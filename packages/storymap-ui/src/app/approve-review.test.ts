import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

// story-740c8g: REVIEW approval is first-class and SYMMETRIC to approveQaAction — approveReviewAction sets
// reviewedAt/reviewCommit (both PIPELINE_OWNED, so update_card rejects them) via the SAME fresh-disk re-read
// lock, letting a human who already reviewed the code stamp the review PROVENANCE instead of re-running
// harness-review or hand-editing the YAML. Unlike approve_qa it unblocks NO gate (there is no hasReview gate).
// These tests pin: (1) it stamps with a valid review status; (2) it also works downstream (revisao);
// (3) reviewed:false revokes; (4) it rejects an upstream/autorun status without writing; (5) the MCP
// approve_review tool exists and delegates.

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

import { approveReviewAction } from "./actions";
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
  cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "revisar-codigo" }, "");
});

afterEach(() => vi.clearAllMocks());

describe("approveReviewAction — first-class review approval (story-740c8g)", () => {
  it("stamps reviewedAt/reviewCommit with a valid review status (revisar-codigo)", async () => {
    const res = await approveReviewAction({ boardId: "b", cardId: "story-x", reviewCommit: "abc123" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); // today()
    expect(cardOnDisk.reviewCommit).toBe("abc123");
  });

  it("also approves downstream in a human-review column (revisao)", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "revisao" }, "");
    const res = await approveReviewAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("revokes a prior review stamp with reviewed:false (clears reviewedAt/reviewCommit)", async () => {
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "user", status: "revisar-codigo", reviewedAt: "2026-07-01", reviewCommit: "old" },
      "",
    );
    const res = await approveReviewAction({ boardId: "b", cardId: "story-x", reviewed: false });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.reviewedAt).toBeNull();
    expect(cardOnDisk.reviewCommit).toBeNull();
  });

  it("REJECTS approval in an upstream/autorun column (capturando) — never writes", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "capturando" }, "");
    const res = await approveReviewAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/revisão/i);
    expect(cardOnDisk.reviewedAt).toBeUndefined(); // the write never happened — card untouched
  });
});

describe("approve_review MCP tool — delegates to approveReviewAction", () => {
  it("stamps the review on a valid card and echoes ok", async () => {
    const handler = captureHandlers().get("approve_review")!;
    const out = await handler({ board: "b", cardId: "story-x", reviewCommit: "deadbeef" });
    expect(out.isError).toBeUndefined();
    expect(cardOnDisk.reviewCommit).toBe("deadbeef");
    expect(cardOnDisk.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("surfaces the rejection when the card is in an invalid column", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "user", status: "capturando" }, "");
    const handler = captureHandlers().get("approve_review")!;
    const out = await handler({ board: "b", cardId: "story-x" });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/revisão/i);
  });
});
