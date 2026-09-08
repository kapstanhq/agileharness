import { describe, expect, it } from "vitest";
import { correlateCommitWarnings } from "./warnings";
import type { CardCommitWarning } from "@/lib/storymap/types";

const w = (over: Partial<CardCommitWarning> & { tempId: string }): CardCommitWarning => ({
  code: "parent-dropped",
  detail: "d",
  ...over,
});

describe("correlateCommitWarnings (4.1) — commit warnings → human-facing view", () => {
  it("pairs a warning with its item's title + the resolved cardId", () => {
    const items = [{ tempId: "t1", title: "Mural de favoritos" }];
    const warnings = [w({ tempId: "t1", code: "parent-dropped", detail: 'parent "x" não resolveu', cardId: "story-abc" })];
    const [v] = correlateCommitWarnings(items, warnings);
    expect(v).toEqual({ code: "parent-dropped", detail: 'parent "x" não resolveu', title: "Mural de favoritos", cardId: "story-abc" });
  });

  it("falls back to cardId:null when the warning carries no resolved id (link is omitted)", () => {
    const items = [{ tempId: "t1", title: "T" }];
    const [v] = correlateCommitWarnings(items, [w({ tempId: "t1" })]);
    expect(v.cardId).toBeNull();
    expect(v.title).toBe("T");
  });

  it("uses the 'Sem título' fallback when the item title is empty/whitespace (mirrors the commit)", () => {
    const items = [{ tempId: "t1", title: "   " }];
    const [v] = correlateCommitWarnings(items, [w({ tempId: "t1", cardId: "c1" })]);
    expect(v.title).toBe("Sem título");
  });

  it("uses 'Sem título' when the tempId matches no item at all", () => {
    const [v] = correlateCommitWarnings([], [w({ tempId: "gone", cardId: "c1" })]);
    expect(v.title).toBe("Sem título");
    expect(v.cardId).toBe("c1");
  });

  it("preserves order and maps every warning (serves-dropped/forced-created too)", () => {
    const items = [
      { tempId: "t1", title: "A" },
      { tempId: "t2", title: "B" },
    ];
    const warnings = [
      w({ tempId: "t2", code: "serves-dropped", cardId: "cB" }),
      w({ tempId: "t1", code: "forced-created", cardId: "cA" }),
    ];
    const views = correlateCommitWarnings(items, warnings);
    expect(views.map((v) => [v.title, v.code, v.cardId])).toEqual([
      ["B", "serves-dropped", "cB"],
      ["A", "forced-created", "cA"],
    ]);
  });

  it("returns [] for no warnings", () => {
    expect(correlateCommitWarnings([{ tempId: "t1", title: "A" }], [])).toEqual([]);
  });
});
