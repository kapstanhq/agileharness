import { describe, expect, it } from "vitest";
import { STYLE_SECTIONS, STYLE_SECTION_KEYS, STYLE_SECTION_BY_KEY, styleSectionLabel } from "./style-guide-blocks";

describe("STYLE_SECTIONS registry", () => {
  it("has exactly the 10 canonical sections from 00-conteudo-do-guia.md, in fill order", () => {
    expect(STYLE_SECTIONS.map((s) => s.key)).toEqual([
      "identity",
      "principles",
      "color",
      "typography",
      "spacing",
      "shape",
      "motion",
      "voice",
      "antiPatterns",
      "debt",
    ]);
  });

  it("every entry has a non-empty label + hint + a valid kind", () => {
    for (const s of STYLE_SECTIONS) {
      expect(s.label.trim()).not.toBe("");
      expect(s.hint.trim()).not.toBe("");
      expect(["tokens", "prose", "mixed"]).toContain(s.kind);
    }
  });

  it("every cell is a STATIC class string (no template interpolation of a variable)", () => {
    for (const s of STYLE_SECTIONS) {
      if (s.cell) expect(s.cell).not.toMatch(/\$\{/);
    }
  });

  it("STYLE_SECTION_KEYS mirrors the registry order 1:1", () => {
    expect(STYLE_SECTION_KEYS).toEqual(STYLE_SECTIONS.map((s) => s.key));
  });

  it("STYLE_SECTION_BY_KEY resolves every key to its own def", () => {
    for (const s of STYLE_SECTIONS) {
      expect(STYLE_SECTION_BY_KEY.get(s.key)).toBe(s);
    }
  });

  it("styleSectionLabel falls back to the raw key for an unknown key", () => {
    expect(styleSectionLabel("color")).toBe("Cor");
    expect(styleSectionLabel("nao-existe")).toBe("nao-existe");
  });

  it("keys are unique", () => {
    expect(new Set(STYLE_SECTION_KEYS).size).toBe(STYLE_SECTION_KEYS.length);
  });
});
