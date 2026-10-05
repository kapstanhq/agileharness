// A PARADA DO CONDUTOR, do lado do serviço — fatia 2 das «paradas por recurso».
//
// O caso que a motivou: dois condutores pararam esperando uma resposta do dono (um ciclo extra, mais orçamento) e
// seguraram todas as vagas do board, com cards esperando na fila. A resposta do dono no Inbox não chegava à sessão
// (alguém tinha de digitar «continuar» no terminal), e um condutor parado segurava a vaga para sempre.
//
// Duas metades, as duas com palavras FIXAS (nunca texto de quem chamou) e só para um pane que prova rodar o claude:
//   • ACORDAR — uma pergunta do card foi respondida (pelo dono no Inbox, pelo proxy, por um agente). Com condutor
//     vivo, a sessão recebe o «continuar» que o dono digitaria. Sem condutor vivo (o card está ESTACIONADO) e sem
//     mais nada aberto, o card volta para a FRENTE da fila («na frente»: terminar o que está quase pronto libera a
//     vaga mais rápido).
//   • ESTACIONAR — um condutor vivo, quieto no prompt, cuja espera é do DONO (toda pergunta aberta é dele, ou o card
//     descansa no passo de aprovar a entrega) recebe, depois de `parkAfterMinutes`, o pedido de estacionar: gravar o
//     estado no card, preservar o trabalho e encerrar a sessão. A decisão de um agente (o proxy) chega em minutos,
//     por isso a carência: estacionar custa uma releitura na retomada («só se demorar»).
// O serviço PEDE; quem estaciona é o condutor (a skill harness-conductor, seção «Estacionar e retomar») — só ele sabe
// commitar o que tem e escrever de onde retomar. O terminal que sobra é fechado pelo passe de órfãos (conductor.ts).
//
// WP5-F2 — a ESCADA ÚNICA ({@link quietLadderStep}): estacionar só quando a espera era do dono deixava duas vagas presas
// por horas — por exemplo, um condutor cujo turno morreu num erro de transporte (até alguém digitar «continue» à mão)
// e um condutor quieto sem pedir nada com vários cards na fila. Agora: erro de transporte ⇒ retomar (linha
// fixa, até 2 por hora) e depois estacionar; quieto com fila esperando vaga ⇒ um lembrete e depois estacionar. Cada
// degrau fica no registro de decisões do sistema; o estacionar tem «Desfazer» (reabrir o condutor já).
// Núcleo DI; as deps de produção moram em conductor-pause-deps.ts.

import { isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import { ownerOnlyOpenQuestions } from "@/lib/storymap/autonomy";
import { whoDecides } from "@/lib/storymap/decision-class";
import { isDeliveryApprovalStep } from "@/lib/storymap/delivery-audit";
import { isConducted } from "@/lib/storymap/driver";
import { openQuestions } from "@/lib/storymap/questions";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { isLiveConductor } from "./conductor";
import type { AgentSession } from "./session-worktree";

/** `autorun.park` do settings — os tempos da escada (ver {@link quietLadderStep} e types.ts `autorun.park`). */
export interface ParkSettings {
  /** espera do dono quieta há isto ⇒ estacionar; e, depois do lembrete, quieto há isto ⇒ estacionar. */
  afterMinutes: number;
  /** quieto sem pausa declarada, com fila esperando vaga, há isto ⇒ o lembrete. */
  nudgeAfterMinutes: number;
  /** o último turno morreu num erro de transporte e o pane está parado há isto ⇒ a linha de retomar. */
  transportRetryAfterMinutes: number;
  /** quantas retomadas por hora antes de estacionar (0 = estaciona direto). */
  transportRetries: number;
  /**
   * story-ex9602 — a espera DECLARADA (report_progress waiting) segura a vaga, com fila esperando, no máximo isto (quieto);
   * depois, o pedido de estacionar que transforma a espera numa pergunta do dono. Uma espera com prazo (`until` no futuro)
   * é respeitada até o prazo.
   */
  declaredAfterMinutes: number;
}
export const DEFAULT_PARK_SETTINGS: ParkSettings = { afterMinutes: 10, nudgeAfterMinutes: 10, transportRetryAfterMinutes: 3, transportRetries: 2, declaredAfterMinutes: 30 };

const SAFE_ID = /^[A-Za-z0-9_-]{1,32}$/;

interface PaneDeps {
  sessions(): Promise<AgentSession[]>;
  /** nomes das sessões tmux vivas AGORA; null = a sonda não respondeu (ninguém é julgado). */
  liveTmux(): Promise<ReadonlySet<string> | null>;
  heartbeatAlive(s: AgentSession): boolean;
  /** a árvore de trabalho da linha foi apagada (tmux zumbi — conductor.ts `isLiveConductor`). */
  treeGone?(s: AgentSession): boolean;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  /** o pane roda o binário do claude? (nunca digitar num shell) */
  runsClaude(tmux: string): Promise<boolean>;
  /** digita e envia a linha — true se entregue. */
  deliver(tmux: string, text: string): Promise<boolean>;
  now?(): number;
  log?(line: string): void;
}

// ── ACORDAR ──────────────────────────────────────────────────────────────────────────────────────────

export type WakeBy = "owner" | "proxy" | "agent" | "system";
export type WakeOutcome = "not-conducted" | "terminal" | "delivered" | "undeliverable" | "resumed" | "still-waiting" | "unknown";

export interface ConductorWakeDeps extends PaneDeps {
  /** põe o card na FRENTE da fila do condutor (retomada de card estacionado). */
  admitResume(board: string, cardId: string): Promise<{ queued: boolean }>;
}

const WHO: Record<WakeBy, string> = {
  owner: "o dono respondeu",
  proxy: "o PROXY (modo ultra) respondeu",
  agent: "um agente respondeu",
  system: "o sistema aprovou",
};

/** A linha que o serviço digita — PURA, palavras fixas; só ids do próprio card entram (e só se têm forma de id). */
export function wakeLine(by: WakeBy, questionIds: readonly string[], ownerLeft: number): string {
  const ids = questionIds.filter((q) => SAFE_ID.test(q));
  const what = ids.length ? ids.join(", ") : "uma pergunta";
  return (
    `continuar — ${WHO[by]} ${what} neste card${by === "proxy" ? ", com premissas registradas" : ""}. ` +
    `Releia o card (get_card) antes de seguir.` +
    (ownerLeft ? ` Restam ${ownerLeft} pergunta(s) só do dono abertas: siga no que não depende delas.` : "")
  );
}

/** Uma resposta acabou de ser gravada no card: acorda o condutor vivo, ou retoma o card estacionado. Nunca lança. */
export async function wakeConductor(
  deps: ConductorWakeDeps,
  input: { board: string; cardId: string; questionIds: readonly string[]; by: WakeBy; /** a linha a entregar no lugar da de resposta (ex.: o desfecho de um comando aprovado) */ line?: string },
): Promise<WakeOutcome> {
  const log = deps.log ?? ((l: string) => console.log(`[conductor] ${l}`));
  const { board, cardId, by } = input;
  try {
    const [card, config] = await Promise.all([deps.readCard(board, cardId), deps.readBoardConfig(board)]);
    if (!card || !config || !isConducted(card)) return "not-conducted";
    // Board SÓ DE ORGANIZAÇÃO (organize-only.ts): nenhum condutor é acordado nem retomado nele.
    if (isOrganizeOnly(config)) return "not-conducted";
    if (config.statuses.find((s) => s.id === card.status)?.terminal) return "terminal";
    const live = await deps.liveTmux().catch(() => null);
    if (live === null) return "unknown"; // sem saber quem está vivo, nem digita nem reabre
    const session = (await deps.sessions()).find((s) => s.board === board && s.cardId === cardId && !!s.tmuxSession && isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone));
    if (session?.tmuxSession) {
      if (!(await deps.runsClaude(session.tmuxSession))) return "undeliverable";
      const ok = await deps.deliver(session.tmuxSession, input.line ?? wakeLine(by, input.questionIds, ownerOnlyOpenQuestions(card).length));
      if (ok) log(`${board}/${cardId}: resposta entregue ao condutor (${session.tmuxSession})`);
      return ok ? "delivered" : "undeliverable";
    }
    // Sem condutor vivo: o card está estacionado. Só retoma quando não sobra pergunta aberta — uma que ainda espera
    // (do dono ou do proxy) acorda o card de novo quando for respondida.
    if (openQuestions(card).length > 0) return "still-waiting";
    await deps.admitResume(board, cardId);
    return "resumed";
  } catch (err) {
    log(`${board}/${cardId}: não foi possível acordar o condutor — ${err instanceof Error ? err.message : String(err)}`);
    return "unknown";
  }
}

// ── ESTACIONAR ───────────────────────────────────────────────────────────────────────────────────────

