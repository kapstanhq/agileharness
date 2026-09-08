// Triage intake (ADR-056, Fase 1) — free-text bug/improvement report → LLM
// classification → a card in the `triage` staging lane.
//
// The agent NEVER writes: report_issue runs Claude READ-ONLY and gets back a
// TriageReport (these types). The deterministic layer (parse.ts) sanitizes it
// against the board vocabulary + an ALLOWLIST of safe outputs, applies a
// confidence gate, and only then materializes ONE card. This is the security
// spine — an injected "report" can never make the agent delete cards, run a
// build skill, or write arbitrary fields. Isomorphic (shared by the action + tests).

import type { BugSeverity, BugFrequency, StoryType } from "../frameworks";

/**
 * The intake decision space (the dedup/route verbs). The 4th triage verb —
 * `snooze`/`accept` (promote out of triage to the board) — is a SEPARATE human/agent
 * action on an item already in triage, not an intake outcome.
 */
export type TriageVerb = "create" | "duplicate" | "decline";
export const TRIAGE_VERBS: TriageVerb[] = ["create", "duplicate", "decline"];

/**
 * The routing category (Opção B, Fase 2) — what KIND of work the report is, which
 * decides the lane a card is ACCEPTED into: `feature` → enriquecer, `bug` → corrigir,
 * `melhoria` → refinar. Distinct from `storyType` (which picks the narrative template):
 * a `bug` intent forces storyType `bug`; a `melhoria` is an improvement of shipped work.
 */
export type TriageIntent = "feature" | "bug" | "melhoria";
export const TRIAGE_INTENTS: TriageIntent[] = ["feature", "bug", "melhoria"];

/** The triage agent's structured answer (raw LLM output, pre-sanitization). */
export interface TriageReport {
  /** create a new triage card · duplicate of an existing card · decline (not actionable) */
  verb: TriageVerb;
  /** the routing category (Opção B) — decides the accept lane: feature→enriquecer · bug→corrigir · melhoria→refinar */
  intent: TriageIntent;
  /** what kind of work this is — usually `bug` for an intake; picks the card's storyType */
  storyType: StoryType;
  /** triage severity (blocker → low) — the bug priority's "how bad" axis */
  severity: BugSeverity;
  /** bug priority's "how often" axis (only meaningful when intent=bug) */
  frequency: BugFrequency;
  /** does a workaround exist? lowers a bug's urgency (only meaningful when intent=bug) */
  hasWorkaround: boolean;
  /** short card title the agent proposes */
  title: string;
  /** normalized 1–2 line restatement of the report (goes in the card body) */
  summary: string;
  /** free-form classification labels (area, regression, needs-info…) */
  labels: string[];
  /** existing card ids this report relates to / regresses (→ links rel=relates-to) */
  relatesTo: string[];
  /** existing card id this duplicates (only meaningful when verb=duplicate) */
  duplicateOf: string | null;
  /** why it's not actionable (only meaningful when verb=decline) */
  declineReason: string | null;
  /** the agent's self-reported confidence, 0..1 — drives the human-review gate */
  confidence: number;
  /** the agent's reasoning (kept in the body for audit) */
  reasoning: string;
  /**
   * WS6 (F5) — SUGGESTED placement on the map (the triador is READ-ONLY: it SUGGESTS, the human aceite
   * DECIDES). `parentSuggestion` = the closest step/activity id this belongs under; `serves` = for a
   * delivery, the user-story id it serves. Sparse — absent when the agent can't anchor it. Never written
   * to the card by the triador itself; it pre-fills the accept drawer so the human is asked to decide.
   */
  placement?: { parentSuggestion?: string; serves?: string; rationale?: string };
}

/** What the deterministic layer decided to DO after the allowlist + confidence gate. */
export interface TriageOutcome {
  /** the status the new card lands in (a staging lane or a visible terminal) */
  status: "triage" | "duplicado" | "cancelado";
  /** the triage agent left this for a human (low confidence, or a dedupe it couldn't anchor) */
  needsHumanReview: boolean;
  /** canonical card id when status=duplicado (gate hasDuplicateOf) */
  duplicateOf: string | null;
}
