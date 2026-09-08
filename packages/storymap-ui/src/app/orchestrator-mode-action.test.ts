import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BoardConfig } from "@/lib/storymap/types";

// Fase 5.1/5.9 — setBoardOrchestratorModeAction. Since F5.9 flipped riskMatrixEnforced=true (the per-call guard
// + move_card dynamic gate + approvals enforce the riskMatrix), autonomousModeSafe()===true and mode='autonomous'
// is now ACCEPTED and persisted — turning ON the capability, not any board (opt-in stays per-board). paired/off
// persist via the same board-config write path.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let cfgOnDisk: BoardConfig;
const writes: BoardConfig[] = [];

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readBoardConfig: async () => cfgOnDisk };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return { ...actual, writeBoardConfig: async (_id: string, cfg: BoardConfig) => { writes.push(cfg); cfgOnDisk = cfg; } };
});

import { setBoardOrchestratorModeAction } from "./actions";

const baseCfg: BoardConfig = {
  id: "b", name: "B", statuses: [], releases: [], personas: [], systems: [], linkTypes: [],
};

describe("setBoardOrchestratorModeAction (5.1)", () => {
  beforeEach(() => {
    cfgOnDisk = { ...baseCfg };
    writes.length = 0;
  });

  it("ACCEPTS autonomous now that F5.9 enforcement shipped, persisting the mode (capability ON, opt-in per board)", async () => {
    const res = await setBoardOrchestratorModeAction({ boardId: "b", mode: "autonomous" });
    expect(res.ok).toBe(true);
    expect(writes.at(-1)?.orchestrator?.mode).toBe("autonomous");
  });

  it("accepts 'paired' and persists orchestrator.mode via the board-config write path", async () => {
    const res = await setBoardOrchestratorModeAction({ boardId: "b", mode: "paired" });
    expect(res.ok).toBe(true);
    expect(writes.at(-1)?.orchestrator?.mode).toBe("paired");
  });

  it("accepts 'off' and preserves any existing riskMatrix on the policy", async () => {
    cfgOnDisk = { ...baseCfg, orchestrator: { mode: "paired", riskMatrix: { "write-board": "auto" } } };
    const res = await setBoardOrchestratorModeAction({ boardId: "b", mode: "off" });
    expect(res.ok).toBe(true);
    expect(writes.at(-1)?.orchestrator?.mode).toBe("off");
    expect(writes.at(-1)?.orchestrator?.riskMatrix).toEqual({ "write-board": "auto" }); // spread preserves the rest
  });
});
