import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAIM_REFUSED_MARKER, RunnerEngine, brandbookPathFor, buildClaudeCommand, buildContextNote, buildResumeCommand, buildRunCommitMessage, buildStateSnapshot, buildStyleGuideNote, buildToolkitNote, captureInputHash, composeSystemPrompt, formatRunAge, precheckNoop, quoteArg, sanitizeSpawnPath, styleGuidePathFor, summarizeFinalText, timeoutFor, pumpRetryNeeded, PUMP_RETRY_MS, type CardUpdater, type PumpTimerFn, type PrecheckInput } from "./engine";
import type { DeltaLandedFn, SplitLandedness } from "./convergence";
import { BOARD_DATA_SKILL_INVARIANTS, CODE_SKILL_INVARIANTS, systemPromptFor } from "./skill-registry";
import { DEFAULT_RUNNER_SETTINGS } from "./config";
import { getRunnerRegistry } from "./registry";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { CardClaims, memoryClaimStore, setCardClaimsSingletonForTests, type CardClaim, type CardClaimsPort } from "./claims";
import type { JournalStart, RunnerJournalPort } from "./journal";
import type { TelemetryPort, TelemetryRecord } from "./telemetry";
import type { ExecFn, WorktreeOps } from "./worktree";
import { makeMergeQueue, type MergeQueuePort, type MergeQueueStore, type RedriveHandler } from "./merge-queue";
import { DependencyGraph } from "./dep-graph";
import type { CommitSerializer } from "./commit-serializer";
import type { VpsResources } from "./scheduler";
import type { MergeQueueEntry } from "./types";
import type { BoardConfig, Card, StatusDef, TriggerId } from "@/lib/storymap/types";

// Resource probe (DI) that ALWAYS reports spare capacity, so the lane caps — not the VPS threshold —
// govern admission in every test that isn't specifically about overload. Keeps the existing suite
// deterministic regardless of the host's real free RAM / load (the operational settings.yaml carries
// real thresholds). Overload-specific tests inject their own probe via makeEngine({ probeResources }).
const NEVER_OVERLOADED: () => VpsResources = () => ({ freeRamMb: Infinity, loadAvg1: 0 });

// Flush microtasks/macrotasks. Two things now resolve asynchronously before assertions:
//   - the worktree is created (await) BEFORE the spawn, so a run reaches `claude` only after a
//     flush following runSkill();
//   - the async falha-fantasma guard (the FAILURE path of finish() reads the card status from
//     disk before settling).
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// WS-4 (claims): give EVERY test a FRESH, in-memory card-claim registry. The engines built INLINE below
// (positional args, so they can't reach the `claims` param) would otherwise fall back to the process-global
// disk-backed one — and since a fake child never settles on its own, its run would hold `acme/story-1` for
// the rest of the file (and, because the file persists, for the next suite RUN too), refusing every later
// spawn of that card. Isolating the singleton per test also keeps the suite off the real storymap/.runner.
beforeEach(() => {
  setCardClaimsSingletonForTests(new CardClaims(memoryClaimStore()));
});

// A fake ChildProcess that never closes on its own — the test drives its lifecycle.
function makeFakeChild() {
  const ee = new EventEmitter() as EventEmitter & { pid?: number; stdout: EventEmitter; stderr: EventEmitter };
  ee.pid = 4321;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  return ee;
}

// A recording journal double (DI) so the engine's durable-journal writes are observable
// and never touch disk in unit tests.
function makeJournal() {
  const starts: JournalStart[] = [];
  const finishes: Array<{ board: string; cardId: string; outcome: string; endedAt: number }> = [];
  // story-9s52tu HALF B: capture markResumable calls so a test can assert a max-turns run was marked
  // resumable (kept "running", NOT flipped to "done" via recordFinish).
  const resumables: Array<{ board: string; cardId: string; endedAt: number }> = [];
  const journal: RunnerJournalPort = {
    recordStart: (e) => {
      starts.push(e);
    },
    recordFinish: (board, cardId, outcome, endedAt) => {
      finishes.push({ board, cardId, outcome, endedAt });
    },
    markResumable: (board, cardId, endedAt) => {
      resumables.push({ board, cardId, endedAt });
    },
  };
  return { journal, starts, finishes, resumables };
}

// A recording telemetry double (DI) so the engine's settle()-time recordRun is observable and never
// touches disk in unit tests (story-observabilidade-runs-telemetria).
function makeTelemetry() {
  const records: TelemetryRecord[] = [];
  const telemetry: TelemetryPort = {
    recordRun: async (r) => {
      records.push(r);
    },
    listByCard: async () => [],
    boardSummary: async (boardId) => ({ boardId, cards: [], totalCostUSD: 0 }),
  };
  return { telemetry, records };
}

// A no-op telemetry port for the inline-constructed engines that don't assert telemetry — keeps every
// `new RunnerEngine(...)` off the real disk-backed singleton (which settle() would otherwise write to).
const noopTelemetry: TelemetryPort = makeTelemetry().telemetry;

// A no-op WorktreeOps for the inline-constructed engines that don't assert worktree behavior —
// returns a deterministic path/branch and records nothing (never touches real git).
const noopWorktreeOps: WorktreeOps = {
  create: async (repoRoot, sessionId) => ({ worktreePath: `${repoRoot}/.worktrees/run-${sessionId}`, branch: `run/${sessionId}` }),
  commit: async () => ({ committed: true }),
  commitBoardState: async () => ({ committed: false }),
  commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
  remove: async () => {},
  detach: async () => {},
  hasUnmergedWork: async () => true,
  disposeBranch: async () => {},
};

// A recording merge-queue double (DI). SM-2: a successful isolated run hands its branch here
// instead of tearing it down — so the engine tests can assert the enqueue WITHOUT a real queue/git.
// story-92ldyt: also records the registered redrive handler (so a test can assert it was wired + drive
// it directly) and captures the enqueued `trigger`/`driveCount` (the merge train's re-drive inputs).
function makeMergeQueueDouble() {
  // cardId optional since WS-1.3 (the train accepts card-less `kind: session` entries); every engine-driven
  // run still carries one — the assertions below read it as the card's id exactly as before.
  const enqueues: Array<{ runId: string; board: string; cardId?: string; branch: string; trigger?: TriggerId; driveCount?: number }> = [];
  const redriveHandlers: RedriveHandler[] = [];
  const mergeQueue: MergeQueuePort = {
    enqueueMerge: async (e) => {
      enqueues.push(e);
    },
    ensureRunBase: async () => "HEAD",
    resolveMergeConflict: async () => {},
    reconcileCardMergeEntries: async () => {},
    getSnapshot: () => ({ entries: [], processing: false }),
    subscribe: () => () => {},
    resolveGateFailed: async () => {},
    // WS-8.1: the steward's verb. The ENGINE never calls it (only the steward pass does), so the double just
    // satisfies the port — an engine test that saw a retry here would be testing the wrong seam.
    retryParkedEntry: async () => ({ ok: false, detail: "double" }),
    setRedriveHandler: (fn) => {
      redriveHandlers.push(fn);
    },
    recover: async () => ({ loaded: 0, resetToConflict: 0, resumed: 0, pruned: 0, resetGateFailed: 0, waiting: 0 }),
    whenIdle: async () => {},
    onMergeDone: () => () => {},
    onEntrySettled: () => () => {},
    liveRunIds: async () => [],
    allRunIds: async () => [],
    activeRunIds: async () => [],
    sweepStuck: async () => ({ swept: 0, warned: 0, runIds: [] }),
    pump: async () => ({ waiting: 0, pumped: false }),
  };
  return { mergeQueue, enqueues, redriveHandlers };
}

// spawn + journal + card-status reader + worktreeOps injected via the constructor — DI instead
// of vi.mock (unavailable on Bun). The reader defaults to "no advance" (null → the failure is
// preserved). The worktree double records create/remove calls and resolves a deterministic path
// from the run's session id, so the spawn can be asserted to use it as cwd — all without git.
function makeEngine(
  readCardStatus: (board: string, cardId: string, cwd?: string) => Promise<string | null> = async () => null,
  opts: {
    committed?: boolean;
    boardCommitted?: boolean;
    boardCommitThrows?: boolean;
    // story-apz8sa FIX 1: model the no-worktree board-data settle commit+push. `boardDataCommitted`
    // decides whether the (mock) scoped commit produced a commit (false = empty board delta → no push);
    // `boardDataPushFails` makes the (mock) push FAIL-OPEN (committed:true, pushed:false). Default:
    // committed:true (the skill wrote the card .md) + pushed:true (origin accepted). `boardDataCommitThrows`
    // models the FIX 2 abort/secret-scan reject — the commit fn REJECTS, the cascade still fires (deferred).
    boardDataCommitted?: boolean;
    boardDataPushFails?: boolean;
    boardDataCommitThrows?: boolean;
    // story-ms5rmt: inject the per-cwd commit mutex (DI). Default = the engine's own module default
    // (the real process-global serialCommit). Tests pass a recording double to assert serialization.
    commitSerializer?: CommitSerializer;
    // Hold commitBoardState (boundary 1) open for N macrotasks so a concurrent boundary-2 would
    // overlap if the serializer were NOT keeping them on one chain (used by the concurrency tests).
    boardCommitDelayMs?: number;
    // story-scheduler-lanes-recursos: inject the VPS resource probe (DI). Default = never overloaded
    // (lane caps govern); overload tests pass a probe that reports a starved box to gate the heavy lane.
    probeResources?: () => VpsResources;
    // SM-4 governor: inject systemd availability (DI). Default = unavailable, so the existing suite
    // never wraps a spawn in a scope (behavior identical to the pre-governor engine). The OOM/scope
    // tests pass () => true to force the scope on.
    systemdCheck?: () => boolean;
    // C2/O3.5: lista de paths que o (mock) changedPaths devolve. AUSENTE (default) = ops sem o método
    // → guard de artefatos OFF (fail-open), suíte pré-existente intocada.
    changedPaths?: string[];
    // ADR-063 Fase 4c: inject read-only-sandbox availability (DI). Default = unavailable, so the existing
    // suite never wraps a spawn in the sandbox. O master switch de env que este comentário citava saiu
    // em 2026-08-05 com a camada fail-open — hoje a disponibilidade entra SÓ por esta injeção.
    // WS-4: inject the card-claim registry (DI). Default = a fresh in-memory one per engine, so the suite
    // never touches the real claims.json and the admission path stays IO-free. A claims test passes its own
    // (pre-seeded) registry to exercise the "card já reservado" refusal.
    claims?: CardClaimsPort;
    // story-92ldyt: inject the board-config reader (DI) the conflict-redrive handler uses to resolve the
    // StatusDef of the conflicting branch's trigger. Default = null (no board) so the existing suite is
    // unchanged; the re-drive tests pass a config whose `desenvolver` column owns `harness-do`.
    readBoardConfig?: (board: string) => Promise<BoardConfig | null>;
    // story-rotear-model-effort-por-complexidade: inject the FULL-card reader (DI) the spawn-flag
    // resolution uses to route model/effort by complexity. Default = null (card-less → the engine falls
    // back to resolveColumnArgs, behavior identical to the pre-routing suite); the routing tests pass a
    // reader that returns a card whose storyType/rice/tasks drive the derived (model, effort).
    readCard?: (board: string, cardId: string) => Promise<Card | null>;
    // story-observabilidade-runs-telemetria: inject the telemetry port (DI). Default = a no-op double
    // (keeps settle() off the real disk-backed singleton); the telemetry test passes a recording double.
    telemetry?: TelemetryPort;
    // Small-commits flow: decouple the settle gate from the sweep commit. Default mirrors `committed`
    // (sweep produced a commit → has work). The self-commit test passes committed:false (sweep found
    // nothing — the skill already committed) + hasUnmergedWork:true (the branch DOES carry the skill's
    // commits) to assert the run is still enqueued, not discarded.
    hasUnmergedWork?: boolean;
    // story-yy3hds: faz o (mock) sweep-commit REJEITAR nas N primeiras chamadas — modela a mensagem
    // que quebrava o /bin/sh (backtick ímpar no Decision:) e, com N≥2, uma falha persistente de git
    // (secret-scan block, index.lock, disco). Default 0 = nunca falha (suíte pré-existente intocada).
    commitThrowsTimes?: number;
    // story-mcp-enfileiramento-lote-dependencias: inject the dependency graph (DI). Default = a fresh
    // graph per engine so each test is isolated from the process singleton; the dep tests pass their
    // own to assert register/release.
    depGraph?: DependencyGraph;
    // story-#30: inject the process-signal sender (DI). Default = a recording spy that NEVER touches a
    // real process (the fake child's pid 4321 must not signal a real pgid) and reports "dead" on the
    // liveness probe (signal 0 → ESRCH) so killTree does not escalate to SIGKILL. The escalation test
    // passes a spy that keeps the group alive across the first probe.
    killProcess?: (pid: number, signal?: NodeJS.Signals | 0) => void;
    // story-koieb3: inject the run's cgroup-scope reaper (DI). Default = a recording spy that NEVER
    // touches a real systemd. The settle-stops-scope test asserts settle() calls it with the run's
    // `harness-run-<id>.scope` and NEVER with storymap.service.
    stopScope?: (unit: string | undefined | null) => Promise<import("./governor").StopScopeResult>;
    // story-koieb3 hardening (EDGE 3): inject the no-systemd dev-server PID reaper (DI). Default = a
    // recording spy that NEVER touches a real process. The settle-reaps-pidfile test asserts settle()
    // ALWAYS calls it with the run's sessionId (so a leaked dev server is reaped even with no systemd).
    reapDevServer?: (runId: string) => Promise<import("./dev-server").ReapPidResult>;
    // 2026-07-17: inject the stranded-work retry timer (DI). Default = a recording fake that NEVER fires,
    // so the existing suite is byte-identical (no real 30s timer, no surprise re-pump); the stranding
    // tests read `pumpTimers` to assert the re-arm and fire it by hand.
    setTimer?: PumpTimerFn;
    // WS-5: inject the convergence ruler (DI) the C2 build-evidence guard consults. Default = undefined →
    // the constructor default (real read-only git), so the pre-existing suite is untouched. The C2 tests
    // pass a fake verdict to drive the guard's three outcomes without a repo.
    deltaLandedFn?: DeltaLandedFn;
    // WS-1.3: inject the SPLIT ruler (DI) the redrive pre-check consults — "did each half land in ITS ref?".
    // Default = undefined → the constructor default (real read-only git), so the pre-existing suite is
    // untouched. The redrive tests drive its three outcomes from a fake verdict, without a repo.
    branchWorkLandedBySplitFn?: (branch: string) => Promise<SplitLandedness>;
    // WS-5: inject the card mutator (DI) the settle-time stamps write through. Default = an in-memory
    // double over a seeded card, so a stamp is OBSERVABLE without writing into the checkout's real board
    // data (the real writer has no path seam — see CardUpdater). `cardOnDisk` seeds it; `cardWrites`
    // records every mutation result.
    cardOnDisk?: Card | null;
  } = {},
) {
  // f1: an isolated run commits its worktree before detaching. Default committed:true (the run
  // changed something → goes to the merge train); pass committed:false to model an EMPTY diff.
  const committed = opts.committed ?? true;
  const children: ReturnType<typeof makeFakeChild>[] = [];
  const cmds: string[] = [];
  const spawnOpts: Array<{ cwd?: string }> = [];
  const { journal, starts, finishes, resumables } = makeJournal();
  const worktreeCreates: Array<{ repoRoot: string; sessionId: string; worktreePath: string; branch: string }> = [];
  const worktreeCommits: Array<{ worktreePath: string; message: string }> = [];
  const worktreeBoardCommits: Array<{ repoRoot: string; message: string }> = [];
  // story-apz8sa FIX 1: every settle-time board-data commit+push of an isCode:false run. `committed`
  // mirrors the (mock) scoped commit; `pushed` mirrors the (mock) cumulative push to origin.
  const worktreeBoardPushes: Array<{ repoRoot: string; message: string; pushed: boolean }> = [];
  const worktreeRemoves: Array<{ worktreePath: string; branch: string }> = [];
  const worktreeDetaches: Array<{ worktreePath: string }> = [];
  // Ordered event log so a test can assert the HEAD=estado board commit ran BEFORE worktree create.
  const worktreeEvents: string[] = [];
  // commitBoardState may be forced to throw (fail-closed boundary test) via opts.boardCommitThrows.
  const boardCommitThrows = opts.boardCommitThrows ?? false;
  const worktreeOps: WorktreeOps = {
    create: async (repoRoot, sessionId) => {
      const worktreePath = `${repoRoot}/.worktrees/run-${sessionId}`;
      const branch = `run/${sessionId}`;
      worktreeEvents.push("create");
      worktreeCreates.push({ repoRoot, sessionId, worktreePath, branch });
      return { worktreePath, branch };
    },
    commitBoardState: async (repoRoot, message) => {
      worktreeEvents.push("boardCommit");
      worktreeBoardCommits.push({ repoRoot, message });
      if (opts.boardCommitDelayMs) await new Promise((r) => setTimeout(r, opts.boardCommitDelayMs));
      if (boardCommitThrows) throw new Error("secret-scan bloqueou o commit (cwd /repo): boom");
      return { committed: opts.boardCommitted ?? false };
    },
    // story-apz8sa FIX 1+2: the no-worktree settle commit+push of an isCode:false run. Records the call
    // (so a test asserts it fired, scoped + on main) and, on a real commit, the (mock) push. The delay
    // holds it open so the concurrency test can prove serialization; `boardDataCommitThrows` models the
    // scoped-commit secret-scan/code-guard reject (FIX 2), which must REJECT (cascade still fires deferred).
    commitBoardStateAndPush: async (repoRoot, message) => {
      worktreeEvents.push("boardCommitPush");
      worktreeBoardCommits.push({ repoRoot, message }); // shared recorder: the commit half
      if (opts.boardCommitDelayMs) await new Promise((r) => setTimeout(r, opts.boardCommitDelayMs));
      if (opts.boardDataCommitThrows) throw new Error("board-data commit ABORTADO: o diff staged toca código (packages/x.ts)");
      const committed = opts.boardDataCommitted ?? true;
      if (!committed) {
        worktreeBoardPushes.push({ repoRoot, message, pushed: false });
        return { committed: false, pushed: false }; // empty board delta → nothing to push
      }
      const pushed = !(opts.boardDataPushFails ?? false);
      worktreeBoardPushes.push({ repoRoot, message, pushed });
      return { committed: true, pushed, pushError: pushed ? undefined : "exit 1" };
    },
    commit: async (worktreePath, message) => {
      worktreeCommits.push({ worktreePath, message });
      // story-yy3hds: as N primeiras tentativas rejeitam (o -m que o shell quebrava / um git doente).
      if (worktreeCommits.length <= (opts.commitThrowsTimes ?? 0))
        throw new Error("Command failed: git commit … /bin/sh: 5: Syntax error: EOF in backquote substitution");
      return { committed };
    },
    remove: async (worktreePath, branch) => {
      worktreeRemoves.push({ worktreePath, branch });
    },
    detach: async (worktreePath) => {
      worktreeDetaches.push({ worktreePath });
    },
    // The settle gate: a run "has work" exactly when its (mock) commit produced something — same
    // intent as the old `committed` flag (true → enqueue, false → empty run → remove). Overridable
    // to model a skill that committed its own work (sweep empty, branch still ahead).
    hasUnmergedWork: async () => opts.hasUnmergedWork ?? committed,
    changedPaths: opts.changedPaths ? async () => opts.changedPaths! : undefined,
    disposeBranch: async () => {},
  };
  const { mergeQueue, enqueues, redriveHandlers } = makeMergeQueueDouble();
  const fakeSpawn = ((cmd: string, opts: { cwd?: string }) => {
    cmds.push(cmd);
    spawnOpts.push(opts);
    const c = makeFakeChild();
    children.push(c);
    return c;
  }) as unknown as typeof import("node:child_process").spawn;
  // story-#30: a recording signal sender that NEVER signals a real process — the fake child's pid
  // (4321) must not reach process.kill. Reports "dead" on the liveness probe (signal 0 → throw ESRCH)
  // so killTree's normal path sends one SIGTERM and stops (no SIGKILL escalation).
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
  const defaultKill = (pid: number, signal?: NodeJS.Signals | 0): void => {
    killCalls.push({ pid, signal });
    if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  // story-koieb3: record every settle-time scope reap WITHOUT touching real systemd. The default acts
  // exactly like a no-op stopRunScope (acted:false on a missing scope) so the existing suite is unchanged.
  const stopScopeCalls: Array<string | undefined | null> = [];
  const defaultStopScope = async (unit: string | undefined | null) => {
    stopScopeCalls.push(unit);
    return { acted: false, reason: "test-spy" };
  };
  // story-koieb3 hardening (EDGE 3): record every settle-time dev-server PID reap WITHOUT touching a real
  // process or fs. The default acts like a no-op reapDevServerPid (acted:false on a missing file) so the
  // existing suite is unchanged — only the new fallback tests assert it fires with the run's sessionId.
  const reapDevServerCalls: string[] = [];
  const defaultReapDevServer = async (runId: string) => {
    reapDevServerCalls.push(runId);
    return { acted: false, reason: "test-spy" };
  };
  // WS-5: an in-memory stand-in for updateCardOnDisk, so a settle-time stamp is observable without touching
  // the checkout's real board data. Default seed = null, i.e. "no such card" — the exact value the real
  // writer returns for the fixture-less `acme/story-1` the suite uses, so every pre-existing test keeps the
  // behavior it had (stamp declines) while losing the real filesystem write it was silently attempting.
  // The stranded-work retry: record each arm WITHOUT scheduling anything real. A test fires `run()` by hand,
  // which is the "30s later, the VPS cooled down" moment.
  const pumpTimers: Array<{ ms: number; run: () => void }> = [];
  const defaultSetTimer: PumpTimerFn = (fn, ms) => {
    pumpTimers.push({ ms, run: fn });
    return { unref: () => {} };
  };
  let cardStore: Card | null = opts.cardOnDisk ?? null;
  const cardWrites: Card[] = [];
  const updateCard: CardUpdater = async (_board, _cardId, mutate) => {
    if (!cardStore) return null;
    const next = mutate(cardStore);
    if (!next) return null;
    cardStore = next;
    cardWrites.push(next);
    return next;
  };
  return {
    cardWrites,
    engine: new RunnerEngine(
      fakeSpawn,
      journal,
      readCardStatus,
      worktreeOps,
      mergeQueue,
      opts.commitSerializer,
      opts.probeResources ?? NEVER_OVERLOADED,
      opts.systemdCheck ?? (() => false),
      opts.readBoardConfig ?? (async () => null),
      opts.readCard ?? (async () => null),
      opts.telemetry ?? noopTelemetry,
      opts.depGraph ?? new DependencyGraph(),
      opts.killProcess ?? defaultKill,
      opts.stopScope ?? defaultStopScope,
      opts.reapDevServer ?? defaultReapDevServer,
      undefined, // readBoardCards → constructor default (unchanged by the Fase 4c param addition)
      // WS-5: undefined → the constructor default (real git). Only the C2 tests inject a verdict.
      opts.deltaLandedFn,
      // WS-4: an IN-MEMORY claim registry. The default is the disk-backed singleton, whose load/persist would
      // put real fs IO on the admission path — the spawn would then land AFTER `flush()` (one macrotask) and
      // every spawn assertion here would go silently red. Injecting it also keeps each engine isolated: a
      // reservation from one test can never leak into the next (they share `acme/story-1`).
      opts.claims ?? new CardClaims(memoryClaimStore()),
      updateCard,
      opts.setTimer ?? defaultSetTimer,
      // WS-1.3: undefined → the constructor default (real git). Only the redrive pre-check tests inject one.
      opts.branchWorkLandedBySplitFn,
    ),
    pumpTimers,
    killCalls,
    stopScopeCalls,
    reapDevServerCalls,
    children,
    cmds,
    spawnOpts,
    starts,
    finishes,
    resumables,
    worktreeCreates,
    worktreeCommits,
    worktreeBoardCommits,
    worktreeBoardPushes,
    worktreeEvents,
    worktreeRemoves,
    worktreeDetaches,
    mergeEnqueues: enqueues,
    redriveHandlers,
  };
}

// harness-do is a code skill and this def has NO costGuard → timeoutFor returns the generous
// UNIVERSAL ceiling (~60 min). The watchdog timer is now ALWAYS armed, but it's unref'd, so
// the never-closing fake child in these tests leaks no event-loop-holding timer.
const codeDef: StatusDef = { id: "desenvolver", name: "Desenvolver" };

const ORIGINAL_MAX = process.env.USM_AUTORUN_MAX;
const ORIGINAL_RATE_MAX = process.env.USM_AUTORUN_RATE_MAX;
const ORIGINAL_WORKTREE = process.env.USM_AUTORUN_WORKTREE;
// Auditoria 2026-08-19: o push do board-data virou DECLARADO (default desligado). Os casos que
// medem o push declaram o knob; o `afterEach` abaixo o restaura junto com o do worktree.
const ORIGINAL_AUTOPUSH = process.env.STORYMAP_BOARD_AUTOPUSH;
const ORIGINAL_HEAVY_MEM = process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX;
const ORIGINAL_HEAVY_CPU = process.env.USM_AUTORUN_LANE_HEAVY_CPU_QUOTA;
const ORIGINAL_RESUME_FALLBACK_MAX = process.env.USM_AUTORUN_RESUME_FALLBACK_MAX;
const ORIGINAL_MAXTURNS_RESUME_MAX = process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX;
afterEach(() => {
  if (ORIGINAL_MAXTURNS_RESUME_MAX === undefined) delete process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX;
  else process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX = ORIGINAL_MAXTURNS_RESUME_MAX;
  if (ORIGINAL_RESUME_FALLBACK_MAX === undefined) delete process.env.USM_AUTORUN_RESUME_FALLBACK_MAX;
  else process.env.USM_AUTORUN_RESUME_FALLBACK_MAX = ORIGINAL_RESUME_FALLBACK_MAX;
  if (ORIGINAL_MAX === undefined) delete process.env.USM_AUTORUN_MAX;
  else process.env.USM_AUTORUN_MAX = ORIGINAL_MAX;
  if (ORIGINAL_RATE_MAX === undefined) delete process.env.USM_AUTORUN_RATE_MAX;
  else process.env.USM_AUTORUN_RATE_MAX = ORIGINAL_RATE_MAX;
  if (ORIGINAL_WORKTREE === undefined) delete process.env.USM_AUTORUN_WORKTREE;
  else process.env.USM_AUTORUN_WORKTREE = ORIGINAL_WORKTREE;
  if (ORIGINAL_AUTOPUSH === undefined) delete process.env.STORYMAP_BOARD_AUTOPUSH;
  else process.env.STORYMAP_BOARD_AUTOPUSH = ORIGINAL_AUTOPUSH;
  if (ORIGINAL_HEAVY_MEM === undefined) delete process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX;
  else process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = ORIGINAL_HEAVY_MEM;
  if (ORIGINAL_HEAVY_CPU === undefined) delete process.env.USM_AUTORUN_LANE_HEAVY_CPU_QUOTA;
  else process.env.USM_AUTORUN_LANE_HEAVY_CPU_QUOTA = ORIGINAL_HEAVY_CPU;
});

describe("timeoutFor — the wall-clock watchdog is ALWAYS a number (no run runs unbounded)", () => {
  const cfg = DEFAULT_RUNNER_SETTINGS;
  const noGuard: StatusDef = { id: "desenvolver", name: "Desenvolver" }; // code skill, no costGuard
  const withGuard: StatusDef = { id: "desenvolver", name: "Desenvolver", costGuard: true };
  const fastDef: StatusDef = { id: "enriquecer", name: "Enriquecer" };

  it("a code skill WITHOUT costGuard/doMs falls back to the generous universal ceiling (was null)", () => {
    expect(timeoutFor("harness-do", noGuard, cfg)).toBe(cfg.autorun.timeouts.universalMs);
    expect(timeoutFor("harness-refine", noGuard, cfg)).toBe(cfg.autorun.timeouts.universalMs); // refine: the bug from the live test
  });

  it("a code skill WITH costGuard keeps the responsive 30-min ceiling (universal is the wider net)", () => {
    expect(timeoutFor("harness-do", withGuard, cfg)).toBe(30 * 60_000);
  });

  it("an explicit global doMs wins over both costGuard and the universal ceiling", () => {
    const withDo = { ...cfg, autorun: { ...cfg.autorun, timeouts: { ...cfg.autorun.timeouts, doMs: 90_000 } } };
    expect(timeoutFor("harness-do", noGuard, withDo)).toBe(90_000);
    expect(timeoutFor("harness-do", withGuard, withDo)).toBe(90_000);
  });

  it("a fast skill keeps its own short fast watchdog (universal ceiling does not touch it)", () => {
    expect(timeoutFor("harness-enrich", fastDef, cfg)).toBe(cfg.autorun.timeouts.fastMs);
  });

  it("honors a tuned universalMs from the config (operational knob)", () => {
    const tuned = { ...cfg, autorun: { ...cfg.autorun, timeouts: { ...cfg.autorun.timeouts, universalMs: 123_000 } } };
    expect(timeoutFor("harness-do", noGuard, tuned)).toBe(123_000);
  });
});

describe("RunnerEngine.runSkill — security + idempotency + concurrency", () => {
  it("rejects a non-slug id (shell-injection guard) WITHOUT spawning", () => {
    const { engine, cmds } = makeEngine();
    expect(engine.runSkill("acme", "../../evil", "harness-do", codeDef)).toEqual({
      ok: false,
      reason: "bad-id",
      detail: expect.any(String),
    });
    expect(engine.runSkill("acme", "a; rm -rf /", "harness-do", codeDef).ok).toBe(false); // metachars
    expect(engine.runSkill("acme", "x$(whoami)", "harness-do", codeDef).ok).toBe(false);
    expect(engine.runSkill("../x", "story-1", "harness-do", codeDef).ok).toBe(false); // bad board too
    expect(cmds).toHaveLength(0); // never reached spawn
  });

  it("accepts a slug id and spawns exactly once with the right command", async () => {
    const { engine, cmds } = makeEngine();
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef)).toEqual({ ok: true });
    await flush(); // spawn happens after the worktree is created
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('"/harness-do acme/story-1"');
  });

  it("injects STORYMAP_AUTORUN_RUN_ID and STORYMAP_AUTORUN_TRIGGER into spawn env (story-ns8x0o)", async () => {
    const { engine, spawnOpts } = makeEngine();
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (spawnOpts[0] as any).env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.STORYMAP_AUTORUN_TRIGGER).toBe("harness-do");
    expect(typeof env.STORYMAP_AUTORUN_RUN_ID).toBe("string");
    expect(env.STORYMAP_AUTORUN_RUN_ID.length).toBeGreaterThan(0);
  });

  it("routes --model/--effort by the card's complexity within the column ceiling (story-rotear-model-effort)", async () => {
    // The column ships opus/high; a chore card forces the cheap tier DOWN to sonnet/medium.
    const devDef = { id: "desenvolver", name: "Desenvolver", model: "opus", effort: "high" } as StatusDef;
    const choreCard = {
      id: "story-1",
      type: "story",
      storyType: "chore",
      tasks: [],
      rice: { reach: null, impact: null, confidence: null, effort: null },
    } as unknown as Card;
    const { engine, cmds } = makeEngine(async () => null, { readCard: async () => choreCard });
    expect(engine.runSkill("acme", "story-1", "harness-do", devDef).ok).toBe(true);
    await flush();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("--model sonnet");
    expect(cmds[0]).toContain("--effort medium");
    expect(cmds[0]).not.toContain("--model opus");
  });

  it("falls back to the column policy when the card read fails (fail-open, identical to pre-routing)", async () => {
    const devDef = { id: "desenvolver", name: "Desenvolver", model: "opus", effort: "high" } as StatusDef;
    // readCard defaults to null in makeEngine → the spawn uses resolveColumnArgs (the column pair).
    const { engine, cmds } = makeEngine();
    expect(engine.runSkill("acme", "story-1", "harness-do", devDef).ok).toBe(true);
    await flush();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("--model opus");
    expect(cmds[0]).toContain("--effort high");
  });

  it("rejects a second run of the SAME card while one is in-flight", async () => {
    const { engine, cmds } = makeEngine();
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef)).toEqual({
      ok: false,
      reason: "in-flight",
      detail: expect.any(String),
    });
    await flush();
    expect(cmds).toHaveLength(1); // the duplicate never spawned
    expect(engine.isInFlight("acme", "story-1")).toBe(true);
  });

  it("honors maxConcurrent: a burst of 3 spawns only 2; the 3rd waits for a free slot", async () => {
    process.env.USM_AUTORUN_MAX = "2"; // ENV wins over settings.yaml/defaults
    const { engine, children, cmds } = makeEngine();
    engine.runSkill("acme", "a", "harness-do", codeDef);
    engine.runSkill("acme", "b", "harness-do", codeDef);
    engine.runSkill("acme", "c", "harness-do", codeDef);
    await flush();
    expect(cmds).toHaveLength(2); // cap honored — c is queued, not spawned

    children[0].emit("close", 0); // first run finishes → frees a slot
    await flush(); // c's start awaits its worktree create before spawning
    expect(cmds).toHaveLength(3); // the queued 3rd run now spawns
    expect(engine.isInFlight("acme", "a")).toBe(false); // slot + in-flight released on close
  });

  it("releases the slot + in-flight key when spawn throws (error exit path)", async () => {
    const throwingSpawn = (() => {
      throw new Error("ENOENT claude");
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(throwingSpawn, makeJournal().journal, async () => null, noopWorktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    expect(engine.runSkill("acme", "story-x", "harness-do", codeDef).ok).toBe(true);
    await flush(); // create resolves, then the spawn throws
    expect(engine.isInFlight("acme", "story-x")).toBe(false); // not stuck in-flight after a failed spawn
    expect(engine.runSkill("acme", "story-x", "harness-do", codeDef).ok).toBe(true); // retryable on the SAME engine
    await flush();
  });

  it("autorun dedupe window blocks a repeat of the same trigger after the run ends", async () => {
    const { engine, children } = makeEngine();
    expect(engine.runSkill("acme", "a", "harness-do", codeDef, { dedupeWindowMs: 30_000 }).ok).toBe(true);
    await flush();
    children[0].emit("close", 0); // run finished → in-flight released, but the spawn stamp remains
    expect(engine.runSkill("acme", "a", "harness-do", codeDef, { dedupeWindowMs: 30_000 })).toEqual({
      ok: false,
      reason: "cooldown",
      detail: expect.any(String),
    });
  });

  it("manual run (no dedupe window) is never throttled by the anti-replay stamp", async () => {
    const { engine, children, cmds } = makeEngine();
    engine.runSkill("acme", "a", "harness-do", codeDef, { dedupeWindowMs: 30_000 });
    await flush();
    children[0].emit("close", 0);
    expect(engine.runSkill("acme", "a", "harness-do", codeDef).ok).toBe(true); // no window → allowed
    await flush();
    expect(cmds).toHaveLength(2);
  });

  it("autorun rate limit (circuit breaker) refuses spawns beyond the window cap", async () => {
    process.env.USM_AUTORUN_RATE_MAX = "2"; // tiny cap for the test
    process.env.USM_AUTORUN_MAX = "5"; // don't let maxConcurrent mask the rate refusal
    const { engine } = makeEngine();
    // Distinct cards so neither in-flight nor cooldown interferes — only the rate cap.
    expect(engine.runSkill("acme", "a", "harness-do", codeDef, { dedupeWindowMs: 1 }).ok).toBe(true);
    expect(engine.runSkill("acme", "b", "harness-do", codeDef, { dedupeWindowMs: 1 }).ok).toBe(true);
    expect(engine.runSkill("acme", "c", "harness-do", codeDef, { dedupeWindowMs: 1 })).toEqual({
      ok: false,
      reason: "rate-limited",
      detail: expect.any(String),
    });
    await flush();
  });

  it("a MANUAL run is exempt from the autorun rate limit", async () => {
    process.env.USM_AUTORUN_RATE_MAX = "1";
    process.env.USM_AUTORUN_MAX = "5";
    const { engine } = makeEngine();
    engine.runSkill("acme", "a", "harness-do", codeDef, { dedupeWindowMs: 1 }); // uses the 1 autorun slot
    expect(engine.runSkill("acme", "b", "harness-do", codeDef).ok).toBe(true); // manual → not counted/limited
    await flush();
  });

  it("records the run start (enqueue pid null → spawn upsert real pid + worktree) and its finish in the journal", async () => {
    process.env.USM_AUTORUN_WORKTREE = "1"; // this assertion is about the worktree path → flag ON
    const { engine, children, starts, finishes, worktreeCreates } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    // Three journal writes when isolation is ON: (1) enqueue (pid null, no tree yet), (2) the f4
    // intermediate upsert with the worktreePath BEFORE the spawn (pid still null), (3) the post-spawn
    // upsert with the real pid + the tree.
    expect(starts).toHaveLength(3);
    expect(starts[0]).toMatchObject({ board: "acme", cardId: "story-1", trigger: "harness-do", pid: null });
    expect(starts[0].worktreePath).toBeUndefined(); // not created yet at enqueue
    expect(starts[1]).toMatchObject({ board: "acme", cardId: "story-1", trigger: "harness-do", pid: null });
    expect(starts[1].worktreePath).toBe(worktreeCreates[0].worktreePath); // f4: journaled before the spawn
    expect(starts[2]).toMatchObject({ board: "acme", cardId: "story-1", trigger: "harness-do", pid: 4321 });
    expect(starts[2].worktreePath).toBe(worktreeCreates[0].worktreePath); // upserted with the tree
    expect(typeof starts[2].sessionId).toBe("string");
    expect(starts[2].osBootMs).toEqual(expect.any(Number));
    children[0].emit("close", 0);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-1", outcome: "ok", endedAt: expect.any(Number) }]);
  });

  it("journals a QUEUED run immediately (pid null) so a crash-while-queued stays recoverable", async () => {
    process.env.USM_AUTORUN_MAX = "2";
    const { engine, cmds, starts } = makeEngine();
    engine.runSkill("acme", "a", "harness-do", codeDef);
    engine.runSkill("acme", "b", "harness-do", codeDef);
    engine.runSkill("acme", "c", "harness-do", codeDef); // queued — cap is 2
    await flush();
    expect(cmds).toHaveLength(2); // only 2 spawned
    const cStarts = starts.filter((s) => s.cardId === "c");
    expect(cStarts).toHaveLength(1); // journaled at enqueue, not yet spawned
    expect(cStarts[0].pid).toBeNull();
    expect(cStarts[0].worktreePath).toBeUndefined(); // no worktree until it actually starts
  });

  it("a signal-killed run is journaled as a failure (exit), not a clean ok", async () => {
    const { engine, children, finishes } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", null, "SIGKILL"); // killed by a signal → code null
    await flush(); // failure path settles asynchronously (falha-fantasma guard reads card status)
    expect(finishes).toEqual([{ board: "acme", cardId: "story-1", outcome: "exit", endedAt: expect.any(Number) }]);
  });

  it("records run telemetry on settle, carrying the registry usage (story-observabilidade-runs-telemetria)", async () => {
    const { telemetry, records } = makeTelemetry();
    const { engine, children } = makeEngine(async () => null, { telemetry });
    engine.runSkill("acme", "story-tele", "harness-do", codeDef);
    await flush();
    // The run reports its cost/tokens via the terminal `result` event, parsed into the registry; settle()
    // reads it back. input = input+cacheCreate+cacheRead, output = output only.
    children[0].stdout.emit(
      "data",
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.5,
        num_turns: 4,
        usage: { input_tokens: 80, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 },
      }) + "\n",
    );
    children[0].emit("close", 0); // clean exit → synchronous settle()
    await flush();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      board: "acme",
      cardId: "story-tele",
      trigger: "harness-do",
      turns: 4,
      inputTokens: 100,
      outputTokens: 50,
      costUSD: 0.5,
      status: "ok",
    });
    expect(records[0].id).toBeTruthy(); // the run's sessionId
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records telemetry with null usage when a run is killed before reporting (status = real outcome)", async () => {
    const { telemetry, records } = makeTelemetry();
    const { engine, children } = makeEngine(async () => null, { telemetry });
    engine.runSkill("acme", "story-killed", "harness-do", codeDef);
    await flush();
    children[0].emit("close", null, "SIGKILL"); // killed before any `result` event
    await flush();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cardId: "story-killed",
      status: "exit",
      turns: null,
      inputTokens: null,
      outputTokens: null,
      costUSD: null,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// A CONTENÇÃO CHEGA AO PROCESSO — comportamental, ponta a ponta, sobre o comando que o spawn RECEBE.
//
// Por que este bloco existe: dois avaliadores independentes mataram a defesa desta fase pelo mesmo
// buraco, medido nas duas vezes com a suíte inteira verde (7167/7167):
//   · trocar `spawnProcess(finalCmd, …)` por `spawnProcess(finalCmd.replace(/ --settings [^ ]+/, ""), …)`;
//   · transformar a própria chamada do portão EM COMENTÁRIO (o guarda era regex sobre a fonte, e o
//     regex nem desprezava comentários).
// Nenhuma das duas sobrevive a uma asserção sobre o comando que o processo filho de fato recebeu — que
// é o que faltava. `peer-review-spawn` e `resolution-judge-spawn` já tinham a sua; o engine, não.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("RunnerEngine.runSkill — a fronteira chega ao comando executado", () => {
  // ── AMBIENTE DECLARADO, NÃO HERDADO (2026-08-05) ─────────────────────────────────────────────────
  // Estas provas reprovaram no gate de integração e passavam localmente. A causa não era o código: era
  // que a máquina que rodou o gate tinha `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1` num drop-in do systemd
  // — a alavanca de rollback armada, de propósito, ANTES do pouso do F0. O serviço a exportou, o gate
  // rodou como filho dele, e as provas herdaram a válvula que desliga exatamente o que elas medem.
  //
  // Um teste cujo veredito depende do que o operador declarou no host não mede o código; mede a
  // máquina. E o sinal é enganoso NOS DOIS SENTIDOS: aqui deu vermelho num código correto, mas num host
  // com a válvula ligada e uma prova mais frouxa daria VERDE medindo o caminho de escape — o vácuo-verde
  // que este repositório existe para recusar, entrando pela porta do ambiente.
  //
  // Não basta limpar: quem chegar depois precisa saber POR QUE, senão alguém "simplifica" isto de volta.
  const ENVS_DE_ESCAPE = ["AGILEHARNESS_ALLOW_UNSANDBOXED_FULL", "AGILEHARNESS_SANDBOX_MODE"] as const;
  const salvos: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENVS_DE_ESCAPE) {
      salvos[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENVS_DE_ESCAPE) {
      if (salvos[k] === undefined) delete process.env[k];
      else process.env[k] = salvos[k];
    }
  });

  it("o comando que o SPAWN recebe carrega o --settings da postura", async () => {
    const { engine, cmds } = makeEngine(async () => null);
    engine.runSkill("acme", "cont-1", "harness-do", codeDef);
    await flush();
    // Guarda de não-vacuidade: sem isto, um run que nem nasceu passaria calado.
    expect(cmds[0], "nenhum comando chegou ao spawn — o run não nasceu").toBeDefined();
    const cmd = cmds[0]!;
    // Neste host a postura resolve `sandboxed`; onde o sandbox não sobe ela rebaixa, e aí o que a
    // fronteira compra é a AUSÊNCIA de shell. As duas pontas são afirmadas, e uma delas tem de valer.
    const contido = / --settings \S+/.test(cmd);
    const rebaixado = /--disallowedTools\s+"?Bash"?/.test(cmd);
    expect(
      contido || rebaixado,
      `o comando não carrega nem a cerca nem o rebaixamento — a contenção não chegou ao processo:\n${cmd}`,
    ).toBe(true);
    // E, em qualquer postura, a flag perigosa não pode estar lá.
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("um --settings a MAIS (extraArgs do operador) impede o run em vez de deixá-lo nascer", async () => {
    // O portão é load-bearing: se alguém o remover, comentar, ou movê-lo para longe do spawn, este
    // teste passa a deixar o run nascer com a fronteira que o operador sobrescreveu.
    process.env.USM_AUTORUN_EXTRA_ARGS = "--settings /outro/qualquer.json";
    try {
      const { engine, cmds } = makeEngine(async () => null);
      engine.runSkill("acme", "cont-2", "harness-do", codeDef);
      await flush();
      expect(cmds, "o run NASCEU com dois --settings: o último vence e a cerca é outra").toEqual([]);
    } finally {
      delete process.env.USM_AUTORUN_EXTRA_ARGS;
    }
  });
});

