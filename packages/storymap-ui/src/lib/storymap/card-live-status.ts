// A LINHA DE ESTADO de um card — QUEM age agora e FAZENDO O QUÊ, em português, dos fatos VIVOS.
//
// O PROBLEMA (visto num board real): o card do Kanban não dizia quem estava nele. Um condutor construía
// uma história havia meia hora (tarefas quase todas feitas, vários arquivos alterados) e o card mostrava só o nome da
// etapa; outro card exibia «✓ Terminou · 3m 27s» de uma execução VELHA enquanto o condutor dele trabalhava; os dois
// dormiam no limite de ações por hora do board e nada no card dizia isso; a fila do condutor era invisível. Cada
// fonte existia (o registro de sessões, a fila do condutor, o ledger de ações, o train, o registro de execuções) —
// faltava UMA régua que as lesse juntas.
//
// ESTE MÓDULO É ESSA RÉGUA, e a única. O card do Kanban, o cabeçalho da página do card e a linha de «Acompanhar» do
// Inbox perguntam aqui — nunca decidem por conta própria (foi assim que o selo de execução e o chip de etapa
// passaram a discordar). Duas peças, as duas PURAS e isomórficas (zero `node:*`):
//   • {@link cardLiveFactsFor}: recorta, dos retratos vivos inteiros, os fatos de UM card;
//   • {@link projectCardLiveStatus}: decide a linha (quem, o quê, desde quando, até quando), pela prioridade abaixo;
//   • {@link cardLiveText}: escreve a linha no fuso do dono («há 12 min», «volta às 20:01»).
//
// A ORDEM (a primeira que casa vence), e por quê:
//   1. PRECISA DE VOCÊ — só a decisão que o Inbox põe em Decidir (o mesmo modelo, que já pergunta a `whoDecides`):
//      o dono lê o board para saber o que é dele; nada acima disto.
//   2. Uma EXECUÇÃO do motor rodando agora — é o ator mais concreto (um processo com PID).
//   3. A sessão viva PARADA num prompt do terminal — trava tudo até alguém responder.
//   4. A INTEGRAÇÃO em andamento (integrando / verificando / na fila) — quando o condutor submeteu, quem age é ela.
//   5. A sessão ESPERANDO (dito por ela, ou o limite de ações do board fechado depois do último relato dela).
//   6. A sessão TRABALHANDO — só com atividade PROVADA (agent-presence.ts: transcript, relato, tela trabalhando; nunca
//      o heartbeat), com o bloco que ela relatou; senão PARADA desde a última atividade, com o último relato na nota.
//   7. A integração PARADA (conflito / verificação reprovada) sem ninguém nela.
//   8. A execução que FALHOU (motivo em português).
//   9. A FILA do condutor (posição + o motivo da espera).
//  10. O JUIZ da triagem decidindo.
//  11. O card TRAVADO — o vigia (runner/stall-watch.ts) o achou parado num passo em que quem age é o sistema, sem
//      ninguém cuidando. Depois de todo ator vivo (se alguém voltou a trabalhar nele, é isso que se lê) e ANTES do
//      que o card prova: era aqui que «Publicando» pulsava sobre um card em que nada publicava.
//  12. O que o próprio card prova: publicando (o disparo carimbado) / aguardando publicação / no ar.
// Uma execução que TERMINOU não é estado atual — é histórico (o histórico do card a guarda). Por isso não há
// «Terminou» aqui: ele mentia exatamente quando outro ator estava trabalhando no card.
//
// Cada tipo de linha cai em UMA das seis presenças ({@link CARD_PRESENCE}) — o vocabulário que nav, Kanban e legenda
// contam juntos. A COR sai da presença (presence-tone.ts), nunca de um «tom» próprio desta linha: o tom paralelo que
// existia aqui foi como o card e o nav passaram a pintar a mesma coisa de cores diferentes.

import type { BoardConfig, Card, StatusDef } from "./types";
import type { MergeQueueEntry, RunnerFailure, RunnerRun } from "./runner/types";
import { ageWords } from "./inbox/copy";
import { CARD_STALLED_FINDING_ID, isDeployStep } from "./demands";
import { isActiveMergeStatus } from "./runner/merge-status";
import { isZombieSession, sessionActivityAt, sessionPresence } from "./agent-presence";

