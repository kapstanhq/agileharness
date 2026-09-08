import { describe, expect, it } from "vitest";
import {
  decideRecovery,
  findResumable,
  makeReconcileWorktrees,
  parseRunWorktrees,
  recoverInterruptedRuns,
  recoverMergeQueue,
  sameBootSession,
  type RecoveryDeps,
} from "./recovery";
import { AUTORUN_DEDUPE_MS, type RunAttempt } from "./engine";
import type { JournalEntry } from "./journal";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// Minimal board: a trigger column (desenvolver→harness-do) and a manual one (revisar-codigo).
const cfg = (): BoardConfig =>
  ({
    id: "acme",
    name: "Nest",
    statuses: [
      { id: "enriquecer", name: "Enriquecer", autorun: true, trigger: "harness-enrich" },
      { id: "desenvolver", name: "Desenvolver", autorun: true, trigger: "harness-do" },
      { id: "revisar-codigo", name: "Revisar", autorun: false },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  }) as unknown as BoardConfig;

const card = (over: Partial<Card> = {}): Card =>
  ({ id: "story-1", type: "story", title: "T", status: "desenvolver", parent: null, release: null, ...over }) as Card;

const interruptedEntry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  board: "acme",
  cardId: "story-1",
  trigger: "harness-do",
  sessionId: "s1",
  pid: 999,
  startedAt: 1,
  status: "running",
  ...over,
});

describe("decideRecovery — what to do with one interrupted run", () => {
  it("respawns when the card still sits in the SAME trigger column", () => {
    expect(decideRecovery(interruptedEntry(), card({ status: "desenvolver" }), cfg())).toEqual({
      action: "respawn",
      trigger: "harness-do",
    });
  });

  it("drops when the card was removed (deleted/renamed away)", () => {
    expect(decideRecovery(interruptedEntry(), undefined, cfg())).toEqual({
      action: "drop",
      reason: "card-removed",
    });
  });

  it("drops when the card advanced to a manual column (the run effectively completed)", () => {
    expect(decideRecovery(interruptedEntry(), card({ status: "revisar-codigo" }), cfg()).action).toBe("drop");
  });

  it("drops when the card now wants a DIFFERENT trigger than the interrupted one", () => {
    // interrupted run was harness-do, but the card moved back to enriquecer (harness-enrich)
    expect(decideRecovery(interruptedEntry(), card({ status: "enriquecer" }), cfg()).action).toBe("drop");
  });

  it("drops a MANUAL one-shot even if its card still sits in the trigger column", () => {
    // a "Rodar agora" on an autorun column is journaled origin:manual → never auto-re-fired
    expect(decideRecovery(interruptedEntry({ origin: "manual" }), card({ status: "desenvolver" }), cfg())).toEqual({
      action: "drop",
      reason: "manual-oneshot",
    });
  });
});

describe("sameBootSession — orphan-kill boot-session guard", () => {
  it("true only within tolerance of the same boot; refuses unknown / a reboot", () => {
    expect(sameBootSession(1000, 1000)).toBe(true);
    expect(sameBootSession(1000, 3000)).toBe(true); // within the 5s tolerance
    expect(sameBootSession(1000, 9000)).toBe(false); // >5s apart → a different boot session
    expect(sameBootSession(undefined, 1000)).toBe(false); // unknown boot → never kill
  });
});

