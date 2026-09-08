// Runner journal — the DURABLE twin of the in-memory RunnerRegistry (registry.ts).
//
// The registry is the live picture of "what is running right now" and is GONE when the
// dev server restarts (process-global, never touches disk). That is exactly why an
// interrupted autorun never resumed: after a crash nothing remembered it was mid-run.
// This journal persists the small durable subset needed to RECOVER:
//   - which runs were in-flight when the process died, and
//   - each card's most-recent session id (so `claude --resume <id>` survives a restart).
//
// CONTRACT: a run is written "running" the instant it spawns and flipped to "done" when
// it settles (success OR failure). Therefore, on boot, EVERY entry still "running" is —
// by construction — a run the crash interrupted (a clean finish would have flipped it).
// recovery.ts reads exactly those. This avoids a board-wide sweep, which would re-spawn
// every card merely SITTING in a trigger column (the spawn storm the watcher's
// "seed silently" guard deliberately prevents).
//
// Persisted atomically (write tmp + rename) to storymap/.runner/journal.json (gitignored).
// SERVER-ONLY (node:fs). Process-global singleton, mirroring registry.ts / engine.ts.

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { TriggerId } from "@/lib/storymap/types";

// "oom-killed": a run whose scope (systemd-run --scope, SM-4) exceeded MemoryMax and was
// SIGKILL'd by the kernel's cgroup OOM killer — distinguished from a plain "exit" so the
// forensic journal/registry can flag a resource-exhaustion death vs. a clean non-zero exit.
// "no-op": a clean exit (code 0) from a skill that MUST advance the card (advancesOnSuccess)
// yet left it in its trigger column — the sucesso-fantasma. Carved out from "ok" so the wedge
// surfaces in failures[] instead of being silently recorded as a success.
// "cancelled": a DELIBERATE operator cancel (forceRelease / cancel_run), distinct from EVERY
// failure outcome (story-vbkazs). Industry-canonical (GitHub Actions `conclusion: cancelled`,
// GitLab/Azure/AWS all separate a user cancel from `failed`): a SIGTERM the OPERATOR asked for is
// NOT a failure — so it is kept OUT of every failed-set (cockpit FAILED_STATUSES, demands
// STUCK_REASONS) and never produces a RunnerFailure. A SIGTERM from the watchdog TIMEOUT stays
// "timeout"; an OOM SIGKILL stays "oom-killed" — only a forceRelease-originated kill is "cancelled".
// "max-turns": the run hit the `--max-turns` cap (stream-json `result` subtype error_max_turns)
// (story-9s52tu HALF B). It is RESUMABLE — partial task commits exist on its branch, so the worktree +
// branch are PRESERVED on teardown (not force-deleted) and a re-run continues via `claude --resume`.
// Distinct from "error" so the journal/forensics flag a turn-budget exhaustion (recoverable) vs a
// genuine code error (force-deleted). Like a crash-interrupted run, it is left effectively resumable.
export type RunOutcome = "ok" | "error" | "timeout" | "exit" | "oom-killed" | "no-op" | "cancelled" | "max-turns";