/** A linha do pedido de estacionar — PURA e autoexplicativa (um condutor aberto antes da skill nova também a segue). */
export const PARK_LINE =
  "estacionar — este card espera uma decisão do dono, que pode demorar, e esta sessão está segurando uma vaga de condutor. " +
  "Faça, nesta ordem: (1) atualize no card a seção «Estado do condutor» (bloco e passo atuais, o que já está pronto, o que falta, " +
  "as perguntas abertas e o nome do branch); (2) commite tudo o que há no worktree; (3) release_claim; " +
  "(4) worktree_discard — o branch com commits não integrados fica preservado; (5) NÃO limpe o driver do card, " +
  "exceto se ele já está em «Aprovar entrega», com tudo integrado e SEM pergunta sua aberta — isto é, só falta o dono aprovar " +
  "a entrega (aí limpe: a cascata o leva adiante quando ele aprovar); com pergunta aberta, mantenha o driver para o serviço reabrir um condutor; " +
  "(6) encerre o turno sem pedir mais nada. Quando a decisão sair, o serviço reabre um condutor para este card na frente da fila.";

/**
 * A espera deste card é do DONO? PURA. Sim quando há pergunta aberta e TODAS são dele (nenhuma para o proxy
 * responder em minutos), ou quando o card descansa no passo em que o dono aprova a entrega.
 */
export function waitsForOwner(card: Card, config: BoardConfig): boolean {
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def || def.terminal) return false;
  const open = openQuestions(card);
  if (open.length > 0) return open.every((q) => whoDecides({ kind: "question", question: q }, card, config).decider === "owner");
  return isDeliveryApprovalStep(def);
}

/**
 * A linha do estacionar quando a espera NÃO é do dono (WP5-F2): a sessão ficou parada sem pausa declarada com fila
 * esperando vaga, ou o erro de transporte não passou com as retomadas. Palavras fixas, uma linha — os mesmos passos do
 * {@link PARK_LINE}, sem a exceção da entrega (aqui o driver fica sempre: o serviço devolve o card à fila).
 */
export const QUIET_PARK_LINE =
  "estacionar — esta sessão ficou parada sem pausa declarada e está segurando uma vaga de condutor. " +
  "Faça, nesta ordem: (1) atualize no card a seção «Estado do condutor» (bloco e passo atuais, o que já está pronto, o que falta, " +
  "as perguntas abertas e o nome do branch); (2) commite tudo o que há no worktree; (3) release_claim; " +
  "(4) worktree_discard — o branch com commits não integrados fica preservado; (5) NÃO limpe o driver do card; " +
  "(6) encerre o turno sem pedir mais nada. O serviço devolve o card à fila e um condutor novo retoma do «Estado do condutor».";

/** A linha de RETOMAR depois de um erro de transporte — o «continue» que alguém digitaria à mão. */
export const TRANSPORT_RETRY_LINE =
  "continuar — sua resposta anterior foi cortada por um erro de API (a conexão parou no meio). " +
  "Retome exatamente de onde parou: releia o card (get_card) se precisar e siga.";

/** O LEMBRETE ao condutor quieto com fila esperando vaga: siga, ou declare a espera — senão o serviço pede para estacionar. */
export const NUDGE_LINE =
  "continuar — esta sessão está quieta há alguns minutos sem pausa declarada e há card na fila esperando uma vaga de condutor. " +
  "Releia o card (get_card) e siga do ponto em que parou; se você está esperando algo (uma decisão, a integração), declare a espera " +
  "com report_progress (campo waiting). Se continuar parada, o serviço vai pedir para estacionar.";

/**
 * story-ex9602 — a linha do estacionar quando a espera foi DECLARADA mas não é uma pergunta do dono: a sessão disse que
 * espera algo (report_progress waiting) e ficou parada segurando a vaga com fila esperando. Uma espera declarada no
 * terminal não chega a ninguém — nenhum item no Inbox — e, num board com uma vaga só, trava a fila inteira. Palavras
 * fixas: se a espera é por algo que só uma pessoa faz, ela vira uma pergunta do dono no card (é o que põe o pedido no Inbox e acorda o card
 * com a resposta); depois, os mesmos passos do {@link PARK_LINE}.
 */
