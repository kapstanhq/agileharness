import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";
import { checkGate } from "./gates";
import type { BoardConfig, Card } from "./types";

const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [{ id: "refinar", name: "Refinar", gate: "hasRefineBrief", trigger: "harness-refine" }],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

describe("coerceCard — refine mode (mode + refinement)", () => {
  it("defaults a card to build mode with no refinement", () => {
    const c = card({});
    expect(c.mode).toBeUndefined();
    expect(c.refinement).toBeNull();
  });

  it("reads mode:refine and the full refinement block (kinds is an array)", () => {
    const c = card({
      mode: "refine",
      refinement: {
        brief: "limpar o card de evento",
        kinds: ["ui", "ux"],
        target: "/eventos/[id]",
        screenshot: "current.png",
        openedAt: "2026-06-03",
      },
    });
    expect(c.mode).toBe("refine");
    expect(c.refinement).toMatchObject({
      brief: "limpar o card de evento",
      kinds: ["ui", "ux"],
      target: "/eventos/[id]",
      screenshot: "current.png",
      openedAt: "2026-06-03",
    });
  });

  it("keeps multiple kinds, dedups, and reads a legacy singular `kind`", () => {
    expect(card({ refinement: { brief: "x", kinds: ["ui", "ux", "ui", "copy"] } }).refinement?.kinds).toEqual([
      "ui",
      "ux",
      "copy",
    ]);
    // backward-compat: an old card persisted with the singular `kind`
    expect(card({ refinement: { brief: "x", kind: "copy" } }).refinement?.kinds).toEqual(["copy"]);
  });

  it("drops a refinement with no brief and defaults empty/unknown kinds to [ux]", () => {
    expect(card({ mode: "refine", refinement: { kinds: ["ui"] } }).refinement).toBeNull(); // no brief
    expect(card({ refinement: { brief: "melhora", kinds: ["bogus", "nope"] } }).refinement?.kinds).toEqual(["ux"]);
    expect(card({ refinement: { brief: "melhora" } }).refinement?.kinds).toEqual(["ux"]); // kinds absent
  });

  it("coerces an unknown mode back to build (undefined)", () => {
    expect(card({ mode: "weird" }).mode).toBeUndefined();
  });
});

describe("checkGate — hasRefineBrief (gate de `refinar`)", () => {
  it("blocks entry to refinar without a brief", () => {
    expect(checkGate(card({}), "refinar", board)).toMatch(/refino|Refinar/i);
  });

  it("passes once the refinement carries a brief", () => {
    const c = card({ mode: "refine", refinement: { brief: "repensar o fluxo do zero", kinds: ["ux"] } });
    expect(checkGate(c, "refinar", board)).toBeNull();
  });
});

describe("cardToFrontmatter — refine round-trip", () => {
  const base = card({ title: "X" });

  it("omits mode + refinement on a build card (stays lean)", () => {
    const fm = cardToFrontmatter(base);
    expect("mode" in fm).toBe(false);
    expect("refinement" in fm).toBe(false);
  });

  it("emits + round-trips mode + multi-kind refinement on a refine card", () => {
    const refined: Card = {
      ...base,
      mode: "refine",
      status: "refinar",
      refinement: {
        brief: "polir hierarquia",
        kinds: ["ux", "copy"],
        target: null,
        screenshot: null,
        openedAt: "2026-06-03",
      },
    };
    const fm = cardToFrontmatter(refined);
    expect(fm.mode).toBe("refine");
    expect(fm.refinement).toMatchObject({ brief: "polir hierarquia", kinds: ["ux", "copy"] });

    const back = coerceCard("x", fm as Record<string, unknown>, "");
    expect(back.mode).toBe("refine");
    expect(back.refinement).toMatchObject({ brief: "polir hierarquia", kinds: ["ux", "copy"], openedAt: "2026-06-03" });
  });

  it("does not emit a refinement whose brief is empty", () => {
    const empty: Card = {
      ...base,
      mode: "refine",
      refinement: { brief: "", kinds: ["ui"], target: null, screenshot: null, openedAt: null },
    };
    expect("refinement" in cardToFrontmatter(empty)).toBe(false);
  });
});
