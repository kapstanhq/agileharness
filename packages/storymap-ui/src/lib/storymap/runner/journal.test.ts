import { describe, expect, it } from "vitest";
import { RunnerJournal, type JournalEntry, type JournalStore } from "./journal";

// In-memory store (DI) so the journal lifecycle is unit-tested without touching fs.
class MemStore implements JournalStore {
  data: JournalEntry[];
  constructor(seed: JournalEntry[] = []) {
    this.data = seed.map((e) => ({ ...e }));
  }
  async load() {
    return this.data.map((e) => ({ ...e }));
  }
  async persist(entries: JournalEntry[]) {
    this.data = entries.map((e) => ({ ...e }));
  }
}

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  board: "acme",
  cardId: "story-1",
  trigger: "harness-do",
  sessionId: "sess-1",
  pid: 1234,
  startedAt: 1000,
  status: "running",
  ...over,
});

describe("RunnerJournal — durable run lifecycle", () => {
  it("records a start as running and persists the durable fields", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "story-1", trigger: "harness-do", sessionId: "s1", pid: 42, startedAt: 1 });
    await j.flush();
    expect(store.data).toHaveLength(1);
    expect(store.data[0]).toMatchObject({ board: "acme", cardId: "story-1", status: "running", sessionId: "s1", pid: 42 });
  });

  it("flips a recorded run to done with its outcome on finish", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "story-1", trigger: "harness-do", sessionId: "s1", pid: 42, startedAt: 1 });
    await j.recordFinish("acme", "story-1", "ok", 2000);
    await j.flush();
    expect(store.data[0]).toMatchObject({ status: "done", outcome: "ok", endedAt: 2000 });
  });

  it("recordFinish is a no-op when no start was recorded (nothing to flip)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordFinish("acme", "ghost", "exit", 5);
    await j.flush();
    expect(store.data).toHaveLength(0);
  });

  it("markResumable keeps the entry RUNNING (not done) + flags resumable + outcome max-turns (story-9s52tu HALF B)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    // story-9s52tu HALF B (HIGH #2): the run was already 1 resume deep — recordStart journaled the count.
    await j.recordStart({ board: "acme", cardId: "story-1", trigger: "harness-do", sessionId: "s1", pid: 42, startedAt: 1, worktreePath: "/wt/run-s1", maxTurnsResumeCount: 1 });
    await j.markResumable("acme", "story-1", 2000);
    await j.flush();
    // STAYS running → loadInterrupted re-picks it on the next boot and recovery `--resume`s it.
    expect(store.data[0]).toMatchObject({ status: "running", resumable: true, outcome: "max-turns", endedAt: 2000 });
    expect(await j.loadInterrupted()).toHaveLength(1); // resumable runs are still "interrupted" = recoverable
    // The worktreePath recorded at start is PRESERVED so the resume runs IN it.
    expect(store.data[0].worktreePath).toBe("/wt/run-s1");
    // The monotonic resume counter SURVIVES markResumable (carried from recordStart) so the cap can't
    // reset each cycle — boot recovery reads the right depth.
    expect(store.data[0].maxTurnsResumeCount).toBe(1);
  });

  it("carries resumeFallbackCount through recordStart + back via loadInterrupted (story-harness-cc #5: the missing-session budget survives a restart)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    // A fresh re-dispatch after a missing-session fallback journaled its cumulative count (2 so far).
    await j.recordStart({ board: "acme", cardId: "story-1", trigger: "harness-do", sessionId: "s2", pid: 7, startedAt: 1, resumeFallbackCount: 2 });
    await j.flush();
    expect(store.data[0].resumeFallbackCount).toBe(2);
    // A NEW journal over the same store (the restart) recovers the count so the cap keeps biting (not reset to 0).
    const j2 = new RunnerJournal(store);
    const interrupted = await j2.loadInterrupted();
    expect(interrupted[0].resumeFallbackCount).toBe(2);
  });

  it("markResumable is a no-op when no start was recorded (nothing to flag)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.markResumable("acme", "ghost", 5);
    await j.flush();
    expect(store.data).toHaveLength(0);
  });

  it("loadInterrupted returns ONLY entries still running (the crash survivors)", async () => {
    const store = new MemStore([
      entry({ cardId: "running-1", status: "running" }),
      entry({ cardId: "done-1", status: "done", outcome: "ok", endedAt: 5 }),
    ]);
    const j = new RunnerJournal(store);
    const interrupted = await j.loadInterrupted();
    expect(interrupted.map((e) => e.cardId)).toEqual(["running-1"]);
  });

  it("a NEW journal over a store seeded with a running entry recovers it (restart scenario)", async () => {
    const store = new MemStore([entry({ cardId: "mid-run", status: "running", sessionId: "sX" })]);
    const j = new RunnerJournal(store); // simulates a fresh process reading the persisted file
    expect(await j.loadInterrupted()).toHaveLength(1);
    expect(await j.sessionFor("acme", "mid-run")).toBe("sX");
  });

  it("resolveInterrupted clears a running entry so a second boot won't reprocess it", async () => {
    const store = new MemStore([entry({ cardId: "x", status: "running" })]);
    const j = new RunnerJournal(store);
    await j.resolveInterrupted("acme", "x");
    await j.flush();
    expect(await j.loadInterrupted()).toHaveLength(0);
    expect(store.data[0].status).toBe("done");
  });

  it("sessionFor survives a restart (new journal, same store) for `claude --resume`", async () => {
    const store = new MemStore();
    const j1 = new RunnerJournal(store);
    await j1.recordStart({ board: "acme", cardId: "c", trigger: "harness-do", sessionId: "resume-me", pid: 1, startedAt: 1 });
    await j1.recordFinish("acme", "c", "ok", 2);
    await j1.flush();
    const j2 = new RunnerJournal(store); // restart over the same persisted data
    expect(await j2.sessionFor("acme", "c")).toBe("resume-me");
  });

  it("caps retained done entries so the journal file can't grow unbounded", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    for (let i = 0; i < 250; i++) {
      await j.recordStart({ board: "acme", cardId: `c${i}`, trigger: "harness-do", sessionId: `s${i}`, pid: i, startedAt: i });
      await j.recordFinish("acme", `c${i}`, "ok", i + 1);
    }
    await j.flush();
    expect(store.data.length).toBeLessThanOrEqual(200);
  });

  it("recordFinish compare-and-set: a mismatched expect never clobbers a fresher run", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "c", trigger: "harness-do", sessionId: "fresh", pid: 1, startedAt: 200 });
    // An older interrupted run tries to resolve the same card key — must NOT flip the fresh entry.
    await j.recordFinish("acme", "c", "error", 9, { sessionId: "stale", startedAt: 100 });
    await j.flush();
    expect(store.data[0]).toMatchObject({ status: "running", sessionId: "fresh" });
    // The matching identity DOES resolve it.
    await j.recordFinish("acme", "c", "ok", 10, { sessionId: "fresh", startedAt: 200 });
    await j.flush();
    expect(store.data[0]).toMatchObject({ status: "done", outcome: "ok" });
  });

  it("carries origin + osBootMs through to disk (for manual-skip + boot-session guard)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "m", trigger: "harness-do", sessionId: "s", pid: 7, startedAt: 1, origin: "manual", osBootMs: 4242 });
    await j.flush();
    expect(store.data[0]).toMatchObject({ origin: "manual", osBootMs: 4242 });
  });

  it("carries driveCount through to disk + back via loadInterrupted (re-drive depth survives a restart)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "r", trigger: "harness-do", sessionId: "s", pid: 7, startedAt: 1, origin: "conflict-redrive", driveCount: 2 });
    await j.flush();
    expect(store.data[0]).toMatchObject({ origin: "conflict-redrive", driveCount: 2 });
    // a fresh journal over the same store (a restart) loads the entry with its depth intact
    const reloaded = await new RunnerJournal(store).loadInterrupted();
    expect(reloaded[0]).toMatchObject({ origin: "conflict-redrive", driveCount: 2 });
  });

  // ── ADR-063 (4b) loop-guard durable counter ────────────────────────────────────────────────
  it("carries column + noProgressRuns through recordStart to disk (the loop-guard fields)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "q", trigger: "harness-qa", sessionId: "s", pid: 7, startedAt: 1, column: "qa-automatizado", noProgressRuns: 2 });
    await j.flush();
    expect(store.data[0]).toMatchObject({ column: "qa-automatizado", noProgressRuns: 2 });
  });

  it("recordFinish PRESERVES column + noProgressRuns (so the next fresh eval reads the last real run's count)", async () => {
    const store = new MemStore();
    const j = new RunnerJournal(store);
    await j.recordStart({ board: "acme", cardId: "q", trigger: "harness-qa", sessionId: "s", pid: 7, startedAt: 1, column: "qa-automatizado", noProgressRuns: 2 });
    await j.recordFinish("acme", "q", "no-op", 2000);
    await j.flush();
    expect(store.data[0]).toMatchObject({ status: "done", column: "qa-automatizado", noProgressRuns: 2 });
  });

  it("latest returns the current (most-recent) entry, and it SURVIVES a restart (durable loop-guard read)", async () => {
    const store = new MemStore();
    const j1 = new RunnerJournal(store);
    await j1.recordStart({ board: "acme", cardId: "q", trigger: "harness-qa", sessionId: "s", pid: 7, startedAt: 1, column: "qa-automatizado", noProgressRuns: 2 });
    await j1.recordFinish("acme", "q", "no-op", 2);
    await j1.flush();
    // A fresh journal over the same store (the restart) still reads the counter via latest — this is what
    // keeps the loop-guard from resetting to 0 on every service bounce.
    const j2 = new RunnerJournal(store);
    const latest = await j2.latest("acme", "q");
    expect(latest).toMatchObject({ column: "qa-automatizado", noProgressRuns: 2, trigger: "harness-qa" });
  });

  it("latest is undefined for a card with no entry", async () => {
    const j = new RunnerJournal(new MemStore());
    expect(await j.latest("acme", "never-ran")).toBeUndefined();
  });
});
