import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";
import type { WorktreeOps } from "@/lib/storymap/runner/worktree";
import type { VpsResources } from "@/lib/storymap/runner/scheduler";
import type { RunnerJournalPort } from "@/lib/storymap/runner/journal";

// The shared autorun kernel (story-ex0114): the single side-effectful entry that BOTH the
// fs-watcher channel AND the in-process moveCardAction (drag + MCP move_card) funnel
// through. Verifies it honors the live master switch, runs/forwards/stops per the pure
// decision, and ALWAYS passes the engine's dedupe window so a duplicate fire (the watcher
// echoing a move the server action already handled) collapses into a single run.

// Spies referenced inside the (hoisted) vi.mock factories — vi.hoisted guarantees they're
// initialized before the factories run, sidestepping the ESM import-hoist TDZ.
const { mockRunSkill, mockUpdateCardOnDisk, mockLastRun, mockListByCard, mockRecentlyCancelledAgeMs, mockDispatchConductor, mockRunEntryEffect, mockPaceRow, mockHoldBoardEntry, mockHoldBoardScopeEntry } = vi.hoisted(() => ({
  // O RITMO DO BOARD (runner/board-pace.ts): a linha de ritmo que o portão lê (null = normal) e a anotação do disparo
  // retido — nunca o arquivo de verdade.
  mockPaceRow: { value: null as unknown },
  mockHoldBoardEntry: vi.fn(async (..._a: unknown[]) => {}),
  // A anotação do que o ESCOPO DE TIPOS segurou (a mesma rede da pausa, para o escopo alargar devolver).
  mockHoldBoardScopeEntry: vi.fn(async (..._a: unknown[]) => {}),
  // O efeito de entrada de um passo (promote-and-deploy…) — NUNCA o real: seria um deploy de verdade.
  mockRunEntryEffect: vi.fn(async (..._a: unknown[]) => {}),
  // conductor-core: the conductor dispatch's ENTRY half (fleet-deps) — spied so a board with `conductor` can be
  // driven without spawning anything; resolves like the real one (driver + queue awaited, pump fired).
  mockDispatchConductor: vi.fn(async (..._a: unknown[]) => {}),
  mockRunSkill: vi.fn((..._args: unknown[]) => ({ ok: true as const })),
  // updateCardOnDisk(board, cardId, mutate): apply the forward's status delta to a disk-card stub so
  // the result is observable — mirrors the real LOCKED read-modify-write (audit unlocked-write fix).
  mockUpdateCardOnDisk: vi.fn(
    async (_b: string, id: string, mutate: (c: { id: string; status: string | null }) => unknown) =>
      mutate({ id, status: "landing" }),
  ),
  // the engine's durable "last run" read the loop-guard consults. Default undefined
  // (empty journal) → the guard resets to 0 and never trips; per-test set to drive the STOP path.
  mockLastRun: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  // the telemetry read the budget backstop sums (+ WS-8.3 last-run-cancelled). Default empty
  // ($0, no cancelled last run) → never over budget, threading unaffected.
  mockListByCard: vi.fn(async (..._a: unknown[]) => [] as Array<{ costUSD: number | null; status?: string }>),
  // WS-8.1: the cancel phase-brake read. Default null (no brake) → the cascade proceeds; a test overrides it
  // to a positive age to assert the re-eval STOPS (does not spawn) and logs the pause line.
  mockRecentlyCancelledAgeMs: vi.fn((..._a: unknown[]) => null as number | null),
}));

// Engine: spy getRunnerEngine().runSkill + .lastRun while keeping the REAL RunnerEngine + the real
// AUTORUN_DEDUPE_MS constant (importActual spread) for the integration dedup test below.
vi.mock("@/lib/storymap/runner/engine", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/engine")>();
  return {
    ...actual,
    getRunnerEngine: () => ({ runSkill: mockRunSkill, onComplete: () => () => {}, lastRun: mockLastRun, recentlyCancelledAgeMs: mockRecentlyCancelledAgeMs, clearRecentlyCancelled: () => {} }),
  };
});

// Telemetry: spy getTelemetryStore().listByCard (the 4a budget read). Fake also implements recordRun +
// boardSummary so the REAL RunnerEngine in the dedup test (its default telemetry = getTelemetryStore())
// still satisfies TelemetryPort. The dedup run never settles, so recordRun is never called here.
vi.mock("@/lib/storymap/runner/telemetry", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/telemetry")>();
  return {
    ...actual,
    getTelemetryStore: () => ({
      listByCard: mockListByCard,
      recordRun: async () => {},
      boardSummary: async () => ({ boardId: "b", cards: [], totalCostUSD: 0 }),
    }),
  };
});

// Master switch + full settings: the helper reads .autorun.enabled, but the REAL engine
// (dedup test) reads .autorun.scheduler.lanes too — so return the actual default settings
// (master switch forced ON), overridden per test via mockReturnValue.
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  const on = { ...actual.DEFAULT_RUNNER_SETTINGS, autorun: { ...actual.DEFAULT_RUNNER_SETTINGS.autorun, enabled: true } };
  return { ...actual, loadRunnerConfig: vi.fn(() => on) };
});

// O portão do board: as regras REAIS (resolveBoardGate) sobre a linha de ritmo que o teste escolhe.
vi.mock("@/lib/storymap/runner/board-pace-store", async () => {
  const pace = await vi.importActual<typeof import("@/lib/storymap/runner/board-pace")>("@/lib/storymap/runner/board-pace");
  return {
    boardGateNow: (_board: string, config: { autorunDisabled?: boolean } | null) => pace.resolveBoardGate(config, mockPaceRow.value as never, Date.now()),
    holdBoardEntry: mockHoldBoardEntry,
    holdBoardScopeEntry: mockHoldBoardScopeEntry,
  };
});

// The conductor dispatch (conductor-core) — the real module would touch the fleet registry and tmux.
vi.mock("@/lib/storymap/runner/fleet-deps", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/fleet-deps")>();
  return { ...actual, dispatchConductorOnEntry: mockDispatchConductor };
});

vi.mock("@/lib/storymap/runner/entry-effects", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/entry-effects")>();
  return { ...actual, runEntryEffect: mockRunEntryEffect };
});

// Board + card reads — driven per test.
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readBoardConfig: vi.fn(), readCards: vi.fn() };
});

