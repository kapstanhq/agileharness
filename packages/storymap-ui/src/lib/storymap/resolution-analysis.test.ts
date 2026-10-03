// WS-10.5 (D14) — the render half of the semantic-resolution ladder. These tests pin the two things the
// operator's decision hangs on: (1) a hunk is NEVER labelled harmless unless the judge actually said so, and
// (2) the all-or-nothing rule is stated exactly when it applies (a mixed set) and never when it doesn't.

import { describe, expect, it } from "vitest";
import {
  ALL_OR_NOTHING_NOTE,
  classifyVerdict,
  formatAnalysisText,
  isAllOrNothing,
  summarizeAnalysis,
  verdictLabel,
  type AnalysisHunk,
} from "./resolution-analysis";

const hunk = (over: Partial<AnalysisHunk> = {}): AnalysisHunk => ({
  file: "packages/storymap-ui/src/a.ts",
  hunk: "- const a = 1\n+ const a = 2",
  verdict: "cosmetic",
  rationale: "só reordenou imports",
  ...over,
});

describe("classifyVerdict / verdictLabel", () => {
  it("reads the two verdicts the judge emits", () => {
    expect(classifyVerdict("cosmetic")).toBe("cosmetic");
    expect(classifyVerdict("substantive")).toBe("substantive");
    expect(verdictLabel("cosmetic")).toBe("cosmético");
    expect(verdictLabel("substantive")).toBe("SUBSTANTIVO");
  });

  // The persisted `verdict` is a plain string ("a RECORD, not a decision"). A value neither side knows must
  // NOT inherit the harmless label — that would invert invariant 6 (ANY doubt ⇒ substantive) on screen.
  it("never folds an unknown verdict into `cosmetic`", () => {
    expect(classifyVerdict("ambiguous")).toBe("unknown");
    expect(classifyVerdict("")).toBe("unknown");
    expect(verdictLabel("ambiguous")).toBe("ambiguous"); // shown verbatim, never claimed safe
    expect(verdictLabel("ambiguous")).not.toBe("cosmético");
  });
});

describe("isAllOrNothing", () => {
  it("is true ONLY for a mixed set — the one case that needs explaining", () => {
    expect(isAllOrNothing([hunk({ verdict: "cosmetic" }), hunk({ verdict: "substantive" })])).toBe(true);
  });

  it("is false when nothing was applicable anyway (all substantive) or nothing parked (all cosmetic)", () => {
    expect(isAllOrNothing([hunk({ verdict: "substantive" }), hunk({ verdict: "substantive" })])).toBe(false);
    expect(isAllOrNothing([hunk({ verdict: "cosmetic" })])).toBe(false);
    expect(isAllOrNothing([])).toBe(false);
  });

  it("does not treat an unknown verdict as the cosmetic half of a mixed set", () => {
    expect(isAllOrNothing([hunk({ verdict: "ambiguous" }), hunk({ verdict: "substantive" })])).toBe(false);
  });
});

describe("summarizeAnalysis", () => {
  const analysis = {
    detail: "juiz achou 1 hunk substantivo",
    outcome: "escalated-substantive",
    hunks: [
      hunk({ file: "a.ts", verdict: "cosmetic", rationale: "comentário" }),
      hunk({ file: "b.ts", verdict: "substantive", rationale: "muda o contrato" }),
      hunk({ file: "a.ts", verdict: "cosmetic", rationale: "import order" }),
    ],
  };

  it("counts by verdict and carries the rung's own words through", () => {
    const s = summarizeAnalysis(analysis);
    expect(s.total).toBe(3);
    expect(s.substantive).toBe(1);
    expect(s.cosmetic).toBe(2);
    expect(s.unknown).toBe(0);
    expect(s.detail).toBe("juiz achou 1 hunk substantivo");
    expect(s.outcome).toBe("escalated-substantive");
    expect(s.allOrNothing).toBe(true);
  });

  it("sorts substantive first — the operator's first question is 'which one is mine to decide?'", () => {
    const s = summarizeAnalysis(analysis);
    expect(s.hunks.map((h) => h.verdict)).toEqual(["substantive", "cosmetic", "cosmetic"]);
    expect(s.hunks[0].label).toBe("SUBSTANTIVO");
  });

  it("ranks unknown between substantive and cosmetic, keeping judge order within a rank", () => {
    const s = summarizeAnalysis({
      detail: "d",
      outcome: "escalated-substantive",
      hunks: [
        hunk({ file: "1.ts", verdict: "cosmetic" }),
        hunk({ file: "2.ts", verdict: "weird" }),
        hunk({ file: "3.ts", verdict: "substantive" }),
        hunk({ file: "4.ts", verdict: "cosmetic" }),
      ],
    });
    expect(s.hunks.map((h) => h.file)).toEqual(["3.ts", "2.ts", "1.ts", "4.ts"]);
    expect(s.unknown).toBe(1);
  });

  it("names the blast radius: unique files in first-appearance order", () => {
    expect(summarizeAnalysis(analysis).files).toEqual(["a.ts", "b.ts"]);
  });

  it("survives an empty hunk list (judge-failed persists an analysis with no verdicts)", () => {
    const s = summarizeAnalysis({ detail: "juiz falhou", outcome: "judge-failed", hunks: [] });
    expect(s.total).toBe(0);
    expect(s.allOrNothing).toBe(false);
    expect(s.files).toEqual([]);
    expect(s.hunks).toEqual([]);
  });
});

describe("formatAnalysisText", () => {
  // Byte-identical to what runner/entry-effects.ts formatAnalysis has always produced — it now delegates here.
  it("renders verdict-first lines and appends the all-or-nothing note on a mixed set", () => {
    const text = formatAnalysisText({
      detail: "1 substantivo de 2",
      hunks: [hunk({ file: "a.ts", verdict: "cosmetic", rationale: "comentário" }), hunk({ file: "b.ts", verdict: "substantive", rationale: "muda o contrato" })],
    });
    expect(text).toBe(
      [
        "Análise da divergência (1 substantivo de 2):",
        "  • [cosmético] a.ts — comentário",
        "  • [SUBSTANTIVO] b.ts — muda o contrato",
        `  (${ALL_OR_NOTHING_NOTE})`,
      ].join("\n"),
    );
  });

  it("omits the note when no cosmetic hunk was sacrificed", () => {
    const text = formatAnalysisText({
      detail: "tudo substantivo",
      hunks: [hunk({ file: "b.ts", verdict: "substantive", rationale: "muda o contrato" })],
    });
    expect(text).not.toContain(ALL_OR_NOTHING_NOTE);
    expect(text).toBe(["Análise da divergência (tudo substantivo):", "  • [SUBSTANTIVO] b.ts — muda o contrato"].join("\n"));
  });
});