describe("RunnerEngine.runSkill — SM-4 governor (systemd-run scope + OOM detection)", () => {
  // harness-do rides the HEAVY lane, so the heavy-lane quota env is what arms the scope here.
  it("wraps the spawn in a systemd-run --scope when a lane quota + systemd are present", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_LANE_HEAVY_CPU_QUOTA = "300";
    const { engine, cmds } = makeEngine(async () => null, { systemdCheck: () => true });
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(cmds[0]).toContain("systemd-run --scope --collect");
    expect(cmds[0]).toContain("--slice=claude-runs.slice");
    // the scope is NAMED after the run's sessionId so recovery can stop the orphan cgroup by name
    // before resuming the session (the deploy-during-run un-strand fix).
    expect(cmds[0]).toMatch(/--unit=harness-run-.+?\.scope/);
    expect(cmds[0]).toContain("MemoryMax=2G");
    expect(cmds[0]).toContain("CPUQuota=300%");
    // the original claude command survives at the tail of the wrapped command
    expect(cmds[0]).toContain('claude -p "/harness-do acme/story-1"');
  });

  it("a SIGKILL on a SCOPED run is the kernel OOM killer → outcome oom-killed (contained)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const reader = async () => "desenvolver"; // card did NOT advance ⇒ a real failure (not falha-fantasma)
    const { engine, children, finishes } = makeEngine(reader, { systemdCheck: () => true });
    engine.runSkill("acme", "oom-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", null, "SIGKILL"); // kernel cgroup OOM kill inside the scope
    await flush(); // failure path settles asynchronously (falha-fantasma guard)
    expect(finishes).toEqual([{ board: "acme", cardId: "oom-1", outcome: "oom-killed", endedAt: expect.any(Number) }]);
    expect(
      getRunnerRegistry()
        .snapshot()
        .failures.some((f) => f.cardId === "oom-1" && f.reason === "oom-killed"),
    ).toBe(true);
  });

  it("a 137 EXIT on a SCOPED run is the OOM kill in its REAL shape → oom-killed", async () => {
    // The production shape: a kernel cgroup OOM SIGKILLs the scope leader (the `claude` binary, which
    // dash exec-opts into from `sh -c "… -- claude …"`); systemd-run/the shell relays that as exit
    // 137 (128+SIGKILL), signal=null — NOT a literal SIGKILL on Node's direct child. This is the
    // vector task t4 named ("código de saída 137") and the one that actually fires on the VPS.
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const reader = async () => "desenvolver"; // card did NOT advance ⇒ a real failure (not falha-fantasma)
    const { engine, children, finishes } = makeEngine(reader, { systemdCheck: () => true });
    engine.runSkill("acme", "oom137", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 137, null); // kernel cgroup OOM, relayed as exit 137 / signal null
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "oom137", outcome: "oom-killed", endedAt: expect.any(Number) }]);
    expect(
      getRunnerRegistry()
        .snapshot()
        .failures.some((f) => f.cardId === "oom137" && f.reason === "oom-killed"),
    ).toBe(true);
  });

  it("a 137 EXIT WITHOUT a scope stays a generic exit (OOM attribution requires an active scope)", async () => {
    // No scope (systemd absent) ⇒ the kernel was NOT enforcing MemoryMax for this run, so a 137 is
    // just a non-zero exit, never an OOM. The scopeApplied gate is what keeps the heuristic honest.
    const reader = async () => "desenvolver";
    const { engine, children, finishes } = makeEngine(reader, { systemdCheck: () => false });
    engine.runSkill("acme", "exit137", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 137, null);
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "exit137", outcome: "exit", endedAt: expect.any(Number) }]);
  });

  it("a 143 EXIT (SIGTERM) on a SCOPED run is OUR kill (watchdog/forceRelease), NOT an OOM → exit", async () => {
    // killTree sends only SIGTERM (143 = 128+SIGTERM). 143 must stay a generic exit even under a
    // scope, else a forced release of a hung run would be mislabeled oom-killed. (Guards the
    // deliberate choice in finish() to match 137 but not 143.)
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const reader = async () => "desenvolver";
    const { engine, children, finishes } = makeEngine(reader, { systemdCheck: () => true });
    engine.runSkill("acme", "term143", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 143, null);
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "term143", outcome: "exit", endedAt: expect.any(Number) }]);
  });

  it("a SIGKILL WITHOUT a scope stays a generic exit (no false OOM attribution)", async () => {
    // systemd ABSENT → no scope is applied (graceful degradation), so a SIGKILL is NOT attributed to
    // an OOM kill — OOM classification requires the kernel to have been enforcing a scope. → exit.
    const reader = async () => "desenvolver";
    const { engine, children, finishes } = makeEngine(reader, { systemdCheck: () => false });
    engine.runSkill("acme", "kill-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", null, "SIGKILL");
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "kill-1", outcome: "exit", endedAt: expect.any(Number) }]);
  });

  it("graceful degradation: a configured quota with systemd ABSENT runs unscoped + logs a warning", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const { engine, cmds } = makeEngine(async () => null, { systemdCheck: () => false });
    engine.runSkill("acme", "degr-1", "harness-do", codeDef);
    await flush();
    expect(cmds[0]).not.toContain("systemd-run"); // ran without the scope
    expect(cmds[0]).toContain("claude -p"); // the real command still launched
    // the warning is surfaced on the card's run console (system frame)
    const logs = getRunnerRegistry().getLogs("acme", "degr-1");
    expect(logs.some((l) => l.text.includes("isolamento de recursos"))).toBe(true);
  });

  it("a clean exit on a scoped run is still a normal ok (scope does not taint the happy path)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const { engine, children, finishes } = makeEngine(async () => null, { systemdCheck: () => true });
    engine.runSkill("acme", "ok-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0); // clean exit
    expect(finishes).toEqual([{ board: "acme", cardId: "ok-1", outcome: "ok", endedAt: expect.any(Number) }]);
  });

  // story-koieb3 (dogfood process isolation): settle() must reap the run's ENTIRE cgroup scope so a
  // process the agent detached (e.g. the QA dev server) dies BY scope, never by loose PID — and the
  // unit it stops can ONLY ever be this run's `harness-run-<id>.scope`, never storymap.service.
  it("settle() of a SCOPED run stops the run's OWN harness-run-*.scope (by scope, never by PID)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    // Disable worktree isolation so the teardown path is the simple remove → settle's finally runs
    // immediately (no async merge-queue deferral to thread through).
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children, stopScopeCalls } = makeEngine(async () => null, { systemdCheck: () => true });
    engine.runSkill("acme", "scope-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0); // clean exit → settle
    await flush();
    expect(stopScopeCalls).toHaveLength(1);
    const unit = stopScopeCalls[0];
    // The reaped unit is THIS run's named scope — and structurally can NEVER be the prod service/slice.
    expect(unit).toMatch(/^harness-run-.+\.scope$/);
    expect(unit).not.toBe("storymap.service");
    expect(unit).not.toContain(".slice");
  });

  it("settle() of an UNSCOPED run (systemd absent) does NOT stop any scope", async () => {
    // systemd unavailable → scopeApplied stays false → settle must skip the scope reap entirely.
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children, stopScopeCalls } = makeEngine(async () => null, { systemdCheck: () => false });
    engine.runSkill("acme", "noscope-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(stopScopeCalls).toHaveLength(0);
  });

  it("settle() reaps the scope EVEN on a failed/non-clean exit (teardown runs in finally)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_WORKTREE = "0";
    const reader = async () => "desenvolver"; // card did NOT advance ⇒ a real failure
    const { engine, children, stopScopeCalls } = makeEngine(reader, { systemdCheck: () => true });
    engine.runSkill("acme", "scopefail-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1); // non-clean exit
    await flush();
    expect(stopScopeCalls).toHaveLength(1);
    expect(stopScopeCalls[0]).toMatch(/^harness-run-.+\.scope$/);
  });

  // story-koieb3 hardening (EDGE 3 — no-systemd fallback teardown): even when there is NO scope to
  // stop (systemd absent → scopeApplied=false), settle() must STILL reap the run's recorded QA
  // dev-server PID, so a dev server the agent detached out of killTree's group can't leak (the
  // orphan-3009 symptom). The reaper is keyed by the run's sessionId, never a loose/scanned pid.
  it("settle() of an UNSCOPED run STILL reaps the dev-server PID file (the only teardown w/o systemd)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children, reapDevServerCalls, stopScopeCalls } = makeEngine(async () => null, {
      systemdCheck: () => false, // no systemd → no scope reap → the PID reap is the ONLY teardown
    });
    engine.runSkill("acme", "noscope-pid-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    // No scope was stopped (systemd absent) but the dev-server PID reap fired with THIS run's sessionId.
    expect(stopScopeCalls).toHaveLength(0);
    expect(reapDevServerCalls).toHaveLength(1);
    expect(reapDevServerCalls[0]).toEqual(expect.any(String));
    expect(reapDevServerCalls[0].length).toBeGreaterThan(0);
  });

  it("settle() ALWAYS reaps the dev-server PID file — even when scoped (complement, not replacement)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children, reapDevServerCalls } = makeEngine(async () => null, { systemdCheck: () => true });
    engine.runSkill("acme", "scoped-pid-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(reapDevServerCalls).toHaveLength(1);
  });

  it("settle() reaps the dev-server PID file EVEN on a failed exit (teardown in finally)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children, reapDevServerCalls } = makeEngine(async () => "desenvolver", {
      systemdCheck: () => false,
    });
    engine.runSkill("acme", "fail-pid-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1); // non-clean exit
    await flush();
    expect(reapDevServerCalls).toHaveLength(1);
  });

  it("a throwing dev-server reaper NEVER escapes settle (slot still freed, run still finishes)", async () => {
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children, finishes } = makeEngine(async () => null, {
      systemdCheck: () => false,
      reapDevServer: async () => {
        throw new Error("reap boom"); // the engine must .catch this — never crash the close handler
      },
    });
    engine.runSkill("acme", "reap-throws-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    // The run still settled cleanly despite the reaper rejecting — the .catch absorbed it.
    expect(finishes).toEqual([
      { board: "acme", cardId: "reap-throws-1", outcome: "ok", endedAt: expect.any(Number) },
    ]);
  });
});

describe("RunnerEngine.runSkill — a camada fail-open (ADR-063) NÃO VOLTA", () => {
  // ── QUATRO PROVAS REMOVIDAS (2026-08-05) — a camada que elas testavam saiu ────────────────────────
  // Elas cobriam o wrap de `scripts/ops/harness-run-sandbox.sh`: aplicava quando ligado+disponível, compunha
  // sob o escopo do systemd, e degradava graciosamente quando indisponível. Boas provas de um mecanismo
  // FAIL-OPEN — e é isso que as tirou daqui, não a qualidade delas.
  //
  // O F0 pousou com o contrato OPOSTO: `failIfUnavailable: true`, e onde a cerca não sobe o run é
  // RECUSADO. "Degradação graciosa" era exatamente a propriedade a matar: um run que perde a proteção e
  // segue em frente é o vácuo-verde com outro nome. As provas equivalentes hoje vivem em
  // autonomy-sandbox.test.ts e exigem o contrário — que a indisponibilidade REPROVE.

  it("o engine não embrulha mais nada com o script fail-open", () => {
    // ⚠ COMENTÁRIOS FORA, e isto não é detalhe: a primeira versão desta prova reprovou por causa do
    // comentário que EXPLICA a remoção, dentro do próprio engine.ts. Uma prova de texto que não separa
    // código de prosa mede a documentação junto — e proibiria escrever por que a peça saiu, que é
    // justamente onde a lição sobrevive neste repositório.
    const src = readFileSync(new URL("./engine.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("harness-run-sandbox.sh");
    expect(src).not.toContain("wrapWithSandbox");
    // Regex sobre a fonte é a técnica que este repositório reprovou três vezes para propriedades de
    // RUNTIME. Aqui ela é legítima por ser outra pergunta: não "a contenção pegou?" (comportamento,
    // provado no spawn espião), e sim "este arquivo voltou a chamar um módulo que não existe mais?"
    // — uma propriedade do TEXTO, que é o que um regex sabe responder.
  });

});

describe("RunnerEngine.runSkill — falha-fantasma guard (exit≠0 após o card avançar)", () => {
  // The guard is skill-agnostic; codeDef/harness-do keeps the fake child watchdog-free (see codeDef).
  it("a non-clean exit AFTER the card advanced is NOT recorded as a failure", async () => {
    // Disable isolation so emitComplete fires immediately (non-isolated path). The r0zr3s describe
    // block covers the isolated-path deferral separately.
    process.env.USM_AUTORUN_WORKTREE = "0";
    // Reader: enqueue read → "priorizar" (before), finish read → "pronta" (after) ⇒ advanced.
    let calls = 0;
    const reader = async () => (calls++ === 0 ? "priorizar" : "pronta");
    const { engine, children, finishes } = makeEngine(reader);
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    engine.runSkill("acme", "ghost-pass", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1); // exit≠0 (e.g. error_max_turns) AFTER the edits landed
    await flush();
    // The work landed → it must NOT pollute the failures list runner_status reads.
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "ghost-pass")).toBe(false);
    // But journal + emit keep the REAL outcome (forense — choice #3), it's just not a failure.
    expect(finishes).toEqual([{ board: "acme", cardId: "ghost-pass", outcome: "exit", endedAt: expect.any(Number) }]);
    expect(seen).toEqual([{ board: "acme", cardId: "ghost-pass", trigger: "harness-do", outcome: "exit" }]);
  });

  it("a non-clean exit while the card did NOT advance is still a real failure", async () => {
    const reader = async () => "desenvolver"; // before === after ⇒ did NOT advance
    const { engine, children, finishes } = makeEngine(reader);
    engine.runSkill("acme", "ghost-fail", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1);
    await flush();
    expect(
      getRunnerRegistry()
        .snapshot()
        .failures.some((f) => f.cardId === "ghost-fail" && f.reason === "exit"),
    ).toBe(true);
    expect(finishes).toEqual([{ board: "acme", cardId: "ghost-fail", outcome: "exit", endedAt: expect.any(Number) }]);
  });
});

describe("RunnerEngine.runSkill — sucesso-fantasma guard (exit 0 mas o card NÃO avançou)", () => {
  // The MIRROR of the falha-fantasma guard: a CLEAN exit from a skill that MUST advance the card on
  // success (advancesOnSuccess: enrich/prioritize/plan/tasks) which left it in its trigger column is a
  // no-op — the skill claimed success but did nothing. Without this it was silently recorded "ok" and
  // the card wedged forever (no visible failure + autorun dedupe blocks a re-fire).
  const fastDef: StatusDef = { id: "enriquecer", name: "Enriquecer" };

  it("a clean exit (exit 0) of harness-enrich that did NOT advance is a 'no-op' failure, not ok", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0";
    const reader = async () => "enriquecer"; // before === after ⇒ did NOT advance
    const { engine, children, finishes } = makeEngine(reader);
    engine.runSkill("storymap", "ghost-noop", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0); // CLEAN exit, but the card still sits in enriquecer
    await flush(); // the guard settles asynchronously (reads the post-run status)
    expect(
      getRunnerRegistry()
        .snapshot()
        .failures.some((f) => f.cardId === "ghost-noop" && f.reason === "no-op"),
    ).toBe(true);
    expect(finishes).toEqual([{ board: "storymap", cardId: "ghost-noop", outcome: "no-op", endedAt: expect.any(Number) }]);
  });

  it("a clean exit of harness-enrich that DID advance is a normal ok (no false positive)", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0";
    let calls = 0;
    const reader = async () => (calls++ === 0 ? "enriquecer" : "priorizar"); // advanced
    const { engine, children, finishes } = makeEngine(reader);
    engine.runSkill("storymap", "ghost-ok", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "ghost-ok")).toBe(false);
    expect(finishes).toEqual([{ board: "storymap", cardId: "ghost-ok", outcome: "ok", endedAt: expect.any(Number) }]);
  });

  it("a clean exit of a NON-advancing skill (harness-grill, HITL) that did NOT advance stays ok — never a no-op", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0";
    const reader = async () => "grill"; // before === after, but grill is human-in-the-loop → expected
    const { engine, children, finishes } = makeEngine(reader);
    const grillDef: StatusDef = { id: "grill", name: "Dúvidas" };
    engine.runSkill("storymap", "ghost-grill", "harness-grill", grillDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "ghost-grill")).toBe(false);
    expect(finishes).toEqual([{ board: "storymap", cardId: "ghost-grill", outcome: "ok", endedAt: expect.any(Number) }]);
  });
});

