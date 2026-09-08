import { describe, expect, it } from "vitest";
import { makeId, randomCardId, slugify } from "./id";

// The id IS the .md filename stem. A collision that goes undetected makes two
// cards write to the same path → one silently overwrites the other (data loss).
describe("slugify", () => {
  it("strips PT-BR diacritics without mangling the base letters", () => {
    expect(slugify("Avaliação de Eventos")).toBe("avaliacao-de-eventos");
    expect(slugify("Configuração & Ações")).toBe("configuracao-acoes");
    expect(slugify("São Paulo")).toBe("sao-paulo");
  });

  it("collapses non-alphanumerics to single dashes and trims edges", () => {
    expect(slugify("  Hello,  World!! ")).toBe("hello-world");
    expect(slugify("a---b")).toBe("a-b");
  });

  it("returns '' for empty/symbol-only/nullish input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify(null as unknown as string)).toBe("");
  });

  it("truncates to 48 chars", () => {
    expect(slugify("x".repeat(80))).toHaveLength(48);
  });
});

describe("makeId — readable, collision-free filename stem", () => {
  it("prefixes by card type", () => {
    expect(makeId("activity", "Descobrir eventos", new Set())).toBe("act-descobrir-eventos");
    expect(makeId("step", "Buscar", new Set())).toBe("step-buscar");
    expect(makeId("story", "Curtir um evento", new Set())).toBe("story-curtir-um-evento");
  });

  it("falls back to 'sem-titulo' when the title slugifies to empty", () => {
    expect(makeId("story", "!!!", new Set())).toBe("story-sem-titulo");
    expect(makeId("story", "", new Set())).toBe("story-sem-titulo");
  });

  it("suffixes -2, -3… on collision against the existing set", () => {
    expect(makeId("story", "x", new Set(["story-x"]))).toBe("story-x-2");
    expect(makeId("story", "x", new Set(["story-x", "story-x-2"]))).toBe("story-x-3");
    // a gap doesn't matter — it finds the first free suffix
    expect(makeId("story", "x", new Set(["story-x", "story-x-2", "story-x-3"]))).toBe("story-x-4");
  });

  it("falls back to a 'card' prefix for an unknown type", () => {
    expect(makeId("bogus" as never, "x", new Set())).toBe("card-x");
  });
});

describe("randomCardId — quick-capture id (contract, not determinism)", () => {
  it("matches <prefix>-<6 base36 chars> and is not in the existing set", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = randomCardId("story", existing);
      expect(id).toMatch(/^story-[a-z0-9]{6}$/);
      expect(existing.has(id)).toBe(false);
      existing.add(id); // pre-seed so the next iteration must avoid it
    }
  });

  it("honours the type prefix", () => {
    expect(randomCardId("activity", new Set())).toMatch(/^act-[a-z0-9]{6}$/);
    expect(randomCardId("step", new Set())).toMatch(/^step-[a-z0-9]{6}$/);
  });
});
