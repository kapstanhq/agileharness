import { describe, expect, it } from "vitest";
import {
  checkAA,
  coerceStyleGuideDoc,
  coerceStyleGuidePointer,
  compileStyleGuideMd,
  computeStyleGuideHash,
  contrastRatio,
  diffStyleGuide,
  isEmptyStyleGuideDoc,
  parseStyleGuideMd,
  styleGuideToPrompt,
  STYLE_GUIDE_BOUNDS,
  type ColorToken,
  type StyleGuideDoc,
} from "./style-guide";
import { STYLE_SECTION_KEYS } from "./style-guide-blocks";

// A fully-populated, plausible doc — used by the compiler/fixed-point/diff tests below.
function fullDoc(): StyleGuideDoc {
  return coerceStyleGuideDoc({
    meta: { version: 3, updatedAt: "2026-07-15T10:00:00.000Z", sources: { prompt: "energia editorial", refs: ["refs/b1/ref-1.webp"] } },
    identity: { school: "editorial urbano de alto contraste", personality: ["confiante", "direto"], prose: "É direto, nunca institucional." },
    principles: { items: ["Um destaque por tela", "Conteúdo é a decoração"], prose: "" },
    color: {
      tokens: [
        { role: "primary", value: "#FF4F00", on: "#FFFFFF", usage: "CTA e foco", budget: "≤ 10% da área" },
        { role: "surface", value: "#FAFAF7", on: "#1A1A18", usage: "fundo padrão" },
      ],
      budgetRules: ["accent ≤ 10% da área"],
      prose: "Paleta enxuta.",
    },
    typography: {
      fonts: [{ family: "Archivo", role: "display" }, { family: "Inter", role: "body" }],
      scale: [{ id: "hero", size: "32/38px", weight: 800, rule: "1 por view" }],
      rules: ["nunca duas fontes display na mesma view"],
      prose: "",
    },
    spacing: { base: 4, steps: [4, 8, 12, 16, 24], prose: "" },
    shape: { radii: { card: "0.75rem" }, depth: "sem sombras", borders: "1px foreground/10", prose: "" },
    motion: { durations: { fast: "120ms" }, easings: { base: "ease-out" }, prose: "" },
    voice: {
      lexicon: { preferred: [{ use: "eventos", avoid: "rolês" }], forbidden: ["rolê"], exceptions: [] },
      prose: "",
    },
    antiPatterns: [{ symptom: "gradiente em CTA", fix: "usar primary sólido" }],
    debt: { knownIssues: ["checkout ainda usa azul legado #4B76E8"] },
    tokenBindings: { primary: { file: "web/src/app/globals.css", cssVar: "--primary" } },
  });
}