describe("RunnerEngine.onComplete — cascade continuation hook", () => {
  it("emits {board,cardId,trigger,outcome} when a run closes cleanly", async () => {
    // Non-isolated path: emitComplete fires synchronously at settle time. The r0zr3s block
    // covers the isolated path where emitComplete is deferred until after merge-back.
    // Uses a NON-must-advance skill (harness-do) so the clean-exit hot path stays synchronous — the
    // sucesso-fantasma guard makes the clean-exit path async ONLY for advancesOnSuccess skills.
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children } = makeEngine();
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(seen).toHaveLength(0); // not yet — the run is still in-flight
    children[0].emit("close", 0);
    expect(seen).toEqual([{ board: "acme", cardId: "story-1", trigger: "harness-do", outcome: "ok" }]);
  });

  it("reports the failing outcome (exit) for a non-zero close", async () => {
    const { engine, children } = makeEngine();
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1);
    await flush(); // failure path settles asynchronously (falha-fantasma guard reads card status)
    expect(seen).toEqual([{ board: "acme", cardId: "story-1", trigger: "harness-do", outcome: "exit" }]);
  });

  it("story-harness-cc #4: carries the structured result (agent's final message + stop subtype + cost/turns)", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children } = makeEngine();
    const seen: Array<{ result?: { finalText?: string; subtype?: string; cost?: number; turns?: number } }> = [];
    engine.onComplete((ev) => seen.push(ev as { result?: { finalText?: string; subtype?: string; cost?: number; turns?: number } }));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].stdout.emit(
      "data",
      JSON.stringify({ type: "result", subtype: "success", result: "feature shipped, tests green", total_cost_usd: 0.3, num_turns: 5 }) + "\n",
    );
    children[0].emit("close", 0);
    await flush();
    expect(seen).toHaveLength(1);
    // The captured tail replaces inference-by-side-effect: the operator/telemetry SEE what the agent reported.
    expect(seen[0].result).toEqual({ finalText: "feature shipped, tests green", subtype: "success", cost: 0.3, turns: 5 });
  });

  it("the in-flight lock is RELEASED before completion fires, so a listener can re-run the SAME card", async () => {
    // Non-isolated path so emitComplete fires synchronously. The lock-before-emit invariant holds
    // on both paths (finally releases before the if-not-deferred emit), but this test checks the
    // synchronous re-spawn which only works on the non-isolated path.
    process.env.USM_AUTORUN_WORKTREE = "0";
    // This is the cascade fix: the next skill must be spawnable from inside onComplete.
    const { engine, children, cmds } = makeEngine();
    engine.onComplete(({ board, cardId }) => {
      expect(engine.isInFlight(board, cardId)).toBe(false); // freed before the listener runs
      engine.runSkill(board, cardId, "harness-tasks", codeDef); // continue the cascade
    });
    engine.runSkill("acme", "story-1", "harness-enrich", codeDef);
    await flush();
    expect(cmds).toHaveLength(1);
    children[0].emit("close", 0); // harness-enrich done → listener spawns harness-tasks
    await flush(); // harness-tasks awaits its worktree create before spawning
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).toContain('"/harness-tasks acme/story-1"');
  });

  it("emits on the spawn-failure path too (so a failed launch never stalls the cascade)", async () => {
    const throwingSpawn = (() => {
      throw new Error("ENOENT claude");
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(throwingSpawn, makeJournal().journal, async () => null, noopWorktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    engine.runSkill("acme", "story-x", "harness-do", codeDef);
    await flush();
    expect(seen).toEqual([{ board: "acme", cardId: "story-x", trigger: "harness-do", outcome: "error" }]);
  });

  it("unsubscribe stops further completions", async () => {
    const { engine, children } = makeEngine();
    const seen: unknown[] = [];
    const off = engine.onComplete((ev) => seen.push(ev));
    off();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    expect(seen).toHaveLength(0);
  });

  it("a throwing listener doesn't break the engine (other listeners + cleanup still run)", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0";
    const { engine, children } = makeEngine();
    const seen: unknown[] = [];
    engine.onComplete(() => {
      throw new Error("listener boom");
    });
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    expect(seen).toHaveLength(1); // the second listener still fired
    expect(engine.isInFlight("acme", "story-1")).toBe(false); // cleanup completed
  });
});

describe("RunnerEngine — in-flight lock release (story-ll5zt3)", () => {
  it("releases the lock even when journal.recordFinish throws synchronously in settle()", async () => {
    // A sync-throwing journal port (valid: the port is typed `(...) => unknown`, so a non-async impl
    // is legal). `void recordFinish(...)` in settle() does NOT suppress a sync throw — the finally
    // block must guarantee the lock is freed regardless.
    const throwingJournal: RunnerJournalPort = {
      recordStart: () => {},
      recordFinish: () => { throw new Error("journal boom"); },
      markResumable: () => {},
    };
    const engine = new RunnerEngine(
      makeFakeChild as unknown as typeof import("node:child_process").spawn,
      throwingJournal,
      async () => null,
      noopWorktreeOps,
      null,
      undefined,
      NEVER_OVERLOADED,
      () => false,
      async () => null,
      async () => null,
      noopTelemetry,
    );
    // Use a real spawn factory that returns a controllable child
    const child = makeFakeChild();
    const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
    const eng = new RunnerEngine(fakeSpawn, throwingJournal, async () => null, noopWorktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    eng.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(eng.isInFlight("acme", "story-1")).toBe(true);
    child.emit("close", 0);
    // Even though journal.recordFinish throws, the lock must be released
    expect(eng.isInFlight("acme", "story-1")).toBe(false);
    // And a new run can be started immediately
    expect(eng.runSkill("acme", "story-1", "harness-do", codeDef)).toMatchObject({ ok: true });
  });

  it("releases the lock on the finishLaunchError path (spawn throws)", async () => {
    const throwingSpawn = (() => { throw new Error("ENOENT claude"); }) as unknown as typeof import("node:child_process").spawn;
    const throwingJournal: RunnerJournalPort = {
      recordStart: () => {},
      recordFinish: () => { throw new Error("journal boom"); },
      markResumable: () => {},
    };
    const engine = new RunnerEngine(throwingSpawn, throwingJournal, async () => null, noopWorktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    // Lock must be freed even when both spawn AND journal throw
    expect(engine.isInFlight("acme", "story-1")).toBe(false);
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef)).toMatchObject({ ok: true });
  });
});

describe("RunnerEngine — isolated run cascade deferred to merge-back (story-r0zr3s)", () => {
  it("does NOT fire onComplete when the run is enqueued on the merge train (emitComplete deferred)", async () => {
    // With isolation ON, a successful run commits+detaches+enqueues. The cascade must NOT fire at
    // settle time (status on main is still the old column) but AFTER the merge-back via onMergeDone.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, mergeEnqueues } = makeEngine(async () => null, { committed: true });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit+detach+enqueue are async fire-and-forget
    // The run was enqueued → onComplete must NOT have fired yet (cascade waiting for merge-back)
    expect(mergeEnqueues).toHaveLength(1);
    expect(seen).toHaveLength(0); // deferred
  });

  it("fires onComplete immediately when the isolated run has an EMPTY DIFF (nothing to merge)", async () => {
    // Empty diff → no merge enqueued → cascade should fire now (no merge-back to wait for)
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children } = makeEngine(async () => null, { committed: false });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit (empty) + remove
    expect(seen).toHaveLength(1); // immediate — no merge pending
    expect((seen[0] as { outcome: string }).outcome).toBe("ok");
  });
});

describe("RunnerEngine — sweep-commit do merge-back NUNCA destrói trabalho (story-yy3hds)", () => {
  it("re-tenta com a mensagem mínima quando o sweep-commit falha 1x — e AINDA enfileira o branch", async () => {
    // O incidente 5a3103d3: a mensagem com o Decision: do agente quebrava o commit. A proveniência
    // NUNCA pode custar o trabalho — a 2ª tentativa usa a mensagem mínima determinística (subject +
    // Run-Id, sem Decision/Model) e o fluxo normal (detach + enqueue no train) segue.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, mergeEnqueues, worktreeCommits, worktreeRemoves, worktreeDetaches, finishes } =
      makeEngine(async () => null, { commitThrowsTimes: 1 });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit (falha) → fallback commit → detach → enqueue (async fire-and-forget)
    expect(worktreeCommits).toHaveLength(2);
    // A 2ª mensagem é a MÍNIMA: subject + Run-Id apenas — nada do finalText do agente.
    expect(worktreeCommits[1].message).toMatch(/^usm\(harness-do\): acme\/story-1 \[run [\w-]+\]\n\nRun-Id: [\w-]+$/);
    expect(worktreeCommits[1].message).not.toContain("Decision:");
    expect(mergeEnqueues).toHaveLength(1); // o trabalho AINDA integra
    expect(worktreeDetaches).toHaveLength(1);
    expect(worktreeRemoves).toHaveLength(0); // nada foi destruído
    expect(finishes.at(-1)?.outcome).toBe("ok");
    expect(seen).toHaveLength(0); // cascade deferida ao onMergeDone, como todo enqueue
  });

  it("PRESERVA worktree+branch e assenta falha visível quando o commit falha TODAS as tentativas", async () => {
    // Defesa em profundidade: commit + fallback falharam (secret-scan block, git doente). O antigo
    // caminho force-removia o worktree com o trabalho não-commitado dentro e o run assentava "ok"
    // (sucesso-fantasma). Agora: NENHUM remove, journal vira "error" (visível em Processos), e a
    // cascade ainda emite (nunca se perde permanentemente).
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, mergeEnqueues, worktreeCommits, worktreeRemoves, worktreeDetaches, finishes } =
      makeEngine(async () => null, { commitThrowsTimes: 2 });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit (falha) → fallback (falha) → preserve + falha visível
    expect(worktreeCommits).toHaveLength(2); // tentou a mensagem completa E a mínima
    expect(worktreeRemoves).toHaveLength(0); // NUNCA destrói o trabalho não-commitado
    expect(worktreeDetaches).toHaveLength(0); // o dir fica no lugar p/ recuperação manual
    expect(mergeEnqueues).toHaveLength(0);
    // settle registrou "ok" (o exit foi limpo) e o catch FLIPOU o outcome durável para "error".
    expect(finishes.map((f) => f.outcome)).toEqual(["ok", "error"]);
    expect(seen).toHaveLength(1); // a cascade não se perde
  });
});

describe("RunnerEngine.runSkill — board-data (isCode:false) runs edit main live, NO worktree (story-apz8sa)", () => {
  // The fast column an isCode:false skill (harness-enrich) is triggered from. harness-enrich is
  // advancesOnSuccess:true, so the sucesso-fantasma guard reads the post-run status off MAIN (no
  // worktree) — an ADVANCING reader is what makes a clean exit a real "ok" (and thus commit board-data),
  // a non-advancing one a "no-op" (and thus NOT commit).
  const fastDef: StatusDef = { id: "enriquecer", name: "Enriquecer" };
  // A reader that reports the card advanced out of `enriquecer` after the run — so harness-enrich's clean
  // exit is a genuine success (not a sucesso-fantasma no-op).
  const advancingReader = () => {
    let calls = 0;
    return async () => (calls++ === 0 ? "enriquecer" : "priorizar");
  };

  it("creates NO worktree, spawns in repoRoot, and never enqueues a merge — even with isolation ON", async () => {
    // The CORE of the fix: with USM_AUTORUN_WORKTREE=1, a CODE run would allocate a worktree + commit
    // boundary-1 + enqueue. A board-data run (harness-enrich) must do NONE of that — it edits main live.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const repoRoot = findRepoRoot();
    const { engine, cmds, spawnOpts, worktreeCreates, worktreeBoardCommits, mergeEnqueues } = makeEngine(
      advancingReader(),
    );
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    expect(cmds).toHaveLength(1); // it DID spawn
    expect(spawnOpts[0].cwd).toBe(repoRoot); // …in the MAIN tree, not a worktree
    expect(worktreeCreates).toHaveLength(0); // NO ephemeral worktree
    expect(worktreeBoardCommits).toHaveLength(0); // NO boundary-1 HEAD=estado commit before the spawn
    expect(mergeEnqueues).toHaveLength(0); // NO merge-train entry
  });

  it("on a clean (advancing) exit, commits its board-data on main via the per-cwd serializer", async () => {
    // The skill wrote the card .md straight on main but never committed — settle must sweep it into one
    // `board:`-prefixed commit on repoRoot, routed through the injected commitSerializer (keyed by cwd).
    process.env.USM_AUTORUN_WORKTREE = "1";
    const repoRoot = findRepoRoot();
    const serializerCwds: string[] = [];
    const recordingSerializer: CommitSerializer = (cwd, fn) => {
      serializerCwds.push(cwd);
      return fn();
    };
    const { engine, children, worktreeBoardCommits } = makeEngine(advancingReader(), {
      commitSerializer: recordingSerializer,
    });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    expect(worktreeBoardCommits).toHaveLength(0); // nothing before the spawn (no boundary-1)
    children[0].emit("close", 0); // clean exit → advancingReader makes it a real success
    await flush(); // sucesso-fantasma guard reads status, then settle commits board-data
    await flush(); // the fire-and-forget commit + its .finally(emitComplete)
    // Exactly one board-data commit, on main, with the `board:`-prefixed message.
    expect(worktreeBoardCommits).toHaveLength(1);
    expect(worktreeBoardCommits[0].repoRoot).toBe(repoRoot);
    expect(worktreeBoardCommits[0].message).toContain("board:");
    // It went through the per-cwd serializer keyed on repoRoot (the shared merge-train mutex).
    expect(serializerCwds).toContain(repoRoot);
    // The cascade fired AFTER the commit resolved (deferred, not synchronous).
    expect(seen).toEqual([{ board: "storymap", cardId: "c1", trigger: "harness-enrich", outcome: "ok", toolGap: [] }]);
  });

  it("a FAILED board-data run does NOT commit anything (failure must not persist partial board edits)", async () => {
    // A non-zero / killed isCode:false run leaves the dirty tree alone — the operator re-runs; we never
    // turn a partial edit into a clean `board:` commit.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const reader = async () => "enriquecer"; // never advances → the killed run is a real failure
    const { engine, children, worktreeBoardCommits, finishes } = makeEngine(reader);
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", null, "SIGKILL"); // killed before any advance
    await flush();
    expect(worktreeBoardCommits).toHaveLength(0); // NO commit on the failure path
    expect(finishes.some((f) => f.outcome === "exit")).toBe(true); // settled as a real failure
  });

  it("two concurrent board-data runs on DIFFERENT cards both commit through the SAME repoRoot serial chain (AC3)", async () => {
    // Concurrency safety: distinct cards write path-disjoint files, and BOTH board-data commits route
    // through the per-cwd serializer keyed on repoRoot — so they serialize on one chain (no .git/index
    // race), never interleave. boardCommitDelayMs holds the first commit open across a macrotask so a
    // non-serialized impl WOULD overlap; the recording serializer asserts the single ordered chain.
    process.env.USM_AUTORUN_WORKTREE = "1";
    process.env.USM_AUTORUN_MAX = "2"; // both run at once
    const repoRoot = findRepoRoot();
    // A faithful per-cwd serializer (mirrors serialCommit) that records start/end ordering so we can
    // assert the second commit only STARTS after the first SETTLES (no overlap on the shared index).
    const chains = new Map<string, Promise<unknown>>();
    const events: string[] = [];
    // Every link handed to the serializer, so the assertions below can wait on the CHAIN ITSELF instead
    // of on the clock — see the settle comment further down.
    const chainSettled: Array<Promise<unknown>> = [];
    let seq = 0;
    const orderingSerializer: CommitSerializer = <T,>(cwd: string, fn: () => Promise<T>): Promise<T> => {
      const id = ++seq;
      const prev = chains.get(cwd) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(async () => {
        events.push(`start-${id}-${cwd}`);
        const r = await fn();
        events.push(`end-${id}-${cwd}`);
        return r;
      });
      chains.set(cwd, next.catch(() => {}));
      chainSettled.push(next.catch(() => {}));
      return next;
    };
    // PER-CARD advancing reader: each card independently reads `enriquecer` first (before) then
    // `priorizar` (after) — so BOTH harness-enrich runs are genuine successes (not sucesso-fantasma no-ops),
    // and both reach the board-data commit. A single shared counter would starve the 2nd run's advance.
    const seenByCard = new Map<string, number>();
    const perCardAdvancingReader = async (_board: string, cardId: string) => {
      const n = seenByCard.get(cardId) ?? 0;
      seenByCard.set(cardId, n + 1);
      return n === 0 ? "enriquecer" : "priorizar";
    };
    const { engine, children, worktreeBoardCommits } = makeEngine(perCardAdvancingReader, {
      commitSerializer: orderingSerializer,
      boardCommitDelayMs: 5,
    });
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    engine.runSkill("storymap", "c2", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0);
    children[1].emit("close", 0);
    // Wait on the CHAIN, never on the clock. This used to be `setTimeout(…, 40)`, and the 40ms budget
    // raced two CHAINED 5ms timers whose second one is only armed once the loop runs again — so any
    // event-loop stall past ~34ms (six vitest forks on a 6-vCPU box under load: routine) let the deadline
    // win and `endIdxs` came back with 1 instead of 2. A red that says nothing about serialization.
    // `next` resolves only AFTER `end-${id}` is pushed, so once these settle the events are all there,
    // however preempted the loop was. The flush is what lets both settles reach the serializer;
    // `boardCommitDelayMs: 5` stays, since holding each fn() open across a real macrotask is exactly what
    // a NON-serialized implementation would overlap on.
    await flush();
    await Promise.all(chainSettled);
    // Both committed their board-data on main.
    expect(worktreeBoardCommits).toHaveLength(2);
    expect(worktreeBoardCommits.every((c) => c.repoRoot === repoRoot)).toBe(true);
    // Both routed through the SAME repoRoot chain and DID NOT overlap: the first commit ENDED before the
    // second one STARTED (start-N, end-N, start-M, end-M — never start-N, start-M).
    const startIdxs = events.map((e, i) => (e.startsWith("start-") ? i : -1)).filter((i) => i >= 0);
    const endIdxs = events.map((e, i) => (e.startsWith("end-") ? i : -1)).filter((i) => i >= 0);
    expect(startIdxs).toHaveLength(2);
    expect(endIdxs).toHaveLength(2);
    // The 2nd start comes AFTER the 1st end → serialized, no interleave.
    expect(startIdxs[1]).toBeGreaterThan(endIdxs[0]);
  });

  it("FIX 1: a settled board-data run PUSHES its `board:` commit to origin (cumulative push, durable)", async () => {
    // Prod runs worktreeIsolation=TRUE: pre-apz8sa a board-data run reached origin via worktree→merge-
    // train→push. With the no-worktree settle, the commit lands local-only — so it MUST push to origin
    // (via commitBoardStateAndPush → the shared pushHeadToOrigin) or other checkouts never see the edit.
    process.env.USM_AUTORUN_WORKTREE = "1";
    process.env.STORYMAP_BOARD_AUTOPUSH = "1"; // o push é declarado desde a auditoria de 2026-08-19
    const repoRoot = findRepoRoot();
    const { engine, children, worktreeBoardCommits, worktreeBoardPushes } = makeEngine(advancingReader(), {
      boardDataCommitted: true, // the skill wrote the card .md → a real commit to push
    });
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0); // clean, advancing exit → genuine success
    await flush(); // sucesso-fantasma guard, then the settle commit+push
    await flush(); // the fire-and-forget commit+push + its .finally(emitComplete)
    // Exactly one board-data commit on main, and it was PUSHED to origin (the cumulative push landed).
    expect(worktreeBoardCommits).toHaveLength(1);
    expect(worktreeBoardCommits[0].repoRoot).toBe(repoRoot);
    expect(worktreeBoardPushes).toHaveLength(1);
    expect(worktreeBoardPushes[0]).toMatchObject({ repoRoot, pushed: true });
    expect(worktreeBoardPushes[0].message).toContain("board:");
  });

  it("FIX 1: a FAILED/cancelled board-data run commits NOTHING, so it pushes NOTHING", async () => {
    // The push is GATED on a real commit: a killed isCode:false run leaves the dirty tree alone (no
    // commit), so there is nothing to push — origin is never touched by an incomplete board edit.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const reader = async () => "enriquecer"; // never advances → the killed run is a real failure
    const { engine, children, worktreeBoardCommits, worktreeBoardPushes, finishes } = makeEngine(reader);
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", null, "SIGKILL"); // killed before any advance
    await flush();
    await flush();
    expect(worktreeBoardCommits).toHaveLength(0); // failure path: no settle commit at all
    expect(worktreeBoardPushes).toHaveLength(0); // …therefore no push to origin
    expect(finishes.some((f) => f.outcome === "exit")).toBe(true); // settled as a real failure
  });

  it("[ATAQUE] SEM a declaração de push, o settle versiona local e NÃO toca no `origin` do adotante", async () => {
    // Auditoria de extração (2026-08-19): este era o segundo caminho — além do flush da interface —
    // que empurrava board-data para o remoto de quem instalou a ferramenta, sem knob e sem aviso. A
    // durabilidade não se perde: `git push` é cumulativo, então o próximo merge-back de um run de
    // CÓDIGO leva o commit junto.
    process.env.USM_AUTORUN_WORKTREE = "1";
    delete process.env.STORYMAP_BOARD_AUTOPUSH;
    const { engine, children, worktreeBoardCommits, worktreeBoardPushes } = makeEngine(advancingReader(), {
      boardDataCommitted: true,
    });
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    await flush();
    expect(worktreeBoardCommits, "o commit local continua acontecendo — é o valor do produto").toHaveLength(1);
    expect(worktreeBoardPushes, "nenhum push sem declaração").toHaveLength(0);
  });

  it("FIX 1: a FAILED push is non-fatal — the run still completes (push is cumulative, recovers later)", async () => {
    // FAIL-OPEN: an origin outage (boardDataPushFails) must NOT crash the run or lose the cascade — the
    // commit is local-durable and the next push recovers it. The cascade still fires (deferred).
    process.env.USM_AUTORUN_WORKTREE = "1";
    process.env.STORYMAP_BOARD_AUTOPUSH = "1";
    const { engine, children, worktreeBoardCommits, worktreeBoardPushes } = makeEngine(advancingReader(), {
      boardDataCommitted: true,
      boardDataPushFails: true, // origin rejects the push (and the reconcile didn't recover it)
    });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    await flush();
    expect(worktreeBoardCommits).toHaveLength(1); // the commit still landed locally (durable)
    expect(worktreeBoardPushes[0].pushed).toBe(false); // …the push failed, but non-fatally
    // The cascade still fired despite the push failure — a board edit is never lost to a push outage.
    expect(seen).toEqual([{ board: "storymap", cardId: "c1", trigger: "harness-enrich", outcome: "ok", toolGap: [] }]);
  });

  it("FIX 2: a settle that ABORTS (staged diff touched code) loses no cascade and never commits code", async () => {
    // The scoped commit aborts (the FIX 2 defense-in-depth guard / secret-scan reject) → the
    // commitBoardStateAndPush promise REJECTS. The engine swallows it (logged) and STILL fires the
    // deferred cascade — a misclassified run can never write code to main as board data, and the card
    // is not silently stranded (the next code run's boundary-1 sweeps any legit leftover board delta).
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, worktreeBoardPushes } = makeEngine(advancingReader(), {
      boardDataCommitThrows: true, // models the code-guard / secret-scan abort
    });
    const seen: unknown[] = [];
    engine.onComplete((ev) => seen.push(ev));
    engine.runSkill("storymap", "c1", "harness-enrich", fastDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    await flush();
    expect(worktreeBoardPushes).toHaveLength(0); // the commit rejected before staging anything → no push
    // The cascade still fired (deferred via .finally) so the abort never deadlocks the pipeline.
    expect(seen).toEqual([{ board: "storymap", cardId: "c1", trigger: "harness-enrich", outcome: "ok", toolGap: [] }]);
  });
});

describe("RunnerEngine.runSkill — isCode:true runs STILL isolate + enqueue (story-apz8sa regression)", () => {
  it("harness-do (isCode:true) with isolation ON still creates a worktree, commits boundary-1, and enqueues", async () => {
    // The mirror assertion: the fix gates the worktree on isCode, so a CODE run must keep the UNCHANGED
    // behavior — exactly what the l.494 journal test + the r0zr3s deferral test cover, asserted here
    // explicitly as an isCode-gated regression guard.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, spawnOpts, worktreeCreates, worktreeBoardCommits, mergeEnqueues } = makeEngine(
      async () => null,
      { committed: true },
    );
    engine.runSkill("storymap", "c1", "harness-do", codeDef);
    await flush();
    expect(worktreeCreates).toHaveLength(1); // CODE run → ephemeral worktree
    expect(spawnOpts[0].cwd).toBe(worktreeCreates[0].worktreePath); // spawned IN the worktree
    expect(worktreeBoardCommits).toHaveLength(1); // boundary-1 HEAD=estado commit before the spawn
    children[0].emit("close", 0);
    await flush(); // commit+detach+enqueue (async)
    expect(mergeEnqueues).toHaveLength(1); // …and the branch went to the merge train
  });
});

