// The CONDUCTOR dispatch — "the human's acceptance is the go".
//
// The linear Kanban stops being the control flow for a conducted story: ONE interactive agent session (the
// `harness-conductor` skill) carries the card through shape → build → verify → publish in one context, and
// the columns become a PROJECTION of its progress. This module is the declarative switch that turns that on:
//
//   board.yaml
//     conductor: { enabled: true, fromStatus: <status id>, maxSessions: 2, model: opus }
//
// When a story card ENTERS `fromStatus` (evaluateAutorunOnEntry — the single chokepoint every entry path
// already funnels through: a drag, an MCP move, an accept, the watcher, the cascade forward):
//
//   1. ADMIT   — stamp `routing.driver: conductor` on the card (the SAME per-card lock every writer uses) and
//                append it to a DURABLE queue. From this instant the cascade and the engine are silent for the
//                card (cascade-decision.ts / engine.ts), so no column skill races the conductor into it.
//   2. PUMP    — serialized; for each queued card, in the board's PRIORITY order (FIFO only where the priority is
//                silent — compareConductorQueue), if the board has a free conductor slot (`maxSessions`, live
//                conductors counted per board) spawn the session through the SAME door `claude_new` uses
//                (`spawnWorkSession`: admission + resource probe, worktree, card claim, scoped MCP token,
//                tmux, role `implement`), whose first prompt is `/harness-conductor <board>/<cardId>`.
//                The excess WAITS; the pump runs again on every fleet tick (instrumentation.ts), which is also
//                where a dead conductor is noticed — so a slot freed by a session ending is re-used on the
//                next tick with no extra wiring.
//   2b. ADOPT  — WP5-F2: the pump also admits ORPHANS — story cards already sitting in `fromStatus` with no driver
//                (they were there before the switch, or their entry event was lost), which the entry chokepoint never
//                sees again (isConductorOrphan). Same verdict as the entry, so it is idempotent with it. A card someone
//                is on (a live session of any driver, a claim, a run, a merge) is never adopted (adoptOrphans).
//   3. END     — a conductor whose story is OVER (card delivered/terminal, discontinued, trashed, or no longer
//                conducted) stops holding a slot at once, and — after a short grace, and only when everything
//                it produced is integrated — is asked to `/exit` (in a real case, conductors sat idle
//                in a delivered column for days and the queue waited on them the whole time).
//
// Idempotent end to end: the driver write is a no-op when already set, the queue dedupes by card, the pump
// skips a card that already has a live conductor, and the claim refuses a second implementer anyway.
//
// What this module deliberately does NOT do:
//   • re-dispatch a card whose conductor DIED. The driver stays (no stale column run), the claim is released
//     by the fleet reconcile, and the operator decides: reopen a conductor (`claude_new` with the conductor
//     task) or clear the driver (`set_card_driver`). An automatic respawn loop over a session that keeps dying
//     is the failure mode a human must see, not one to paper over;
//   • spawn anything while the live master switch is off or the board gate holds (board-pace.ts: the board is
//     disarmed or paused): the queue waits, and resumes by itself when the switch comes back.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { conductorCommand, conductorEntryVerdict, conductorModelFor, conductorTask, CONDUCTOR_SKILL, isConducted, resolveConductorPolicy } from "@/lib/storymap/driver";
import { cardWsjf } from "@/lib/storymap/wsjf";
import type { BugSeverity } from "@/lib/storymap/frameworks";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { AgentSession, SessionWorkVerdict } from "./session-worktree";
import type { SpawnSessionInput, SpawnSessionResult } from "./session-spawn";
import type { GateVerdict } from "./capacity-governor";
import { gateOf, paceCap, type BoardGate, type BoardGatePort } from "./board-pace";

// ── PURE policy (lives in ../driver.ts — isomorphic, so the move risk class can ask it too) ──────────────
export {
  conductorEntryVerdict,
  conductorModelFor,
  conductorTask,
  CONDUCTOR_DEFAULT_MODEL,
  resolveConductorPolicy,
  type ConductorEntryVerdict,
  type ResolvedConductorPolicy,
} from "@/lib/storymap/driver";

/**
 * Is `s` a LIVE conductor session? PURE. A conductor is alive while its tmux answers. When the tmux probe could
 * not answer (`liveTmux === null`) every registered conductor counts as alive — the fail-closed direction for a
 * CAP (the worst case is waiting one more tick, never spawning a third conductor on a full box). A session with
 * no tmux handle (it should not happen for a dispatched conductor) counts by its registry heartbeat.
 *
 * WP5-F2 — o TMUX ZUMBI não é condutor vivo: a árvore de trabalho da linha (worktree/cwd) foi APAGADA e o claude
 * segue no prompt, sem ter onde trabalhar (num caso real, o terminal com cwd «(deleted)» contava como uma das
 * vagas do board enquanto vários cards esperavam). `treeGone` é a prova (IO na borda); ausente ⇒ ninguém é zumbi. Um tmux
 * SEM linha no registro nunca chega aqui — só linhas contam — e o passe de órfãos o encerra.
 */
export function isLiveConductor(
  s: AgentSession,
  liveTmux: ReadonlySet<string> | null,
  heartbeatAlive: (s: AgentSession) => boolean,
  treeGone?: (s: AgentSession) => boolean,
): boolean {
  if (s.driver !== "conductor") return false;
  if (treeGone?.(s)) return false;
  return isLiveSession(s, liveTmux, heartbeatAlive);
}

/**
 * A linha do registro é de uma sessão VIVA, qualquer que seja o driver? PURA — a mesma prova do {@link isLiveConductor}
 * (o tmux responde; sem tmux, o heartbeat; sonda sem resposta ⇒ viva, a direção segura), sem o filtro do zumbi: quem
 * pergunta é a ADOÇÃO de órfãos, que muda o card, e um terminal com a árvore apagada ainda é alguém que o operador vê.
 */
export function isLiveSession(s: AgentSession, liveTmux: ReadonlySet<string> | null, heartbeatAlive: (s: AgentSession) => boolean): boolean {
  if (!s.tmuxSession) return heartbeatAlive(s);
  if (liveTmux === null) return true;
  return liveTmux.has(s.tmuxSession);
}

/**
 * The tmux slug of a conductor dispatch: the card id plus a short per-dispatch suffix, so two dispatches of the
 * same card never share a tmux name (see the spawn site). PURE.
 */
export function conductorSessionSlug(cardId: string, now: number): string {
  return `conductor-${cardId}-${now.toString(36).slice(-4)}`;
}

/**
 * Live conductors per board, counted by the PROCESS that hosts them: rows that name the same tmux session are one
 * conductor (a tmux hosts one `claude`). A row with no tmux (heartbeat-only) counts on its own. PURE.
 */