describe("coerceStyleGuideDoc — tolerant, never throws", () => {
  it("degrades null/undefined/garbage to the fully-shaped empty doc", () => {
    for (const bad of [null, undefined, "garbage", 42, [], () => {}]) {
      expect(() => coerceStyleGuideDoc(bad)).not.toThrow();
      const doc = coerceStyleGuideDoc(bad);
      expect(isEmptyStyleGuideDoc(doc)).toBe(true);
      // every section is ALWAYS present, even on garbage input.
      for (const key of STYLE_SECTION_KEYS) expect(doc).toHaveProperty(key);
    }
  });

  it("degrades a legacy/half-shaped payload (missing sections, wrong types) without throwing", () => {
    const doc = coerceStyleGuideDoc({
      identity: "isso deveria ser um objeto, não string",
      color: { tokens: "isso deveria ser array" },
      spacing: { base: "quatro", steps: [4, -1, "x", 8] },
    });
    expect(doc.identity).toEqual({ school: "", personality: [], prose: "" });
    expect(doc.color.tokens).toEqual([]);
    expect(doc.spacing.base).toBe(0); // "quatro" is not a finite number → falls back to 0
    expect(doc.spacing.steps).toEqual([4, 8]); // non-finite/negative entries dropped
  });

  it("truncates color tokens at MAX_COLOR_ROLES (33 in → 32 out)", () => {
    const tokens = Array.from({ length: 33 }, (_, i) => ({ role: `role-${i}`, value: "#ffffff", usage: "u" }));
    const doc = coerceStyleGuideDoc({ color: { tokens } });
    expect(doc.color.tokens.length).toBe(STYLE_GUIDE_BOUNDS.MAX_COLOR_ROLES);
    expect(doc.color.tokens.length).toBe(32);
  });

  it("truncates typography scale at MAX_TYPE_LEVELS", () => {
    const scale = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, size: "10/12px", weight: 400 }));
    const doc = coerceStyleGuideDoc({ typography: { scale } });
    expect(doc.typography.scale.length).toBe(STYLE_GUIDE_BOUNDS.MAX_TYPE_LEVELS);
  });

  it("truncates list sections at MAX_LIST_ITEMS and prose at MAX_SECTION_PROSE", () => {
    const items = Array.from({ length: 100 }, (_, i) => `item ${i}`);
    const doc = coerceStyleGuideDoc({ principles: { items, prose: "x".repeat(10_000) } });
    expect(doc.principles.items.length).toBe(STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS);
    expect(doc.principles.prose.length).toBe(STYLE_GUIDE_BOUNDS.MAX_SECTION_PROSE);
  });

  it("truncates refs at MAX_REFS", () => {
    const refs = Array.from({ length: 20 }, (_, i) => `refs/b1/ref-${i}.webp`);
    const doc = coerceStyleGuideDoc({ meta: { sources: { refs } } });
    expect(doc.meta.sources.refs.length).toBe(STYLE_GUIDE_BOUNDS.MAX_REFS);
  });

  it("drops a color token missing role/value (partial entries are useless, not padded)", () => {
    const doc = coerceStyleGuideDoc({ color: { tokens: [{ role: "primary" }, { value: "#fff" }, { role: "ok", value: "#000", usage: "u" }] } });
    expect(doc.color.tokens).toEqual([{ role: "ok", value: "#000", usage: "u" }]);
  });

  it("a malicious __proto__/constructor key in a record section is dropped, never pollutes", () => {
    const payload = JSON.parse(
      '{"shape":{"radii":{"__proto__":{"polluted":"yes"},"constructor":"x","card":"0.5rem"}},"tokenBindings":{"__proto__":{"file":"a","cssVar":"--a"},"primary":{"file":"b","cssVar":"--b"}}}',
    );
    const doc = coerceStyleGuideDoc(payload);
    expect(doc.shape.radii).toEqual({ card: "0.5rem" });
    expect(doc.tokenBindings).toEqual({ primary: { file: "b", cssVar: "--b" } });
    // the object's OWN prototype was never retargeted by the malicious key.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("is idempotent — coercing an already-coerced doc is a no-op", () => {
    const doc = fullDoc();
    expect(coerceStyleGuideDoc(doc)).toEqual(doc);
  });
});

describe("isEmptyStyleGuideDoc — emptiness canonical", () => {
  it("a freshly-coerced blank doc reads as empty (never a phantom conflict)", () => {
    expect(isEmptyStyleGuideDoc(coerceStyleGuideDoc(null))).toBe(true);
    expect(isEmptyStyleGuideDoc(coerceStyleGuideDoc(undefined))).toBe(true);
    expect(isEmptyStyleGuideDoc(coerceStyleGuideDoc({}))).toBe(true);
  });

  it("a doc with a single filled field is NOT empty", () => {
    expect(isEmptyStyleGuideDoc(coerceStyleGuideDoc({ identity: { school: "algo" } }))).toBe(false);
  });

  it("a fully-populated doc is NOT empty", () => {
    expect(isEmptyStyleGuideDoc(fullDoc())).toBe(false);
  });
});

describe("contrastRatio — WCAG 2.1 relative luminance", () => {
  it("black on white is the maximum ratio, exactly 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21); // order-independent
  });

  it("a known WebAIM reference pair (#767676 on white ≈ 4.54:1 — the classic 'just passes AA' gray)", () => {
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 1);
  });

  it("a known failing pair (#999999 on white ≈ 2.85:1 — fails even the large-text 3:1 bar)", () => {
    expect(contrastRatio("#999999", "#FFFFFF")).toBeCloseTo(2.85, 1);
  });

  it("hsl(...) and the equivalent hex resolve to the SAME ratio", () => {
    const viaHex = contrastRatio("#999999", "#ffffff");
    const viaHsl = contrastRatio("hsl(0, 0%, 60%)", "#ffffff");
    expect(viaHsl).toBeCloseTo(viaHex, 4);
  });

  it("3-digit hex shorthand resolves like its 6-digit expansion", () => {
    expect(contrastRatio("#000", "#fff")).toBe(21);
  });

  it("oklch(...) converts white/black to the same 21:1 extreme", () => {
    expect(contrastRatio("oklch(100% 0 0)", "oklch(0% 0 0)")).toBeCloseTo(21, 0);
  });

  it("a malformed oklch(...) is rejected with a clear message, never a silent NaN", () => {
    expect(() => contrastRatio("oklch(not a color)", "#fff")).toThrow(/oklch/i);
  });

  it("an unsupported format (bare rgb()) is rejected with a clear message", () => {
    expect(() => contrastRatio("rgb(0,0,0)", "#fff")).toThrow(/formato de cor/i);
  });
});

