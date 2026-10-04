import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// A decisão do dono ESPERA: quem move por `move_card` é um AGENTE, e num card em
// só-negócio ele não o leva rumo ao ar com uma decisão do dono aberta. Voltar e mover outro card seguem livres.

const moveCardAction = vi.fn();
// a matriz de risco não é o assunto aqui (guard.test.ts): a chamada chega ao handler
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));
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

// Um card que entrou na Triagem por uma mudança de board FORÇADA (um agente o mudou para um board mais permissivo)
// só sai dela pelo juiz da triagem daqui ou pelo operador: o move_card de um agente recusa.
describe("move_card — o card da mudança forçada espera o juiz daqui", () => {
  const triageConfig = {
    ...config,
    statuses: [{ id: "triage", name: "Triagem", staging: true }, ...(config.statuses as unknown[])],
  } as unknown as BoardConfig;
  const forced = () =>
    coerceCard("story-y", {
      type: "story",
      storyType: "technical",
      title: "Trocar a corrente",
      status: "triage",
      transfers: [{ from: "estufa", to: "b", at: "2026-05-04T10:00:00Z", by: "agent", forced: true }],
    }, "");

  it("agente tirando o card da Triagem: recusa e nada se move", async () => {
    state.config = triageConfig;
    state.card = forced();
    const { runWithMcpActor } = await import("./actor");
    const out = await runWithMcpActor({ level: "orch" }, () => moveCard()({ board: "b", cardId: "story-y", status: "construir" }) as Promise<CallToolResult>);
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/mudança forçada/);
    expect(moveCardAction).not.toHaveBeenCalled();
  });

  it("o operador (token full) move; depois do juiz julgar, o agente também", async () => {
    state.config = triageConfig;
    state.card = forced();
    const { runWithMcpActor } = await import("./actor");
    const op = await runWithMcpActor({ level: "full" }, () => moveCard()({ board: "b", cardId: "story-y", status: "construir" }) as Promise<CallToolResult>);
    expect(op.isError).toBeFalsy();
    state.card = { ...forced(), triageDecision: { verdict: "accept", reason: "serve o PRD", by: "triage-judge", at: "2026-05-04" } };
    const ag = await runWithMcpActor({ level: "orch" }, () => moveCard()({ board: "b", cardId: "story-y", status: "construir" }) as Promise<CallToolResult>);
    expect(ag.isError).toBeFalsy();
  });
});
