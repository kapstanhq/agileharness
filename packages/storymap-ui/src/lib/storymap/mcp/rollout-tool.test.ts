import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// `rollout_readiness`: a regra de expansão do só-negócio como tool MCP SÓ DE
// LEITURA — "pronto para estender: sim/não, N/10". Não liga board nenhum.

const readTransitions = vi.fn();
vi.mock("@/lib/storymap/runner/transitions", async (orig) => ({
  ...(await orig<typeof import("../runner/transitions")>()),
  readTransitions: (...a: unknown[]) => readTransitions(...a),
}));
const readSystemDecisions = vi.fn();
vi.mock("@/lib/storymap/runner/decision-log", async (orig) => ({
  ...(await orig<typeof import("../runner/decision-log")>()),
  readSystemDecisions: (...a: unknown[]) => readSystemDecisions(...a),
}));
const listBoards = vi.fn();
const getBoard = vi.fn();
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  listBoards: (...a: unknown[]) => listBoards(...a),
  getBoard: (...a: unknown[]) => getBoard(...a),
}));

import { registerStorymapTools } from "./tools";
import { riskClassForTool } from "./register";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _m: unknown, h: ToolHandler) => out.set(name, h) } as unknown as McpServer);
  return out;
}

describe("rollout_readiness", () => {
  it("é leitura; responde a linha para o dono a partir dos boards em só-negócio", async () => {
    expect(riskClassForTool("rollout_readiness")).toBe("read");
    listBoards.mockResolvedValue([
      { id: "piloto", name: "Piloto" },
      { id: "outro", name: "Outro" },
    ]);
    const statuses = [
      { id: "merge", name: "Integrar" },
      { id: "concluida", name: "No ar", terminal: true, delivered: true },
    ];
    getBoard.mockImplementation(async (id: string) => ({
      config: { id, name: id, statuses, ...(id === "piloto" ? { autonomy: { mode: "ultra" } } : {}) },
      cards: [{ id: "story-a", type: "story", storyType: "technical", title: "A", questions: [] }],
    }));
    readTransitions.mockResolvedValue([{ v: 1, at: "2026-09-29T12:00:00Z", board: "piloto", cardId: "story-a", from: "merge", to: "concluida", actor: "system" }]);
    readSystemDecisions.mockResolvedValue([{ v: 1, id: "d1", at: "2026-09-28T10:00:00Z", board: "piloto", agent: "proxy", kind: "proxy-answer", what: "x", why: "y" }]);
    const out = await handlers().get("rollout_readiness")!({});
    const body = JSON.parse((out.content[0] as { text: string }).text) as { ready: boolean; line: string; pilots: Array<{ board: string; clean: string[] }> };
    expect(body.line).toBe("Pronto para estender a outros boards: não — 1/10 histórias no ar sem toque técnico seu");
    expect(body.pilots).toEqual([expect.objectContaining({ board: "piloto", clean: ["story-a"], since: "2026-09-28T10:00:00Z" })]);
  });
});
