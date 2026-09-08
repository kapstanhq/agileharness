// Crash recovery — the boot-time half of the durable journal (journal.ts).
//
// On a dev-server restart, instrumentation.ts calls recoverInterruptedRuns(). It reads
// the runs the journal still has as "running" (= interrupted by the crash) and, for each,
// decides from the card's CURRENT disk state whether to resume it:
//   - the card's column would RUN the SAME trigger that was interrupted → RESPAWN it
//     (the skill never advanced the card, so its work is unfinished);
//   - the card moved on / was deleted / its column now forwards or stops → DROP it
//     (the run effectively completed before the crash).
//
// SURGICAL, not a board sweep: only genuinely-interrupted runs are candidates, and each
// respawn goes through engine.runSkill with the autorun dedupe window, so the in-flight
// lock + circuit-breaker rate limit cap it exactly like a live event would. This respects
// the watcher's "seed silently" guard (no spawn storm of cards merely sitting in a column).
//
// The decision (decideRecovery) is PURE — like cascade-decision.ts. The orchestrator takes
// all side effects as injected deps so it is unit-testable without fs / spawn.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { findRepoRoot } from "@/lib/storymap/paths";
import { decideCascade } from "@/lib/notifications/server/channels/cascade-decision";
import { AUTORUN_DEDUPE_MS, type RunAttempt } from "./engine";
import { osBootMs, type JournalEntry, type RunOutcome } from "./journal";
import { defaultExec, defaultWorktreeOps, runBranch, type ExecFn } from "./worktree";
import { isRunScopeActive, runScopeUnit, stopRunScope } from "./governor";
import { resolveHeadroomUrl } from "./headroom";
import { liveSessionIds, renewHeartbeatFromActivity } from "./session-worktree";
import { worktreeTouchedWithin } from "./session-activity";
import { SESSION_HEARTBEAT_TTL_MS } from "./session-liveness";
import type { MergeQueuePort, MergeQueueRecovery } from "./merge-queue";
import type { BoardConfig, Card, StatusDef, TriggerId } from "@/lib/storymap/types";

export type RecoveryDecision =
  | { action: "respawn"; trigger: TriggerId }
  | { action: "drop"; reason: string };

/**
 * story-9s52tu HALF B: the subset of journal entries that are RESUMABLE because the run hit `--max-turns`
 * (marked `resumable` + outcome "max-turns" by the engine, kept "running" so it is recovered). Their
 * ephemeral worktree + `run/<sessionId>` branch were PRESERVED (carrying the partial task commits), so the
 * boot reconciler must NEVER prune those trees/branches — these ids EXTEND the keep set alongside the
 * crash-interrupted runs. `loadInterrupted` already returns them (status "running"), so the resume itself
 * is handled by the existing interrupted-run path; this classifier exists so the keep-set is EXPLICIT +
 * testable (a resumable run's tree is protected even though it "settled"). Pure — exported for tests.
 */
export function findResumable(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((e) => e.resumable === true);
}

/**
 * Decide what to do with one interrupted run given the card's CURRENT disk state.
 * PURE — assumes the master switch was already checked by the caller.
 */
export function decideRecovery(
  entry: JournalEntry,
  card: Card | undefined,
  config: BoardConfig,
): RecoveryDecision {
  // A manual "Rodar agora" is a one-shot the user fired by hand — never auto-re-fire it, even if
  // the card sits in an autorun column (whose trigger would otherwise match). The engine already
  // exempts manual runs from the dedupe/rate-limit; recovery must honor the same intent.
  if (entry.origin === "manual") return { action: "drop", reason: "manual-oneshot" };
  if (!card) return { action: "drop", reason: "card-removed" };
  const decision = decideCascade(card, config);
  if (decision.action === "run" && decision.trigger === entry.trigger) {
    return { action: "respawn", trigger: entry.trigger };
  }
  // The card advanced (the skill finished and moved it), now forwards, or stopped.
  return { action: "drop", reason: `card-advanced:${decision.action}` };
}

export interface RecoverySummary {
  interrupted: number;
  respawned: number;
  dropped: number;
  /** Interrupted but not retried because resume-on-boot (or the master switch) is off. */
  skipped: number;
  /** un-strand: a resume DEFERRED to the next boot because the orphan scope survived even the SIGKILL
   * escalation (a wedged/D-state claude). The entry is LEFT 'running' (not clobbered) so it's retried —
   * never spawn a 2nd claude into a session a live orphan still owns. */
  deferred: number;
}