describe("buildClaudeCommand / quoteArg — shell command assembly", () => {
  it("quotes a token with a space, leaves plain tokens bare", () => {
    expect(quoteArg("opus")).toBe("opus");
    expect(quoteArg("--model")).toBe("--model");
    expect(quoteArg("storymap/qa mcp.json")).toBe('"storymap/qa mcp.json"');
  });

  it("HARDENING 1.3: quotes shell metacharacters (parens/glob/`;`/`$`), keeps safe-set tokens bare", () => {
    // canonical `--allowedTools Tool(specifier)` values carry parens/glob — unquoted under `sh -c` they are a
    // syntax error that kills the WHOLE spawn, so they must be quoted:
    expect(quoteArg("Bash(git:*)")).toBe('"Bash(git:*)"');
    expect(quoteArg("Read(//abs)")).toBe('"Read(//abs)"');
    expect(quoteArg("a;b")).toBe('"a;b"');
    expect(quoteArg("$FOO")).toBe('"$FOO"');
    // shell-neutral tokens (identifiers, mcp tool names, model ids, flags) stay bare:
    expect(quoteArg("mcp__storymap__get_card")).toBe("mcp__storymap__get_card");
    expect(quoteArg("stream-json")).toBe("stream-json");
    expect(quoteArg("--allowedTools")).toBe("--allowedTools");
    expect(quoteArg("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(quoteArg("--dangerously-skip-permissions")).toBe("--dangerously-skip-permissions");
  });

  it("HARDENING 1.3: an assembled command with allowedTools Tool(specifier) parses under `sh -n`", () => {
    // The regression the fix closes: an unquoted `Bash(git:*)` makes `sh -c` fail with a syntax error before
    // claude ever runs. Assemble a realistic command and assert the shell parses it (no execution).
    const cmd = buildClaudeCommand("claude", "/storymap-orchestrator storymap manual --tick", "storymap/x", [
      "--allowedTools",
      "Bash(git:*),mcp__storymap__get_card,Read(//abs)",
      "--dangerously-skip-permissions",
    ]);
    const parsed = spawnSync("sh", ["-n", "-c", cmd]);
    expect(parsed.status).toBe(0); // parens survived quoting → no shell syntax error → the spawn survives
  });

  it("assembles the prompt + quoted flags into one command line", () => {
    const cmd = buildClaudeCommand("claude", "/harness-do", "acme/story-1", [
      "--dangerously-skip-permissions",
      "--mcp-config",
      "storymap/qa mcp.json",
    ]);
    expect(cmd).toBe(
      'claude -p "/harness-do acme/story-1" --dangerously-skip-permissions --mcp-config "storymap/qa mcp.json"',
    );
  });
});

describe("buildResumeCommand — headless `claude --resume` revives a crashed run's session (story-watchdog)", () => {
  it("assembles a print-mode resume: re-issues the prompt AND binds the prior session via --resume", () => {
    const cmd = buildResumeCommand("claude", "/harness-do", "storymap/story-1", "sess-abc", [
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
    ]);
    // -p keeps it headless (stream-json output requires --print); --resume <id> carries the
    // transcript + checkpoint so the skill continues instead of starting over (AC1/AC2).
    expect(cmd).toBe(
      'claude -p "/harness-do storymap/story-1" --resume sess-abc --dangerously-skip-permissions --output-format stream-json',
    );
  });

  it("quotes a flag value with a space (same shell-safety as buildClaudeCommand)", () => {
    const cmd = buildResumeCommand("claude", "/harness-do", "acme/s1", "s2", ["--mcp-config", "storymap/qa mcp.json"]);
    expect(cmd).toBe('claude -p "/harness-do acme/s1" --resume s2 --mcp-config "storymap/qa mcp.json"');
  });
});

describe("SM-09 — per-app context note injected into the spawn prompt", () => {
  const cfg = (over: Partial<BoardConfig>): BoardConfig => ({
    id: "x", name: "X", statuses: [], releases: [], personas: [], systems: [], linkTypes: [], ...over,
  });

  describe("brandbookPathFor — board.yaml `brandbook:` field → brand-voice doc", () => {
    it("returns the configured brandbook path", () => {
      expect(brandbookPathFor(cfg({ brandbook: "docs/business/brandbooks/brandbook-acmeapp.md" }))).toBe(
        "docs/business/brandbooks/brandbook-acmeapp.md",
      );
    });
    it("returns null when no brandbook is configured, or config is null", () => {
      expect(brandbookPathFor(cfg({ package: "packages/storymap-ui" }))).toBeNull();
      expect(brandbookPathFor(null)).toBeNull();
    });
    it("fails open to null on a shell-unsafe brandbook path (interpolated into the spawn -p)", () => {
      expect(brandbookPathFor(cfg({ brandbook: "docs/x`id`.md" }))).toBeNull();
      expect(brandbookPathFor(cfg({ brandbook: 'docs/x"; rm -rf /; ".md' }))).toBeNull();
    });
  });

  describe("buildContextNote — package CLAUDE.md (+ brandbook) read-this-first", () => {
    it("AC4: a null config (read failure) yields NO note — omitted silently", () => {
      expect(buildContextNote(null)).toBeNull();
    });

    it("AC4: a config without `package:` yields NO note (no path to read) — never throws", () => {
      expect(buildContextNote(cfg({ id: "acme", name: "Nest", package: undefined }))).toBeNull();
    });

    it("a board WITH a brandbook names both the package CLAUDE.md and the brandbook", () => {
      const note = buildContextNote(
        cfg({ id: "acme", name: "Nest", package: "packages/acmeapp", brandbook: "docs/business/brandbooks/brandbook-acmeapp.md" }),
      );
      expect(note).toBe(
        "Context: antes de qualquer ação de código ou copy, leia packages/acmeapp/.claude/CLAUDE.md e docs/business/brandbooks/brandbook-acmeapp.md para respeitar as convenções específicas deste app.",
      );
    });

    it("AC4: a board WITHOUT a brandbook (storymap) names ONLY the package CLAUDE.md — no brandbook clause", () => {
      const note = buildContextNote(cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }));
      expect(note).toBe(
        "Context: antes de qualquer ação de código ou copy, leia packages/storymap-ui/.claude/CLAUDE.md para respeitar as convenções específicas deste app.",
      );
      expect(note).not.toContain("brandbook");
    });

    it("a `package:` carrying shell metacharacters yields NO note — fail-open to the legacy prompt", () => {
      // `package` is read raw from board.yaml; it is interpolated into the `-p "..."` shell command,
      // so a stray quote/`$`/`;`/backtick must NOT reach the command line.
      for (const evil of ['packages/x"; rm -rf /; "', "packages/x$(whoami)", "packages/`id`", "a b"]) {
        expect(buildContextNote(cfg({ id: "acme", name: "Nest", package: evil }))).toBeNull();
      }
    });

    it("personas-as-prompt: appends a SHELL-SAFE persona pointer (ids + board slug only) when given persona ids", () => {
      const note = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap", personaIds: ["bruno", "marina"] },
      );
      expect(note).toContain("packages/storymap-ui/.claude/CLAUDE.md");
      expect(note).toContain("atende a(s) persona(s) bruno, marina");
      expect(note).toContain("storymap/boards/storymap/board.yaml");
    });

    it("personas-as-prompt: drops persona ids / board that aren't slug-safe (never reach the shell)", () => {
      const note = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap", personaIds: ['bad"; rm -rf /', "ok-id", "a b"] },
      );
      expect(note).toContain("atende a(s) persona(s) ok-id");
      expect(note).not.toContain("rm -rf");
      expect(note).not.toContain("a b");
    });

    it("personas-as-prompt: an unsafe board slug drops the persona clause entirely (fail-open)", () => {
      const note = buildContextNote(
        cfg({ id: "x", name: "X", package: "packages/storymap-ui" }),
        { board: "bad board", personaIds: ["bruno"] },
      );
      expect(note).not.toContain("persona");
    });

    it("personas-as-prompt: no persona clause when personaIds is empty/absent", () => {
      const base = cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" });
      const comBoard = buildContextNote(base, { board: "storymap", personaIds: [] });
      const semBoard = buildContextNote(base);

      for (const note of [comBoard, semBoard]) {
        expect(note).toContain("leia packages/storymap-ui/.claude/CLAUDE.md");
        expect(note).not.toContain("persona");
      }
      // SEM board não há slug shell-safe para citar, então a nota para aí — é a mesma régua fail-open
      // das cláusulas de persona e de sistema.
      expect(semBoard).not.toContain("prd.md");
    });

    it("PRD: aponta para o documento, e o ponteiro é INCONDICIONAL", () => {
      // Incondicional de propósito. A condição antiga ("o board tem `positioning` ou `desiredOutcome`
      // no board.yaml?") deixou de ser avaliável a partir do `boardConfig`: um board que escreveu o
      // `docs/prd.md` e nunca teve a escada antiga tem norte E falharia na condição — o agente
      // rodaria sem saber que existe onde olhar. O caminho é o mesmo nos dois casos, e um PRD vazio
      // devolve o esqueleto, que É a resposta certa ("este board ainda não declarou norte").
      const semEscada = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap" },
      );
      const comEscada = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui", desiredOutcome: "Levar ideias ao ar sozinhas" }),
        { board: "storymap" },
      );

      for (const note of [semEscada, comEscada]) {
        expect(note).toContain("storymap/boards/storymap/docs/prd.md");
        expect(note).toContain("Decisões já tomadas");
      }
      // O VALOR nunca viaja inline — a nota é interpolada verbatim num `-p "..."`, e o texto do PRD
      // carrega aspas, `$` e quebras de linha.
      expect(comEscada).not.toContain("Levar ideias ao ar sozinhas");
    });

    it("PRD: o ponteiro cai inteiro quando o slug do board é inseguro (fail-open, nunca chega ao shell)", () => {
      const note = buildContextNote(
        cfg({ id: "x", name: "X", package: "packages/storymap-ui", positioning: "Para PMs..." }),
        { board: "bad board" },
      );
      expect(note).not.toContain("prd.md");
      expect(note).not.toContain("bad board");
    });

    it("systems-as-prompt: appends a SHELL-SAFE systems pointer (ids + board slug only) when given system ids", () => {
      const note = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap", systemIds: ["engine", "merge-queue"] },
      );
      expect(note).toContain("toca o(s) sistema(s) engine, merge-queue");
      expect(note).toContain("bloco `systems` em storymap/boards/storymap/board.yaml");
      expect(note).toContain("respeite as capacidades e limites");
    });

    it("personas + systems: both clauses appended (persona before system), each shell-safe", () => {
      const note = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap", personaIds: ["bruno"], systemIds: ["engine", 'bad"; rm -rf /'] },
      );
      expect(note).toContain("atende a(s) persona(s) bruno");
      expect(note).toContain("toca o(s) sistema(s) engine");
      expect(note).not.toContain("rm -rf");
      // persona clause comes before the system clause
      const n = note ?? "";
      expect(n.indexOf("persona(s)")).toBeLessThan(n.indexOf("sistema(s)"));
    });

    it("addressed idea: appends a SHELL-SAFE pointer to the idea card the story addresses", () => {
      const note = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap", addressedIdeaId: "idea-abc" },
      );
      expect(note).toContain("endereça a ideia idea-abc");
      expect(note).toContain("storymap/boards/storymap/cards/idea-abc.md");
      expect(note).toContain("focado em fechá-la");
    });

    it("addressed idea: clause dropped when the idea id is unsafe (fail-open, never reaches the shell)", () => {
      const note = buildContextNote(
        cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" }),
        { board: "storymap", addressedIdeaId: 'bad"; rm -rf /' },
      );
      expect(note).not.toContain("rm -rf");
      expect(note).not.toContain("endereça a ideia");
    });

    it("addressed idea: sem cláusula quando ausente/null", () => {
      const base = cfg({ id: "storymap", name: "AgileHarness", package: "packages/storymap-ui" });
      for (const note of [
        buildContextNote(base, { board: "storymap", addressedIdeaId: null }),
        buildContextNote(base, { board: "storymap" }),
      ]) {
        expect(note).not.toContain("ideia");
        // A nota deixou de ser byte-idêntica ao "legacy" porque o ponteiro do PRD é incondicional
        // (ver o teste do PRD acima) — o que esta asserção mede é a AUSÊNCIA da cláusula de ideia,
        // e é isso que ela continua medindo.
        expect(note).toContain("leia packages/storymap-ui/.claude/CLAUDE.md");
      }
    });
  });

  describe("styleGuidePathFor — D13 canal 1: board slug → derived style-guide path (NEVER a stored path)", () => {
    it("returns the derived path when the board has a published guide", () => {
      expect(styleGuidePathFor("acme", cfg({ id: "acme", name: "Nest", styleGuide: { version: 3, hash: "abc123" } }))).toBe(
        "storymap/boards/acme/design/style-guide.md",
      );
    });
    it("returns null when the board has no guide yet (D16 fail-open)", () => {
      expect(styleGuidePathFor("acme", cfg({ id: "acme", name: "Nest" }))).toBeNull();
      expect(styleGuidePathFor("acme", null)).toBeNull();
    });
    it("returns null on a hostile/off-charset boardId even with a guide present (fail-open, never reaches the shell)", () => {
      expect(
        styleGuidePathFor('bad"; rm -rf /', cfg({ id: "x", name: "X", styleGuide: { version: 1, hash: "h" } })),
      ).toBeNull();
      expect(styleGuidePathFor("", cfg({ id: "x", name: "X", styleGuide: { version: 1, hash: "h" } }))).toBeNull();
    });
  });

  describe("buildStyleGuideNote — D13 canal 1: the path-only pointer note (SEPARATE from buildContextNote)", () => {
    it("board WITH a guide → note contains the derived path and the version", () => {
      const note = buildStyleGuideNote("acme", cfg({ id: "acme", name: "Nest", styleGuide: { version: 3, hash: "abc123" } }));
      expect(note).toBe(
        "O board tem guia de estilo em storymap/boards/acme/design/style-guide.md (v3) — leia ANTES de qualquer trabalho de UI, copy ou frontend; para outros trabalhos, ignore.",
      );
    });

    it("board WITH a guide AND WITHOUT `package:` → note still PRESENT (the case that would die inside buildContextNote, which returns null early for a package-less board)", () => {
      const config = cfg({ id: "acme", name: "Nest", package: undefined, styleGuide: { version: 1, hash: "h" } });
      expect(buildContextNote(config)).toBeNull();
      const note = buildStyleGuideNote("acme", config);
      expect(note).not.toBeNull();
      expect(note).toContain("storymap/boards/acme/design/style-guide.md");
    });

    it("board WITHOUT a guide → prompt unchanged (null, composeSystemPrompt drops it)", () => {
      expect(buildStyleGuideNote("acme", cfg({ id: "acme", name: "Nest" }))).toBeNull();
      expect(buildStyleGuideNote("acme", null)).toBeNull();
    });

    it("hostile boardId → null (fail-open) even when the board has a guide", () => {
      expect(
        buildStyleGuideNote('bad"; rm -rf /', cfg({ id: "x", name: "X", styleGuide: { version: 2, hash: "h" } })),
      ).toBeNull();
    });

    it("never inlines guide content — only the derived path + version ride the note", () => {
      const note = buildStyleGuideNote("acme", cfg({ id: "acme", name: "Nest", styleGuide: { version: 5, hash: "deadbeef" } }));
      expect(note).not.toContain("deadbeef"); // the hash never rides the note, only version
    });
  });

  describe("buildClaudeCommand / buildResumeCommand carry the note inside the -p prompt", () => {
    const note = "Context: leia packages/acmeapp/.claude/CLAUDE.md";

    it("retrocompat: omitting contextNote reproduces the legacy command byte-for-byte", () => {
      expect(buildClaudeCommand("claude", "/harness-do", "acme/s1", ["--x"])).toBe('claude -p "/harness-do acme/s1" --x');
      expect(buildClaudeCommand("claude", "/harness-do", "acme/s1", ["--x"], null)).toBe('claude -p "/harness-do acme/s1" --x');
    });

    it("appends the note after a blank line, still inside the -p double quotes (fresh run)", () => {
      const cmd = buildClaudeCommand("claude", "/harness-do", "acme/s1", ["--x"], note);
      expect(cmd).toBe(`claude -p "/harness-do acme/s1\n\n${note}" --x`);
    });

    it("a resumed run carries the note too (parity with the fresh spawn)", () => {
      const cmd = buildResumeCommand("claude", "/harness-do", "acme/s1", "sess", ["--x"], note);
      expect(cmd).toBe(`claude -p "/harness-do acme/s1\n\n${note}" --resume sess --x`);
    });
  });

  describe("composeSystemPrompt + systemPromptFor (story-harness-cc #1/#3)", () => {
    it("composeSystemPrompt: null when both parts are absent/blank", () => {
      expect(composeSystemPrompt(null, null)).toBeNull();
      expect(composeSystemPrompt("", "  ")).toBeNull();
    });

    it("composeSystemPrompt: returns the single non-empty part alone", () => {
      expect(composeSystemPrompt("note", null)).toBe("note");
      expect(composeSystemPrompt(null, "invariants")).toBe("invariants");
    });

    it("composeSystemPrompt: joins both with a blank line (contextNote first)", () => {
      expect(composeSystemPrompt("note", "invariants")).toBe("note\n\ninvariants");
    });

    it("composeSystemPrompt: variadic — joins 3 parts in order, skipping the blank middle (story-harness-adk A1)", () => {
      expect(composeSystemPrompt("note", "snapshot", "invariants")).toBe("note\n\nsnapshot\n\ninvariants");
      expect(composeSystemPrompt("note", null, "invariants")).toBe("note\n\ninvariants");
      expect(composeSystemPrompt(null, "snapshot", null)).toBe("snapshot");
    });

    it("systemPromptFor: a CODE skill defaults to the shared CODE_SKILL_INVARIANTS", () => {
      expect(systemPromptFor("harness-do")).toBe(CODE_SKILL_INVARIANTS);
      expect(systemPromptFor("harness-review")).toBe(CODE_SKILL_INVARIANTS);
    });

    // BEHAVIOR CHANGE (2026-07-18): the light lane used to get NO system prompt, on the theory that "its
    // conventions ride in the per-app contextNote". The contextNote carries APP conventions; it never
    // carried the run's own standing — and the light lane is exactly the lane that writes board-data in the
    // runtime checkout under an exemption it could not discover. acme/story-tlz0dt: a harness-grill run read the
    // "board-data only via MCP" doctrine, could not find the clause exempting engine runs (the root file
    // never names STORYMAP_AUTORUN_RUN_ID; the file that does is package-scoped), abandoned the Edit it was
    // granted, chased an MCP tool it was not, and spent its budget asking a human who does not exist.
    it("systemPromptFor: a light-lane skill carries the BOARD-DATA invariants (it must know its own standing)", () => {
      expect(systemPromptFor("harness-grill")).toBe(BOARD_DATA_SKILL_INVARIANTS);
      expect(systemPromptFor("harness-prioritize")).toBe(BOARD_DATA_SKILL_INVARIANTS);
    });

    it("the light-lane invariants state the exemption, the empty MCP surface, and the no-human rule", () => {
      // Asserting the SUBSTANCE, not the prose: each clause is one of the three beliefs that stalled the run.
      expect(BOARD_DATA_SKILL_INVARIANTS).toContain("STORYMAP_AUTORUN_RUN_ID"); // self-verifiable, unlike the doc
      expect(BOARD_DATA_SKILL_INVARIANTS).toMatch(/Edit\/Write/); // write directly — the granted path
      expect(BOARD_DATA_SKILL_INVARIANTS).toMatch(/não existe humano/i); // never end a turn asking permission
    });

    // WS3 (F2) — the toolkit note is fail-open byte-identical: no toolkit ⇒ null ⇒ dropped by
    // composeSystemPrompt ⇒ the prompt file is unchanged from the legacy body.
    it("buildToolkitNote: null when the toolkit is absent OR has no guidance/specialists (byte-identical body)", () => {
      expect(buildToolkitNote(null)).toBeNull();
      expect(buildToolkitNote({ mcpConfigPaths: ["x"], allowedTools: [], specialists: [], expects: [] })).toBeNull();
      // proof of byte-identity: a null toolkit note leaves composeSystemPrompt's output unchanged.
      const base = composeSystemPrompt("ctx", "snap", "invariants");
      expect(composeSystemPrompt("ctx", "snap", buildToolkitNote(null), "invariants")).toBe(base);
    });

    it("buildToolkitNote: emits the guidance directive, plus a specialists clause when declared", () => {
      const note = buildToolkitNote({
        mcpConfigPaths: [],
        allowedTools: [],
        specialists: [{ id: "security", agent: "security-reviewer", when: "rules, auth, pagamentos" }],
        expects: [],
        guidance: "Consulte query_graph do codegraph ANTES de propor arquitetura.",
      });
      expect(note).toContain("query_graph do codegraph ANTES");
      expect(note).toContain("Especialistas disponíveis");
      expect(note).toContain("- security-reviewer: rules, auth, pagamentos");
      expect(note).toContain("```json"); // the output contract is named
    });

    it("buildToolkitNote (WS4): filters an off-charset agent slug against SAFE_SLUG (injection guard)", () => {
      const note = buildToolkitNote({
        mcpConfigPaths: [],
        allowedTools: [],
        specialists: [
          { id: "evil", agent: "x; rm -rf /", when: "nunca" },
          { id: "ok", agent: "security-reviewer", when: "rules" },
        ],
        expects: [],
      });
      expect(note).not.toContain("rm -rf"); // the unsafe slug is dropped
      expect(note).toContain("- security-reviewer: rules"); // the safe one survives
    });
  });

  describe("buildStateSnapshot (story-harness-adk A1 — canonical checkpoint in the system prompt)", () => {
    const card = (o: Partial<Card>): Card => o as Card;

    it("null when the card is absent or has no status (fail-open → omitted)", () => {
      expect(buildStateSnapshot(null)).toBeNull();
      expect(buildStateSnapshot(card({ status: null }))).toBeNull();
      expect(buildStateSnapshot(card({ status: undefined }))).toBeNull();
    });

    it("asserts the current status verbatim", () => {
      const snap = buildStateSnapshot(card({ status: "desenvolver" }));
      expect(snap).toContain("- status atual: desenvolver");
    });

    it("surfaces a reentry mode but NOT the ordinary 'build' flow", () => {
      expect(buildStateSnapshot(card({ status: "desenvolver", mode: "refine" }))).toContain("modo de reentrada: refine");
      expect(buildStateSnapshot(card({ status: "desenvolver", mode: "build" }))).not.toContain("modo de reentrada");
    });

    it("lists open questions (collapsing whitespace); omits answered ones with no real answer", () => {
      const snap = buildStateSnapshot(
        card({
          status: "desenvolver",
          questions: [
            { id: "q1", text: "Quem é o\n  usuário?", status: "open" },
            { id: "q2", text: "Já respondida", status: "answered" }, // no answer/answeredAt → omitted (G7)
          ],
        }),
      );
      expect(snap).toContain("1 pergunta(s) em aberto");
      expect(snap).toContain("[q1] Quem é o usuário?");
      expect(snap).not.toContain("q2");
      expect(snap).not.toContain("Já respondida");
    });

    it("G7: surfaces the most-recent ANSWERED questions (pergunta → resposta), skipping stale auto-resolutions", () => {
      const snap = buildStateSnapshot(
        card({
          status: "desenvolver",
          questions: [
            { id: "q1", text: "Qual o tom?", status: "answered", answer: "informal e direto", answeredAt: "2026-06-21" },
            { id: "q2", text: "Pergunta morta", status: "answered", answer: "(sem resposta — card concluído/arquivado)", answeredAt: "2026-06-20" },
          ],
        }),
      );
      expect(snap).toContain("recém-respondida");
      expect(snap).toContain("[q1] Qual o tom? → informal e direto");
      expect(snap).not.toContain("Pergunta morta"); // stale auto-resolution is not a real answer
    });

    it("G7+G8: answered questions are omitted in shell-safe mode (the answer text is free-form)", () => {
      const snap = buildStateSnapshot(
        card({
          status: "desenvolver",
          questions: [{ id: "q1", text: "Qual o tom?", status: "answered", answer: "informal $X", answeredAt: "2026-06-21" }],
        }),
        { shellSafe: true },
      );
      expect(snap).not.toContain("informal $X");
      expect(snap).not.toContain("recém-respondida");
    });

    it("summarizes task progress when tasks exist", () => {
      const snap = buildStateSnapshot(
        card({
          status: "desenvolver",
          tasks: [
            { id: "t1", title: "a", done: true },
            { id: "t2", title: "b", done: false },
          ],
        }),
      );
      expect(snap).toContain("- tasks: 1/2 concluídas");
    });

    it("G8 shell-safe mode: emits the open-question COUNT but omits the free-form question text", () => {
      const c = card({
        status: "desenvolver",
        questions: [{ id: "q1", text: "Detalhe SEGREDO com $VAR e `backtick`", status: "open" }],
      });
      const safe = buildStateSnapshot(c, { shellSafe: true });
      expect(safe).toContain("1 pergunta(s) em aberto");
      expect(safe).not.toContain("SEGREDO"); // shell-unsafe free-form text is omitted in shell-safe mode
      // the default (file) mode still includes the verbatim text — the omission is shell-safe-mode-specific
      expect(buildStateSnapshot(c)).toContain("SEGREDO");
    });

    it("G9: the header frames the snapshot as an enqueue-time mirror to RECONFIRM, not an oracle", () => {
      const snap = buildStateSnapshot(card({ status: "desenvolver" }));
      expect(snap).toContain("RECONFIRME");
      expect(snap).not.toContain("trate ISTO como a verdade");
    });

    it("G8: an off-charset status/mode is neutralized in shell-safe mode (defense-in-depth), verbatim in file mode", () => {
      // status/mode are authored fields (coerceCard takes them verbatim, no allow-list). A pipeline
      // status is always a slug so this never fires in practice — but shell-safe mode must not RELY on
      // that distant invariant: status → placeholder, off-charset mode → omitted, so nothing reaches the shell.
      const c = card({ status: "$(touch /tmp/x)", mode: "refine`id`" as Card["mode"] });
      const safe = buildStateSnapshot(c, { shellSafe: true })!;
      expect(safe).not.toContain("$(touch"); // status swapped for a placeholder
      expect(safe).toContain("fora de charset");
      expect(safe).not.toContain("`id`"); // off-charset mode is omitted (no "modo de reentrada" line)
      // the default (file) mode is NOT shell-bound → it keeps the verbatim authored status
      expect(buildStateSnapshot(c)).toContain("$(touch /tmp/x)");
    });

    it("G7: same-day answered questions tie-break STABLY by creation order (the freshest stay in the top-3)", () => {
      // answeredAt is date-only → 4 same-day replies tie under localeCompare; the top-3 must be
      // deterministic and keep the LATER-created ones (append-only questions → higher index = more recent).
      const sameDay = (id: string) => ({ id, text: `P${id}`, status: "answered" as const, answer: `R${id}`, answeredAt: "2026-06-21" });
      const snap = buildStateSnapshot(
        card({ status: "desenvolver", questions: [sameDay("a"), sameDay("b"), sameDay("c"), sameDay("d")] }),
      )!;
      for (const id of ["b", "c", "d"]) expect(snap).toContain(`[${id}]`);
      expect(snap).not.toContain("[a]"); // the oldest is dropped — never a non-deterministic pick
    });
  });

  describe("RunnerEngine.onIdle (G4b — event-driven recovery sweep)", () => {
    it("fires once the last in-flight run settles (engine drained), not while a run is in flight", async () => {
      const { engine, children } = makeEngine();
      let idles = 0;
      engine.onIdle(() => {
        idles += 1;
      });
      // A DATA skill (harness-enrich) commits board-data and does NOT enter the merge train, so emitComplete
      // fires at settle (a code skill enqueued onto the train suppresses it via emitDeferred).
      expect(engine.runSkill("acme", "story-1", "harness-enrich", codeDef).ok).toBe(true);
      await flush();
      expect(engine.hasInFlight()).toBe(true);
      expect(idles).toBe(0); // a run is in flight → not idle
      children[0].emit("close", 0); // the run settles
      for (let i = 0; i < 50 && idles === 0; i++) await flush();
      expect(engine.hasInFlight()).toBe(false);
      expect(idles).toBeGreaterThanOrEqual(1); // engine drained → idle fired
    });
  });

  describe("RunnerEngine.runSkill — the spawn engages the system-prompt FILE (story-harness-cc #1/#3)", () => {
    const boardCfg = (over: Partial<BoardConfig> = {}): BoardConfig => ({
      id: "acme", name: "Nest", package: "packages/acmeapp",
      brandbook: "docs/business/brandbooks/brandbook-acmeapp.md",
      statuses: [], releases: [], personas: [], systems: [], linkTypes: [], ...over,
    });

    // The spawn writes the system-prompt body to runnerStateDir()/system-prompt-<sessionId>.txt; release()
    // unlinks it on settle. A test that asserts the command WITHOUT driving the run to settle leaves the
    // file behind → sweep them here (uniquely named, never the journal/telemetry).
    afterAll(async () => {
      try {
        const dir = runnerStateDir();
        for (const f of await fsp.readdir(dir)) {
          if (f.startsWith("system-prompt-") && f.endsWith(".txt")) {
            await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
          }
        }
      } catch {
        /* dir may not exist — nothing to clean */
      }
    });

    it("AC1/AC3: a acme code run passes --append-system-prompt-file — the note moved OUT of the -p prompt (survives compaction)", async () => {
      const { engine, cmds } = makeEngine(async () => null, { readBoardConfig: async () => boardCfg() });
      expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
      await flush();
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).toContain("--append-system-prompt-file");
      // the note no longer rides INLINE in the -p user prompt (it lives in the file now)
      expect(cmds[0]).not.toContain("packages/acmeapp/.claude/CLAUDE.md");
      expect(cmds[0]).toContain('-p "/harness-do acme/story-1"');
    });

    it("AC2: a `.md`-only data skill on a packaged board still gets the file (its per-app contextNote)", async () => {
      const { engine, cmds } = makeEngine(async () => null, { readBoardConfig: async () => boardCfg() });
      engine.runSkill("acme", "story-1", "harness-enrich", codeDef);
      await flush();
      expect(cmds[0]).toContain("--append-system-prompt-file");
    });

    it("#3: a CODE skill on a board WITHOUT a package STILL gets the file (its per-skill invariants alone)", async () => {
      const cfg = boardCfg({ package: undefined }); // no contextNote, but harness-do is code → CODE_SKILL_INVARIANTS
      const { engine, cmds } = makeEngine(async () => null, { readBoardConfig: async () => cfg });
      expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
      await flush();
      expect(cmds[0]).toContain("--append-system-prompt-file");
      expect(cmds[0]).toContain('-p "/harness-do acme/story-1"');
    });

    // Was: "a NON-code skill on a board WITHOUT a package spawns the bare prompt — no file". The empty body
    // is no longer reachable for a REGISTERED skill: every trigger in AGENTS now carries invariants, so the
    // absent contextNote shrinks the body instead of emptying it. The fail-open that still matters — an
    // UNKNOWN trigger with nothing to say — is asserted below.
    it("a light-lane skill on a board WITHOUT a package still gets its invariants file (no contextNote ⇒ smaller body, not none)", async () => {
      const cfg = boardCfg({ package: undefined });
      const { engine, cmds } = makeEngine(async () => null, { readBoardConfig: async () => cfg });
      expect(engine.runSkill("acme", "story-1", "harness-grill", codeDef).ok).toBe(true);
      await flush();
      expect(cmds[0]).toContain("--append-system-prompt-file");
      expect(cmds[0]).toContain('-p "/harness-grill acme/story-1"');
    });

    it("fail-open preserved: an UNREGISTERED trigger has no invariants → no system-prompt file", () => {
      expect(systemPromptFor("harness-nao-existe" as never)).toBeNull();
    });

    it("G8: USM_AUTORUN_SYSTEM_PROMPT_FILE=0 inline fallback carries contextNote AND the per-skill invariants (not only contextNote)", async () => {
      process.env.USM_AUTORUN_SYSTEM_PROMPT_FILE = "0";
      try {
        const { engine, cmds } = makeEngine(async () => null, { readBoardConfig: async () => boardCfg() });
        expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
        await flush();
        expect(cmds[0]).not.toContain("--append-system-prompt-file");
        expect(cmds[0]).toContain("packages/acmeapp/.claude/CLAUDE.md"); // the inline contextNote is restored
        // G8: the fix-the-app/scope invariants (CODE_SKILL_INVARIANTS) now ALSO ride the inline -p — the
        // fallback no longer silently strips a code run of its non-negotiables.
        expect(cmds[0]).toContain("fix-the-app");
      } finally {
        delete process.env.USM_AUTORUN_SYSTEM_PROMPT_FILE;
      }
    });

    it("a board-config read FAILURE degrades gracefully — a code skill still gets its invariants file (fail-open)", async () => {
      const { engine, cmds } = makeEngine(async () => null, {
        readBoardConfig: async () => {
          throw new Error("yaml gone");
        },
      });
      expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
      await flush();
      // contextNote is null (the read threw) but the code-skill invariants still fill the system prompt.
      expect(cmds[0]).toContain("--append-system-prompt-file");
    });

    it("G5: injects the PREVIOUS step's telemetry summary as a hand-off hint in the system-prompt file", async () => {
      const telemetry: TelemetryPort = {
        recordRun: async () => {},
        listByCard: async () => [
          { id: "r1", board: "acme", cardId: "story-1", trigger: "harness-enrich", startedAt: 1, durationMs: null, turns: null, inputTokens: null, outputTokens: null, costUSD: null, summary: "renomeei o card e defini a persona", status: "ok" },
        ],
        boardSummary: async (boardId) => ({ boardId, cards: [], totalCostUSD: 0 }),
      };
      const { engine, starts } = makeEngine(async () => null, { readBoardConfig: async () => boardCfg(), telemetry });
      expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
      await flush();
      const body = await fsp.readFile(path.join(runnerStateDir(), `system-prompt-${starts[0].sessionId}.txt`), "utf8");
      expect(body).toContain("passo anterior");
      expect(body).toContain("harness-enrich");
      expect(body).toContain("renomeei o card e defini a persona");
    });

    it("G5: a hand-off from the SAME trigger is NOT injected (only a genuine prior step)", async () => {
      const telemetry: TelemetryPort = {
        recordRun: async () => {},
        listByCard: async () => [
          { id: "r1", board: "acme", cardId: "story-1", trigger: "harness-do", startedAt: 1, durationMs: null, turns: null, inputTokens: null, outputTokens: null, costUSD: null, summary: "tentativa anterior do MESMO passo", status: "ok" },
        ],
        boardSummary: async (boardId) => ({ boardId, cards: [], totalCostUSD: 0 }),
      };
      const { engine, starts } = makeEngine(async () => null, { readBoardConfig: async () => boardCfg(), telemetry });
      expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
      await flush();
      const body = await fsp.readFile(path.join(runnerStateDir(), `system-prompt-${starts[0].sessionId}.txt`), "utf8");
      expect(body).not.toContain("passo anterior");
    });

    it("G6: a resumeNote (dead session's reasoning) is injected into the fresh run's system-prompt file AND journaled", async () => {
      const { engine, starts } = makeEngine(async () => null, { readBoardConfig: async () => boardCfg() });
      expect(
        engine.runSkill("acme", "story-1", "harness-do", codeDef, { resumeNote: "estava removendo o uso legado de getFirestore()" }).ok,
      ).toBe(true);
      await flush();
      expect(starts[0].resumeNote).toBe("estava removendo o uso legado de getFirestore()"); // journaled (survives a 2nd crash)
      const body = await fsp.readFile(path.join(runnerStateDir(), `system-prompt-${starts[0].sessionId}.txt`), "utf8");
      expect(body).toContain("sessão anterior deste passo foi interrompida");
      expect(body).toContain("estava removendo o uso legado de getFirestore()");
    });
  });
});

