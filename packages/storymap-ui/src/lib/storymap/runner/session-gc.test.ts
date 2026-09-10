import { describe, expect, it, vi } from "vitest";
import { SESSION_HEARTBEAT_TTL_MS } from "./session-liveness";
import {
  SESSION_GC_GRACE_MS,
  runSessionGc,
  selectSessionsToForget,
  sessionGcGraceMs,
  type GcSession,
  type GcTrainEntry,
} from "./session-gc";
import type { DiscardSessionResult } from "./session-worktree";

const NOW = Date.parse("2026-07-23T18:00:00.000Z");
/** A heartbeat `hoursAgo` hours before NOW. */
const beat = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function pick(sessions: GcSession[], entries: GcTrainEntry[] = [], liveTmux: string[] = []) {
  return selectSessionsToForget({ sessions, entries, liveTmux: new Set(liveTmux) }, NOW).map((s) => s.sessionId);
}

describe("sessionGcGraceMs — env knob", () => {
  it("defaults when unset / empty / garbage / non-positive (never off)", () => {
    expect(sessionGcGraceMs({})).toBe(SESSION_GC_GRACE_MS);
    expect(sessionGcGraceMs({ AGILEHARNESS_SESSION_GC_GRACE_MS: "" })).toBe(SESSION_GC_GRACE_MS);
    expect(sessionGcGraceMs({ AGILEHARNESS_SESSION_GC_GRACE_MS: "abc" })).toBe(SESSION_GC_GRACE_MS);
    expect(sessionGcGraceMs({ AGILEHARNESS_SESSION_GC_GRACE_MS: "0" })).toBe(SESSION_GC_GRACE_MS);
    expect(sessionGcGraceMs({ AGILEHARNESS_SESSION_GC_GRACE_MS: "-1" })).toBe(SESSION_GC_GRACE_MS);
  });
  it("parses a positive integer (ms)", () => {
    expect(sessionGcGraceMs({ AGILEHARNESS_SESSION_GC_GRACE_MS: "3600000" })).toBe(3_600_000);
  });
  it("is 2× the liveness TTL by default", () => {
    expect(SESSION_GC_GRACE_MS).toBe(2 * SESSION_HEARTBEAT_TTL_MS);
  });
});