export interface RecoveryDeps {
  /** True only when autorun.enabled AND autorun.resumeOnBoot are both on. */
  enabled: boolean;
  journal: Pick<
    import("./journal").RunnerJournal,
    "loadInterrupted" | "resolveInterrupted"
  >;
  readBoardConfig(boardId: string): Promise<BoardConfig | null>;
  readCards(boardId: string): Promise<Card[]>;
  runSkill(
    board: string,
    cardId: string,
    trigger: TriggerId,
    def: StatusDef,
    // story-watchdog: recovery RESUMES the crashed run (passes resumeSessionId so the engine spawns
    // `claude --resume`, preserving the transcript+checkpoint) and, when the original ephemeral tree
    // is still on disk, hands its path so the resume runs IN it instead of a fresh checkout.
    // origin/driveCount (story-92ldyt): a resumed conflict-redrive must re-enter at the SAME depth +
    // origin, else the merge train's re-drive cap resets to 0 each crash cycle (driveCount weakening).
    opts: {
      dedupeWindowMs: number;
      resumeSessionId?: string;
      existingWorktreePath?: string;
      headroomUrl?: string | null;
      origin?: "autorun" | "manual" | "conflict-redrive";
      driveCount?: number;
      // story-9s52tu HALF B (HIGH #2): a boot-recovered max-turns resume must re-enter at the SAME
      // monotonic resume depth + 1 (carried on the journal entry), else the cap would reset to 0 each
      // restart cycle and a chronically-stuck card could loop past the cap. Plain crash resumes carry
      // undefined (≡ 0) — unchanged. Mirrors driveCount's restart-survives-the-cap intent (story-92ldyt).
      maxTurnsResumeCount?: number;
      // story-harness-cc HALF #5: the journaled missing-session fallback budget, re-injected on respawn so
      // it survives the restart (the engine's in-process Map is wiped on boot) — carried UNCHANGED here.
      resumeFallbackCount?: number;
      // ADR-063 (4b): the journaled loop-guard column + monotonic no-progress counter, re-injected on
      // respawn so the "same-column-no-progress" guard SURVIVES a restart (else a wedged card's counter
      // would reset to 0 every boot and could churn forever). Carried UNCHANGED — the shell owns increments.
      column?: string;
      noProgressRuns?: number;
    },
  ): RunAttempt;
  /** Best-effort kill of the orphaned child the previous process left running (same boot session only). */
  killOrphan(pid: number | null, entryBootMs?: number): void;
  /** Reap an orphaned `git worktree` (dir + branch) a crashed run left behind. Best-effort. */
  cleanupWorktree(worktreePath: string, branch: string): Promise<void>;
  /**
   * story-watchdog (AC4) — does the original run's ephemeral worktree STILL exist on disk? A resume
   * can only `--resume` into a tree that survived; a missing one (removed, or its branch reaped) has
   * no checkpoint, so the run is failed gracefully instead. Injectable (DI) for testability; defaults
   * to {@link checkWorktreeOnDisk}. Best-effort: a probe error is treated as "missing" (fail-safe).
   */
  checkWorktreeExists?(worktreePath: string): Promise<boolean>;
  /**
   * f4 — defensive worktree reconciliation: enumerate the REAL `git worktree list` and prune every
   * `run/*` tree whose sessionId is NOT in `keepSessionIds`, catching the create→spawn-gap orphan
   * whose journal write was lost (the per-entry cleanupWorktree only reaps trees the journal still
   * remembers). Best-effort + idempotent; optional so legacy callers stay valid. Returns #pruned.
   */
  reconcileWorktrees?(keepSessionIds: Set<string>): Promise<number>;
  /**
   * settle-gap-resume: the run ids of every branch currently on the merge train. The reconciler's
   * orphan-branch sweep must NEVER dispose a `run/<id>` that is legitimately pending integration — only
   * a TRUE settle-gap orphan (committed + detached, but the enqueue never persisted → no entry). These
   * ids EXTEND the keep set. Optional → legacy callers (no merge train) skip it.
   */
  mergeQueueRunIds?(): Promise<string[]>;
  /**
   * un-strand fix: STOP the still-live orphan SCOPE before resuming its session. A run launches inside a
   * transient `systemd-run --scope` in `claude-runs.slice` — a cgroup DISJOINT from storymap.service, so
   * it SURVIVES a `systemctl restart` (the restart only kills the service cgroup). killOrphan's SIGTERM
   * reaches only the dead `systemd-run` shell client recorded as `entry.pid`, never the scope leader (the
   * real claude). Resuming `claude --resume <id>` while that orphan still owns the session is what
   * produced the phantom 246ms 'exit' that stranded story-080fo9. This stops the named scope
   * (`harness-run-<sessionId>.scope`, rederived when the entry predates the `unit` field) → SIGTERM then
   * SIGKILL-escalate. No-op when no scope was applied. Optional → legacy callers skip it.
   */
  stopScope?(unit: string): Promise<void>;
  /** un-strand fix: is the orphan scope STILL active after stopScope (a D-state claude that ignored even
   * SIGKILL until the kernel finishes its syscall)? The respawn is DEFERRED when true. Optional. */
  isScopeActive?(unit: string): Promise<boolean>;
}