export const DECLARED_PARK_LINE =
  "estacionar — esta sessão declarou uma espera e está parada há tempo demais segurando uma vaga de condutor, com card na fila. " +
  "Se o que você espera é algo que só o operador ou o dono faz (editar um caminho de controle, uma permissão, uma decisão), " +
  "transforme a espera numa pergunta do dono neste card ANTES de estacionar: ask_question com o marcador [humano] no texto, " +
  "o que exatamente fazer no contexto (o diff, quando houver) e as opções «Feito» e «Não fazer». " +
  "Depois, nesta ordem: (1) atualize no card a seção «Estado do condutor» (bloco e passo atuais, o que já está pronto, o que falta, " +
  "as perguntas abertas e o nome do branch); (2) commite tudo o que há no worktree; (3) release_claim; " +
  "(4) worktree_discard — o branch com commits não integrados fica preservado; (5) NÃO limpe o driver do card; " +
  "(6) encerre o turno sem pedir mais nada. Quando a pergunta for respondida, o serviço reabre um condutor para este card na frente da fila.";

/** As retomadas por erro de transporte são contadas nesta janela: duas falhas seguidas são infraestrutura, não acaso. */
export const TRANSPORT_RETRY_WINDOW_MS = 60 * 60_000;

/** Por que a sessão foi estacionada — decide a linha e o que acontece com o card depois. */
export type ParkCause = "owner" | "transport" | "quiet" | "declared";

/**
 * A linha do estacionar quando o BOARD foi pausado com «parar agora» (board-pace.ts). Palavras fixas, os mesmos passos
 * do {@link QUIET_PARK_LINE} — o driver fica: quando o board for retomado, o serviço reabre um condutor para o card.
 */
export const PACE_PARK_LINE =
  "estacionar — este board foi pausado e esta sessão precisa guardar o trabalho e encerrar agora. " +
  "Faça, nesta ordem: (1) atualize no card a seção «Estado do condutor» (bloco e passo atuais, o que já está pronto, o que falta, " +
  "as perguntas abertas e o nome do branch); (2) commite tudo o que há no worktree; (3) release_claim; " +
  "(4) worktree_discard — o branch com commits não integrados fica preservado; (5) NÃO limpe o driver do card; " +
  "(6) encerre o turno sem pedir mais nada. Quando o board for retomado, o serviço reabre um condutor para este card na frente da fila.";

/** Memória do passe POR SESSÃO. Em processo: um restart só repete um passo da escada uma vez. */
export interface ConductorParkMemo {
  board: string;
  cardId: string;
  /** o pedido de estacionar foi entregue (uma vez por sessão). */
  askedAt?: number;
  /** `pace` = o board foi pausado com «parar agora» ({@link parkBoardConductors}); as outras vêm da escada. */
  parkCause?: ParkCause | "pace";
  /** o lembrete do condutor quieto (uma vez por sessão). */
  nudgedAt?: number;
  /** as retomadas por erro de transporte entregues (instantes). */
  retriedAt?: number[];
}
export type ConductorParkState = Map<string, ConductorParkMemo>;

/** O que o passe sabe de UM condutor vivo agora. */
export interface QuietLadderFacts {
  /** quieto no prompt há quanto (null = trabalhando ou não observado; o filho vivo vem à parte, em `childBusy`). */
  quietForMs: number | null;
  asking: boolean;
  /** o último turno morreu num erro de transporte (o texto), ou null. */
  transportError: string | null;
  /** a sessão declarou a espera (report_progress waiting). */
  declaredWaiting: boolean;
  /** o prazo que a espera declarada trouxe (`until`, epoch ms), ou null. Ausente ⇒ sem prazo. */
  declaredUntilMs?: number | null;
  /** a espera é do dono ({@link waitsForOwner}). */
  ownerWait: boolean;
  /** cards do MESMO board na fila do condutor esperando uma vaga. */
  slotWaiters: number;
  /** o claude do pane tem filho vivo, ou a sonda não soube (conductor-quiet.ts `childBusy`). Ausente ⇒ não. */
  childBusy?: boolean;
}

/**
 * Por quanto tempo de transcript parado um FILHO VIVO no pane ainda conta como trabalho: este fator × `afterMinutes`
 * (30 min no padrão). Uma suíte em segundo plano do monorepo leva até ~20 min com a máquina carregada; passado isso sem
 * o transcript andar, o filho é processo esquecido — o dev server subido no VERIFICAR, um watcher, um servidor MCP
 * stdio (vivem enquanto o claude viver) — e não pode segurar a vaga com fila esperando (revisão do WP5-F2).
 */
