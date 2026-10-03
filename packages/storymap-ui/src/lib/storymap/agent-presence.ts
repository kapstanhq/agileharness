// A PRESENÇA de um agente — está TRABALHANDO DE FATO, parado, perguntando ou esperando? E quais cards ainda estão na
// fila, sem agente nenhum?
//
// O PROBLEMA (medido no ar): cinco telas respondiam «quantos agentes» com cinco definições, e
// nenhuma era «trabalhando de verdade». O chip do terminal contava os tmux (os condutores + o `claude` e o `shell` do
// dono); o de processos só contava execuções do motor (0); a linha do card pintava de azul pulsando um condutor parado
// no prompt, porque qualquer relato vencia (o ramo «parado» era inalcançável quando havia relato); e a Esteira lia como
// trabalho o `heartbeatAt`, que o tick da frota carimba a cada 60 s para QUALQUER tmux vivo — ele mede «o processo
// existe», não «está trabalhando».
//
// ESTE MÓDULO É A RÉGUA ÚNICA de presença, PURO e isomórfico (zero `node:*`). A linha do card (card-live-status.ts) e
// a contagem de agentes perguntam aqui, nunca decidem sozinhas. A evidência é só de TRABALHO:
//   • a última escrita do transcript (o CLI escreve nele a cada mensagem) — medida no coletor do feed;
//   • o relato da sessão (`report_progress` → `progress.at`) e as tools que mexem no trabalho (`lastActivityAt`);
//   • a tela trabalhando agora (um turno longo, uma suíte em segundo plano) — a leitura de conductorQuiet (`busy`);
//   • uma execução do motor viva (um processo com PID);
//   • o juiz da triagem com o julgamento em voo neste processo (`judging` do feed).
// NUNCA o `heartbeatAt`.
//
// A REGRA, na ordem (a primeira que casa vence):
//   1. asking  — um prompt desenhado na tela (menu, s/N): trava tudo até alguém responder;
//   2. waiting — a espera DECLARADA pela sessão (relato com `waiting`), ou o limite de ações do board fechado depois
//                do último relato dela (um relato mais novo prova que ela voltou a andar);
//   3. working — a tela trabalhando agora, ou atividade provada há menos de {@link PRESENCE_FRESH_MS};
//   4. quiet   — vivo e sem atividade provada: acabou a vez dele, espera uma instrução, ou parou num erro.
// «Na fila» não é estado de sessão: é o card esperando uma vaga de condutor, ainda sem agente — ele entra em `queued`.
// Um ZUMBI (o tmux sobreviveu à pasta de trabalho apagada) não é agente: não entra em nada.

import type { BoardThrottleFact, CardLiveFeed, CardQueueFact, CardSessionFact, ConductorPhase, ConductorSlotFact, TerminalWaitFact } from "./card-live-status";
import type { RunnerRun } from "./runner/types";

/**
 * Atividade mais nova que isto = trabalhando. É a MESMA janela de conductorQuiet (runner/conductor-quiet.ts): um
 * transcript mexido há menos de 2 min é «um turno que acabou de terminar, ou está no meio — cedo para julgar». Um
 * número só para as duas perguntas («está quieto?» e «está trabalhando?»): com dois, haveria um intervalo em que o
 * condutor não é nem uma coisa nem outra. O teste de agent-presence prende os dois juntos.
 */
export const PRESENCE_FRESH_MS = 2 * 60_000;

export type AgentPresenceState = "working" | "quiet" | "asking" | "waiting";

export interface SessionPresence {
  state: AgentPresenceState;
  /** a âncora do «há N»: a última atividade provada (working/quiet), o início da pergunta (asking), o relato (waiting). */
  since?: number;
  /** quando a espera acaba, se se sabe (waiting). */
  until?: number;
  /** o complemento de «Esperando …», dito pela sessão (waiting declarado). */
  waitingFor?: string;
  /** a espera é o limite de ações por hora do board — não foi dita pela sessão. */
  throttled?: boolean;
}

