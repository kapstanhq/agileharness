import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

// createcard-toctou regression: two concurrent creates of the SAME backbone title used to read the
// same id-set and both mint the same deterministic slug id (makeId), the second writeCard silently
// overwriting the first card's file. The board-scoped withCreateLock now serializes read→mint→write,
// so the second create re-reads AFTER the first commit and makeId increments. This exercises the REAL
// withCreateLock (NOT the pass-through commit.test uses) over a shared in-memory store.

// next/cache is Next-only at runtime; stub it so importing the server action works.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// A shared on-disk fake: writeCard pushes to `store`, readCards reflects it — so the lock's effect
// (second create sees the first's write) is observable. coerceCard stays REAL (spread actual).
let store: Card[] = [];
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readCards: async () => store.map((c) => ({ ...c })),
    readBoardConfig: async () => ({ id: "b", name: "B", statuses: [], releases: [], personas: [], systems: [], linkTypes: [] }),
  };
});
// Spread actual so withCreateLock is the REAL lock; only writeCard is faked (no filesystem).
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    writeCard: async (_boardId: string, card: Card) => {
      store.push(card);
    },
  };
});
// actions.ts module-loads the engine + autorun channel — stub them (createCardAction doesn't use them).
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));

import { createCardAction } from "@/app/actions";
import { coerceCard } from "@/lib/storymap/repo";

beforeEach(() => {
  store = [];
});

describe("createCardAction — board-scoped create lock (createcard-toctou)", () => {
  it("two concurrent creates of the SAME backbone title mint DISTINCT ids — neither overwrites the other", async () => {
    // Both calls carry the same client-minted id (what two surfaces deriving from the same title produce).
    const mk = () => coerceCard("act-backbone", { type: "activity", title: "Backbone X" }, "");
    const [a, b] = await Promise.all([
      createCardAction({ boardId: "b", card: mk() }),
      createCardAction({ boardId: "b", card: mk() }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(store).toHaveLength(2); // both persisted — no silent overwrite
    expect(new Set(store.map((c) => c.id)).size).toBe(2); // distinct ids (the second re-minted)
  });

  it("a single create keeps its id when the board is empty (no spurious re-mint)", async () => {
    const res = await createCardAction({ boardId: "b", card: coerceCard("act-solo", { type: "activity", title: "Solo" }, "") });
    expect(res.ok).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0].id).toBe("act-solo");
  });
});