// Forward target writer — observed in the FORWARD test (now the locked updateCardOnDisk).
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return { ...actual, updateCardOnDisk: mockUpdateCardOnDisk };
});

import { evaluateAutorunOnEntry, nextNoProgressCount, threadResumeSessionId } from "./autorun-eval";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { coerceCard, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { DEFAULT_RUNNER_SETTINGS, loadRunnerConfig } from "@/lib/storymap/runner/config";
import { AUTORUN_DEDUPE_MS, RunnerEngine } from "@/lib/storymap/runner/engine";
import { HEADROOM_SUGGESTED_URL } from "@/lib/storymap/runner/headroom";
import { getPublishBreaker, resetPublishBreakerForTest } from "@/lib/storymap/runner/publish-breaker";
import { runnerStateDir } from "@/lib/storymap/paths";

const settings = (enabled: boolean) => ({
  ...DEFAULT_RUNNER_SETTINGS,
  autorun: { ...DEFAULT_RUNNER_SETTINGS.autorun, enabled },
});

const cfg = (statuses: StatusDef[]): BoardConfig => ({
  id: "b",
  name: "B",
  statuses,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
});

const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mockPaceRow.value = null; // ritmo normal, salvo o teste que pausa
  mockHoldBoardEntry.mockClear();
  mockHoldBoardScopeEntry.mockClear();
  mockDispatchConductor.mockClear();
  mockRunSkill.mockClear();
  mockUpdateCardOnDisk.mockClear();
  mockLastRun.mockClear();
  mockLastRun.mockResolvedValue(undefined);
  mockListByCard.mockClear();
  mockListByCard.mockResolvedValue([]);
  mockRecentlyCancelledAgeMs.mockClear();
  mockRecentlyCancelledAgeMs.mockReturnValue(null);
  vi.mocked(loadRunnerConfig).mockReturnValue(settings(true));
});

afterEach(() => vi.clearAllMocks());

