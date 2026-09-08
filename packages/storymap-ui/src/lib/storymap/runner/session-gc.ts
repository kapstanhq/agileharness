// session GC — FORGET the fleet registry entries whose agent is long dead and whose work is provably not
// at risk. It is the sibling of branch-gc: branch-gc harvests preserved BRANCHES, this deregisters dead
// SESSIONS. Both run IN-PROCESS in the recovery-sweep tick (idle-gated so their git subprocesses never
// fight the merge train).
//
// WHY THIS EXISTS. The worktree reaper only ever touched WORKTREES — a session with no isolated tree has
// nothing for it to reap, so its registry row lived forever. That is exactly the ADOPTED session (WS-6.2):
// no worktree, no branch, so once its process dies its entry just accumulates. Measured in production: the
// fleet view showed 10 rows, 8 of them adopted sessions dead for 3–6 DAYS — pure noise that buried the one
// live agent and made "Frota de agentes · 10" a lie. The registry needed a GC of its own.
//
// SAFETY — this NEVER risks un-integrated work. Three fail-closed guards, in order:
//   1. Liveness. A session inside the heartbeat TTL is alive → never touched. An unparseable/absent
//      heartbeat reads as ALIVE (isSessionAlive fail-closes), so a corrupt row is kept, not forgotten.
//   2. Grace. Even past the TTL, a session must have been dead longer than {@link SESSION_GC_GRACE_MS}
//      (2× the TTL) — and its hosting tmux must be gone — before it is a candidate. A live tmux keeps it.
//   3. Nothing to lose. Only three shapes are forgotten: ADOPTED (no tree, no branch — nothing to lose),
//      train `done` (its work already integrated), or BRANCHLESS (never opened an isolated tree). An
//      isolated session that still holds a branch is KEPT — its possibly-un-integrated code is branch-gc's
//      job to adjudicate by content, never this GC's to drop. And an ORPHANED INTEGRATION (a dead session
//      whose train entry is still unresolved) is KEPT too: it is a DEMAND the fleet view is the only
//      surface for (fleet-view GAP 1.3c), so forgetting it would erase the one place the operator sees it.
//
// PURE core (selectSessionsToForget) + a thin IO wrapper (runSessionGc), like branch-gc / fleet-view: the
// decision is where a mistake would drop real work, so the decision is the part that is unit-tested.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { isSessionAlive, SESSION_HEARTBEAT_TTL_MS } from "./session-liveness";
import type { MergeQueueStatus } from "./types";
import type { AgentSession } from "./session-worktree";
import type { DiscardSessionResult } from "./session-worktree";

/**
 * How long a session must be dead before the GC forgets it. 2× the 6h liveness TTL: past the TTL a session
 * is already "dead", but the extra window means a brief clock skew / a service that was down over the
 * agent's last heartbeat can never make the GC drop a row a human might still want to eyeball. The worktree
 * reaper already frees the FOLDER at the TTL; this only removes the registry ROW, and later.
 */
export const SESSION_GC_GRACE_MS = 2 * SESSION_HEARTBEAT_TTL_MS; // 12h

/** Resolve the grace window from the env (USM_SESSION_GC_GRACE_MS). <=0 / garbage → the default; never off
 *  (a disabled session GC is what let 8 zombies pile up). Pure — exported for tests. */
export function sessionGcGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.USM_SESSION_GC_GRACE_MS;
  if (raw == null || raw === "") return SESSION_GC_GRACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SESSION_GC_GRACE_MS;
  return Math.floor(n);
}

/**
 * Train statuses that mean "this integration is NOT going to happen unless someone acts" — a MIRROR of
 * fleet-view's own set (kept local so this pure core stays dependency-light; both express one policy: an
 * integration nobody will pick up). A dead session with such an entry is an orphaned integration = a
 * DEMAND, so the GC KEEPS it even past grace — the fleet row is the only surface that shows it.
 */
const UNRESOLVED_TRAIN: ReadonlySet<MergeQueueStatus> = new Set<MergeQueueStatus>([
  "returned-to-session",
  "gate-failed",
  "conflict",
  "failed",
]);

/** The minimum a session needs to expose for the GC decision (the registry carries much more). */
export interface GcSession {
  sessionId: string;
  heartbeatAt: string;
  /** absent/false ⇒ isolated; true ⇒ ADOPTED (no tree, no branch — nothing to lose). */
  adopted?: boolean;
  /** the isolated branch this session owns, if any. Present ⇒ there MAY be un-integrated code. */
  branch?: string;
  /** the tmux that hosts it — a live one vetoes the forget (the process is provably still there). */
  tmuxSession?: string;
}

/** Just the train facts the decision reads (join key: entry.runId === session.sessionId). */
export interface GcTrainEntry {
  runId: string;
  status: MergeQueueStatus;
}

/** Why a session was chosen for forgetting — journaled, so the ledger says WHICH guard released it. */
export type ForgetReason = "adopted-dead" | "integrated-dead" | "branchless-dead";

export interface SessionToForget {
  sessionId: string;
  reason: ForgetReason;
  /** ms the session had been dead when chosen — for the journal / operator forensics. */
  deadForMs: number;
}

export interface SelectForgetInputs {
  sessions: GcSession[];
  /** every train entry (live + history) — to spot an orphaned integration that must be kept. */
  entries: GcTrainEntry[];
  /** tmux session names that exist right now — a live host vetoes the forget. */
  liveTmux: ReadonlySet<string>;
  graceMs?: number;
  ttlMs?: number;
}