// ── os blocos do condutor ──────────────────────────────────────────────────────────────────────────────

/** Os quatro blocos do condutor (skill harness-conductor), na ordem em que ele os percorre. */
export const CONDUCTOR_PHASES = ["moldar", "construir", "verificar", "publicar"] as const;
export type ConductorPhase = (typeof CONDUCTOR_PHASES)[number];

export function isConductorPhase(v: unknown): v is ConductorPhase {
  return typeof v === "string" && (CONDUCTOR_PHASES as readonly string[]).includes(v);
}

/** O verbo de cada bloco, no gerúndio — «Condutor construindo». */
const PHASE_VERB: Record<ConductorPhase, string> = {
  moldar: "moldando",
  construir: "construindo",
  verificar: "verificando",
  publicar: "publicando",
};

/**
 * O que a sessão relatou por último (`report_progress`). Mora no REGISTRO DE SESSÕES, não no card: é barato, não
 * disputa o lock do card e morre com a sessão.
 */
export interface SessionProgress {
  phase: ConductorPhase;
  /** uma linha livre do agente — o que está fazendo dentro do bloco. */
  note?: string;
  /** ISO do último relato. */
  at: string;
  /** ISO de quando o bloco atual começou (preservado entre relatos do mesmo bloco). */
  phaseSince: string;
  /** a sessão está ESPERANDO — completa a frase «Esperando …» (ex.: «a janela de ações»). */
  waiting?: string;
  /** ISO de quando a espera acaba, quando se sabe. */
  until?: string;
}

// ── os fatos vivos (o que o servidor manda pelo SSE `card-live`) ──────────────────────────────────────

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

/** Uma sessão de agente VIVA num card, como o feed a reporta. */
export interface CardSessionFact {
  board: string;
  cardId: string;
  sessionId: string;
  role: string;
  /** a sessão CONDUZ o card (driver conductor). */
  conductor: boolean;
  tmuxSession?: string;
  openedAt: string;
  /** PROVA DE VIDA, nunca de trabalho: o tick da frota o renova a cada 60 s para todo tmux vivo (agent-presence.ts). */
  heartbeatAt: string;
  progress?: SessionProgress;
  /** o tamanho do trabalho na árvore dela, contra a base (medido com teto de frequência). */
  diff?: DiffStat | null;
  /** ISO da última atividade PROVADA — a escrita do transcript, as tools que mexem no trabalho (card-live-feed.ts). */
  lastActivityAt?: string;
  /** a tela está trabalhando AGORA (turno longo, suíte em segundo plano), lida como conductorQuiet a lê. */
  busy?: boolean;
  /** o tmux sobreviveu à pasta de trabalho apagada — um zumbi, não um agente. */
  zombie?: boolean;
}

/** Um card esperando uma vaga de condutor. */
export interface CardQueueFact {
  board: string;
  cardId: string;
  /** 1-based, entre os do MESMO board. */
  position: number;
  total: number;
  queuedAt: string;
  waitKind?: string;
  waitReason?: string;
}

/** O limite de ações por hora de um board está FECHADO até `until`. `at` = a última ação freada. */
export interface BoardThrottleFact {
  board: string;
  until: string;
  at: string;
}

/**
 * As vagas de condutor de um board: quantas estão ocupadas, o teto, e se a vaga extra está aberta (e por quê não). O
 * MESMO fato que o despacho do condutor usa — chega quando o coletor o recebe do despacho; até lá o campo fica ausente.
 */
export interface ConductorSlotFact {
  board: string;
  used: number;
  max: number;
  extra?: { open: boolean; why?: string };
}

export interface CardLiveFeed {
  at: number;
  sessions: CardSessionFact[];
  queue: CardQueueFact[];
  throttles: BoardThrottleFact[];
  /** `board/cardId` dos cards que o juiz da triagem está julgando agora. */
  judging: string[];
  /** as vagas de condutor por board (opcional: ver {@link ConductorSlotFact}). */
  slots?: ConductorSlotFact[];
}

export const EMPTY_CARD_LIVE_FEED: CardLiveFeed = { at: 0, sessions: [], queue: [], throttles: [], judging: [] };

/** Um terminal parado esperando o operador (o vigia de terminais), pelo nome da sessão tmux. */
export interface TerminalWaitFact {
  session: string;
  kind: "asking" | "idle";
  since: number;
}

