import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// `touches_per_story`: a medida (toques humanos por história, negócio × técnico) como tool MCP
// SÓ DE LEITURA, com board e período opcional.

const readTransitions = vi.fn();
vi.mock("@/lib/storymap/runner/transitions", async (orig) => ({
  ...(await orig<typeof import("../runner/transitions")>()),
  readTransitions: (...a: unknown[]) => readTransitions(...a),
}));
const readCards = vi.fn();
const readBoardConfig = vi.fn();
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  readCards: (...a: unknown[]) => readCards(...a),
  readBoardConfig: (...a: unknown[]) => readBoardConfig(...a),
}));

import { registerStorymapTools } from "./tools";
import { riskClassForTool } from "./register";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _m: unknown, h: ToolHandler) => out.set(name, h) } as unknown as McpServer);
  return out;
}

describe("touches_per_story", () => {
  it("é leitura; lê o ledger DO board e devolve a medida por história", async () => {
    expect(riskClassForTool("touches_per_story")).toBe("read");
    readTransitions.mockResolvedValue([
      { v: 1, at: "2026-04-14T09:12:05.331Z", board: "armazem", cardId: "story-a", from: "triage", to: "enriquecer", actor: "human", note: "aceito na triagem" },
    ]);
    readCards.mockResolvedValue([{ id: "story-a", type: "story", storyType: "technical", title: "A", questions: [] }]);
    readBoardConfig.mockResolvedValue({ id: "armazem", statuses: [{ id: "triage", name: "Triagem", staging: true }, { id: "enriquecer", name: "Especificar" }] });
    const out = await handlers().get("touches_per_story")!({ board: "armazem", since: "2026-04-01T00:00:00Z" });
    expect(readTransitions).toHaveBeenCalledWith({ board: "armazem" });
    const body = JSON.parse((out.content[0] as { text: string }).text) as { stories: Array<{ cardId: string; human: { hops: number } }> };
    expect(body.stories).toEqual([expect.objectContaining({ cardId: "story-a", human: expect.objectContaining({ hops: 1 }) })]);
  });
});
