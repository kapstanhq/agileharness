// A porta MCP de mudar um card de board: `transfer_card` repassa à MESMA action da tela (que mede quem trabalha no card e
// recusa com o motivo) e devolve o board, o status e os avisos. Montada para quem escreve no board (write/orch), nunca ro.

import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const transferCardAction = vi.fn();
vi.mock("@/app/actions", async (orig) => ({ ...(await orig<typeof import("@/app/actions")>()), transferCardAction: (...a: unknown[]) => transferCardAction(...a) }));
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));

import { registerStorymapTools } from "./tools";
import { riskClassForTool } from "./register";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _m: unknown, h: ToolHandler) => void out.set(name, h) } as unknown as McpServer);
  return out;
}
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("transfer_card", () => {
  it("repassa à action e devolve board, status e avisos", async () => {
    transferCardAction.mockResolvedValueOnce({ ok: true, data: { card: {}, toStatus: "triage", warnings: ["entrou pela Triagem"] } });
    const r = await handlers().get("transfer_card")!({ board: "estufa", cardId: "story-caixa", toBoard: "galpao", reason: "pacote de lá" });
    expect(transferCardAction).toHaveBeenCalledWith({ boardId: "estufa", cardId: "story-caixa", toBoardId: "galpao", anchor: null, reason: "pacote de lá" });
    expect(JSON.parse(text(r))).toEqual({ ok: true, cardId: "story-caixa", board: "galpao", status: "triage", warnings: ["entrou pela Triagem"] });
  });

  it("a recusa da action volta como erro com o motivo", async () => {
    transferCardAction.mockResolvedValueOnce({ ok: false, error: "há uma sessão de trabalho aberta neste card" });
    const r = await handlers().get("transfer_card")!({ board: "estufa", cardId: "story-caixa", toBoard: "galpao" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/sessão de trabalho/);
  });

  it("escrever no board (write-board): montada em write/orch, nunca num token só de leitura", () => {
    expect(riskClassForTool("transfer_card")).toBe("write-board");
  });
});