/**
 * Resume every run the crash interrupted. Returns a summary (logged by the caller).
 * Each card is read fresh per board (cached) so the decision uses live disk truth.
 */
export async function recoverInterruptedRuns(deps: RecoveryDeps): Promise<RecoverySummary> {
  const interrupted = await deps.journal.loadInterrupted();
  const summary: RecoverySummary = { interrupted: interrupted.length, respawned: 0, dropped: 0, skipped: 0, deferred: 0 };

  // f4: reconcile real worktrees against the journal BEFORE anything respawns — prune any `run/*`
  // tree whose sessionId has no live journal entry (a create→spawn-gap orphan whose journal write
  // was lost). Keep the interrupted runs' ids (their trees are reaped deterministically per-entry
  // below). Running it before the respawn loop means it can never race a freshly-created tree;
  // best-effort + idempotent, a failure here must never abort boot.
  if (deps.reconcileWorktrees) {
    const keep = new Set(interrupted.map((e) => e.sessionId));
    // story-9s52tu HALF B: EXPLICITLY keep every RESUMABLE max-turns run's tree + branch (their
    // sessionIds) so the reconciler's prune never reaps the preserved worktree a `--resume` needs.
    // These already sit in `interrupted` (kept "running"), so this is belt-and-suspenders — but it
    // documents the invariant and stays correct even if a resumable entry is ever classified elsewhere.
    for (const e of findResumable(interrupted)) keep.add(e.sessionId);
    // settle-gap-resume: also protect every run branch the merge train is mid-integrating, so the
    // reconciler's orphan-branch sweep can't dispose a branch a live merge entry still points at.
    if (deps.mergeQueueRunIds) {
      for (const id of await deps.mergeQueueRunIds().catch(() => [] as string[])) keep.add(id);
    }
    await deps.reconcileWorktrees(keep).catch(() => {});
  }

  if (!interrupted.length) return summary;

  // Resume-on-boot (or autorun) off → don't retry, but DO clear the entries so they
  // can't accumulate or get reprocessed on the next boot. Still STOP the orphan scope (else a live
  // claude leaks in claude-runs.slice until OOM) AND reap any orphaned worktree so nothing accumulates
  // just because resume is disabled.
  if (!deps.enabled) {
    for (const e of interrupted) {
      if (deps.stopScope) await deps.stopScope(e.unit ?? runScopeUnit(e.sessionId)).catch(() => {});
      if (e.worktreePath) await deps.cleanupWorktree(e.worktreePath, runBranch(e.sessionId)).catch(() => {});
      await deps.journal.resolveInterrupted(e.board, e.cardId, "error");
    }
    summary.skipped = interrupted.length;
    return summary;
  }

  const boardCache = new Map<string, { config: BoardConfig | null; cards: Card[] }>();
  const loadBoard = async (boardId: string) => {
    const hit = boardCache.get(boardId);
    if (hit) return hit;
    const config = await deps.readBoardConfig(boardId).catch(() => null);
    const cards = config ? await deps.readCards(boardId).catch(() => [] as Card[]) : [];
    const val = { config, cards };
    boardCache.set(boardId, val);
    return val;
  };

  // story-watchdog (t4): the resume pre-condition probe — default to the real fs check, overridable (DI).
  const checkWorktreeExists = deps.checkWorktreeExists ?? checkWorktreeOnDisk;

  for (const entry of interrupted) {
    // Kill the orphan FIRST so a still-running previous-process child can't fight a fresh run for
    // the same card. Guarded to the SAME OS boot session (defaultKillOrphan): across a machine
    // reboot the pid has been recycled to a stranger, so we must NOT force-kill it by number.
    deps.killOrphan(entry.pid, entry.osBootMs);

    // un-strand: killOrphan only SIGTERMs the dead `systemd-run` shell client (entry.pid). The real
    // claude leads a transient SCOPE in claude-runs.slice — a cgroup DISJOINT from the service that
    // SURVIVED the restart. Stop that named scope too (rederive from sessionId when the entry predates
    // the persisted `unit`). Speculative + allowlisted to `harness-run-*.scope` (never the service/slice):
    // a no-op when no scope was applied. This is what makes the resume below safe (no live orphan
    // contending for the session). Done for EVERY entry (respawn AND drop) so a zombie never lingers.
    const scopeUnit = entry.unit ?? runScopeUnit(entry.sessionId);
    if (deps.stopScope) await deps.stopScope(scopeUnit).catch(() => {});

    const expect = { sessionId: entry.sessionId, startedAt: entry.startedAt };
    const branch = runBranch(entry.sessionId);
    const { config, cards } = await loadBoard(entry.board);
    if (!config) {
      // Board gone → drop. Reap the orphaned tree (no resume will reuse it). Best-effort.
      if (entry.worktreePath) await deps.cleanupWorktree(entry.worktreePath, branch).catch(() => {});
      await deps.journal.resolveInterrupted(entry.board, entry.cardId, "error", expect);
      summary.dropped += 1;
      continue;
    }
    const card = cards.find((c) => c.id === entry.cardId);
    const decision = decideRecovery(entry, card, config);

    if (decision.action === "respawn" && card) {
      // un-strand fail-safe: NEVER resume into a session a live orphan still owns. If the scope outlived
      // even the SIGKILL escalation (a wedged/D-state claude blocked in a syscall), DEFER — leave the
      // entry 'running' (do NOT clobber the recoverable marker; do NOT spawn a 2nd claude on the
      // session, which is exactly what produced the phantom 'exit' strand) so the NEXT boot retries.
      // Fail OPEN (skip, never block) so a wedged process can't hang instrumentation.register().
      if (deps.isScopeActive && (await deps.isScopeActive(scopeUnit).catch(() => false))) {
        console.warn(
          `[harness-recovery] scope ${scopeUnit} de ${entry.board}/${entry.cardId} ainda ativa após stop — ` +
            `adiando resume (entry mantida 'running' para o próximo boot)`,
        );
        summary.deferred += 1;
        continue;
      }
      // story-watchdog (t4/AC4): validate the resume pre-conditions. If the original run had an
      // ISOLATED worktree, it must STILL exist on disk to `--resume` into it — a missing tree
      // (removed, or its branch reaped) leaves no checkpoint, so fail gracefully instead of spawning
      // into nothing. The tree is REUSED (not reaped) on the happy path: the resume runs in it.
      // story-apz8sa: this is DATA-driven on `entry.worktreePath`, NOT on isCodeSkill — and that is
      // exactly what makes recovery isCode-aware for free. A pre-dev (isCode:false) run NEVER created a
      // worktree, so it journaled NO worktreePath; the guard below is skipped entirely (no phantom
      // checkWorktreeExists / cleanupWorktree for a tree that never existed), existingWorktreePath stays
      // undefined, and the respawn resumes in the repo root — mirroring the original board-data run that
      // edited main live. Keeping the gate on the journaled fact (not the trigger) avoids coupling
      // recovery to the skill registry and stays correct even if a skill's isCode classification changes.
      let existingWorktreePath: string | undefined;
      if (entry.worktreePath) {
        const exists = await checkWorktreeExists(entry.worktreePath).catch(() => false);
        if (!exists) {
          console.warn(
            `[harness-recovery] worktree ausente para ${entry.board}/${entry.cardId} (${entry.worktreePath}) — ` +
              `marcando failed, sem resume`,
          );
          // CAS via `expect` so a 2nd boot never reprocesses this entry → no recovery loop.
          await deps.journal.resolveInterrupted(entry.board, entry.cardId, "error", expect);
          summary.dropped += 1;
          continue;
        }
        existingWorktreePath = entry.worktreePath;
      }

      const status = config.statuses.find((s) => s.id === card.status)!;
      const res = deps.runSkill(entry.board, entry.cardId, decision.trigger, status, {
        dedupeWindowMs: AUTORUN_DEDUPE_MS,
        resumeSessionId: entry.sessionId, // AC1/AC2: --resume preserves the prior session's context
        existingWorktreePath, // undefined for a legacy/isolation-off run → engine resumes in repo root
        headroomUrl: resolveHeadroomUrl(config, process.env), // route resumed run through the proxy too
        // Re-enter a conflict-redrive at its persisted depth + origin so the merge train's re-drive cap
        // isn't silently reset to 0 by the restart (story-92ldyt). Plain autorun runs carry undefined.
        origin: entry.origin,
        driveCount: entry.driveCount,
        // story-9s52tu HALF B (HIGH #2): a max-turns-resumable entry re-enters at its persisted resume
        // depth + 1 so the cap survives the restart (a chronically-stuck card still escalates). A plain
        // crash resume (no max-turns) carries undefined ⇒ 0, unchanged. Only ever bumped for a
        // `resumable` entry; the engine's max-turns settle reads it against maxTurnsResumeMax.
        maxTurnsResumeCount: entry.resumable ? (entry.maxTurnsResumeCount ?? 0) + 1 : entry.maxTurnsResumeCount,
        // story-harness-cc HALF #5: re-inject the journaled missing-session fallback budget UNCHANGED so it
        // survives the restart (the engine's in-process Map was wiped on boot). A resumed run whose session is
        // now gone reads this against resumeFallbackMax instead of restarting the budget at 0 every boot.
        resumeFallbackCount: entry.resumeFallbackCount,
        // ADR-063 (4b): re-inject the journaled loop-guard column + no-progress counter UNCHANGED so the
        // "same-column-no-progress" circuit-breaker survives the restart (mirrors driveCount/maxTurnsResume-
        // Count) — a resumed run stamps them back via recordStart, keeping the counter monotonic across boots.
        column: entry.column,
        noProgressRuns: entry.noProgressRuns,
      });
      if (res.ok) {
        // runSkill's recordStart overwrote the journal entry with a FRESH running run —
        // no resolve needed (resolving here would wrongly flip the new run to done).
        summary.respawned += 1;
      } else {
        // Rejected (rate-limited / cooldown / in-flight) → clear so it doesn't loop on the next
        // boot. Compare-and-set (expect) so we never clobber a fresher run that took the slot. The
        // resume never launched, so reap the tree we were going to reuse (else it leaks).
        await deps.journal.resolveInterrupted(entry.board, entry.cardId, "error", expect);
        if (existingWorktreePath) await deps.cleanupWorktree(existingWorktreePath, branch).catch(() => {});
        summary.dropped += 1;
      }
    } else {
      // Drop (card advanced / removed / manual one-shot) → reap any orphaned tree, then resolve.
      if (entry.worktreePath) await deps.cleanupWorktree(entry.worktreePath, branch).catch(() => {});
      await deps.journal.resolveInterrupted(entry.board, entry.cardId, "error", expect);
      summary.dropped += 1;
    }
  }

  return summary;
}