/** Os fatos vivos de UM card — recortados por {@link cardLiveFactsFor}. */
export interface CardLiveFacts {
  run?: Pick<RunnerRun, "trigger" | "startedAt"> | null;
  failure?: Pick<RunnerFailure, "reason" | "detail" | "at"> | null;
  /** as entradas do train DESTE card. */
  merge?: Pick<MergeQueueEntry, "status" | "enqueuedAt" | "mergeStartedAt" | "runId">[];
  /** posição (1-based) da entrada `waiting` deste card na fila do train, quando há. */
  mergePosition?: number | null;
  session?: CardSessionFact | null;
  terminal?: TerminalWaitFact | null;
  queue?: CardQueueFact | null;
  throttle?: BoardThrottleFact | null;
  judging?: boolean;
  /** a decisão do DONO que o card carrega (cardInboxSignal — só o que o Inbox põe em Decidir). */
  ownerDecision?: { label: string; itemId: string } | null;
  /** o tamanho do trabalho já integrado (diffSnapshot / commitRange), quando não há árvore viva. */
  integratedDiff?: DiffStat | null;
}

/** A integração ANDANDO para este card: a régua única de merge-status.ts, mais o `re-driving` — que a fila marca como
 *  terminal, mas que o operador lê como «ainda integrando» até a nova execução aparecer (run-substate.ts). */
const isMergeUnderway = (status: MergeQueueEntry["status"]) => isActiveMergeStatus(status) || status === "re-driving";

/**
 * Recorta dos retratos inteiros (runner, train, feed, terminais) os fatos de um card. PURA.
 * A sessão escolhida é a do CONDUTOR quando há uma; senão a de atividade provada mais recente. Um zumbi (o tmux
 * sobreviveu à pasta apagada) nunca é a sessão do card: ele não trabalha nele, só segura um nome.
 */
export function cardLiveFactsFor(
  boardId: string,
  cardId: string,
  src: {
    running?: readonly RunnerRun[];
    failures?: readonly RunnerFailure[];
    mergeEntries?: readonly MergeQueueEntry[];
    feed?: CardLiveFeed | null;
    terminals?: readonly TerminalWaitFact[];
  },
): CardLiveFacts {
  const mine = <T extends { board: string; cardId?: string }>(xs: readonly T[] | undefined) =>
    (xs ?? []).filter((x) => x.board === boardId && x.cardId === cardId);
  const merge = mine(src.mergeEntries);
  const waiting = merge.find((e) => e.status === "waiting");
  let mergePosition: number | null = null;
  if (waiting) {
    const queued = (src.mergeEntries ?? [])
      .filter((e) => e.status === "waiting" || e.status === "gate-running")
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const at = queued.findIndex((e) => e.runId === waiting.runId);
    mergePosition = at >= 0 ? at + 1 : null;
  }
  const sessions = mine(src.feed?.sessions).filter((s) => !isZombieSession(s));
  const stamp = (s: CardSessionFact) => sessionActivityAt(s) ?? 0;
  const session =
    [...sessions].sort((a, b) => Number(b.conductor) - Number(a.conductor) || stamp(b) - stamp(a))[0] ?? null;
  const terminal = session?.tmuxSession ? (src.terminals ?? []).find((t) => t.session === session.tmuxSession) ?? null : null;
  return {
    run: mine(src.running)[0] ?? null,
    failure: mine(src.failures)[0] ?? null,
    merge,
    mergePosition,
    session,
    terminal,
    queue: mine(src.feed?.queue)[0] ?? null,
    throttle: (src.feed?.throttles ?? []).find((t) => t.board === boardId) ?? null,
    judging: (src.feed?.judging ?? []).includes(`${boardId}/${cardId}`),
  };
}

// ── a projeção ─────────────────────────────────────────────────────────────────────────────────────────

export type CardLiveKind =
  | "owner"
  | "run"
  | "terminal-prompt"
  | "integrating"
  | "waiting"
  | "working"
  | "quiet"
  | "stopped"
  | "queued"
  | "judging"
  | "publishing"
  | "live";