export const CHILD_WORK_WINDOW_FACTOR = 3;
const childWorkWindowMs = (s: ParkSettings) => CHILD_WORK_WINDOW_FACTOR * Math.max(1, s.afterMinutes) * 60_000;

/**
 * O prazo que a ESCADA ainda tem para agir num condutor quieto — o vigia de card parado só avisa depois dele (enquanto a
 * escada tem prazo, a quietude é tratada, não é travamento). PURA, a MESMA conta da {@link quietLadderStep}: sem erro de
 * transporte nem fila esperando vaga não há escada (0); senão, o maior entre o degrau do quieto (lembrete — mais tarde
 * com filho vivo, pela janela dele — e depois estacionar) e o das retomadas por erro de transporte.
 */
export function ladderGraceMs(s: ParkSettings, f: { transportError: boolean; slotWaiters: number; childBusy: boolean }): number {
  if (!f.transportError && f.slotWaiters <= 0) return 0;
  const quietRung = Math.max(s.nudgeAfterMinutes, f.childBusy ? CHILD_WORK_WINDOW_FACTOR * s.afterMinutes : 0) + s.afterMinutes;
  const transportRung = (s.transportRetries + 1) * s.transportRetryAfterMinutes;
  return Math.max(quietRung, transportRung) * 60_000;
}

export type QuietLadderStep =
  | { kind: "none" }
  | { kind: "transport-retry"; attempt: number }
  | { kind: "nudge" }
  | { kind: "park"; cause: ParkCause };

/**
 * A ESCADA ÚNICA do condutor parado — PURA (os fatos chegam prontos; quem digita é {@link parkWaitingConductors}).
 * A vaga só é segurada por atividade provada ou espera declarada (RC5). Em ordem:
 *   1. já pedido para estacionar, trabalhando ou com um prompt desenhado ⇒ nada;
 *   2. ERRO DE TRANSPORTE no último turno e quieto há `transportRetryAfterMinutes` ⇒ a linha fixa de retomar, até
 *      `transportRetries` vezes por hora (e nunca duas no mesmo intervalo); esgotadas ⇒ estacionar. Não depende de fila
 *      nem de filho vivo: um turno cortado não volta sozinho (ficaria parado até alguém digitar «continue» à mão);
 *   3. espera do DONO quieta há `afterMinutes` ⇒ estacionar (fatia 2 das paradas por recurso), com filho vivo ou não —
 *      como antes do F2;
 *   4. QUIETO sem pausa declarada, com fila esperando vaga no board, há `nudgeAfterMinutes` ⇒ UM lembrete; quieto de novo
 *      por `afterMinutes` depois dele ⇒ estacionar. Um FILHO VIVO no pane (a suíte em segundo plano) adia os dois enquanto
 *      o transcript parou há menos de {@link CHILD_WORK_WINDOW_FACTOR} × `afterMinutes` — nunca para sempre. Sem fila,
 *      ninguém é incomodado (aparece como «parado», só isso).
 */
export function quietLadderStep(f: QuietLadderFacts, memo: ConductorParkMemo | undefined, s: ParkSettings, now: number): QuietLadderStep {
  if (memo?.askedAt !== undefined) return { kind: "none" };
  if (f.quietForMs == null || f.asking) return { kind: "none" };
  const min = (m: number) => Math.max(1, m) * 60_000;
  if (f.transportError) {
    if (f.quietForMs < min(s.transportRetryAfterMinutes)) return { kind: "none" };
    const recent = (memo?.retriedAt ?? []).filter((t) => now - t < TRANSPORT_RETRY_WINDOW_MS);
    const last = recent.at(-1);
    if (last !== undefined && now - last < min(s.transportRetryAfterMinutes)) return { kind: "none" }; // a linha ainda não pegou
    return recent.length < s.transportRetries ? { kind: "transport-retry", attempt: recent.length + 1 } : { kind: "park", cause: "transport" };
  }
  if (f.ownerWait) return f.quietForMs >= min(s.afterMinutes) ? { kind: "park", cause: "owner" } : { kind: "none" };
  if (f.slotWaiters <= 0) return { kind: "none" };
  // story-ex9602: a espera declarada segura a vaga, mas não para sempre — com prazo, até o prazo; sem prazo, até
  // `declaredAfterMinutes` quieta. Depois, o pedido de estacionar que a transforma numa pergunta do dono.
  if (f.declaredWaiting) {
    if (f.declaredUntilMs != null && f.declaredUntilMs > now) return { kind: "none" };
    return f.quietForMs >= min(s.declaredAfterMinutes) ? { kind: "park", cause: "declared" } : { kind: "none" };
  }
  if (f.childBusy && f.quietForMs < childWorkWindowMs(s)) return { kind: "none" };
  if (memo?.nudgedAt === undefined) return f.quietForMs >= min(s.nudgeAfterMinutes) ? { kind: "nudge" } : { kind: "none" };
  return f.quietForMs >= min(s.afterMinutes) && now - memo.nudgedAt >= min(s.afterMinutes) ? { kind: "park", cause: "quiet" } : { kind: "none" };
}