describe("RunnerEngine.runSkill — resume an interrupted run via --resume (story-watchdog)", () => {
  it("spawns `claude --resume <sessionId>` (not a fresh -p run) when resumeSessionId is passed", async () => {
    const { engine, cmds, starts } = makeEngine();
    expect(
      engine.runSkill("storymap", "story-1", "harness-do", codeDef, { dedupeWindowMs: 0, resumeSessionId: "sess-prev" }).ok,
    ).toBe(true);
    await flush();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("--resume sess-prev");
    // The session is the resumed one (NOT a freshly generated uuid), so the journal keys it identically.
    expect(starts.every((s) => s.sessionId === "sess-prev")).toBe(true);
    // --resume binds the session → a second --session-id would contradict it, so it is omitted.
    expect(cmds[0]).not.toContain("--session-id");
  });

  it("reuses the original run's worktree as cwd and does NOT create a new one (resume into the existing tree)", async () => {
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, cmds, spawnOpts, worktreeCreates, worktreeBoardCommits } = makeEngine();
    engine.runSkill("storymap", "story-1", "harness-do", codeDef, {
      dedupeWindowMs: 0,
      resumeSessionId: "sess-prev",
      existingWorktreePath: "/repo/.worktrees/run-sess-prev",
    });
    await flush();
    expect(worktreeCreates).toHaveLength(0); // reused, not recreated
    expect(worktreeBoardCommits).toHaveLength(0); // boundary-1 ran before the original run → skipped
    expect(cmds).toHaveLength(1);
    expect(spawnOpts[0].cwd).toBe("/repo/.worktrees/run-sess-prev"); // spawn cwd IS the original tree
    delete process.env.USM_AUTORUN_WORKTREE;
  });

  it("resume WITHOUT an existing worktree runs in the repo root — even with isolation ON (no fresh tree)", async () => {
    // A resume never mints a NEW worktree (the branch run/<resumeSessionId> would collide and the
    // transcript already encodes the original tree's work) — so isolation ON is irrelevant here.
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, cmds, spawnOpts, worktreeCreates } = makeEngine();
    const repoRoot = findRepoRoot();
    engine.runSkill("storymap", "story-1", "harness-do", codeDef, { dedupeWindowMs: 0, resumeSessionId: "sess-prev" });
    await flush();
    expect(worktreeCreates).toHaveLength(0);
    expect(cmds).toHaveLength(1);
    expect(spawnOpts[0].cwd).toBe(repoRoot);
    delete process.env.USM_AUTORUN_WORKTREE;
  });
});

describe("RunnerEngine.runSkill — resume fallback to a FRESH dispatch (story-1mxmqy)", () => {
  // The cascade resumes the prior step's claude session (`--resume <id>`) for threaded columns AND boot
  // recovery resumes a crashed run — but a session that expired/was wiped (a restart, a store cleanup)
  // makes `claude --resume` exit 1 with "No conversation found with session ID". That is NOT a failure
  // of the work: the engine re-dispatches the column's skill FRESH instead of stranding the card.
  it("re-dispatches FRESH (no --resume, new --session-id) when the resumed session is gone", async () => {
    const { engine, cmds, children } = makeEngine();
    expect(
      engine.runSkill("storymap", "story-1", "harness-do", codeDef, { dedupeWindowMs: 0, resumeSessionId: "sess-gone" }).ok,
    ).toBe(true);
    await flush();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("--resume sess-gone");
    // The CLI prints its missing-session line (the ONLY signal) then exits 1.
    children[0].stderr.emit("data", Buffer.from("No conversation found with session ID: sess-gone\n"));
    children[0].emit("close", 1, null);
    await flush();
    // A SECOND spawn: same skill+card, but FRESH — no --resume, a brand-new --session-id.
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).not.toContain("--resume");
    expect(cmds[1]).toContain("--session-id");
    expect(cmds[1]).toContain("/harness-do storymap/story-1");
  });

  it("does NOT fall back for a real exit-1 (no missing-session signature) — the failure is preserved", async () => {
    const { engine, cmds, children, finishes } = makeEngine();
    engine.runSkill("storymap", "story-1", "harness-do", codeDef, { dedupeWindowMs: 0, resumeSessionId: "sess-prev" });
    await flush();
    expect(cmds).toHaveLength(1);
    // A genuine error (e.g. error_max_turns) — NOT the missing-session signature → no fallback.
    children[0].stderr.emit("data", Buffer.from("some unrelated error\n"));
    children[0].emit("close", 1, null);
    await flush();
    expect(cmds).toHaveLength(1); // never re-dispatched
    expect(finishes.some((f) => f.outcome === "exit")).toBe(true); // settled as a real failure
  });

  it("respects the retry cap — USM_AUTORUN_RESUME_FALLBACK_MAX=0 fails to the operator, never re-dispatching", async () => {
    process.env.USM_AUTORUN_RESUME_FALLBACK_MAX = "0";
    const { engine, cmds, children, finishes } = makeEngine();
    engine.runSkill("storymap", "story-1", "harness-do", codeDef, { dedupeWindowMs: 0, resumeSessionId: "sess-gone" });
    await flush();
    expect(cmds).toHaveLength(1);
    children[0].stderr.emit("data", Buffer.from("No conversation found with session ID: sess-gone\n"));
    children[0].emit("close", 1, null);
    await flush();
    // Budget 0 → no fresh re-dispatch; the run settles as a real failure (operator decides).
    expect(cmds).toHaveLength(1);
    expect(finishes.some((f) => f.outcome === "exit")).toBe(true);
  });
});

describe("RunnerEngine.runSkill — resume on --max-turns (story-9s52tu HALF B)", () => {
  // The CLI's max-turns stop event: a final result with subtype error_max_turns, then exit 1.
  const MAX_TURNS_EVENT = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }) + "\n";

  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "1"; // a worktree must exist to preserve + resume into
  });
  afterEach(() => {
    delete process.env.USM_AUTORUN_WORKTREE;
  });

  it("AC5: a max-turns stop where the card did NOT advance PRESERVES the worktree+branch and marks the run RESUMABLE (no force-delete, no failure)", async () => {
    // The card never advanced past its trigger column (still mid-build) → the run is RESUMABLE: its
    // partial task commits live on the branch and the tree stays on disk for `claude --resume`.
    const reader = async () => "desenvolver"; // before === after (in worktree or main) ⇒ did NOT advance
    const { engine, children, finishes, resumables, worktreeRemoves, worktreeDetaches, mergeEnqueues } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    // The run hits the max-turns cap: emit the result event, THEN exit 1 (the CLI's shape).
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush(); // the max-turns guard reads the card status asynchronously before settling
    // PRESERVED: neither removed (force-delete) nor detached/enqueued (that path is for completed work).
    expect(worktreeRemoves).toHaveLength(0);
    expect(worktreeDetaches).toHaveLength(0);
    expect(mergeEnqueues).toHaveLength(0);
    // RESUMABLE, not a failure: markResumable (NOT recordFinish) was called → the journal stays "running".
    expect(resumables).toEqual([{ board: "storymap", cardId: "story-1", endedAt: expect.any(Number) }]);
    expect(finishes).toHaveLength(0); // never flipped to a "done"/failed outcome
    // Not a hard failure → it must NOT pollute the failures the cockpit reads.
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "story-1")).toBe(false);
  });

  it("a max-turns stop where the card DID advance inside the worktree is success-with-warning → committed + enqueued (no resume needed)", async () => {
    // The work landed (the card advanced in the worktree) → integrate it via the normal success path,
    // exactly like the falha-fantasma success-with-warning. It is NOT preserved-as-resumable.
    const reader = async (_b: string, _c: string, cwd?: string) => (cwd ? "revisar-codigo" : "desenvolver");
    const { engine, children, resumables, worktreeRemoves, worktreeDetaches, mergeEnqueues } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    expect(resumables).toHaveLength(0); // advanced → not resumable, the work is integrated instead
    expect(worktreeRemoves).toHaveLength(0); // branch carries the advance → kept
    expect(worktreeDetaches).toHaveLength(1); // detached + enqueued like any completed run
    expect(mergeEnqueues).toHaveLength(1);
  });

  it("AC6: a GENUINE code error (NO max-turns signal) still FORCE-DELETES the worktree+branch — never leaks a resumable orphan", async () => {
    const reader = async () => "desenvolver"; // did NOT advance → a real failure
    const { engine, children, finishes, resumables, worktreeCreates, worktreeRemoves, mergeEnqueues } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    // A genuine error: an unrelated stderr line, NO error_max_turns result → exits 1.
    children[0].stderr.emit("data", Buffer.from("TypeError: cannot read property of undefined\n"));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    expect(resumables).toHaveLength(0); // NOT resumable — a code error is force-deleted
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
    expect(mergeEnqueues).toHaveLength(0);
    expect(finishes).toEqual([{ board: "storymap", cardId: "story-1", outcome: "exit", endedAt: expect.any(Number) }]);
  });

  it("AC3: a watchdog TIMEOUT (no max-turns signal) is unchanged — force-delete + a 'timeout' failure, never preserved", async () => {
    // A timeout kill carries no error_max_turns result, so the max-turns branch never fires: the run
    // tears down + settles as a real "timeout" failure exactly as before this story.
    const reader = async () => "desenvolver";
    const { engine, children, finishes, resumables, worktreeCreates, worktreeRemoves } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    // killTree closes the child with SIGTERM (signal != null, no result event) — but to model the
    // watchdog timeout deterministically we close with the signal a timeout kill produces.
    children[0].emit("close", null, "SIGTERM");
    await flush();
    await flush();
    expect(resumables).toHaveLength(0); // a kill is never resumable
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
    expect(finishes.some((f) => f.outcome === "exit")).toBe(true); // killed → exit outcome, a real failure
  });

  // BEHAVIOR CHANGE (2026-07-18). This test used to assert the OPPOSITE — "no worktree ⇒ NOT resumable,
  // settles as a normal failure (nothing to preserve)" — and that assertion was the defect written down as
  // a contract. It conflates "no CODE to preserve" with "no SESSION to resume": `claude --resume` rehydrates
  // from the session id and never needs a tree. Because worktrees are allocated only for the code lane
  // (`isCode`), the old guard made the ENTIRE max-turns mechanism — resume AND the cap escalation —
  // unreachable for every `isCode:false` skill, i.e. ~93% of runs. Boot recovery already got this right
  // (recovery.ts keys on `entry.worktreePath` being absent, data-driven); the engine's settle was the
  // outlier. Measured cost of the old contract: acme/story-tlz0dt stopped mid-thought, wrote nothing, and
  // was never retried.
  it("a max-turns stop with NO worktree is STILL resumable — the session resumes without a tree", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0"; // no worktree — the light lane's normal shape
    const reader = async () => "desenvolver";
    const { engine, children, cmds, spawnOpts, finishes, resumables, worktreeRemoves, worktreeCreates } =
      makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    expect(resumables).toHaveLength(1); // resumable on the SESSION, not on a tree
    expect(finishes).toHaveLength(0); // NOT settled as a failure/done
    expect(worktreeRemoves).toHaveLength(0);
    expect(worktreeCreates).toHaveLength(0); // none existed, none invented
    expect(children).toHaveLength(2); // and it actually re-dispatched
    expect(cmds[1]).toContain("--resume ");
    expect(spawnOpts[1].cwd).not.toMatch(/run-/); // resumes in the repo root, not a phantom tree
  });

  // The TRUTH defect, separate from the resume one. The outcome ladder classifies on the process exit code
  // ALONE, so when the CLI emitted `error_max_turns` and then exited 0, `failure` was undefined, `outcome`
  // was "ok", and the whole max-turns branch was skipped — the run recorded as an unqualified success. On
  // acme/story-tlz0dt that meant 10 turns and $2.35 spent, NOTHING written to the card, and a board showing
  // "✓ concluído": absent from failures[], from the stuck lane, from the step rollup, from findings. The
  // only contrary evidence was an ephemeral `✗ error_max_turns` console frame printed immediately above the
  // green line. `hitMaxTurns` was in scope the whole time and simply was not consulted — an exit code is
  // not the authority on WHY the model stopped.
  it("a max-turns stop that exits ZERO is NOT recorded as a clean success", async () => {
    const reader = async () => "desenvolver"; // did NOT advance
    const { engine, children, finishes, resumables } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 0, null); // exit 0 — the shape that used to slip through as "ok"
    await flush();
    await flush();
    expect(finishes.some((f) => f.outcome === "ok")).toBe(false); // the lie this test exists to prevent
    expect(resumables).toHaveLength(1); // recognized as a cap stop and handed to the resume path
  });

  it("guard ordering: a watchdog TIMEOUT that ALSO emitted a stale max-turns result is NOT hijacked into resume — stays a real timeout failure + force-delete", async () => {
    // The CLI emitted error_max_turns, but then the wrap-up HUNG and the watchdog killed it (SIGTERM).
    // A kill is NOT a clean cap exit, so the run must settle as a genuine failure (timeout/exit), NOT be
    // preserved as resumable — else a hung run leaks a resumable orphan it can never cleanly resume from.
    const reader = async () => "desenvolver";
    const { engine, children, resumables, worktreeCreates, worktreeRemoves } = makeEngine(reader);
    engine.runSkill("storymap", "story-tmo", "harness-do", codeDef);
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT)); // stale max-turns event…
    children[0].emit("close", null, "SIGTERM"); // …then a KILL (signal) — not a clean cap exit
    await flush();
    await flush();
    expect(resumables).toHaveLength(0); // a killed run is NEVER resumable, even with a stale max-turns event
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
    expect(children).toHaveLength(1); // no in-process resume
  });

  // ── HIGH #1: the ROOT fix — a max-turns settle LIVE-resumes IN-PROCESS instead of letting the
  //    generic cascade spawn a FRESH from-scratch run (which would overwrite the resumable journal
  //    entry + orphan the preserved tree). These FAIL on the pre-fix diff (emitDeferred not set +
  //    no in-process re-dispatch). ─────────────────────────────────────────────────────────────────
  it("HIGH #1: a max-turns settle LIVE re-dispatches the SAME session in-process with --resume in the PRESERVED worktree — no fresh from-scratch run", async () => {
    const reader = async () => "desenvolver"; // did NOT advance → resumable
    const { engine, children, cmds, spawnOpts, worktreeCreates } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    const firstSessionId = worktreeCreates[0].branch.replace("run/", "");
    const firstWorktree = worktreeCreates[0].worktreePath;
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush(); // settle + the async max-turns guard read
    await flush(); // the trailing in-process re-dispatch (runSkill awaits its setup before spawning)
    // A SECOND child spawned: the in-process resume. NOT a fresh from-scratch run — it reuses the
    // SAME session (--resume <firstSessionId>) and the SAME preserved worktree (no new tree created).
    expect(children).toHaveLength(2);
    expect(worktreeCreates).toHaveLength(1); // the resume REUSES the preserved tree — no fresh checkout
    expect(cmds[1]).toContain(`--resume ${firstSessionId}`);
    expect(cmds[1]).not.toContain(`-p "/harness-do storymap/story-1"\n`); // (sanity: it IS a resume, prompt re-issued)
    expect(spawnOpts[1].cwd).toBe(firstWorktree); // the resume runs IN the preserved tree
  });

  it("HIGH #1: a max-turns settle does NOT emit the generic cascade (no fresh-from-scratch re-spawn of the unchanged column)", async () => {
    const reader = async () => "desenvolver"; // did NOT advance
    const { engine, children } = makeEngine(reader);
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    // The generic cascade is SUPPRESSED for the resumable path — emitComplete never fires for the
    // max-turns outcome, so evaluateAutorunOnEntry can't (after the 30s dedupe) spawn a fresh run that
    // overwrites the resumable journal entry. The in-process resume is the ONLY follow-up.
    expect(seen.some((e) => e.outcome === "max-turns")).toBe(false);
    expect(seen).toHaveLength(0);
    void children; // (the in-process resume's own child is live, asserted in the test above)
  });

  // ── HIGH #2: a BOUNDED counter — after the cap of max-turns resumes a chronically-stuck card
  //    ESCALATES to a genuine failure + force-deletes the tree, instead of looping forever. FAILS on
  //    the pre-fix diff (no counter, no cap → always preserves). ───────────────────────────────────
  it("HIGH #2: at the resume cap the card ESCALATES — genuine 'error' failure + the worktree is FORCE-DELETED (no resumable orphan, no resume)", async () => {
    process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX = "2"; // cap = 2
    const reader = async () => "desenvolver"; // never advances → chronically stuck
    const { engine, children, finishes, resumables, worktreeCreates, worktreeRemoves } = makeEngine(reader);
    // This run ALREADY carries resumeCount === cap (2) — the 3rd cycle. It must NOT preserve again.
    engine.runSkill("storymap", "story-1", "harness-do", codeDef, { maxTurnsResumeCount: 2 });
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    expect(resumables).toHaveLength(0); // at the cap → NOT preserved as resumable
    expect(children).toHaveLength(1); // NO in-process resume re-dispatch (it escalated instead)
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]); // the preserved tree is FORCE-DELETED so it can't leak as an orphan
    expect(finishes).toEqual([{ board: "storymap", cardId: "story-1", outcome: "error", endedAt: expect.any(Number) }]);
    // Operator-visible: a real RunnerFailure surfaces on the cockpit (failures[]).
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "story-1")).toBe(true);
  });

  it("HIGH #2: UNDER the cap still preserves + resumes (the cap is the only thing that stops the loop)", async () => {
    process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX = "2";
    const reader = async () => "desenvolver";
    const { engine, children, resumables, worktreeRemoves } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef, { maxTurnsResumeCount: 1 }); // 1 < cap 2
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    expect(resumables).toEqual([{ board: "storymap", cardId: "story-1", endedAt: expect.any(Number) }]);
    expect(worktreeRemoves).toHaveLength(0); // preserved, not force-deleted
    expect(children).toHaveLength(2); // resumed in-process
  });

  it("HIGH #2: cap=0 disables auto-resume — the FIRST max-turns settle escalates straight to a failure", async () => {
    process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX = "0";
    const reader = async () => "desenvolver";
    const { engine, children, finishes, resumables, worktreeCreates, worktreeRemoves } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef); // resumeCount 0 >= cap 0 → escalate
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    expect(resumables).toHaveLength(0);
    expect(children).toHaveLength(1);
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
    expect(finishes.some((f) => f.outcome === "error")).toBe(true);
  });

  // ── (c) the counter SURVIVES recordStart: the in-process resume re-dispatch journals the
  //    INCREMENTED count, so a restart / the next cycle reads the right depth. FAILS pre-fix (the
  //    field doesn't exist, so recordStart never carried it). ─────────────────────────────────────
  it("(c) the in-process resume journals the INCREMENTED maxTurnsResumeCount (survives recordStart)", async () => {
    const reader = async () => "desenvolver";
    const { engine, children, starts } = makeEngine(reader);
    engine.runSkill("storymap", "story-1", "harness-do", codeDef); // first run: count undefined (≡ 0)
    await flush();
    children[0].stdout.emit("data", Buffer.from(MAX_TURNS_EVENT));
    children[0].emit("close", 1, null);
    await flush();
    await flush();
    // The FIRST run's recordStart(s) carry count 0/undefined; the in-process resume's recordStart
    // carries count 1 — the monotonic increment that the next max-turns cycle / boot recovery reads.
    expect(starts.some((s) => s.maxTurnsResumeCount === 1)).toBe(true);
    // …and that resume run reuses the SAME session id (so --resume rehydrates it, not a fresh uuid).
    const firstSessionId = starts[0].sessionId;
    expect(starts.some((s) => s.sessionId === firstSessionId && s.maxTurnsResumeCount === 1)).toBe(true);
    void children;
  });

  // ── (d) a NORMAL completion still cascades (the suppression is scoped to the resumable path ONLY). ─
  it("(d) a NORMAL (clean) completion still emits the generic cascade — suppression is the resumable path ONLY", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0"; // non-isolated → emitComplete fires synchronously on clean exit
    const reader = async () => "desenvolver";
    const { engine, children } = makeEngine(reader);
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0); // clean exit, NO max-turns → normal cascade
    await flush();
    expect(seen).toEqual([{ board: "storymap", cardId: "story-1", trigger: "harness-do", outcome: "ok" }]);
  });
});

describe("buildRunCommitMessage — deterministic, traceable run commit (f1) + F4 provenance trailers", () => {
  it("ties the commit subject to the skill, the card and the run session", () => {
    // subject (first line) is unchanged; Run-Id is always appended as a trailer (every run commit is greppable).
    const msg = buildRunCommitMessage("harness-do", "acme", "story-1", "sess-abc");
    expect(msg.split("\n")[0]).toBe("usm(harness-do): acme/story-1 [run sess-abc]");
    expect(msg).toBe("usm(harness-do): acme/story-1 [run sess-abc]\n\nRun-Id: sess-abc");
    expect(buildRunCommitMessage("harness-review", "storymap", "story-oimqu8", "s2").split("\n")[0]).toBe(
      "usm(harness-review): storymap/story-oimqu8 [run s2]",
    );
  });

  it("emits Decision/Model/Run-Id trailers when run metadata is supplied (F4)", () => {
    const msg = buildRunCommitMessage("harness-review", "storymap", "story-x", "sess-9", {
      model: "opus",
      effort: "high",
      decision: "Corrigi o scroll-trap do AsciiFigure no mobile e revalidei.",
    });
    const [subject, blank, ...trailers] = msg.split("\n");
    expect(subject).toBe("usm(harness-review): storymap/story-x [run sess-9]");
    expect(blank).toBe(""); // git trailers are separated from the subject by a blank line
    expect(trailers).toEqual([
      "Decision: Corrigi o scroll-trap do AsciiFigure no mobile e revalidei.",
      "Model: opus · high",
      "Run-Id: sess-9",
    ]);
  });

  it("omits the Decision trailer when there is no finalText, and Model when no model", () => {
    expect(buildRunCommitMessage("harness-do", "b", "c", "s", { decision: "   " })).toBe(
      "usm(harness-do): b/c [run s]\n\nRun-Id: s",
    );
    expect(buildRunCommitMessage("harness-do", "b", "c", "s", { model: "sonnet" })).toBe(
      "usm(harness-do): b/c [run s]\n\nModel: sonnet\nRun-Id: s",
    );
  });

  it("collapses a multi-line decision into one capped trailer line", () => {
    const decision = `Decidi A.\n\nDepois B.\n   E ${"x".repeat(200)}`;
    const msg = buildRunCommitMessage("harness-do", "b", "c", "s", { decision });
    const decisionLine = msg.split("\n").find((l) => l.startsWith("Decision: "))!;
    expect(decisionLine).not.toContain("\n");
    expect(decisionLine.startsWith("Decision: Decidi A. Depois B. E xxx")).toBe(true);
    expect(decisionLine.endsWith("…")).toBe(true);
    expect(decisionLine.length).toBeLessThanOrEqual("Decision: ".length + 140);
  });
});

describe("summarizeFinalText — single-line, capped run-decision projection (F4)", () => {
  it("returns null for empty/blank/undefined input", () => {
    expect(summarizeFinalText(undefined)).toBeNull();
    expect(summarizeFinalText(null)).toBeNull();
    expect(summarizeFinalText("   \n\t  ")).toBeNull();
  });

  it("collapses internal whitespace/newlines into single spaces and trims", () => {
    expect(summarizeFinalText("  linha 1\n\n   linha 2\tfim  ")).toBe("linha 1 linha 2 fim");
  });

  it("caps long text with an ellipsis at the requested max", () => {
    const out = summarizeFinalText("a".repeat(300), 50)!;
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short single line untouched", () => {
    expect(summarizeFinalText("decisão curta", 200)).toBe("decisão curta");
  });
});

describe("formatRunAge — coarse handoff-source age (G5)", () => {
  it("buckets a delta into sub-minute / minutes / hours / days", () => {
    expect(formatRunAge(20_000)).toBe("agora há pouco"); // < 30s rounds to 0 min
    expect(formatRunAge(5 * 60_000)).toBe("há ~5min");
    expect(formatRunAge(3 * 3_600_000)).toBe("há ~3h");
    expect(formatRunAge(50 * 3_600_000)).toBe("há ~2d");
  });

  it("returns '' for a non-finite/negative delta (clock skew → the caller omits the clause)", () => {
    expect(formatRunAge(-1000)).toBe("");
    expect(formatRunAge(NaN)).toBe("");
  });
});

// F0 / ADR-067 — o describe de `needsSandboxEnv` viveu aqui. A função MORREU junto com a injeção de
// `IS_SANDBOX=1`, que nunca isolou nada (era o bypass da trava de root do CLI). A propriedade que aqueles
// testes protegiam — "o bypass segue o tier EFETIVO" — foi RE-MIRADA, não descartada: ela agora vive em
// autonomy-sandbox.test.ts como "a postura segue o tier efetivo", com o mecanismo que de fato contém.
// A cobertura equivalente do lado do engine é a tabela de flags em autonomy-tier.test.ts.

