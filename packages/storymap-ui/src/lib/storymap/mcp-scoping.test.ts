import { readFileSync } from "node:fs";

import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./paths";
import { readBoardConfig } from "./repo";
import { providerChain, resolveToolkit } from "./toolkit";
import { subjectBoards } from "./board-fixture";

// story-ju8wh2 — chrome-devtools MCP is scoped PER-COLUMN, never global. A headless `claude -p`
// does NOT auto-load the project .mcp.json, so the only browser-bearing runs are those whose column
// declares `mcpConfig` (→ flags.ts emits `--strict-mcp-config --mcp-config <path>`). Declaring
// chrome-devtools in the ROOT .mcp.json would re-spawn a ~475MB Chrome on EVERY interactive session
// and EVERY non-UI run — exactly the waste this story removed. This guards the invariant from
// silent re-introduction.

const QA_MCP_REL = "storymap/qa-mcp.json";

function readJson(rel: string): { mcpServers?: Record<string, unknown> } {
  const abs = path.join(findRepoRoot(), rel);
  return JSON.parse(readFileSync(abs, "utf8"));
}

describe("MCP scoping — chrome-devtools is per-column, not global (story-ju8wh2)", () => {
  // O caso sobre o `.mcp.json` da raiz saiu com a segunda árvore (issue #1): esse arquivo era config do
  // checkout de origem e nunca existiu aqui. O escopo por coluna é cobrado por capability-contract.test.ts.
  it("the dedicated storymap/qa-mcp.json DOES provide chrome-devtools (for the visual sweep)", () => {
    const qa = readJson(QA_MCP_REL);
    expect(qa.mcpServers).toBeTruthy();
    expect(Object.keys(qa.mcpServers ?? {})).toContain("chrome-devtools");
  });

  it("the qa-automatizado step routes the headless run at qa-mcp.json (so harness-qa keeps its browser)", async () => {
    const board = subjectBoards()[0];
    const cfg = await readBoardConfig(board);
    const qaStep = cfg.statuses.find((s) => s.id === "qa-automatizado");
    expect(qaStep, `qa-automatizado status must exist on the ${board} board`).toBeTruthy();
    // The step now declares the browser through the CAPABILITY contract instead of the legacy
    // `mcpConfig` sugar. Same invariant, stronger: the mount is still per-column (never global), and it
    // is now reachable only via a provider that must PROVE itself. Asserted through resolveToolkit —
    // the seam the engine actually uses — so this cannot pass while the spawn mounts something else.
    const resolved = resolveToolkit(qaStep!, cfg, board, findRepoRoot());
    expect(resolved.mcpConfigPaths).toContain(QA_MCP_REL);
  });

  it("the browser capability is REQUIRED for UI cards and has a probeable provider chain", async () => {
    const board = subjectBoards()[0];
    const cfg = await readBoardConfig(board);
    const qaStep = cfg.statuses.find((s) => s.id === "qa-automatizado");
    const expectation = qaStep?.toolkit?.expect?.find((e) => e.tool === "browser");
    expect(expectation, "qa-automatizado must declare the browser capability").toBeTruthy();
    expect(expectation?.level).toBe("required");
    // Conditional on UI surface — a technical/chore card must never be stopped by a missing browser it
    // was never going to open (that would turn a targeted guard into a pipeline-wide outage).
    expect(expectation?.when).toBe("uiSurface");
    // Every provider in the chain must be PROVABLE — a required capability whose chain has no probe is
    // the "declared capability with zero producers" shape this whole contract exists to make impossible.
    const chain = providerChain("browser", cfg.toolConfigs, board, findRepoRoot());
    expect(chain.length, "browser must resolve a provider chain").toBeGreaterThan(1);
    expect(chain.every((p) => p.probe), `every provider needs a probe: ${chain.map((p) => p.id).join(", ")}`).toBe(true);
    // …and they must be interchangeable: a fallback providing a DIFFERENT capability is not a fallback.
    expect(new Set(chain.map((p) => p.capability))).toEqual(new Set(["browser"]));
  });
});