function ms(v: string | number | null | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** O instante mais recente entre as provas dadas (ISO ou epoch ms). `undefined` quando nenhuma é legível. PURA. */
export function latestActivity(...proofs: Array<string | number | null | undefined>): number | undefined {
  let best: number | undefined;
  for (const p of proofs) {
    const t = ms(p);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

/** A última atividade PROVADA de uma sessão do feed: o que o coletor mediu (transcript, tools) e o relato. PURA. */
export function sessionActivityAt(s: Pick<CardSessionFact, "lastActivityAt" | "progress">): number | undefined {
  return latestActivity(s.lastActivityAt, s.progress?.at);
}

/** O tmux sobreviveu à pasta de trabalho apagada: não é agente, não segura nada na tela. PURA. */
export function isZombieSession(s: Pick<CardSessionFact, "zombie">): boolean {
  return s.zombie === true;
}

/**
 * A presença de UMA sessão viva, pela ordem do cabeçalho. PURA. `terminal` é o vigia de terminais daquela tmux;
 * `throttle`, o limite de ações do board dela.
 */
export function sessionPresence(
  s: Pick<CardSessionFact, "progress" | "lastActivityAt" | "busy" | "openedAt">,
  ctx: { terminal?: TerminalWaitFact | null; throttle?: BoardThrottleFact | null },
  now: number,
): SessionPresence {
  if (ctx.terminal?.kind === "asking") return { state: "asking", since: ctx.terminal.since };
  const p = s.progress;
  const reportedAt = ms(p?.at);
  if (p?.waiting) return { state: "waiting", waitingFor: p.waiting, until: ms(p.until), since: reportedAt };
  const t = ctx.throttle;
  const until = ms(t?.until);
  if (t && until && until > now && (reportedAt == null || reportedAt < (ms(t.at) ?? 0))) {
    return { state: "waiting", throttled: true, until };
  }
  // A tela trabalhando AGORA é a prova mais fresca que existe: «há N» é «agora», por mais antiga que seja a última
  // escrita do transcript (uma suíte de 10 min não escreve nele).
  if (s.busy) return { state: "working", since: now };
  const act = sessionActivityAt(s);
  if (act != null && now - act < PRESENCE_FRESH_MS) return { state: "working", since: act };
  // Quieto: o «há N» é desde a última atividade provada — é isso que diz «parado há 40 min». Sem prova nenhuma, desde
  // quando o vigia viu a tela parar, ou desde que a sessão abriu.
  const idleSince = ctx.terminal?.kind === "idle" ? ctx.terminal.since : undefined;
  return { state: "quiet", since: act ?? idleSince ?? ms(s.openedAt) };
}

// ── a frota inteira ────────────────────────────────────────────────────────────────────────────────────

/** Um agente PRESENTE num card: uma sessão viva da frota, uma execução do motor ou o juiz da triagem julgando. */
export interface PresentAgent {
  /** `session:<sessionId>`, `run:<board>/<cardId>` ou `judge:<board>/<cardId>` — estável entre retratos. */
  key: string;
  kind: "conductor" | "session" | "run" | "judge";
  board: string;
  cardId: string;
  presence: SessionPresence;
  /** o bloco que o condutor relatou por último (moldar/construir/verificar/publicar). */
  phase?: ConductorPhase;
  tmuxSession?: string;
}

export interface AgentPresence {
  agents: PresentAgent[];
  /** os cards esperando uma vaga de condutor, na ordem de despacho. */
  queued: CardQueueFact[];
  /** as vagas de condutor por board, quando o feed as traz. */
  slots: ConductorSlotFact[];
  totals: Record<AgentPresenceState | "agents" | "queued", number>;
}

export interface AgentPresenceInputs {
  feed?: CardLiveFeed | null;
  /** as execuções do motor vivas (o SSE `runner`). */
  running?: ReadonlyArray<Pick<RunnerRun, "board" | "cardId" | "startedAt">>;
  /** o vigia de terminais (o SSE `terminals`) — inclui os do dono, que NUNCA viram agente. */
  terminals?: readonly TerminalWaitFact[];
}

/** O verbo de cada estado do agente — o MESMO no popover do nav e na lista da frota do /processes. */
export const AGENT_STATE_WORDS: Readonly<Record<AgentPresenceState, string>> = {
  working: "agindo",
  asking: "esperando resposta no terminal",
  waiting: "esperando",
  quiet: "parado",
};

/** A ordem de leitura: quem trava (pergunta) primeiro, depois quem trabalha, quem espera, e quem parou. */
const STATE_RANK: Record<AgentPresenceState, number> = { asking: 0, working: 1, waiting: 2, quiet: 3 };

/**
 * Quantos agentes estão nos cards, e fazendo o quê. PURA. Só entra o que é AGENTE DA FROTA: as sessões do registro
 * (o feed só carrega sessão com linha no registro) que não são zumbis, as execuções do motor e o juiz da triagem com
 * um julgamento em voo. O terminal do dono aparece em `terminals` e nunca vira agente — é só o lugar onde se lê se uma
 * sessão da frota está perguntando.
 *
 * O juiz entra porque o card que ele julga pinta «Agindo» (card-live-status.ts, `judging`): sem ele aqui, o board
 * mostrava um card azul pulsando com o nav dizendo «Agentes 0».
 */
export function reduceAgentPresence(inputs: AgentPresenceInputs, now: number): AgentPresence {
  const feed = inputs.feed;
  const terminalByTmux = new Map((inputs.terminals ?? []).map((t) => [t.session, t] as const));
  const throttleByBoard = new Map((feed?.throttles ?? []).map((t) => [t.board, t] as const));
  const agents: PresentAgent[] = [];
  for (const r of inputs.running ?? []) {
    agents.push({ key: `run:${r.board}/${r.cardId}`, kind: "run", board: r.board, cardId: r.cardId, presence: { state: "working", since: r.startedAt } });
  }
  for (const key of feed?.judging ?? []) {
    const cut = key.indexOf("/");
    if (cut <= 0) continue;
    const board = key.slice(0, cut);
    const cardId = key.slice(cut + 1);
    // sem âncora de tempo: o feed diz que o julgamento está em voo AGORA, não desde quando
    agents.push({ key: `judge:${key}`, kind: "judge", board, cardId, presence: { state: "working" } });
  }
  for (const s of feed?.sessions ?? []) {
    if (isZombieSession(s)) continue;
    const terminal = s.tmuxSession ? terminalByTmux.get(s.tmuxSession) : undefined;
    agents.push({
      key: `session:${s.sessionId}`,
      kind: s.conductor ? "conductor" : "session",
      board: s.board,
      cardId: s.cardId,
      presence: sessionPresence(s, { terminal, throttle: throttleByBoard.get(s.board) }, now),
      ...(s.progress ? { phase: s.progress.phase } : {}),
      ...(s.tmuxSession ? { tmuxSession: s.tmuxSession } : {}),
    });
  }
  agents.sort((a, b) => STATE_RANK[a.presence.state] - STATE_RANK[b.presence.state] || (b.presence.since ?? 0) - (a.presence.since ?? 0));
  const queued = [...(feed?.queue ?? [])];
  const totals: AgentPresence["totals"] = { agents: agents.length, working: 0, quiet: 0, asking: 0, waiting: 0, queued: queued.length };
  for (const a of agents) totals[a.presence.state] += 1;
  return { agents, queued, slots: [...(feed?.slots ?? [])], totals };
}

/**
 * Quantos agentes trabalham DE FATO — o número do chip «Agentes N» do nav. PURA. Só `working` (evidência fresca): o
 * parado no prompt, o que espera e o que pergunta aparecem no popover, mas não somam — «4 agentes» com 2 deles parados
 * era a mentira que isto fecha.
 */
export function workingAgents(agents: readonly Pick<PresentAgent, "presence">[]): number {
  return agents.filter((a) => a.presence.state === "working").length;
}

/** O que o nav («Agentes N») e o pulso do board («n agentes agindo · f na fila · vagas u/m») dizem. */
export interface AgentPulse {
  /** agentes trabalhando de fato ({@link workingAgents}). */
  working: number;
  /** cards esperando uma vaga de condutor (a fila do despacho, não a cor da linha do card). */
  queued: number;
  slots: ConductorSlotFact[];
}

/**
 * A conta ÚNICA de agentes, para a frota inteira (o nav) ou para um board (o pulso do Kanban). PURA.
 *
 * O defeito que ela fecha: o nav contava AGENTES e o pulso contava CARDS pintados de «Agindo». A cor
 * do card segue a precedência da linha — a decisão do dono e a integração vencem a sessão que trabalha —, então um
 * condutor trabalhando num card em Decidir, ou esperando o train no PUBLICAR, dava «Agentes 1» no nav e «0 agindo» no
 * pulso. Agora os dois leem daqui: a soma dos recortes por board é o número do nav. A legenda do Kanban segue contando
 * CARDS por cor — é o que ela diz («Cards: Agindo 1») —, e todo card azul tem um agente trabalhando nele.
 */
export function agentPulse(p: Pick<AgentPresence, "agents" | "queued" | "slots">, board?: string): AgentPulse {
  const mine = <T extends { board: string }>(xs: readonly T[]): T[] => (board == null ? [...xs] : xs.filter((x) => x.board === board));
  return { working: workingAgents(mine(p.agents)), queued: mine(p.queued).length, slots: mine(p.slots) };
}
