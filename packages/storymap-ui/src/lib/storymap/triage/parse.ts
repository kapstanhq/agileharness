// Turn the triage agent's answer into a validated TriageReport, then decide the
// concrete outcome (ADR-056, Fase 1). This is the SECURITY CAGE: the agent's JSON
// is sanitized against the board vocabulary + an allowlist of fields, so an injected
// report can never widen its effect (gh-aw "safe outputs"). The confidence gate then
// routes low-confidence / unanchored cases to a human instead of auto-applying.

import { isBugSeverity, isBugFrequency, isStoryType } from "../frameworks";
import { extractJsonObject } from "../smart-capture/parse";
import { REOPEN_KINDS } from "../reopen";
import type { BoardConfig, BugReport, Card, Refinement } from "../types";
import {
  TRIAGE_INTENTS,
  TRIAGE_VERBS,
  type TriageIntent,
  type TriageOutcome,
  type TriageReport,
  type TriageVerb,
} from "./types";

/** Below this confidence the intake refuses to auto-dedupe/decline (→ human review). */
export const TRIAGE_CONFIDENCE_THRESHOLD = 0.7;
/** Untrusted free text is capped before it reaches the agent. */
export const MAX_INTAKE_TEXT = 4000;
const MAX_LABELS = 8;
const MAX_LABEL_LEN = 32;
const MAX_RELATES = 10;

// Zero-width / invisible code points (ZWSP, ZWNJ, ZWJ, word-joiner, BOM) — classic
// prompt-injection carriers. Matched by code point (not a literal regex class) so the
// source stays free of invisible characters.
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/** True for C0/C1 control chars EXCEPT tab/LF/CR, plus DEL — and zero-width chars. */
function isStrippableChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false; // keep \t \n \r
  if (code <= 0x1f || code === 0x7f) return true; // control + DEL
  return ZERO_WIDTH.has(code);
}

/**
 * Strip control + zero-width/invisible chars and cap length. The intake report is
 * untrusted input flowing into an agent with file/skill access, so we neutralize the
 * classic prompt-injection carriers before it is delimited as DATA in the prompt.
 */
