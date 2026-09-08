import { describe, expect, it } from "vitest";
import { deriveLink } from "./link";
import { linkSchema } from "./schema";

describe("deriveLink — destination link normalisation (producer↔broker seam)", () => {
  it("empty intent → none", () => {
    expect(deriveLink({})).toEqual({ kind: "none" });
  });

  it("board only → none + board", () => {
    expect(deriveLink({ board: "storymap" })).toEqual({ kind: "none", board: "storymap" });
  });

  it("explicit card + cardId → card (carries board + cardId, drops sessionId)", () => {
    expect(deriveLink({ kind: "card", board: "storymap", cardId: "story-x", sessionId: "s1" })).toEqual({
      kind: "card",
      board: "storymap",
      cardId: "story-x",
    });
  });

  it("infers card from a bare cardId (kind absent)", () => {
    expect(deriveLink({ cardId: "story-x" })).toEqual({ kind: "card", cardId: "story-x" });
  });

  it("infers session from a bare sessionId (kind absent)", () => {
    expect(deriveLink({ sessionId: "tmux-7" })).toEqual({ kind: "session", sessionId: "tmux-7" });
  });

  it("an EXPLICIT none is respected even when a stray cardId rides along (the picker's 'Novo item')", () => {
    expect(deriveLink({ kind: "none", cardId: "story-x", board: "storymap" })).toEqual({
      kind: "none",
      board: "storymap",
    });
  });

  it("card with no cardId degrades to none (can't refine a card with no id)", () => {
    expect(deriveLink({ kind: "card", board: "storymap" })).toEqual({ kind: "none", board: "storymap" });
  });

  it("session with no sessionId degrades to none", () => {
    expect(deriveLink({ kind: "session" })).toEqual({ kind: "none" });
  });

  it("trims blank selections (whitespace is not a target)", () => {
    expect(deriveLink({ kind: "card", cardId: "   " })).toEqual({ kind: "none" });
  });

  it("both selections present with kind=card → card wins, sessionId dropped", () => {
    expect(deriveLink({ kind: "card", cardId: "c1", sessionId: "s1" })).toEqual({ kind: "card", cardId: "c1" });
  });

  it("output is always linkSchema-valid", () => {
    for (const input of [{}, { cardId: "c" }, { sessionId: "s" }, { kind: "card", cardId: "c", board: "b" }]) {
      expect(linkSchema.safeParse(deriveLink(input)).success).toBe(true);
    }
  });
});
