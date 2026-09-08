// ADR-063 item 3b tests — the kernel (fan-out + recover) AND the durable/wired layer (persist + reportDone).
import { describe, expect, it, vi } from "vitest";
import {
  diskTestQueueStore,
  makePersistentTestQueue,
  makeTestQueue,
  type PersistedTestJob,
  type TestJob,
  type TestJobDone,
  type TestQueueStore,
} from "./test-queue";

const job = (over: Partial<TestJob> = {}): TestJob => ({
  board: "storymap",
  cardId: "story-abc",
  trigger: "harness-qa",
  ...over,
});

/** Flush the microtask queue so the detached run()->onDone chain settles. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("makeTestQueue (ADR-063 3b scaffold)", () => {
  it("enqueue runs the job detached and emits onDone with {passed}", async () => {
    const run = vi.fn(async () => ({ passed: true }));
    const q = makeTestQueue({ run });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.enqueue(job());
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ board: "storymap", cardId: "story-abc", trigger: "harness-qa", passed: true });
  });

  it("carries a failing result through as {passed:false}", async () => {
    const q = makeTestQueue({ run: async () => ({ passed: false }) });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.enqueue(job({ cardId: "story-red" }));
    await flush();

    expect(seen).toEqual([{ board: "storymap", cardId: "story-red", trigger: "harness-qa", passed: false }]);
  });

  it("a rejected run() settles as {passed:false} instead of throwing", async () => {
    const q = makeTestQueue({ run: async () => { throw new Error("boom"); } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.enqueue(job());
    await flush();

    expect(seen).toEqual([{ board: "storymap", cardId: "story-abc", trigger: "harness-qa", passed: false }]);
    errSpy.mockRestore();
  });

  it("fans out to multiple subscribers, each firing exactly once per job", async () => {
    const q = makeTestQueue({ run: async () => ({ passed: true }) });
    const a: TestJobDone[] = [];
    const b: TestJobDone[] = [];
    q.onDone((d) => a.push(d));
    q.onDone((d) => b.push(d));

    q.enqueue(job());
    await flush();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("unsubscribe stops delivery to that subscriber only", async () => {
    const q = makeTestQueue({ run: async () => ({ passed: true }) });
    const a: TestJobDone[] = [];
    const b: TestJobDone[] = [];
    const off = q.onDone((d) => a.push(d));
    q.onDone((d) => b.push(d));

    off();
    q.enqueue(job());
    await flush();

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("recover() re-drives an in-flight (crashed) job and it then emits once", async () => {
    // First run() invocation HANGS (simulating a crash mid-run — the job stays in-flight and never
    // emits). recover() re-drives it; the second invocation resolves → onDone fires exactly once.
    let calls = 0;
    const run = vi.fn(
      (): Promise<{ passed: boolean }> =>
        ++calls === 1 ? new Promise<{ passed: boolean }>(() => {}) : Promise.resolve({ passed: true }),
    );
    const q = makeTestQueue({ run });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.enqueue(job());
    await flush();
    expect(seen).toHaveLength(0); // still in-flight — the first run() never resolved

    q.recover();
    await flush();

    expect(run).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([{ board: "storymap", cardId: "story-abc", trigger: "harness-qa", passed: true }]);
  });

  it("recover() is a no-op when nothing is in flight", async () => {
    const run = vi.fn(async () => ({ passed: true }));
    const q = makeTestQueue({ run });
    q.recover();
    await flush();
    expect(run).not.toHaveBeenCalled();
  });
});

// ── The durable / wired layer (Fase 3b proper) ──────────────────────────────────────────────────────

/** An in-memory TestQueueStore that records every persist so a test can assert the ledger contents. */
function memStore(seed: PersistedTestJob[] = []): TestQueueStore & { last: () => PersistedTestJob[] } {
  let jobs = [...seed];
  return {
    async load() {
      return [...jobs];
    },
    async persist(next) {
      jobs = [...next];
    },
    last: () => [...jobs],
  };
}

