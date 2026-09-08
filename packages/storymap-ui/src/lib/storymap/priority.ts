// Type-aware prioritization (Fase 2) — a SINGLE comparable backlog score (WSJF) for
// every story, whatever its kind. A frequent blocker bug must be able to out-rank a
// low-RICE feature; an improvement ranks on its own modest impact/effort. The score
// is DERIVED (like riceScore, never persisted): the kind picks the formula, the
// formula maps the kind's own inputs onto ONE Cost-of-Delay / Job-Size ratio.
//
// WSJF (Weighted Shortest Job First, SAFe): priorityScore = (CostOfDelay / JobSize).
// We scale ×10 and round so the number reads as "priority points" on a shared scale
// (roughly: trivial < 10 · normal 10–40 · alto 40–80 · crítico 80+). Higher = do first.
//
// The rubric weights live HERE (the single source) and are documented for humans/agents
// in storymap/frameworks.md §4. Keep the two in sync.

// priorityKind / bugSeverityOf / riceScore now live in gate-core.js (the isomorphic single-source
// shared verbatim with the pre-write hook — see B4 / ADR-057). priorityScore + the WSJF rubric
// below stay here (app-only). We import the three pure helpers and RE-EXPORT priorityKind +
// bugSeverityOf so the ~8 consumers keep their `from "./priority"` import path.
import { riceScore, priorityKind, bugSeverityOf } from "./gate-core";
import { BUG_FREQUENCY_BY_ID, type BugFrequency, type BugSeverity } from "./frameworks";
import type { Card } from "./types";

export { priorityKind, bugSeverityOf };

/** The three prioritization shapes. `feature` = RICE+KANO+funnel; `bug` = severity×
 * frequency×workaround; `melhoria` = impact/effort. (priorityKind's runtime DERIVATION — a
 * reopened feature keeps its bet — now lives in gate-core.js.) */
export type PriorityKind = "feature" | "bug" | "melhoria";

/**
 * A qualitative priority TIER derived from the raw WSJF score — the human-facing label that
 * replaces the bare number on the kanban card face. The cut points mirror the rubric documented
 * at the top of this file (the single source): trivial < 10 · normal 10–40 · alto 40–80 · crítico 80+.
 * `rank` (0..3) drives the card's monochrome weight treatment (higher = heavier). Notion-clean: the
 * tier is communicated by TEXT WEIGHT, never colour; the exact number stays in a tooltip.
 */
export type PriorityTier = { label: string; rank: 0 | 1 | 2 | 3 };

/** The canonical rank→label map (single source): 0 Baixa · 1 Média · 2 Alta · 3 Crítica. Both the WSJF
 * cut points and the ARGUED priority (priorityCall.rank) resolve their label through here, so the two
 * paths never drift. */
const TIER_BY_RANK: Record<0 | 1 | 2 | 3, PriorityTier> = {
  0: { label: "Baixa", rank: 0 },
  1: { label: "Média", rank: 1 },
  2: { label: "Alta", rank: 2 },
  3: { label: "Crítica", rank: 3 },
};

/** The tier for an ARGUED rank (priorityCall.rank). */
export function tierFromRank(rank: 0 | 1 | 2 | 3): PriorityTier {
  return TIER_BY_RANK[rank];
}

export function priorityTier(score: number | null): PriorityTier | null {
  if (score == null) return null;
  if (score >= 80) return TIER_BY_RANK[3];
  if (score >= 40) return TIER_BY_RANK[2];
  if (score >= 10) return TIER_BY_RANK[1];
  return TIER_BY_RANK[0];
}

/**
 * The PRIMARY priority tier of a card (reasoning-first): the ARGUED tier (`priorityCall.rank`, a
 * human/agent's defended judgment) when present, else the legacy WSJF tier derived from RICE/severity.
 * THE single entry point the UI should use so argued priority wins everywhere it's been set. Pure.
 */
export function cardPriorityTier(card: Card): PriorityTier | null {
  if (card.priorityCall) return tierFromRank(card.priorityCall.rank);
  return priorityTier(priorityScore(card));
}

