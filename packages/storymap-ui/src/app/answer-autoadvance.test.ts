import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";

// HITL auto-advance (story-rl5v03): answering the LAST open question on a card sitting in the
// `grill`/Dúvidas step (a human-in-the-loop PAUSE — harness-grill writes the questions and does NOT
// advance) must resume the cascade automatically, board- + storyType-aware, instead of stranding
// the card in Dúvidas waiting for a manual drag. Scoped to the grill step so operator follow-up
// questions raised elsewhere never silently advance a card past a real human gate.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const runSkill = vi.fn((..._args: unknown[]) => ({ ok: true as const }));
vi.mock("@/lib/storymap/runner/engine", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/engine")>();
  // lastRun (ADR-063 4b): empty journal → undefined → loop-guard resets/never trips. Present so the
  // shell's `getRunnerEngine().lastRun(...)` call doesn't throw (this mock's config has no noProgressMax).
  return { ...actual, getRunnerEngine: () => ({ runSkill, onComplete: () => () => {}, lastRun: async () => undefined }) };
});

vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  return { ...actual, loadRunnerConfig: () => ({ autorun: { enabled: true } }) as never };
});

// Pipeline: grill (trigger harness-grill, the HITL pause) → enriquecer (autorun:true + trigger). No gate
// on enriquecer, so a grill card with all questions answered advances straight into it.
const grill: StatusDef = { id: "grill", name: "Dúvidas", trigger: "harness-grill", autorun: true };
const enriquecer: StatusDef = { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true };
const boardConfig: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [grill, enriquecer],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

let cardOnDisk: Card;

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readBoardConfig: async () => boardConfig,
    readCards: async () => [cardOnDisk],
    readCard: async () => cardOnDisk,
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

import { answerQuestionAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const q = (id: string, status: "open" | "answered") => ({
  id,
  text: `pergunta ${id}`,
  askedBy: "harness-grill",
  askedAt: "2026-06-13",
  status,
  ...(status === "answered" ? { answer: "x", answeredAt: "2026-06-13" } : {}),
});

beforeEach(() => {
  runSkill.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("answerQuestionAction — HITL auto-advance out of grill (story-rl5v03)", () => {
  it("answering the LAST open question advances the card out of Dúvidas and fires the next skill", async () => {
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "technical", status: "grill", questions: [q("q1", "open")] },
      "",
    );
    const res = await answerQuestionAction({ boardId: "b", cardId: "story-x", questionId: "q1", answer: "decidido" });
    expect(res.ok).toBe(true);
    await flush();
    expect(cardOnDisk.status).toBe("enriquecer"); // resumed the cascade
    expect(runSkill).toHaveBeenCalledTimes(1); // and spawned the next step's skill
    expect(runSkill.mock.calls[0][2]).toBe("harness-enrich");
  });

  it("does NOT advance while other questions are still open", async () => {
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "technical", status: "grill", questions: [q("q1", "open"), q("q2", "open")] },
      "",
    );
    const res = await answerQuestionAction({ boardId: "b", cardId: "story-x", questionId: "q1", answer: "parcial" });
    expect(res.ok).toBe(true);
    await flush();
    expect(cardOnDisk.status).toBe("grill"); // still waiting on q2
    expect(runSkill).not.toHaveBeenCalled();
  });

  it("does NOT auto-advance when the answered question is on a NON-grill step (operator follow-up)", async () => {
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "technical", status: "enriquecer", questions: [q("q1", "open")] },
      "",
    );
    const res = await answerQuestionAction({ boardId: "b", cardId: "story-x", questionId: "q1", answer: "fyi" });
    expect(res.ok).toBe(true);
    await flush();
    expect(cardOnDisk.status).toBe("enriquecer"); // unchanged — never silently advances past a gate
    expect(runSkill).not.toHaveBeenCalled();
  });
});