describe("makePersistentTestQueue (ADR-063 3b — durable + wired)", () => {
  it("enqueue persists the job, runs it, fans out onDone, and UNpersists on completion", async () => {
    const store = memStore();
    const run = vi.fn(async () => ({ passed: true }));
    const q = makePersistentTestQueue({ run, store, now: () => 111 });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.enqueue(job());
    // Persisted synchronously at enqueue (before the run resolves) → survives a crash right after spawn.
    expect(q.inflight()).toEqual([{ board: "storymap", cardId: "story-abc", trigger: "harness-qa", enqueuedAt: 111 }]);

    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ board: "storymap", cardId: "story-abc", trigger: "harness-qa", passed: true }]);
    expect(q.inflight()).toEqual([]); // unpersisted after completion
    await flush();
    expect(store.last()).toEqual([]); // the on-disk ledger is also cleared
  });

  it("reportDone (the webhook path) fans out + unpersists WITHOUT re-running the executor", async () => {
    const store = memStore();
    const run = vi.fn(() => new Promise<{ passed: boolean }>(() => {})); // HANGS — models a test that outlived the process
    const q = makePersistentTestQueue({ run, store, now: () => 222 });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.enqueue(job({ cardId: "story-ext" }));
    await flush();
    expect(q.inflight()).toHaveLength(1); // still in-flight (executor hung)

    q.reportDone(job({ cardId: "story-ext" }), false);
    await flush();
    expect(seen).toEqual([{ board: "storymap", cardId: "story-ext", trigger: "harness-qa", passed: false }]);
    expect(q.inflight()).toEqual([]); // the external report cleared it
    expect(run).toHaveBeenCalledTimes(1); // reportDone did NOT re-run the executor
  });

  it("reportDone for an UNKNOWN job still fans out (best-effort, idempotent cascade)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = makePersistentTestQueue({ run: async () => ({ passed: true }), store: memStore(), now: () => 1 });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    q.reportDone(job({ cardId: "never-enqueued" }), true);
    await flush();
    expect(seen).toEqual([{ board: "storymap", cardId: "never-enqueued", trigger: "harness-qa", passed: true }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("recover() reloads the persisted ledger and re-drives every job (restart survival)", async () => {
    // A restart lost the kernel's in-memory map; the disk store still carries the fired jobs.
    const seeded: PersistedTestJob = { board: "acme", cardId: "story-crash", trigger: "harness-qa", command: "vitest run x", enqueuedAt: 5 };
    const store = memStore([seeded]);
    const run = vi.fn(async (j: TestJob) => ({ passed: j.cardId === "story-crash" }));
    const q = makePersistentTestQueue({ run, store, now: () => 9 });
    const seen: TestJobDone[] = [];
    q.onDone((d) => seen.push(d));

    const { redriven } = await q.recover();
    expect(redriven).toBe(1);
    await flush();
    // The re-driven job carried its persisted command + re-ran to completion, fanning out EXACTLY once.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cardId: "story-crash", command: "vitest run x" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ board: "acme", cardId: "story-crash", trigger: "harness-qa", passed: true });
    expect(q.inflight()).toEqual([]);
  });

  it("recover() is a no-op with an empty ledger", async () => {
    const run = vi.fn(async () => ({ passed: true }));
    const q = makePersistentTestQueue({ run, store: memStore(), now: () => 1 });
    expect(await q.recover()).toEqual({ redriven: 0 });
    await flush();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("diskTestQueueStore — versioned JSON ledger with per-entry safeParse", () => {
  it("round-trips valid jobs and drops malformed / wrong-version data", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-tq-"));
    try {
      const store = diskTestQueueStore(dir);
      expect(await store.load()).toEqual([]); // absent file → clean

      const jobs: PersistedTestJob[] = [{ board: "storymap", cardId: "story-1", trigger: "harness-qa", enqueuedAt: 42 }];
      await store.persist(jobs);
      expect(await store.load()).toEqual(jobs);

      // Wrong version → dropped whole.
      await fs.writeFile(path.join(dir, "test-queue.json"), JSON.stringify({ version: 999, jobs }), "utf8");
      expect(await store.load()).toEqual([]);

      // Right version, one good + one malformed entry → only the good one survives.
      await fs.writeFile(
        path.join(dir, "test-queue.json"),
        JSON.stringify({ version: 1, jobs: [jobs[0], { board: "x" /* missing fields */ }] }),
        "utf8",
      );
      expect(await store.load()).toEqual(jobs);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