/** One durably-recorded headless run. Keyed (in memory + file) by `board/cardId`. */
export interface JournalEntry {
  board: string;
  cardId: string;
  trigger: TriggerId;
  /** `claude --session-id` this run spawned with — lets a human `--resume` it post-restart. */
  sessionId: string;
  /** OS pid of the spawned shell, for a best-effort orphan kill on recovery; null if unknown. */
  pid: number | null;
  /** "manual" (Rodar agora / Sincronizar) vs "autorun" vs "conflict-redrive" (story-92ldyt: a merge
   * conflict re-ran the generating skill) — recovery never re-fires a manual one-shot, but a crashed
   * conflict-redrive recovers like an autorun (re-run the skill against the updated main). */
  origin?: "autorun" | "manual" | "conflict-redrive";
  /** Conflict re-drive depth this run carries (story-92ldyt cap = mergeTrain.maxRedrives). Persisted so
   * a restart RESUMES a redrive at the SAME depth instead of resetting to 0 (which would let a
   * pathological conflict re-drive past the cap each crash cycle). Absent for a normal first run. */
  driveCount?: number;
  /** OS boot instant when the run started — recovery kills an orphan pid only within the SAME boot session. */
  osBootMs?: number;
  startedAt: number;
  /** Ephemeral `git worktree` this run spawned into (R1 isolation) — present once created;
   * absent if create failed or for legacy entries. Lets boot recovery reap an orphaned tree. */
  worktreePath?: string;
  /** The named `systemd-run` scope (`harness-run-<sessionId>.scope`) this run was launched into, when the
   * governor applied one. Persisted so recovery can STOP the still-live orphan scope by name BEFORE
   * resuming its session (a `--resume` into a session the orphan still owns is what strands the card).
   * Absent when no scope was applied (systemd off / no quota) or for legacy entries — recovery then
   * rederives it from sessionId (deterministic) and a stop is a harmless no-op. */
  unit?: string;
  status: "running" | "done";
  endedAt?: number;
  outcome?: RunOutcome;
  /** story-9s52tu HALF B: this run hit `--max-turns` and is RESUMABLE — its ephemeral worktree +
   * `run/<sessionId>` branch were PRESERVED (not force-deleted), carrying the partial task commits, so
   * boot recovery resumes it via `claude --resume` from where it stopped. Set ON a max-turns teardown
   * (alongside outcome "max-turns") and keyed on by {@link recovery.findResumable}. Absent ⇒ a normal
   * run (a genuine error force-deletes its tree → never resumable). */
  resumable?: boolean;
  /** story-9s52tu HALF B (HIGH #2): MONOTONIC count of how many times THIS card has already been
   * auto-resumed after a `--max-turns` settle. Carried through {@link JournalStart} so it SURVIVES the
   * resume's `recordStart` (exactly like {@link driveCount}) — it must NOT reset each cycle, else a
   * chronically-stuck card loops forever. The engine increments it per resume and, once it reaches
   * {@link config.maxTurnsResumeMax}, STOPS preserving and escalates the run to a genuine failure. Absent
   * ⇒ 0 (a first run / a run never resumed). */
  maxTurnsResumeCount?: number;
  /** story-harness-cc HALF #5: MONOTONIC count of how many times THIS card has already been auto-re-
   * dispatched FRESH after a missing `--resume` session ("No conversation found with session ID"). Carried
   * through {@link JournalStart} so it SURVIVES a server restart (the in-memory `resumeFallbackCount` Map is
   * lost on boot — without this the per-card fallback budget resets to 0 each restart and a session store
   * that keeps losing sessions can churn fresh dispatches forever). The engine reads it against
   * {@link config.resumeFallbackMax}; once exhausted the run settles as a real failure for the operator.
   * Absent ⇒ 0 (a first run / a run that never hit a missing-session fallback). */
  resumeFallbackCount?: number;
  /** story-harness-adk G6: a one-line distilled summary of a DEAD run's reasoning (summarizeFinalText of
   * its finalText), captured when a missing-session resume falls back to a FRESH re-dispatch and injected
   * into the fresh run's system prompt so the lost session's reasoning isn't thrown away (the agent
   * doesn't re-tread abandoned dead-ends). Carried through {@link JournalStart}. Additive/optional (no
   * JOURNAL_VERSION bump, like resumeFallbackCount). Absent ⇒ no prior reasoning to carry. */
  resumeNote?: string;
  /** ADR-063 (4b): the card STATUS id this run processed (read by the autorun loop-guard shell as the
   * "did the card advance?" reference — the next eval compares the card's CURRENT status against this).
   * Stamped by the shell via {@link JournalStart}; carried FORWARD unchanged across a run's own resume/
   * re-dispatch (the shell owns the increment, not the engine). Additive/optional (no JOURNAL_VERSION
   * bump, like resumeFallbackCount). Absent ⇒ a manual/legacy run (⇒ the guard resets — a natural override). */
  column?: string;
  /** ADR-063 (4b): MONOTONIC count of CONSECUTIVE runs of this card whose status stayed == {@link column}
   * across fresh cascade re-dispatches of the same trigger (no column advance = no progress). The shell
   * increments it per fresh eval and STOPS auto-dispatching once it reaches config.noProgressMax. Carried
   * through {@link JournalStart} so it SURVIVES a restart (exactly like {@link resumeFallbackCount} /
   * {@link maxTurnsResumeCount}) — else the guard would reset each boot and a wedged card could churn
   * forever. Additive/optional (no JOURNAL_VERSION bump). Absent ⇒ 0 (a first / freshly-reset run). */
  noProgressRuns?: number;
}