describe("evaluateAutorunOnEntry — the shared autorun kernel", () => {
  it("RUNS the column's skill with the dedupe window when a card lands in an autorun:true+trigger column", async () => {
    const config = cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    // A suíte roda com AGILEHARNESS_HEADROOM_URL=off (vitest.setup.ts, hermeticidade). Aqui removemos o
    // kill switch DE PROPÓSITO: sem NENHUMA declaração — nem env, nem `headroom` no board — o valor
    // resolvido tem de ser `null`, e é o que o kernel repassa (o
    // default deixou de ser um endereço de loopback embutido, que na máquina de quem instala ou não
    // responde ou responde por ser outra coisa). A COBERTURA de quem tem o sidecar continua vindo da
    // declaração — é o caso irmão logo abaixo que prova o repasse.
    const savedKillSwitch = process.env.AGILEHARNESS_HEADROOM_URL;
    delete process.env.AGILEHARNESS_HEADROOM_URL;
    try {
      await evaluateAutorunOnEntry("b", "c");
    } finally {
      if (savedKillSwitch !== undefined) process.env.AGILEHARNESS_HEADROOM_URL = savedKillSwitch;
    }

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    const [board, cardId, trigger, def, opts] = mockRunSkill.mock.calls[0];
    expect({ board, cardId, trigger, defId: (def as StatusDef).id }).toEqual({
      board: "b",
      cardId: "c",
      trigger: "harness-do",
      defId: "desenvolver",
    });
    // ALWAYS passes the dedupe window — the property that lets the engine collapse a
    // watcher echo of a move the server action already fired into ONE run — plus the resolved
    // headroom URL (aqui `null`: nada declarado ⇒ tráfego direto) e os loop-guard
    // fields (column = the trigger status; noProgressRuns = 0, a fresh column).
    expect(opts).toEqual({
      dedupeWindowMs: AUTORUN_DEDUPE_MS,
      headroomUrl: null,
      column: "desenvolver",
      noProgressRuns: 0,
      // o card que a cascata dispara, para o pump do engine segurar o job se o escopo de tipos estreitar na fila
      scopeCard: { id: "c", type: "story", storyType: "bug", mode: undefined, status: "desenvolver" },
    });
  });

  it("[PAR] com o proxy DECLARADO no env, o kernel repassa a URL — é assim que a cobertura existe", async () => {
    // O par do caso acima, e o que impede a correção de virar "o proxy nunca é usado": quem tem o
    // sidecar declara, e a declaração precisa CHEGAR ao spawn. Sem este caso, o `null` de cima
    // passaria a valer também para quem configurou, sem ninguém perceber.
    const config = cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    vi.stubEnv("AGILEHARNESS_HEADROOM_URL", HEADROOM_SUGGESTED_URL);
    try {
      await evaluateAutorunOnEntry("b", "c");
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    const [, , , , opts] = mockRunSkill.mock.calls[0];
    expect((opts as { headroomUrl: string | null }).headroomUrl).toBe(HEADROOM_SUGGESTED_URL);
  });

  it("does NOTHING when the master switch is OFF (never even reads the board)", async () => {
    vi.mocked(loadRunnerConfig).mockReturnValue(settings(false));

    await evaluateAutorunOnEntry("b", "c");

    expect(readBoardConfig).not.toHaveBeenCalled();
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  it("WS-8.1 — a recently-cancelled card is PHASE-BRAKED: the cascade does NOT spawn (both re-eval paths)", async () => {
    const config = cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);
    mockRecentlyCancelledAgeMs.mockReturnValue(2_000); // braked 2s ago

    // the run-completion threading path (suppressTrigger) AND the fs-watch path (no opts) are BOTH braked
    await evaluateAutorunOnEntry("b", "c", { suppressTrigger: "harness-enrich" });
    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled();
    // the brake was consulted against the card's CURRENT status (so a move already clears it there)
    expect(mockRecentlyCancelledAgeMs).toHaveBeenCalledWith("b", "c", "desenvolver");
  });

  it("WS-8.1 — once the brake is gone (null), the cascade spawns normally again", async () => {
    const config = cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);
    mockRecentlyCancelledAgeMs.mockReturnValue(null); // no brake (default)

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
  });

  it("does NOTHING when the BOARD has autorunDisabled — reads the board but never fires (story-ex0077)", async () => {
    // Per-board kill-switch: a card sitting in an autorun:true+trigger column of a board flagged
    // autorunDisabled (e.g. the `storymap` dogfood board) must NOT auto-fire — the operator always
    // runs skills manually there. Distinct from the master switch: the board IS read (the gate is
    // per-board, after readBoardConfig), but no run/forward happens.
    const config = { ...cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]), autorunDisabled: true };
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(readBoardConfig).toHaveBeenCalled(); // per-board gate DID read the board (unlike the master switch)
    expect(mockRunSkill).not.toHaveBeenCalled(); // ...but the disabled board never spawns a run
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled(); // nor forwards a gated landing
  });

  it("BOARD PAUSADO pelo ritmo: nada dispara, e o disparo retido fica anotado para a retomada devolver", async () => {
    mockPaceRow.value = { board: "b", agent: { level: "paused", by: { kind: "agent" }, at: new Date().toISOString() } };
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
    expect(mockRunEntryEffect).not.toHaveBeenCalled();
    expect(mockDispatchConductor).not.toHaveBeenCalled();
    expect(mockHoldBoardEntry).toHaveBeenCalledWith("b", "c", "entry");
  });

  it("BOARD PAUSADO: o run que acabou sem avançar o card NÃO é anotado (a retomada rodaria a mesma skill de novo)", async () => {
    mockPaceRow.value = { board: "b", owner: { level: "paused", by: { kind: "owner" }, at: new Date().toISOString() } };
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    await evaluateAutorunOnEntry("b", "c", { suppressTrigger: "harness-do" });

    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockHoldBoardEntry).not.toHaveBeenCalled();
  });

  it("BOARD DESARMADO não anota nada (não há retomada: é um board de sessão guiada)", async () => {
    vi.mocked(readBoardConfig).mockResolvedValue({ ...cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]), autorunDisabled: true });
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockHoldBoardEntry).not.toHaveBeenCalled();
  });

  it("BOARD DEVAGAR dispara normalmente — quem limita a um por vez é o pump do engine", async () => {
    mockPaceRow.value = { board: "b", owner: { level: "slow", by: { kind: "owner" }, at: new Date().toISOString() } };
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "bug" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockHoldBoardEntry).not.toHaveBeenCalled();
  });

  it("STOPS (no run, no forward) for a manual column", async () => {
    const config = cfg([{ id: "pronta", name: "Pronta", autorun: false }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "pronta", storyType: "user" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
  });

  it("FORWARDS a gated landing, then RUNS the next column's skill IN-PROCESS (no watcher dependency)", async () => {
    const config = cfg([
      { id: "landing", name: "Landing", autorun: true }, // autorun, no trigger → forward
      { id: "quebrar-tasks", name: "Quebrar tasks", trigger: "harness-tasks", autorun: true },
    ]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    // 1st read → the landing status (→ forward); 2nd read (the in-process re-trigger) → the forwarded
    // status (→ run harness-tasks). Models the on-disk write the forward just made. (forward-fs-watch-only)
    vi.mocked(readCards)
      .mockResolvedValueOnce([card({ status: "landing", storyType: "user" })])
      .mockResolvedValue([card({ status: "quebrar-tasks", storyType: "user" })]);

    await evaluateAutorunOnEntry("b", "c");
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget re-trigger settle

    expect(mockUpdateCardOnDisk).toHaveBeenCalledTimes(1); // the forward landing→quebrar-tasks
    const mutate = mockUpdateCardOnDisk.mock.calls[0][2] as (c: { status: string | null }) => { status: string };
    expect(mutate({ status: "landing" })).toMatchObject({ status: "quebrar-tasks" });
    // the re-trigger ran the FORWARDED column's skill in-process — no longer waiting on the fs.watcher
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockRunSkill.mock.calls[0][2]).toBe("harness-tasks");
  });

  it("FORWARD is anti-clobber — the mutate ABORTS when the card was re-routed under the lock (concurrent revert)", async () => {
    const config = cfg([
      { id: "landing", name: "Landing", autorun: true }, // autorun, no trigger → forward to quebrar-tasks
      { id: "quebrar-tasks", name: "Quebrar tasks", trigger: "harness-tasks", autorun: true },
    ]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    // 1st read → `landing` (decide forward); the re-trigger's read → the forwarded status, so the
    // in-process re-trigger settles (a flat mockResolvedValue would loop the forward → OOM).
    vi.mocked(readCards)
      .mockResolvedValueOnce([card({ status: "landing", storyType: "user" })]) // decided FROM `landing`
      .mockResolvedValue([card({ status: "quebrar-tasks", storyType: "user" })]);

    await evaluateAutorunOnEntry("b", "c");
    await new Promise((r) => setTimeout(r, 0));

    const mutate = mockUpdateCardOnDisk.mock.calls[0][2] as (c: { status: string | null }) => { status: string } | null;
    // still in `landing` under the lock (nobody else wrote) → the forward applies
    expect(mutate({ status: "landing" })).toMatchObject({ status: "quebrar-tasks" });
    // re-routed to `desenvolver` by a concurrent deploy-failure revert → ABORT (null), never clobber the reopen
    expect(mutate({ status: "desenvolver" })).toBeNull();
  });

  it("a forward into a MANUAL column STOPS — the in-process re-trigger no-ops (recursion terminates)", async () => {
    const config = cfg([
      { id: "landing", name: "Landing", autorun: true }, // autorun, no trigger → forward
      { id: "parada", name: "Parada", autorun: false }, // manual, no trigger → STOP
    ]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards)
      .mockResolvedValueOnce([card({ status: "landing", storyType: "user" })])
      .mockResolvedValue([card({ status: "parada", storyType: "user" })]);

    await evaluateAutorunOnEntry("b", "c");
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdateCardOnDisk).toHaveBeenCalledTimes(1); // forwarded once, landing→parada
    expect(mockRunSkill).not.toHaveBeenCalled(); // manual column → re-trigger stops, no spurious run/loop
  });

  it("does not throw when the card no longer exists on disk", async () => {
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id: "x", name: "X", autorun: true }]));
    vi.mocked(readCards).mockResolvedValue([]);

    await expect(evaluateAutorunOnEntry("b", "missing")).resolves.toBeUndefined();
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  // ── same-column-no-progress loop-guard ──────────────────────────────────────────────────────
  it("passes the loop-guard column + incremented count into the spawn on a non-advancing repeat (< cap)", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);
    // Last run processed the SAME column + trigger at count 1 → next = 2, below the default cap (3) → RUN.
    mockLastRun.mockResolvedValue({ column: "qa-automatizado", noProgressRuns: 1, trigger: "harness-qa" });

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    const opts = mockRunSkill.mock.calls[0][4] as { column?: string; noProgressRuns?: number };
    expect(opts.column).toBe("qa-automatizado");
    expect(opts.noProgressRuns).toBe(2); // 1 + 1 — stamped so recordStart persists it (durable)
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled(); // no finding while under the cap
  });

  it("STOPS + writes a loop-guard finding when the no-progress count reaches the cap (never spawns)", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);
    // count 2 + 1 = 3 === default cap → circuit-break.
    mockLastRun.mockResolvedValue({ column: "qa-automatizado", noProgressRuns: 2, trigger: "harness-qa" });

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled(); // circuit-broken — no $ burned
    expect(mockUpdateCardOnDisk).toHaveBeenCalledTimes(1);
    // the mutate stamps a high (non-blocker) general loop-guard finding, and is NULL-idempotent (loop-safe)
    const mutate = mockUpdateCardOnDisk.mock.calls[0][2] as (
      c: { id: string; status: string | null; findings?: Array<{ id: string; severity: string }> },
    ) => { findings: Array<{ id: string; severity: string }> } | null;
    const written = mutate({ id: "c", status: "qa-automatizado", findings: [] });
    expect(written).not.toBeNull();
    expect(written!.findings[0].id).toBe("loop-guard-c");
    expect(written!.findings[0].severity).toBe("high");
    // identical finding already present → null → NO write → no fs-watcher re-eval loop
    expect(mutate({ id: "c", status: "qa-automatizado", findings: written!.findings })).toBeNull();
  });

  it("a different trigger for the same status RESETS the loop-guard (no stop, count 0)", async () => {
    const config = cfg([{ id: "revisar-codigo", name: "Rev", trigger: "harness-review", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "revisar-codigo", storyType: "user" })]);
    // The last run in this column was a DIFFERENT trigger (harness-qa) — a new kind of work resets the counter.
    mockLastRun.mockResolvedValue({ column: "revisar-codigo", noProgressRuns: 9, trigger: "harness-qa" });

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect((mockRunSkill.mock.calls[0][4] as { noProgressRuns?: number }).noProgressRuns).toBe(0);
  });

  it("AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX-style cap of 0 DISABLES the guard (runs even at a high count)", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);
    vi.mocked(loadRunnerConfig).mockReturnValue({
      ...settings(true),
      autorun: { ...settings(true).autorun, noProgressMax: 0 },
    });
    mockLastRun.mockResolvedValue({ column: "qa-automatizado", noProgressRuns: 50, trigger: "harness-qa" });

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).toHaveBeenCalledTimes(1); // cap 0 → never trips
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
  });

  // ── opt-in per-card $ backstop ──────────────────────────────────────────────────────────────
  it("is INERT by default — never reads telemetry when cardBudgetUSD is unset", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(mockListByCard).not.toHaveBeenCalled(); // default OFF → no cost read
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
  });

  it("STOPS + writes a budget finding when the card's lifetime cost reaches cardBudgetUSD", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);
    vi.mocked(loadRunnerConfig).mockReturnValue({
      ...settings(true),
      autorun: { ...settings(true).autorun, cardBudgetUSD: 10 },
    });
    mockListByCard.mockResolvedValue([{ costUSD: 6 }, { costUSD: 5 }]); // $11 ≥ $10

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockUpdateCardOnDisk).toHaveBeenCalledTimes(1);
    const mutate = mockUpdateCardOnDisk.mock.calls[0][2] as (
      c: { id: string; status: string | null; findings?: Array<{ id: string }> },
    ) => { findings: Array<{ id: string }> } | null;
    const written = mutate({ id: "c", status: "qa-automatizado", findings: [] });
    expect(written!.findings[0].id).toBe("card-budget-c");
  });

  it("does NOT stop when the card's cost is UNDER cardBudgetUSD (normal spawn)", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);
    vi.mocked(loadRunnerConfig).mockReturnValue({
      ...settings(true),
      autorun: { ...settings(true).autorun, cardBudgetUSD: 10 },
    });
    mockListByCard.mockResolvedValue([{ costUSD: 3 }]); // $3 < $10

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
  });

  it("a telemetry read FAILURE never throws into the cascade — the run still spawns (fail-open)", async () => {
    const config = cfg([{ id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "qa-automatizado", storyType: "user" })]);
    vi.mocked(loadRunnerConfig).mockReturnValue({
      ...settings(true),
      autorun: { ...settings(true).autorun, cardBudgetUSD: 10 },
    });
    mockListByCard.mockRejectedValue(new Error("ledger corrupt"));

    await expect(evaluateAutorunOnEntry("b", "c")).resolves.toBeUndefined();
    expect(mockRunSkill).toHaveBeenCalledTimes(1); // fail-open: a broken ledger must not block autorun
  });
});

