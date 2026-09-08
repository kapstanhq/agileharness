import { describe, expect, it } from "vitest";
import {
  MAXTURNS_LEAN_BASELINE,
  MECHANICAL_PROFILE_ID,
  cardSizeScore,
  deriveCardModelEffort,
  deriveCardMaxTurns,
} from "./model-routing";

// The four ACs of story-rotear-model-effort-por-complexidade. The column pair is the
// DEFAULT (when the card carries no complexity signal) and the TETO (the routing never
// elevates past it). `desenvolver` ships opus/high, so we use it as the canonical column.
describe("deriveCardModelEffort — route (model, effort) by card complexity", () => {
  it("AC1: a chore with no tasks forces sonnet/medium, ignoring the column default (opus/high)", () => {
    expect(deriveCardModelEffort({ storyType: "chore", riceEffort: null, taskCount: 0, severity: null }, "opus", "high")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("AC1: a chore is forced DOWN even when its RICE effort is high (chore wins over the size branch)", () => {
    expect(deriveCardModelEffort({ storyType: "chore", riceEffort: 8, taskCount: 9, severity: null }, "opus", "high")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("AC2: riceEffort >= 3 AND >= 5 tasks elevates to opus/high (within the column ceiling)", () => {
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 3, taskCount: 5, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC2: the size branch does NOT trigger when only one of the two thresholds is met", () => {
    // riceEffort high but too few tasks → fallback to column default
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 5, taskCount: 2, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
    // many tasks but riceEffort below the bar → fallback to column default
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 1, taskCount: 9, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC3: a sonnet column ceiling caps a derived opus back down to sonnet", () => {
    expect(deriveCardModelEffort({ storyType: "technical", riceEffort: 3, taskCount: 5, severity: null }, "sonnet", "high")).toEqual({
      model: "sonnet",
      effort: "high",
    });
  });

  it("AC3: the ceiling also caps the chore floor when the column is below sonnet (haiku)", () => {
    expect(deriveCardModelEffort({ storyType: "chore", riceEffort: null, taskCount: 0, severity: null }, "haiku", "low")).toEqual({
      model: "haiku",
      effort: "low",
    });
  });

  it("AC4: a card with no explicit complexity signal returns the column default unchanged", () => {
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 1, taskCount: 2, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC4: an undefined column pair (no ceiling) lets the derived candidate pass through", () => {
    // chore floor with no ceiling → sonnet/medium straight through
    expect(deriveCardModelEffort({ storyType: "chore", riceEffort: null, taskCount: 0, severity: null }, undefined, undefined)).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    // size branch with no ceiling → opus/high straight through
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 3, taskCount: 5, severity: null }, undefined, undefined)).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC4: a no-signal card with an undefined column pair returns undefined/undefined (CLI default)", () => {
    expect(deriveCardModelEffort({ storyType: null, riceEffort: null, taskCount: 0, severity: null }, undefined, undefined)).toEqual({
      model: undefined,
      effort: undefined,
    });
  });

  it("treats a missing riceEffort as 0 — the size branch never fires without an estimate", () => {
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: undefined, taskCount: 8, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  // ── WS4 — per-card route caps (teto-sob-teto) ────────────────────────────────────────────────
  it("WS4: a modelCap sonnet caps an opus column even on the size-elevation branch", () => {
    // a big card that WOULD earn opus is held to sonnet by the express route cap (without skipping the step).
    expect(
      deriveCardModelEffort({ storyType: "user", riceEffort: 5, taskCount: 8, severity: null }, "opus", "high", "sonnet", "medium"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: a modelCap applies to the FALLTHROUGH branch too (a capped card with no signal routes at the cap)", () => {
    // no complexity signal → branch 3 would return the column pair (opus/high); the cap tightens it.
    expect(
      deriveCardModelEffort({ storyType: "user", riceEffort: 1, taskCount: 1, severity: null }, "opus", "high", "sonnet", "medium"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: the cap is teto-sob-teto — the LOWER of column and cap wins (a higher cap never elevates)", () => {
    // column already sonnet, cap opus → stays sonnet (cap can only lower, never raise).
    expect(
      deriveCardModelEffort({ storyType: "user", riceEffort: 1, taskCount: 1, severity: null }, "sonnet", "medium", "opus", "high"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: undefined caps preserve the prior behaviour exactly (no regression)", () => {
    expect(
      deriveCardModelEffort({ storyType: "user", riceEffort: 3, taskCount: 5, severity: null }, "opus", "high", undefined, undefined),
    ).toEqual({ model: "opus", effort: "high" });
  });

  it("WS4: a cap on an undefined column becomes the effective ceiling (CLI-default column, capped)", () => {
    // column pair undefined (no per-column model) + cap sonnet → the cap is the effective model.
    expect(
      deriveCardModelEffort({ storyType: "user", riceEffort: 1, taskCount: 1, severity: null }, undefined, undefined, "sonnet", "medium"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: a chore under a haiku cap is pulled below the sonnet floor (cap wins over the chore floor)", () => {
    expect(
      deriveCardModelEffort({ storyType: "chore", riceEffort: null, taskCount: 0, severity: null }, "opus", "high", "haiku", "low"),
    ).toEqual({ model: "haiku", effort: "low" });
  });
});

// story-9s52tu HALF A: the column's maxTurns is the CEILING; a per-card effective value scales within
// [lean baseline, ceiling] from effort + task count. The `storymap desenvolver` column ships maxTurns
// 220 (the empirical ceiling a big card like w9n03r needs) — used here as the canonical big ceiling.
const STORYMAP_DESENVOLVER_CEILING = 220;

describe("cardSizeScore — size proxy in [0,1] from effort + task count", () => {
  it("a small card (no effort, ≤2 tasks) scores near 0", () => {
    expect(cardSizeScore({ riceEffort: 1, taskCount: 2 })).toBeCloseTo((1 / 3 + 2 / 5) / 2, 5);
    expect(cardSizeScore({ riceEffort: null, taskCount: 0 })).toBe(0);
  });

  it("a big card (effort ≥3 AND ≥5 tasks) tops out at 1 (both axes saturated)", () => {
    expect(cardSizeScore({ riceEffort: 3, taskCount: 5 })).toBe(1);
    expect(cardSizeScore({ riceEffort: 8, taskCount: 9 })).toBe(1); // clamps past the bar
  });

  it("a card big on ONLY one axis lands mid-range, never the top (mirrors the AND in the size branch)", () => {
    expect(cardSizeScore({ riceEffort: 3, taskCount: 0 })).toBe(0.5); // effort maxed, no tasks
    expect(cardSizeScore({ riceEffort: 0, taskCount: 5 })).toBe(0.5); // tasks maxed, no effort
  });
});

describe("deriveCardMaxTurns — scale per-card --max-turns within [baseline, column ceiling]", () => {
  it("AC1 big-gets-more: a BIG card (effort 3, ~6 tasks) reaches the column ceiling (~220), NOT re-capped to 120", () => {
    // The exact card this story fixes (w9n03r blew 120 mid-build). With the 220 ceiling kept as the
    // board.yaml override, a big card scores 1 → the full ceiling.
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, STORYMAP_DESENVOLVER_CEILING)).toBe(220);
    // Crucially it stays WELL above the _base 120 default → a big card is never re-capped below what it needs.
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, STORYMAP_DESENVOLVER_CEILING)).toBeGreaterThan(120);
  });

  it("AC2 small-stays-lean: a SMALL card (effort 1, ≤2 tasks) gets a lean value near the baseline, far under the ceiling", () => {
    const small = deriveCardMaxTurns({ riceEffort: 1, taskCount: 2 }, STORYMAP_DESENVOLVER_CEILING);
    expect(small).toBeGreaterThanOrEqual(MAXTURNS_LEAN_BASELINE); // never below the floor
    expect(small).toBeLessThan(120); // a small card never burns the big-card budget
    // A 0-signal card sits exactly at the lean baseline.
    expect(deriveCardMaxTurns({ riceEffort: null, taskCount: 0 }, STORYMAP_DESENVOLVER_CEILING)).toBe(MAXTURNS_LEAN_BASELINE);
  });

  it("clamp-to-ceiling: the result NEVER exceeds the column ceiling, even for an oversized card", () => {
    const maxed = deriveCardMaxTurns({ riceEffort: 99, taskCount: 99 }, 120);
    expect(maxed).toBe(120); // score 1 → exactly the ceiling, never over
    expect(maxed).toBeLessThanOrEqual(120);
  });

  it("a mid-size card lands strictly between the baseline and the ceiling (monotonic interpolation)", () => {
    const mid = deriveCardMaxTurns({ riceEffort: 2, taskCount: 3 }, STORYMAP_DESENVOLVER_CEILING)!;
    const small = deriveCardMaxTurns({ riceEffort: 1, taskCount: 1 }, STORYMAP_DESENVOLVER_CEILING)!;
    const big = deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, STORYMAP_DESENVOLVER_CEILING)!;
    expect(mid).toBeGreaterThan(small);
    expect(mid).toBeLessThan(big);
  });

  it("an undefined / non-positive ceiling → undefined (no flag, CLI default) — never invents a value", () => {
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, undefined)).toBeUndefined();
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, 0)).toBeUndefined();
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, -5)).toBeUndefined();
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, Number.NaN)).toBeUndefined();
  });

  it("a degenerate ceiling BELOW the baseline collapses the band to the ceiling (never overshoots it)", () => {
    // ceiling 10 < baseline 40 → even a big card is clamped to 10, never the baseline.
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, 10)).toBe(10);
    expect(deriveCardMaxTurns({ riceEffort: null, taskCount: 0 }, 10)).toBe(10);
  });
});