/** A linha que cada degrau digita — palavras fixas, nunca texto de quem chamou. PURA. */
export function ladderLine(step: Exclude<QuietLadderStep, { kind: "none" }>): string {
  if (step.kind === "transport-retry") return TRANSPORT_RETRY_LINE;
  if (step.kind === "nudge") return NUDGE_LINE;
  return step.cause === "owner" ? PARK_LINE : step.cause === "declared" ? DECLARED_PARK_LINE : QUIET_PARK_LINE;
}

/** O que cada degrau deixa no registro de decisões do sistema (o dono lê no Inbox/registro). PURA. */
export function ladderDecision(
  step: Exclude<QuietLadderStep, { kind: "none" }>,
  ctx: { board: string; card: Pick<Card, "id" | "title">; quietMin: number; transportError: string | null; slotWaiters: number; retries: number; at: string; id: string },
): SystemDecision {
  const base = { v: 1 as const, id: ctx.id, at: ctx.at, board: ctx.board, cardId: ctx.card.id, agent: "system" };
  const fila = `${ctx.slotWaiters} card(s) na fila esperando vaga`;
  if (step.kind === "transport-retry") {
    return {
      ...base,
      kind: "stall-retry",
      what: `Retomou o condutor de «${ctx.card.title}» depois de um erro de API (${step.attempt}/${ctx.retries})`,
      why: `o último turno foi cortado («${(ctx.transportError ?? "API Error").slice(0, 120)}») e a sessão ficou parada no prompt há ${ctx.quietMin} min`,
    };
  }
  if (step.kind === "nudge") {
    return {
      ...base,
      kind: "stall-retry",
      what: `Lembrou o condutor de «${ctx.card.title}» que ele segura uma vaga`,
      why: `a sessão está quieta há ${ctx.quietMin} min sem pausa declarada e há ${fila}`,
    };
  }
  const why =
    step.cause === "owner"
      ? `a sessão espera uma decisão sua há ${ctx.quietMin} min — o trabalho fica guardado e o card volta para a frente da fila quando você decidir`
      : step.cause === "declared"
        ? `a sessão declarou uma espera e ficou parada há ${ctx.quietMin} min com ${fila} — o pedido vira uma pergunta sua no card, o trabalho fica guardado e o card volta quando você responder`
        : step.cause === "transport"
        ? `o erro de API se repetiu depois de ${ctx.retries} retomada(s) («${(ctx.transportError ?? "API Error").slice(0, 120)}») — o trabalho fica guardado e o card volta para a fila`
        : `a sessão seguiu quieta depois do lembrete, sem pausa declarada, com ${fila} — o trabalho fica guardado e o card volta para a fila`;
  return { ...base, kind: "conductor-park", what: `Estacionou o condutor de «${ctx.card.title}»`, why, undo: { kind: "resume-conductor", cardId: ctx.card.id } };
}

export interface ConductorParkDeps extends PaneDeps {
  settings(): ParkSettings;
  /** há quanto tempo a sessão está quieta no prompt (`null` = trabalhando ou não observada). */
  quietForMs(tmux: string): number | null;
  /** um prompt desenhado na tela (menu, s/N): digitar ali seria respondê-lo. */
  asking(tmux: string): boolean;
  /** o último turno morreu num erro de transporte (o texto), ou null. Ausente ⇒ nunca. */
  transportError?(tmux: string): string | null;
  /** o claude do pane tem filho vivo (ou não se sabe) — {@link QuietLadderFacts.childBusy}. Ausente ⇒ não. */
  childBusy?(tmux: string): boolean;
  /** cards do board na fila do condutor esperando uma vaga. Ausente ⇒ 0 (sem fila, o lembrete não sai). */
  slotWaiters?(board: string): number;
  /**
   * devolve à fila o card de um condutor que estacionou por quietude/transporte (a espera do dono volta pelo acordar):
   * `resume` na frente (o erro de API interrompeu trabalho), `yield` depois de quem esperava vaga (ele CEDEU a vaga —
   * conductor.ts `ConductorQueueEntry.yielded`).
   */
  requeue?(board: string, cardId: string, place: "resume" | "yield"): Promise<unknown>;
  /** o registro de decisões do sistema. */
  record?(entry: SystemDecision): Promise<void>;
  newId?(): string;
  state: ConductorParkState;
}