describe("RunnerEngine — git worktree isolation (R1)", () => {
  // The whole capability is gated behind worktreeIsolation (DEFAULT OFF) — turn it ON for this block.
  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "1";
  });

  it("creates an isolated worktree BEFORE spawning and uses it as the run's cwd (AC1)", async () => {
    const { engine, cmds, spawnOpts, worktreeCreates } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    expect(cmds).toHaveLength(0); // spawn is deferred until the worktree exists
    await flush();
    expect(worktreeCreates).toHaveLength(1); // created (after the HEAD=estado board commit) before spawn
    expect(cmds).toHaveLength(1);
    expect(spawnOpts[0].cwd).toBe(worktreeCreates[0].worktreePath); // spawn cwd IS the worktree
    expect(worktreeCreates[0].worktreePath).toContain(".worktrees/run-");
    expect(worktreeCreates[0].branch).toMatch(/^run\//);
  });

  it("commits pending board state on main BEFORE creating the worktree (boundary 1, HEAD=estado)", async () => {
    // The CRITICAL bug: writeCard mutations sit UNCOMMITTED on main, so the worktree (a checkout of
    // HEAD) is born from a STALE commit and the skill reads an obsolete status. Fix: commit the live
    // board state on main FIRST, so HEAD carries it and the fresh worktree checks out the live state.
    const { engine, worktreeEvents, worktreeBoardCommits, worktreeCreates } = makeEngine(async () => null, {
      boardCommitted: true,
    });
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    expect(worktreeEvents).toEqual(["boardCommit", "create"]); // commit ran strictly BEFORE create
    expect(worktreeBoardCommits).toHaveLength(1);
    expect(worktreeBoardCommits[0].message).toMatch(/^board:/); // separable from code commits (usm(...))
    expect(worktreeBoardCommits[0].message).toContain("storymap/story-1");
    expect(worktreeCreates).toHaveLength(1);
  });

  it("still creates the worktree when the board tree is already clean (commitBoardState no-op)", async () => {
    // A clean main → commitBoardState returns committed:false; the run proceeds exactly as before.
    const { engine, cmds, worktreeEvents, worktreeCreates } = makeEngine(async () => null, { boardCommitted: false });
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    expect(worktreeEvents).toEqual(["boardCommit", "create"]); // attempted, then created
    expect(worktreeCreates).toHaveLength(1);
    expect(cmds).toHaveLength(1); // spawned normally
  });

  it("a board-state commit FAILURE (fail-closed, e.g. secret found) aborts the run — no worktree, no spawn (settles error)", async () => {
    // commitBoardState throws (the secret scanner blocked the board commit). Proceeding would create a
    // worktree off a STALE HEAD, so we must abort: never create the tree, never spawn, settle as error.
    const { engine, cmds, worktreeEvents, worktreeCreates, finishes } = makeEngine(async () => null, {
      boardCommitThrows: true,
    });
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    expect(engine.runSkill("storymap", "story-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(worktreeEvents).toEqual(["boardCommit"]); // failed at the commit → create never reached
    expect(worktreeCreates).toHaveLength(0);
    expect(cmds).toHaveLength(0); // never spawned
    expect(engine.isInFlight("storymap", "story-1")).toBe(false); // slot + lock released
    expect(finishes).toEqual([{ board: "storymap", cardId: "story-1", outcome: "error", endedAt: expect.any(Number) }]);
    expect(seen).toEqual([{ board: "storymap", cardId: "story-1", trigger: "harness-do", outcome: "error" }]);
  });

  it("journals the worktreePath BEFORE spawning, so a create→spawn crash leaves a recoverable orphan (f4)", async () => {
    // f4: the create→spawn window used to journal the worktreePath only POST-spawn → a crash in
    // between left a tree nobody could reap. Assert the journal ALREADY carries the worktreePath at
    // the very moment of spawn (an order-sensitive check the post-spawn-only code cannot satisfy).
    const starts: JournalStart[] = [];
    const journal: RunnerJournalPort = {
      recordStart: (e) => {
        starts.push(e);
      },
      recordFinish: () => {},
      markResumable: () => {},
    };
    const created: Array<{ worktreePath: string }> = [];
    const worktreeOps: WorktreeOps = {
      create: async (repoRoot, sessionId) => {
        const w = { worktreePath: `${repoRoot}/.worktrees/run-${sessionId}`, branch: `run/${sessionId}` };
        created.push(w);
        return w;
      },
      commit: async () => ({ committed: true }),
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async () => {},
      detach: async () => {},
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    let worktreePathAtSpawn: string | undefined;
    const fakeSpawn = (() => {
      // Snapshot what the journal knows at spawn time: with f4 the worktreePath is ALREADY written.
      worktreePathAtSpawn = starts.find((s) => s.worktreePath !== undefined)?.worktreePath;
      return makeFakeChild();
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(fakeSpawn, journal, async () => null, worktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(worktreePathAtSpawn).toBe(created[0].worktreePath); // journaled BEFORE the spawn, not after
  });

  it("COMMITS the worktree, then DETACHES it (keeping the branch) and enqueues it on the merge train on success (AC1/AC2/f1)", async () => {
    const { engine, children, worktreeCreates, worktreeCommits, worktreeRemoves, worktreeDetaches, mergeEnqueues } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit + detach + enqueue are fire-and-forget (async) after settle
    // f1 fix: the run's writes are COMMITTED onto run/<id> BEFORE the dir is detached — without
    // this the branch stays == HEAD and the merge train deletes it, losing the work.
    expect(worktreeCommits).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, message: expect.stringContaining("usm(harness-do): acme/story-1") },
    ]);
    // The branch must SURVIVE so the merge queue can integrate it → detach, NOT remove (no branch -D).
    expect(worktreeRemoves).toHaveLength(0);
    expect(worktreeDetaches).toEqual([{ worktreePath: worktreeCreates[0].worktreePath }]);
    expect(mergeEnqueues).toHaveLength(1);
    expect(mergeEnqueues[0]).toMatchObject({
      board: "acme",
      cardId: "story-1",
      branch: worktreeCreates[0].branch,
      runId: worktreeCreates[0].sessionId,
    });
  });

  it("an EMPTY-DIFF run (nothing committed) tears the tree + branch down and enqueues NOTHING (AC3)", async () => {
    // commit reports { committed: false } → the run changed nothing. No no-op merge entry; the
    // ephemeral worktree AND its branch are removed clean (dir + branch), never detached.
    const { engine, children, worktreeCreates, worktreeCommits, worktreeRemoves, worktreeDetaches, mergeEnqueues } = makeEngine(
      async () => null,
      { committed: false },
    );
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit (empty) + remove are fire-and-forget after settle
    expect(worktreeCommits).toHaveLength(1); // commit was ATTEMPTED (detected the empty diff)
    expect(worktreeDetaches).toHaveLength(0); // never detached — nothing to integrate
    expect(mergeEnqueues).toHaveLength(0); // AC3: no no-op merge enqueued
    // full teardown: dir + branch (the branch == HEAD, safe to delete)
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
  });

  it("PRESERVES a skill's OWN incremental commits: sweep is empty but the branch has work → detach + enqueue (small-commits flow)", async () => {
    // The small-commits flow: the skill committed each task itself inside the worktree, so the settle
    // SWEEP finds nothing to commit (committed:false) — but the branch carries the skill's commits
    // (hasUnmergedWork:true). The OLD gate keyed on `committed` would have removed the branch and LOST
    // all that work; the new gate keys on branch divergence, so the run is enqueued like any other.
    const { engine, children, worktreeCreates, worktreeRemoves, worktreeDetaches, mergeEnqueues } = makeEngine(
      async () => null,
      { committed: false, hasUnmergedWork: true },
    );
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(worktreeRemoves).toHaveLength(0); // branch NOT discarded — the skill's commits survive
    expect(worktreeDetaches).toEqual([{ worktreePath: worktreeCreates[0].worktreePath }]);
    expect(mergeEnqueues).toHaveLength(1); // integrated like a normal run
    expect(mergeEnqueues[0]).toMatchObject({ board: "acme", cardId: "story-1", branch: worktreeCreates[0].branch });
  });

  // story-yy3hds INVERTEU o contrato deste teste: o antigo "full remove" era exatamente o caminho que
  // DESTRUÍA as edições não-commitadas do run (remove --force) enquanto o run assentava "ok" — o
  // sucesso-fantasma do run 5a3103d3. O invariante real nunca foi "não sobra árvore" e sim "não sobra
  // árvore INVISÍVEL": agora uma falha persistente de commit PRESERVA worktree + branch deliberadamente
  // e fica visível (journal "error" + console + finding blocker) — não é leak, é recuperação manual.
  it("a PERSISTENT commit failure preserves the tree+branch (no remove, no detach, no enqueue) — story-yy3hds", async () => {
    const worktreeCreates: Array<{ worktreePath: string; branch: string }> = [];
    const worktreeRemoves: Array<{ worktreePath: string; branch: string }> = [];
    let detached = false;
    const { mergeQueue, enqueues } = makeMergeQueueDouble();
    const worktreeOps: WorktreeOps = {
      create: async (repoRoot, sessionId) => {
        const w = { worktreePath: `${repoRoot}/.worktrees/run-${sessionId}`, branch: `run/${sessionId}` };
        worktreeCreates.push(w);
        return w;
      },
      commit: async () => {
        throw new Error("fatal: unable to write commit object");
      },
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async (worktreePath, branch) => {
        worktreeRemoves.push({ worktreePath, branch });
      },
      detach: async () => {
        detached = true;
      },
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    const child = makeFakeChild();
    const fakeSpawn = (() => child) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(fakeSpawn, makeJournal().journal, async () => null, worktreeOps, mergeQueue, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    child.emit("close", 0);
    await flush();
    expect(detached).toBe(false);
    expect(enqueues).toHaveLength(0); // the commit threw → nothing integrated
    expect(worktreeCreates).toHaveLength(1); // a tree WAS created…
    expect(worktreeRemoves).toHaveLength(0); // …and is PRESERVED, never force-removed with work inside
  });

  it("removes the worktree (branch and all) on a failing exit — a FAILED run never reaches the merge train (AC2)", async () => {
    const reader = async () => "desenvolver"; // did NOT advance → a real failure
    const { engine, children, worktreeCreates, worktreeRemoves, mergeEnqueues } = makeEngine(reader);
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1);
    await flush(); // failure path settles asynchronously (falha-fantasma guard)
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
    expect(mergeEnqueues).toHaveLength(0); // failure → discard the work, never integrate it
  });

  it("a non-clean exit AFTER the card advanced INSIDE the worktree → success-with-warning, ENQUEUED (falha-fantasma root-cause, audit 2026-06)", async () => {
    // The CRITICAL the audit found: `before` reads main (desenvolver, at enqueue) but the isolated run
    // advances its card in the WORKTREE — so the `after` read MUST look at the worktree. A reader that
    // returns the advanced status ONLY when handed the worktree cwd models reality. Before the fix the
    // engine read main for `after` too (→ before===after → "no advance" → branch -D = data loss).
    const reader = async (_b: string, _c: string, cwd?: string) => (cwd ? "revisar-codigo" : "desenvolver");
    const { engine, children, worktreeCreates, worktreeRemoves, worktreeDetaches, mergeEnqueues } = makeEngine(reader);
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 1); // non-clean exit (e.g. error_max_turns) AFTER the worktree advance
    await flush();
    await flush(); // success teardown (commit → detach → enqueue) is async
    expect(worktreeRemoves).toHaveLength(0); // NOT discarded — the branch carries the advance + code
    expect(worktreeDetaches).toEqual([{ worktreePath: worktreeCreates[0].worktreePath }]); // dir detached, branch kept
    expect(mergeEnqueues).toHaveLength(1); // committed work handed to the merge train, not lost
  });

  it("removes the worktree when the run is killed (SIGTERM) (AC2)", async () => {
    const { engine, children, worktreeCreates, worktreeRemoves } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", null, "SIGTERM");
    await flush();
    await flush();
    expect(worktreeRemoves).toEqual([
      { worktreePath: worktreeCreates[0].worktreePath, branch: worktreeCreates[0].branch },
    ]);
  });

  it("removes the worktree even when the spawn itself throws", async () => {
    const throwingSpawn = (() => {
      throw new Error("ENOENT claude");
    }) as unknown as typeof import("node:child_process").spawn;
    const worktreeCreates: Array<{ worktreePath: string; branch: string }> = [];
    const worktreeRemoves: Array<{ worktreePath: string; branch: string }> = [];
    const worktreeOps: WorktreeOps = {
      create: async (repoRoot, sessionId) => {
        const w = { worktreePath: `${repoRoot}/.worktrees/run-${sessionId}`, branch: `run/${sessionId}` };
        worktreeCreates.push(w);
        return w;
      },
      commit: async () => ({ committed: true }),
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async (worktreePath, branch) => {
        worktreeRemoves.push({ worktreePath, branch });
      },
      detach: async () => {},
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    const engine = new RunnerEngine(throwingSpawn, makeJournal().journal, async () => null, worktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    engine.runSkill("acme", "story-x", "harness-do", codeDef);
    await flush();
    expect(worktreeCreates).toHaveLength(1); // it was created…
    expect(worktreeRemoves).toEqual([worktreeCreates[0]]); // …then torn down on the spawn failure
    expect(engine.isInFlight("acme", "story-x")).toBe(false);
  });

  it("gives two concurrent runs DISTINCT worktrees so their files never collide (AC3)", async () => {
    process.env.USM_AUTORUN_MAX = "2";
    const { engine, spawnOpts, worktreeCreates } = makeEngine();
    engine.runSkill("acme", "a", "harness-do", codeDef);
    engine.runSkill("acme", "b", "harness-do", codeDef);
    await flush();
    expect(worktreeCreates).toHaveLength(2);
    expect(worktreeCreates[0].worktreePath).not.toBe(worktreeCreates[1].worktreePath);
    expect(spawnOpts[0].cwd).not.toBe(spawnOpts[1].cwd); // each spawn isolated to its own tree
  });

  it("settles a run as error (no spawn, no orphan) when worktree create fails", async () => {
    let removeCalled = false;
    const worktreeOps: WorktreeOps = {
      create: async () => {
        throw new Error("fatal: could not lock .git/index.lock");
      },
      commit: async () => ({ committed: true }),
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async () => {
        removeCalled = true;
      },
      detach: async () => {},
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    const { journal, finishes } = makeJournal();
    const cmds: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      cmds.push(cmd);
      return makeFakeChild();
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(fakeSpawn, journal, async () => null, worktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);
    const seen: Array<{ outcome: string }> = [];
    engine.onComplete((ev) => seen.push(ev as { outcome: string }));
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(cmds).toHaveLength(0); // never spawned
    expect(removeCalled).toBe(false); // nothing was created → nothing to remove (no orphan)
    expect(engine.isInFlight("acme", "story-1")).toBe(false); // slot + lock released
    expect(finishes).toEqual([{ board: "acme", cardId: "story-1", outcome: "error", endedAt: expect.any(Number) }]);
    expect(seen).toEqual([{ board: "acme", cardId: "story-1", trigger: "harness-do", outcome: "error" }]);
  });

  it("force-releasing DURING worktree creation tears down the fresh tree and never spawns", async () => {
    let resolveCreate: () => void = () => {};
    const worktreeCreates: Array<{ sessionId: string }> = [];
    const worktreeRemoves: Array<{ worktreePath: string; branch: string }> = [];
    const worktreeOps: WorktreeOps = {
      create: (repoRoot, sessionId) =>
        new Promise((res) => {
          worktreeCreates.push({ sessionId });
          resolveCreate = () => res({ worktreePath: `${repoRoot}/.worktrees/run-${sessionId}`, branch: `run/${sessionId}` });
        }),
      commit: async () => ({ committed: true }),
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async (worktreePath, branch) => {
        worktreeRemoves.push({ worktreePath, branch });
      },
      detach: async () => {},
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    const cmds: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      cmds.push(cmd);
      return makeFakeChild();
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(fakeSpawn, makeJournal().journal, async () => null, worktreeOps, null, undefined, NEVER_OVERLOADED, () => false, async () => null, async () => null, noopTelemetry);

    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush(); // start() ran; create() is now pending (no child tracked yet)
    expect(worktreeCreates).toHaveLength(1);
    expect((await engine.forceRelease("acme", "story-1")).released).toBe(true); // cancel while create is in-flight
    resolveCreate(); // create resolves → start re-checks cancellation
    await flush();
    await flush();
    expect(cmds).toHaveLength(0); // never spawned
    expect(worktreeRemoves).toHaveLength(1); // the freshly-created tree was torn down
    expect(engine.isInFlight("acme", "story-1")).toBe(false);
  });
});

describe("RunnerEngine.forceRelease — liberar/matar uma run travada (R1)", () => {
  // These assert worktree teardown on force-release → isolation ON.
  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "1";
  });

  it("kills an EXECUTING run's child, releases its in-flight lock and tears down its worktree", async () => {
    const { engine, children, cmds, worktreeRemoves } = makeEngine();
    expect(engine.runSkill("acme", "stuck-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(children).toHaveLength(1);
    expect(engine.isInFlight("acme", "stuck-1")).toBe(true);

    expect(await engine.forceRelease("acme", "stuck-1")).toEqual({ released: true });
    // killTree asks the child to die; in prod its 'close' then runs settle(). Drive it here.
    children[0].emit("close", null, "SIGTERM");
    await flush();
    await flush();

    expect(engine.isInFlight("acme", "stuck-1")).toBe(false);
    expect(worktreeRemoves).toHaveLength(1); // the killed run's worktree was reaped
    // Lock freed → the SAME card can run again (spawns a 2nd time).
    expect(engine.runSkill("acme", "stuck-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    // Count CLAUDE launches only — on Windows killTree also spawns a `taskkill` (recorded by the fake
    // spawn); on POSIX it signals the process group via killProcess (no spawn). Filtering keeps the
    // intent ("claude ran twice") platform-agnostic.
    expect(cmds.filter((c) => c.includes("claude"))).toHaveLength(2);
  });

  it("cancels a QUEUED run cleanly, never spawning it (cap=1) and journaling it finished", async () => {
    process.env.USM_AUTORUN_MAX = "1";
    const { engine, children, cmds, finishes, worktreeCreates } = makeEngine();
    expect(engine.runSkill("acme", "run-a", "harness-do", codeDef).ok).toBe(true); // executes
    expect(engine.runSkill("acme", "run-b", "harness-do", codeDef).ok).toBe(true); // queued (cap 1)
    await flush();
    expect(cmds).toHaveLength(1); // only A spawned
    expect(children).toHaveLength(1);

    const res = await engine.forceRelease("acme", "run-b");
    expect(res.released).toBe(true);
    expect(res.note).toBeDefined();

    // Finish A → pump dequeues B's start, which sees it cancelled and cleans up.
    children[0].emit("close", 0);
    await flush();
    await flush();

    expect(cmds).toHaveLength(1); // B NEVER spawned
    expect(worktreeCreates).toHaveLength(1); // B was cancelled BEFORE its worktree was created
    expect(engine.isInFlight("acme", "run-b")).toBe(false);
    expect(engine.isInFlight("acme", "run-a")).toBe(false);
    // B was journaled finished so a reboot won't try to recover it.
    expect(finishes.some((f) => f.cardId === "run-b")).toBe(true);
  });

  it("returns released:false when there is no run for the card", async () => {
    const { engine } = makeEngine();
    expect(await engine.forceRelease("acme", "ghost")).toEqual({ released: false, note: expect.any(String) });
  });

  it("#44: a queued cancel re-stamps the dedupe window so an AUTORUN echo can't resurrect it (manual re-run still allowed)", async () => {
    process.env.USM_AUTORUN_MAX = "1";
    const { engine, children, cmds } = makeEngine();
    // A executes (holds the single slot); B queues behind it with the autorun dedupe window.
    expect(engine.runSkill("acme", "run-a", "harness-do", codeDef, { dedupeWindowMs: 30_000 }).ok).toBe(true);
    expect(engine.runSkill("acme", "run-b", "harness-do", codeDef, { dedupeWindowMs: 30_000 }).ok).toBe(true);
    await flush();
    expect(cmds).toHaveLength(1); // only A spawned; B is queued

    // Cancel B WHILE queued — the lock is freed, but the dedupe window is re-stamped (#44).
    expect((await engine.forceRelease("acme", "run-b")).released).toBe(true);

    // An AUTORUN echo of B (watcher re-eval, same trigger, dedupe window) is REFUSED — the cancel
    // is not silently undone by a re-fire through the freed lock.
    expect(engine.runSkill("acme", "run-b", "harness-do", codeDef, { dedupeWindowMs: 30_000 })).toEqual({
      ok: false,
      reason: "cooldown",
      detail: expect.any(String),
    });
    // A MANUAL re-run (no dedupe window) is still allowed — the human's explicit intent survives.
    expect(engine.runSkill("acme", "run-b", "harness-do", codeDef).ok).toBe(true);
  });

  // POSIX-only: the group-kill via killProcess is the POSIX path; Windows killTree uses taskkill /T.
  it.skipIf(process.platform === "win32")("escalates SIGTERM → SIGKILL on the process GROUP when the child ignores SIGTERM (story-#30)", async () => {
    // A child that survives SIGTERM: the liveness probe reports the group still alive ONCE, then dead.
    let probes = 0;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const stubbornKill = (pid: number, signal?: NodeJS.Signals | 0): void => {
      killCalls.push({ pid, signal });
      if (signal === 0) {
        probes += 1;
        if (probes === 1) return; // first probe: still alive → forces the SIGKILL escalation
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); // then dead
      }
    };
    const { engine, children } = makeEngine(async () => null, { killProcess: stubbornKill });
    expect(engine.runSkill("acme", "stuck-2", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(children).toHaveLength(1);

    expect(await engine.forceRelease("acme", "stuck-2")).toEqual({ released: true });
    // It signaled the negative pid (the process GROUP), escalating SIGTERM then SIGKILL.
    const group = killCalls.filter((c) => c.pid < 0);
    expect(group.some((c) => c.signal === "SIGTERM")).toBe(true);
    expect(group.some((c) => c.signal === "SIGKILL")).toBe(true);
  });

  it("a SIGKILL (137) on a force-killed SCOPED run is OUR kill, NOT an OOM (story-#30) → cancelled (story-vbkazs)", async () => {
    // Scope ON (systemd + heavy MemoryMax) so WITHOUT the forceKilled marker a 137 would be oom-killed.
    // forceRelease marks it forceKilled (so it is NOT mislabeled OOM) AND cancelledKills (story-vbkazs:
    // a DELIBERATE cancel), so the 137 classifies as the non-failure outcome "cancelled" — never
    // "oom-killed". The regression guarded here remains: it must NOT be attributed to the kernel's OOM.
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const reader = async () => "desenvolver";
    const { engine, children, finishes } = makeEngine(reader, { systemdCheck: () => true });
    engine.runSkill("acme", "fk-1", "harness-do", codeDef);
    await flush();
    expect(await engine.forceRelease("acme", "fk-1")).toEqual({ released: true });
    children[0].emit("close", 137, null); // SIGKILL relayed as exit 137 (the VPS shape)
    await flush();
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "fk-1", outcome: "cancelled", endedAt: expect.any(Number) }]);
    // A deliberate cancel records NO RunnerFailure (so no red flag / cockpit-stuck), and certainly not OOM.
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "fk-1")).toBe(false);
  });

  // ── story-vbkazs: a deliberate cancel is a DISTINCT non-failure outcome ─────────────────────────
  it("a force-released EXECUTING run records the NON-failure outcome 'cancelled' (not 'exit') + NO RunnerFailure", async () => {
    const { engine, children, finishes, telemetry, records } = (() => {
      const t = makeTelemetry();
      return { ...makeEngine(async () => "desenvolver", { telemetry: t.telemetry }), telemetry: t.telemetry, records: t.records };
    })();
    expect(engine.runSkill("acme", "cancel-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(children).toHaveLength(1);

    expect((await engine.forceRelease("acme", "cancel-1")).released).toBe(true);
    children[0].emit("close", null, "SIGTERM"); // killTree's SIGTERM → child close → settle()
    await flush();
    await flush();

    // The journaled + emitted outcome is the distinct 'cancelled', NOT 'exit' (a deliberate cancel
    // is not a failure). The failure-fantasma reader returns "desenvolver" (no advance) — proving the
    // cancel branch preempts the killed/exit classification regardless of card movement.
    expect(finishes).toEqual([{ board: "acme", cardId: "cancel-1", outcome: "cancelled", endedAt: expect.any(Number) }]);
    // No RunnerFailure recorded for the card → it never shows as red / stuck in the cockpit.
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "cancel-1")).toBe(false);
    // Telemetry persists the run with status 'cancelled' (the durable history the card UI reads).
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ cardId: "cancel-1", status: "cancelled" });
  });

  it("a force-released EXECUTING run does NOT enqueue its worktree on the merge train (cancelled work is incomplete)", async () => {
    // Worktree ON via the block's beforeEach. A cancel carries no RunnerFailure, but its work is
    // INCOMPLETE — it must tear the worktree down (like a failure path), never commit+enqueue it.
    const { engine, children, worktreeRemoves, worktreeCommits, mergeEnqueues } = makeEngine(async () => "desenvolver");
    expect(engine.runSkill("acme", "cancel-wt", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(children).toHaveLength(1);

    expect((await engine.forceRelease("acme", "cancel-wt")).released).toBe(true);
    children[0].emit("close", null, "SIGTERM");
    await flush();
    await flush();

    expect(worktreeRemoves).toHaveLength(1); // the cancelled run's worktree was reaped
    expect(worktreeCommits).toHaveLength(0); // never committed (no half-done work onto a branch)
    expect(mergeEnqueues).toHaveLength(0); // never handed to the merge train
  });

  it("a QUEUED run force-released then dequeued records 'cancelled' (not 'exit') + NO RunnerFailure", async () => {
    process.env.USM_AUTORUN_MAX = "1";
    const { engine, children, cmds, finishes } = makeEngine();
    expect(engine.runSkill("acme", "q-a", "harness-do", codeDef).ok).toBe(true); // executes (holds the slot)
    expect(engine.runSkill("acme", "q-b", "harness-do", codeDef).ok).toBe(true); // queued (cap 1)
    await flush();
    expect(cmds).toHaveLength(1); // only A spawned

    expect((await engine.forceRelease("acme", "q-b")).released).toBe(true);
    children[0].emit("close", 0); // finish A → pump dequeues B's start → finishCancelled()
    await flush();
    await flush();

    expect(cmds).toHaveLength(1); // B NEVER spawned
    // B's durable finish is 'cancelled', NOT 'exit' (the prior hard-coded value) — and no failure.
    const bFinish = finishes.find((f) => f.cardId === "q-b");
    expect(bFinish).toMatchObject({ outcome: "cancelled" });
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "q-b")).toBe(false);
  });

  it("REGRESSION: a watchdog/manual SIGTERM that did NOT go through forceRelease stays 'exit' (not 'cancelled')", async () => {
    // A SIGTERM/143 that never entered cancelledKills (e.g. an external kill, or the watchdog's own
    // killTree which sets `timedOut` not cancelledKills) must NOT be mislabeled a deliberate cancel.
    const { engine, children, finishes } = makeEngine(async () => "desenvolver");
    engine.runSkill("acme", "extkill-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", null, "SIGTERM"); // killed by a signal, but NOT via forceRelease
    await flush();
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "extkill-1", outcome: "exit", endedAt: expect.any(Number) }]);
  });

  it("REGRESSION: an OOM SIGKILL/137 on a SCOPED run stays 'oom-killed' (cancelledKills empty)", async () => {
    // The OOM path is untouched by story-vbkazs: no forceRelease → cancelledKills empty → the scope's
    // 137 is still attributed to the kernel's cgroup OOM killer, NEVER reclassified as a cancel.
    process.env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX = "2G";
    const { engine, children, finishes } = makeEngine(async () => "desenvolver", { systemdCheck: () => true });
    engine.runSkill("acme", "oom-vb", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 137, null); // kernel cgroup OOM, NO forceRelease
    await flush();
    await flush();
    expect(finishes).toEqual([{ board: "acme", cardId: "oom-vb", outcome: "oom-killed", endedAt: expect.any(Number) }]);
    expect(
      getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "oom-vb" && f.reason === "oom-killed"),
    ).toBe(true);
  });
});

// story-ms5rmt — a recording per-cwd commit serializer that MIRRORS the production primitive
// (serialize same-cwd, parallel distinct-cwd) AND measures the peak number of commits running
// CONCURRENTLY on each cwd. Shared between an engine (boundary 1) and a merge queue (boundary 2) so
// a test can prove their board commits onto the SAME main tree never overlap (peak 1) even when
// fired concurrently — and that per-worktree commits never touch this mutex at all (AC2).
function makeConcurrencySerializer() {
  const chains = new Map<string, Promise<unknown>>();
  const cwds: string[] = [];
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const serialCommit: CommitSerializer = (cwd, fn) => {
    cwds.push(cwd);
    const prev = chains.get(cwd) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const n = (inFlight.get(cwd) ?? 0) + 1;
      inFlight.set(cwd, n);
      peak.set(cwd, Math.max(peak.get(cwd) ?? 0, n));
      try {
        return await fn();
      } finally {
        inFlight.set(cwd, (inFlight.get(cwd) ?? 1) - 1);
      }
    });
    chains.set(cwd, next.catch(() => {}));
    return next;
  };
  return { serialCommit, cwds, peakFor: (cwd: string) => peak.get(cwd) ?? 0 };
}

// In-memory MergeQueueStore (DI) so the real merge queue runs without touching disk.
function memStore(): MergeQueueStore {
  let saved: MergeQueueEntry[] = [];
  return {
    load: async () => saved.map((e) => ({ ...e })),
    persist: async (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
  };
}

// A stateful merge exec (DI) whose board-commit path (boundary 2) actually runs: a DIRTY tree
// (`status --porcelain`) → add → scan → `git commit` (optionally held open `commitDelayMs` so a
// concurrent boundary-1 commit would overlap if unserialized) → then a clean merge integrates the
// branch (is-ancestor false pre-merge, true after).
function mergeExecWithBoardCommit(opts: { commitDelayMs?: number } = {}) {
  const integrated = new Set<string>();
  const calls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd);
    const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
    if (cmd.includes("status --porcelain")) return { stdout: " M storymap/boards/x/cards/y.md\n", stderr: "" };
    if (cmd.includes("scan-secrets")) return { stdout: "", stderr: "" };
    if (cmd.startsWith("git commit")) {
      if (opts.commitDelayMs) await new Promise((r) => setTimeout(r, opts.commitDelayMs));
      return { stdout: "", stderr: "" };
    }
    if (cmd.includes("is-ancestor")) {
      if (integrated.has(br)) return { stdout: "", stderr: "" };
      throw Object.assign(new Error("not ancestor"), { code: 1 });
    }
    if (cmd.includes("merge --no-ff")) {
      integrated.add(br);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("RunnerEngine + merge train — per-cwd commit mutex across BOTH boundaries (story-ms5rmt)", () => {
  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "1"; // boundary 1 only runs with isolation ON
  });

  it("serializes the engine's boundary-1 START commit and the merge train's boundary-2 commit on the SAME main tree (AC1/AC4, f-serial-start-test)", async () => {
    const repoRoot = findRepoRoot();
    const ser = makeConcurrencySerializer();
    // Engine: boundary-1 board commit held open 5ms so a concurrent boundary-2 would overlap if the
    // two weren't kept on ONE chain keyed by repoRoot.
    const { engine } = makeEngine(async () => null, {
      commitSerializer: ser.serialCommit,
      boardCommitDelayMs: 5,
      boardCommitted: true,
    });
    // The merge train sharing the SAME serializer instance — its boundary-2 commit is also held open.
    const { exec } = mergeExecWithBoardCommit({ commitDelayMs: 5 });
    const mq = makeMergeQueue({ repoRoot, exec, store: memStore(), commitSerializer: ser.serialCommit });

    // Fire a run START (boundary 1) and a merge (boundary 2) CONCURRENTLY, both targeting repoRoot.
    engine.runSkill("storymap", "story-a", "harness-do", codeDef);
    await mq.enqueueMerge({ runId: "s-merge", board: "storymap", cardId: "story-b", branch: "run/s-merge" });
    await flush();
    await mq.whenIdle();
    await flush();

    // BOTH boundaries routed their commit through the mutex, keyed by the SAME main tree…
    const onRepoRoot = ser.cwds.filter((c) => c === repoRoot);
    expect(onRepoRoot).toHaveLength(2); // boundary 1 (start) + boundary 2 (merge)
    // …and they NEVER ran at the same time on it (the race on .git/index.lock is closed).
    expect(ser.peakFor(repoRoot)).toBe(1);
  });

  it("serializes 2 concurrent STARTS + 1 merge on the same repoRoot, and never routes a per-worktree commit through the mutex (AC1/AC2)", async () => {
    process.env.USM_AUTORUN_MAX = "2"; // let both starts run at once
    const repoRoot = findRepoRoot();
    const ser = makeConcurrencySerializer();
    const { engine } = makeEngine(async () => null, {
      commitSerializer: ser.serialCommit,
      boardCommitDelayMs: 5,
      boardCommitted: true,
    });
    const { exec } = mergeExecWithBoardCommit({ commitDelayMs: 5 });
    const mq = makeMergeQueue({ repoRoot, exec, store: memStore(), commitSerializer: ser.serialCommit });

    // Two starts (two boundary-1 commits on repoRoot) + one merge (a boundary-2 commit on repoRoot),
    // all concurrent on the SAME main tree.
    engine.runSkill("storymap", "story-a", "harness-do", codeDef);
    engine.runSkill("storymap", "story-b", "harness-do", codeDef);
    await mq.enqueueMerge({ runId: "s-merge", board: "storymap", cardId: "story-c", branch: "run/s-merge" });
    await flush();
    await mq.whenIdle();
    await flush();

    // AC1: all three same-cwd commits went through the mutex and were serialized (peak 1, never raced).
    expect(ser.cwds.filter((c) => c === repoRoot)).toHaveLength(3);
    expect(ser.peakFor(repoRoot)).toBe(1);
    // AC2: the mutex is scoped to the shared tree ONLY — no per-worktree (run-*) commit was ever
    // routed through it, so isolated runs keep committing their own worktrees in parallel.
    expect(ser.cwds.every((c) => c === repoRoot)).toBe(true);
  });
});

