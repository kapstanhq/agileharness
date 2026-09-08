import { describe, expect, it } from "vitest";
import { auditTokensAgainstCss } from "./style-drift";
import { coerceStyleGuideDoc } from "./style-guide";

const CSS_FILE = "web/src/app/globals.css";

function docWithBindings() {
  return coerceStyleGuideDoc({
    color: {
      tokens: [
        { role: "primary", value: "220 90% 50%", usage: "cta" },
        { role: "surface", value: "0 0% 98%", usage: "fundo" },
        { role: "danger", value: "0 80% 55%", usage: "erro" },
      ],
    },
    tokenBindings: {
      primary: { file: CSS_FILE, cssVar: "--primary" },
      surface: { file: CSS_FILE, cssVar: "--surface" },
      danger: { file: "web/src/app/other.css", cssVar: "--danger" },
    },
  });
}

describe("auditTokensAgainstCss — tokenBindings path (D6, mechanical)", () => {
  it("reports NOTHING when every bound var matches its declared value", () => {
    const files = [{ path: CSS_FILE, text: ":root {\n  --primary: 220 90% 50%;\n  --surface: 0 0% 98%;\n}" }];
    const report = auditTokensAgainstCss(docWithBindings(), [
      ...files,
      { path: "web/src/app/other.css", text: ":root { --danger: 0 80% 55%; }" },
    ]);
    expect(report.findings).toEqual([]);
  });

  it("flags a DIVERGENT var value as mismatch (no confidence flag — mechanical, data-driven)", () => {
    const files = [
      { path: CSS_FILE, text: ":root {\n  --primary: 10 90% 50%;\n  --surface: 0 0% 98%;\n}" }, // primary drifted
      { path: "web/src/app/other.css", text: ":root { --danger: 0 80% 55%; }" },
    ];
    const report = auditTokensAgainstCss(docWithBindings(), files);
    expect(report.findings).toEqual([
      { role: "primary", declared: "220 90% 50%", found: "10 90% 50%", file: CSS_FILE, kind: "mismatch" },
    ]);
  });

  it("flags an ABSENT var (declared file exists, var doesn't) as missing-var", () => {
    const files = [
      { path: CSS_FILE, text: ":root {\n  --surface: 0 0% 98%;\n}" }, // --primary missing
      { path: "web/src/app/other.css", text: ":root { --danger: 0 80% 55%; }" },
    ];
    const report = auditTokensAgainstCss(docWithBindings(), files);
    expect(report.findings).toEqual([{ role: "primary", declared: "220 90% 50%", file: CSS_FILE, kind: "missing-var" }]);
  });

  it("flags an UNREADABLE binding (the declared file wasn't handed in at all) as unreadable", () => {
    const files = [{ path: CSS_FILE, text: ":root { --primary: 220 90% 50%; --surface: 0 0% 98%; }" }];
    // "other.css" (danger's binding) is absent from `files` entirely.
    const report = auditTokensAgainstCss(docWithBindings(), files);
    expect(report.findings).toEqual([
      { role: "danger", declared: "0 80% 55%", file: "web/src/app/other.css", kind: "unreadable" },
    ]);
  });

  it("ignores a binding whose role the guide no longer declares (stale binding, not an error)", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "primary", value: "220 90% 50%", usage: "cta" }] },
      tokenBindings: {
        primary: { file: CSS_FILE, cssVar: "--primary" },
        ghost: { file: CSS_FILE, cssVar: "--ghost" }, // no matching color token
      },
    });
    const files = [{ path: CSS_FILE, text: ":root { --primary: 220 90% 50%; }" }];
    expect(auditTokensAgainstCss(doc, files).findings).toEqual([]);
  });
});

describe("auditTokensAgainstCss — heuristic fallback (no tokenBindings, low-confidence)", () => {
  it("guesses --<role> across every file and flags a mismatch as low-confidence", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "primary", value: "#FF4F00", usage: "cta" }] },
    });
    const files = [{ path: CSS_FILE, text: ":root { --primary: #000000; }" }];
    const report = auditTokensAgainstCss(doc, files);
    expect(report.findings).toEqual([
      { role: "primary", declared: "#FF4F00", found: "#000000", file: CSS_FILE, kind: "mismatch", confidence: "low" },
    ]);
  });

  it("reports nothing when the heuristic guess isn't present in any file (no false positive)", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "primary", value: "#FF4F00", usage: "cta" }] },
    });
    const files = [{ path: CSS_FILE, text: ":root { --unrelated: #000000; }" }];
    expect(auditTokensAgainstCss(doc, files).findings).toEqual([]);
  });

  it("reports nothing when the heuristic guess matches", () => {
    const doc = coerceStyleGuideDoc({
      color: { tokens: [{ role: "primary", value: "#FF4F00", usage: "cta" }] },
    });
    const files = [{ path: CSS_FILE, text: ":root { --primary: #FF4F00; }" }];
    expect(auditTokensAgainstCss(doc, files).findings).toEqual([]);
  });
});

describe("auditTokensAgainstCss — edge cases", () => {
  it("a guide with no color tokens and no bindings never throws, reports nothing", () => {
    const doc = coerceStyleGuideDoc(null);
    expect(() => auditTokensAgainstCss(doc, [])).not.toThrow();
    expect(auditTokensAgainstCss(doc, []).findings).toEqual([]);
  });

  it("is PURE — never reads fs; an empty files array is a legal input", () => {
    const doc = docWithBindings();
    expect(() => auditTokensAgainstCss(doc, [])).not.toThrow();
    expect(auditTokensAgainstCss(doc, []).findings.every((f) => f.kind === "unreadable")).toBe(true);
  });
});

describe("auditTokensAgainstCss — object-path bindings (tailwind/JS config, not only CSS vars)", () => {
  const TW = "packages/acme/web/tailwind.config.ts";
  function docWithConfigBinding() {
    return coerceStyleGuideDoc({
      color: { tokens: [{ role: "canvas", value: "#E8E6E0", usage: "bg" }] },
      tokenBindings: { canvas: { file: TW, cssVar: "colors.mosaico.bg" } },
    });
  }
  // A board whose tokens live in a Tailwind config, not CSS custom properties — the exact acme case.
  const CONFIG = `theme: { extend: { colors: { mosaico: { bg: "#E8E6E0", surface: "#FAF8F4" } } } }`;

  it("reads a `colors.x.y` object-path key out of a config (no CSS var) — no drift when equal", () => {
    const report = auditTokensAgainstCss(docWithConfigBinding(), [{ path: TW, text: CONFIG }]);
    expect(report.findings).toEqual([]);
  });

  it("flags a mismatch when the config key value differs from the declared token", () => {
    const report = auditTokensAgainstCss(docWithConfigBinding(), [{ path: TW, text: `colors: { mosaico: { bg: "#123456" } }` }]);
    expect(report.findings).toEqual([{ role: "canvas", declared: "#E8E6E0", found: "#123456", file: TW, kind: "mismatch" }]);
  });

  it("reports missing-var when the file READ but the key is absent — never 'unreadable'", () => {
    const report = auditTokensAgainstCss(docWithConfigBinding(), [{ path: TW, text: `colors: { other: { x: "#000000" } }` }]);
    expect(report.findings).toEqual([{ role: "canvas", declared: "#E8E6E0", file: TW, kind: "missing-var" }]);
  });
});
