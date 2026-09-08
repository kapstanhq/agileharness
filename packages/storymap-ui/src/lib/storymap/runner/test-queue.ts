// ADR-063 item 3b — ASYNC event-driven test execution: fire → resume on the result (the onMergeDone
// pattern), OUT of the LLM loop. Two layers in this file:
//
//   1. makeTestQueue — the PURE in-memory KERNEL (the original scaffold). It runs a card's acceptance
//      suite DETACHED from the LLM loop (the enqueuer does NOT await the result) and fans the outcome
//      out via `onDone`, mirroring the merge train's `onMergeDone` (merge-queue.ts ~191-197). PURE over
//      an injected `run` (like the engine's `spawn` / mergeQueue's `exec`): unit-testable with a fake
//      run, no processes, no disk. `settle`-once + fan-out + `recover()` (re-drive a same-process crash).
//
//   2. makePersistentTestQueue + getTestQueue — the WIRED, DURABLE layer (Fase 3b proper). It wraps the
//      kernel with a disk LEDGER so a fired test survives a service RESTART (boot `recover()` reloads +
//      re-drives), a `reportDone` entry point for a test that OUTLIVES the process (the /api/runner/
//      test-webhook durable twin — like deploy-webhook), and a process-global singleton. The
//      trigger-runner-channel subscribes its `onDone` to RESUME the cascade (evaluateAutorunOnEntry),
//      exactly the way it subscribes mergeQueue.onMergeDone — so the wait leaves the LLM loop entirely.