describe("RunnerEngine — resource-aware admission lanes (story-scheduler-lanes-recursos)", () => {
  // Lane caps + thresholds are driven by env (which always wins over settings.yaml). Isolation OFF so
  // the spawn path is the plain repo-root one — these tests are about admission, not worktrees.
  const LANE_ENV = [
    "USM_AUTORUN_LANE_LIGHT_MAX",
    "USM_AUTORUN_LANE_HEAVY_MAX",
    "USM_AUTORUN_RAM_FREE_MB",
    "USM_AUTORUN_LOAD_AVG_1",
  ] as const;
  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "0";
  });
  afterEach(() => {
    for (const k of LANE_ENV) delete process.env[k];
  });

  // Count how many spawned commands are for a given skill (the cmd embeds `"/<skill> board/card"`).
  const countSkill = (cmds: string[], skill: string) => cmds.filter((c) => c.includes(`"/${skill} `)).length;

  it("a heavy run waits when the heavy lane is at its cap, while a light run still passes (AC2)", async () => {
    process.env.USM_AUTORUN_MAX = "5"; // global ceiling not the binding constraint here
    process.env.USM_AUTORUN_LANE_HEAVY_MAX = "1"; // only ONE heavy run at a time
    process.env.USM_AUTORUN_LANE_LIGHT_MAX = "5";
    const { engine, children, cmds } = makeEngine();
    engine.runSkill("acme", "heavy-a", "harness-do", codeDef); // admitted (heavy lane: 1/1)
    engine.runSkill("acme", "heavy-b", "harness-do", codeDef); // BLOCKED — heavy lane full
    engine.runSkill("acme", "light-c", "harness-enrich", codeDef); // passes — light lane independent
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(1); // only the first heavy spawned
    expect(countSkill(cmds, "harness-enrich")).toBe(1); // the light run was NOT blocked by the heavy backlog
    expect(engine.isInFlight("acme", "heavy-b")).toBe(true); // still queued, holding its in-flight lock

    children[0].emit("close", 0); // the first heavy finishes → frees the heavy slot
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(2); // the queued heavy now admits
  });

  it("blocks the heavy lane while the VPS is over the RAM threshold, but never the light lane (AC2)", async () => {
    process.env.USM_AUTORUN_MAX = "5";
    process.env.USM_AUTORUN_LANE_HEAVY_MAX = "5"; // lane caps are NOT the constraint — the probe is
    process.env.USM_AUTORUN_LANE_LIGHT_MAX = "5";
    process.env.USM_AUTORUN_RAM_FREE_MB = "400"; // heavy waits while free RAM < 400 MB
    process.env.USM_AUTORUN_LOAD_AVG_1 = "999"; // isolate the RAM axis
    let overloaded = true;
    const probe = () => ({ freeRamMb: overloaded ? 100 : Infinity, loadAvg1: 0 });
    const { engine, children, cmds } = makeEngine(async () => null, { probeResources: probe });
    engine.runSkill("acme", "heavy-a", "harness-do", codeDef); // gated by the overloaded probe
    engine.runSkill("acme", "light-b", "harness-enrich", codeDef); // admitted — probe never gates light
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(0); // heavy held back by the resource probe
    expect(countSkill(cmds, "harness-enrich")).toBe(1); // light unaffected
    expect(engine.isInFlight("acme", "heavy-a")).toBe(true);

    overloaded = false; // RAM recovered
    children[0].emit("close", 0); // closing the light run re-pumps → the heavy now admits
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(1); // heavy admitted once the box is healthy again
  });

  // 2026-07-17 — o teste ACIMA recupera por `children[0].emit("close")`: uma BORDA. É exatamente a suposição
  // que quebra na produção. O pump é disparado por BORDA (um run assenta, ou um job enfileira) mas o portão
  // da lane heavy é de NÍVEL (RAM/load da VPS). Um nível que cede sozinho não emite borda nenhuma — e quando
  // o run adiado é o ÚLTIMO (o caso normal: o pico de carga costuma ser o gate do próprio train rodando a
  // suíte), não existe assentamento futuro para re-pumpar. Foi assim que o redrive de acme/story-novo-item
  // ficou 5h+ na fila (journal `running`, `pid: null`, worktree nenhum — nunca chegou a lançar).
  describe("pump — trabalho ENCALHADO: portão de nível × disparo por borda", () => {
    it("pumpRetryNeeded: só encalha com fila heavy E nada rodando (com run em voo, o assentamento É a borda)", () => {
      expect(pumpRetryNeeded(0, 1)).toBe(true); // ninguém para acordar → encalhado
      expect(pumpRetryNeeded(1, 1)).toBe(false); // um run vai assentar e re-pumpar → timer seria redundante
      expect(pumpRetryNeeded(0, 0)).toBe(false); // nada na fila → nada a acordar
    });

    it("heavy barrado com a caixa QUENTE e nada rodando: não spawna, e RE-ARMA (antes: esperava para sempre)", async () => {
      process.env.USM_AUTORUN_MAX = "5";
      process.env.USM_AUTORUN_LANE_HEAVY_MAX = "5";
      process.env.USM_AUTORUN_RAM_FREE_MB = "400";
      process.env.USM_AUTORUN_LOAD_AVG_1 = "999";
      let overloaded = true;
      const { engine, cmds, pumpTimers } = makeEngine(async () => null, {
        probeResources: () => ({ freeRamMb: overloaded ? 100 : Infinity, loadAvg1: 0 }),
      });
      engine.runSkill("acme", "heavy-strand", "harness-do", codeDef);
      await flush();
      expect(countSkill(cmds, "harness-do")).toBe(0); // barrado pelo nível…
      expect(pumpTimers).toHaveLength(1); // …e AGORA existe quem o acorde
      expect(pumpTimers[0].ms).toBe(PUMP_RETRY_MS);

      overloaded = false; // a VPS esfria — SEM nenhum run assentar, ou seja, sem borda nenhuma
      pumpTimers[0].run(); // 30s depois
      await flush();
      expect(countSkill(cmds, "harness-do")).toBe(1); // admitido pelo timer — o encalhe morre
    });

    it("ainda quente no retry: re-arma (UM timer por vez — retenta, não vira busy-loop)", async () => {
      process.env.USM_AUTORUN_MAX = "5";
      process.env.USM_AUTORUN_LANE_HEAVY_MAX = "5";
      process.env.USM_AUTORUN_RAM_FREE_MB = "400";
      process.env.USM_AUTORUN_LOAD_AVG_1 = "999";
      const { engine, cmds, pumpTimers } = makeEngine(async () => null, {
        probeResources: () => ({ freeRamMb: 100, loadAvg1: 0 }), // NUNCA esfria
      });
      engine.runSkill("acme", "heavy-hot", "harness-do", codeDef);
      await flush();
      expect(pumpTimers).toHaveLength(1);
      pumpTimers[0].run(); // retry #1 — segue quente
      await flush();
      expect(countSkill(cmds, "harness-do")).toBe(0);
      expect(pumpTimers).toHaveLength(2); // re-armou: a espera continua, mas viva
      // Um 2º pump enquanto um timer JÁ está armado não arma um segundo (dobraria a taxa de probe do /proc).
      engine.runSkill("acme", "heavy-hot-2", "harness-do", codeDef);
      await flush();
      expect(pumpTimers).toHaveLength(2);
    });

    it("com um run EM VOO nada é armado — o assentamento dele é a borda (nenhum timer supérfluo)", async () => {
      process.env.USM_AUTORUN_MAX = "5";
      process.env.USM_AUTORUN_LANE_HEAVY_MAX = "1"; // o 2º heavy fica na fila pela COTA, não pelo nível
      const { engine, pumpTimers } = makeEngine(async () => null, {});
      engine.runSkill("acme", "heavy-1", "harness-do", codeDef);
      engine.runSkill("acme", "heavy-2", "harness-do", codeDef);
      await flush();
      expect(pumpTimers).toEqual([]); // heavy-1 vai assentar e re-pumpar sozinho
    });
  });

  it("blocks the heavy lane while the VPS is over the LOAD threshold, but never the light lane (AC2)", async () => {
    // Sibling of the RAM-threshold test on the OTHER axis of isVpsOverloaded — proves the load/CPU
    // half of AC2 is wired through pump() end-to-end, not only in the pure isVpsOverloaded unit.
    process.env.USM_AUTORUN_MAX = "5";
    process.env.USM_AUTORUN_LANE_HEAVY_MAX = "5"; // lane caps are NOT the constraint — the probe is
    process.env.USM_AUTORUN_LANE_LIGHT_MAX = "5";
    process.env.USM_AUTORUN_RAM_FREE_MB = "0"; // isolate the LOAD axis (never block on RAM)
    process.env.USM_AUTORUN_LOAD_AVG_1 = "3.5"; // heavy waits while 1-min load > 3.5
    let overloaded = true;
    const probe = () => ({ freeRamMb: Infinity, loadAvg1: overloaded ? 9 : 0 });
    const { engine, children, cmds } = makeEngine(async () => null, { probeResources: probe });
    engine.runSkill("acme", "heavy-a", "harness-do", codeDef); // gated by the high load
    engine.runSkill("acme", "light-b", "harness-enrich", codeDef); // admitted — probe never gates light
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(0); // heavy held back by the load probe
    expect(countSkill(cmds, "harness-enrich")).toBe(1); // light unaffected by CPU pressure
    expect(engine.isInFlight("acme", "heavy-a")).toBe(true);

    overloaded = false; // load subsided
    children[0].emit("close", 0); // closing the light run re-pumps → the heavy now admits
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(1); // heavy admitted once load is back under the ceiling
  });

  it("maxConcurrent > 2 admits runs distributed across BOTH lanes up to the per-lane caps (AC3)", async () => {
    process.env.USM_AUTORUN_MAX = "4"; // the operator raised the ceiling above the legacy 2
    process.env.USM_AUTORUN_LANE_LIGHT_MAX = "3";
    process.env.USM_AUTORUN_LANE_HEAVY_MAX = "1";
    const { engine, cmds } = makeEngine();
    engine.runSkill("acme", "heavy-a", "harness-do", codeDef);
    engine.runSkill("acme", "light-b", "harness-enrich", codeDef);
    engine.runSkill("acme", "light-c", "harness-enrich", codeDef);
    engine.runSkill("acme", "light-d", "harness-enrich", codeDef);
    engine.runSkill("acme", "heavy-e", "harness-do", codeDef); // 2nd heavy — over the heavy cap
    await flush();
    expect(cmds).toHaveLength(4); // four simultaneous runs (was capped at 2 before)
    expect(countSkill(cmds, "harness-do")).toBe(1); // heavy lane cap (1) honored
    expect(countSkill(cmds, "harness-enrich")).toBe(3); // light lane filled its cap (3)
    expect(engine.isInFlight("acme", "heavy-e")).toBe(true); // the over-cap heavy waits for a heavy slot
  });

  it("force-releasing a QUEUED heavy run frees the heavy-lane counter so a later heavy still admits", async () => {
    // Guards the runningHeavy invariant on the cancel-while-queued teardown: pump() claims the heavy
    // slot when it dequeues the cancelled run, and finishCancelled() must release it via the SAME lane
    // captured at enqueue. If it leaked, the heavy lane (cap 1) would stay permanently throttled.
    process.env.USM_AUTORUN_MAX = "5";
    process.env.USM_AUTORUN_LANE_HEAVY_MAX = "1"; // one heavy at a time → the counter must recover
    const { engine, children, cmds } = makeEngine();
    engine.runSkill("acme", "heavy-a", "harness-do", codeDef); // admitted (heavy lane 1/1)
    engine.runSkill("acme", "heavy-b", "harness-do", codeDef); // queued behind the heavy cap
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(1);

    expect((await engine.forceRelease("acme", "heavy-b")).released).toBe(true); // cancel WHILE queued
    children[0].emit("close", 0); // heavy-a finishes → pump dequeues heavy-b, which self-cancels
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(1); // heavy-b never spawned (it was cancelled)
    expect(engine.isInFlight("acme", "heavy-b")).toBe(false); // its in-flight lock was released

    engine.runSkill("acme", "heavy-c", "harness-do", codeDef); // a fresh heavy run
    await flush();
    expect(countSkill(cmds, "harness-do")).toBe(2); // admits ONLY if runningHeavy was decremented to 0
  });
});

describe("RunnerEngine — merge train re-drive wiring (story-92ldyt)", () => {
  // Isolation ON so a successful run hands its branch to the merge train (where the trigger/driveCount
  // it carries decide re-drive eligibility).
  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "1";
  });

  const board: BoardConfig = {
    id: "storymap",
    name: "AgileHarness",
    statuses: [{ id: "desenvolver", name: "Em desenvolvimento", trigger: "harness-do" }],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  };

  it("registers a redrive handler on the merge queue at construction (so a conflict can call back)", () => {
    const { redriveHandlers } = makeEngine();
    expect(redriveHandlers).toHaveLength(1);
    expect(typeof redriveHandlers[0]).toBe("function");
  });

  it("propagates the run's `trigger` (and an absent driveCount on a first run) onto the merge enqueue", async () => {
    const { engine, children, mergeEnqueues } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush(); // commit + detach + enqueue (fire-and-forget after settle)
    expect(mergeEnqueues).toHaveLength(1);
    expect(mergeEnqueues[0]).toMatchObject({ trigger: "harness-do", branch: expect.stringMatching(/^run\//) });
    expect(mergeEnqueues[0].driveCount).toBeUndefined(); // first attempt — no re-drive depth yet
  });

  it("carries an explicit driveCount (a conflict-redrive run) onto the merge enqueue", async () => {
    const { engine, children, mergeEnqueues } = makeEngine();
    engine.runSkill("acme", "story-1", "harness-do", codeDef, { origin: "conflict-redrive", driveCount: 2 });
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(mergeEnqueues[0]).toMatchObject({ trigger: "harness-do", driveCount: 2 }); // depth carried forward
  });

  it("the registered redrive handler resolves the trigger's column policy and RE-RUNS the skill with the incremented driveCount", async () => {
    const { engine, redriveHandlers, cmds, children, mergeEnqueues } = makeEngine(async () => null, {
      readBoardConfig: async () => board,
    });
    // The merge train fires this on a conflict (driveCount already incremented past the conflicted attempt).
    redriveHandlers[0]({ board: "storymap", cardId: "story-1", trigger: "harness-do", driveCount: 1, conflictDetail: "CONFLICT" });
    for (let i = 0; i < 4; i++) await flush(); // redrive awaits readBoardConfig → runSkill → worktree → spawn
    expect(cmds.some((c) => c.includes('"/harness-do storymap/story-1"'))).toBe(true); // the skill re-ran
    expect(engine.isInFlight("storymap", "story-1")).toBe(true);
    children[0].emit("close", 0);
    await flush();
    expect(mergeEnqueues).toHaveLength(1);
    expect(mergeEnqueues[0]).toMatchObject({ trigger: "harness-do", driveCount: 1 }); // depth carried onto the regen branch
  });

  it("the redrive handler degrades silently when the board/column can't be resolved (no spawn, no throw)", async () => {
    const { engine, redriveHandlers, cmds } = makeEngine(async () => null, {
      readBoardConfig: async () => null, // board gone
    });
    redriveHandlers[0]({ board: "ghost", cardId: "story-x", trigger: "harness-do", driveCount: 1, conflictDetail: "CONFLICT" });
    for (let i = 0; i < 4; i++) await flush();
    expect(cmds).toHaveLength(0); // nothing re-ran
    expect(engine.isInFlight("ghost", "story-x")).toBe(false);
  });
});

describe("RunnerEngine + merge train — conflict re-drive end-to-end (story-92ldyt, AC1+AC2)", () => {
  beforeEach(() => {
    process.env.USM_AUTORUN_WORKTREE = "1";
  });

  it("a conflicting run is RE-DRIVEN — the skill re-runs against the updated main, the regenerated branch merges CLEAN, with no manual pause", async () => {
    const repoRoot = findRepoRoot();
    const board: BoardConfig = {
      id: "storymap",
      name: "AgileHarness",
      statuses: [{ id: "desenvolver", name: "Em desenvolvimento", trigger: "harness-do" }],
      releases: [],
      personas: [],
      systems: [],
      linkTypes: [],
    };
    // Merge exec: the FIRST merge-back conflicts; every later one integrates clean (models "regenerated
    // over the updated main merges cleanly"). is-ancestor true only AFTER a clean merge (f3 invariant).
    const integrated = new Set<string>();
    let mergeAttempts = 0;
    const exec: ExecFn = async (cmd) => {
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("status --porcelain")) return { stdout: "", stderr: "" }; // clean main → no board commit
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        mergeAttempts += 1;
        if (mergeAttempts === 1) throw Object.assign(new Error("CONFLICT"), { code: 1, stderr: `CONFLICT in ${br}` });
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const mq = makeMergeQueue({ repoRoot, exec, store: memStore() });

    // Faked worktree ops: a distinct run branch per sessionId; every run "changed something".
    const worktreeOps: WorktreeOps = {
      create: async (root, sessionId) => ({ worktreePath: `${root}/.worktrees/run-${sessionId}`, branch: `run/${sessionId}` }),
      commit: async () => ({ committed: true }),
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async () => {},
      detach: async () => {},
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const cmds: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      cmds.push(cmd);
      const c = makeFakeChild();
      children.push(c);
      return c;
    }) as unknown as typeof import("node:child_process").spawn;
    // The engine wired to the REAL merge queue + the board config (so the conflict re-drive resolves harness-do).
    const engine = new RunnerEngine(
      fakeSpawn,
      makeJournal().journal,
      async () => null,
      worktreeOps,
      mq,
      undefined,
      NEVER_OVERLOADED,
      () => false,
      async () => board,
      async () => null,
      noopTelemetry,
    );

    // Run 1: the skill produces a branch.
    engine.runSkill("storymap", "story-1", "harness-do", codeDef);
    await flush();
    expect(cmds).toHaveLength(1);
    // Finishing run 1 → enqueue → merge attempt #1 CONFLICTS → re-drive → the engine re-runs harness-do.
    children[0].emit("close", 0);
    for (let i = 0; i < 6; i++) {
      await flush();
      await mq.whenIdle();
    }
    expect(cmds).toHaveLength(2); // AC1: a SECOND harness-do spawned (regenerate) — NOT an operator pause
    expect(engine.isInFlight("storymap", "story-1")).toBe(true); // the re-driven run holds the lock

    // Run 2 (the regenerate) finishes → its branch enqueues with driveCount 1 → merges CLEAN.
    children[1].emit("close", 0);
    for (let i = 0; i < 6; i++) {
      await flush();
      await mq.whenIdle();
    }
    const snap = mq.getSnapshot();
    // AC2: fully hands-off — the first branch re-driven (terminal), the regenerated one done, no `conflict`.
    expect(snap.entries.some((e) => e.status === "conflict")).toBe(false);
    expect(snap.entries.some((e) => e.status === "done")).toBe(true);
    expect(snap.entries.some((e) => e.status === "re-driving")).toBe(true);
  });
});

describe("RunnerEngine — worktree isolation OFF by default (safe default)", () => {
  it("allocates NO worktree and runs in the repo root (cwd=repoRoot) when the flag is off", async () => {
    process.env.USM_AUTORUN_WORKTREE = "0"; // explicit default-off (independent of any settings.yaml)
    const { engine, children, cmds, spawnOpts, starts, worktreeCreates, worktreeBoardCommits, worktreeRemoves } = makeEngine();
    expect(engine.runSkill("acme", "story-1", "harness-do", codeDef).ok).toBe(true);
    await flush();
    expect(worktreeCreates).toHaveLength(0); // never created
    // Flag OFF = cwd is the shared repo root, no git boundary → NO HEAD=estado board commit either.
    // Ad-hoc code generated outside an isolated run is committed by its own flow, never swept here.
    expect(worktreeBoardCommits).toHaveLength(0);
    expect(cmds).toHaveLength(1); // still spawned
    expect(spawnOpts[0].cwd).toBe(findRepoRoot()); // cwd is the shared repo root, NOT a worktree
    // the spawn-time journal upsert (pid 4321) carries no worktreePath
    expect(starts.find((s) => s.pid === 4321)?.worktreePath).toBeUndefined();
    children[0].emit("close", 0); // settle
    await flush();
    expect(worktreeRemoves).toHaveLength(0); // nothing allocated → nothing to tear down
    expect(engine.isInFlight("acme", "story-1")).toBe(false);
  });
});

describe("RunnerEngine.getQueueInfo — admission snapshot (story-mcp-enfileiramento-lote-dependencias)", () => {
  it("reports idle for a card with no run", () => {
    const { engine } = makeEngine();
    expect(engine.getQueueInfo("qi", "none")).toEqual({
      status: "idle",
      lane: null,
      position: null,
      estimatedStart: null,
    });
  });

  it("reports running (with the heavy lane) once the skill process is live", async () => {
    const { engine, children } = makeEngine();
    engine.runSkill("qi", "qr1", "harness-do", codeDef);
    await flush(); // worktree create → spawn → registry.start
    const info = engine.getQueueInfo("qi", "qr1");
    expect(info.status).toBe("running");
    expect(info.lane).toBe("heavy"); // harness-do is a code skill
    children[0].emit("close", 0); // settle so it doesn't leak into the shared registry
    await flush();
  });

  it("reports queued lane + 0-indexed position, shifting in lockstep as the queue drains", async () => {
    process.env.USM_AUTORUN_MAX = "1"; // one heavy run at a time → qb, qc queue behind qa
    const { engine, children } = makeEngine();
    engine.runSkill("qi", "qa", "harness-do", codeDef); // runs
    engine.runSkill("qi", "qb", "harness-do", codeDef); // queued, position 0
    engine.runSkill("qi", "qc", "harness-do", codeDef); // queued, position 1
    await flush();
    expect(engine.getQueueInfo("qi", "qb")).toMatchObject({ status: "queued", lane: "heavy", position: 0 });
    expect(engine.getQueueInfo("qi", "qc")).toMatchObject({ status: "queued", lane: "heavy", position: 1 });
    expect(engine.getQueueInfo("qi", "qc").estimatedStart!).toBeGreaterThan(Date.now() - 1); // conservative estimate

    children[0].emit("close", 0); // qa finishes → qb dequeues + spawns
    await flush();
    expect(engine.getQueueInfo("qi", "qc")).toMatchObject({ status: "queued", position: 0 }); // shifted down in lockstep
    expect(engine.getQueueInfo("qi", "qb").status).toBe("running");

    children[1]?.emit("close", 0); // drain the rest so nothing leaks into the shared registry
    await flush();
    children[2]?.emit("close", 0);
    await flush();
  });
});

describe("RunnerEngine.enqueueWithDeps — dependency-aware enqueue (story-mcp-enfileiramento-lote-dependencias)", () => {
  it("runs immediately when there are no deps, returning an unblocked result with the lane", async () => {
    const { engine, cmds, children } = makeEngine();
    const res = engine.enqueueWithDeps("dg", "solo", "harness-do", codeDef, []);
    expect(res).toMatchObject({ id: "solo", board: "dg", lane: "heavy", blocked: false });
    expect(res.reason).toBeUndefined();
    await flush();
    expect(cmds).toHaveLength(1); // actually spawned
    children[0].emit("close", 0);
    await flush();
  });

  it("registers a card with alive deps in the graph and does NOT spawn it", async () => {
    const graph = new DependencyGraph();
    const { engine, cmds, children } = makeEngine(async () => null, { depGraph: graph });
    engine.enqueueWithDeps("dg", "a", "harness-do", codeDef, []); // a runs → in-flight (alive)
    await flush();
    expect(cmds).toHaveLength(1);
    const res = engine.enqueueWithDeps("dg", "b", "harness-do", codeDef, ["dg/a"]);
    expect(res).toMatchObject({ blocked: true, blockedBy: ["dg/a"], lane: "heavy", position: null });
    expect(graph.isBlocked("dg", "b")).toBe(true);
    expect(cmds).toHaveLength(1); // b NOT spawned while a is alive
    children[0].emit("close", 0); // settle a
    await flush();
  });

  it("treats a dep that is neither in-flight nor blocked as already-settled (runs now)", async () => {
    const { engine, cmds, children } = makeEngine();
    const res = engine.enqueueWithDeps("dg", "b2", "harness-do", codeDef, ["dg/ghost"]); // ghost never enqueued
    expect(res.blocked).toBe(false);
    await flush();
    expect(cmds).toHaveLength(1);
    children[0].emit("close", 0);
    await flush();
  });

  it("counts a dep that is itself blocked in the graph as alive (chained deps)", () => {
    const graph = new DependencyGraph();
    const { engine } = makeEngine(async () => null, { depGraph: graph });
    graph.register({ board: "dg", cardId: "a3", trigger: "harness-do", def: codeDef, depsRemaining: new Set(["dg/x"]), failedDeps: new Set(), blockedSince: 0 });
    const res = engine.enqueueWithDeps("dg", "b3", "harness-do", codeDef, ["dg/a3"]); // a3 is blocked → alive
    expect(res.blocked).toBe(true);
    expect(graph.isBlocked("dg", "b3")).toBe(true);
  });

  it("surfaces a runSkill refusal (in-flight) as a reason, not a throw", async () => {
    const { engine, children } = makeEngine();
    engine.enqueueWithDeps("dg", "dup", "harness-do", codeDef, []); // takes the in-flight lock
    const res = engine.enqueueWithDeps("dg", "dup", "harness-do", codeDef, []); // refused
    expect(res).toMatchObject({ blocked: false, reason: "in-flight", lane: null });
    await flush();
    children[0].emit("close", 0);
    await flush();
  });
});

// t6 — end-to-end through the REAL engine + REAL dependency graph (only spawn is faked). This
// exercises the full wiring enqueueWithDeps → register → run settles → onComplete → onSettled →
// release runSkill, which the unit tests above stub out. `committed:false` (empty diff) makes each
// run's `close` fire emitComplete synchronously instead of deferring to the merge train — in
// production (isolation on) the release fires at the merge-back, when the predecessor is truly done.
describe("enqueue_batch chain A→B→C — dependency-aware integration (story-mcp-enfileiramento-lote-dependencias)", () => {
  it("blocks B and C until each predecessor completes, then releases them in order", async () => {
    const graph = new DependencyGraph();
    const { engine, cmds, children } = makeEngine(async () => null, { committed: false, depGraph: graph });
    expect(engine.enqueueWithDeps("sm", "A", "harness-do", codeDef, []).blocked).toBe(false);
    expect(engine.enqueueWithDeps("sm", "B", "harness-do", codeDef, ["sm/A"]).blocked).toBe(true);
    expect(engine.enqueueWithDeps("sm", "C", "harness-do", codeDef, ["sm/B"]).blocked).toBe(true);
    await flush();
    expect(cmds).toHaveLength(1); // only A is running; B, C held
    expect(graph.isBlocked("sm", "B")).toBe(true);
    expect(graph.isBlocked("sm", "C")).toBe(true);

    children[0].emit("close", 0); // A completes ok → releases B
    await flush();
    expect(cmds).toHaveLength(2); // B now runs
    expect(graph.isBlocked("sm", "B")).toBe(false);
    expect(graph.isBlocked("sm", "C")).toBe(true); // C still waits on B

    children[1].emit("close", 0); // B completes ok → releases C
    await flush();
    expect(cmds).toHaveLength(3); // C now runs
    expect(graph.isBlocked("sm", "C")).toBe(false);

    children[2].emit("close", 0); // settle C
    await flush();
  });

  it("a failed predecessor leaves the dependent blocked-by-failure (held, not cancelled, never spawned)", async () => {
    const graph = new DependencyGraph();
    const { engine, cmds, children } = makeEngine(async () => null, { committed: false, depGraph: graph });
    engine.enqueueWithDeps("sm", "A2", "harness-do", codeDef, []);
    engine.enqueueWithDeps("sm", "B2", "harness-do", codeDef, ["sm/A2"]);
    await flush();
    expect(cmds).toHaveLength(1);

    children[0].emit("close", 1); // A2 FAILS (non-zero exit → outcome "exit")
    await flush();
    await flush(); // the falha-fantasma guard settles A2 on a macrotask before emitComplete
    expect(cmds).toHaveLength(1); // B2 NEVER spawned
    expect(graph.isBlocked("sm", "B2")).toBe(true); // held for the operator
    expect([...graph.listBlocked()[0].failedDeps]).toEqual(["sm/A2"]); // blocked-by-failure
  });
});