/**
 * A comparable sort key (higher = do first) that ranks ARGUED priority ABOVE any raw WSJF number: an
 * argued card sorts on a band (1000 + rank) always above the legacy scores; an un-argued card keeps its
 * raw WSJF. Lets a ranked backlog float the human/agent-judged bets to the top while still ordering the
 * rest by the formula. null when the card has neither an argued tier nor the inputs its kind needs.
 */
export function cardPriorityRank(card: Card): number | null {
  if (card.priorityCall) return 1000 + card.priorityCall.rank;
  return priorityScore(card);
}

// --- Cost-of-Delay rubric weights (mirror storymap/frameworks.md §4) -----------

/** FEATURE: compress unbounded RICE reach into a 1–5 tier so it's comparable to a bug. */
function reachTier(reach: number): number {
  if (reach < 50) return 1;
  if (reach < 200) return 2;
  if (reach < 1000) return 3;
  if (reach < 5000) return 4;
  return 5;
}
const KANO_MULT: Record<string, number> = {
  "must-be": 1.3,
  performance: 1.1,
  attractive: 1.0,
  indifferent: 0.5,
  reverse: 0.2,
};
const FUNNEL_MULT: Record<string, number> = {
  activation: 1.2,
  retention: 1.2,
  revenue: 1.2,
  acquisition: 1.1,
  referral: 1.1,
  awareness: 1.0,
};

/** BUG: severity points — the spread that lets a blocker out-weigh a big feature. */
const SEVERITY_PTS: Record<BugSeverity, number> = { blocker: 20, high: 10, medium: 4, low: 1.5 };
/** BUG: a workaround halves the Cost of Delay; no workaround = full urgency. */
const WORKAROUND_MULT = { withWorkaround: 0.5, without: 1.0 };
/** BUG: bugs rarely carry a RICE effort estimate — assume a small job when absent. */
export const DEFAULT_BUG_EFFORT = 2;

/** MELHORIA: Cost of Delay = impact × this (keeps improvements modest vs features/bugs). */
const MELHORIA_IMPACT_MULT = 2;

/** Never divide by a zero/negative job size; clamp the denominator. */
function jobSize(effort: number): number {
  return Math.max(0.5, effort);
}

function frequencyWeight(freq: BugFrequency | null | undefined): number | null {
  if (!freq) return null;
  return BUG_FREQUENCY_BY_ID[freq]?.weight ?? null;
}

/**
 * The unified WSJF backlog score (priority points, higher = do first), or null when the
 * card lacks the inputs its kind needs (an unscored card sinks to the bottom of the
 * ranking, exactly like a null riceScore). Pure.
 */
export function priorityScore(card: Card): number | null {
  const kind = priorityKind(card);

  if (kind === "bug") {
    const sev = bugSeverityOf(card);
    const fw = frequencyWeight(card.frequency);
    if (sev == null || fw == null) return null; // gate: bug needs severity + frequency
    const waMult = card.hasWorkaround === true ? WORKAROUND_MULT.withWorkaround : WORKAROUND_MULT.without;
    const cod = SEVERITY_PTS[sev] * fw * waMult;
    const effort = card.rice?.effort != null && card.rice.effort > 0 ? card.rice.effort : DEFAULT_BUG_EFFORT;
    return Math.round((cod / jobSize(effort)) * 10);
  }

  if (kind === "melhoria") {
    const impact = card.rice?.impact;
    const effort = card.rice?.effort;
    if (impact == null || effort == null || !(effort > 0)) return null; // gate: melhoria needs impact + effort
    const cod = impact * MELHORIA_IMPACT_MULT;
    return Math.round((cod / jobSize(effort)) * 10);
  }

  // feature
  const score = riceScore(card.rice);
  if (score == null || card.kano == null || card.funnelStage == null) return null; // gate: feature needs RICE + KANO + funnel
  const { reach, impact, confidence } = card.rice;
  const cod =
    (impact as number) *
    (confidence as number) *
    reachTier(reach as number) *
    (KANO_MULT[card.kano] ?? 1) *
    (FUNNEL_MULT[card.funnelStage] ?? 1);
  const effort = card.rice.effort as number;
  return Math.round((cod / jobSize(effort)) * 10);
}
