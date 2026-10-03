import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// MCP wiring for the HITL question tools (answer_question / ask_question). These close the
// grill→answer loop for the MCP/phone surface: the web /perguntas queue had no MCP twin, so an
// orchestrator could not answer a harness-grill question without the UI. The tools must DELEGATE to
// the existing server actions (answerQuestionAction / askQuestionsAction) and report how many
// questions stay open, so the caller knows when it's safe to advance the card. We mock @/app/actions
// so no real .md is written.

const answerQuestionAction = vi.fn();
const askQuestionsAction = vi.fn();
vi.mock("@/app/actions", () => ({
  answerQuestionAction: (...a: unknown[]) => answerQuestionAction(...a),
  askQuestionsAction: (...a: unknown[]) => askQuestionsAction(...a),
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

function parseResult(r: CallToolResult): Record<string, unknown> {
  return JSON.parse((r.content[0] as { text: string }).text);
}

/** A minimal card whose `questions[]` openQuestions() can filter (only status matters here). */
const cardWith = (questions: unknown[]) => ({ id: "story-x", questions });

beforeEach(() => {
  answerQuestionAction.mockReset();
  askQuestionsAction.mockReset();
});

describe("answer_question — delegates + reports remaining open", () => {
  it("answers a question and counts the ones still open", async () => {
    answerQuestionAction.mockResolvedValue({
      ok: true,
      data: {
        card: cardWith([
          { id: "q1", text: "a", status: "answered" },
          { id: "q2", text: "b", status: "open" },
          { id: "q3", text: "c", status: "open" },
        ]),
      },
    });
    const out = await captureHandlers().get("answer_question")!({
      board: "storymap",
      cardId: "story-x",
      questionId: "q1",
      answer: "Sim, colapsa",
    });
    expect(answerQuestionAction).toHaveBeenCalledWith(
      // F6.3 — an MCP answer is ALWAYS the agent (the human uses the /perguntas UI), so it is
      // attributed as "copilot" server-side, not by the model.
      expect.objectContaining({ boardId: "storymap", cardId: "story-x", questionId: "q1", answer: "Sim, colapsa", answeredBy: "copilot" }),
    );
    const parsed = parseResult(out);
    expect(parsed.answered).toBe("q1");
    expect(parsed.openRemaining).toBe(2);
    expect(parsed.openIds).toEqual(["q2", "q3"]);
  });

  it("surfaces the action error (no write)", async () => {
    answerQuestionAction.mockResolvedValue({ ok: false, error: "card não encontrado" });
    const out = await captureHandlers().get("answer_question")!({
      board: "storymap",
      cardId: "nope",
      questionId: "q1",
      answer: "x",
    });
    expect(out.isError).toBe(true);
  });
});

describe("ask_question — delegates to askQuestionsAction", () => {
  it("appends questions and reports the open ids", async () => {
    askQuestionsAction.mockResolvedValue({
      ok: true,
      data: { card: cardWith([{ id: "q1", text: "nova", status: "open" }]) },
    });
    const out = await captureHandlers().get("ask_question")!({
      board: "storymap",
      cardId: "story-x",
      texts: ["nova"],
    });
    expect(askQuestionsAction).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: "storymap", cardId: "story-x", texts: ["nova"] }),
    );
    expect(parseResult(out).openIds).toEqual(["q1"]);
  });

  it("registers both HITL tools", () => {
    const h = captureHandlers();
    expect(h.has("answer_question")).toBe(true);
    expect(h.has("ask_question")).toBe(true);
  });
});
