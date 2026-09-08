// Card-aware model routing — derive the (model, effort) pair a run spawns with from the
// COMPLEXITY of the card, not just the column it sits in. The column's policy (StatusDef
// model/effort, falling back to the global columnDefaults) is the DEFAULT (used verbatim
// when the card carries no complexity signal) AND the TETO (the routing never elevates past
// it — only reduces, or stays). This keeps Opus for genuinely complex changes and lets Sonnet
// cover chores and trivial typos, cutting token cost without starving hard work of reasoning.
//
// Pure + isomorphic-safe (types only) — trivially unit-testable, no I/O. config.ts feeds it
// the card signals + the resolved column pair; the engine wires the spawn flags from the result.
//
// ── ROLE × MODEL — THE CANONICAL TABLE (WS-7 §7.1 · decision D10) ─────────────────────────────────
//
// The SINGLE SOURCE for "which (model, effort) does each ROLE get, and WHO decides it". It MAPS the
// mechanisms that already exist — it is NOT a new axis. Every row is realized by one of the THREE
// declarative doors below; a FOURTH (a skill→model map hardcoded in the runner) is forbidden, because
// the effective tier must stay predictable by reading config alone (AgileHarness D9/WS9, D10):
//
//   door 1 — the COLUMN policy: board.yaml `StatusDef.model/effort/maxTurns`, falling back to
//            settings.yaml `columnDefaults` (sonnet/medium). It is the DEFAULT *and* the CEILING.
//   door 2 — the per-CARD route: `card.routing.modelCap/effortCap`, materialized onto the card from a
//            named `routeProfiles` entry (_base/board.yaml). CEILING only (teto-sob-teto).
//   door 3 — the derivation BELOW (chore floor · size elevation · maxTurns scaling), from the card's
//            own complexity signals.
//
// | Role / task                                        | Model                 | Effort  | Decided by             |
// |----------------------------------------------------|-----------------------|---------|------------------------|
// | Implementer — complex card (RICE≥3 AND ≥5 tasks)    | elevated, ≤ column*   | high*   | door 3 (branch 2)      |
// | Implementer — ordinary card                         | the column pair       | column  | door 3 (branch 3)      |
// | Implementer — chore / mechanical work               | sonnet*               | medium* | door 3 (branch 1)      |
// | Conflict resolution / semantic judge (WS-10)        | sonnet                | medium  | door 2 (`mechanical`)  |
// | Triage / enrich / prioritize (light lane)           | sonnet                | medium  | door 1 (_base columns) |
// | QA runner (ADR-063: thin — decides + reads)         | sonnet                | medium  | door 1 (qa-automatizado)|
// | Review CONSOLIDATION (the harness-review run itself)    | the column (opus)     | high    | door 1 (revisar-codigo)|
// | Agent session `implement` (WS-6 spawn)              | the card's own rule   | idem    | door 3 (resolveCardArgs)|
// | Agent session `free` (open-ended self-dev)          | opus                  | high    | the WS-6 spawn's args  |
// | Copilot chat / tick steward                         | opus[1m]              | high    | settings knob          |
// | Review LENSES (specialist sub-agents)               | the agent definition  | —       | ⚠ NOT a storymap door  |
//
// * always CAPPED (never elevated) by doors 1+2 — see capModel/capEffort.
//
// The fine print (verified against the LIVE config, not assumed — a table that flatters itself is worse
// than none):
//   - "≤ column" is NOT a synonym for opus. `_base` ships `desenvolver: sonnet/high`, so a complex card on
//     the base pipeline tops out at SONNET/high: the size elevation is a REQUEST the ceiling still has to
//     grant. An implementer reaches opus only on a board that declares it (packages/orbit ships
//     `desenvolver: opus/max`). The rule is "the ceiling"; the tier itself is the consumer board's call
//     (D13 — agnostic core).
//   - the REVIEW LENSES are the one row this file does NOT govern. A lens is a Task sub-agent, and its tier
//     comes from the CONSUMER repo's `.claude/agents/<slug>.md` frontmatter — TODAY `model: inherit` for
//     security-reviewer/performance-auditor (so they inherit the review run's opus, NOT sonnet) and
//     `model: haiku` for code-reviewer. storymap-ui only maps id → slug (`BoardConfig.specialists`) and must
//     keep it that way: reaching in to pin a lens's model WOULD be the forbidden 4th door. Wanting lenses in
//     sonnet is one line of frontmatter in the consumer repo, not code here.
//   - `opus[1m]` (copilot chat / tick steward) is a settings knob (copilot/agent-session.ts) — this table
//     DOCUMENTS it, it does not re-implement it.
//   - a NEW model tier entering the CLI (e.g. fable) extends {@link MODEL_ORDER} and NOTHING ELSE — it is the
//     single ordinal scale every cap/ceiling comparison in this file goes through.

