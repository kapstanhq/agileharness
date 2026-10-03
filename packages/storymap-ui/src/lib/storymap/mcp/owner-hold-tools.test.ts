import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// A decisão do dono ESPERA: quem move por `move_card` é um AGENTE, e num card em
// só-negócio ele não o leva rumo ao ar com uma decisão do dono aberta. Voltar e mover outro card seguem livres.

const moveCardAction = vi.fn();
vi.mock("@/app/actions", () => ({ moveCardAction: (...a: unknown[]) => moveCardAction(...a) }));
const state: { card: Card | null; config: BoardConfig | null } = { card: null, config: null };
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  readCard: async () => state.card,
  readBoardConfig: async () => state.config,
}));

import { coerceCard } from "../repo";
import { registerStorymapTools } from "./tools";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function moveCard(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _m: unknown, h: ToolHandler) => handlers.set(name, h) } as unknown as McpServer);
  return handlers.get("move_card")!;
}

const config = {
  id: "b",
  name: "B",
  autonomy: { mode: "ultra" },
  statuses: [
    { id: "construir", name: "Construir" },
    { id: "aprovar", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
    { id: "integrar", name: "Integrar", autorun: true },
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy", autoEnterTerminal: true },
    { id: "concluida", name: "No ar", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as unknown as BoardConfig;

beforeEach(() => {
  moveCardAction.mockReset().mockResolvedValue({ ok: true });
  state.config = config;
  state.card = coerceCard("story-x", {
    type: "story",
    storyType: "technical",
    title: "Aviso de novidade",
    status: "aprovar",
    questions: [{ id: "q1", text: "Mandamos push para todos os usuários?", status: "open", category: "owner", ownerClass: "brand-voice" }],
  }, "");
});

describe("move_card — a decisão do dono espera", () => {
  it("rumo ao ar com a pergunta do dono aberta: recusa, e nada se move", async () => {
    const out = await moveCard()({ board: "b", cardId: "story-x", status: "integrar" });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toMatch(/espera o dono/);
    expect(moveCardAction).not.toHaveBeenCalled();
  });

  it("voltar, ou a pergunta já respondida: move", async () => {
    expect((await moveCard()({ board: "b", cardId: "story-x", status: "construir" })).isError).toBeFalsy();
    state.card = { ...state.card!, questions: [{ ...state.card!.questions![0], status: "answered", answer: "não" }] };
    expect((await moveCard()({ board: "b", cardId: "story-x", status: "integrar" })).isError).toBeFalsy();
    expect(moveCardAction).toHaveBeenCalledTimes(2);
  });
});
