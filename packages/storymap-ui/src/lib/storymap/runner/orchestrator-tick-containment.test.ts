import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorRunResult, OrchestratorSpawnDeps } from "./orchestrator-spawn";

// A FIAÇÃO da contenção do tick: buildTickDeps().spawn tem de (1) entregar ao spawn a contenção do settings
// (orchestrator.tick) e (2) quando o run morre — inclusive morto pelo relógio ou cortado pelo teto — cobrar o
// custo no orçamento do DIA e contar ao operador por que o ciclo parou. O spawn real é substituído por um
// dublê que só captura as deps; o estado e o diário são capturados sem tocar em disco.
const { mockSpawn, mockReadState, mockWriteState, mockActivity } = vi.hoisted(() => ({
  mockSpawn: vi.fn(async (_b: string, _m: string, _d: unknown) => true),
  mockReadState: vi.fn(async (_b: string) => ({ v: 1, budget: { day: "", ticksToday: 1, costToday: 0, pushesToday: 0 } })),
  mockWriteState: vi.fn(async (_b: string, _s: unknown) => {}),
  mockActivity: vi.fn(async (_b: string, _e: { kind: string; text: string; detail?: string }) => {}),
}));
vi.mock("./orchestrator-spawn", async (orig) => {
  const actual = await orig<typeof import("./orchestrator-spawn")>();
  return { ...actual, spawnOrchestrator: mockSpawn };
});
vi.mock("./orchestrator-state", async (orig) => {
  const actual = await orig<typeof import("./orchestrator-state")>();
  return { ...actual, readOrchestratorState: mockReadState, writeOrchestratorState: mockWriteState };
});
vi.mock("@/lib/storymap/copilot/activity", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/copilot/activity")>();
  return { ...actual, appendCopilotActivity: mockActivity };
});

import { buildTickDeps, tickStopText } from "./orchestrator-run";
import { loadRunnerConfig } from "./config";
import { DEFAULT_TICK_LIMITS } from "./run-budget";

describe("buildTickDeps().spawn — a contenção do tick chega ao spawn e o tick parado ainda é cobrado", () => {
  const savedToken = process.env.AGILEHARNESS_MCP_TOKEN_ORCH;
  beforeEach(() => {
    delete process.env.AGILEHARNESS_MCP_TOKEN_ORCH; // sem ator de ledger ⇒ a atribuição anti-noop é identidade
    mockSpawn.mockClear();
    mockWriteState.mockClear();
    mockActivity.mockClear();
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.AGILEHARNESS_MCP_TOKEN_ORCH;
    else process.env.AGILEHARNESS_MCP_TOKEN_ORCH = savedToken;
  });

  async function spawnAndSettle(result: Omit<OrchestratorRunResult, "board">) {
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    await deps.spawn("acme", "autonomous");
    const spawnDeps = mockSpawn.mock.calls[0][2] as OrchestratorSpawnDeps;
    mockWriteState.mockClear(); // descarta a escrita do lease; interessa a do RESULTADO
    spawnDeps.onResult!({ board: "acme", ...result });
    await vi.waitFor(() => expect(mockActivity).toHaveBeenCalled(), { timeout: 2_000 });
    return { spawnDeps };
  }

  it("o spawn recebe orchestrator.tick do settings (turnos, dinheiro, relógio)", async () => {
    const { spawnDeps } = await spawnAndSettle({ costUSD: 0.3, exitCode: 0, durationMs: 1_000, summary: "ok" });
    expect(spawnDeps.tick).toEqual(loadRunnerConfig().orchestrator?.tick);
    expect(spawnDeps.tick).toEqual(DEFAULT_TICK_LIMITS); // o settings.yaml publicado não declara o bloco
  });

  it("um tick morto pelo RELÓGIO é cobrado no dia (custo estimado) e o chat diz que o relógio o encerrou", async () => {
    await spawnAndSettle({
      costUSD: 4,
      costEstimated: true,
      stop: "timeout",
      exitCode: null,
      durationMs: 720_000,
      failure: "tick encerrado pelo relógio (12min)",
    });
    const written = mockWriteState.mock.calls.at(-1)![1] as {
      budget: { costToday: number };
      lastTick?: { stop?: string; costEstimated?: boolean };
    };
    expect(written.budget.costToday).toBeCloseTo(4);
    expect(written.lastTick?.stop).toBe("timeout");
    expect(written.lastTick?.costEstimated).toBe(true);
    const said = mockActivity.mock.calls.at(-1)![1];
    expect(said.kind).toBe("error");
    expect(said.text).toBe(tickStopText("timeout"));
    expect(said.detail).toMatch(/estimado pelo teto/);
  });

  it("um tick CORTADO pelo teto é cobrado pelo custo real e o chat nomeia o teto — não 'falhou (exit 1)'", async () => {
    await spawnAndSettle({ costUSD: 4.1, stop: "budget-cut", exitCode: 1, durationMs: 300_000, failure: "tick cortado pelo teto de custo ($4)" });
    const written = mockWriteState.mock.calls.at(-1)![1] as { budget: { costToday: number }; lastTick?: { stop?: string } };
    expect(written.budget.costToday).toBeCloseTo(4.1);
    expect(written.lastTick?.stop).toBe("budget-cut");
    const said = mockActivity.mock.calls.at(-1)![1];
    expect(said.text).toBe(tickStopText("budget-cut"));
    expect(said.text).not.toMatch(/falhou/);
  });
});