/**
 * As SEIS presenças de um card — mutuamente exclusivas, uma por linha de estado. É o vocabulário que o nav, o pulso do
 * Kanban, a legenda e as cores leem (decisão de projeto): cada presença é UM estado de tela, e nenhuma tela inventa
 * a sua. Por que estas seis:
 *   • owner      — precisa de você (só a decisão que o Inbox põe em Decidir);
 *   • working    — alguém trabalhando AGORA, com prova (o único que pulsa);
 *   • waiting    — ninguém age agora e não é alarme: o agente parado no prompt (o sistema cutuca sozinho), o card na
 *                  fila do condutor, a espera pelo limite de ações ou pela cota;
 *   • delivering — a vez é do sistema: integrando, na fila da integração, publicando ou aguardando a publicação;
 *   • stopped    — parou e ninguém cuida (falha, conflito, card travado, prompt no terminal sem resposta);
 *   • live       — no ar (o passo terminal).
 */
export const CARD_PRESENCES = ["owner", "working", "waiting", "delivering", "stopped", "live"] as const;
export type CardPresence = (typeof CARD_PRESENCES)[number];

/** Cada tipo de linha cai em EXATAMENTE uma presença. Record exaustivo: um tipo novo sem presença não compila. */
export const CARD_PRESENCE: Readonly<Record<CardLiveKind, CardPresence>> = {
  owner: "owner",
  run: "working",
  working: "working",
  judging: "working",
  quiet: "waiting",
  queued: "waiting",
  waiting: "waiting",
  integrating: "delivering",
  publishing: "delivering",
  "terminal-prompt": "stopped",
  stopped: "stopped",
  live: "live",
};

/** Só quem trabalha com prova pulsa — um pulso sobre quem não trabalha é exatamente a mentira que a régua existe para evitar. PURA. */
export function presencePulses(p: CardPresence): boolean {
  return p === "working";
}

/** Quantos cards em cada presença (`none` = só a etapa, nada vivo). A MESMA conta para a legenda e o pulso. PURA. */
export function countPresence(statuses: Iterable<CardLiveStatus | null | undefined>): Record<CardPresence | "none", number> {
  const out = { owner: 0, working: 0, waiting: 0, delivering: 0, stopped: 0, live: 0, none: 0 };
  for (const s of statuses) out[s ? s.presence : "none"] += 1;
  return out;
}

export interface CardLiveStatus {
  kind: CardLiveKind;
  /** a presença do card — sempre `CARD_PRESENCE[kind]`, posta num ponto só ({@link projectCardLiveStatus}). */
  presence: CardPresence;
  /** quem age agora — «Condutor», «Agente», «Integração», «Juiz da triagem», «Você». */
  actor: string;
  /** a frase, sem o tempo — «Condutor construindo». */
  label: string;
  /** âncora relativa (epoch ms) — escrita «há 12 min». */
  since?: number;
  /** âncora absoluta (epoch ms) — escrita «volta às 20:01». */
  until?: number;
  /** uma linha a mais: o relato do agente, o motivo da espera. */
  note?: string;
  /** o item do Inbox da decisão do dono (só `owner`). */
  itemId?: string;
  /** o tamanho do trabalho (vivo na árvore, ou já integrado). */
  diff?: DiffStat | null;
}

/** O motivo de uma execução que falhou, em português (o card; os detalhes técnicos ficam no console). */
const FAILURE_WORDS: Record<string, string> = {
  timeout: "a execução ficou sem resposta",
  exit: "a execução do agente falhou",
  error: "o agente não conseguiu começar",
  "oom-killed": "faltou memória na máquina",
  "no-op": "o agente não avançou o card",
  "budget-cut": "atingiu o teto de custo",
};

/** O verbo da execução do motor pela skill da etapa — AgileHarness nomeia as próprias; o resto cai em «trabalhando». */
const RUN_VERB: Record<string, string> = {
  "harness-do": "construindo",
  "harness-review": "revisando",
  "harness-qa": "testando",
  "harness-enrich": "especificando",
  "harness-plan": "planejando",
  "harness-tasks": "planejando",
  "harness-grill": "investigando",
  "harness-interview": "entrevistando",
  "harness-prioritize": "priorizando",
  "harness-fix": "diagnosticando",
  "harness-refine": "diagnosticando",
  "harness-ux": "desenhando",
  "harness-ui": "desenhando",
  "harness-sync-card": "sincronizando",
  "harness-capture": "propondo cards",
};

function ms(iso: string | null | undefined): number | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * A linha de estado de um card. PURA. `null` = nada vivo e nada provado — a tela mostra só a etapa.
 */