import type { ModelTier, EffortLevel } from "@/lib/storymap/types";
import type { StoryType, BugSeverity } from "@/lib/storymap/frameworks";

/**
 * The complexity signals lifted off a {@link Card} that bias the model/effort choice.
 * Collected by `resolveCardArgs` (config.ts) at spawn time; each is the raw card field
 * (nullable, since a freshly-captured card may not have them yet).
 */
export interface CardComplexitySignals {
  /** the nature of the work — `chore` forces the cheap tier; null/undefined = unknown */
  storyType: StoryType | null | undefined;
  /** RICE effort estimate (size proxy); null/undefined = unestimated → treated as 0 */
  riceEffort: number | null | undefined;
  /** number of tasks in the breakdown (size proxy) */
  taskCount: number;
  /** bug triage severity (reserved signal — carried for parity with the card); null = unset */
  severity: BugSeverity | null | undefined;
}

// Ordinal scales for ceiling enforcement: a candidate may never outrank the column's pair.
// MODEL_ORDER is the SINGLE place a new CLI tier is registered (WS-7): every cap/ceiling comparison in
// this file ranks through it, so adding a tier here teaches the whole routing about it at once — and
// forgetting to would silently make the tier un-cappable, not merely unranked.
const MODEL_ORDER: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const EFFORT_ORDER: Record<EffortLevel, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/** Cap `candidate` at `ceiling` (never exceed it). An undefined ceiling = no cap (passes through). */
function capModel(candidate: ModelTier, ceiling: ModelTier | undefined): ModelTier {
  if (!ceiling) return candidate;
  return MODEL_ORDER[candidate] <= MODEL_ORDER[ceiling] ? candidate : ceiling;
}
function capEffort(candidate: EffortLevel, ceiling: EffortLevel | undefined): EffortLevel {
  if (!ceiling) return candidate;
  return EFFORT_ORDER[candidate] <= EFFORT_ORDER[ceiling] ? candidate : ceiling;
}

// WS4 — teto-sob-teto: the LOWER of two (possibly-undefined) ceilings. undefined on either side ⇒ the
// other; both undefined ⇒ undefined (no ceiling). Combines the column's step ceiling with the card's
// per-instance route cap so an `express` card pays even an opus column in sonnet WITHOUT skipping the step.
function lowerModel(a: ModelTier | undefined, b: ModelTier | undefined): ModelTier | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return MODEL_ORDER[a] <= MODEL_ORDER[b] ? a : b;
}
function lowerEffort(a: EffortLevel | undefined, b: EffortLevel | undefined): EffortLevel | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return EFFORT_ORDER[a] <= EFFORT_ORDER[b] ? a : b;
}

// The size branch fires only when BOTH the estimate and the breadth cross the bar — a single
// big-but-shallow (or small-but-wide) card is not enough to spend Opus.
const SIZE_RICE_MIN = 3;
const SIZE_TASKS_MIN = 5;

// ── Per-card maxTurns scaling (story-9s52tu HALF A) ────────────────────────────────────────────
// The column's `maxTurns` (board.yaml: storymap desenvolver=220, _base=120) is the CEILING, not a
// fixed value. A FIXED ceiling blew up mid-build for a big card (w9n03r empirically needed ~220),
// while a SMALL card (a 1-task chore) burning the same 220-turn budget is wasteful AND lets a
// runaway loop churn turns it never needed. So we scale the EFFECTIVE maxTurns within
// [LEAN_BASELINE, ceiling] from the card's size (RICE effort + task count): a small card gets a
// lean budget; a big, broad card reaches the ceiling. costGuard ($ wall-clock) stays the
// independent backstop — this only bounds the TURN budget, never the cost.