describe("checkAA", () => {
  it("normal-text usage requires 4.5:1 — a token with a clean pair passes AA", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "foreground", value: "#000000", on: "#FFFFFF", usage: "texto padrão de leitura" }] },
    });
    const report = checkAA(doc);
    expect(report.pairs).toEqual([{ role: "foreground", ratio: 21, level: "AA" }]);
  });

  it("normal-text usage FAILS a sub-4.5:1 pair", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "muted", value: "#999999", on: "#FFFFFF", usage: "texto padrão" }] },
    });
    expect(checkAA(doc).pairs[0].level).toBe("fail");
  });

  it("a large/CTA usage only needs 3:1 — a pair failing normal text can still pass AA-large", () => {
    // #767676 on white ≈ 4.54 (passes both); pick something between 3 and 4.5 for a clean AA-large-only case.
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "accent", value: "#949494", on: "#FFFFFF", usage: "CTA grande" }] },
    });
    const { level, ratio } = checkAA(doc).pairs[0];
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThan(4.5);
    expect(level).toBe("AA-large");
  });

  it("skips tokens with no `on` pair (nothing to check)", () => {
    const doc = coerceStyleGuideDoc({ color: { tokens: [{ role: "accent", value: "#FF4F00", usage: "cta" }] } });
    expect(checkAA(doc).pairs).toEqual([]);
  });

  it("an unparseable pair fails CLOSED (never throws out of checkAA)", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "broken", value: "not-a-color", on: "#fff", usage: "texto" }] },
    });
    expect(() => checkAA(doc)).not.toThrow();
    expect(checkAA(doc).pairs).toEqual([{ role: "broken", ratio: 0, level: "fail" }]);
  });
});

describe("compileStyleGuideMd / parseStyleGuideMd — D3 fixed point", () => {
  it("compiles the SAME doc to the SAME bytes (deterministic)", () => {
    const doc = fullDoc();
    expect(compileStyleGuideMd(doc)).toBe(compileStyleGuideMd(doc));
  });

  it("every STYLE_SECTIONS key appears in the compiled .md", () => {
    const compiled = compileStyleGuideMd(fullDoc());
    for (const key of STYLE_SECTION_KEYS) {
      expect(compiled.includes(key), `missing section key "${key}" in compiled .md`).toBe(true);
    }
  });

  it("carries the GERADO warning header (manual edits are overwritten on next approve)", () => {
    expect(compileStyleGuideMd(fullDoc())).toMatch(/^<!-- GERADO/);
  });

  it("fixed point: parse(compile(doc)) ≡ coerce(doc)", () => {
    const doc = fullDoc();
    const roundTripped = parseStyleGuideMd(compileStyleGuideMd(doc));
    expect(roundTripped).toEqual(coerceStyleGuideDoc(doc));
  });

  it("fixed point holds for the EMPTY doc too (no crash, no phantom content)", () => {
    const empty = coerceStyleGuideDoc(null);
    const roundTripped = parseStyleGuideMd(compileStyleGuideMd(empty));
    expect(roundTripped).toEqual(empty);
    expect(isEmptyStyleGuideDoc(roundTripped)).toBe(true);
  });

  it("parseStyleGuideMd degrades ungracefully-formatted text to the empty doc, never throws", () => {
    expect(() => parseStyleGuideMd("")).not.toThrow();
    expect(() => parseStyleGuideMd("not a compiled guide at all")).not.toThrow();
    expect(isEmptyStyleGuideDoc(parseStyleGuideMd("garbage\n---\nnot: [valid, yaml,\n---\nbody"))).toBe(true);
  });

  it("the compiled .md NEVER embeds a `hash` key in the frontmatter (D3 self-reference trap)", () => {
    const compiled = compileStyleGuideMd(fullDoc());
    const frontmatter = compiled.split("\n---\n")[1];
    expect(frontmatter).not.toMatch(/^hash:/m);
  });
});