/**
 * Boot recovery for the SM-2 merge train (sibling of recoverInterruptedRuns). On a restart the
 * in-memory queue is gone but merge-queue.json survives: this loads it, parks any `merging` entry
 * (a crash mid-merge — the tree may be dirty) as `conflict` for the operator to validate, and
 * resumes the `waiting` ones. The queue owns that logic (mq.recover); this is the guarded boot seam
 * so a failure here can never abort instrumentation. Returns the summary the caller logs.
 */
export async function recoverMergeQueue(mq: Pick<MergeQueuePort, "recover">): Promise<MergeQueueRecovery> {
  try {
    return await mq.recover();
  } catch (err) {
    console.error("[harness-boot] merge-queue recovery failed:", err instanceof Error ? err.message : err);
    return { loaded: 0, resetToConflict: 0, resumed: 0, pruned: 0, resetGateFailed: 0, waiting: 0 };
  }
}

/** Same OS boot session? (tolerance absorbs os.uptime's ~second resolution between two reads.) */
export function sameBootSession(entryBootMs: number | undefined, currentBootMs: number): boolean {
  return entryBootMs !== undefined && Math.abs(entryBootMs - currentBootMs) < 5_000;
}

/**
 * Default orphan killer: the whole process tree on Windows (taskkill /T), SIGTERM elsewhere.
 * GUARDED by boot session: across a machine reboot the recorded pid has been recycled to an
 * unrelated process (Windows resets the pid counter; Linux pid_max wraps), so killing it by
 * number would hit a stranger. We kill ONLY when the run started in the CURRENT boot session;
 * after a reboot the orphan is already dead anyway, so skipping the kill loses nothing. A bare
 * dead pid in the same session is a harmless no-op (ESRCH / taskkill finds no target).
 */