/** The floor of the scaled range — even the smallest card gets at least this many turns, so a lean
 * budget can never starve a legitimately-small build of the handful of turns it needs. Kept low
 * enough to be a real economy on a tiny card yet high enough to finish a 1–2 task change. */
export const MAXTURNS_LEAN_BASELINE = 40;

/**
 * WS-7 §7.2 — the id of the `mechanical` route profile (declared in `storymap/boards/_base/board.yaml`
 * as `{modelCap: sonnet, effortCap: medium}`). Its role is CLOSED-ENDED machine work: WS-10's
 * `harness-resolve` (reapply a delta, judge each hunk cosmetic×substantive) spawns on it ALWAYS, and it is
 * available as an ordinary card route. Exported so a consumer names it once, typed, instead of sprinkling
 * a string literal — the CAPS themselves stay in board.yaml (door 2), never here.
 *
 * Two properties a consumer must NOT re-derive:
 *   - LEAN TURNS COME FREE — the profile carries no `maxTurns` (hence no schema change): size-neutral
 *     signals (no RICE estimate, no task breakdown) ⇒ {@link cardSizeScore} = 0 ⇒ {@link deriveCardMaxTurns}
 *     returns exactly {@link MAXTURNS_LEAN_BASELINE} (40), the lean budget the spec asks for, out of the
 *     mechanism that already exists. ⚠ This holds only while the signals ARE size-neutral: spawn a
 *     resolution using the CONFLICTED CARD's own signals (which may carry RICE + 6 tasks) and the size
 *     branch scales the budget back UP — a resolution is not the card's build, so pass it neutral signals.
 *   - IT IS NOT GUARANTEED TO RESOLVE — a board may opt out of the inherited pipeline and own its
 *     `routeProfiles` (repo.ts), so `resolveRouteProfile(MECHANICAL_PROFILE_ID, …)` returning null means
 *     "fall back to explicit sonnet/medium caps", NEVER "spawn uncapped" (D13 — the core can't assume the
 *     consumer's config).
 */
export const MECHANICAL_PROFILE_ID = "mechanical";

/**
 * The card-size SCORE in [0,1] — how close to the ceiling this card's turn budget should sit.
 * Combines the two size proxies the routing already lifts (RICE effort + task count) so a card that
 * is BOTH high-effort AND broad reaches 1 (the ceiling), while a 1-effort / ≤2-task card sits near 0
 * (the lean baseline). Each proxy saturates at the bar the size-elevation branch uses (effort 3,
 * 5 tasks) so the score is a smooth ramp, not a cliff. Pure — exported for tests.
 *
 * effortFrac: clamp(riceEffort / SIZE_RICE_MIN, 0..1) — 0 at no estimate, 1 at effort ≥ 3.
 * tasksFrac:  clamp(taskCount / SIZE_TASKS_MIN, 0..1) — 0 at no tasks, 1 at ≥ 5 tasks.
 * The two are AVERAGED so a card must be big on BOTH axes to top out (mirrors the AND in the size
 * branch); a card big on only one axis lands mid-range, not at the ceiling.
 */
export function cardSizeScore(signals: Pick<CardComplexitySignals, "riceEffort" | "taskCount">): number {
  const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const effortFrac = clamp01((signals.riceEffort ?? 0) / SIZE_RICE_MIN);
  const tasksFrac = clamp01(signals.taskCount / SIZE_TASKS_MIN);
  return (effortFrac + tasksFrac) / 2;
}

/**
 * Derive the EFFECTIVE per-card `--max-turns` from the card's size signals, using the column's
 * `maxTurns` as the CEILING (story-9s52tu HALF A). The result scales within
 * [{@link MAXTURNS_LEAN_BASELINE}, ceiling] by {@link cardSizeScore}:
 *
 *   - a SMALL card (effort ≤1, ≤2 tasks → score ≈ 0)         → ≈ the lean baseline (AC2);
 *   - a BIG card (effort ≥3 AND ≥5 tasks → score = 1)        → the ceiling (AC1, e.g. 220);
 *   - anything in between                                     → linearly interpolated.
 *
 * Robustness rails:
 *   - `ceiling` undefined ⇒ no per-column cap configured ⇒ undefined (passthrough: the CLI applies
 *     its own default; we never invent a number the board didn't ask for) (AC: no-ceiling);
 *   - the result is CLAMPED to `ceiling` so it can NEVER exceed it (clamp-to-ceiling AC) — including
 *     the degenerate case of a ceiling BELOW the baseline (a tiny column override), where the
 *     baseline itself is pulled down to the ceiling rather than overshooting it;
 *   - returns an integer (floor), since `--max-turns` is a whole count.
 *
 * Crucially this KEEPS the existing board.yaml maxTurns values AS the ceilings — so the big card
 * w9n03r still reaches ~220 (NOT re-capped to 120), and no board.yaml / golden-snapshot change is
 * needed. Pure — exported for tests.
 */