// ── WS-7 §7.1/§7.2 — the ROLE × MODEL table ──────────────────────────────────────────────────────
// The table itself lives in ONE place: the doc-comment at the head of model-routing.ts (AC3). These tests
// are its EXECUTABLE half — each pins a row against the derivation, so the doc can't quietly drift from
// the code it claims to describe. The `mechanical` profile's CAPS live in _base/board.yaml (door 2) and
// reach here as the cardModelCap/cardEffortCap arguments — exactly the path `express` already takes; the
// profile is config, not a code branch (D10: no 4th door).
describe("WS-7 — role × model (the canonical table's executable half)", () => {
  // The `mechanical` profile as _base declares it: caps only, no skips.
  const MECHANICAL_CAPS = { modelCap: "sonnet", effortCap: "medium" } as const;

  it("the profile id is the one _base declares (the typed anchor WS-10 spawns through)", () => {
    expect(MECHANICAL_PROFILE_ID).toBe("mechanical");
  });

  it("§7.2 resolution role: the mechanical caps hold on an opus/high column (a judge never buys opus)", () => {
    expect(
      deriveCardModelEffort(
        { storyType: "technical", riceEffort: null, taskCount: 0, severity: null },
        "opus",
        "high",
        MECHANICAL_CAPS.modelCap,
        MECHANICAL_CAPS.effortCap,
      ),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("§7.2 the caps hold even on the SIZE-ELEVATION branch — a big conflicted card is still mechanical work", () => {
    // The size branch WOULD elevate to opus/high; the route cap is teto-sob-teto, so the resolution of a
    // big card stays sonnet/medium. This is the row that makes D14's ladder affordable: trying the judge
    // before the human can never cost opus, however large the card that conflicted.
    expect(
      deriveCardModelEffort(
        { storyType: "user", riceEffort: 8, taskCount: 9, severity: null },
        "opus",
        "high",
        MECHANICAL_CAPS.modelCap,
        MECHANICAL_CAPS.effortCap,
      ),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("§7.2 lean turns come FREE from the size baseline — the profile needs no maxTurns knob (no schema change)", () => {
    // A mechanical spawn is size-neutral (no RICE estimate, no task breakdown) → score 0 → the lean
    // baseline (40), on any column ceiling. THIS is why `mechanical` carries no maxTurns in board.yaml.
    expect(deriveCardMaxTurns({ riceEffort: null, taskCount: 0 }, STORYMAP_DESENVOLVER_CEILING)).toBe(MAXTURNS_LEAN_BASELINE);
    expect(deriveCardMaxTurns({ riceEffort: null, taskCount: 0 }, 120)).toBe(MAXTURNS_LEAN_BASELINE);
  });

  it("§7.2 the lean budget is a property of the SIGNALS, not of the caps (the WS-10 spawn must pass neutral ones)", () => {
    // Documents the sharp edge called out on MECHANICAL_PROFILE_ID: caps bound model/effort, NOT turns.
    // Spawn a resolution with the CONFLICTED CARD's own signals and the size branch scales the budget back
    // up to the ceiling — capped at sonnet, but with a 220-turn leash. A resolution is not the card's build.
    expect(deriveCardMaxTurns({ riceEffort: 3, taskCount: 6 }, STORYMAP_DESENVOLVER_CEILING)).toBe(220);
  });

  it("§7.1 implementer/complex: the row is 'the column CEILING', not 'opus' — _base ships desenvolver sonnet/high", () => {
    // The fine print in the table: on the base pipeline a complex card tops out at SONNET/high. Opus for an
    // implementer only happens on a board that declares an opus column (orbit: desenvolver opus/max).
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 3, taskCount: 5, severity: null }, "sonnet", "high")).toEqual({
      model: "sonnet",
      effort: "high",
    });
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 3, taskCount: 5, severity: null }, "opus", "max")).toEqual({
      model: "opus",
      effort: "high", // the size branch asks for `high`; the ceiling (max) grants it without raising it
    });
  });

  it("§7.1 implementer/chore + light lane: the sonnet/medium rows are the SAME derivation, not two rules", () => {
    // chore floor on a heavy column…
    expect(deriveCardModelEffort({ storyType: "chore", riceEffort: null, taskCount: 0, severity: null }, "opus", "high")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    // …and the light lane (enriquecer/priorizar/qa-automatizado ship sonnet/medium) is just the column pair
    // falling through — no per-skill mapping anywhere (D10: the tier is readable from config alone).
    expect(deriveCardModelEffort({ storyType: "user", riceEffort: 1, taskCount: 2, severity: null }, "sonnet", "medium")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });
});