export function projectCardLiveStatus(
  card: Pick<Card, "status" | "deployFiredAt" | "deployProof" | "releasedAt" | "findings">,
  config: Pick<BoardConfig, "statuses">,
  facts: CardLiveFacts,
  now: number,
): CardLiveStatus | null {
  const def: StatusDef | undefined = config.statuses.find((s) => s.id === card.status);
  const s = facts.session ?? null;
  const diff = s?.diff ?? facts.integratedDiff ?? null;
  const out = (st: Omit<CardLiveStatus, "diff" | "presence">): CardLiveStatus => ({ ...st, presence: CARD_PRESENCE[st.kind], diff });
  // A presença da sessão é a régua única (agent-presence.ts): esta função só a escreve, nunca decide por conta própria
  // se alguém trabalha.
  const presence = s ? sessionPresence(s, { terminal: facts.terminal, throttle: facts.throttle }, now) : null;

  // 1. a decisão do dono
  if (facts.ownerDecision) {
    return out({ kind: "owner", actor: "Você", label: `Precisa de você: ${facts.ownerDecision.label}`, itemId: facts.ownerDecision.itemId });
  }

  // 2. uma execução do motor rodando agora
  if (facts.run) {
    const verb = RUN_VERB[facts.run.trigger] ?? "trabalhando";
    return out({
      kind: "run",
     
      actor: "Agente",
      label: `Agente ${verb}`,
      since: facts.run.startedAt,
      note: def?.name ? `Passo: ${def.name}` : undefined,
    });
  }

  const actor = s?.conductor ? "Condutor" : "Agente";

  // 3. a sessão parada num prompt do terminal
  if (presence?.state === "asking") {
    return out({ kind: "terminal-prompt", actor, label: `${actor} esperando resposta no terminal`, since: presence.since });
  }

  // 4. a integração em andamento
  const merge = facts.merge ?? [];
  const live = merge.find((e) => isMergeUnderway(e.status));
  if (live) {
    if (live.status === "waiting") {
      const pos = facts.mergePosition;
      return out({ kind: "integrating", actor: "Integração", label: pos ? `Na fila da integração · ${pos}º` : "Na fila da integração", since: live.enqueuedAt });
    }
    if (live.status === "gate-running") {
      return out({ kind: "integrating", actor: "Integração", label: "Verificando antes de integrar", since: live.enqueuedAt });
    }
    return out({ kind: "integrating", actor: "Integração", label: "Integrando", since: live.mergeStartedAt ?? live.enqueuedAt });
  }

  if (s && presence) {
    const p = s.progress;
    // 5. a sessão esperando — dito por ela, ou o limite de ações do board fechado depois do último relato dela
    if (presence.state === "waiting") {
      if (presence.throttled) {
        return out({ kind: "waiting", actor, label: "Esperando a janela de ações", until: presence.until, note: "O board atingiu o limite de ações por hora; o condutor retoma quando a janela abrir." });
      }
      return out({ kind: "waiting", actor, label: `Esperando ${presence.waitingFor}`, until: presence.until, since: presence.since, note: p?.note });
    }
    // 6. a sessão trabalhando — só com atividade PROVADA; o «há N» é a última atividade, não o começo do bloco
    if (presence.state === "working") {
      return out({ kind: "working", actor, label: p ? `${actor} ${PHASE_VERB[p.phase]}` : `${actor} trabalhando`, since: presence.since, note: p?.note });
    }
    // …ou parada: o relato velho NÃO vence a falta de atividade (era o condutor parado pulsando como se construísse).
    // O último relato vira a nota — «parado há 40 min» diz mais com «onde parou».
    return out({
      kind: "quiet",
     
      actor,
      label: `${actor} parado`,
      since: presence.since,
      note: p ? [`Último relato: ${PHASE_VERB[p.phase]}`, p.note].filter(Boolean).join(" · ") : "O terminal está quieto: acabou a vez dele ou espera uma instrução.",
    });
  }

  // 7. a integração parada, sem ninguém nela
  const parked = merge.find((e) => e.status === "conflict" || e.status === "gate-failed");
  if (parked) {
    return out({
      kind: "stopped",
     
      actor: "Integração",
      label: parked.status === "conflict" ? "Parado: conflito ao integrar" : "Parado: a verificação antes de integrar reprovou",
      since: parked.enqueuedAt,
    });
  }

  // 8. a execução que falhou
  if (facts.failure) {
    const why = FAILURE_WORDS[facts.failure.reason] ?? "a execução do agente falhou";
    return out({ kind: "stopped", actor: "Agente", label: `Parado: ${why}`, since: facts.failure.at });
  }

  // 9. a fila do condutor
  if (facts.queue) {
    const q = facts.queue;
    return out({ kind: "queued", actor: "Condutor", label: `Na fila do condutor · ${q.position}º`, since: ms(q.queuedAt), note: q.waitReason });
  }

  // 10. o juiz da triagem
  if (facts.judging) return out({ kind: "judging", actor: "Juiz da triagem", label: "Juiz da triagem decidindo" });

  // 11. o card travado: o achado ABERTO do vigia (em qualquer passo não terminal). O detalhe dele — desde quando, o
  // que o sistema tentou, o card de conserto — já vem em linguagem de dono e vira a segunda linha.
  const stalled = def?.terminal ? undefined : (card.findings ?? []).find((f) => f.id === CARD_STALLED_FINDING_ID && f.status === "open");
  if (stalled) {
    return out({ kind: "stopped", actor: "Sistema", label: `Travado em «${def?.name ?? card.status ?? "?"}»`, note: stalled.detail });
  }

  // 12. o que o card prova
  if (!def?.terminal && card.deployFiredAt) {
    return out({ kind: "publishing", actor: "Publicação", label: "Publicando", since: ms(card.deployFiredAt) });
  }
  // No passo de publicação SEM o disparo carimbado nada está publicando: o card espera a vez dele. Dizer «Publicando»
  // (e pulsar) aqui era afirmar um trabalho que ninguém fazia — o tom é de espera, não de atividade.
  if (!def?.terminal && isDeployStep(def)) {
    return out({ kind: "publishing", actor: "Publicação", label: "Aguardando publicação" });
  }
  if (def?.terminal) {
    const at = ms(card.deployProof?.at) ?? ms(card.releasedAt);
    if (card.deployProof || at != null) return out({ kind: "live", actor: "Publicação", label: "No ar", since: at });
    // Sem prova (um card sem código, um terminal declarado à mão): a linha diz só a etapa, mas o card TEM presença —
    // um card no passo final nunca é «nada vivo», senão a legenda e o pulso perdem a conta dele.
    return out({ kind: "live", actor: "Publicação", label: def.name || "Concluído" });
  }
  return null;
}