export function sanitizeIntakeText(raw: string): string {
  let out = "";
  for (const ch of raw ?? "") {
    if (!isStrippableChar(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim().slice(0, MAX_INTAKE_TEXT);
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sanitizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    const s = String(x).trim().slice(0, MAX_LABEL_LEN);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/**
 * Sanitize the agent's JSON against the board vocabulary + the field allowlist.
 * Unknown verb → "create" (safe: lands in triage). Unknown storyType → "bug" (the
 * intake default). relatesTo/duplicateOf are kept ONLY when they point at a real card.
 */
export function parseTriage(raw: string, _config: BoardConfig, cards: Card[]): TriageReport {
  const o = extractJsonObject(raw) as Record<string, unknown>;
  const existingIds = new Set(cards.map((c) => c.id));

  const verb: TriageVerb = TRIAGE_VERBS.includes(o.verb as TriageVerb) ? (o.verb as TriageVerb) : "create";
  const duplicateOf =
    typeof o.duplicateOf === "string" && existingIds.has(o.duplicateOf) ? o.duplicateOf : null;
  const relatesTo = Array.isArray(o.relatesTo)
    ? [...new Set(o.relatesTo.map((x) => String(x)).filter((id) => existingIds.has(id)))].slice(0, MAX_RELATES)
    : [];

  const storyType = isStoryType(o.storyType) ? o.storyType : "bug";
  // Routing intent (Opção B): use the agent's when valid, else derive — a `bug`
  // storyType implies a bug intent, anything else implies a feature (melhoria is
  // never inferred — it needs the agent to recognize an improvement of shipped work).
  const intent: TriageIntent = TRIAGE_INTENTS.includes(o.intent as TriageIntent)
    ? (o.intent as TriageIntent)
    : storyType === "bug"
      ? "bug"
      : "feature";

  return {
    verb,
    intent,
    storyType,
    severity: isBugSeverity(o.severity) ? o.severity : "medium",
    frequency: isBugFrequency(o.frequency) ? o.frequency : "sometimes",
    hasWorkaround: typeof o.hasWorkaround === "boolean" ? o.hasWorkaround : false,
    title: typeof o.title === "string" ? o.title.trim().slice(0, 160) : "",
    summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 600) : "",
    labels: sanitizeLabels(o.labels),
    relatesTo,
    duplicateOf,
    declineReason:
      typeof o.declineReason === "string" && o.declineReason.trim()
        ? o.declineReason.trim().slice(0, 600)
        : null,
    confidence: clampConfidence(o.confidence),
    reasoning: typeof o.reasoning === "string" ? o.reasoning.trim().slice(0, 600) : "",
    ...(coercePlacement(o.placement, cards) ? { placement: coercePlacement(o.placement, cards)! } : {}),
  };
}

/**
 * WS6 (F5) — tolerant parse of the triador's SUGGESTED placement. Validates `parentSuggestion`/`serves`
 * against REAL card ids (drops a hallucinated id, mirroring relatesTo) so the accept drawer only ever
 * pre-fills a real anchor. Returns undefined when nothing usable survives (sparse — never fabricated).
 */
function coercePlacement(
  raw: unknown,
  cards: Card[],
): { parentSuggestion?: string; serves?: string; rationale?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const ids = new Set(cards.map((c) => c.id));
  const out: { parentSuggestion?: string; serves?: string; rationale?: string } = {};
  if (typeof r.parentSuggestion === "string" && ids.has(r.parentSuggestion)) out.parentSuggestion = r.parentSuggestion;
  if (typeof r.serves === "string" && ids.has(r.serves)) out.serves = r.serves;
  if (typeof r.rationale === "string" && r.rationale.trim()) out.rationale = r.rationale.trim().slice(0, 300);
  return out.parentSuggestion || out.serves ? out : undefined; // a lone rationale is not a placement
}

/**
 * Confidence gate + verb resolution (pure). Low confidence — or a `duplicate` the
 * agent couldn't anchor to a real card — falls back to a `triage` card flagged
 * needsHumanReview, so automation never silently dedupes/declines when unsure. High
 * confidence applies the verb (→ duplicado / cancelado terminal). Everything else
 * lands in the triage staging lane.
 */
export function decideTriage(report: TriageReport, opts: { threshold?: number } = {}): TriageOutcome {
  const threshold = opts.threshold ?? TRIAGE_CONFIDENCE_THRESHOLD;
  const lowConfidence = report.confidence < threshold;

  if (!lowConfidence && report.verb === "duplicate" && report.duplicateOf) {
    return { status: "duplicado", needsHumanReview: false, duplicateOf: report.duplicateOf };
  }
  if (!lowConfidence && report.verb === "decline") {
    return { status: "cancelado", needsHumanReview: false, duplicateOf: null };
  }
  return { status: "triage", needsHumanReview: lowConfidence, duplicateOf: null };
}

// --- Accept routing (Opção B, Fase 2) ---------------------------------------
//
// A card RESTS in triage until a human/agent ACCEPTS it. Acceptance routes it into
// the right lane by the kind the intake persisted on the card (mirrors priorityKind):
//   bug  (storyType bug / mode fix)  → corrigir   (harness-fix)
//   melhoria (mode refine)           → refinar    (harness-refine)
//   feature (everything else)        → enriquecer (harness-enrich)
// The lane's entry gate (hasBugReport / hasRefineBrief) is pre-satisfied at intake
// (see reportIssueAction), so the accept is a clean status move. PURE.

/** The lane status an accepted triage card routes into, by its persisted kind. The bug/refine lanes
 *  DERIVE from REOPEN_KINDS (single source). A plain feature enters the build flow at its FIRST step:
 *  a `user` story at `interview` (discovery FIRST — USM: o aceite nasce da conversa), every non-user
 *  type at `enriquecer` (it skipForTypes the interview anyway, so route straight past it). */
export function acceptRoute(card: Card): string {
  if (card.storyType === "bug" || card.mode === "fix") return REOPEN_KINDS.fix.status;
  if (card.mode === "refine") return REOPEN_KINDS.refine.status;
  return card.storyType === "user" ? "interview" : "enriquecer";
}

/**
 * Canonical `bugReport` for a NEW bug accepted into `corrigir` (satisfies the
 * hasBugReport gate). The triage gives us the brief + severity; expected/actual/steps
 * are left for `harness-fix` to reconstruct from the live code. PURE.
 */
export function buildTriageBugReport(report: TriageReport): BugReport {
  return {
    brief: report.summary || report.title || "Bug reportado na triagem.",
    severity: report.severity,
    expected: null,
    actual: null,
    steps: [],
    target: null,
    screenshot: null,
    openedAt: null,
  };
}

/**
 * Canonical `refinement` for a NEW melhoria accepted into `refinar` (satisfies the
 * hasRefineBrief gate). Defaults the kind to `functionality` (harness-refine re-classifies
 * from the live diagnosis). PURE.
 */
export function buildTriageRefinement(report: TriageReport): Refinement {
  return {
    brief: report.summary || report.title || "Melhoria reportada na triagem.",
    kinds: ["functionality"],
    target: null,
    screenshot: null,
    openedAt: null,
  };
}
