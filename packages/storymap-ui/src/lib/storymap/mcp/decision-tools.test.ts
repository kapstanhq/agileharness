import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

// `record_decision`: a porta MCP da DECISÃO REGISTRADA de um dilema. Escreve no board (classe
// write-board: o condutor e o tick a têm), delega à action — que recusa pela régua de quem decide o dilema.

const recordDecisionAction = vi.fn();
vi.mock("@/app/actions", () => ({
  recordDecisionAction: (...a: unknown[]) => recordDecisionAction(...a),
}));
const readSystemDecisions = vi.fn();
vi.mock("@/lib/storymap/runner/decision-log", async (orig) => ({
  ...(await orig<typeof import("../runner/decision-log")>()),
  readSystemDecisions: (...a: unknown[]) => readSystemDecisions(...a),
}));

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerStorymapTools } from "./tools";
import { riskClassForTool } from "./register";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

function capture(): { handlers: Map<string, ToolHandler>; metas: Map<string, { inputSchema: z.ZodRawShape }> } {
  const handlers = new Map<string, ToolHandler>();
  const metas = new Map<string, { inputSchema: z.ZodRawShape }>();
  const server = {
    registerTool: (name: string, meta: { inputSchema: z.ZodRawShape }, handler: ToolHandler) => {
      handlers.set(name, handler);
      metas.set(name, meta);
    },
  } as unknown as McpServer;
  registerStorymapTools(server);
  return { handlers, metas };
}

beforeEach(() => recordDecisionAction.mockReset());

describe("record_decision", () => {
  const args = {
    board: "b",
    cardId: "story-x",
    what: "Adiar a exportação em PDF",
    options: ["Entregar só o CSV", "Atrasar dois dias"],
    choice: "Entregar só o CSV",
    why: "O prazo do piloto com a primeira loja é fixo",
    undo: "Reabrir com o PDF como critério",
    by: "harness-conductor",
  };

  it("é write-board (o condutor e o tick têm) e delega à action", async () => {
    expect(riskClassForTool("record_decision")).toBe("write-board");
    recordDecisionAction.mockResolvedValue({ ok: true, data: { decision: { id: "d1" } } });
    const out = await capture().handlers.get("record_decision")!(args);
    expect(out.isError).toBeFalsy();
    expect(recordDecisionAction).toHaveBeenCalledWith(expect.objectContaining({ boardId: "b", cardId: "story-x", choice: "Entregar só o CSV", by: "harness-conductor" }));
  });

  it("a recusa da action volta como erro (ex.: o dilema toca uma classe do dono)", async () => {
    recordDecisionAction.mockResolvedValue({ ok: false, error: "é decisão do dono (PRD e metas)" });
    const out = await capture().handlers.get("record_decision")!({ ...args, ownerClass: "prd" });
    expect(out.isError).toBe(true);
  });
});

describe("list_system_decisions", () => {
  it("é leitura e devolve a projeção do «Acompanhar» do board", async () => {
    expect(riskClassForTool("list_system_decisions")).toBe("read");
    readSystemDecisions.mockResolvedValue([
      { v: 1, id: "sd-1", at: "2026-09-28T10:00:00Z", board: "b", agent: "proxy", kind: "proxy-answer", what: "Respondeu", why: "PRD", undo: { kind: "reopen-question", cardId: "c", questionId: "q1" } },
    ]);
    const out = await capture().handlers.get("list_system_decisions")!({ board: "b" });
    const body = JSON.parse((out.content[0] as { text: string }).text) as { items: Array<{ id: string; undoable: boolean }> };
    expect(body.items).toEqual([expect.objectContaining({ id: "sd-1", undoable: true })]);
  });
});

describe("record_cost_projection (grill 2, A)", () => {
  it("é write-board e está registrada", () => {
    expect(riskClassForTool("record_cost_projection")).toBe("write-board");
    expect(capture().handlers.has("record_cost_projection")).toBe(true);
  });
});

describe("request_budget (paradas por recurso, fatia 3)", () => {
  it("é write-board e está registrada", () => {
    expect(riskClassForTool("request_budget")).toBe("write-board");
    expect(capture().handlers.has("request_budget")).toBe(true);
  });
});

describe("request_extra_cycle (a regra do ciclo extra)", () => {
  it("é write-board, está registrada e o schema pede loopsUsed, failing, reason e estimateUSD", () => {
    expect(riskClassForTool("request_extra_cycle")).toBe("write-board");
    const { handlers, metas } = capture();
    expect(handlers.has("request_extra_cycle")).toBe(true);
    expect(Object.keys(metas.get("request_extra_cycle")!.inputSchema).sort()).toEqual(["board", "cardId", "estimateUSD", "failing", "loopsUsed", "reason"]);
  });

  it("a skill do condutor pede o ciclo extra por esta tool — e não mais por ask_question technical", () => {
    const skill = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../.claude/skills/harness-conductor/SKILL.md"), "utf8");
    expect(skill).toContain("request_extra_cycle({board, cardId, loopsUsed: 2");
    expect(skill).not.toMatch(/P3 after loop 2: DECLARE it — `ask_question` with `category: "technical"`/);
  });
});
