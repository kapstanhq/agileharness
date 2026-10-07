import { describe, expect, it } from "vitest";
import {
  MAXTURNS_LEAN_BASELINE,
  MECHANICAL_PROFILE_ID,
  cardSizeScore,
  deriveCardModelEffort,
  deriveCardMaxTurns,
} from "./model-routing";

// The four routing rules (complexity → model/effort), numbered AC1..AC4 below. The column pair is the
// DEFAULT (when the card carries no complexity signal) and the TETO (the routing never
// elevates past it). `desenvolver` ships opus/high, so we use it as the canonical column.
describe("deriveCardModelEffort — route (model, effort) by card complexity", () => {
  it("AC1: a chore with no tasks forces sonnet/medium, ignoring the column default (opus/high)", () => {
    expect(deriveCardModelEffort({ storyType: "chore", taskCount: 0, severity: null }, "opus", "high")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("AC1: a chore is forced DOWN even when it is big (chore wins over the size branch)", () => {
    expect(deriveCardModelEffort({ storyType: "chore", taskCount: 9, severity: null }, "opus", "high")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("AC2: >= 10 tasks elevates to opus/high (within the column ceiling)", () => {
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 10, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC2: the size branch does NOT trigger below the task bar (a sonnet column stays sonnet)", () => {
    // 9 tasks — under the bar → the column pair verbatim, even when the column could go higher
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 9, severity: null }, "sonnet", "medium")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  // A régua de tamanho perdeu o esforço do RICE junto com a priorização. Quase nenhum card o tinha, então o ramo de
  // elevar NUNCA disparava: um card típico (5 tarefas) ficava no par da coluna. O limiar de 10 tarefas mantém esse
  // comportamento efetivo — baixar o limiar elevaria o orçamento de quase todo card planejado sem ninguém decidir.
  it("um card típico de 5 tarefas continua no par da coluna (não sobe para opus/high)", () => {
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 5, severity: null }, "opus", "medium")).toEqual({
      model: "opus",
      effort: "medium",
    });
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 5, severity: null }, "sonnet", "medium")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("AC3: a sonnet column ceiling caps a derived opus back down to sonnet", () => {
    expect(deriveCardModelEffort({ storyType: "technical", taskCount: 10, severity: null }, "sonnet", "high")).toEqual({
      model: "sonnet",
      effort: "high",
    });
  });

  it("AC3: the ceiling also caps the chore floor's EFFORT when the column asks for less than medium", () => {
    // Haiku is not offered, so `sonnet` is the lowest tier and no cap can pull a chore below the model
    // floor any more: the column's effort ceiling is what can still sit under the floor.
    expect(deriveCardModelEffort({ storyType: "chore", taskCount: 0, severity: null }, "sonnet", "low")).toEqual({
      model: "sonnet",
      effort: "low",
    });
  });

  it("AC4: a card with no explicit complexity signal returns the column default unchanged", () => {
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 2, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC4: an undefined column pair (no ceiling) lets the derived candidate pass through", () => {
    // chore floor with no ceiling → sonnet/medium straight through
    expect(deriveCardModelEffort({ storyType: "chore", taskCount: 0, severity: null }, undefined, undefined)).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    // size branch with no ceiling → opus/high straight through
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 10, severity: null }, undefined, undefined)).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("AC4: a no-signal card with an undefined column pair returns undefined/undefined (CLI default)", () => {
    expect(deriveCardModelEffort({ storyType: null, taskCount: 0, severity: null }, undefined, undefined)).toEqual({
      model: undefined,
      effort: undefined,
    });
  });

  it("the size comes from the task count alone — a card with no tasks never elevates", () => {
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 0, severity: null }, "opus", "medium")).toEqual({
      model: "opus",
      effort: "medium",
    });
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 8, severity: null }, "opus", "high")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  // ── WS4 — per-card route caps (teto-sob-teto) ────────────────────────────────────────────────
  it("WS4: a modelCap sonnet caps an opus column even on the size-elevation branch", () => {
    // a big card that WOULD earn opus is held to sonnet by the express route cap (without skipping the step).
    expect(
      deriveCardModelEffort({ storyType: "user", taskCount: 12, severity: null }, "opus", "high", "sonnet", "medium"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: a modelCap applies to the FALLTHROUGH branch too (a capped card with no signal routes at the cap)", () => {
    // no complexity signal → branch 3 would return the column pair (opus/high); the cap tightens it.
    expect(
      deriveCardModelEffort({ storyType: "user", taskCount: 1, severity: null }, "opus", "high", "sonnet", "medium"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: the cap is teto-sob-teto — the LOWER of column and cap wins (a higher cap never elevates)", () => {
    // column already sonnet, cap opus → stays sonnet (cap can only lower, never raise).
    expect(
      deriveCardModelEffort({ storyType: "user", taskCount: 1, severity: null }, "sonnet", "medium", "opus", "high"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: undefined caps preserve the prior behaviour exactly (no regression)", () => {
    expect(
      deriveCardModelEffort({ storyType: "user", taskCount: 5, severity: null }, "opus", "high", undefined, undefined),
    ).toEqual({ model: "opus", effort: "high" });
  });

  it("WS4: a cap on an undefined column becomes the effective ceiling (CLI-default column, capped)", () => {
    // column pair undefined (no per-column model) + cap sonnet → the cap is the effective model.
    expect(
      deriveCardModelEffort({ storyType: "user", taskCount: 1, severity: null }, undefined, undefined, "sonnet", "medium"),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("WS4: a chore under a sonnet/low card cap stays at the sonnet floor with the capped effort (cap wins over the chore floor)", () => {
    expect(
      deriveCardModelEffort({ storyType: "chore", taskCount: 0, severity: null }, "opus", "high", "sonnet", "low"),
    ).toEqual({ model: "sonnet", effort: "low" });
  });
});

// story-ex0050 HALF A: the column's maxTurns is the CEILING; a per-card effective value scales within
// [lean baseline, ceiling] from the task count. The `storymap desenvolver` column ships maxTurns
// 220 (the empirical ceiling a big card like ex0146 needs) — used here as the canonical big ceiling.
const AGILEHARNESS_DESENVOLVER_CEILING = 220;

describe("cardSizeScore — size proxy in [0,1] from the task count", () => {
  it("a small card (≤2 tasks) scores low; no tasks scores 0; a typical 5-task card sits mid-band", () => {
    expect(cardSizeScore({ taskCount: 2 })).toBeCloseTo(2 / 10, 5);
    expect(cardSizeScore({ taskCount: 5 })).toBeCloseTo(0.5, 5); // o máximo efetivo de antes (sem esforço RICE)
    expect(cardSizeScore({ taskCount: 0 })).toBe(0);
  });

  it("a big card (≥10 tasks) tops out at 1", () => {
    expect(cardSizeScore({ taskCount: 10 })).toBe(1);
    expect(cardSizeScore({ taskCount: 19 })).toBe(1); // clamps past the bar
  });
});

describe("deriveCardMaxTurns — scale per-card --max-turns within [baseline, column ceiling]", () => {
  it("AC1 big-gets-more: a BIG card (≥10 tasks) reaches the column ceiling (~220), NOT re-capped to 120", () => {
    // The exact card this story fixes (ex0146 blew 120 mid-build). With the 220 ceiling kept as the
    // board.yaml override, a big card scores 1 → the full ceiling.
    expect(deriveCardMaxTurns({ taskCount: 10 }, AGILEHARNESS_DESENVOLVER_CEILING)).toBe(220);
    // Crucially it stays WELL above the _base 120 default → a big card is never re-capped below what it needs.
    expect(deriveCardMaxTurns({ taskCount: 10 }, AGILEHARNESS_DESENVOLVER_CEILING)).toBeGreaterThan(120);
    // A typical 5-task card keeps the effective budget it had (score 0.5 → mid-band), not the ceiling.
    expect(deriveCardMaxTurns({ taskCount: 5 }, AGILEHARNESS_DESENVOLVER_CEILING)).toBe(130);
  });

  it("AC2 small-stays-lean: a SMALL card (≤2 tasks) gets a lean value near the baseline, far under the ceiling", () => {
    const small = deriveCardMaxTurns({ taskCount: 2 }, AGILEHARNESS_DESENVOLVER_CEILING);
    expect(small).toBeGreaterThanOrEqual(MAXTURNS_LEAN_BASELINE); // never below the floor
    expect(small).toBeLessThan(120); // a small card never burns the big-card budget
    // A 0-signal card sits exactly at the lean baseline.
    expect(deriveCardMaxTurns({ taskCount: 0 }, AGILEHARNESS_DESENVOLVER_CEILING)).toBe(MAXTURNS_LEAN_BASELINE);
  });

  it("clamp-to-ceiling: the result NEVER exceeds the column ceiling, even for an oversized card", () => {
    const maxed = deriveCardMaxTurns({ taskCount: 99 }, 120);
    expect(maxed).toBe(120); // score 1 → exactly the ceiling, never over
    expect(maxed).toBeLessThanOrEqual(120);
  });

  it("a mid-size card lands strictly between the baseline and the ceiling (monotonic interpolation)", () => {
    const mid = deriveCardMaxTurns({ taskCount: 3 }, AGILEHARNESS_DESENVOLVER_CEILING)!;
    const small = deriveCardMaxTurns({ taskCount: 1 }, AGILEHARNESS_DESENVOLVER_CEILING)!;
    const big = deriveCardMaxTurns({ taskCount: 10 }, AGILEHARNESS_DESENVOLVER_CEILING)!;
    expect(mid).toBeGreaterThan(small);
    expect(mid).toBeLessThan(big);
  });

  it("an undefined / non-positive ceiling → undefined (no flag, CLI default) — never invents a value", () => {
    expect(deriveCardMaxTurns({ taskCount: 6 }, undefined)).toBeUndefined();
    expect(deriveCardMaxTurns({ taskCount: 6 }, 0)).toBeUndefined();
    expect(deriveCardMaxTurns({ taskCount: 6 }, -5)).toBeUndefined();
    expect(deriveCardMaxTurns({ taskCount: 6 }, Number.NaN)).toBeUndefined();
  });

  it("a degenerate ceiling BELOW the baseline collapses the band to the ceiling (never overshoots it)", () => {
    // ceiling 10 < baseline 40 → even a big card is clamped to 10, never the baseline.
    expect(deriveCardMaxTurns({ taskCount: 6 }, 10)).toBe(10);
    expect(deriveCardMaxTurns({ taskCount: 0 }, 10)).toBe(10);
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
        { storyType: "technical", taskCount: 0, severity: null },
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
        { storyType: "user", taskCount: 9, severity: null },
        "opus",
        "high",
        MECHANICAL_CAPS.modelCap,
        MECHANICAL_CAPS.effortCap,
      ),
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("§7.2 lean turns come FREE from the size baseline — the profile needs no maxTurns knob (no schema change)", () => {
    // A mechanical spawn is size-neutral (no task breakdown) → score 0 → the lean
    // baseline (40), on any column ceiling. THIS is why `mechanical` carries no maxTurns in board.yaml.
    expect(deriveCardMaxTurns({ taskCount: 0 }, AGILEHARNESS_DESENVOLVER_CEILING)).toBe(MAXTURNS_LEAN_BASELINE);
    expect(deriveCardMaxTurns({ taskCount: 0 }, 120)).toBe(MAXTURNS_LEAN_BASELINE);
  });

  it("§7.2 the lean budget is a property of the SIGNALS, not of the caps (the WS-10 spawn must pass neutral ones)", () => {
    // Documents the sharp edge called out on MECHANICAL_PROFILE_ID: caps bound model/effort, NOT turns.
    // Spawn a resolution with the CONFLICTED CARD's own signals and the size branch scales the budget back
    // up to the ceiling — capped at sonnet, but with a 220-turn leash. A resolution is not the card's build.
    expect(deriveCardMaxTurns({ taskCount: 12 }, AGILEHARNESS_DESENVOLVER_CEILING)).toBe(220);
  });

  it("§7.1 implementer/complex: the row is 'the column CEILING', not 'opus' — _base ships desenvolver sonnet/high", () => {
    // The fine print in the table: on the base pipeline a complex card tops out at SONNET/high. Opus for an
    // implementer only happens on a board that declares an opus column (e.g. a board whose desenvolver column is opus/max).
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 10, severity: null }, "sonnet", "high")).toEqual({
      model: "sonnet",
      effort: "high",
    });
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 10, severity: null }, "opus", "max")).toEqual({
      model: "opus",
      effort: "high", // the size branch asks for `high`; the ceiling (max) grants it without raising it
    });
  });

  it("§7.1 implementer/chore + light lane: the sonnet/medium rows are the SAME derivation, not two rules", () => {
    // chore floor on a heavy column…
    expect(deriveCardModelEffort({ storyType: "chore", taskCount: 0, severity: null }, "opus", "high")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    // …and the light lane (enriquecer/qa-automatizado ship sonnet/medium) is just the column pair
    // falling through — no per-skill mapping anywhere (D10: the tier is readable from config alone).
    expect(deriveCardModelEffort({ storyType: "user", taskCount: 2, severity: null }, "sonnet", "medium")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });
});