/**
 * Decide which dead sessions are safe to deregister. PURE. See the module header for the three guards; the
 * order here is deliberate — cheapest and most-protective first, so a live/at-risk session exits early.
 */
export function selectSessionsToForget(inputs: SelectForgetInputs, now: number): SessionToForget[] {
  const graceMs = inputs.graceMs ?? SESSION_GC_GRACE_MS;
  const ttlMs = inputs.ttlMs ?? SESSION_HEARTBEAT_TTL_MS;
  const entryByRun = new Map(inputs.entries.map((e) => [e.runId, e] as const));

  const out: SessionToForget[] = [];
  for (const s of inputs.sessions) {
    // 1. Liveness — inside the TTL, or an unreadable heartbeat (fail-closed to alive) → keep.
    if (isSessionAlive(s, now, ttlMs)) continue;
    // 2a. A live hosting tmux means the process is provably there (it just hasn't beaten lately) → keep.
    if (s.tmuxSession && inputs.liveTmux.has(s.tmuxSession)) continue;
    // 2b. Grace — dead, but not long enough. (NaN heartbeat can't reach here: step 1 kept it.)
    const deadForMs = now - Date.parse(s.heartbeatAt);
    if (!(deadForMs >= graceMs)) continue;
    // 3a. Orphaned integration (dead + unresolved train entry) is a DEMAND — the fleet view is its only
    //     surface (GAP 1.3c), so never forget it out from under the operator.
    const entry = entryByRun.get(s.sessionId);
    if (entry && UNRESOLVED_TRAIN.has(entry.status)) continue;
    // 3b. Nothing to lose? Only these shapes; an isolated session still holding a branch is branch-gc's
    //     to adjudicate by CONTENT, never this GC's to drop.
    const reason: ForgetReason | null = s.adopted
      ? "adopted-dead"
      : entry?.status === "done"
        ? "integrated-dead"
        : !s.branch
          ? "branchless-dead"
          : null;
    if (!reason) continue;
    out.push({ sessionId: s.sessionId, reason, deadForMs });
  }
  return out;
}

// ── IO wrapper (SERVER-ONLY) ──────────────────────────────────────────────────────────────────────────────

export interface SessionGcJournalEntry {
  at: string;
  sessionId: string;
  reason: ForgetReason;
  deadForMs: number;
  /** whether the deregister actually landed (discard returned ok). */
  forgotten: boolean;
  /** the discard verdict text — e.g. a branch that ended up PRESERVED (should be none here by construction). */
  detail?: string;
}

export interface SessionGcDeps {
  /** the whole registry (alive or not) — allSessions() in production. */
  listSessions: () => Promise<AgentSession[]>;
  /** every train entry (live + history) — getMergeQueue().getSnapshot().entries in production. */
  trainEntries: () => Promise<GcTrainEntry[]>;
  /** tmux session names alive right now. */
  liveTmux: () => Promise<string[]>;
  /** deregister ONE session — discardSessionWorktree in production (fail-closed teardown: it preserves any
   *  committed branch work as `failed/agent/<id>` before deregistering, so even a mis-selected isolated
   *  session can never lose integrated code). */
  discard: (sessionId: string) => Promise<DiscardSessionResult>;
  /** record each forget (append to session-gc.jsonl in prod; a collector in tests). Best-effort. */
  journal?: (entry: SessionGcJournalEntry) => void | Promise<void>;
  now?: () => number;
  graceMs?: number;
}

/**
 * Run ONE GC pass: read the registries, pick the safe-to-forget dead sessions, deregister each. Every step
 * is best-effort — a cold merge queue degrades the decision (fewer inputs), it never throws — because this
 * runs on the recovery sweep and must never demote a successful recovery tick. Returns the journal entries.
 */
export async function runSessionGc(deps: SessionGcDeps): Promise<SessionGcJournalEntry[]> {
  const now = (deps.now ?? Date.now)();
  const [sessions, entries, tmux] = await Promise.all([
    deps.listSessions().catch(() => [] as AgentSession[]),
    deps.trainEntries().catch(() => [] as GcTrainEntry[]),
    deps.liveTmux().catch(() => [] as string[]),
  ]);
  const chosen = selectSessionsToForget(
    { sessions, entries, liveTmux: new Set(tmux), graceMs: deps.graceMs },
    now,
  );
  const out: SessionGcJournalEntry[] = [];
  for (const c of chosen) {
    let forgotten = false;
    let detail: string | undefined;
    try {
      const res = await deps.discard(c.sessionId);
      forgotten = res.ok;
      detail = res.ok ? res.detail : res.reason;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    const entry: SessionGcJournalEntry = {
      at: new Date(now).toISOString(),
      sessionId: c.sessionId,
      reason: c.reason,
      deadForMs: c.deadForMs,
      forgotten,
      detail,
    };
    out.push(entry);
    await deps.journal?.(entry);
  }
  return out;
}

/** Production journal sink — append one JSONL line to storymap/.runner/session-gc.jsonl. Best-effort. */
export async function appendSessionGcJournal(entry: SessionGcJournalEntry): Promise<void> {
  try {
    await fsp.appendFile(path.join(runnerStateDir(), "session-gc.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("[session-gc] journal append falhou:", err instanceof Error ? err.message : err);
  }
}
