import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

// Eixo 3.1 (#39): QA approval is first-class — approveQaAction sets qaPassed/qaRanAt/qaCommit via the
// SAME fresh-disk re-read lock as every other pipeline action, and update_card REJECTS pipeline-owned
// fields explicitly (instead of stripping them silently, which is what forced hand-editing the YAML).
// These tests pin: (1) approveQaAction stamps with a valid human-review status; (2) it rejects an
// invalid (upstream/autorun) status without writing; (3) update_card returns an explicit error citing
// the rejected pipeline fields + pointing at approve_qa.

// next/cache is a Next-only runtime; stub revalidatePath so importing the server action works.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The card on disk — `updateCardOnDisk` mutates this shared ref, `readCard` reflects it.
let cardOnDisk: Card;

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readCard: async () => cardOnDisk,
    readCards: async () => [cardOnDisk],
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(cardOnDisk);
      if (next) cardOnDisk = next;
      return next;
    },
    writeCard: async () => {},
  };
});

import { approveQaAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";
import { registerStorymapTools } from "@/lib/storymap/mcp/tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

/** Register the real tools onto a fake McpServer and return the handler map by name. */
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

beforeEach(() => {
  cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "qa-automatizado" }, "");
});

afterEach(() => vi.clearAllMocks());

describe("approveQaAction — first-class QA approval (Eixo 3.1)", () => {
  it("stamps qaPassed/qaRanAt with a valid human-review status (qa-automatizado)", async () => {
    const res = await approveQaAction({ boardId: "b", cardId: "story-x", qaCommit: "abc123" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.qaPassed).toBe(true);
    expect(cardOnDisk.qaRanAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); // today()
    expect(cardOnDisk.qaCommit).toBe("abc123");
  });

  it("also approves when the card is already in the human approval column (revisao)", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "revisao" }, "");
    const res = await approveQaAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.qaPassed).toBe(true);
  });

  it("supports revoking a prior approval with qaPassed:false", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "revisao", qaPassed: true }, "");
    const res = await approveQaAction({ boardId: "b", cardId: "story-x", qaPassed: false });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.qaPassed).toBe(false);
  });

  it("REJECTS approval when the card is in an upstream/autorun column (capturando) — never writes", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "capturando" }, "");
    const res = await approveQaAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/revisão humana/);
    expect(cardOnDisk.qaPassed).toBeUndefined(); // the write never happened — card untouched
  });
});

describe("update_card MCP tool — rejects pipeline-owned fields explicitly", () => {
  it("returns an error citing qaPassed + pointing at approve_qa when a caller tries to set it", async () => {
    const handler = captureHandlers().get("update_card")!;
    const out = await handler({ board: "b", cardId: "story-x", qaPassed: true });
    expect(out.isError).toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/qaPassed/);
    expect(text).toMatch(/approve_qa/);
  });

  it("rejects a non-qa pipeline field (findings) pointing at the autorun, not approve_qa", async () => {
    const handler = captureHandlers().get("update_card")!;
    const out = await handler({ board: "b", cardId: "story-x", findings: [] });
    expect(out.isError).toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/findings/);
    expect(text).toMatch(/autorun/);
  });
});