// ── o texto ────────────────────────────────────────────────────────────────────────────────────────────

/** «20:01», no fuso do dono. */
function clock(at: number, timeZone?: string): string {
  return new Date(at).toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" });
}

function dayKey(at: number, timeZone?: string): string {
  return new Date(at).toLocaleDateString("pt-BR", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** «volta às 20:01» (hoje) / «volta amanhã às 00:00» / «volta 15/03 às 09:00» — no fuso do dono. PURA. */
export function untilWords(until: number, now: number, timeZone?: string): string {
  const k = dayKey(until, timeZone);
  if (k === dayKey(now, timeZone)) return `volta às ${clock(until, timeZone)}`;
  if (k === dayKey(now + 86_400_000, timeZone)) return `volta amanhã às ${clock(until, timeZone)}`;
  const d = new Date(until).toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "2-digit" });
  return `volta ${d} às ${clock(until, timeZone)}`;
}

/** «há 12 min» / «agora». PURA. */
export function sinceWords(since: number, now: number): string {
  const w = ageWords(now - since);
  return w === "agora" ? "agora" : `há ${w}`;
}

/** A linha inteira, pronta: «Condutor construindo · há 12 min», «Esperando a janela de ações · volta às 20:01». PURA. */
export function cardLiveText(s: CardLiveStatus, now: number, timeZone?: string): string {
  if (s.until != null && s.until > now) return `${s.label} · ${untilWords(s.until, now, timeZone)}`;
  if (s.since != null && s.kind !== "owner") return `${s.label} · ${sinceWords(s.since, now)}`;
  return s.label;
}

/** «+187 −23 · 9 arquivos». PURA. */
export function diffWords(d: DiffStat): string {
  const files = d.files === 1 ? "1 arquivo" : `${d.files} arquivos`;
  return `+${d.additions} −${d.deletions} · ${files}`;
}