function build(opts: {
  interrupted: JournalEntry[];
  cards?: Card[];
  config?: BoardConfig | null;
  enabled?: boolean;
  runSkillResult?: RunAttempt;
  // story-watchdog: does the original run's worktree still exist on disk? Default true (the resume
  // reuses it); a test passes false to drive the AC4 missing-worktree → fail path.
  worktreeExists?: boolean;
  // un-strand: is the orphan SCOPE still active after stopScope? Default false (it died → resume
  // proceeds); true drives the D-state DEFER path (resume held, marker kept 'running').
  scopeActive?: boolean;
}) {
  const runs: Array<{
    board: string;
    cardId: string;
    trigger: string;
    opts: {
      dedupeWindowMs: number;
      resumeSessionId?: string;
      existingWorktreePath?: string;
      origin?: "autorun" | "manual" | "conflict-redrive";
      driveCount?: number;
      maxTurnsResumeCount?: number;
      resumeFallbackCount?: number;
    };
  }> = [];
  const resolved: string[] = [];
  const killed: Array<number | null> = [];
  const cleaned: Array<{ worktreePath: string; branch: string }> = [];
  const reconciled: Array<Set<string>> = [];
  const checkedWorktrees: string[] = [];
  const stoppedScopes: string[] = [];
  const deps: RecoveryDeps = {
    enabled: opts.enabled ?? true,
    journal: {
      loadInterrupted: async () => opts.interrupted,
      resolveInterrupted: async (b, c) => {
        resolved.push(`${b}/${c}`);
      },
    },
    readBoardConfig: async () => (opts.config === undefined ? cfg() : opts.config),
    readCards: async () => opts.cards ?? [],
    runSkill: (board, cardId, trigger, _def, o) => {
      runs.push({ board, cardId, trigger, opts: o });
      return opts.runSkillResult ?? { ok: true };
    },
    killOrphan: (pid) => killed.push(pid),
    cleanupWorktree: async (worktreePath, branch) => {
      cleaned.push({ worktreePath, branch });
    },
    checkWorktreeExists: async (worktreePath) => {
      checkedWorktrees.push(worktreePath);
      return opts.worktreeExists ?? true;
    },
    reconcileWorktrees: async (keep) => {
      reconciled.push(keep);
      return 0;
    },
    stopScope: async (unit) => {
      stoppedScopes.push(unit);
    },
    isScopeActive: async () => opts.scopeActive ?? false,
  };
  return { deps, runs, resolved, killed, cleaned, reconciled, checkedWorktrees, stoppedScopes };
}

