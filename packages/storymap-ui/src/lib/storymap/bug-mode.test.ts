import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";
import { checkGate } from "./gates";
import type { BoardConfig, Card } from "./types";

const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [{ id: "corrigir", name: "Corrigir", gate: "hasBugReport", trigger: "harness-fix" }],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

describe("coerceCard — fix mode (mode + bugReport)", () => {
  it("defaults a card to build mode with no bug report", () => {
    const c = card({});
    expect(c.mode).toBeUndefined();
    expect(c.bugReport).toBeNull();
  });

  it("reads mode:fix and the full bugReport block", () => {
    const c = card({
      mode: "fix",
      bugReport: {
        brief: "imagem some no mobile",
        severity: "high",
        expected: "imagem aparece",
        actual: "imagem some",
        steps: ["abrir /eventos", "tocar no card"],
        target: "/eventos/[id]",
        screenshot: "current.png",
        openedAt: "2026-06-03",
      },
    });
    expect(c.mode).toBe("fix");
    expect(c.bugReport).toMatchObject({
      brief: "imagem some no mobile",
      severity: "high",
      expected: "imagem aparece",
      actual: "imagem some",
      steps: ["abrir /eventos", "tocar no card"],
      target: "/eventos/[id]",
      screenshot: "current.png",
      openedAt: "2026-06-03",
    });
  });

  it("defaults an unknown/absent severity to medium and keeps steps as a string array", () => {
    expect(card({ mode: "fix", bugReport: { brief: "x", severity: "bogus" } }).bugReport?.severity).toBe("medium");
    expect(card({ bugReport: { brief: "x" } }).bugReport?.severity).toBe("medium"); // severity absent
    expect(card({ bugReport: { brief: "x", steps: "nope" } }).bugReport?.steps).toEqual([]); // non-array → []
  });

  it("drops a bug report with no brief", () => {
    expect(card({ mode: "fix", bugReport: { severity: "high" } }).bugReport).toBeNull();
  });

  it("coerces an unknown mode (e.g. legacy 'bug') back to build (undefined)", () => {
    expect(card({ mode: "bug" }).mode).toBeUndefined();
  });
});

describe("checkGate — hasBugReport (gate de `corrigir`)", () => {
  it("blocks entry to corrigir without a bug report", () => {
    expect(checkGate(card({}), "corrigir", board)).toMatch(/bug|Corrigir/i);
  });

  it("passes once the bug report carries a brief", () => {
    const c = card({ mode: "fix", bugReport: { brief: "preço aparece como NaN", severity: "high" } });
    expect(checkGate(c, "corrigir", board)).toBeNull();
  });
});

describe("cardToFrontmatter — fix round-trip", () => {
  const base = card({ title: "X" });

  it("omits mode + bugReport on a build card (stays lean)", () => {
    const fm = cardToFrontmatter(base);
    expect("mode" in fm).toBe(false);
    expect("bugReport" in fm).toBe(false);
  });

  it("emits + round-trips mode:fix + bugReport on a fix card", () => {
    const fixed: Card = {
      ...base,
      mode: "fix",
      status: "corrigir",
      bugReport: {
        brief: "preço NaN",
        severity: "blocker",
        expected: "mostra R$ 30",
        actual: "mostra R$ NaN",
        steps: ["abrir cinema"],
        target: null,
        screenshot: null,
        openedAt: "2026-06-03",
      },
    };
    const fm = cardToFrontmatter(fixed);
    expect(fm.mode).toBe("fix");
    expect(fm.bugReport).toMatchObject({ brief: "preço NaN", severity: "blocker", steps: ["abrir cinema"] });

    const backCard = coerceCard("x", fm as Record<string, unknown>, "");
    expect(backCard.mode).toBe("fix");
    expect(backCard.bugReport).toMatchObject({
      brief: "preço NaN",
      severity: "blocker",
      expected: "mostra R$ 30",
      openedAt: "2026-06-03",
    });
  });

  it("does not emit a bug report whose brief is empty", () => {
    const empty: Card = {
      ...base,
      mode: "fix",
      bugReport: {
        brief: "",
        severity: "medium",
        expected: null,
        actual: null,
        steps: [],
        target: null,
        screenshot: null,
        openedAt: null,
      },
    };
    expect("bugReport" in cardToFrontmatter(empty)).toBe(false);
  });
});

describe("write/coerce — os blocos de reabertura são mutuamente exclusivos no round-trip", () => {
  // As actions garantem UM bloco por vez (reportBugAction zera refinement; refineCardAction
  // zera bugReport). O serializer não pode ressuscitar o bloco zerado: um refinement/bugReport
  // null é omitido, então o sobrevivente faz round-trip sozinho.
  const base = card({ title: "X" });

  it("um card fix com refinement zerado emite só bugReport", () => {
    const c: Card = {
      ...base,
      mode: "fix",
      refinement: null,
      bugReport: {
        brief: "quebrou",
        severity: "high",
        expected: null,
        actual: null,
        steps: [],
        target: null,
        screenshot: null,
        openedAt: "2026-06-03",
      },
    };
    const fm = cardToFrontmatter(c);
    expect("refinement" in fm).toBe(false);
    expect(fm.mode).toBe("fix");
    expect(fm.bugReport).toMatchObject({ brief: "quebrou", severity: "high" });

    const back = coerceCard("x", fm as Record<string, unknown>, "");
    expect(back.refinement).toBeNull();
    expect(back.bugReport?.brief).toBe("quebrou");
  });

  it("um card refine com bugReport zerado emite só refinement", () => {
    const c: Card = {
      ...base,
      mode: "refine",
      refinement: { brief: "melhorar", kinds: ["ux"], target: null, screenshot: null, openedAt: "2026-06-03" },
      bugReport: null,
    };
    const fm = cardToFrontmatter(c);
    expect("bugReport" in fm).toBe(false);
    expect(fm.mode).toBe("refine");
    expect(fm.refinement).toMatchObject({ brief: "melhorar" });

    const back = coerceCard("x", fm as Record<string, unknown>, "");
    expect(back.bugReport).toBeNull();
    expect(back.refinement?.brief).toBe("melhorar");
  });
});
