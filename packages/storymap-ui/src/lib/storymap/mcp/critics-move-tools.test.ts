// A RÉGUA DOS CRÍTICOS E DA CAIXA DE CORREIO no nível da TOOL (fase 6): o `move_card` de um agente passa pelo crítico do
// plano/verificador e pela recusa de desfazer o dono; o dono (token do operador, sem rótulo de agente) não passa por
// nenhuma; o chat (token do operador COM rótulo de agente) passa pelos críticos. E um agente não tira o driver de um card
// antes do «vai» do plano. As réguas em si são falsas aqui (critics-deps.test.ts e card-intents.test.ts as provam).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const moveCardAction = vi.fn();
const setCardDriverAction = vi.fn();
const criticMoveHold = vi.fn();
const driverClearHold = vi.fn();
const ownerMoveRevertHold = vi.fn();
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));
vi.mock("@/app/actions", () => ({
  moveCardAction: (...a: unknown[]) => moveCardAction(...a),
  setCardDriverAction: (...a: unknown[]) => setCardDriverAction(...a),
}));
vi.mock("@/lib/storymap/runner/critics-deps", () => ({
  criticMoveHold: (...a: unknown[]) => criticMoveHold(...a),
  driverClearHold: (...a: unknown[]) => driverClearHold(...a),
}));
vi.mock("@/lib/storymap/runner/card-intents-deps", () => ({ ownerMoveRevertHold: (...a: unknown[]) => ownerMoveRevertHold(...a) }));
const state: { card: Card | null; config: BoardConfig | null } = { card: null, config: null };
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  readCard: async () => state.card,
  readBoardConfig: async () => state.config,
}));

import { coerceCard } from "../repo";
import { runWithMcpActor, type McpActor } from "./actor";
import { registerStorymapTools } from "./tools";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function tool(name: string): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (n: string, _m: unknown, h: ToolHandler) => handlers.set(n, h) } as unknown as McpServer);
  return handlers.get(name)!;
}

const SCOPED: McpActor = { level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", caller: { kind: "session", id: "s-ex1" } };
const OWNER: McpActor = { level: "full", tokenEnv: "AGILEHARNESS_MCP_TOKEN" };
const CHAT: McpActor = { level: "full", tokenEnv: "AGILEHARNESS_MCP_TOKEN", caller: { kind: "copilot-chat", id: "b" } };

beforeEach(() => {
  for (const f of [moveCardAction, setCardDriverAction]) f.mockReset().mockResolvedValue({ ok: true, data: { card: { routing: null }, changed: true } });
  criticMoveHold.mockReset().mockResolvedValue("o crítico do plano ainda não aprovou este plano");
  driverClearHold.mockReset().mockResolvedValue("o plano deste card ainda não foi aprovado");
  ownerMoveRevertHold.mockReset().mockResolvedValue(null);
  state.config = {
    id: "b",
    name: "B",
    statuses: [
      { id: "moldando", name: "Moldando" },
      { id: "construir", name: "Construir", trigger: "harness-do" },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  } as unknown as BoardConfig;
  state.card = coerceCard("story-ex9801", { type: "story", storyType: "user", title: "Busca por autor", status: "moldando" }, "");
});

describe("move_card — os críticos e a caixa de correio na tool", () => {
  it("agente escopado indo construir sem o plano aprovado: RECUSA e nada se move", async () => {
    const out = await runWithMcpActor(SCOPED, () => tool("move_card")({ board: "b", cardId: "story-ex9801", status: "construir" }));
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toMatch(/crítico do plano/);
    expect(moveCardAction).not.toHaveBeenCalled();
  });

  it("agente escopado desfazendo o último movimento do dono: RECUSA", async () => {
    criticMoveHold.mockResolvedValue(null);
    ownerMoveRevertHold.mockResolvedValue("o dono acabou de mover este card para cá");
    const out = await runWithMcpActor(SCOPED, () => tool("move_card")({ board: "b", cardId: "story-ex9801", status: "construir" }));
    expect(out.isError).toBe(true);
    expect(moveCardAction).not.toHaveBeenCalled();
  });

  it("o DONO (token do operador, sem rótulo de agente) não passa por nenhuma régua: o movimento dele vence", async () => {
    const out = await runWithMcpActor(OWNER, () => tool("move_card")({ board: "b", cardId: "story-ex9801", status: "construir" }));
    expect(out.isError).toBeFalsy();
    expect(criticMoveHold).not.toHaveBeenCalled();
    expect(ownerMoveRevertHold).not.toHaveBeenCalled();
    expect(moveCardAction).toHaveBeenCalledTimes(1);
  });

  it("o CHAT (token do operador COM rótulo de agente) passa pelos críticos", async () => {
    const out = await runWithMcpActor(CHAT, () => tool("move_card")({ board: "b", cardId: "story-ex9801", status: "construir" }));
    expect(out.isError).toBe(true);
    expect(criticMoveHold).toHaveBeenCalledTimes(1);
    expect(moveCardAction).not.toHaveBeenCalled();
  });
});

describe("set_card_driver(null) — a porta dos fundos do crítico do plano fica fechada", () => {
  it("um agente não tira o driver antes do «vai» do plano; o dono tira", async () => {
    const refused = await runWithMcpActor(SCOPED, () => tool("set_card_driver")({ board: "b", cardId: "story-ex9801", driver: null }));
    expect(refused.isError).toBe(true);
    expect(setCardDriverAction).not.toHaveBeenCalled();
    const ok = await runWithMcpActor(OWNER, () => tool("set_card_driver")({ board: "b", cardId: "story-ex9801", driver: null }));
    expect(ok.isError).toBeFalsy();
    expect(driverClearHold).toHaveBeenCalledTimes(1);
    expect(setCardDriverAction).toHaveBeenCalledTimes(1);
  });

  it("pôr o driver (conductor) nunca é retido", async () => {
    await runWithMcpActor(SCOPED, () => tool("set_card_driver")({ board: "b", cardId: "story-ex9801", driver: "conductor" }));
    expect(driverClearHold).not.toHaveBeenCalled();
    expect(setCardDriverAction).toHaveBeenCalledTimes(1);
  });
});