describe("recoverInterruptedRuns — boot-time crash recovery", () => {
  it("no interrupted runs → a clean no-op summary", async () => {
    const { deps, runs } = build({ interrupted: [] });
    expect(await recoverInterruptedRuns(deps)).toEqual({
      interrupted: 0,
      respawned: 0,
      dropped: 0,
      skipped: 0,
      deferred: 0,
    });
    expect(runs).toHaveLength(0);
  });

  it("un-strand: STOPS the orphan scope (rederived from sessionId) BEFORE resuming its session", async () => {
    const { deps, runs, stoppedScopes } = build({
      interrupted: [interruptedEntry({ sessionId: "s1" })],
      cards: [card({ status: "desenvolver" })],
    });
    await recoverInterruptedRuns(deps);
    // the named scope was stopped (the orphan cgroup that survived the restart) …
    expect(stoppedScopes).toContain("harness-run-s1.scope");
    // … and only THEN was the session resumed (no live orphan contending for it).
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.resumeSessionId).toBe("s1");
  });

  it("un-strand: prefers the persisted `unit` verbatim over rederiving it", async () => {
    const { deps, stoppedScopes } = build({
      interrupted: [interruptedEntry({ sessionId: "s1", unit: "harness-run-s1.scope" })],
      cards: [card({ status: "desenvolver" })],
    });
    await recoverInterruptedRuns(deps);
    expect(stoppedScopes).toContain("harness-run-s1.scope");
  });

  it("un-strand fail-safe: a scope still ALIVE after stop DEFERS the resume + KEEPS the marker 'running'", async () => {
    const { deps, runs, resolved } = build({
      interrupted: [interruptedEntry({ sessionId: "s1" })],
      cards: [card({ status: "desenvolver" })],
      scopeActive: true, // a wedged/D-state claude that survived even SIGKILL
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(summary.deferred).toBe(1);
    expect(runs).toHaveLength(0); // NO 2nd claude spawned into the session the orphan still owns
    expect(resolved).toHaveLength(0); // entry LEFT 'running' (not clobbered) → next boot retries
  });

  it("respawns a card still in its trigger column, with the autorun dedupe window", async () => {
    const { deps, runs, resolved, killed } = build({
      interrupted: [interruptedEntry({ pid: 555 })],
      cards: [card({ status: "desenvolver" })],
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(summary).toMatchObject({ interrupted: 1, respawned: 1, dropped: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ board: "acme", cardId: "story-1", trigger: "harness-do" });
    expect(runs[0].opts.dedupeWindowMs).toBe(AUTORUN_DEDUPE_MS);
    // story-watchdog AC1: the respawn RESUMES the crashed session (preserves its context) rather than
    // starting a fresh `-p` run — so it carries the entry's sessionId as resumeSessionId.
    expect(runs[0].opts.resumeSessionId).toBe("s1");
    expect(killed).toContain(555); // orphan killed before the respawn
    expect(resolved).toHaveLength(0); // respawn overwrote the entry — no manual resolve
  });

  it("drops + resolves a card that advanced past its trigger (no respawn)", async () => {
    const { deps, runs, resolved, killed } = build({
      interrupted: [interruptedEntry()],
      cards: [card({ status: "revisar-codigo" })],
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(summary).toMatchObject({ interrupted: 1, respawned: 0, dropped: 1 });
    expect(runs).toHaveLength(0);
    expect(resolved).toEqual(["acme/story-1"]);
    expect(killed).toContain(999); // orphan still killed even when we drop
  });

  it("when the respawn is REJECTED (rate-limited), it resolves the entry so it can't loop", async () => {
    const { deps, runs, resolved } = build({
      interrupted: [interruptedEntry()],
      cards: [card({ status: "desenvolver" })],
      runSkillResult: { ok: false, reason: "rate-limited", detail: "cap" },
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1); // it tried
    expect(summary).toMatchObject({ respawned: 0, dropped: 1 });
    expect(resolved).toEqual(["acme/story-1"]);
  });

  it("a resumed conflict-redrive re-enters at its persisted driveCount + origin (restart doesn't reset the re-drive cap)", async () => {
    const { deps, runs } = build({
      interrupted: [interruptedEntry({ origin: "conflict-redrive", driveCount: 2 })],
      cards: [card({ status: "desenvolver" })],
    });
    await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1);
    // Without the fix these were undefined/"autorun" → the merge train read driveCount 0 and could
    // re-drive maxRedrives MORE times past the cap each crash cycle.
    expect(runs[0].opts.origin).toBe("conflict-redrive");
    expect(runs[0].opts.driveCount).toBe(2);
  });

  it("with resume-on-boot OFF, it resolves the entries but never respawns", async () => {
    const { deps, runs, resolved } = build({
      interrupted: [interruptedEntry()],
      cards: [card({ status: "desenvolver" })],
      enabled: false,
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(summary).toMatchObject({ interrupted: 1, respawned: 0, dropped: 0, skipped: 1 });
    expect(runs).toHaveLength(0);
    expect(resolved).toEqual(["acme/story-1"]);
  });
});

describe("recoverInterruptedRuns — orphaned worktree cleanup (R1)", () => {
  it("REUSES the existing worktree on respawn (resume into it) — does NOT reap it (story-watchdog t4)", async () => {
    const { deps, runs, cleaned, checkedWorktrees } = build({
      interrupted: [interruptedEntry({ worktreePath: "/repo/.worktrees/run-s1", sessionId: "s1" })],
      cards: [card({ status: "desenvolver" })],
      worktreeExists: true,
    });
    await recoverInterruptedRuns(deps);
    expect(checkedWorktrees).toEqual(["/repo/.worktrees/run-s1"]); // pre-condition checked
    expect(cleaned).toHaveLength(0); // tree survives — the resume runs IN it
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.resumeSessionId).toBe("s1");
    expect(runs[0].opts.existingWorktreePath).toBe("/repo/.worktrees/run-s1"); // passed through to the engine
  });

  it("reaps an orphaned worktree even when the run is dropped (card advanced)", async () => {
    const { deps, runs, cleaned, resolved } = build({
      interrupted: [interruptedEntry({ worktreePath: "/repo/.worktrees/run-s2", sessionId: "s2" })],
      cards: [card({ status: "revisar-codigo" })], // advanced → drop
    });
    await recoverInterruptedRuns(deps);
    expect(cleaned).toEqual([{ worktreePath: "/repo/.worktrees/run-s2", branch: "run/s2" }]);
    expect(runs).toHaveLength(0);
    expect(resolved).toEqual(["acme/story-1"]);
  });

  it("reaps an orphaned worktree even with resume-on-boot OFF (no leak when disabled)", async () => {
    const { deps, runs, cleaned, resolved } = build({
      interrupted: [interruptedEntry({ worktreePath: "/repo/.worktrees/run-s3", sessionId: "s3" })],
      cards: [card({ status: "desenvolver" })],
      enabled: false,
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(summary).toMatchObject({ skipped: 1, respawned: 0 });
    expect(cleaned).toEqual([{ worktreePath: "/repo/.worktrees/run-s3", branch: "run/s3" }]);
    expect(runs).toHaveLength(0);
    expect(resolved).toEqual(["acme/story-1"]);
  });

  it("un-strand: STOPS the orphan scope on the resume-DISABLED path too (no live-claude leak)", async () => {
    const { deps, stoppedScopes } = build({
      interrupted: [interruptedEntry({ sessionId: "s3" })],
      cards: [card({ status: "desenvolver" })],
      enabled: false, // resume off → still must kill the surviving scope, not just the worktree
    });
    await recoverInterruptedRuns(deps);
    expect(stoppedScopes).toContain("harness-run-s3.scope");
  });

  it("skips worktree cleanup for a legacy entry with no worktreePath", async () => {
    const { deps, cleaned, runs, checkedWorktrees } = build({
      interrupted: [interruptedEntry()], // no worktreePath (pre-R1 run)
      cards: [card({ status: "desenvolver" })],
    });
    await recoverInterruptedRuns(deps);
    expect(cleaned).toHaveLength(0);
    expect(checkedWorktrees).toHaveLength(0); // no tree to validate → no pre-condition check
    // It still resumes the session, just without an existing worktree (engine runs in repo root).
    expect(runs[0].opts.resumeSessionId).toBe("s1");
    expect(runs[0].opts.existingWorktreePath).toBeUndefined();
  });

  it("resumes a board-data (isCode:false) run that died WITHOUT assuming a worktree that never existed (story-apz8sa AC5)", async () => {
    // A pre-dev run (harness-enrich) edits storymap/boards/** live on main → it NEVER creates a worktree, so
    // its journal entry carries NO worktreePath. Recovery must be isCode-AWARE here: it must not check
    // for / reap a phantom worktree, and it must resume in the repo root (existingWorktreePath undefined),
    // mirroring the original board-data run. This is what guarantees a pre-dev death doesn't assume a tree.
    const { deps, runs, cleaned, checkedWorktrees } = build({
      // The interrupted run was harness-enrich; the card still sits in `enriquecer` (its trigger column) so
      // decideRecovery respawns it. NO worktreePath — board-data runs never journal one.
      interrupted: [interruptedEntry({ trigger: "harness-enrich", sessionId: "se1" })],
      cards: [card({ status: "enriquecer" })],
    });
    await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("harness-enrich");
    expect(runs[0].opts.resumeSessionId).toBe("se1");
    // The phantom-worktree assumption is exactly what AC5 forbids: NO existence check, NO cleanup, and
    // the resume degrades to the repo root.
    expect(checkedWorktrees).toHaveLength(0);
    expect(cleaned).toHaveLength(0);
    expect(runs[0].opts.existingWorktreePath).toBeUndefined();
  });
});

describe("recoverInterruptedRuns — resume pre-conditions (story-watchdog AC4: fail without a loop)", () => {
  it("marks a run FAILED (no resume) when its worktree is gone — and never spawns (AC4)", async () => {
    const { deps, runs, resolved, cleaned, checkedWorktrees } = build({
      interrupted: [interruptedEntry({ worktreePath: "/repo/.worktrees/run-s1", sessionId: "s1" })],
      cards: [card({ status: "desenvolver" })], // would otherwise respawn
      worktreeExists: false, // the tree was removed / branch reaped → no checkpoint to resume
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(checkedWorktrees).toEqual(["/repo/.worktrees/run-s1"]); // pre-condition was checked
    expect(runs).toHaveLength(0); // NEVER re-enqueued (no resume into a missing tree)
    expect(resolved).toEqual(["acme/story-1"]); // journaled failed (CAS) so a 2nd boot won't retry → no loop
    expect(summary).toMatchObject({ interrupted: 1, respawned: 0, dropped: 1 });
    // No tree to reap (it's already gone); cleanup is best-effort and not required here.
    expect(cleaned).toHaveLength(0);
  });

  it("when the resume is REJECTED (rate-limited), it reaps the reused tree + resolves so it can't loop", async () => {
    const { deps, runs, resolved, cleaned } = build({
      interrupted: [interruptedEntry({ worktreePath: "/repo/.worktrees/run-s1", sessionId: "s1" })],
      cards: [card({ status: "desenvolver" })],
      worktreeExists: true,
      runSkillResult: { ok: false, reason: "rate-limited", detail: "cap" },
    });
    const summary = await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1); // it tried to resume
    expect(resolved).toEqual(["acme/story-1"]); // cleared so it can't loop next boot
    // The tree we were going to reuse must be reaped (the resume never launched → it would leak).
    expect(cleaned).toEqual([{ worktreePath: "/repo/.worktrees/run-s1", branch: "run/s1" }]);
    expect(summary).toMatchObject({ respawned: 0, dropped: 1 });
  });

  it("AC3 idempotência: a run that FINISHED before the crash is never in loadInterrupted → never resumed", async () => {
    // loadInterrupted only returns status:"running" entries; a clean finish flipped the entry to
    // "done", so it never reaches recovery. Model that by feeding an EMPTY interrupted set.
    const { deps, runs, resolved } = build({ interrupted: [], cards: [card({ status: "desenvolver" })] });
    const summary = await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(0); // nothing to resume
    expect(resolved).toHaveLength(0);
    expect(summary).toMatchObject({ interrupted: 0, respawned: 0, dropped: 0 });
  });
});

describe("recoverInterruptedRuns — worktree reconciliation on boot (f4)", () => {
  it("reconciles real worktrees, keeping the interrupted runs' session ids", async () => {
    const { deps, reconciled } = build({
      interrupted: [interruptedEntry({ sessionId: "s-live" })],
      cards: [card({ status: "desenvolver" })],
    });
    await recoverInterruptedRuns(deps);
    expect(reconciled).toHaveLength(1);
    expect([...reconciled[0]]).toEqual(["s-live"]); // its session id is protected from pruning
  });

  it("runs reconciliation even with NO interrupted runs (catches a journal-less orphan)", async () => {
    const { deps, reconciled } = build({ interrupted: [] });
    await recoverInterruptedRuns(deps);
    expect(reconciled).toHaveLength(1);
    expect([...reconciled[0]]).toEqual([]); // nothing to keep → everything on disk is an orphan
  });

  it("story-9s52tu HALF B: a RESUMABLE (max-turns) run's tree is in the keep set AND it is resumed via --resume", async () => {
    // A max-turns run stays "running" + resumable with its preserved worktree on disk. The reconciler
    // must keep its tree (so the resume can run IN it), and recovery resumes it like a crashed run.
    const { deps, reconciled, runs } = build({
      interrupted: [interruptedEntry({ sessionId: "s-maxturns", resumable: true, outcome: "max-turns", worktreePath: "/wt/run-s-maxturns" })],
      cards: [card({ status: "desenvolver" })], // still in the trigger column → respawn
      worktreeExists: true,
    });
    await recoverInterruptedRuns(deps);
    // KEEP SET: the resumable run's session id is protected from pruning.
    expect([...reconciled[0]]).toContain("s-maxturns");
    // RESUMED: --resume into the PRESERVED worktree, same session (mirrors story-1mxmqy / watchdog).
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.resumeSessionId).toBe("s-maxturns");
    expect(runs[0].opts.existingWorktreePath).toBe("/wt/run-s-maxturns");
  });

  it("story-9s52tu HALF B (HIGH #2): a boot-recovered max-turns resume re-enters at maxTurnsResumeCount + 1 (the cap survives the restart)", async () => {
    // The entry already burned 1 in-process resume before the restart. Recovery must complete the resume
    // the in-process path couldn't (the `resumable` flag = "a resume was owed"), bumping the monotonic
    // count to 2 so a chronically-stuck card still escalates at the cap (it doesn't reset to 0 per boot).
    const { deps, runs } = build({
      interrupted: [
        interruptedEntry({ sessionId: "s-mt", resumable: true, outcome: "max-turns", worktreePath: "/wt/s-mt", maxTurnsResumeCount: 1 }),
      ],
      cards: [card({ status: "desenvolver" })],
      worktreeExists: true,
    });
    await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.maxTurnsResumeCount).toBe(2); // 1 (persisted) + 1 (this resume) — NOT reset to 0
  });

  it("story-9s52tu HALF B: a PLAIN crash resume (not max-turns-resumable) does NOT bump maxTurnsResumeCount", async () => {
    // A crash-interrupted run that never hit max-turns carries its count through UNCHANGED (it isn't a
    // max-turns resume cycle — only a `resumable` max-turns entry advances the counter).
    const { deps, runs } = build({
      interrupted: [interruptedEntry({ sessionId: "s-crash", worktreePath: "/wt/s-crash", maxTurnsResumeCount: 1 })],
      cards: [card({ status: "desenvolver" })],
      worktreeExists: true,
    });
    await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.maxTurnsResumeCount).toBe(1); // unchanged — a crash resume is not a max-turns cycle
  });

  it("story-harness-cc #5: a boot-recovered run re-injects the journaled resumeFallbackCount UNCHANGED (the missing-session budget survives the restart)", async () => {
    // The entry already burned 2 missing-session fallbacks before the restart. Recovery must carry the
    // journaled count into the respawn so the per-card budget keeps biting — without this it would reset to
    // 0 every boot (the in-process Map is wiped) and a session store that keeps losing sessions could churn.
    const { deps, runs } = build({
      interrupted: [interruptedEntry({ sessionId: "s-rf", worktreePath: "/wt/s-rf", resumeFallbackCount: 2 })],
      cards: [card({ status: "desenvolver" })],
      worktreeExists: true,
    });
    await recoverInterruptedRuns(deps);
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.resumeFallbackCount).toBe(2); // carried through, NOT reset to 0 by the restart
  });
});

describe("findResumable — classify the resumable (max-turns) journal entries (story-9s52tu HALF B)", () => {
  it("returns ONLY the entries flagged resumable", () => {
    const entries: JournalEntry[] = [
      interruptedEntry({ sessionId: "a", resumable: true, outcome: "max-turns" }),
      interruptedEntry({ sessionId: "b" }), // a plain interrupted run (crash) — not resumable-by-max-turns
      interruptedEntry({ sessionId: "c", resumable: false }),
    ];
    expect(findResumable(entries).map((e) => e.sessionId)).toEqual(["a"]);
  });

  it("returns [] when nothing is resumable", () => {
    expect(findResumable([interruptedEntry({ sessionId: "x" })])).toEqual([]);
  });
});

describe("reconcileWorktrees — prune run/* worktrees with no live journal entry (f4)", () => {
  it("parses `git worktree list --porcelain` into the run/* + agent/* entries only", () => {
    const out = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/run-s1",
      "HEAD def",
      "branch refs/heads/run/s1",
      "",
      // WS-1: a session's tree. Parsed too, but tagged `session` — the reconciler gives it the OPPOSITE
      // default (never pruned without positive proof of death), so the tag is what keeps them apart.
      "worktree /repo/.worktrees/agent-a1",
      "HEAD 999",
      "branch refs/heads/agent/a1",
      "",
    ].join("\n");
    expect(parseRunWorktrees(out)).toEqual([
      { worktreePath: "/repo/.worktrees/run-s1", sessionId: "s1", branch: "run/s1", origin: "run" },
      { worktreePath: "/repo/.worktrees/agent-a1", sessionId: "a1", branch: "agent/a1", origin: "session" },
    ]);
  });

  it("prunes an orphan run/* tree (sessionId not in keep) and KEEPS a live one", async () => {
    const removed: Array<{ worktreePath: string; branch: string }> = [];
    const reconcile = makeReconcileWorktrees({
      listWorktrees: async () =>
        [
          "worktree /repo/.worktrees/run-live",
          "branch refs/heads/run/live",
          "",
          "worktree /repo/.worktrees/run-orphan",
          "branch refs/heads/run/orphan",
          "",
        ].join("\n"),
      removeWorktree: async (worktreePath, branch) => {
        removed.push({ worktreePath, branch });
      },
    });
    const pruned = await reconcile(new Set(["live"]));
    expect(pruned).toBe(1);
    expect(removed).toEqual([{ worktreePath: "/repo/.worktrees/run-orphan", branch: "run/orphan" }]);
  });

  it("settle-gap: disposes a DETACHED orphan run branch (no dir) but PROTECTS dir-backed + merge-train branches", async () => {
    const removedDirs: string[] = [];
    const disposed: string[] = [];
    const reconcile = makeReconcileWorktrees({
      // run-live has a worktree dir; run/orphan + run/merging are DETACHED (no dir → invisible here).
      listWorktrees: async () => ["worktree /repo/.worktrees/run-live", "branch refs/heads/run/live", ""].join("\n"),
      removeWorktree: async (worktreePath) => void removedDirs.push(worktreePath),
      listRunBranches: async () => ["run/live", "run/orphan", "run/merging"],
      disposeBranch: async (branch) => void disposed.push(branch),
    });
    // keep: run/live (a live interrupted run, also dir-backed) + run/merging (on the merge train).
    const pruned = await reconcile(new Set(["live", "merging"]));
    expect(disposed).toEqual(["run/orphan"]); // the ONLY true settle-gap orphan (no dir, no entry)
    expect(removedDirs).toEqual([]); // run/live is kept (in keep) → its dir is not pruned
    expect(pruned).toBe(1);
  });

  it("never disposes a branch with NO dispose deps wired (legacy reconciler — branch sweep is a no-op)", async () => {
    const reconcile = makeReconcileWorktrees({
      listWorktrees: async () => "",
      removeWorktree: async () => {},
      // listRunBranches / disposeBranch omitted → the branch sweep must be skipped entirely.
    });
    expect(await reconcile(new Set())).toBe(0);
  });

  it("is best-effort: a remove failure never aborts the sweep (continues + counts the rest)", async () => {
    const removed: string[] = [];
    const reconcile = makeReconcileWorktrees({
      listWorktrees: async () =>
        [
          "worktree /r/.worktrees/run-a",
          "branch refs/heads/run/a",
          "",
          "worktree /r/.worktrees/run-b",
          "branch refs/heads/run/b",
          "",
        ].join("\n"),
      removeWorktree: async (_worktreePath, branch) => {
        if (branch === "run/a") throw new Error("locked");
        removed.push(branch);
      },
    });
    const pruned = await reconcile(new Set());
    expect(pruned).toBe(1); // only run/b succeeded; run/a's failure was swallowed
    expect(removed).toEqual(["run/b"]);
  });
});

describe("recoverMergeQueue — boot recovery of the merge train (SM-2)", () => {
  it("delegates to the queue's recover() and returns its summary", async () => {
    const summary = { loaded: 3, resetToConflict: 1, resumed: 0, pruned: 0, resetGateFailed: 0, waiting: 2 };
    const mq = { recover: async () => summary };
    expect(await recoverMergeQueue(mq)).toEqual(summary);
  });

  it("swallows a recover() failure so it can never abort boot", async () => {
    const mq = {
      recover: async () => {
        throw new Error("disk read failed");
      },
    };
    expect(await recoverMergeQueue(mq)).toEqual({ loaded: 0, resetToConflict: 0, resumed: 0, pruned: 0, resetGateFailed: 0, waiting: 0 });
  });
});
