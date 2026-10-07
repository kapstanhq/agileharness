import { describe, expect, it, vi } from "vitest";

// A FIAÇÃO do tique depois da fase 6: buildTickDeps().spawn entrega o board à SENTINELA (sessão nova, uma por causa) e
// nunca mais retoma a conversa do chat. A contenção da sessão (tetos de turno, dinheiro e relógio; lista branca de
// tools; a trava dura) é da Sentinela e está provada em sentinel.test.ts / sentinel-spawn.test.ts. O estado e o diário
// são substituídos por dublês: nada toca o disco.
const { mockReadState, mockWriteState, mockActivity } = vi.hoisted(() => ({
  mockReadState: vi.fn(async (_b: string) => ({ v: 1, budget: { day: "", ticksToday: 1, costToday: 0, pushesToday: 0 } })),
  mockWriteState: vi.fn(async (_b: string, _s: unknown) => {}),
  mockActivity: vi.fn(async (_b: string, _e: { kind: string; text: string; detail?: string }) => {}),
}));
vi.mock("./orchestrator-state", async (orig) => {
  const actual = await orig<typeof import("./orchestrator-state")>();
  return { ...actual, readOrchestratorState: mockReadState, writeOrchestratorState: mockWriteState };
});
const { mockSentinelSweep } = vi.hoisted(() => ({ mockSentinelSweep: vi.fn(async (_d?: unknown, _b?: string[]) => []) }));
vi.mock("./sentinel-run", () => ({ runSentinelSweep: mockSentinelSweep, sentinelSweepBoards: async () => [] }));
vi.mock("@/lib/storymap/copilot/activity", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/copilot/activity")>();
  return { ...actual, appendCopilotActivity: mockActivity };
});

import * as run from "./orchestrator-run";

describe("FASE 6 — buildTickDeps().spawn entrega o board à Sentinela, nunca retoma o chat", () => {
  it("o spawn do tique chama a varredura da Sentinela daquele board", async () => {
    mockSentinelSweep.mockClear();
    const deps = run.buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.spawn("acme", "autonomous", "um run morreu")).toBe(true);
    expect(mockSentinelSweep).toHaveBeenCalledWith(undefined, ["acme"]);
    // o tique imediato/wake de UM board não carrega a varredura global
    expect(deps.sentinel).toBeUndefined();
    expect(typeof run.buildTickDeps().sentinel).toBe("function");
  });

  it("o caminho antigo (retomar o chat do board num tique) não existe mais — nem exportado, nem por trás", () => {
    expect(run).not.toHaveProperty("legacyChatTickSpawn");
    expect(run).not.toHaveProperty("tickStopText");
  });
});