/** The fields the engine knows at spawn time (status is set by recordStart). */
export type JournalStart = Omit<JournalEntry, "status" | "endedAt" | "outcome">;

/** Narrow surface the engine depends on (DI — like the engine's injectable `spawn`). */
export interface RunnerJournalPort {
  recordStart(entry: JournalStart): unknown;
  recordFinish(board: string, cardId: string, outcome: RunOutcome, endedAt: number): unknown;
  /** story-9s52tu HALF B: a run hit `--max-turns` — mark it RESUMABLE WITHOUT flipping it to "done".
   * The entry STAYS "running" (so boot recovery's loadInterrupted picks it up and resumes it via
   * `claude --resume`, exactly like a crash-interrupted run) but carries `resumable:true` +
   * `outcome:"max-turns"` for forensics/classification. The preserved worktree path it already holds
   * is what the resume runs IN. No-op if no start was recorded for the card. */
  markResumable(board: string, cardId: string, endedAt: number): unknown;
  /** ADR-063 (4b): the current (most-recent) entry for a card — the DURABLE read the autorun loop-guard
   * needs (it survives a restart, unlike the in-memory registry). OPTIONAL on the port so existing minimal
   * fakes stay valid; the concrete {@link RunnerJournal} implements it. undefined ⇒ the card has no entry. */
  latest?(board: string, cardId: string): Promise<JournalEntry | undefined>;
}

/**
 * Persistence port — disk by default, in-memory in tests. Keeps RunnerJournal's logic
 * (the running/done lifecycle + the cap) pure and unit-testable without touching fs.
 */
export interface JournalStore {
  load(): Promise<JournalEntry[]>;
  persist(entries: JournalEntry[]): Promise<void>;
}

/**
 * OS boot instant (ms), so two processes in the SAME boot session agree (os.uptime has ~second
 * resolution → compare with tolerance). Persisted per run so recovery can refuse to force-kill a
 * pid that was recycled across a machine reboot (see defaultKillOrphan in recovery.ts).
 */
export function osBootMs(): number {
  return Math.round(Date.now() - os.uptime() * 1000);
}

// Keep recent finished runs so `claude --resume` resolves for a while after a run ends,
// but cap the file so it can't grow unbounded across a long dev session.
const MAX_DONE_RETAINED = 200;

function keyOf(board: string, cardId: string): string {
  return `${board}/${cardId}`;
}

export class RunnerJournal implements RunnerJournalPort {
  private entries = new Map<string, JournalEntry>();
  // Memoized load PROMISE (not a boolean): every concurrent caller awaits the SAME resolution,
  // so none proceeds on a partial map. MERGE (never clobber) so a fresh recordStart that landed
  // during the load survives the stale disk copy.
  private loadOnce?: Promise<void>;
  // Serialize persists so a concurrent start/finish can never interleave a half-written file.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private store: JournalStore) {}

  private ensureLoaded(): Promise<void> {
    return (this.loadOnce ??= this.store
      .load()
      .catch(() => [] as JournalEntry[])
      .then((rows) => {
        for (const e of rows) {
          const k = keyOf(e.board, e.cardId);
          if (!this.entries.has(k)) this.entries.set(k, e);
        }
      }));
  }

