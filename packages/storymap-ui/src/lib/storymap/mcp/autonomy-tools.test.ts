import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// lanes-ultra — the MCP surface of the AUTONOMY KEY:
//   • answer_question REFUSES a money/owner-only question (an MCP answer is always an agent's — the owner answers
//     in the Inbox), and never reaches the writer;
//   • ask_question carries the asker's `category` to the action (the proxy's primary signal);
//   • set_card_autonomy / resolve_proxy_audit delegate to their actions (owner decisions — full-token only,
//     pinned in register.test's DESTRUCTIVE surface).

const answerQuestionAction = vi.fn();
const askQuestionsAction = vi.fn();
const setCardAutonomyAction = vi.fn();
const resolveProxyAuditAction = vi.fn();
vi.mock("@/app/actions", () => ({
  answerQuestionAction: (...a: unknown[]) => answerQuestionAction(...a),
  askQuestionsAction: (...a: unknown[]) => askQuestionsAction(...a),
  setCardAutonomyAction: (...a: unknown[]) => setCardAutonomyAction(...a),
  resolveProxyAuditAction: (...a: unknown[]) => resolveProxyAuditAction(...a),
}));

const readCard = vi.fn();
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  readCard: (...a: unknown[]) => readCard(...a),
}));

import { registerStorymapTools } from "./tools";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

function captureHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerStorymapTools(server);
  return handlers;
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

beforeEach(() => {
  for (const f of [answerQuestionAction, askQuestionsAction, setCardAutonomyAction, resolveProxyAuditAction, readCard]) f.mockReset();
});

describe("answer_question — dinheiro é do dono", () => {
  const card = (q: Record<string, unknown>) => ({ id: "story-x", questions: [{ id: "q1", text: "?", status: "open", ...q }] });

  it("pergunta de categoria money ⇒ recusa, e o escritor nem é chamado", async () => {
    readCard.mockResolvedValue(card({ category: "money", text: "Assinamos o plano?" }));
    const out = await captureHandlers().get("answer_question")!({ board: "b", cardId: "story-x", questionId: "q1", answer: "sim" });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/só do dono/);
    expect(answerQuestionAction).not.toHaveBeenCalled();
  });

  it("o PISO também segura: uma interview que fala de preço é do dono", async () => {
    readCard.mockResolvedValue(card({ category: "interview", text: "Qual o preço do plano anual?" }));
    const out = await captureHandlers().get("answer_question")!({ board: "b", cardId: "story-x", questionId: "q1", answer: "R$ 99" });
    expect(out.isError).toBe(true);
    expect(answerQuestionAction).not.toHaveBeenCalled();
  });

  it("uma pergunta comum segue sendo respondida pelo agente (comportamento de sempre)", async () => {
    readCard.mockResolvedValue(card({ category: "interview", text: "A leitora filtra por gênero?" }));
    answerQuestionAction.mockResolvedValue({ ok: true, data: { card: { id: "story-x", questions: [] } } });
    const out = await captureHandlers().get("answer_question")!({ board: "b", cardId: "story-x", questionId: "q1", answer: "sim" });
    expect(out.isError).toBeFalsy();
    expect(answerQuestionAction).toHaveBeenCalledWith(expect.objectContaining({ answeredBy: "copilot" }));
  });
});

describe("ask_question — a categoria do autor chega à action", () => {
  it("questions[].category é repassada", async () => {
    askQuestionsAction.mockResolvedValue({ ok: true, data: { card: { id: "story-x", questions: [] } } });
    await captureHandlers().get("ask_question")!({
      board: "b",
      cardId: "story-x",
      questions: [{ text: "Quem é o público?", category: "interview" }],
    });
    expect(askQuestionsAction).toHaveBeenCalledWith(
      expect.objectContaining({ questions: [expect.objectContaining({ category: "interview" })] }),
    );
  });
});

describe("set_card_autonomy / resolve_proxy_audit — delegam às actions", () => {
  it("set_card_autonomy", async () => {
    setCardAutonomyAction.mockResolvedValue({ ok: true, data: { card: { autonomyMode: "ultra" }, changed: true, effective: { mode: "ultra", source: "card" } } });
    const out = await captureHandlers().get("set_card_autonomy")!({ board: "b", cardId: "story-x", mode: "ultra" });
    expect(setCardAutonomyAction).toHaveBeenCalledWith({ boardId: "b", cardId: "story-x", mode: "ultra" });
    expect(JSON.parse(text(out))).toMatchObject({ ok: true, autonomyMode: "ultra", effective: { mode: "ultra", source: "card" }, changed: true });
  });

  it("resolve_proxy_audit", async () => {
    resolveProxyAuditAction.mockResolvedValue({ ok: false, error: "nenhuma auditoria de proxy pendente" });
    const out = await captureHandlers().get("resolve_proxy_audit")!({ board: "b", cardId: "story-x", questionId: "q1", outcome: "confirmed" });
    expect(resolveProxyAuditAction).toHaveBeenCalledWith({ boardId: "b", cardId: "story-x", questionId: "q1", outcome: "confirmed" });
    expect(out.isError).toBe(true);
  });
});