// C1 (2026-07-08): the storymap service runs under a bun-run lifecycle, which prepends every
// node_modules/.bin dir to its PATH. Runs spawn with {...process.env}, so a dependency's bin
// shim shadowed the system `just` for EVERY headless run (just-install's shim exec's a binary
// that only exists as just.exe → ENOENT → process.exit(null) = silent no-op, rc 0). Skills read
// that as "advance path blocked" and hand-flipped card status — the ny4v26 falha-fantasma.
describe("sanitizeSpawnPath", () => {
  it("strips every node_modules/.bin segment from the spawn PATH", () => {
    const poisoned = [
      "/root/meu-monorepo/packages/storymap-ui/node_modules/.bin",
      "/root/meu-monorepo/node_modules/.bin",
      "/root/.bun/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(path.delimiter);
    expect(sanitizeSpawnPath(poisoned)).toBe(["/root/.bun/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter));
  });

  it("strips Windows-style node_modules\\.bin segments (notebook dev)", () => {
    const poisoned = ["C:\\repo\\node_modules\\.bin", "C:\\Windows\\system32"].join(";");
    expect(sanitizeSpawnPath(poisoned, ";")).toBe("C:\\Windows\\system32");
  });

  it("keeps a clean PATH unchanged and passes undefined through", () => {
    const clean = ["/root/.bun/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);
    expect(sanitizeSpawnPath(clean)).toBe(clean);
    expect(sanitizeSpawnPath(undefined)).toBeUndefined();
  });
});

// C2/O3.5 (2026-07-08, ny4v26): guard de artefatos de código. Um harness-do que sai LIMPO mas cujo
// worktree só mudou storymap/boards/ (tipicamente o flip do card) alegou build sem construir nada —
// reclassifica como no-op ANTES do teardown, para a falha aparecer e o branch flip-only não mergear.
describe("RunnerEngine.runSkill — guard de artefatos de código (C2/O3.5, harness-do)", () => {
  it("clean exit de harness-do cujo worktree só mudou storymap/boards/ → reclassificado no-op", async () => {
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, finishes } = makeEngine(async () => null, {
      changedPaths: ["storymap/boards/acme/cards/story-c2ghost.md"],
    });
    engine.runSkill("acme", "story-c2ghost", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    await flush(); // o guard settla num macrotask (roda o changedPaths async)
    expect(
      getRunnerRegistry()
        .snapshot()
        .failures.some((f) => f.cardId === "story-c2ghost" && f.reason === "no-op"),
    ).toBe(true);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-c2ghost", outcome: "no-op", endedAt: expect.any(Number) }]);
  });

  it("clean exit de harness-do com artefato de código → ok (sem falso positivo)", async () => {
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, finishes } = makeEngine(async () => null, {
      changedPaths: ["storymap/boards/acme/cards/story-c2ok.md", "packages/acmeapp/web/src/components/Facet.tsx"],
    });
    engine.runSkill("acme", "story-c2ok", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    await flush();
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "story-c2ok")).toBe(false);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-c2ok", outcome: "ok", endedAt: expect.any(Number) }]);
  });

  it("fail-open: ops sem changedPaths (default) → guard OFF, clean exit segue ok", async () => {
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, finishes } = makeEngine();
    engine.runSkill("acme", "story-c2off", "harness-do", codeDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "story-c2off")).toBe(false);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-c2off", outcome: "ok", endedAt: expect.any(Number) }]);
  });

  it("um harness-review sem mudanças de código NÃO é reclassificado (zero código é legítimo fora do harness-do)", async () => {
    process.env.USM_AUTORUN_WORKTREE = "1";
    const { engine, children, finishes } = makeEngine(async () => null, { changedPaths: [] });
    const revDef: StatusDef = { id: "revisar-codigo", name: "Rev" };
    engine.runSkill("acme", "story-c2rev", "harness-review", revDef);
    await flush();
    children[0].emit("close", 0);
    await flush();
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "story-c2rev")).toBe(false);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-c2rev", outcome: "ok", endedAt: expect.any(Number) }]);
  });
});

// WS-5.2 (story-uae2ag / colisão #4) — o TERCEIRO desfecho que faltava à guarda C2 acima: "nenhum artefato
// NESTE run" ≠ "nada entregue". Se o delta do card JÁ ESTÁ na base do run, não reimplementar foi o
// comportamento CORRETO. Estes testes dirigem o CALL-SITE (engine.ts stampBuildEvidenceIfLanded →
// proveAndStampBuildEvidence) — a lógica das camadas é de convergence.test.ts; o que se prova AQUI é o fio:
// que a régua é consultada com o range certo, que só `landed` carimba, e que o carimbo tira o run do no-op.
// Foi este fio (não a lógica) que deixou o qb8z2c reimplementar 3× por ~$13 e o uae2ag em deadlock.
describe("RunnerEngine.runSkill — guarda C2 × convergência: o delta já aterrissado (WS-5.2)", () => {
  // Um card com delta REGISTRADO (commitRange) — a única entrada de que expectedDeltaOf precisa. `tasks`
  // fica PENDENTE de propósito: um card todo-done + run anterior que avançou cairia no precheck no-op ($0,
  // sem spawn) e o processo nunca chegaria à guarda que queremos dirigir.
  const deltaCard = {
    id: "story-uae2ag",
    type: "story",
    storyType: "bug",
    status: "desenvolver",
    tasks: [{ id: "t1", title: "x", done: false }],
    findings: [],
    commitRange: { base: "aaa111", head: "bbb222" },
  } as unknown as Card;

  // O run: harness-do isolado que sai LIMPO tendo mudado só storymap/boards/ — exatamente a forma do
  // sucesso-fantasma. O que decide entre "fantasma" e "já aterrissou" é SÓ o veredito da régua.
  const runGhostBuild = async (opts: { verdict: "landed" | "partial" | "unknown"; card?: Card | null; onDisk?: Card | null }) => {
    process.env.USM_AUTORUN_WORKTREE = "1";
    const rulerCalls: Array<{ range: { base: string; head: string }; target: string }> = [];
    const card = opts.card === undefined ? deltaCard : opts.card;
    const h = makeEngine(async () => null, {
      changedPaths: ["storymap/boards/acme/cards/story-uae2ag.md"],
      readCard: async () => card,
      cardOnDisk: opts.onDisk === undefined ? card : opts.onDisk,
      deltaLandedFn: async (o) => {
        rulerCalls.push({ range: o.range, target: o.target });
        return { verdict: opts.verdict, detail: `veredito de teste: ${opts.verdict}` };
      },
    });
    h.engine.runSkill("acme", "story-uae2ag", "harness-do", codeDef);
    await flush();
    h.children[0].emit("close", 0);
    await flush();
    await flush(); // a guarda settla num macrotask (changedPaths + a prova são async)
    return { ...h, rulerCalls };
  };

  it("PROVADO landed ⇒ carimba a build-evidence e o run assenta OK — o deadlock do uae2ag morre", async () => {
    const { finishes, cardWrites, rulerCalls } = await runGhostBuild({ verdict: "landed" });
    // A régua foi consultada com o delta do CARD e a BASE DO RUN — nunca HEAD/merge-base (run-base.ts).
    expect(rulerCalls).toEqual([{ range: { base: "aaa111", head: "bbb222" }, target: "HEAD" }]);
    // Carimbou a prova, com a proveniência que diz de ONDE veio a autoridade.
    expect(cardWrites.at(-1)?.buildEvidence).toMatchObject({
      provenance: "already-landed",
      range: "aaa111..bbb222",
      target: "HEAD",
    });
    // E — o ponto todo — NÃO acusou no-op: o gate hasBuildEvidence destrava em vez de travar.
    expect(getRunnerRegistry().snapshot().failures.some((f) => f.cardId === "story-uae2ag")).toBe(false);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-uae2ag", outcome: "ok", endedAt: expect.any(Number) }]);
  });

  it.each(["unknown", "partial"] as const)("veredito %s NÃO carimba e o sucesso-fantasma REAL continua sendo pego", async (verdict) => {
    const { finishes, cardWrites } = await runGhostBuild({ verdict });
    // Fail-closed: só prova POSITIVA por conteúdo autoriza. `partial` é a metade que enganaria.
    expect(cardWrites).toEqual([]);
    expect(
      getRunnerRegistry()
        .snapshot()
        .failures.some((f) => f.cardId === "story-uae2ag" && f.reason === "no-op"),
    ).toBe(true);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-uae2ag", outcome: "no-op", endedAt: expect.any(Number) }]);
  });

  it("card SEM delta registrado ⇒ a régua nunca é consultada (curto-circuito) e a guarda decide como antes", async () => {
    const semDelta = { ...deltaCard, commitRange: undefined } as unknown as Card;
    const { finishes, rulerCalls, cardWrites } = await runGhostBuild({ verdict: "landed", card: semDelta, onDisk: semDelta });
    expect(rulerCalls).toEqual([]); // nada a provar → não gasta git perguntando
    expect(cardWrites).toEqual([]);
    expect(finishes).toEqual([{ board: "acme", cardId: "story-uae2ag", outcome: "no-op", endedAt: expect.any(Number) }]);
  });

  it("landed mas o CARIMBO falha ⇒ o run NÃO reivindica a prova que não conseguiu registrar (no-op)", async () => {
    // `onDisk: null` = o writer real devolvendo "esse card não existe". Se o carimbo não persistiu, o gate
    // seguiria fechado — assentar "ok" aqui avançaria um card cuja evidência ninguém consegue ler depois.
    const { finishes, rulerCalls } = await runGhostBuild({ verdict: "landed", onDisk: null });
    expect(rulerCalls).toHaveLength(1); // provou…
    expect(finishes).toEqual([{ board: "acme", cardId: "story-uae2ag", outcome: "no-op", endedAt: expect.any(Number) }]); // …mas não registrou ⇒ conservador
  });
});

// ── WS-4.2 card claims — the engine's reservation chokepoint ──────────────────────────────────────────
describe("RunnerEngine — card claims (WS-4.2)", () => {
  const liveClaim = (over: Partial<CardClaim> = {}): CardClaim => ({
    board: "acme",
    cardId: "story-1",
    actor: "session:outra",
    kind: "implement",
    scope: "code",
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...over,
  });

  it("reserves the card for the run (scope `code` for an isCode skill) and FREES it on settle", async () => {
    const claims = new CardClaims(memoryClaimStore());
    const { engine, children } = makeEngine(async () => null, { claims });
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    const held = await claims.list("acme");
    expect(held).toHaveLength(1);
    expect(held[0].actor).toMatch(/^run:/);
    expect(held[0].scope).toBe("code");
    expect(held[0].kind).toBe("implement");
    children[0].emit("close", 0);
    await flush();
    await flush();
    expect(await claims.list("acme")).toHaveLength(0); // the reservation dies with the run
  });

  it("a LIGHT (isCode:false) run also reserves — scope `board` (the WS-3.4 mitigation)", async () => {
    const claims = new CardClaims(memoryClaimStore());
    const { engine } = makeEngine(async () => null, { claims });
    engine.runSkill("acme", "story-1", "harness-enrich", { id: "enriquecer", name: "Especificar" });
    await flush();
    const held = await claims.list("acme");
    expect(held).toHaveLength(1);
    expect(held[0].scope).toBe("board");
  });

  it("a card held by a LIVE SESSION does NOT spawn: $0 no-op naming the holder (never burns a colliding run)", async () => {
    const claims = new CardClaims(memoryClaimStore([liveClaim({ actor: "session:abc" })]));
    const telemetry = makeTelemetry();
    const { engine, cmds, finishes } = makeEngine(async () => null, { claims, telemetry: telemetry.telemetry });
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(cmds).toHaveLength(0); // no process was ever spawned
    expect(finishes).toEqual([{ board: "acme", cardId: "story-1", outcome: "no-op", endedAt: expect.any(Number) }]);
    const row = telemetry.records[0];
    expect(row.costUSD).toBe(0);
    expect(row.status).toBe("no-op");
    // The holder is NAMED (the operator/agent reads who has it) and MARKED so the pre-check never treats
    // this settle as idempotency evidence (which would wedge the card forever).
    expect(row.summary).toContain("session:abc");
    expect(row.summary).toContain(CLAIM_REFUSED_MARKER);
    expect(engine.isInFlight("acme", "story-1")).toBe(false); // the lock is released, the card stays runnable
  });

  it("an EXPIRED reservation blocks nothing — the next run spawns normally (AC2: no deadlock by orphan)", async () => {
    const stale = liveClaim({ actor: "session:morta", expiresAt: new Date(Date.now() - 1).toISOString() });
    const claims = new CardClaims(memoryClaimStore([stale]));
    const { engine, cmds } = makeEngine(async () => null, { claims });
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(cmds).toHaveLength(1);
  });

  it("a DIFFERENT card is unaffected by a reservation (claims are per-card, never per-board)", async () => {
    const claims = new CardClaims(memoryClaimStore([liveClaim({ cardId: "story-1" })]));
    const { engine, cmds } = makeEngine(async () => null, { claims });
    engine.runSkill("acme", "story-2", "harness-do", codeDef);
    await flush();
    expect(cmds).toHaveLength(1);
  });

  it("a broken claim registry FAILS OPEN: the run spawns (a reservation outage never stops the pipeline)", async () => {
    const broken: CardClaimsPort = {
      acquire: async () => {
        throw new Error("claims store morto");
      },
      release: async () => {},
    };
    const { engine, cmds } = makeEngine(async () => null, { claims: broken });
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(cmds).toHaveLength(1);
  });

  it("frees the reservation when the run is CANCELLED mid-flight (teardown is the universal release)", async () => {
    const claims = new CardClaims(memoryClaimStore());
    const { engine, children } = makeEngine(async () => null, { claims });
    engine.runSkill("acme", "story-1", "harness-do", codeDef);
    await flush();
    expect(await claims.list("acme")).toHaveLength(1);
    expect(await engine.forceRelease("acme", "story-1")).toEqual({ released: true });
    // killTree asks the child to die; in prod its 'close' then runs settle(). Drive it here (same as the
    // forceRelease suite above) — the release rides settle's universal teardown, not the kill itself.
    children[0].emit("close", null, "SIGTERM");
    await flush();
    await flush();
    expect(await claims.list("acme")).toHaveLength(0);
  });
});

// ── WS-5.3 zero-token pre-check (precheckNoop / captureInputHash) ─────────────────────────────────────
describe("precheckNoop — the pure zero-token pre-check decision (WS-5.3)", () => {
  const inp = (over: Partial<PrecheckInput>): PrecheckInput => ({ trigger: "harness-do", origin: "autorun", ...over });

  it("case 1 — last run of this trigger was no-op AND the card .md is unchanged (mtime ≤ startedAt) → no-op", () => {
    const r = precheckNoop(inp({ lastRunOfTrigger: { status: "no-op", startedAt: 2_000 }, cardMtimeMs: 1_500 }));
    expect(r.noop).toBe(true);
  });
  it("case 1 — the card changed since the no-op (mtime > startedAt) → spawn (false positive is impossible)", () => {
    expect(precheckNoop(inp({ lastRunOfTrigger: { status: "no-op", startedAt: 2_000 }, cardMtimeMs: 2_001 })).noop).toBe(false);
  });
  it("case 1 — an unreadable mtime (null) → spawn (conservative)", () => {
    expect(precheckNoop(inp({ lastRunOfTrigger: { status: "no-op", startedAt: 2_000 }, cardMtimeMs: null })).noop).toBe(false);
  });
  it("case 1 — last run was `ok` (not no-op) → spawn (an ok non-advancing skill would do real work)", () => {
    expect(precheckNoop(inp({ trigger: "harness-ux", lastRunOfTrigger: { status: "ok", startedAt: 2_000 }, cardMtimeMs: 1_000 })).noop).toBe(false);
  });

  // WS-4.2 — a CLAIM-REFUSED settle is recorded as a `no-op` so the card surfaces honestly on Inbox, but
  // that run NEVER RAN: it is not evidence that there's nothing to do. If case 1 counted it, the card could
  // never run again (the .md can't change if nobody ever runs it) → a reservation would become a permanent
  // lock, the exact deadlock claims.ts forbids (AC2).
  it("case 1 — a CLAIM-REFUSED no-op is NOT idempotency evidence → spawn (no deadlock after the claim frees)", () => {
    const r = precheckNoop(
      inp({
        lastRunOfTrigger: {
          status: "no-op",
          startedAt: 2_000,
          summary: `pre-check no-op: ${CLAIM_REFUSED_MARKER}: card reservado por session:x (implement/code) desde 10:00`,
        },
        cardMtimeMs: 1_500, // unchanged since that "run" — case 1 would fire without the marker
      }),
    );
    expect(r.noop).toBe(false);
  });
  it("case 1 — a REAL no-op (any other summary) still short-circuits (WS-5.3 unchanged)", () => {
    const r = precheckNoop(
      inp({ lastRunOfTrigger: { status: "no-op", startedAt: 2_000, summary: "nada a fazer" }, cardMtimeMs: 1_500 }),
    );
    expect(r.noop).toBe(true);
  });

  it("case 2 — harness-do, all tasks done + a prior run advanced + no open blocker → no-op (the eqpdtz $0.99)", () => {
    const r = precheckNoop(inp({ tasks: [{ done: true }, { done: true }], lastRunOfTrigger: { status: "exit", startedAt: 1, advanced: true }, hasOpenBlocker: false }));
    expect(r.noop).toBe(true);
  });
  it("case 2 — an OPEN blocker means work remains → spawn (a reopened/reverted card is never falsely no-oped)", () => {
    expect(precheckNoop(inp({ tasks: [{ done: true }], lastRunOfTrigger: { status: "exit", startedAt: 1, advanced: true }, hasOpenBlocker: true })).noop).toBe(false);
  });
  it("case 2 — the prior run did NOT advance (work never integrated) → spawn", () => {
    expect(precheckNoop(inp({ tasks: [{ done: true }], lastRunOfTrigger: { status: "no-op", startedAt: 1, advanced: false }, cardMtimeMs: 2 })).noop).toBe(false);
  });
  it("case 2 — a task still open → spawn; no tasks at all → spawn", () => {
    expect(precheckNoop(inp({ tasks: [{ done: true }, { done: false }], lastRunOfTrigger: { status: "exit", startedAt: 1, advanced: true } })).noop).toBe(false);
    expect(precheckNoop(inp({ tasks: [], lastRunOfTrigger: { status: "exit", startedAt: 1, advanced: true } })).noop).toBe(false);
  });

  it("case 3 — harness-capture: the stamped input hash matches the current input → no-op ($0.47 retry)", () => {
    const r = precheckNoop(inp({ trigger: "harness-capture", origin: "manual", proposalInputHash: "abc", currentInputHash: "abc" }));
    expect(r.noop).toBe(true);
  });
  it("case 3 — harness-capture: a mismatch (body/feedback changed) → spawn", () => {
    expect(precheckNoop(inp({ trigger: "harness-capture", proposalInputHash: "abc", currentInputHash: "def" })).noop).toBe(false);
  });
  it("case 3 — harness-capture: no stamp on the proposal yet → spawn (inert until the skill stamps)", () => {
    expect(precheckNoop(inp({ trigger: "harness-capture", proposalInputHash: null, currentInputHash: "abc" })).noop).toBe(false);
  });

  it("a conflict-redrive is NEVER pre-checked (it re-integrates a preserved branch) even with all tasks done", () => {
    expect(precheckNoop(inp({ origin: "conflict-redrive", tasks: [{ done: true }], lastRunOfTrigger: { status: "exit", startedAt: 1, advanced: true } })).noop).toBe(false);
  });
});

describe("captureInputHash — deterministic input hash for the capture pre-check (WS-5.3)", () => {
  it("is stable for the same (body, feedback) and changes when either changes", () => {
    const a = captureInputHash("dor do usuário", ["mais foco em X"]);
    expect(captureInputHash("dor do usuário", ["mais foco em X"])).toBe(a);
    expect(captureInputHash("dor do usuário DIFERENTE", ["mais foco em X"])).not.toBe(a);
    expect(captureInputHash("dor do usuário", ["mais foco em X", "e Y"])).not.toBe(a);
    // NUL-joined → no field-boundary collision (body "a" + fb "b" ≠ body "ab" + no fb)
    expect(captureInputHash("a", ["b"])).not.toBe(captureInputHash("ab", []));
  });
});

describe("RunnerEngine pre-check — settle a $0 no-op WITHOUT spawning (WS-5.3)", () => {
  const codeDef2: StatusDef = { id: "desenvolver", name: "Desenvolver" };
  // A telemetry double whose listByCard reports a PRIOR harness-do run that advanced (advanced:true) — the eqpdtz
  // shape — and records every settle so a test can assert the $0 no-op. Returns the shared `records` array.
  const priorAdvancedTelemetry = () => {
    const records: TelemetryRecord[] = [];
    const telemetry: TelemetryPort = {
      recordRun: async (r) => {
        records.push(r);
      },
      listByCard: async () =>
        [{ id: "prev", board: "acme", cardId: "c1", trigger: "harness-do", startedAt: 1_000, durationMs: 1, turns: 1, inputTokens: null, outputTokens: null, costUSD: 0.99, status: "exit", advanced: true }] as TelemetryRecord[],
      boardSummary: async (boardId) => ({ boardId, cards: [], totalCostUSD: 0 }),
    };
    return { telemetry, records };
  };

  it("case 2 — harness-do, all tasks done + prior advanced + no blocker → $0 no-op, NEVER spawns, releases the lock", async () => {
    const { telemetry, records } = priorAdvancedTelemetry();
    const card = { id: "c1", type: "story", storyType: "bug", status: "desenvolver", tasks: [{ id: "t1", title: "x", done: true }], findings: [] } as unknown as Card;
    const { engine, cmds } = makeEngine(async () => null, { telemetry, readCard: async () => card });
    expect(engine.runSkill("acme", "c1", "harness-do", codeDef2).ok).toBe(true);
    await flush();
    expect(cmds).toEqual([]); // NEVER spawned a claude process
    const noop = records.find((r) => r.status === "no-op");
    expect(noop?.costUSD).toBe(0);
    expect(engine.isInFlight("acme", "c1")).toBe(false); // settled + lock released
  });

  it("case 2 does NOT fire when an OPEN blocker remains → the run spawns normally", async () => {
    const { telemetry } = priorAdvancedTelemetry();
    const card = { id: "c1", type: "story", storyType: "bug", status: "desenvolver", tasks: [{ id: "t1", title: "x", done: true }], findings: [{ id: "f1", lens: "security", severity: "blocker", title: "x", status: "open" }] } as unknown as Card;
    const { engine, cmds } = makeEngine(async () => null, { telemetry, readCard: async () => card });
    engine.runSkill("acme", "c1", "harness-do", codeDef2);
    await flush();
    expect(cmds).toHaveLength(1); // spawned — a card with unresolved work is never falsely no-oped
  });

  it("a conflict-redrive is NEVER pre-checked → it spawns even with all tasks done (re-integration path)", async () => {
    const { telemetry } = priorAdvancedTelemetry();
    const card = { id: "c1", type: "story", storyType: "bug", status: "desenvolver", tasks: [{ id: "t1", title: "x", done: true }], findings: [] } as unknown as Card;
    const { engine, cmds } = makeEngine(async () => null, { telemetry, readCard: async () => card });
    engine.runSkill("acme", "c1", "harness-do", codeDef2, { origin: "conflict-redrive", preservedBranch: "conflicted/run/x" });
    await flush();
    expect(cmds).toHaveLength(1);
  });
});

// ── WS-8.1 cancel phase-brake (recentlyCancelledAgeMs / forceRelease marker) ──────────────────────────
describe("RunnerEngine cancel phase-brake (WS-8.1)", () => {
  const codeDef3: StatusDef = { id: "priorizar", name: "Priorizar" };

  it("forceRelease arms the brake at the card's resting status; a same-status re-eval is braked, a MOVE clears it", async () => {
    const { engine, children } = makeEngine(async () => "priorizar"); // status read for the marker
    engine.runSkill("acme", "c1", "harness-enrich", codeDef3);
    await flush();
    expect(children).toHaveLength(1);
    await engine.forceRelease("acme", "c1"); // kills the child + arms the brake with status "priorizar"
    // same status (the cascade would re-engage from here) → braked (age ≥ 0)
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "priorizar")).toBeGreaterThanOrEqual(0);
    // a human MOVE (different status) clears the brake as a side effect
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "pronta")).toBeNull();
    // …and it stays cleared thereafter
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "priorizar")).toBeNull();
  });

  it("clearRecentlyCancelled drops the brake explicitly", async () => {
    const { engine } = makeEngine(async () => "priorizar");
    engine.runSkill("acme", "c1", "harness-enrich", codeDef3);
    await flush();
    await engine.forceRelease("acme", "c1");
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "priorizar")).toBeGreaterThanOrEqual(0);
    engine.clearRecentlyCancelled("acme", "c1");
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "priorizar")).toBeNull();
  });

  it("an explicit manual re-run (retry/enqueue) drops the brake once the cancelled run settled", async () => {
    const { engine, children } = makeEngine(async () => "priorizar");
    engine.runSkill("acme", "c1", "harness-enrich", codeDef3);
    await flush();
    await engine.forceRelease("acme", "c1"); // arms the brake + kills the child
    children[0].emit("close", 143, "SIGTERM"); // the cancelled run settles → releases the in-flight lock
    await flush();
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "priorizar")).toBeGreaterThanOrEqual(0); // still braked
    engine.runSkill("acme", "c1", "harness-enrich", codeDef3, { origin: "manual" }); // explicit resume → clears
    expect(engine.recentlyCancelledAgeMs("acme", "c1", "priorizar")).toBeNull();
  });

  it("a card that was never cancelled is never braked", () => {
    const { engine } = makeEngine();
    expect(engine.recentlyCancelledAgeMs("acme", "never", "any")).toBeNull();
  });
});

// autonomy-endgame WS-1.3 — the redrive pre-check's THREE outcomes. It had zero tests, and that absence hid
// two bugs that cost real money: it measured the WHOLE delta against ONE ref (so a split run — code on
// `stage`, board-data on `main` — was structurally unprovable ⇒ `absent` ⇒ SPAWN ⇒ the fix that had already
// landed got re-implemented from zero: the qb8z2c pattern, 3× for ~$13), and it tested the literal
// `provenance !== "reflog"` that convergence.ts documents as THE bug (a session's exact base is the
// base-ref). `string | null` fused three situations into one "spawn"; the middle one is the live incident.
describe("WS-1.3 — o pre-check do redrive tem TRÊS desfechos, não dois", () => {
  const card = {
    id: "story-novo-item",
    type: "story",
    storyType: "bug",
    status: "desenvolver",
    tasks: [{ id: "t1", title: "x", done: false }],
    findings: [],
  } as unknown as Card;

  const runRedrive = async (split: SplitLandedness) => {
    const calls: string[] = [];
    const h = makeEngine(async () => null, {
      readBoardConfig: async () => ({ statuses: [{ id: "desenvolver", name: "Desenvolver", trigger: "harness-do" }] }) as never,
      readCard: async () => card,
      cardOnDisk: card,
      branchWorkLandedBySplitFn: async (branch) => {
        calls.push(branch);
        return split;
      },
    });
    const outcome = await h.redriveHandlers[0]?.({
      board: "acme",
      cardId: "story-novo-item",
      trigger: "harness-do" as never,
      driveCount: 1,
      conflictDetail: "split: board data não aplicou em main",
      preservedBranch: "conflicted/run/a779b5be",
    });
    await flush();
    return { ...h, outcome, calls };
  };

  it("as DUAS metades aterrissadas ⇒ already-landed: $0, ZERO spawn, evidência carimbada", async () => {
    const { outcome, cardWrites, children, calls } = await runRedrive({
      code: "landed",
      data: "landed",
      detail: "código→stage: pós-imagem | dados→main: pós-imagem",
      base: "base111",
    });
    // Measured against the PRESERVED branch — its own work, from its own cut point.
    expect(calls).toEqual(["conflicted/run/a779b5be"]);
    // THE POINT: no agent was spawned. This is the $13 that stops being spent.
    expect(children).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: true, reason: "already-landed" });
    // The proof is recorded with the REAL base and both refs — never a whole-delta re-measurement, which
    // would answer `absent` for the very work just proven landed.
    expect(cardWrites.at(-1)?.buildEvidence).toMatchObject({
      provenance: "already-landed",
      range: "base111..conflicted/run/a779b5be",
      target: "stage+main (split)",
    });
  });

  it("código em stage + dados AUSENTES ⇒ half-landed: NÃO spawna, parqueia legível (a foto de a779b5be)", async () => {
    const { outcome, children } = await runRedrive({
      code: "landed",
      data: "absent",
      detail: "código→stage: pós-imagem | dados→main: nem ancestralidade, nem pós-imagem",
      base: "base222",
    });
    // Re-driving here would re-implement code that is ALREADY published on `stage` AND not fix the data
    // (the failure was in `git apply`, not in the skill). So: no spawn.
    expect(children).toHaveLength(0);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toBe("half-landed");
    // `ok:false` ⇒ the train parks the entry as `conflict` WITH this detail. A stopped, legible card beats
    // $13 of silent re-implementation — and the detail must name the RIGHT recovery, not "re-drive".
    expect(outcome?.detail).toMatch(/MEIA-ATERRISSAGEM/);
    expect(outcome?.detail).toMatch(/RETENTAR a metade de dados/);
    // It must also say WHY re-driving is the wrong instinct — the operator reading this at 3am is exactly
    // who would otherwise hit "re-drive" and buy the qb8z2c loop back.
    expect(outcome?.detail).toMatch(/re-implementaria código já publicado/);
  });

  it.each([
    ["unknown numa metade (soluço do git)", { code: "landed", data: "unknown" }],
    ["código AUSENTE (o trabalho não está lá)", { code: "absent", data: "landed" }],
    ["base estimada ⇒ tudo unknown", { code: "unknown", data: "unknown" }],
  ] as const)("%s ⇒ spawna (dúvida spawna — o conservador de hoje, intacto)", async (_name, halves) => {
    const { outcome, children } = await runRedrive({ ...halves, detail: "veredito de teste", base: "base333" });
    expect(children).toHaveLength(1); // o agente fresco roda
    expect(outcome?.ok).toBe(true);
    expect(outcome?.reason).toBeUndefined(); // admitido normalmente, sem atalho
  });
});