export interface ConductorParkReport {
  asked: Array<{ board: string; cardId: string; tmuxSession: string; cause?: ParkCause }>;
  nudged: Array<{ board: string; cardId: string; tmuxSession: string }>;
  retried: Array<{ board: string; cardId: string; tmuxSession: string; attempt: number }>;
  requeued: Array<{ board: string; cardId: string }>;
}

/**
 * Um passe da escada sobre cada condutor vivo (ver {@link quietLadderStep}), e a volta à fila do card cujo condutor
 * estacionou por quietude ou transporte e já saiu. Só pane que prova rodar o claude recebe texto. Nunca lança.
 */
export async function parkWaitingConductors(deps: ConductorParkDeps): Promise<ConductorParkReport> {
  const log = deps.log ?? ((l: string) => console.log(`[conductor] ${l}`));
  const report: ConductorParkReport = { asked: [], nudged: [], retried: [], requeued: [] };
  try {
    const live = await deps.liveTmux().catch(() => null);
    if (live === null) return report;
    const now = (deps.now ?? Date.now)();
    const settings = deps.settings();
    const conductors = (await deps.sessions()).filter((s) => !!s.tmuxSession && !!s.board && !!s.cardId && isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone));
    const alive = new Set(conductors.map((s) => s.sessionId));

    // A sessão estacionada SAIU (worktree_discard tira a linha): o card de quem parou por quietude/transporte volta à
    // fila — sem isso ele ficaria com o driver e sem ninguém. O que esperava o dono volta pelo acordar (a resposta).
    // Quem parou por QUIETUDE volta cedendo a vez: a vaga foi liberada para quem esperava, não para ele reconquistá-la.
    for (const [id, memo] of deps.state) {
      if (alive.has(id)) continue;
      if (memo.askedAt !== undefined && memo.parkCause && memo.parkCause !== "owner" && deps.requeue) {
        const [card, config] = await Promise.all([deps.readCard(memo.board, memo.cardId).catch(() => null), deps.readBoardConfig(memo.board).catch(() => null)]);
        const back = !!card && !!config && isConducted(card) && !config.statuses.find((x) => x.id === card.status)?.terminal && openQuestions(card).length === 0;
        if (back) {
          // Quem parou por QUIETUDE (ou por uma espera declarada sem pergunta do dono) cedeu a vaga; o erro de API e a pausa
          // do board INTERROMPERAM trabalho: voltam na frente. A espera que virou pergunta do dono volta pelo acordar (a resposta).
          const ok = await deps.requeue(memo.board, memo.cardId, memo.parkCause === "quiet" || memo.parkCause === "declared" ? "yield" : "resume").then(() => true, () => false);
          if (!ok) continue; // tenta de novo no próximo passe
          report.requeued.push({ board: memo.board, cardId: memo.cardId });
          log(`${memo.board}/${memo.cardId}: o condutor estacionou (${memo.parkCause}) — o card voltou para a fila`);
        }
      }
      deps.state.delete(id);
    }

    for (const s of conductors) {
      const tmux = s.tmuxSession as string;
      const board = s.board as string;
      const cardId = s.cardId as string;
      const memo = deps.state.get(s.sessionId);
      if (memo?.askedAt !== undefined) continue; // já pedido: uma vez por sessão
      const quiet = deps.quietForMs(tmux);
      if (quiet == null || deps.asking(tmux)) continue;
      const [card, config] = await Promise.all([deps.readCard(board, cardId), deps.readBoardConfig(board)]);
      if (!card || !config || !isConducted(card)) continue;
      const facts: QuietLadderFacts = {
        quietForMs: quiet,
        asking: false,
        transportError: deps.transportError?.(tmux) ?? null,
        declaredWaiting: !!s.progress?.waiting,
        declaredUntilMs: s.progress?.until ? Date.parse(s.progress.until) || null : null,
        ownerWait: waitsForOwner(card, config),
        slotWaiters: deps.slotWaiters?.(board) ?? 0,
        childBusy: deps.childBusy?.(tmux) ?? false,
      };
      const step = quietLadderStep(facts, memo, settings, now);
      if (step.kind === "none") continue;
      if (!(await deps.runsClaude(tmux))) continue;
      if (!(await deps.deliver(tmux, ladderLine(step)))) continue; // tenta de novo no próximo passe
      const next: ConductorParkMemo = { ...(memo ?? { board, cardId }), board, cardId };
      const quietMin = Math.round(quiet / 60_000);
      if (step.kind === "transport-retry") {
        next.retriedAt = [...(next.retriedAt ?? []).filter((t) => now - t < TRANSPORT_RETRY_WINDOW_MS), now];
        report.retried.push({ board, cardId, tmuxSession: tmux, attempt: step.attempt });
        log(`${board}/${cardId}: o último turno morreu num erro de API e a sessão está parada há ${quietMin}min — retomada ${step.attempt}/${settings.transportRetries} enviada (${tmux})`);
      } else if (step.kind === "nudge") {
        next.nudgedAt = now;
        report.nudged.push({ board, cardId, tmuxSession: tmux });
        log(`${board}/${cardId}: condutor quieto há ${quietMin}min sem pausa declarada, com fila esperando vaga — lembrete enviado (${tmux})`);
      } else {
        next.askedAt = now;
        next.parkCause = step.cause;
        report.asked.push({ board, cardId, tmuxSession: tmux, cause: step.cause });
        log(`${board}/${cardId}: condutor quieto há ${quietMin}min (${step.cause === "owner" ? "esperando o dono" : step.cause === "transport" ? "erro de API repetido" : step.cause === "declared" ? "espera declarada longa, com fila esperando" : "depois do lembrete, com fila esperando"}) — pedido de estacionar enviado (${tmux})`);
      }
      deps.state.set(s.sessionId, next);
      if (deps.record) {
        const entry = ladderDecision(step, {
          board,
          card,
          quietMin,
          transportError: facts.transportError,
          slotWaiters: facts.slotWaiters,
          retries: settings.transportRetries,
          at: new Date(now).toISOString(),
          id: deps.newId?.() ?? `park-${s.sessionId}-${now}`,
        });
        await deps.record(entry).catch((err) => log(`${board}/${cardId}: o registro da decisão falhou — ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  } catch (err) {
    log(`o passe de estacionar falhou — ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}

// ── O BOARD FOI PAUSADO COM «PARAR AGORA» (board-pace.ts) ────────────────────────────────────────────

export interface BoardParkDeps extends PaneDeps {
  /** um prompt desenhado na tela (menu, s/N): digitar ali seria respondê-lo. Ausente ⇒ nunca. */
  asking?(tmux: string): boolean;
  state: ConductorParkState;
}

/**
 * Pede a CADA condutor vivo do board que estacione ({@link PACE_PARK_LINE}): guardar o estado no card, commitar e
 * encerrar. Uma vez por sessão (a memória do passe é a mesma da escada, então o card volta para a fila quando a sessão
 * sair — e espera lá até o board ser retomado). Quem tem um prompt na tela fica para a escada. Nunca lança.
 */
export async function parkBoardConductors(deps: BoardParkDeps, board: string): Promise<Array<{ cardId: string; tmuxSession: string }>> {
  const log = deps.log ?? ((l: string) => console.log(`[conductor] ${l}`));
  const asked: Array<{ cardId: string; tmuxSession: string }> = [];
  try {
    const live = await deps.liveTmux().catch(() => null);
    if (live === null) return asked;
    const now = (deps.now ?? Date.now)();
    for (const s of await deps.sessions()) {
      if (s.board !== board || !s.tmuxSession || !s.cardId || !isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone)) continue;
      if (deps.state.get(s.sessionId)?.askedAt !== undefined) continue;
      if (deps.asking?.(s.tmuxSession)) continue;
      if (!(await deps.runsClaude(s.tmuxSession))) continue;
      if (!(await deps.deliver(s.tmuxSession, PACE_PARK_LINE))) continue;
      deps.state.set(s.sessionId, { ...(deps.state.get(s.sessionId) ?? {}), board, cardId: s.cardId, askedAt: now, parkCause: "pace" });
      asked.push({ cardId: s.cardId, tmuxSession: s.tmuxSession });
      log(`${board}/${s.cardId}: o board foi pausado — pedido de estacionar enviado (${s.tmuxSession})`);
    }
  } catch (err) {
    log(`pedido de estacionar do board ${board} falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
  return asked;
}