describe("nextNoProgressCount — the pure loop-guard counter", () => {
  it("is 0 for a first run in a column (no prior entry)", () => {
    expect(nextNoProgressCount(undefined, "qa-automatizado", "harness-qa")).toBe(0);
  });

  it("increments when the prior run was the SAME status + trigger (no column advance = no progress)", () => {
    expect(
      nextNoProgressCount({ column: "qa-automatizado", noProgressRuns: 2, trigger: "harness-qa" }, "qa-automatizado", "harness-qa"),
    ).toBe(3);
  });

  it("treats a missing prior noProgressRuns as 0 (→ 1)", () => {
    expect(nextNoProgressCount({ column: "qa-automatizado", trigger: "harness-qa" }, "qa-automatizado", "harness-qa")).toBe(1);
  });

  it("RESETS to 0 when the card advanced to a DIFFERENT status (progress)", () => {
    expect(
      nextNoProgressCount({ column: "revisar-codigo", noProgressRuns: 5, trigger: "harness-qa" }, "qa-automatizado", "harness-qa"),
    ).toBe(0);
  });

  it("RESETS to 0 when a DIFFERENT trigger would run (a new kind of work / a manual run stamped no column)", () => {
    expect(
      nextNoProgressCount({ column: "qa-automatizado", noProgressRuns: 5, trigger: "harness-review" }, "qa-automatizado", "harness-qa"),
    ).toBe(0);
  });

  it(">= the cap is the STOP boundary the shell enforces", () => {
    const n = nextNoProgressCount({ column: "qa-automatizado", noProgressRuns: 2, trigger: "harness-qa" }, "qa-automatizado", "harness-qa");
    expect(n).toBe(3);
    expect(n >= 3).toBe(true); // cap = 3 → STOP
  });
});