import { promises as fsp } from "node:fs";
import { createWriteStream, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";

/** The unit of work: run this card's tests, triggered by `trigger` (the generating skill/column). */
export interface TestJob {
  board: string;
  cardId: string;
  trigger: string;
  /** The test command to run detached (built by the consumer — 3a's planner). A slug-validated,
   * internally-constructed shell command; absent ⇒ the default runner logs a misconfig + fails (never
   * a silent pass). Persisted so a restart re-drives the SAME command. */
  command?: string;
  /** ADR-063 5a: the git range the QA verifies (only the diff since the last green). Threaded through so
   * a resumed/re-driven run re-verifies the SAME delta. Opaque to the queue; the consumer builds it. */
  commitRange?: string;
}

/** The result an `onDone` subscriber receives once a job's tests land. */
export interface TestJobDone extends TestJob {
  passed: boolean;
}

/** The injectable surface a future channel subscribes to (DI — like {@link MergeQueuePort}). */
export interface TestQueuePort {
  /** Enqueue a card's test run. Returns immediately — the run is DETACHED (never awaited by the caller). */
  enqueue(job: TestJob): void;
  /**
   * Subscribe to every job that finishes (its tests landed). Multiple subscribers ALL fire, each
   * exactly ONCE per job (singleton-safe fan-out, mirroring mergeQueue.onMergeDone). Returns an
   * unsubscribe fn.
   */
  onDone(fn: (d: TestJobDone) => void): () => void;
  /**
   * Re-drive every job still in flight — the boot-recovery pass for jobs whose run crashed mid-flight
   * (the process died before the result landed). Each in-flight job is re-run; whichever invocation
   * settles first emits `onDone` exactly once for that job (a late-resolving crashed run cannot
   * double-emit). A no-op when nothing is in flight.
   */
  recover(): void;
}

/**
 * Build a {@link TestQueuePort} over an injected `run` (the detached test executor). In-memory: a job
 * is tracked as in-flight from `enqueue` until its `run` settles, at which point it is removed and
 * `onDone` fires once. `recover()` re-drives whatever is still in-flight. PURE over `run`.
 */
export function makeTestQueue(deps: { run: (job: TestJob) => Promise<{ passed: boolean }> }): TestQueuePort {
  // Monotonic id per enqueue → the settle guard keys on it so each job emits exactly ONCE even when a
  // recover() re-drive races the original (crashed) run to completion.
  let seq = 0;
  const inFlight = new Map<number, TestJob>();
  const listeners = new Set<(d: TestJobDone) => void>();

  const emit = (d: TestJobDone): void => {
    for (const fn of listeners) {
      try {
        fn(d);
      } catch (err) {
        // LOG-and-KEEP (mirrors mergeQueue.emitMergeDone): a throwing subscriber stays subscribed so a
        // single bad handler can't permanently sever the fan-out for the process.
        console.error("[harness-test-queue] onDone listener threw", err instanceof Error ? err.message : err);
      }
    }
  };

  /** Settle a job exactly once: only the FIRST invocation for `id` (original run OR its recover re-drive)
   * removes it from in-flight + emits; a later winner finds it gone and no-ops. */
  const settle = (id: number, job: TestJob, passed: boolean): void => {
    if (!inFlight.has(id)) return;
    inFlight.delete(id);
    emit({ ...job, passed });
  };

  /** Fire the detached run for a tracked job and route its outcome into `settle`. A rejected run counts
   * as a FAILED result (never throws out of the queue) — a crash in the executor must not lose the job. */
  const drive = (id: number, job: TestJob): void => {
    Promise.resolve()
      .then(() => deps.run(job))
      .then((r) => settle(id, job, r.passed))
      .catch((err) => {
        console.error("[harness-test-queue] run threw", err instanceof Error ? err.message : err);
        settle(id, job, false);
      });
  };

  return {
    enqueue(job: TestJob): void {
      const id = (seq += 1);
      inFlight.set(id, job);
      drive(id, job);
    },
    onDone(fn: (d: TestJobDone) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    recover(): void {
      for (const [id, job] of inFlight) drive(id, job);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fase 3b — the DURABLE, WIRED layer over the kernel.
// ─────────────────────────────────────────────────────────────────────────────

/** A test job as persisted to the durable ledger (survives a restart → re-driven at boot). */
export interface PersistedTestJob extends TestJob {
  /** epoch-ms the job was enqueued (for observability / stale detection). */
  enqueuedAt: number;
}

const TEST_QUEUE_VERSION = 1;

const PersistedTestJobSchema = z.object({
  board: z.string(),
  cardId: z.string(),
  trigger: z.string(),
  command: z.string().optional(),
  commitRange: z.string().optional(),
  enqueuedAt: z.number(),
});

/** Persistence port — disk by default, in-memory in tests (keeps the queue logic pure). Mirrors MergeQueueStore. */
export interface TestQueueStore {
  load(): Promise<PersistedTestJob[]>;
  persist(jobs: PersistedTestJob[]): Promise<void>;
}

/** The detached test EXECUTOR the queue drives (DI — like the engine's `spawn` / mergeQueue's `exec`). */
export type TestRunner = (job: TestJob) => Promise<{ passed: boolean }>;

/** The durable/wired surface the channel + webhook + boot recovery depend on. Extends the kernel's
 *  fan-out with restart-survival (`recover`), an external-completion path (`reportDone`), and observability. */
export interface PersistentTestQueuePort {
  /** Fire a card's test detached + persist it to the ledger. Returns immediately (never awaited). */
  enqueue(job: TestJob): void;
  /** Subscribe to every completed job (fan-out, exactly once per job). Returns an unsubscribe fn. */
  onDone(fn: (d: TestJobDone) => void): () => void;
  /** External/webhook completion for a test that OUTLIVED the process (the durable twin): unpersist +
   * fan out, WITHOUT re-running the executor. Safe to call for an unknown job (fans out best-effort). */
  reportDone(job: TestJob, passed: boolean): void;
  /** Boot recovery: reload the ledger + re-drive every job the last process left in-flight (a restart
   * lost the kernel's in-memory map). Returns how many were re-driven. */
  recover(): Promise<{ redriven: number }>;
  /** The jobs currently in flight (persisted, not yet done) — for the ops snapshot. */
  inflight(): PersistedTestJob[];
}

/** Stable ledger key: a card has at most ONE in-flight test per generating trigger. */
function jobKey(j: TestJob): string {
  return `${j.board}/${j.cardId}/${j.trigger}`;
}

/**
 * Build the DURABLE test queue over the pure kernel + an injected executor + a store. Persists on
 * `enqueue`, unpersists on completion, and re-drives the ledger on `recover()` — so a fired test that a
 * restart interrupts is picked up on the next boot (the "fire → resume on result" durability the ADR
 * pairs with onMergeDone). Its OWN listener set fans out BOTH the in-process executor completions (via
 * the kernel's onDone) AND external `reportDone` completions (the webhook), so a subscriber wakes the
 * same way regardless of which path landed the result. PURE over `run` + `store` — unit-testable.
 */
export function makePersistentTestQueue(deps: {
  run: TestRunner;
  store: TestQueueStore;
  now?: () => number;
}): PersistentTestQueuePort {
  const now = deps.now ?? (() => Date.now());
  const kernel = makeTestQueue({ run: deps.run });
  const listeners = new Set<(d: TestJobDone) => void>();
  const ledger = new Map<string, PersistedTestJob>();
  // Serialize persistence so overlapping saves can't interleave-corrupt the ledger file (best-effort,
  // never throws out — a failed persist logs and the in-memory ledger stays authoritative for the process).
  let persisting: Promise<void> = Promise.resolve();
  const save = (): void => {
    persisting = persisting
      .then(() => deps.store.persist([...ledger.values()]))
      .catch((err) => console.error("[harness-test-queue] persist failed", err instanceof Error ? err.message : err));
  };

  const emit = (d: TestJobDone): void => {
    for (const fn of listeners) {
      try {
        fn(d);
      } catch (err) {
        // LOG-and-KEEP (mirrors the kernel + mergeQueue): a throwing subscriber stays subscribed.
        console.error("[harness-test-queue] onDone listener threw", err instanceof Error ? err.message : err);
      }
    }
  };

  // In-process executor completions flow through here: drop from the ledger, persist, fan out.
  kernel.onDone((d) => {
    ledger.delete(jobKey(d));
    save();
    emit(d);
  });

  return {
    enqueue(job: TestJob): void {
      // Persist BEFORE the run fires so a crash right after spawn still leaves a re-drivable ledger entry.
      ledger.set(jobKey(job), { ...job, enqueuedAt: now() });
      save();
      kernel.enqueue(job);
    },
    onDone(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reportDone(job: TestJob, passed: boolean): void {
      const key = jobKey(job);
      if (!ledger.has(key)) {
        // A test that outlived the process (the ledger may have been pruned, or this is a stale/foreign
        // report). Fan out anyway — the caller asserts THIS card's test is done; the cascade re-eval is
        // idempotent over the card's current state. Log so a genuinely-foreign report is visible.
        console.warn(`[harness-test-queue] reportDone para job desconhecido ${key} — propagando mesmo assim`);
      }
      ledger.delete(key);
      save();
      emit({ ...job, passed });
    },
    async recover() {
      const persisted = await deps.store.load().catch(() => [] as PersistedTestJob[]);
      let redriven = 0;
      for (const pj of persisted) {
        // Adopt the persisted entry into the ledger (idempotent) and re-drive it through the kernel. A
        // restart emptied the kernel's in-memory map, so re-enqueue (NOT kernel.recover(), which would
        // double-drive the same job — it re-runs whatever the kernel already holds) is what re-runs it.
        if (!ledger.has(jobKey(pj))) ledger.set(jobKey(pj), pj);
        kernel.enqueue({ board: pj.board, cardId: pj.cardId, trigger: pj.trigger, command: pj.command, commitRange: pj.commitRange });
        redriven += 1;
      }
      return { redriven };
    },
    inflight() {
      return [...ledger.values()];
    },
  };
}

/**
 * Disk-backed {@link TestQueueStore} (JSON ledger, versioned + per-entry safeParse on load — mirrors
 * diskMergeQueueStore). A foreign/old-schema file or a malformed entry is dropped, never fed to recovery.
 * Atomic write via tmp+rename.
 */
export function diskTestQueueStore(dir: string): TestQueueStore {
  const file = path.join(dir, "test-queue.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        if (data?.version !== TEST_QUEUE_VERSION || !Array.isArray(data.jobs)) return [];
        const valid: PersistedTestJob[] = [];
        for (const j of data.jobs) {
          const parsed = PersistedTestJobSchema.safeParse(j);
          if (parsed.success) valid.push(parsed.data);
        }
        return valid;
      } catch {
        return []; // absent / unreadable / malformed → start clean
      }
    },
    async persist(jobs) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: TEST_QUEUE_VERSION, jobs }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file);
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

/** The log file a card's detached test run streams to (re-read by ops / the console). */
export function testLogFileFor(job: TestJob, root: string = findRepoRoot()): string {
  const safe = `${job.board}-${job.cardId}`.replace(/[^a-z0-9-]/gi, "_");
  return path.join(root, ".artifacts", "logs", `harness-test-${safe}.log`);
}

/**
 * The default {@link TestRunner}: spawn the job's `command` DETACHED (a child of the storymap service —
 * a test run does NOT restart storymap, so no systemd-run/unit), stream its output to a log, and resolve
 * `{ passed: exit === 0 }`. NO command ⇒ resolve `{ passed: false }` after logging a MISCONFIG (never a
 * silent pass — a test with nothing to run is a red, so a mis-wired consumer surfaces instead of hiding).
 * The command is an internally-constructed, slug-scoped shell string (like the merge-gate's checkCommand),
 * not user input. Streams to {@link testLogFileFor} so a completed test's output is inspectable post-hoc.
 */
export const defaultTestRunner: TestRunner = (job) =>
  new Promise((resolve) => {
    if (!job.command || !job.command.trim()) {
      console.error(`[harness-test-queue] job ${jobKey(job)} sem command — nada a rodar (falha, nunca pass silencioso)`);
      resolve({ passed: false });
      return;
    }
    const logFile = testLogFileFor(job);
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {
      /* best-effort log dir */
    }
    const out = createWriteStream(logFile, { flags: "w" });
    out.write(`[harness-test ${jobKey(job)}]${job.commitRange ? ` range=${job.commitRange}` : ""} ${job.command}\n`);
    let settled = false;
    const done = (passed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ passed });
    };
    try {
      const child = spawn(job.command, { cwd: findRepoRoot(), shell: true, windowsHide: true });
      child.stdout?.on("data", (d) => out.write(d));
      child.stderr?.on("data", (d) => out.write(d));
      child.on("close", (code) => {
        out.end(`\n[harness-test ${jobKey(job)}] finished exit ${code}\n`);
        done(code === 0);
      });
      child.on("error", (e) => {
        out.end(`\n[harness-test ${jobKey(job)}] spawn error: ${e.message}\n`);
        done(false); // a spawn failure is a RED (never lose the job / never pass)
      });
    } catch (err) {
      out.end(`\n[harness-test ${jobKey(job)}] spawn threw: ${err instanceof Error ? err.message : err}\n`);
      done(false);
    }
  });

const KEY = Symbol.for("storymap.runner.testQueue");
const store = globalThis as unknown as { [KEY]?: PersistentTestQueuePort };

/** Process-global durable test queue over the real detached executor + disk store. Singleton so the
 *  channel subscription, the webhook, and boot recovery all share ONE queue (globalThis-pinned → survives
 *  Next HMR, like getMergeQueue / getProductDeploy). */
export function getTestQueue(): PersistentTestQueuePort {
  return (store[KEY] ??= makePersistentTestQueue({
    run: defaultTestRunner,
    store: diskTestQueueStore(runnerStateDir()),
  }));
}