export function countLiveConductorsByBoard(liveConductors: readonly AgentSession[]): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const s of liveConductors) {
    if (!s.board) continue;
    const key = s.tmuxSession ? `tmux:${s.tmuxSession}` : `session:${s.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(s.board, (out.get(s.board) ?? 0) + 1);
  }
  return out;
}

/** As vagas de condutor de UM board, como o nav e o Kanban as mostram (WP5-F2). */
export interface ConductorSlotFacts {
  board: string;
  /** condutores que OCUPAM vaga agora: vivos, sem zumbi e sem quem já terminou a story. */
  used: number;
  /** o teto do board (`conductor.maxSessions`); 0 = condutor desligado neste board. */
  max: number;
  /** a vaga extra do board agora (para card pequeno) — aberta, ou fechada e por qual trava. */
  extra: { open: boolean; why: string };
  /** entradas da fila deste board, e quantas delas esperam VAGA (as outras esperam conta, orçamento, autorun…). */
  queued: number;
  waitingForSlot: number;
}

/**
 * As vagas de condutor de um board — PURA, a MESMA conta do pump ({@link countLiveConductorsByBoard} sobre os vivos que
 * não terminaram), para o nav nunca dizer um número diferente do que o despacho usa. `liveConductors` já vem filtrado
 * por {@link isLiveConductor}; `extra` é o veredito da vaga extra do board (extra-slot.ts), `null` = não medido.
 */
export function conductorSlotFacts(
  board: string,
  input: {
    config: Pick<BoardConfig, "conductor"> | null;
    liveConductors: readonly AgentSession[];
    finished?: ReadonlySet<string>;
    queue: readonly ConductorQueueEntry[];
    extra: { open: boolean; why: string } | null;
    /** o portão do board (board-pace.ts): pausado ⇒ nenhuma vaga; devagar ⇒ uma, sem a extra. Ausente ⇒ ritmo normal. */
    gate?: Pick<BoardGate, "level" | "held" | "why">;
  },
): ConductorSlotFacts {
  const policy = resolveConductorPolicy(input.config);
  const paced = input.gate && (input.gate.held || input.gate.level === "slow") ? input.gate : null;
  const holding = input.liveConductors.filter((s) => s.board === board && !input.finished?.has(s.sessionId));
  const mine = input.queue.filter((e) => e.board === board);
  return {
    board,
    used: countLiveConductorsByBoard(holding).get(board) ?? 0,
    // o MESMO teto que o pump aplica (paceCap): o nav nunca mostra duas vagas num board que anda um por vez
    max: paced ? paceCap(policy?.maxSessions ?? 0, paced) : (policy?.maxSessions ?? 0),
    extra: paced
      ? { open: false, why: paced.held ? paced.why : "o board está em ritmo devagar (um card por vez)" }
      : input.extra
        ? { open: input.extra.open, why: input.extra.why }
        : { open: false, why: "a vaga extra não foi medida agora" },
    queued: mine.length,
    waitingForSlot: mine.filter((e) => isSlotWait(e.lastWaitKind)).length,
  };
}

/**
 * Why a conductor's story is OVER — or null while it is still the conductor's to carry. PURE. Over = the card is
 * gone (trashed), no longer conducted, being discontinued (`mode: retire`), or in a terminal status (delivered
 * is a subset of terminal). An unreadable board config cannot say "terminal", so it answers null (keeps the slot).
 */
export function conductorDoneReason(card: Card | null, config: BoardConfig | null): string | null {
  if (!card) return "o card não existe mais";
  if (!isConducted(card)) return "o card não tem mais routing.driver: conductor";
  if (card.mode === "retire") return "o card está sendo descontinuado";
  if (card.deferred) return "o card foi adiado (não agora)";
  const def = card.status ? config?.statuses.find((s) => s.id === card.status) : undefined;
  if (def?.delivered) return `o card foi entregue (${card.status})`;
  if (def?.terminal) return `o card está num status terminal (${card.status})`;
  return null;
}

/**
 * The live conductors whose story is over, by sessionId → why. A card that could not be READ (the reader threw)
 * is not "gone": that conductor keeps its slot — the fail-closed direction for a cap.
 */
export async function finishedConductors(
  deps: Pick<ConductorDeps, "readCard" | "readBoardConfig">,
  live: readonly AgentSession[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of live) {
    if (!s.board || !s.cardId) continue;
    const [card, config] = await Promise.all([
      deps.readCard(s.board, s.cardId).then((c) => c, () => undefined),
      deps.readBoardConfig(s.board).catch(() => null),
    ]);
    if (card === undefined) continue;
    const why = conductorDoneReason(card, config);
    if (why) out.set(s.sessionId, why);
  }
  return out;
}

// ── the durable queue ───────────────────────────────────────────────────────────────────────────────────

/** One card waiting for a conductor slot. Durable: a restart must not strand a card that already has the
 *  driver (the cascade is silent for it — a lost queue entry would be a card nobody ever picks up). */
export interface ConductorQueueEntry {
  board: string;
  cardId: string;
  queuedAt: string;
  /** spawn attempts that failed for a reason no slot explains (plumbing) — bounded by {@link CONDUCTOR_MAX_SPAWN_ATTEMPTS}. */
  attempts: number;
  lastError?: string;
  /**
   * POR QUE a entrada está esperando, dito na última passada — e DESDE QUANDO esse motivo vale. A espera era
   * muda: medido na v0.8.0 no ar, um condutor retido pela janela da conta não deixava rastro nenhum (nem log, nem
   * estado, e o painel do governador dizia «retidos: nenhum»). `lastWaitKind` é a classe estável do motivo (o
   * texto traz números que mudam a cada passada): o log sai só quando ELA muda, e `lastWaitAt` é quando começou.
   */
  lastWaitReason?: string;
  lastWaitKind?: string;
  lastWaitAt?: string;
  /**
   * RETOMADA de um card ESTACIONADO (regra: «na frente»): o card já tem trabalho feito e a
   * decisão que ele esperava saiu — terminar o que está quase pronto libera a vaga mais rápido do que começar outro.
   * Uma entrada com esta marca passa na frente de toda a fila; entre retomadas vale FIFO.
   */
  resume?: true;
  /**
   * O card CEDEU a vaga: o condutor dele estacionou por QUIETUDE (conductor-pause.ts) — a vaga foi liberada para quem
   * esperava, e ele volta DEPOIS de todos eles, qualquer tier (revisão do WP5-F2: com o tier dele, o bug alto reconquistava
   * a vaga que acabara de liberar, os tier 0 seguiam esperando e o ciclo de 20 min se repetia). A marca sai na passada
   * que despacha outro card do mesmo board — servida a vez cedida, ele volta a disputar pelo seu tier.
   */
  yielded?: true;
}

export interface ConductorQueueStore {
  load(): Promise<ConductorQueueEntry[]>;
  persist(entries: ConductorQueueEntry[]): Promise<void>;
}

/** `storymap/.runner/conductor-queue.json` (gitignored with the rest of `.runner/`). */
export function conductorQueuePath(): string {
  return path.join(runnerStateDir(), "conductor-queue.json");
}

/** Disk store — atomic temp+rename; an unreadable file reads as EMPTY (the cards keep their driver, and the
 *  operator sees them as conducted-with-no-session in the fleet view: visible, never silently respawned). */
export function diskConductorQueueStore(file: string = conductorQueuePath()): ConductorQueueStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { entries?: unknown };
        const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
        return list.filter(
          (e): e is ConductorQueueEntry =>
            !!e && typeof e === "object" && typeof (e as ConductorQueueEntry).board === "string" && typeof (e as ConductorQueueEntry).cardId === "string",
        );
      } catch {
        return [];
      }
    },
    async persist(entries) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify({ v: 1, entries }, null, 2));
    },
  };
}

/** A severidade do bug como tier da fila — a mesma escala do `priorityCall.rank` (3 Crítica → 0 Baixa). */
const SEVERITY_TIER: Readonly<Record<BugSeverity, number>> = { blocker: 3, high: 2, medium: 1, low: 0 };
/** Rótulos que dizem «segurança ou dados de pessoas» — vocabulário genérico, nunca o nome de um produto. */
const SECURITY_LABEL = /^(?:security|seguran[cç]a|privacy|privacidade|lgpd|gdpr|dados-pessoais|personal-data)$/i;

/**
 * WP5-F2 — o tier que um card SEM `priorityCall` ganha dos próprios fatos: a severidade do bug (bloqueante 3, alta 2,
 * média 1, baixa 0) e +1 com rótulo de segurança/dados de pessoas (no máximo 3); só o rótulo, sem severidade, vale 1.
 * `null` = nada a derivar. PURA. Caso real: nenhum dos cards na fila tinha priorityCall (o card conduzido pula o
 * passo priorizar), a fila era FIFO, e um bug ALTO esperou horas atrás de um bug baixo.
 */
export function derivedQueueTier(card: Pick<Card, "bugReport" | "labels">): number | null {
  const sev = card.bugReport?.severity;
  const base = sev && sev in SEVERITY_TIER ? SEVERITY_TIER[sev] : null;
  const sensitive = (card.labels ?? []).some((l) => typeof l === "string" && SECURITY_LABEL.test(l.trim()));
  if (base === null) return sensitive ? 1 : null;
  return Math.min(3, base + (sensitive ? 1 : 0));
}

/**
 * The DISPATCH ORDER of the queue — the board's own priority ruler (the Priorização screen's, wsjf.ts), FIFO only
 * where the ruler is silent. PURE and total:
 *   0. a RESUME of a parked card (`entry.resume`) goes before everything else — FIFO among resumes;
 *   0b. an entry that YIELDED its slot (`entry.yielded` — parked for being quiet) goes after every entry that did not,
 *      whatever its tier, until the pump serves the yielded turn (see {@link ConductorQueueEntry.yielded});
 *   1. the tier: `priorityCall.rank` (3 Crítica → 0 Baixa) when the card has one — an explicit call always wins over
 *      what the card's facts would derive — else the tier derived from the bug's severity and a security/personal-data
 *      label ({@link derivedQueueTier}, WP5-F2); a card with neither goes after every tiered one. On a tie, the
 *      explicit call goes before the derived tier;
 *   2. the WSJF ratio inside the tier, a ratio before none;
 *   3. FIFO by `queuedAt` for ties and for everything unscored — then board/card id, so any permutation of the
 *      same queue comes out in the same order.
 * A board expresses a sequence (e.g. the PRD's order of fronts) through its priority calls; the queue never reads
 * prose to guess one.
 */
export function compareConductorQueue(
  a: { entry: ConductorQueueEntry; card: Card | null },
  b: { entry: ConductorQueueEntry; card: Card | null },
): number {
  if (!!a.entry.resume !== !!b.entry.resume) return a.entry.resume ? -1 : 1;
  if (a.entry.resume && b.entry.resume) {
    const qa = a.entry.queuedAt ?? "";
    const qb = b.entry.queuedAt ?? "";
    if (qa !== qb) return qa < qb ? -1 : 1;
  }
  if (!!a.entry.yielded !== !!b.entry.yielded) return a.entry.yielded ? 1 : -1;
  const explicitA = a.card?.priorityCall?.rank;
  const explicitB = b.card?.priorityCall?.rank;
  const ra = explicitA ?? (a.card ? derivedQueueTier(a.card) : null) ?? -1;
  const rb = explicitB ?? (b.card ? derivedQueueTier(b.card) : null) ?? -1;
  if (ra !== rb) return rb - ra;
  if ((explicitA == null) !== (explicitB == null)) return explicitA == null ? 1 : -1;
  const wa = a.card ? cardWsjf(a.card) : null;
  const wb = b.card ? cardWsjf(b.card) : null;
  if (wa != null && wb != null && wa !== wb) return wb - wa;
  if ((wa == null) !== (wb == null)) return wa == null ? 1 : -1;
  const qa = a.entry.queuedAt ?? ""; // an entry read from disk without it sorts first — the oldest shape
  const qb = b.entry.queuedAt ?? "";
  if (qa !== qb) return qa < qb ? -1 : 1;
  return a.entry.board.localeCompare(b.entry.board) || a.entry.cardId.localeCompare(b.entry.cardId);
}

/** In-memory store (tests). */
export function memoryConductorQueueStore(seed: ConductorQueueEntry[] = []): ConductorQueueStore & { entries: ConductorQueueEntry[] } {
  const box = { entries: seed.map((e) => ({ ...e })) };
  return {
    get entries() {
      return box.entries;
    },
    async load() {
      return box.entries.map((e) => ({ ...e }));
    },
    async persist(entries) {
      box.entries = entries.map((e) => ({ ...e }));
    },
  };
}

// ── the dispatcher ──────────────────────────────────────────────────────────────────────────────────────

/** Plumbing failures (no slot/claim explains them) tolerated before the card is handed to the operator. */
export const CONDUCTOR_MAX_SPAWN_ATTEMPTS = 3;

/** The finding the operator sees when the dispatch gave up spawning (never for waiting or a claim). */
export const CONDUCTOR_DISPATCH_FINDING_ID = "conductor-dispatch";

/**
 * WP5-F1 — por que o card de uma entrada da fila NÃO veio, e o que a fila faz com cada resposta:
 *   • `unreadable` — o card não foi lido AGORA (o arquivo existe mas foi recusado/ilegível, ou nem deu para saber):
 *                    a entrada FICA e a próxima passada tenta de novo;
 *   • `trashed`    — alguém mandou o card para a lixeira: a saída é a decisão de quem apagou;
 *   • `missing`    — ENOENT confirmado, fora da lixeira: o card SUMIU com a fila esperando por ele. Sai da fila, mas
 *                    nunca em silêncio — vira decisão do sistema (`card-missing`) e alerta.
 * Caso real: cards aceitos na triagem foram apagados pelo merge train e a fila os tirou com uma
 * linha de journal («card não existe mais»), sem registro nenhum — um deles era um bug de segurança.
 */
export type QueuedCardMiss =
  | { kind: "unreadable"; detail: string }
  | { kind: "trashed" }
  | { kind: "missing"; lastHop: { from: string | null; to: string; at: string } | null };

/** PURA — o registro durável de um card que sumiu do disco com a fila do condutor esperando por ele. */
export function cardMissingDecision(
  entry: Pick<ConductorQueueEntry, "board" | "cardId" | "queuedAt">,
  miss: Extract<QueuedCardMiss, { kind: "missing" }>,
  at: string,
  id: string,
): SystemDecision {
  const hop = miss.lastHop
    ? `o último salto do ledger foi ${miss.lastHop.from ?? "—"} → ${miss.lastHop.to} (${miss.lastHop.at})`
    : "o ledger de transições não tem salto deste card";
  return {
    v: 1,
    id,
    at,
    board: entry.board,
    cardId: entry.cardId,
    agent: "system",
    kind: "card-missing",
    what: `O card ${entry.cardId} sumiu do disco com a fila do condutor esperando por ele`,
    why:
      `estava na fila desde ${entry.queuedAt}; o arquivo não existe em cards/ nem na lixeira; ${hop}. ` +
      `A entrada saiu da fila — recrie o card pelo caminho oficial (MCP) a partir deste registro e do histórico.`,
  };
}

export interface ConductorDeps {
  queue: ConductorQueueStore;
  /** every registered fleet session (the registry — alive or not). */
  sessions(): Promise<AgentSession[]>;
  /** names of the tmux sessions alive NOW; null = the probe did not answer (see {@link isLiveConductor}). */
  liveTmux(): Promise<ReadonlySet<string> | null>;
  heartbeatAlive(s: AgentSession): boolean;
  /** WP5-F2 — a árvore de trabalho desta linha foi apagada (tmux zumbi, ver {@link isLiveConductor}). Ausente ⇒ nunca. */
  treeGone?(s: AgentSession): boolean;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  /** stamp `routing.driver: conductor` (idempotent, under the card lock). */
  markDriver(board: string, cardId: string): Promise<void>;
  /** remove the driver the DISPATCH set (only used when the dispatch is abandoned before any conductor ran). */
  clearDriver(board: string, cardId: string): Promise<void>;
  /** the operator-facing finding when spawning keeps failing (idempotent upsert). */
  stampDispatchFailure(board: string, cardId: string, detail: string): Promise<void>;
  /** the SAME spawn `claude_new` uses. */
  spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>;
  /** the live autorun master switch (settings.yaml `autorun.enabled` / AGILEHARNESS_AUTORUN). */
  masterEnabled(): boolean;
  /** the board gate (board-pace.ts: disarmed, paused, slow). Absent ⇒ only the board config answers. */
  boardGate?: BoardGatePort;
  /**
   * The ACCOUNT window (capacity-governor). The session is spawned as `human` (the acceptance is the go, and
   * the steward must not reap a conductor waiting at a pause), but the DISPATCH is automation: nobody is at a
   * keyboard when it fires. So it asks the governor as automation — held ⇒ the entry WAITS in the queue (never
   * dropped) and the next pump re-asks. Absent ⇒ admitted (tests / an adopter without a meter).
   */
  admission?(): GateVerdict;
  /**
   * Tell the governor WHICH queue entries its window is holding (the complete set; it replaces the previous one),
   * so the capacity panel counts them and the >24h alert covers them. Reported only by a pass that actually ASKED
   * the governor (or found the queue empty): a pass that stopped earlier (box full, slots taken) does not know,
   * and must not reset the clock of an entry that was already waiting — the engine's rule for its own queue.
   */
  reportHeld?(keys: string[]): void;
  /**
   * O TETO DE GASTO do card (card-budget.ts): o motivo pelo qual este card não pode receber um condutor agora (o que
   * já foi gasto chegou ao teto em vigor), ou null. Para um card conduzido o teto era só texto da skill; aqui ele
   * passa a valer em código — a entrada ESPERA na fila (nunca sai) e anda quando um aumento for aprovado.
   */
  budgetRefusal?(board: string, card: Card): Promise<string | null>;
  /**
   * A VAGA EXTRA (extra-slot.ts): com o board no limite de `maxSessions`, este card pode nascer mesmo assim? `open`
   * só com todas as travas do dono (máquina folgada, cota no ritmo, integração vazia, card pequeno). Ausente ⇒ o
   * limite do board é o limite.
   */
  extraSlot?(board: string, card: Card, live: number, maxSessions: number): Promise<{ open: boolean; why: string; lock?: string }>;
  /** um condutor nasceu NA vaga extra — para o registro de decisões do sistema. */
  onExtraSlot?(board: string, card: Card, why: string): Promise<void>;
  /**
   * WP5-F1 — `readCard` devolveu null: o card sumiu, foi para a lixeira, ou só não foi lido agora? (ver
   * {@link QueuedCardMiss}). Na dúvida, `unreadable`. Ausente ⇒ o comportamento antigo (a entrada sai da fila).
   */
  explainMissingCard?(board: string, cardId: string): Promise<QueuedCardMiss>;
  /** WP5-F1 — o card SUMIU com a fila esperando: grava a decisão do sistema (`card-missing`) e alerta. */
  recordCardMissing?(entry: ConductorQueueEntry, miss: Extract<QueuedCardMiss, { kind: "missing" }>): Promise<void>;
  /**
   * WP5-F2 — os boards com o condutor ligado e o autorun armado, com os cards de agora, para a admissão dos ÓRFÃOS
   * ({@link isConductorOrphan}). Ausente ⇒ só a entrada admite. Pode devolver [] para poupar a leitura (a produção
   * varre no máximo a cada 5 min).
   */
  orphanCandidates?(): Promise<Array<{ board: string; config: BoardConfig; cards: readonly Card[] }>>;
  /**
   * Revisão do WP5-F2 — alguém trabalha neste card FORA do registro de sessões: claim ativo, run do engine ou entrada
   * viva no merge train (a régua `inFlight` do vigia, stall-watch-deps.ts). Só a adoção de órfãos pergunta; lançar ⇒ o
   * card não é adotado. Ausente ⇒ só o registro de sessões responde.
   */
  cardInFlight?(board: string, cardId: string): Promise<boolean>;
  now?(): number;
  log?(line: string): void;
}

const QUEUE_LOCK = "conductor-dispatch";

/**
 * O MOTIVO REAL da espera por vaga (WP5-F2). Antes a fila gravava só «2 condutor(es) vivo(s) — esperando uma vaga» e
 * descartava o porquê da vaga extra: num caso real, vários cards esperaram horas com a máquina carregada pelo gate e ninguém
 * via a trava. Agora a classe diz qual trava fechou (`slots:extra-closed:<trava>`) e o texto, os números. PURA.
 */
export function slotWait(live: number, extra: { open: boolean; why: string; lock?: string } | null): { reason: string; kind: string } {
  const base = `${live} condutor(es) vivo(s) no board`;
  if (!extra || extra.open) return { reason: `${base} — esperando uma vaga`, kind: "slots" };
  return { reason: `${base} — esperando uma vaga (vaga extra fechada: ${extra.why})`, kind: extra.lock ? `slots:extra-closed:${extra.lock}` : "slots" };
}

/** A entrada espera uma VAGA (com ou sem o motivo da vaga extra)? PURA — quem lê a fila usa esta régua, nunca `=== "slots"`. */
export function isSlotWait(kind: string | undefined): boolean {
  return kind === "slots" || !!kind?.startsWith("slots:");
}

const logOf = (deps: ConductorDeps) => deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));

/**
 * ADMIT a card whose entry made it a dispatch: stamp the driver and queue it (idempotent). Awaited by the
 * shell BEFORE it returns, so every evaluation that follows already sees a conducted card. The spawn itself is
 * the pump's job (seconds of worktree + tmux) — the caller fires it without holding the entry path.
 */
export async function admitConductorCard(
  deps: ConductorDeps,
  board: string,
  cardId: string,
  /** `resume`: na frente da fila (retomada); `yielded`: depois das que esperavam (cedeu a vaga — {@link ConductorQueueEntry.yielded}). */
  opts: { resume?: boolean; yielded?: boolean } = {},
): Promise<{ queued: boolean }> {
  await deps.markDriver(board, cardId);
  return withKeyedLock(QUEUE_LOCK, async () => {
    const entries = await deps.queue.load();
    const waiting = entries.find((e) => e.board === board && e.cardId === cardId);
    if (waiting) {
      // já na fila: uma retomada só PROMOVE a entrada (nunca duplica, nunca rebaixa)
      if (opts.resume && !waiting.resume) {
        await deps.queue.persist(entries.map((e) => (e === waiting ? { ...e, resume: true as const } : e)));
        logOf(deps)(`${board}/${cardId} passou para a frente da fila do condutor (retomada)`);
      }
      return { queued: false };
    }
    const sessions = await deps.sessions().catch(() => [] as AgentSession[]);
    const live = await deps.liveTmux().catch(() => null);
    const already = sessions.some(
      (s) => s.board === board && s.cardId === cardId && isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone),
    );
    if (already) return { queued: false }; // its conductor is on it (e.g. the conductor itself moved the card here)
    const place = opts.resume ? { resume: true as const } : opts.yielded ? { yielded: true as const } : {};
    entries.push({ board, cardId, queuedAt: new Date((deps.now ?? Date.now)()).toISOString(), attempts: 0, ...place });
    await deps.queue.persist(entries);
    logOf(deps)(
      opts.resume
        ? `${board}/${cardId} volta para a frente da fila do condutor (retomada de card estacionado)`
        : opts.yielded
          ? `${board}/${cardId} volta à fila do condutor DEPOIS das que esperavam vaga (estacionou por quietude e cedeu a vaga)`
          : `${board}/${cardId} na fila do condutor (driver: conductor)`,
    );
    return { queued: true };
  });
}

/** What one pump pass did — for the log and the tests. */
export interface ConductorPumpReport {
  spawned: Array<{ board: string; cardId: string; sessionId: string; tmuxSession: string }>;
  waiting: Array<{ board: string; cardId: string; reason: string }>;
  dropped: Array<{ board: string; cardId: string; reason: string }>;
  /** WP5-F2 — órfãos que esta passada admitiu (driver + fila). */
  adopted: Array<{ board: string; cardId: string }>;
}

/**
 * WP5-F2 — um ÓRFÃO do condutor: card de story parado num `fromStatus` do board, sem driver. PURA — a MESMA régua da
 * entrada (`conductorEntryVerdict` em autorun-eval.ts), que só admite quando o card ENTRA no status: um card que já
 * estava lá quando o condutor foi ligado, ou cuja entrada se perdeu (restart, evento perdido), ficava sem ninguém para
 * sempre — nem condutor (nunca admitido), nem skill de coluna (a entrada daquele status é do condutor). Num caso real,
 * vários cards em «Moldando» ficaram assim (um que tinha driver não entra — ver abaixo).
 *
 * Card COM driver e sem sessão nem fila NÃO é órfão aqui: é o condutor que morreu, e reabrir em laço quem morre é o
 * que o cabeçalho deste módulo proíbe — o vigia de card parado o mostra ao operador (`conductor-dead`).
 */
export function isConductorOrphan(card: Card, config: BoardConfig): boolean {
  return !isConducted(card) && conductorEntryVerdict(card, config).dispatch;
}

/**
 * One PUMP pass over the queue (in priority order — {@link compareConductorQueue}), serialized with admission
 * under one lock so the per-board count cannot race a concurrent pass into a third conductor. Every outcome of a
 * spawn attempt is decided HERE:
 *   • ok                       → out of the queue (the card now has its conductor);
 *   • no_capacity              → stays; the pass STOPS (the box is full — later entries would fail the same way);
 *   • card_claimed by a SESSION→ out of the queue: another session already owns the card (an operator-opened
 *                                conductor, typically) — log only, the driver stays;
 *   • card_claimed by anyone else (a run settling, the tick) → stays, retried next pass;
 *   • plumbing (spawn_failed / session_lost / name_taken) → stays, `attempts`+1; at
 *     {@link CONDUCTOR_MAX_SPAWN_ATTEMPTS} it leaves the queue with an operator finding on the card.
 * An entry whose card was not READ stays (WP5-F1 — see {@link QueuedCardMiss}); one whose card went to the trash,
 * vanished (recorded as `card-missing`, never silently), left the driver, or reached a terminal status is dropped; one whose board
 * turned the conductor OFF is dropped AND the dispatch's driver is removed (no conductor ever ran: handing the
 * card back to the cascade is the honest undo). The master switch / board kill switch pause, never drop.
 */
export async function pumpConductorQueue(deps: ConductorDeps): Promise<ConductorPumpReport> {
  return withKeyedLock(QUEUE_LOCK, () => pumpUnlocked(deps));
}

/** O registro do retido é escrituração — nunca pode travar o pump. */
function reportHeldSafe(deps: ConductorDeps, keys: string[]): void {
  try {
    deps.reportHeld?.(keys);
  } catch {
    /* best-effort */
  }
}

/**
 * Admite os órfãos ({@link isConductorOrphan}) na fila — idempotente: o driver carimbado tira o card da régua, e um
 * card já na fila não entra de novo. Só com o autorun ligado (a entrada também não admite com ele desligado). A fila
 * é gravada logo, para um card com driver novo nunca ficar fora dela se o resto da passada lançar.
 *
 * Órfão é quem NINGUÉM está carregando — sem driver, sem fila E sem sessão, claim, run ou merge no card. Sem a segunda
 * metade, o card que o operador trabalha numa sessão interativa (sem driver de condutor) ganhava o driver, o spawn
 * esbarrava no claim da sessão dele e a entrada saía da fila com o driver — o card virava «conduzido» sem condutor, e
 * nenhuma skill de coluna rodava mais nele. Adotar MUDA o card: sem saber quem está nele, nada é adotado nesta passada.
 */
async function adoptOrphans(deps: ConductorDeps, entries: ConductorQueueEntry[], report: ConductorPumpReport): Promise<void> {
  if (!deps.orphanCandidates || !deps.masterEnabled()) return;
  const boards = await deps.orphanCandidates().catch(() => []);
  const queued = new Set(entries.map((e) => `${e.board}/${e.cardId}`));
  const candidates = boards.flatMap(({ board, config, cards }) =>
    gateOf(deps.boardGate, board, config).held ? [] : cards.filter((card) => !queued.has(`${board}/${card.id}`) && isConductorOrphan(card, config)).map((card) => ({ board, card })),
  );
  if (!candidates.length) return; // o registro e as reservas só são lidos quando há órfão a adotar
  let sessions: AgentSession[];
  try {
    sessions = await deps.sessions();
  } catch (err) {
    logOf(deps)(`órfãos do condutor: o registro de sessões não foi lido (${err instanceof Error ? err.message : String(err)}) — nenhum adotado nesta varredura`);
    return;
  }
  const live = await deps.liveTmux().catch(() => null);
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  let changed = false;
  for (const { board, card } of candidates) {
    if (sessions.some((s) => s.board === board && s.cardId === card.id && isLiveSession(s, live, deps.heartbeatAlive))) continue;
    const inFlight = await (deps.cardInFlight?.(board, card.id) ?? Promise.resolve(false)).catch(() => true);
    if (inFlight) continue;
    const marked = await deps.markDriver(board, card.id).then(
      () => true,
      (err) => {
        logOf(deps)(`${board}/${card.id}: órfão em «${card.status}» — o driver não foi gravado (${err instanceof Error ? err.message : String(err)}); tento na próxima varredura`);
        return false;
      },
    );
    if (!marked) continue;
    entries.push({ board, cardId: card.id, queuedAt: nowIso, attempts: 0 });
    report.adopted.push({ board, cardId: card.id });
    changed = true;
    logOf(deps)(`${board}/${card.id}: estava em «${card.status}» sem condutor, sem fila e sem ninguém no card (órfão) — admitido na fila do condutor`);
  }
  if (changed) await deps.queue.persist(entries);
}

async function pumpUnlocked(deps: ConductorDeps): Promise<ConductorPumpReport> {
  const log = logOf(deps);
  const report: ConductorPumpReport = { spawned: [], waiting: [], dropped: [], adopted: [] };
  const entries = await deps.queue.load();
  await adoptOrphans(deps, entries, report);
  if (!entries.length) {
    reportHeldSafe(deps, []);
    return report;
  }
  const sessions = await deps.sessions().catch(() => [] as AgentSession[]);
  const live = await deps.liveTmux().catch(() => null);
  const liveConductors = sessions.filter((s) => isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone));
  // A conductor whose story is over holds no slot, from this very pass — ending its process is endFinishedConductors'.
  const finished = await finishedConductors(deps, liveConductors);
  const liveCount = countLiveConductorsByBoard(liveConductors.filter((s) => !finished.has(s.sessionId)));

  const keep: ConductorQueueEntry[] = [];
  /** boards em que esta passada abriu um condutor — a vez cedida (`yielded`) de quem ficou nele foi servida */
  const servedBoards = new Set<string>();
  let boxFull = false;
  /** a passada PERGUNTOU ao governador por alguma entrada (ver {@link ConductorDeps.reportHeld}) */
  let consulted = false;
  const heldByAccount: string[] = [];
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();
  const drop = (e: ConductorQueueEntry, reason: string) => {
    report.dropped.push({ board: e.board, cardId: e.cardId, reason });
    log(`${e.board}/${e.cardId} saiu da fila: ${reason}`);
  };
  /** Espera: persiste o motivo e desde quando; loga só quando a CLASSE do motivo muda (sem spam por passada). */
  const wait = (e: ConductorQueueEntry, reason: string, kind: string, patch: Partial<ConductorQueueEntry> = {}) => {
    const changed = e.lastWaitKind !== kind;
    keep.push({
      ...e,
      ...patch,
      lastWaitReason: reason.slice(0, 300),
      lastWaitKind: kind,
      lastWaitAt: changed || !e.lastWaitAt ? nowIso() : e.lastWaitAt,
    });
    report.waiting.push({ board: e.board, cardId: e.cardId, reason });
    if (changed) log(`${e.board}/${e.cardId} esperando: ${reason}`);
  };

  // The board's priority decides who gets a free slot first (compareConductorQueue) — the queue is persisted in
  // that order too, so the file reads as the dispatch order.
  // Uma leitura que LANÇA não é um card que sumiu (WP5-F1): guarda o erro para a entrada ficar na fila.
  const queued = await Promise.all(
    entries.map(async (entry) => {
      try {
        return { entry, card: await deps.readCard(entry.board, entry.cardId), readError: null as string | null };
      } catch (err) {
        return { entry, card: null, readError: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  queued.sort(compareConductorQueue);

  for (const { entry: e, card, readError } of queued) {
    if (boxFull) {
      wait(e, "máquina saturada (admissão da frota)", "box-full");
      continue;
    }
    const config = await deps.readBoardConfig(e.board).catch(() => null);
    if (!card) {
      const miss: QueuedCardMiss | null =
        readError !== null
          ? { kind: "unreadable", detail: readError }
          : deps.explainMissingCard
            ? await deps.explainMissingCard(e.board, e.cardId).catch((err): QueuedCardMiss => ({
                kind: "unreadable",
                detail: err instanceof Error ? err.message : String(err),
              }))
            : null;
      if (miss?.kind === "unreadable") {
        wait(e, `o card não foi lido agora (${miss.detail.slice(0, 160)}) — a entrada fica na fila`, "card-unreadable");
        continue;
      }
      if (miss?.kind === "trashed") {
        drop(e, "o card foi para a lixeira");
        continue;
      }
      if (miss?.kind === "missing") {
        await deps.recordCardMissing?.(e, miss).catch((err) =>
          log(`${e.board}/${e.cardId}: o registro do card sumido falhou — ${err instanceof Error ? err.message : String(err)}`),
        );
        drop(e, "o card SUMIU do disco (fora da lixeira) — registrado como decisão do sistema card-missing");
        continue;
      }
      drop(e, "card não existe mais");
      continue;
    }
    if (card.deferred) {
      // «Adiado — não agora»: o card sai da fila e fica livre (sem driver) — inerte até alguém trazê-lo de volta.
      if (isConducted(card)) await deps.clearDriver(e.board, e.cardId).catch(() => {});
      drop(e, "o card foi adiado (não agora) — saiu da fila");
      continue;
    }
    if (!isConducted(card)) {
      drop(e, "o driver foi removido (operador) — o card voltou à cascata");
      continue;
    }
    if (card.status && config?.statuses.find((s) => s.id === card.status)?.terminal) {
      drop(e, `card já está num status terminal (${card.status})`);
      continue;
    }
    const policy = resolveConductorPolicy(config);
    if (!policy) {
      await deps.clearDriver(e.board, e.cardId).catch(() => {});
      drop(e, "o conductor foi desligado neste board antes de a sessão nascer — driver removido");
      continue;
    }
    if (!deps.masterEnabled()) {
      wait(e, "autorun desligado (master switch) — a fila espera", "autorun-off");
      continue;
    }
    // O portão do board (board-pace.ts): desarmado ou pausado, a fila espera; devagar, um condutor por vez.
    const boardGate = gateOf(deps.boardGate, e.board, config);
    if (boardGate.held) {
      wait(e, `${boardGate.why} — a fila espera`, boardGate.source === "pace" ? "board-paused" : "autorun-off");
      continue;
    }
    const maxSessions = paceCap(policy.maxSessions, boardGate);
    if (liveConductors.some((s) => s.board === e.board && s.cardId === e.cardId)) {
      drop(e, "já tem um condutor vivo");
      continue;
    }
    const liveNow = liveCount.get(e.board) ?? 0;
    let viaExtraSlot: string | null = null;
    if (liveNow >= maxSessions) {
      // Em ritmo devagar a vaga extra não abre: o ritmo é a decisão de gastar menos, e ela a desfaria.
      const extra =
        boardGate.level === "slow"
          ? { open: false, why: "o board está em ritmo devagar (um card por vez)", lock: "pace" }
          : await deps.extraSlot?.(e.board, card, liveNow, maxSessions).catch(() => null);
      if (!extra?.open) {
        const why = slotWait(liveNow, extra ?? null);
        wait(e, why.reason, why.kind);
        continue;
      }
      viaExtraSlot = extra.why;
    }
    const overBudget = await deps.budgetRefusal?.(e.board, card).catch(() => null);
    if (overBudget) {
      wait(e, overBudget, "budget");
      continue;
    }
    const gate = deps.admission?.();
    if (gate) consulted = true;
    if (gate && !gate.admit) {
      heldByAccount.push(`${e.board}/${e.cardId}`);
      wait(e, `janela da conta: ${gate.detail}`, `account:${gate.reason}`);
      continue;
    }

    const res = await deps
      .spawn({
        role: "implement",
        task: conductorTask(e.board, e.cardId),
        board: e.board,
        cardId: e.cardId,
        // The board's model is the DEFAULT; the card's own route cap lowers it (see conductorModelFor).
        model: conductorModelFor(policy.model, card.routing?.modelCap),
        // A per-DISPATCH suffix (the recycle path's convention): a card re-dispatched after its conductor died gets a
        // NEW tmux name, so the dead registry row — same card, same old name — never looks alive again through the
        // new process (measured v0.9.0: the re-dispatched session resurrected the killed one and the board counted
        // 2 conductors for 1, starving the next card of a slot).
        name: conductorSessionSlug(e.cardId, (deps.now ?? Date.now)()),
        actor: "service:conductor",
        // The human's acceptance IS the go: the session is on the operator's behalf, not the copiloto's own
        // (only copilot-spawned sessions are the steward's to reap — a conductor waiting at a pause must not be).
        spawnedBy: "human",
        driver: "conductor",
        command: conductorCommand(e.board, e.cardId),
      })
      .catch((err): SpawnSessionResult => ({ ok: false, code: "spawn_failed", reason: err instanceof Error ? err.message : String(err) }));

    if (res.ok) {
      liveCount.set(e.board, (liveCount.get(e.board) ?? 0) + 1);
      servedBoards.add(e.board);
      report.spawned.push({ board: e.board, cardId: e.cardId, sessionId: res.session.sessionId, tmuxSession: res.tmuxSession });
      log(`${e.board}/${e.cardId} → condutor ${res.tmuxSession} (${res.route.model ?? "?"}, sessão ${res.session.sessionId.slice(0, 8)})`);
      if (viaExtraSlot) {
        log(`${e.board}/${e.cardId}: nasceu na VAGA EXTRA (${policy.maxSessions} + 1) — ${viaExtraSlot}`);
        await deps.onExtraSlot?.(e.board, card, viaExtraSlot).catch(() => {});
      }
      continue;
    }
    if (res.code === "no_capacity") {
      boxFull = true;
      wait(e, `máquina saturada: ${res.reason}`, "box-full");
      continue;
    }
    if (res.code === "card_claimed") {
      if (res.holder?.actor.startsWith("session:")) {
        drop(e, `outra sessão já é dona do card (${res.holder.actor}) — nenhum condutor novo`);
      } else {
        wait(e, `card reservado por ${res.holder?.actor ?? "?"} — tento no próximo tick`, "claimed");
      }
      continue;
    }
    const attempts = e.attempts + 1;
    if (attempts >= CONDUCTOR_MAX_SPAWN_ATTEMPTS) {
      const detail =
        `A dispatch do condutor falhou ${attempts}x ao abrir a sessão (${res.code}: ${res.reason}). O card segue com ` +
        `routing.driver: conductor, então nenhuma skill de coluna roda nele. Abra o condutor à mão ` +
        `(claude_new role:"implement" task:"/${CONDUCTOR_SKILL} ${e.board}/${e.cardId}") ou devolva o card à cascata ` +
        `(set_card_driver driver:null).`;
      await deps.stampDispatchFailure(e.board, e.cardId, detail).catch(() => {});
      drop(e, `spawn falhou ${attempts}x (${res.code}) — finding no card`);
      continue;
    }
    wait(e, `spawn falhou (${res.code}) — tentativa ${attempts}/${CONDUCTOR_MAX_SPAWN_ATTEMPTS}`, "spawn-failed", {
      attempts,
      lastError: `${res.code}: ${res.reason}`.slice(0, 300),
    });
  }

  await deps.queue.persist(keep.map((e) => (e.yielded && servedBoards.has(e.board) ? yieldServed(e) : e)));
  if (consulted || keep.length === 0) reportHeldSafe(deps, heldByAccount);
  return report;
}

/** A vez cedida foi servida (outro card do board ganhou a vaga): a entrada volta a disputar pelo seu tier. PURA. */
function yieldServed(e: ConductorQueueEntry): ConductorQueueEntry {
  const out = { ...e };
  delete out.yielded;
  return out;
}

// ── the END of a conductor whose story is over ──────────────────────────────────────────────────────────

/** How long a story must STAY over before its conductor is asked to leave — and how long `/exit` gets to take. */
export const CONDUCTOR_END_GRACE_MS = 10 * 60_000;

/** Per-session memory of the end pass. In-process on purpose: a restart only restarts the grace. */
export type ConductorEndState = Map<string, { finishedAt: number; exitAt?: number; note?: string }>;

export interface ConductorEndDeps
  extends Pick<ConductorDeps, "sessions" | "liveTmux" | "heartbeatAlive" | "readCard" | "readBoardConfig" | "now" | "log"> {
  /** is everything the session produced integrated? (session-worktree `sessionWorkSettled`) */
  workSettled(s: AgentSession): Promise<SessionWorkVerdict>;
  /** type `/exit` into the conductor's pane — only a pane proven to run claude; false = not delivered. */
  requestExit(s: AgentSession): Promise<boolean>;
  /** the last resort, when `/exit` did not take within a whole grace. */
  kill(s: AgentSession): Promise<void>;
  /** release the card claims the session holds (the tmux death would too, one tick later). */
  releaseClaims(s: AgentSession): Promise<void>;
  state: ConductorEndState;
}

export interface ConductorEndReport {
  exited: string[];
  killed: string[];
  /** over, but ending it would lose work — it holds no slot, and stays until its work is integrated. */
  kept: Array<{ sessionId: string; reason: string }>;
}

/**
 * One END pass: every live conductor whose story has been over for a whole grace, and whose work is integrated,
 * is asked to `/exit` once, its claims released; one that is still there a grace after that is killed. The tmux
 * death is then the ordinary one — the fleet reconcile books its spend and the session GC forgets the row.
 * A tmux probe that did not answer ends nobody (not knowing who is alive is not evidence of anything).
 */
export async function endFinishedConductors(deps: ConductorEndDeps): Promise<ConductorEndReport> {
  const log = deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));
  const now = (deps.now ?? Date.now)();
  const report: ConductorEndReport = { exited: [], killed: [], kept: [] };
  const live = await deps.liveTmux().catch(() => null);
  if (live === null) return report;
  const conductors = (await deps.sessions().catch(() => [] as AgentSession[])).filter(
    (s) => !!s.tmuxSession && isLiveConductor(s, live, deps.heartbeatAlive),
  );
  const finished = await finishedConductors(deps, conductors);
  for (const id of deps.state.keys()) if (!finished.has(id)) deps.state.delete(id); // back to work, or gone

  for (const s of conductors) {
    const why = finished.get(s.sessionId);
    if (!why) continue;
    const st = deps.state.get(s.sessionId) ?? { finishedAt: now };
    deps.state.set(s.sessionId, st);
    const label = `${s.board}/${s.cardId} (${s.tmuxSession})`;
    if (st.exitAt !== undefined) {
      if (now - st.exitAt >= CONDUCTOR_END_GRACE_MS) {
        await deps.kill(s).catch(() => {});
        report.killed.push(s.sessionId);
        log(`${label}: o /exit não encerrou o condutor em ${CONDUCTOR_END_GRACE_MS / 60_000}min — sessão encerrada à força`);
      }
      continue;
    }
    if (now - st.finishedAt < CONDUCTOR_END_GRACE_MS) continue;
    const work = await deps.workSettled(s).catch((err): SessionWorkVerdict => ({ settled: false, reason: String(err) }));
    if (!work.settled) {
      report.kept.push({ sessionId: s.sessionId, reason: work.reason });
      if (st.note !== work.reason) log(`${label}: ${why}, mas o condutor fica — ${work.reason} (não ocupa vaga)`);
      st.note = work.reason;
      continue;
    }
    if (!(await deps.requestExit(s).catch(() => false))) continue; // tries again next tick
    st.exitAt = now;
    await deps.releaseClaims(s).catch(() => {});
    report.exited.push(s.sessionId);
    log(`${label}: ${why} e ${work.detail} — /exit enviado ao condutor`);
  }
  return report;
}

// ── the ORPHAN terminal of a conductor that already left the registry ────────────────────────────────

/** A conductor's tmux name: `agent-` + {@link conductorSessionSlug}. Only names of THIS shape are ever touched. */
export const CONDUCTOR_TMUX_NAME = /^agent-conductor-[A-Za-z0-9][A-Za-z0-9_-]*-[a-z0-9]{4}$/;

/** Per-terminal memory of the orphan pass (tmux name → when it was first seen without a row, and the `/exit`). */
export type ConductorOrphanState = Map<string, { seenAt: number; exitAt?: number }>;

export interface ConductorOrphanDeps extends Pick<ConductorDeps, "sessions" | "liveTmux" | "now" | "log"> {
  /** the pane shows a drawn prompt (menu, y/N): typing `/exit` there would ANSWER it — leave it alone. */
  asking(tmux: string): boolean;
  /** type `/exit` — only into a pane proven to run claude; false = not delivered. */
  requestExit(tmux: string): Promise<boolean>;
  kill(tmux: string): Promise<void>;
  state: ConductorOrphanState;
}

export interface ConductorOrphanReport {
  exited: string[];
  killed: string[];
}

/**
 * One ORPHAN pass. A conductor ends its story by discarding its own worktree (`worktree_discard`), which removes
 * its row from the session registry — and {@link endFinishedConductors} only knows conductors that HAVE a row. The
 * `claude` process stays at its prompt in a tmux nobody tracks: it holds no slot and no claim, but it sits in the
 * operator's terminal list as if it were waiting for something (seen in practice: several such terminals, some for
 * hours). A terminal named like a conductor's, with no row for a whole grace, is asked to `/exit`; one that is
 * still there a grace later is killed. Nothing here can lose work: a session with a row — the only kind that can
 * own a worktree — is never touched, and a probe that did not answer ends nobody.
 */
export async function endOrphanConductorTerminals(deps: ConductorOrphanDeps): Promise<ConductorOrphanReport> {
  const log = deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));
  const now = (deps.now ?? Date.now)();
  const report: ConductorOrphanReport = { exited: [], killed: [] };
  const live = await deps.liveTmux().catch(() => null);
  if (live === null) return report;
  // A registry that could not be read is not "no rows": without it nobody is an orphan.
  const sessions = await deps.sessions().catch(() => null);
  if (sessions === null) return report;
  const tracked = new Set(sessions.map((s) => s.tmuxSession).filter((n): n is string => !!n));
  const orphans = [...live].filter((name) => CONDUCTOR_TMUX_NAME.test(name) && !tracked.has(name));
  for (const name of deps.state.keys()) if (!orphans.includes(name)) deps.state.delete(name); // gone, or tracked again

  for (const name of orphans) {
    const st = deps.state.get(name) ?? { seenAt: now };
    deps.state.set(name, st);
    if (st.exitAt !== undefined) {
      if (now - st.exitAt >= CONDUCTOR_END_GRACE_MS) {
        await deps.kill(name).catch(() => {});
        report.killed.push(name);
        log(`${name}: terminal de condutor sem sessão registrada — o /exit não o encerrou em ${CONDUCTOR_END_GRACE_MS / 60_000}min, encerrado à força`);
      }
      continue;
    }
    if (now - st.seenAt < CONDUCTOR_END_GRACE_MS) continue; // a spawn writes its row within seconds; a grace is ample
    if (deps.asking(name)) continue;
    if (!(await deps.requestExit(name).catch(() => false))) continue; // tries again next tick
    st.exitAt = now;
    report.exited.push(name);
    log(`${name}: terminal de condutor sem sessão registrada há ${CONDUCTOR_END_GRACE_MS / 60_000}min (a sessão já se encerrou) — /exit enviado`);
  }
  return report;
}