// ── Integration dedup proof (acceptance #4) ───────────────────────────────────────────
// Two triggers for the SAME entry (the in-process moveCardAction fire + the watcher's later
// card.moved echo) must yield ONE run. The helper always passes dedupeWindowMs:
// AUTORUN_DEDUPE_MS (asserted above); here we drive a REAL RunnerEngine with that exact
// window to prove the second fire is rejected and the skill spawns exactly once.
describe("autorun dedup — duplicate fire of the same entry collapses to one run", () => {
  // A fake child process that never closes on its own (the run stays in-flight).
  function makeFakeChild() {
    const ee = new EventEmitter() as EventEmitter & { pid?: number; stdout: EventEmitter; stderr: EventEmitter };
    ee.pid = 4321;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    return ee;
  }
  const noopWorktreeOps: WorktreeOps = {
    create: async (repoRoot, sessionId) => ({ worktreePath: `${repoRoot}/.wt/${sessionId}`, branch: `run/${sessionId}` }),
    commit: async () => ({ committed: true }),
    commitBoardState: async () => ({ committed: false }),
    commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
    remove: async () => {},
    detach: async () => {},
    hasUnmergedWork: async () => true,
    disposeBranch: async () => {},
  };
  const journal: RunnerJournalPort = { recordStart: () => {}, recordFinish: () => {}, markResumable: () => {} };
  const NEVER_OVERLOADED: () => VpsResources = () => ({ freeRamMb: Infinity, loadAvg1: 0 });
  const def: StatusDef = { id: "desenvolver", name: "Dev" };

  it("a REAL engine spawns once when runSkill fires twice for the same (board, card, trigger) within the window", async () => {
    const cmds: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      cmds.push(cmd);
      return makeFakeChild();
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = new RunnerEngine(
      fakeSpawn,
      journal,
      async () => null,
      noopWorktreeOps,
      null,
      undefined,
      NEVER_OVERLOADED,
    );

    // Fire 1 (e.g. moveCardAction in-process): admitted, takes the in-flight lock.
    expect(engine.runSkill("acme", "a", "harness-do", def, { dedupeWindowMs: AUTORUN_DEDUPE_MS }).ok).toBe(true);
    // Fire 2 (the watcher's echo of the same move): rejected — the dedupe window's
    // anti-replay stamp catches it (and the in-flight lock backs it up either way).
    const second = engine.runSkill("acme", "a", "harness-do", def, { dedupeWindowMs: AUTORUN_DEDUPE_MS });
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toMatch(/cooldown|in-flight/);
    // The admitted run reaches spawn only after its async enqueue reads resolve — worktree create PLUS
    // the card/board/telemetry reads (the G5 hand-off telemetry read among them). In prod the real
    // worktree git create masks those; the noop worktree here reveals the extra tick, so POLL for the
    // spawn instead of assuming a single macrotask. The 2nd fire was already rejected SYNCHRONOUSLY
    // (asserted above), so this can never observe a phantom 2nd spawn.
    for (let i = 0; i < 50 && cmds.length === 0; i++) await flush();
    expect(cmds).toHaveLength(1); // exactly ONE skill spawned despite two triggers
  });
});

describe("threadResumeSessionId — session threading policy (one agent, many hats)", () => {
  // Minimal board: a Discovery column that THREADS (Especificar→Entrevista both autorun,
  // sonnet) + a non-threading todo column. Only config.columns + config.statuses are read.
  const cfg = (): BoardConfig =>
    ({
      statuses: [
        { id: "enriquecer", trigger: "harness-enrich", column: "discovery", model: "sonnet", autorun: true },
        { id: "interview", trigger: "harness-interview", column: "discovery", model: "sonnet", autorun: true },
        { id: "pronta", column: "todo", autorun: false },
      ],
      columns: [
        { id: "discovery", name: "Discovery", color: "#fff", threadSession: true },
        { id: "todo", name: "A fazer", color: "#fff" },
      ],
    }) as unknown as BoardConfig;

  const next = (c: BoardConfig, id: string) => c.statuses.find((s) => s.id === id)!;

  beforeEach(() => {
    // Seed the card's most-recent session (the just-finished Especificar run).
    getRunnerRegistry().start("b", "c", "harness-enrich", 1, "sess-1");
  });

  it("resumes the prior session on a same-column threaded continuation", () => {
    const c = cfg();
    expect(threadResumeSessionId("b", "c", c, next(c, "interview"), "harness-interview", "harness-enrich")).toBe("sess-1");
  });

  it("starts fresh (undefined) without a suppressTrigger — fs-watcher / first entry, not a completion", () => {
    const c = cfg();
    expect(threadResumeSessionId("b", "c", c, next(c, "interview"), "harness-interview", undefined)).toBeUndefined();
  });

  it("starts fresh when the column does not opt into threadSession", () => {
    const c = cfg();
    c.columns!.find((x) => x.id === "discovery")!.threadSession = false;
    expect(threadResumeSessionId("b", "c", c, next(c, "interview"), "harness-interview", "harness-enrich")).toBeUndefined();
  });

  it("never threads across a column boundary (discovery → todo)", () => {
    const c = cfg();
    expect(threadResumeSessionId("b", "c", c, next(c, "pronta"), "harness-plan", "harness-enrich")).toBeUndefined();
  });

  it("never threads across a model switch within the column", () => {
    const c = cfg();
    next(c, "interview").model = "opus"; // prior=sonnet, next=opus → would void the cache
    expect(threadResumeSessionId("b", "c", c, next(c, "interview"), "harness-interview", "harness-enrich")).toBeUndefined();
  });

  it("WS-8.3 — never re-seeds a session the operator CANCELLED (fresh session when the cascade resumes)", () => {
    const c = cfg();
    // lastRunCancelled=true (the just-finished run ended `cancelled`) → undefined even though every other
    // threading condition holds. A cancel means the human does NOT want that context continuing.
    expect(threadResumeSessionId("b", "c", c, next(c, "interview"), "harness-interview", "harness-enrich", true)).toBeUndefined();
    // …and the legacy default (no cancel) still threads.
    expect(threadResumeSessionId("b", "c", c, next(c, "interview"), "harness-interview", "harness-enrich", false)).toBe("sess-1");
  });

  // v0.9 — "the last run was cancelled" reads the latest COLUMN run, never the latest ledger record: a proxy answer
  // (ultra) booked after the cancel is not a run and must not re-open the thread the operator cancelled.
  it("WS-8.3 × v0.9 — a PROXY record after the cancelled run does not hide the cancel (kernel end to end)", async () => {
    const c = { ...cfg(), id: "b", name: "B", releases: [], personas: [], systems: [], linkTypes: [] } as BoardConfig;
    vi.mocked(readBoardConfig).mockResolvedValue(c);
    vi.mocked(readCards).mockResolvedValue([card({ status: "interview", storyType: "user" })]);
    const rows = (over: Array<Record<string, unknown>>) => over.map((o, i) => ({ id: `r${i}`, costUSD: 0, ...o }));
    // most-recent first, like the store: the proxy answer (ok) is NEWER than the cancelled column run
    mockListByCard.mockResolvedValue(rows([
      { status: "ok", role: "proxy", startedAt: 200 },
      { status: "cancelled", startedAt: 100 },
    ]));
    await evaluateAutorunOnEntry("b", "c", { suppressTrigger: "harness-enrich" });
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockRunSkill.mock.calls[0][4]).not.toHaveProperty("resumeSessionId");

    // the pair: the SAME kernel with no cancel among the runs threads as before
    mockRunSkill.mockClear();
    mockListByCard.mockResolvedValue(rows([{ status: "ok", role: "proxy", startedAt: 200 }, { status: "ok", startedAt: 100 }]));
    await evaluateAutorunOnEntry("b", "c", { suppressTrigger: "harness-enrich" });
    expect(mockRunSkill.mock.calls[0][4]).toMatchObject({ resumeSessionId: "sess-1" });
  });
});