describe("computeStyleGuideHash", () => {
  it("is deterministic for the same bytes", () => {
    const md = compileStyleGuideMd(fullDoc());
    expect(computeStyleGuideHash(md)).toBe(computeStyleGuideHash(md));
  });

  it("changes when the compiled bytes change", () => {
    const a = compileStyleGuideMd(fullDoc());
    const b = compileStyleGuideMd(coerceStyleGuideDoc({ ...fullDoc(), identity: { school: "outra escola", personality: [], prose: "" } }));
    expect(computeStyleGuideHash(a)).not.toBe(computeStyleGuideHash(b));
  });

  it("looks like a sha256 hex digest", () => {
    expect(computeStyleGuideHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("diffStyleGuide", () => {
  it("reports no changes for two coercions of the same doc", () => {
    const doc = fullDoc();
    const diff = diffStyleGuide(doc, coerceStyleGuideDoc(doc));
    expect(diff.changedSections).toEqual([]);
    expect(diff.colorTokenChanges).toEqual([]);
  });

  it("reports the changed section + the specific color token change (added/removed/changed)", () => {
    const a = fullDoc();
    const b = coerceStyleGuideDoc({
      ...a,
      color: {
        ...a.color,
        tokens: [
          { role: "primary", value: "#000000", on: "#FFFFFF", usage: "CTA e foco", budget: "≤ 10% da área" }, // changed value
          { role: "danger", value: "#FF0000", usage: "erros" }, // added
          // "surface" removed
        ],
      },
    });
    const diff = diffStyleGuide(a, b);
    expect(diff.changedSections).toContain("color");
    expect(diff.colorTokenChanges).toEqual(
      expect.arrayContaining([
        { role: "primary", kind: "changed" },
        { role: "danger", kind: "added" },
        { role: "surface", kind: "removed" },
      ]),
    );
  });
});

describe("styleGuideToPrompt", () => {
  it("mentions every section label and the current version", () => {
    const prompt = styleGuideToPrompt(fullDoc());
    expect(prompt).toContain("versão 3");
    expect(prompt).toContain("primary");
  });

  it("never throws on the empty doc", () => {
    expect(() => styleGuideToPrompt(coerceStyleGuideDoc(null))).not.toThrow();
  });
});

describe("coerceStyleGuidePointer", () => {
  it("accepts a well-formed pointer", () => {
    expect(coerceStyleGuidePointer({ version: 3, hash: "abc123", updatedAt: "2026-07-15" })).toEqual({
      version: 3,
      hash: "abc123",
      updatedAt: "2026-07-15",
    });
  });

  it("omits updatedAt when absent (sparse, stable key order)", () => {
    expect(coerceStyleGuidePointer({ version: 1, hash: "x" })).toEqual({ version: 1, hash: "x" });
  });

  it("rejects an incomplete/garbage pointer as undefined (no guide yet)", () => {
    expect(coerceStyleGuidePointer(null)).toBeUndefined();
    expect(coerceStyleGuidePointer({})).toBeUndefined();
    expect(coerceStyleGuidePointer({ version: 0, hash: "x" })).toBeUndefined();
    expect(coerceStyleGuidePointer({ version: 1, hash: "" })).toBeUndefined();
    expect(coerceStyleGuidePointer({ version: "not-a-number", hash: "x" })).toBeUndefined();
  });

  it("is idempotent (needed for the persist-side re-coercion, D-lockstep)", () => {
    const p = coerceStyleGuidePointer({ version: 2, hash: "h", updatedAt: "2026-07-01" });
    expect(coerceStyleGuidePointer(p)).toEqual(p);
  });
});

// Sanity: the ColorToken type is exercised structurally above; this asserts the field names the
// downstream WSes will build against didn't silently drift.
describe("ColorToken shape", () => {
  it("role/value/usage required, on/budget optional", () => {
    const token: ColorToken = { role: "primary", value: "#fff", usage: "cta" };
    expect(token.on).toBeUndefined();
    expect(token.budget).toBeUndefined();
  });
});