export function defaultKillOrphan(pid: number | null, entryBootMs?: number): void {
  if (!pid || pid <= 0) return;
  if (!sameBootSession(entryBootMs, osBootMs())) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already dead in this session — best effort, never throw on boot
  }
}

/**
 * Default worktree reaper: delegates to the git WorktreeOps, swallowing errors. A stale tree is
 * harmless (the next run uses a fresh uuid path) and `git worktree remove --force` is idempotent,
 * so a failure here is non-fatal and must never abort boot recovery.
 */
export async function defaultCleanupWorktree(worktreePath: string, branch: string): Promise<void> {
  await defaultWorktreeOps.remove(worktreePath, branch).catch(() => {});
}

/**
 * un-strand — production scope-stop: SIGTERM the named run scope (`systemctl stop`), a SHORT grace, then
 * SIGKILL-escalate the cgroup if it's still active. The grace is bounded (2 s) so a couple of interrupted
 * entries can't stall boot. The `harness-run-*.scope` allowlist lives INSIDE stopRunScope — it can never
 * target storymap.service or a slice. Never throws (best-effort on the boot path).
 */
export async function defaultStopScope(unit: string): Promise<void> {
  await stopRunScope(unit, undefined, { graceMs: 2_000 }).catch(() => {});
}

/** un-strand — production scope-liveness probe (`systemctl is-active <unit>`); fail-safe to "dead". */
export async function defaultIsScopeActive(unit: string): Promise<boolean> {
  return isRunScopeActive(unit).catch(() => false);
}

