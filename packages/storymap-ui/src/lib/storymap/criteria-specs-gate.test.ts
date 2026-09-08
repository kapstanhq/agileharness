import { describe, it, expect } from "vitest";
import { GATES } from "./gate-core";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";

// ADR-063 (2c) — the shift-left spec gate. THE release-blocking invariant: it must be
// DEFAULT-SATISFIED on absent/empty data so it can NEVER fail-closed on a legacy card and freeze the
// merge train (the documented storymap-merge-gate-fail-closed footgun).
const okWith = (data: Record<string, any>) =>
  GATES.hasCriteriaSpecs.ok(coerceCard("t", { type: "story", storyType: "user", ...data }, ""));

describe("ADR-063 (2c) hasCriteriaSpecs — default-satisfied, never freezes legacy", () => {
  it("SATISFIED when criteriaSpecs is absent (zero-migration — a legacy card never freezes)", () => {
    expect(okWith({})).toBe(true);
  });

  it("SATISFIED when criteriaSpecs is empty", () => {
    expect(okWith({ criteriaSpecs: [] })).toBe(true);
  });

  it("SATISFIED for a UI-less card even with an incomplete spec map (hasUiSurface:false)", () => {
    expect(
      GATES.hasCriteriaSpecs.ok(
        coerceCard("t", { type: "story", storyType: "user", hasUiSurface: false, criteriaSpecs: [{ criterion: "x" }] }, ""),
      ),
    ).toBe(true);
  });

  it("SATISFIED when every declared criterion carries a specPath", () => {
    expect(okWith({ criteriaSpecs: [{ criterion: "nav aparece", specPath: "tests/e2e/nav.spec.ts" }] })).toBe(true);
  });

  it("BLOCKS a UI card that DECLARED a criterion without a specPath (routes back, not re-authored)", () => {
    expect(
      okWith({
        criteriaSpecs: [
          { criterion: "nav aparece", specPath: "tests/e2e/nav.spec.ts" },
          { criterion: "botão salva" },
        ],
      }),
    ).toBe(false);
  });

  it("parity-safe: never throws on RAW malformed input (the pre-write hook path)", () => {
    expect(() =>
      GATES.hasCriteriaSpecs.ok({ type: "story", storyType: "user", criteriaSpecs: [null, { specPath: 123 }, "junk"] } as any),
    ).not.toThrow();
    // a non-string specPath counts as missing → present-but-incomplete → blocks
    expect(
      GATES.hasCriteriaSpecs.ok({ type: "story", storyType: "user", criteriaSpecs: [{ criterion: "x", specPath: 123 }] } as any),
    ).toBe(false);
  });
});

describe("ADR-063 (2c/4d) round-trip — criteriaSpecs + finding.failureClass survive serialize→coerce", () => {
  it("criteriaSpecs round-trips through cardToFrontmatter → coerceCard (else the gate never sees it)", () => {
    const card = coerceCard(
      "t",
      {
        type: "story",
        storyType: "user",
        criteriaSpecs: [
          { criterion: "nav aparece em /account", specPath: "tests/e2e/nav.spec.ts" },
          { criterion: "sem spec ainda" },
        ],
      },
      "",
    );
    const round = coerceCard("t", cardToFrontmatter(card) as any, "");
    expect(round.criteriaSpecs).toEqual([
      { criterion: "nav aparece em /account", specPath: "tests/e2e/nav.spec.ts" },
      { criterion: "sem spec ainda" },
    ]);
  });

  it("finding.failureClass round-trips through cardToFrontmatter → coerceCard", () => {
    const card = coerceCard(
      "t",
      {
        type: "story",
        storyType: "user",
        findings: [{ id: "f1", lens: "testing", severity: "blocker", title: "stack não sobe", status: "open", failureClass: "infra" }],
      },
      "",
    );
    const round = coerceCard("t", cardToFrontmatter(card) as any, "");
    expect(round.findings[0].failureClass).toBe("infra");
  });

  it("drops a malformed failureClass on read (stays sparse)", () => {
    const card = coerceCard(
      "t",
      { type: "story", findings: [{ id: "f1", lens: "testing", severity: "blocker", title: "x", status: "open", failureClass: "bogus" }] },
      "",
    );
    expect(card.findings[0].failureClass).toBeUndefined();
  });
});
