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
//   2. PUMP    — serialized; for each queued card, if the board has a free conductor slot (`maxSessions`, live
//                conductors counted per board) spawn the session through the SAME door `claude_new` uses
//                (`spawnWorkSession`: admission + resource probe, worktree, card claim, scoped MCP token,
//                tmux, role `implement`), whose first prompt is `/harness-conductor <board>/<cardId>`.
//                The excess WAITS; the pump runs again on every fleet tick (instrumentation.ts), which is also
//                where a dead conductor is noticed — so a slot freed by a session ending is re-used on the
//                next tick with no extra wiring.
//
// Idempotent end to end: the driver write is a no-op when already set, the queue dedupes by card, the pump
// skips a card that already has a live conductor, and the claim refuses a second implementer anyway.
//
// What this module deliberately does NOT do:
//   • re-dispatch a card whose conductor DIED. The driver stays (no stale column run), the claim is released
//     by the fleet reconcile, and the operator decides: reopen a conductor (`claude_new` with the conductor
//     task) or clear the driver (`set_card_driver`). An automatic respawn loop over a session that keeps dying
//     is the failure mode a human must see, not one to paper over;
//   • spawn anything while the live master switch is off or the board is disarmed (`autorunDisabled`): the
//     queue waits, and resumes by itself when the switch comes back.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { conductorCommand, conductorTask, CONDUCTOR_SKILL, isConducted, resolveConductorPolicy } from "@/lib/storymap/driver";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { AgentSession } from "./session-worktree";
import type { SpawnSessionInput, SpawnSessionResult } from "./session-spawn";
import type { GateVerdict } from "./capacity-governor";

// ── PURE policy (lives in ../driver.ts — isomorphic, so the move risk class can ask it too) ──────────────
export {
  conductorEntryVerdict,
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
 */
export function isLiveConductor(s: AgentSession, liveTmux: ReadonlySet<string> | null, heartbeatAlive: (s: AgentSession) => boolean): boolean {
  if (s.driver !== "conductor") return false;
  if (!s.tmuxSession) return heartbeatAlive(s);
  if (liveTmux === null) return true;
  return liveTmux.has(s.tmuxSession);
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

export interface ConductorDeps {
  queue: ConductorQueueStore;
  /** every registered fleet session (the registry — alive or not). */
  sessions(): Promise<AgentSession[]>;
  /** names of the tmux sessions alive NOW; null = the probe did not answer (see {@link isLiveConductor}). */
  liveTmux(): Promise<ReadonlySet<string> | null>;
  heartbeatAlive(s: AgentSession): boolean;
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
  now?(): number;
  log?(line: string): void;
}

const QUEUE_LOCK = "conductor-dispatch";

const logOf = (deps: ConductorDeps) => deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));

/**
 * ADMIT a card whose entry made it a dispatch: stamp the driver and queue it (idempotent). Awaited by the
 * shell BEFORE it returns, so every evaluation that follows already sees a conducted card. The spawn itself is
 * the pump's job (seconds of worktree + tmux) — the caller fires it without holding the entry path.
 */
export async function admitConductorCard(deps: ConductorDeps, board: string, cardId: string): Promise<{ queued: boolean }> {
  await deps.markDriver(board, cardId);
  return withKeyedLock(QUEUE_LOCK, async () => {
    const entries = await deps.queue.load();
    if (entries.some((e) => e.board === board && e.cardId === cardId)) return { queued: false };
    const sessions = await deps.sessions().catch(() => [] as AgentSession[]);
    const live = await deps.liveTmux().catch(() => null);
    const already = sessions.some(
      (s) => s.board === board && s.cardId === cardId && isLiveConductor(s, live, deps.heartbeatAlive),
    );
    if (already) return { queued: false }; // its conductor is on it (e.g. the conductor itself moved the card here)
    entries.push({ board, cardId, queuedAt: new Date((deps.now ?? Date.now)()).toISOString(), attempts: 0 });
    await deps.queue.persist(entries);
    logOf(deps)(`${board}/${cardId} na fila do condutor (driver: conductor)`);
    return { queued: true };
  });
}

/** What one pump pass did — for the log and the tests. */
export interface ConductorPumpReport {
  spawned: Array<{ board: string; cardId: string; sessionId: string; tmuxSession: string }>;
  waiting: Array<{ board: string; cardId: string; reason: string }>;
  dropped: Array<{ board: string; cardId: string; reason: string }>;
}

/**
 * One PUMP pass over the queue (FIFO), serialized with admission under one lock so the per-board count cannot
 * race a concurrent pass into a third conductor. Every outcome of a spawn attempt is decided HERE:
 *   • ok                       → out of the queue (the card now has its conductor);
 *   • no_capacity              → stays; the pass STOPS (the box is full — later entries would fail the same way);
 *   • card_claimed by a SESSION→ out of the queue: another session already owns the card (an operator-opened
 *                                conductor, typically) — log only, the driver stays;
 *   • card_claimed by anyone else (a run settling, the tick) → stays, retried next pass;
 *   • plumbing (spawn_failed / session_lost / name_taken) → stays, `attempts`+1; at
 *     {@link CONDUCTOR_MAX_SPAWN_ATTEMPTS} it leaves the queue with an operator finding on the card.
 * An entry whose card vanished, left the driver, or reached a terminal status is dropped; one whose board
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

async function pumpUnlocked(deps: ConductorDeps): Promise<ConductorPumpReport> {
  const log = logOf(deps);
  const report: ConductorPumpReport = { spawned: [], waiting: [], dropped: [] };
  const entries = await deps.queue.load();
  if (!entries.length) {
    reportHeldSafe(deps, []);
    return report;
  }
  const sessions = await deps.sessions().catch(() => [] as AgentSession[]);
  const live = await deps.liveTmux().catch(() => null);
  const liveConductors = sessions.filter((s) => isLiveConductor(s, live, deps.heartbeatAlive));
  const liveCount = new Map<string, number>();
  for (const s of liveConductors) if (s.board) liveCount.set(s.board, (liveCount.get(s.board) ?? 0) + 1);

  const keep: ConductorQueueEntry[] = [];
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

  for (const e of entries) {
    if (boxFull) {
      wait(e, "máquina saturada (admissão da frota)", "box-full");
      continue;
    }
    const [config, card] = await Promise.all([
      deps.readBoardConfig(e.board).catch(() => null),
      deps.readCard(e.board, e.cardId).catch(() => null),
    ]);
    if (!card) {
      drop(e, "card não existe mais");
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
    if (!deps.masterEnabled() || config?.autorunDisabled) {
      wait(e, "autorun desligado (master switch ou board desarmado) — a fila espera", "autorun-off");
      continue;
    }
    if (liveConductors.some((s) => s.board === e.board && s.cardId === e.cardId)) {
      drop(e, "já tem um condutor vivo");
      continue;
    }
    if ((liveCount.get(e.board) ?? 0) >= policy.maxSessions) {
      wait(e, `${policy.maxSessions} condutor(es) vivo(s) no board — esperando uma vaga`, "slots");
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
        model: policy.model,
        name: `conductor-${e.cardId}`,
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
      report.spawned.push({ board: e.board, cardId: e.cardId, sessionId: res.session.sessionId, tmuxSession: res.tmuxSession });
      log(`${e.board}/${e.cardId} → condutor ${res.tmuxSession} (${res.route.model ?? "?"}, sessão ${res.session.sessionId.slice(0, 8)})`);
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

  await deps.queue.persist(keep);
  if (consulted || keep.length === 0) reportHeldSafe(deps, heldByAccount);
  return report;
}