// conductor-core — the kernel is where the conductor is dispatched AND where a conducted card is left alone.
describe("evaluateAutorunOnEntry — o condutor", () => {
  const driven = { skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" };
  const withConductor = (statuses: StatusDef[]): BoardConfig => ({ ...cfg(statuses), conductor: { enabled: true, fromStatus: "pronta" } });

  it("card CONDUZIDO numa coluna armada: nenhum run, nenhuma escrita (nem finding de loop-guard), nenhum log no card", async () => {
    const config = cfg([{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", routing: driven })]);
    // o loop-guard estaria no teto se a cascata chegasse lá — e mesmo assim nada pode ser escrito
    mockLastRun.mockResolvedValue({ column: "desenvolver", trigger: "harness-do", noProgressRuns: 99 });
    const appendLog = vi.spyOn(getRunnerRegistry(), "appendLog");
    try {
      await evaluateAutorunOnEntry("b", "c");
      expect(mockRunSkill).not.toHaveBeenCalled();
      expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
      expect(appendLog).not.toHaveBeenCalled();
      expect(mockDispatchConductor).not.toHaveBeenCalled();
    } finally {
      appendLog.mockRestore();
    }
  });

  it("story ENTRANDO em fromStatus num board com conductor: despacha o condutor e NÃO roda a cascata", async () => {
    const config = withConductor([
      { id: "pronta", name: "Pronta", trigger: "harness-plan", autorun: true }, // armada de propósito
    ]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "pronta" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockDispatchConductor).toHaveBeenCalledWith("b", "c");
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  it("um card JÁ conduzido que re-entra/recebe re-avaliação em fromStatus NÃO re-despacha (condutor morto não renasce sozinho)", async () => {
    const config = withConductor([{ id: "pronta", name: "Pronta", autorun: false }]);
    vi.mocked(readBoardConfig).mockResolvedValue(config);
    vi.mocked(readCards).mockResolvedValue([card({ status: "pronta", routing: driven })]);
    await evaluateAutorunOnEntry("b", "c", { suppressTrigger: "harness-do" });
    await evaluateAutorunOnEntry("b", "c");
    expect(mockDispatchConductor).not.toHaveBeenCalled();
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  it("master switch OFF: nem condutor nem cascata", async () => {
    vi.mocked(loadRunnerConfig).mockReturnValue(settings(false));
    vi.mocked(readBoardConfig).mockResolvedValue(withConductor([{ id: "pronta", name: "Pronta", autorun: false }]));
    vi.mocked(readCards).mockResolvedValue([card({ status: "pronta" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockDispatchConductor).not.toHaveBeenCalled();
  });

  it("board sem `conductor`: a mesma entrada segue a cascata de sempre", async () => {
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id: "pronta", name: "Pronta", trigger: "harness-plan", autorun: true }]));
    vi.mocked(readCards).mockResolvedValue([card({ status: "pronta" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockDispatchConductor).not.toHaveBeenCalled();
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
  });
});

// O DISJUNTOR DA PUBLICAÇÃO no kernel real. O laço: release (autorun) → forward → deploy → exit 3 → revert →
// release → forward… por horas. O kernel lê o registro ANTES da decisão pura e, se ele segura, não escreve nada e não
// dispara o efeito de entrada (que é o deploy).
describe("evaluateAutorunOnEntry — o disjuntor da publicação (release automática não martela um deploy que não anda)", () => {
  const release = cfg([
    { id: "release", name: "Liberar", autorun: true },
    { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
  ]);

  /**
   * As leituras do card, na ordem: cada avaliação lê do disco, e depois de um FORWARD o disco já diz o status novo.
   * (Um mock que respondesse `release` para sempre faria a releitura em processo encaminhar sem fim — coisa que o
   * sistema real não faz porque o write muda o status.) A última leitura vale daí em diante.
   */
  const reads = (...statuses: string[]) => {
    const m = vi.mocked(readCards);
    m.mockReset();
    statuses.slice(0, -1).forEach((st) => m.mockResolvedValueOnce([card({ status: st })]));
    m.mockResolvedValue([card({ status: statuses[statuses.length - 1]! })]);
  };

  beforeEach(() => {
    mockRunEntryEffect.mockClear();
    // o registro é um singleton persistido em disco: cada teste começa do zero
    resetPublishBreakerForTest();
    rmSync(path.join(runnerStateDir(), "deploy-attempts.json"), { force: true });
    vi.mocked(readBoardConfig).mockResolvedValue(release);
    // o write travado vê o card em `release` (o anti-clobber do forward compara o status lido com o de sob o lock)
    mockUpdateCardOnDisk.mockImplementation(async (_b, id, mutate) => mutate({ id, status: "release" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    mockUpdateCardOnDisk.mockImplementation(async (_b, id, mutate) => mutate({ id, status: "landing" })); // o default do arquivo
  });

  it("sem falha registrada ⇒ encaminha para Publicar e dispara o efeito de entrada (o comportamento de sempre)", async () => {
    reads("release", "deploy");
    await evaluateAutorunOnEntry("b", "c");
    expect(mockUpdateCardOnDisk).toHaveBeenCalledTimes(1);
    expect(mockRunEntryEffect).toHaveBeenCalledWith("promote-and-deploy", "b", "c");
  });

  it("falha registrada (exit 3) ⇒ NÃO encaminha: nenhum write, nenhum deploy — e avaliar de novo não muda isso", async () => {
    reads("release");
    getPublishBreaker().recordFailureNow("b", "c", { phase: "needs-human", exitCode: 3 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) await evaluateAutorunOnEntry("b", "c");
      expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
      expect(mockRunEntryEffect).not.toHaveBeenCalled();
      // dito UMA vez por janela (não 5): o laço que isto contém avaliava o card a cada poucos segundos
      const said = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("publish-backoff"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("[harness-autorun b/c]");
      // o rótulo de needs-human nomeia a decisão do dono (WP2: sem «só o dono publica»)
      expect(said[0]).toContain("a publicação espera uma decisão do dono");
    } finally {
      log.mockRestore();
    }
  });

  it("o recuo VENCE ⇒ a cascata volta a encaminhar sozinha", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    reads("release", "release", "deploy");
    getPublishBreaker().recordFailureNow("b", "c", { phase: "needs-human", exitCode: 3 });
    await evaluateAutorunOnEntry("b", "c");
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000 + 1);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockUpdateCardOnDisk).toHaveBeenCalledTimes(1);
    expect(mockRunEntryEffect).toHaveBeenCalledTimes(1);
  });

  it("ESGOTADO (desistiu) ⇒ nem o tempo o libera: só o clique humano, que não passa por aqui", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    reads("release");
    for (let i = 0; i < 3; i++) getPublishBreaker().recordFailureNow("b", "c", { phase: "needs-human", exitCode: 3 });
    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60_000);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockUpdateCardOnDisk).not.toHaveBeenCalled();
    expect(mockRunEntryEffect).not.toHaveBeenCalled();
  });

  it("o registro é POR CARD: outro card do mesmo board segue normalmente", async () => {
    reads("release", "deploy");
    getPublishBreaker().recordFailureNow("b", "outro", { phase: "needs-human", exitCode: 3 });
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunEntryEffect).toHaveBeenCalledTimes(1);
  });

  it("falha SÍNCRONA ao obter o registro (diretório de estado não resolve) também NÃO trava a cascata — fail-open", async () => {
    reads("release", "deploy");
    resetPublishBreakerForTest(); // o singleton seria reaproveitado; sem ele `getPublishBreaker()` reconstrói e lança
    vi.stubEnv("AGILEHARNESS_RUNNER_STATE_DIR", ""); // sob o vitest, sem o override `runnerStateDir()` lança
    try {
      await evaluateAutorunOnEntry("b", "c");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mockRunEntryEffect).toHaveBeenCalledTimes(1);
  });

  it("o registro ilegível (falha ao consultar) NÃO trava a cascata — fail-open", async () => {
    reads("release", "deploy");
    const breaker = getPublishBreaker();
    vi.spyOn(breaker, "holdReason").mockRejectedValue(new Error("disco"));
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunEntryEffect).toHaveBeenCalledTimes(1);
  });
});

// O ESCOPO DE TIPOS (runner/board-pace.ts, segundo eixo do ritmo): a entrada de coluna é o ponto único por onde passa o
// despacho do condutor e a cascata de colunas — aqui se prova a pergunta por card e a fronteira da construção.
describe("evaluateAutorunOnEntry — o escopo de tipos do board (só consertos e manutenção)", () => {
  const FIXES = ["bug", "technical", "chore", "spike"];
  const scopeRow = (types: string[] = FIXES) => ({ board: "b", ownerScope: { types, by: { kind: "owner" }, at: new Date().toISOString() } });
  const build = [{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true } as StatusDef];
  const driven = { skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" };
  const withConductor = (statuses: StatusDef[], fromStatus: string | string[]): BoardConfig => ({ ...cfg(statuses), conductor: { enabled: true, fromStatus } });

  it("funcionalidade nova (user) na COLUNA DE CONSTRUÇÃO: nenhuma skill, o disparo fica anotado para o escopo alargar devolver", async () => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "user" })]);

    await evaluateAutorunOnEntry("b", "c");

    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockHoldBoardScopeEntry).toHaveBeenCalledWith("b", "c");
    expect(mockHoldBoardEntry).not.toHaveBeenCalled(); // a anotação do ESCOPO, não a da pausa
  });

  it("card sem storyType vale `user` (o padrão de quem ainda não foi classificado): barrado na construção", async () => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  it.each(["bug", "technical", "chore", "spike"])("%s na construção: segue normalmente, sem anotação", async (storyType) => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
  });

  it("um `user` em modo `fix` conta como erro: segue na construção", async () => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "user", mode: "fix" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
  });

  it("o card que a cascata dispara vai no run (scopeCard) — é o que o pump do engine consulta", async () => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "chore" })]);
    await evaluateAutorunOnEntry("b", "c");
    const opts = mockRunSkill.mock.calls[0][4] as { scopeCard?: unknown };
    expect(opts.scopeCard).toEqual({ id: "c", type: "story", storyType: "chore", mode: undefined, status: "desenvolver" });
  });

  it.each(["capturando", "triage", "grill", "enriquecer", "interview", "pronta"])(
    "FORA da construção (%s): a funcionalidade nova continua andando para o tipo ser decidido",
    async (id) => {
      mockPaceRow.value = scopeRow();
      vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id, name: id, trigger: "harness-enrich", autorun: true } as StatusDef]));
      vi.mocked(readCards).mockResolvedValue([card({ status: id, storyType: "user" })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockRunSkill).toHaveBeenCalledTimes(1);
      expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
    },
  );

  it.each(["plano-tecnico", "quebrar-tasks", "desenvolver"])(
    "o COMEÇO da construção (%s) é barrado para a funcionalidade nova",
    async (id) => {
      mockPaceRow.value = scopeRow();
      vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id, name: id, trigger: "harness-do", autorun: true } as StatusDef]));
      vi.mocked(readCards).mockResolvedValue([card({ status: id, storyType: "user" })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockRunSkill).not.toHaveBeenCalled();
      expect(mockHoldBoardScopeEntry).toHaveBeenCalledWith("b", "c");
    },
  );

  // C4 («deixa terminar», decisão do dono): uma funcionalidade cujo desenvolver terminou depois de o escopo estreitar chega à revisão
  // de código e à QA — que fecham o que já foi escrito. Barrá-las a deixava PARADA e anotada, com código escrito e sem revisão.
  it.each(["revisar-codigo", "qa-automatizado"])("o FECHAMENTO da construção (%s) NÃO é barrado: o que já começou termina até a entrega", async (id) => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id, name: id, trigger: "harness-review", autorun: true } as StatusDef]));
    vi.mocked(readCards).mockResolvedValue([card({ status: id, storyType: "user" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
  });

  it("a ENTREGA não é barrada (R8): revisão da funcionalidade já construída segue", async () => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg([{ id: "revisao", name: "Revisão", trigger: "harness-review", autorun: true } as StatusDef]));
    vi.mocked(readCards).mockResolvedValue([card({ status: "revisao", storyType: "user" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
  });

  it("só STORY entra na regra: uma ideia (ou atividade) na coluna de construção segue como sempre", async () => {
    mockPaceRow.value = scopeRow();
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ type: "idea", status: "desenvolver" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
  });

  it("a interseção das camadas vale na entrada: o dono admite tudo e o agente só consertos ⇒ user barrado", async () => {
    mockPaceRow.value = { board: "b", agentScope: { types: FIXES, by: { kind: "agent" }, at: new Date().toISOString() } };
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "user" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  it("escopo com PRAZO vencido não segura nada (o portão já o trata como saído)", async () => {
    mockPaceRow.value = { board: "b", ownerScope: { types: FIXES, by: { kind: "owner" }, at: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" } };
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "user" })]);
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
  });

  it("ritmo e escopo são eixos independentes: PAUSADO ganha (anota a PAUSA, não o escopo) e DEVAGAR + escopo ainda barra o tipo", async () => {
    vi.mocked(readBoardConfig).mockResolvedValue(cfg(build));
    vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "user" })]);

    mockPaceRow.value = { ...scopeRow(), owner: { level: "paused", by: { kind: "owner" }, at: new Date().toISOString() } };
    await evaluateAutorunOnEntry("b", "c");
    expect(mockHoldBoardEntry).toHaveBeenCalledWith("b", "c", "entry");
    expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();

    mockHoldBoardEntry.mockClear();
    mockPaceRow.value = { ...scopeRow(), owner: { level: "slow", by: { kind: "owner" }, at: new Date().toISOString() } };
    await evaluateAutorunOnEntry("b", "c");
    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(mockHoldBoardScopeEntry).toHaveBeenCalledWith("b", "c");
  });

  describe("o despacho do condutor", () => {
    it("funcionalidade nova entrando em fromStatus: NÃO despacha o condutor e fica anotada (espera o escopo alargar)", async () => {
      mockPaceRow.value = scopeRow();
      vi.mocked(readBoardConfig).mockResolvedValue(withConductor([{ id: "pronta", name: "Pronta", trigger: "harness-plan", autorun: true }], "pronta"));
      vi.mocked(readCards).mockResolvedValue([card({ status: "pronta", storyType: "user" })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockDispatchConductor).not.toHaveBeenCalled();
      expect(mockRunSkill).not.toHaveBeenCalled();
      expect(mockHoldBoardScopeEntry).toHaveBeenCalledWith("b", "c");
    });

    it("conserto entrando em fromStatus: o condutor é despachado normalmente", async () => {
      mockPaceRow.value = scopeRow();
      vi.mocked(readBoardConfig).mockResolvedValue(withConductor([{ id: "pronta", name: "Pronta", trigger: "harness-plan", autorun: true }], "pronta"));
      vi.mocked(readCards).mockResolvedValue([card({ status: "pronta", storyType: "bug" })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockDispatchConductor).toHaveBeenCalledWith("b", "c");
      expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
    });

    it("fromStatus que é coluna de CLASSIFICAÇÃO (enriquecer): o condutor espera, mas a skill da coluna roda para o tipo ser decidido", async () => {
      mockPaceRow.value = scopeRow();
      vi.mocked(readBoardConfig).mockResolvedValue(withConductor([{ id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true }], "enriquecer"));
      vi.mocked(readCards).mockResolvedValue([card({ status: "enriquecer", storyType: "user" })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockDispatchConductor).not.toHaveBeenCalled();
      expect(mockRunSkill).toHaveBeenCalledTimes(1);
      expect(mockRunSkill.mock.calls[0][2]).toBe("harness-enrich");
      expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
    });

    it("card JÁ conduzido (começou antes de o escopo estreitar) não é barrado nem anotado: o que executa termina", async () => {
      mockPaceRow.value = scopeRow();
      vi.mocked(readBoardConfig).mockResolvedValue(withConductor(build, "pronta"));
      vi.mocked(readCards).mockResolvedValue([card({ status: "desenvolver", storyType: "user", routing: driven })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockHoldBoardScopeEntry).not.toHaveBeenCalled();
      expect(mockRunSkill).not.toHaveBeenCalled(); // a cascata segue calada para quem tem condutor
      expect(mockDispatchConductor).not.toHaveBeenCalled();
    });

    it("escopo alargado de volta (sem limite): a mesma funcionalidade nova é despachada", async () => {
      mockPaceRow.value = null;
      vi.mocked(readBoardConfig).mockResolvedValue(withConductor([{ id: "pronta", name: "Pronta", trigger: "harness-plan", autorun: true }], "pronta"));
      vi.mocked(readCards).mockResolvedValue([card({ status: "pronta", storyType: "user" })]);
      await evaluateAutorunOnEntry("b", "c");
      expect(mockDispatchConductor).toHaveBeenCalledWith("b", "c");
    });
  });
});