describe("selectSessionsToForget — the three safety guards", () => {
  it("forgets a long-dead ADOPTED session (the zombie the fleet accumulated)", () => {
    expect(pick([{ sessionId: "z", heartbeatAt: beat(140), adopted: true }])).toEqual(["z"]);
  });

  it("guard 1: keeps a session still inside the heartbeat TTL", () => {
    expect(pick([{ sessionId: "live", heartbeatAt: beat(1), adopted: true }])).toEqual([]);
  });

  it("guard 1: keeps a session with an unparseable heartbeat (fail-closed to alive)", () => {
    expect(pick([{ sessionId: "corrupt", heartbeatAt: "not-a-date", adopted: true }])).toEqual([]);
  });

  it("guard 2a: a live hosting tmux vetoes the forget even past grace", () => {
    const s: GcSession = { sessionId: "hosted", heartbeatAt: beat(100), adopted: true, tmuxSession: "agent-hosted" };
    expect(pick([s], [], ["agent-hosted"])).toEqual([]); // tmux alive → kept
    expect(pick([s], [], [])).toEqual(["hosted"]); // tmux gone → forgotten
  });

  it("guard 2b: dead past the TTL but WITHIN grace is kept (only forgotten once past grace)", () => {
    // TTL is 6h, grace is 12h → a session dead 8h is dead-but-in-grace.
    expect(pick([{ sessionId: "recent", heartbeatAt: beat(8), adopted: true }])).toEqual([]);
    expect(pick([{ sessionId: "old", heartbeatAt: beat(13), adopted: true }])).toEqual(["old"]);
  });

  it("guard 3a: keeps a dead session whose train entry is an ORPHANED integration (a demand)", () => {
    const s: GcSession = { sessionId: "orphan", heartbeatAt: beat(100), adopted: false, branch: "agent/orphan" };
    for (const status of ["returned-to-session", "gate-failed", "conflict", "failed"] as const) {
      expect(pick([s], [{ runId: "orphan", status }])).toEqual([]);
    }
  });

  it("guard 3b: forgets an isolated dead session once its work is train-DONE (integrated)", () => {
    const s: GcSession = { sessionId: "done", heartbeatAt: beat(100), adopted: false, branch: "agent/done" };
    expect(pick([s], [{ runId: "done", status: "done" }])).toEqual(["done"]);
  });

  it("guard 3b: KEEPS an isolated dead session that still holds a branch with no resolved train entry", () => {
    // Possibly un-integrated code → branch-gc's call by CONTENT, never this GC's to drop.
    expect(pick([{ sessionId: "risky", heartbeatAt: beat(100), adopted: false, branch: "agent/risky" }])).toEqual([]);
  });

  it("guard 3b: forgets a BRANCHLESS dead isolated session (never opened a tree)", () => {
    expect(pick([{ sessionId: "branchless", heartbeatAt: beat(100), adopted: false }])).toEqual(["branchless"]);
  });

  it("reports the reason + how long it was dead", () => {
    const [r] = selectSessionsToForget(
      { sessions: [{ sessionId: "z", heartbeatAt: beat(24), adopted: true }], entries: [], liveTmux: new Set() },
      NOW,
    );
    expect(r).toMatchObject({ sessionId: "z", reason: "adopted-dead" });
    expect(r.deadForMs).toBeCloseTo(24 * 3_600_000, -3);
  });

  it("matches the production mix: 8 dead adopted + 1 done-isolated forgotten, live + orphan kept", () => {
    const forgotten = pick(
      [
        { sessionId: "a1", heartbeatAt: beat(142), adopted: true },
        { sessionId: "a2", heartbeatAt: beat(137), adopted: true },
        { sessionId: "a3", heartbeatAt: beat(76), adopted: true },
        { sessionId: "done1", heartbeatAt: beat(44), adopted: false, branch: "agent/done1" },
        { sessionId: "live1", heartbeatAt: beat(0.1), adopted: false, branch: "agent/live1" },
        { sessionId: "orphan1", heartbeatAt: beat(90), adopted: false, branch: "agent/orphan1" },
      ],
      [
        { runId: "done1", status: "done" },
        { runId: "orphan1", status: "returned-to-session" },
      ],
    );
    expect(forgotten.sort()).toEqual(["a1", "a2", "a3", "done1"]);
  });
});

describe("runSessionGc — IO wrapper", () => {
  const okDiscard = (detail: string): DiscardSessionResult => ({ ok: true, branchPreserved: false, detail });

  it("deregisters each chosen session and journals the outcome", async () => {
    const discard = vi.fn(async () => okDiscard("desregistrada"));
    const journal = vi.fn();
    const out = await runSessionGc({
      listSessions: async () =>
        [
          { sessionId: "z", heartbeatAt: beat(100), adopted: true, task: "t", openedAt: beat(200), role: "implement" },
          { sessionId: "live", heartbeatAt: beat(0.1), adopted: true, task: "t", openedAt: beat(1), role: "implement" },
        ] as never,
      trainEntries: async () => [],
      liveTmux: async () => [],
      discard,
      journal,
      now: () => NOW,
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith("z");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: "z", reason: "adopted-dead", forgotten: true });
    expect(journal).toHaveBeenCalledTimes(1);
  });

  it("never throws when a registry read fails — it degrades to no candidates", async () => {
    const out = await runSessionGc({
      listSessions: async () => {
        throw new Error("registry unreadable");
      },
      trainEntries: async () => [],
      liveTmux: async () => [],
      discard: async () => okDiscard("x"),
      now: () => NOW,
    });
    expect(out).toEqual([]);
  });

  it("records forgotten:false (never throws) when a discard fails", async () => {
    const out = await runSessionGc({
      listSessions: async () =>
        [{ sessionId: "z", heartbeatAt: beat(100), adopted: true, task: "t", openedAt: beat(200), role: "implement" }] as never,
      trainEntries: async () => [],
      liveTmux: async () => [],
      discard: async () => ({ ok: false, reason: "teardown falhou" }),
      now: () => NOW,
    });
    expect(out[0]).toMatchObject({ sessionId: "z", forgotten: false, detail: "teardown falhou" });
  });
});