  /** Re-derive the capped set and flush it; chained so writes never interleave. */
  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(async () => {
      const all = [...this.entries.values()];
      const running = all.filter((e) => e.status === "running");
      const done = all
        .filter((e) => e.status === "done")
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, MAX_DONE_RETAINED);
      // Re-seed memory to the capped set so it matches disk (running entries are NEVER dropped).
      this.entries = new Map([...running, ...done].map((e) => [keyOf(e.board, e.cardId), e]));
      await this.store.persist([...this.entries.values()]).catch((err) => {
        console.error("[harness-journal] persist failed:", err instanceof Error ? err.message : err);
      });
    });
  }

  /** A run spawned → record it "running" (fire-and-forget from the engine). */
  async recordStart(entry: JournalStart): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(keyOf(entry.board, entry.cardId), { ...entry, status: "running" });
    this.schedulePersist();
  }

  /**
   * A run settled → flip it "done" with its outcome. No-op if no start was recorded. When
   * `expect` is passed (recovery's drop path), this is a COMPARE-AND-SET: it flips only if the
   * entry still IS the run being resolved — so a fresher recordStart (a watcher- or
   * manual-started run for the same card) is never clobbered to done.
   */
  async recordFinish(
    board: string,
    cardId: string,
    outcome: RunOutcome,
    endedAt: number,
    expect?: { sessionId: string; startedAt: number },
  ): Promise<void> {
    await this.ensureLoaded();
    const k = keyOf(board, cardId);
    const prev = this.entries.get(k);
    if (!prev || (expect && (prev.sessionId !== expect.sessionId || prev.startedAt !== expect.startedAt))) return;
    this.entries.set(k, { ...prev, status: "done", outcome, endedAt });
    this.schedulePersist();
  }

  /**
   * story-9s52tu HALF B: a run hit `--max-turns` — mark it RESUMABLE without flipping it to "done".
   * It STAYS "running" (so loadInterrupted picks it up on the next boot and recovery resumes it via
   * `claude --resume`, mirroring a crash-interrupted run) but carries `resumable:true` +
   * `outcome:"max-turns"` for classification. The worktreePath recorded at start is preserved on disk,
   * so the resume runs IN it. No-op if no start was recorded. `endedAt` is stamped for the forensics
   * even though the entry is not "done" (it marks when the turn budget ran out).
   */
  async markResumable(board: string, cardId: string, endedAt: number): Promise<void> {
    await this.ensureLoaded();
    const k = keyOf(board, cardId);
    const prev = this.entries.get(k);
    if (!prev) return;
    this.entries.set(k, { ...prev, status: "running", resumable: true, outcome: "max-turns", endedAt });
    this.schedulePersist();
  }

  /** Entries still "running" on disk = runs the crash interrupted (a clean finish flips to done). */
  async loadInterrupted(): Promise<JournalEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].filter((e) => e.status === "running");
  }

  /** All journal entries (running + recent done) — read-only snapshot for the Processos page. */
  async list(): Promise<JournalEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.values()];
  }

  /** Mark an interrupted run resolved so a SECOND boot doesn't reprocess it (compare-and-set via `expect`). */
  async resolveInterrupted(
    board: string,
    cardId: string,
    outcome: RunOutcome = "error",
    expect?: { sessionId: string; startedAt: number },
  ): Promise<void> {
    await this.recordFinish(board, cardId, outcome, Date.now(), expect);
  }

  /** Most-recent session id for a card (survives a restart → `claude --resume <id>`). */
  async sessionFor(board: string, cardId: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.entries.get(keyOf(board, cardId))?.sessionId ?? null;
  }

  /** ADR-063 (4b): the current (most-recent) entry for a card — the DURABLE read the autorun loop-guard
   * uses to know which status the last run processed + the monotonic no-progress counter it carried.
   * Reads the in-memory map (loaded from disk) so it survives a restart. undefined ⇒ no entry for the card. */
  async latest(board: string, cardId: string): Promise<JournalEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.get(keyOf(board, cardId));
  }

  /** Await all pending writes (tests / graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

// JOURNAL_VERSION — bump when the persisted shape changes incompatibly; load() drops a file whose
// version it doesn't recognize (the entries feed DESTRUCTIVE recovery, so reading a foreign/old
// schema as-is is the footgun this guards).
const JOURNAL_VERSION = 1;

// Tolerant shape contract for ONE persisted entry. The journal is cross-process (a prior dev-server
// life) and drives `killOrphan(pid)` + `git worktree remove(worktreePath)` on boot — so we VALIDATE
// the structural types that reach those (pid number|null, worktreePath string, status enum) and DROP
// any entry that doesn't match instead of casting garbage in. `trigger` stays loose (z.string) on
// purpose: an entry whose trigger was renamed between boots is STILL worth keeping so its orphan
// pid/worktree get reaped — recovery tolerates an unknown trigger downstream (lookup-miss = no re-fire).
const JournalEntrySchema = z.object({
  board: z.string(),
  cardId: z.string(),
  trigger: z.string(),
  sessionId: z.string(),
  pid: z.number().nullable(),
  origin: z.enum(["autorun", "manual", "conflict-redrive"]).optional(),
  driveCount: z.number().optional(),
  osBootMs: z.number().optional(),
  startedAt: z.number(),
  worktreePath: z.string().optional(),
  unit: z.string().optional(),
  status: z.enum(["running", "done"]),
  endedAt: z.number().optional(),
  outcome: z.enum(["ok", "error", "timeout", "exit", "oom-killed", "no-op", "cancelled", "max-turns"]).optional(),
  resumable: z.boolean().optional(),
  maxTurnsResumeCount: z.number().optional(),
  resumeFallbackCount: z.number().optional(),
  resumeNote: z.string().optional(),
  column: z.string().optional(),
  noProgressRuns: z.number().optional(),
});

/** Atomic on-disk store: write a temp file then rename over the target (same fs). */
export function diskJournalStore(dir: string): JournalStore {
  const file = path.join(dir, "journal.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        // Foreign / old-schema file → start clean (never feed unrecognized entries to recovery).
        if (data?.version !== JOURNAL_VERSION || !Array.isArray(data.runs)) {
          // settle-gap/version-bump: a SELF version bump (new build, prior journal with runs IN FLIGHT)
          // drops them by design — but LOUDLY, so the strand isn't invisible vs a clean empty boot. The
          // reconciler's branch-sweep preserves any committed run/<id> as failed/<branch>.
          if (data && Array.isArray(data.runs) && data.runs.length && data.version !== JOURNAL_VERSION) {
            console.warn(
              `[harness-journal] versão ${data.version} ≠ ${JOURNAL_VERSION}: descartando ${data.runs.length} run(s) em andamento (bump de schema) — verifique branches failed/run/* por trabalho não integrado.`,
            );
          }
          return [];
        }
        // Keep only structurally-valid entries; a malformed one is dropped, not trusted.
        const valid: JournalEntry[] = [];
        for (const r of data.runs) {
          const parsed = JournalEntrySchema.safeParse(r);
          if (parsed.success) valid.push(parsed.data as JournalEntry);
        }
        return valid;
      } catch {
        return []; // absent / unreadable / malformed JSON → start clean
      }
    },
    async persist(entries) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: JOURNAL_VERSION, runs: entries }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file); // atomic; overwrites on win32 via MoveFileEx
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

const KEY = Symbol.for("storymap.runner.journal");
const store = globalThis as unknown as { [KEY]?: RunnerJournal };

export function getRunnerJournal(): RunnerJournal {
  return (store[KEY] ??= new RunnerJournal(diskJournalStore(runnerStateDir())));
}