/**
 * story-watchdog (AC4) — default resume pre-condition: does the original run's ephemeral worktree
 * still exist on disk? `fsp.access` resolves iff the path is reachable; ANY error (ENOENT, perms)
 * means we cannot `--resume` into it, so we report missing (fail-safe → the caller fails the run
 * gracefully rather than looping). Pure I/O, injectable via RecoveryDeps for tests.
 */
export async function checkWorktreeOnDisk(worktreePath: string): Promise<boolean> {
  try {
    await fsp.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/** The git/remove plumbing the reconciler needs, injectable (DI) so the prune logic is testable. */
export interface ReconcileDeps {
  /** Raw output of `git worktree list --porcelain` (the real worktrees on disk). */
  listWorktrees(): Promise<string>;
  /** Remove a worktree dir + delete its branch (idempotent). */
  removeWorktree(worktreePath: string, branch: string): Promise<void>;
  /** settle-gap-resume: every `run/*` (and WS-1 `agent/*`) branch name, INCLUDING detached ones with no dir. */
  listRunBranches?(): Promise<string[]>;
  /** settle-gap-resume: safe-dispose a worktree-less orphan branch (preserve-as-failed/<branch> or delete). */
  disposeBranch?(branch: string): Promise<void>;
  /**
   * WS-1/G7 — "is this agent session PROVABLY dead (heartbeat past its TTL) and therefore reapable?" Only a
   * TRUE releases a session's worktree dir; absent dep, a throw, or a false all mean LEAVE IT ALONE. This
   * asymmetry is deliberate and load-bearing: the reaper has already destroyed a live RUN worktree mid-run
   * (memory `harness-do-worktree-reaped-midrun`), and a session's tree lives for HOURS with an agent editing in
   * it, so the same mistake here is far more expensive. Never consulted for `run/*`.
   */
  isSessionReapable?(sessionId: string, worktreePath?: string): Promise<boolean>;
}

/**
 * Parse `git worktree list --porcelain` into the MACHINE's worktrees. Each porcelain block is
 * `worktree <path>` + (optionally) `branch refs/heads/<name>`; we keep the `run/<id>` and (WS-1)
 * `agent/<id>` ones and recover the sessionId from the branch ref. Pure — exported for tests.
 *
 * `origin` matters because the two have OPPOSITE default fates in the reconciler: a `run/*` tree with no
 * live journal entry is garbage (its process is gone — nothing will ever write to it again), while an
 * `agent/*` tree with no journal entry is the NORMAL state of a healthy session (a session is not a run;
 * it was never in the journal). Pruning them by the same rule would delete every live agent's work on the
 * first service restart — see makeReconcileWorktrees.
 */
export function parseRunWorktrees(
  porcelain: string,
): Array<{ worktreePath: string; sessionId: string; branch: string; origin: "run" | "session" }> {
  const out: Array<{ worktreePath: string; sessionId: string; branch: string; origin: "run" | "session" }> = [];
  let curPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    const l = line.trim();
    if (l === "") {
      curPath = null;
      continue;
    }
    if (l.startsWith("worktree ")) {
      curPath = l.slice("worktree ".length);
      continue;
    }
    if (l.startsWith("branch ")) {
      const ref = l.slice("branch ".length);
      const run = ref.match(/^refs\/heads\/run\/(.+)$/);
      if (run && curPath) {
        out.push({ worktreePath: curPath, sessionId: run[1], branch: `run/${run[1]}`, origin: "run" });
        continue;
      }
      const agent = ref.match(/^refs\/heads\/agent\/(.+)$/);
      if (agent && curPath) {
        out.push({ worktreePath: curPath, sessionId: agent[1], branch: `agent/${agent[1]}`, origin: "session" });
      }
    }
  }
  return out;
}

/**
 * Build the f4 reconciler over injectable deps. Prunes every `run/*` worktree whose sessionId is
 * NOT in `keepSessionIds`; best-effort (a remove failure is swallowed, the sweep continues).
 * Returns the count successfully pruned.
 *
 * WS-1/G7 — SESSION trees are governed by the OPPOSITE default. `keepSessionIds` is built from the RUN
 * JOURNAL, and a session was never in the journal, so the run rule ("no entry ⇒ prune") applied to
 * `agent/*` would delete the worktree of every live agent on the first boot after a restart — with the
 * agent still editing in it. A session's liveness lives in its own durable registry (session-worktree.ts),
 * so an agent tree is pruned ONLY when `isSessionReapable` positively says its heartbeat is dead past the
 * TTL. FAIL-CLOSED: no `isSessionReapable` dep ⇒ no session tree is ever pruned (the pre-WS-1 behaviour,
 * where the parser simply didn't see them). Even when reaped, the BRANCH still goes through
 * `removeWorktree`'s fail-closed teardown, which preserves un-integrated commits as `failed/agent/<id>` —
 * the folder is disposable, the work never is.
 */
export function makeReconcileWorktrees(deps: ReconcileDeps): (keep: Set<string>) => Promise<number> {
  return async (keepSessionIds) => {
    const list = await deps.listWorktrees().catch(() => "");
    const dirBacked = new Set<string>();
    let pruned = 0;
    for (const wt of parseRunWorktrees(list)) {
      dirBacked.add(wt.sessionId);
      if (keepSessionIds.has(wt.sessionId)) continue; // a live run owns this tree → leave it
      if (wt.origin === "session") {
        // Positive proof of death required — silence means ALIVE. O CAMINHO vai junto: a prova de morte
        // não é só o carimbo do registro, é também "ninguém está mexendo nesta árvore" (session-activity).
        const reapable = deps.isSessionReapable
          ? await deps.isSessionReapable(wt.sessionId, wt.worktreePath).catch(() => false)
          : false;
        if (!reapable) continue;
        console.warn(`[recovery] worktree de sessão ${wt.branch}: heartbeat morto + TTL vencido → liberando a pasta (branch preservado se tiver trabalho)`);
      }
      try {
        await deps.removeWorktree(wt.worktreePath, wt.branch);
        pruned += 1;
      } catch {
        // best-effort — a stale tree is superseded by the next run's fresh uuid path; never abort boot
      }
    }
    // settle-gap-resume: ALSO sweep DETACHED `run/*` branches — a crash between detach (dir removed,
    // branch kept) and the merge enqueue leaves a COMMITTED branch invisible to the worktree-list scan
    // above (no dir), never preserved/cleaned. Dispose any run/<id> NOT dir-backed (handled above) AND
    // NOT kept (a live interrupted run OR a live merge-train branch) → disposeBranch PRESERVES its
    // un-integrated work as failed/<branch> (recoverable) or deletes an empty one. Optional deps → a
    // legacy caller without them simply skips this pass (behaviour identical to before).
    if (deps.listRunBranches && deps.disposeBranch) {
      const branches = await deps.listRunBranches().catch(() => [] as string[]);
      for (const branch of branches) {
        const m = branch.match(/^(run|agent)\/(.+)$/);
        if (!m) continue;
        const sessionId = m[2];
        if (dirBacked.has(sessionId) || keepSessionIds.has(sessionId)) continue;
        // WS-1/G7: an `agent/<id>` branch with NO dir can still belong to a live session (its tree was
        // reaped from under it, or it is mid-open) — only a dead session's branch may be disposed. Same
        // fail-closed default as the tree sweep: unknown ⇒ alive ⇒ leave it. `disposeBranch` itself still
        // PRESERVES anything with un-integrated commits, so the worst case is a `failed/agent/<id>` snapshot.
        if (m[1] === "agent") {
          const reapable = deps.isSessionReapable
            ? await deps.isSessionReapable(sessionId).catch(() => false)
            : false;
          if (!reapable) continue;
        }
        try {
          await deps.disposeBranch(branch);
          pruned += 1;
        } catch {
          // best-effort — never abort boot over an orphan-branch sweep
        }
      }
    }
    return pruned;
  };
}

const reconcileExec = defaultExec;

/** Production f4 reconciler over the real git + the default WorktreeOps remover. Best-effort. */
export async function defaultReconcileWorktrees(keepSessionIds: Set<string>): Promise<number> {
  const repoRoot = findRepoRoot();
  const reconcile = makeReconcileWorktrees({
    listWorktrees: async () => {
      const { stdout } = await reconcileExec("git worktree list --porcelain", { cwd: repoRoot, timeout: 60_000 });
      return stdout;
    },
    removeWorktree: (worktreePath, branch) => defaultWorktreeOps.remove(worktreePath, branch),
    listRunBranches: async () => {
      const { stdout } = await reconcileExec(
        "git for-each-ref --format='%(refname:short)' refs/heads/run/ refs/heads/agent/",
        { cwd: repoRoot, timeout: 60_000 },
      );
      return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    },
    disposeBranch: (branch) => defaultWorktreeOps.disposeBranch(repoRoot, branch),
    // G7: reapable ONLY when a READABLE registry positively says this session's heartbeat is dead past the
    // TTL. Um registro ILEGÍVEL nunca autoriza reap (`ok:false` ⇒ false): "não sei" não é "morto" — era
    // por aí que um `[]` mudo transformava uma falha de leitura em "todas as sessões morreram" e varria a
    // frota inteira de uma vez (ver liveSessionIds). O registro está em disco justamente para esta
    // resposta sobreviver ao restart que dispara a varredura.
    isSessionReapable: async (sessionId, worktreePath) => {
      const live = await liveSessionIds();
      if (!live.ok) {
        console.warn(`[recovery] registro de sessões ilegível (${live.error}) — NENHUMA árvore de sessão será varrida neste passe.`);
        return false;
      }
      if (live.ids.includes(sessionId)) return false;
      // O CARIMBO diz morta — mas o carimbo mede "conversou com o serviço", não "está trabalhando". Uma
      // sessão INTERATIVA edita, builda e roda teste por horas sem tocar no MCP: foi assim que uma árvore
      // com 14 arquivos editados foi declarada morta às 6h e apagada (2026-07-27). Antes de liberar,
      // pergunte ao TRABALHO: algum arquivo sujo foi tocado dentro da janela? Só roda para quem o registro
      // já deu como morta (raro) e sai no primeiro arquivo recente. Ver session-activity.ts.
      if (worktreePath && (await worktreeTouchedWithin({ exec: reconcileExec }, worktreePath, SESSION_HEARTBEAT_TTL_MS))) {
        console.warn(
          `[recovery] sessão ${sessionId.slice(0, 8)}: heartbeat vencido, mas a árvore foi EDITADA há pouco — ` +
            `mantendo (o carimbo mede chamada de tool, não trabalho).`,
        );
        // …e a descoberta não fica só aqui: ela ALIMENTA o carimbo, que é o que o cap de admissão, o
        // /processes e o branch-gc leem. Sem isto, a sessão seguiria "morta" para todos eles enquanto a
        // varredura, sozinha, sabia que não estava. Ver renewHeartbeatFromActivity.
        await renewHeartbeatFromActivity(sessionId).catch(() => {});
        return false;
      }
      return true;
    },
  });
  return reconcile(keepSessionIds).catch(() => 0);
}

// Re-exported so callers don't need to import RunOutcome from journal for the deps shape.
export type { RunOutcome };
