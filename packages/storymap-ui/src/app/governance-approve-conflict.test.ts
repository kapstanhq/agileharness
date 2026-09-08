import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, GovernanceDraft } from "@/lib/storymap/types";

// Regression (story-w9n03r, decision q1=o1 "recusar no conflito"): approveGovernanceDraftAction
// must REFUSE when the canonical value changed since the proposal's `before` snapshot — writing
// nothing — instead of warning + overwriting (the old o2 behavior). This guards AC1/AC3 under a
// propose↔approve race: a newer human edit to an owner:human field is never clobbered.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Mutable test doubles for the IO boundary the action touches.
let canonicalDesiredOutcome = "old desiredOutcome";
let pendingDraft: GovernanceDraft | null = null;
let writtenConfigs: BoardConfig[] = [];
let writtenDrafts: GovernanceDraft[] = [];

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readBoardConfig: async (): Promise<BoardConfig> => ({
      id: "b",
      name: "B",
      statuses: [],
      releases: [],
      personas: [],
      systems: [],
      linkTypes: [],
      desiredOutcome: canonicalDesiredOutcome,
    }),
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    writeBoardConfig: async (_boardId: string, config: BoardConfig) => {
      writtenConfigs.push(config);
    },
  };
});

vi.mock("@/lib/storymap/sidecars", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/sidecars")>();
  return {
    ...actual,
    readGovernanceDraft: async () => (pendingDraft ? { ...pendingDraft } : null),
    writeGovernanceDraft: async (_boardId: string, draft: GovernanceDraft) => {
      writtenDrafts.push(draft);
    },
  };
});

// actions.ts module-loads the engine + autorun channel — stub them (these actions don't use them).
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));

import { approveGovernanceDraftAction } from "@/app/actions";

const draftWithBefore = (before: string): GovernanceDraft => ({
  id: "d1",
  board: "b",
  status: "pending",
  reason: "enriquecer story-tihd9l",
  origin: null,
  changes: [{ artifact: "desiredOutcome", field: null, before, after: "new desiredOutcome" }],
  createdAt: "2026-06-15",
  decidedAt: null,
});

beforeEach(() => {
  canonicalDesiredOutcome = "old desiredOutcome";
  pendingDraft = null;
  writtenConfigs = [];
  writtenDrafts = [];
});

describe("approveGovernanceDraftAction — refuses on conflict (q1=o1)", () => {
  it("REFUSES and writes nothing when the canonical changed since the proposal", async () => {
    // Canonical moved to a NEWER human edit; the draft's `before` is the stale snapshot.
    canonicalDesiredOutcome = "NEWER human edit";
    pendingDraft = draftWithBefore("old desiredOutcome");

    const res = await approveGovernanceDraftAction({ boardId: "b", draftId: "d1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("canônico mudou");
    expect(writtenConfigs).toHaveLength(0); // no blind overwrite — canonical untouched
    expect(writtenDrafts).toHaveLength(0); // draft NOT marked approved — still pending for re-proposal
  });

  it("applies the change and marks approved when there is NO conflict", async () => {
    canonicalDesiredOutcome = "old desiredOutcome"; // matches the draft's `before`
    pendingDraft = draftWithBefore("old desiredOutcome");

    const res = await approveGovernanceDraftAction({ boardId: "b", draftId: "d1" });

    expect(res.ok).toBe(true);
    expect(writtenConfigs).toHaveLength(1);
    expect(writtenConfigs[0].desiredOutcome).toBe("new desiredOutcome"); // applied
    expect(writtenDrafts).toHaveLength(1);
    expect(writtenDrafts[0].status).toBe("approved");
  });
});