export function deriveCardMaxTurns(
  signals: Pick<CardComplexitySignals, "riceEffort" | "taskCount">,
  ceiling: number | undefined,
): number | undefined {
  // No configured ceiling → leave maxTurns unset (CLI default); inventing a value here would emit a
  // --max-turns flag on a column that deliberately carries none.
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return undefined;
  // A column whose ceiling is at/below the baseline can't host the full range — the baseline itself
  // must not overshoot it, so the lower bound collapses to the ceiling (a degenerate but valid 1-turn-
  // band column). Otherwise interpolate baseline → ceiling by the size score.
  const baseline = Math.min(MAXTURNS_LEAN_BASELINE, ceiling);
  const score = cardSizeScore(signals);
  const scaled = baseline + (ceiling - baseline) * score;
  // CLAMP to the ceiling (never exceed) — score is in [0,1] so this is a belt-and-suspenders rail
  // against any future score drift — and floor to a whole turn count.
  return Math.floor(Math.min(scaled, ceiling));
}

/**
 * Derive the (model, effort) a run should use from the card's complexity signals, honoring the
 * column pair as DEFAULT (no signal) and TETO (never exceed). First match wins:
 *
 *   1. `storyType === "chore"` → force DOWN to sonnet/medium (a chore is cheap by definition,
 *      regardless of its size — this branch beats the size branch). Still capped, so a column
 *      below sonnet (e.g. haiku) pulls it down further.
 *   2. `riceEffort >= 3` AND `taskCount >= 5` → elevate to opus/high, capped by the column.
 *   3. otherwise → the column pair verbatim (AC4): an undefined pair yields undefined/undefined,
 *      letting the CLI apply its own default downstream.
 *
 * The ceiling is applied to the elevated/forced candidates (1, 2) but is a no-op on the fallthrough
 * (3) — the column pair can't exceed itself.
 *
 * WS4 — the OPTIONAL per-card route caps (`cardModelCap`/`cardEffortCap`, from `card.routing`) tighten the
 * ceiling to the LOWER of the column pair and the cap (teto-sob-teto). This lets an `express` route pay a
 * trivial card in sonnet/medium even on an opus/high column, WITHOUT skipping the (load-bearing) step —
 * subsuming O3.4. The cap applies to EVERY branch (incl. fallthrough 3), so a capped card with no
 * complexity signal still routes at the cap, not the column default. Undefined caps ⇒ prior behaviour.
 */
export function deriveCardModelEffort(
  signals: CardComplexitySignals,
  columnModel: ModelTier | undefined,
  columnEffort: EffortLevel | undefined,
  cardModelCap?: ModelTier | undefined,
  cardEffortCap?: EffortLevel | undefined,
): { model: ModelTier | undefined; effort: EffortLevel | undefined } {
  // teto-sob-teto: the effective ceiling is the LOWER of the column pair and the card's route cap.
  const modelCeil = lowerModel(columnModel, cardModelCap);
  const effortCeil = lowerEffort(columnEffort, cardEffortCap);
  // 1 — chore floor (takes precedence over the size branch).
  if (signals.storyType === "chore") {
    return { model: capModel("sonnet", modelCeil), effort: capEffort("medium", effortCeil) };
  }
  // 2 — size elevation: a big, broad change earns Opus (within the ceiling).
  if ((signals.riceEffort ?? 0) >= SIZE_RICE_MIN && signals.taskCount >= SIZE_TASKS_MIN) {
    return { model: capModel("opus", modelCeil), effort: capEffort("high", effortCeil) };
  }
  // 3 — no explicit signal: the effective ceiling (the column pair, tightened by any card cap).
  return { model: modelCeil, effort: effortCeil };
}
