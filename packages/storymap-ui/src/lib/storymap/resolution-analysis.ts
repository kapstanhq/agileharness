// WS-10.5 (D14) — the ONE vocabulary for a semantic-resolution analysis, shared by every surface that shows
// it to a human: the text formatter that lands in a finding/revert reason (runner/entry-effects.ts), the
// steward's escalation question (copilot/steward.ts) and the Inbox panel (CockpitView ConflictRenderer).
//
// WHY ITS OWN MODULE (and not runner/semantic-resolution.ts, which owns the domain types): that module imports
// `convergence`/`worktree` — real git, server-only. Inbox is a client surface, so the render path needs a
// module with ZERO imports. The shape below is therefore the PERSISTED one (MergeQueueEntry.resolutionAnalysis
// / the Zod schema in merge-queue.ts): `verdict` and `outcome` are plain `string`, NOT the closed unions.
// That widening is deliberate upstream ("this field is a RECORD, not a decision") and it is exactly why the
// render must classify defensively instead of assuming a two-value world — see `classifyVerdict`.
//
// PURE — no imports, no I/O. Everything here is unit-tested in resolution-analysis.test.ts.

/** ONE judged region as it rides the merge-queue entry (the persisted, string-typed mirror of `HunkAnalysis`). */
export interface AnalysisHunk {
  /** repo-relative path of the divergent file */
  file: string;
  /** the conflicting region (already capped upstream at HUNK_TEXT_CAP) */
  hunk: string;
  /** `cosmetic` / `substantive` as persisted — a plain string on purpose (see the header note) */
  verdict: string;
  /** WHY — the judge's own reasoning, in the operator's language */
  rationale: string;
}

/** The analysis as persisted on a parked `MergeQueueEntry` (types.ts `resolutionAnalysis`). */
export interface EntryResolutionAnalysis {
  /** which rung answered, and why — the operator-facing one-liner */
  detail: string;
  /** `escalated-substantive` / `judge-failed` / `skipped` — a resolved entry never parks */
  outcome: string;
  hunks: AnalysisHunk[];
}

/**
 * How a verdict is READ by a surface. `unknown` is a third case ON PURPOSE: the persisted `verdict` is a
 * `string`, so a future judge value (or a corrupt state file) must not be silently folded into one of the two
 * known buckets. Folding it into `cosmetic` — which is what a `=== "substantive" ? … : …` ternary does — would
 * paint an UNJUDGED hunk with the harmless label, inverting invariant 6 ("ANY doubt ⇒ substantive") at exactly
 * the moment the operator is deciding. An unknown verdict is shown verbatim and never claimed to be safe.
 */
export type VerdictKind = "cosmetic" | "substantive" | "unknown";

export function classifyVerdict(verdict: string): VerdictKind {
  if (verdict === "cosmetic") return "cosmetic";
  if (verdict === "substantive") return "substantive";
  return "unknown";
}

/**
 * The operator-facing label for a verdict. SUBSTANTIVO is shouted and cosmético is not: the whole point of the
 * analysis is to answer "which of these is genuinely mine to decide?" at a glance. An unknown verdict renders
 * as its own raw value — an honest "I don't know what this is" beats a confident wrong word.
 */
export function verdictLabel(verdict: string): string {
  switch (classifyVerdict(verdict)) {
    case "substantive":
      return "SUBSTANTIVO";
    case "cosmetic":
      return "cosmético";
    case "unknown":
      return verdict;
  }
}

/**
 * Invariant 2 as the OPERATOR meets it. A mixed set (≥1 substantive AND ≥1 cosmetic) is the only case that
 * needs explaining: someone looking at 3 cosmetic hunks in a parked merge will ask why the machine didn't at
 * least take those. An all-substantive set needs no note (nothing was applicable), and an all-cosmetic set
 * never parks in the first place. Mirrors the check formatAnalysisText has always made.
 */
export function isAllOrNothing(hunks: readonly AnalysisHunk[]): boolean {
  return (
    hunks.some((h) => classifyVerdict(h.verdict) === "substantive") &&
    hunks.some((h) => classifyVerdict(h.verdict) === "cosmetic")
  );
}

/** The all-or-nothing explanation, in ONE place — the text formatter and the UI panel must never drift apart. */
export const ALL_OR_NOTHING_NOTE =
  "tudo-ou-nada: nenhum hunk foi aplicado — uma resolução parcial deixaria a árvore quebrada";

/** A hunk with its classification + label resolved — what a view renders without re-deriving anything. */
export interface AnalysisHunkView extends AnalysisHunk {
  kind: VerdictKind;
  label: string;
}

/** Everything a surface needs to render an analysis, derived once. PURE. */
export interface AnalysisSummary {
  detail: string;
  outcome: string;
  total: number;
  substantive: number;
  cosmetic: number;
  unknown: number;
  /** true ⇔ a mixed set ⇒ the all-or-nothing note applies */
  allOrNothing: boolean;
  /** the blast radius: unique files, in first-appearance order */
  files: string[];
  /** substantive first — the operator's first question is "which one is mine?"; ties keep judge order */
  hunks: AnalysisHunkView[];
}

/** Rank for the display sort. Lower renders first: substantive (mine to decide) → unknown (unproven) → cosmetic. */
function rank(kind: VerdictKind): number {
  return kind === "substantive" ? 0 : kind === "unknown" ? 1 : 2;
}

export function summarizeAnalysis(a: EntryResolutionAnalysis): AnalysisSummary {
  const hunks: AnalysisHunkView[] = a.hunks.map((h) => {
    const kind = classifyVerdict(h.verdict);
    return { ...h, kind, label: verdictLabel(h.verdict) };
  });
  const files: string[] = [];
  for (const h of hunks) if (!files.includes(h.file)) files.push(h.file);
  // Stable by construction: Array.prototype.sort is stable (ES2019+), so equal ranks keep the judge's order.
  const sorted = [...hunks].sort((x, y) => rank(x.kind) - rank(y.kind));
  return {
    detail: a.detail,
    outcome: a.outcome,
    total: hunks.length,
    substantive: hunks.filter((h) => h.kind === "substantive").length,
    cosmetic: hunks.filter((h) => h.kind === "cosmetic").length,
    unknown: hunks.filter((h) => h.kind === "unknown").length,
    allOrNothing: isAllOrNothing(a.hunks),
    files,
    hunks: sorted,
  };
}

/**
 * The PLAIN-TEXT rendering — what lands in a card finding / a revert reason a human reads (never JSON).
 * Leads with the verdict and the file for the same reason the panel sorts substantive first.
 * The canonical source of this wording; `runner/entry-effects.ts formatAnalysis` delegates here.
 */
export function formatAnalysisText(a: { detail: string; hunks: readonly AnalysisHunk[] }): string {
  const lines = [`Análise da divergência (${a.detail}):`];
  for (const h of a.hunks) lines.push(`  • [${verdictLabel(h.verdict)}] ${h.file} — ${h.rationale}`);
  if (isAllOrNothing(a.hunks)) lines.push(`  (${ALL_OR_NOTHING_NOTE})`);
  return lines.join("\n");
}
