// Pure helpers behind the card's progressive disclosure + quick-action visibility
// (story-redesenho-cards-storymap). Kept React-free so the boundary logic (show first
// N, count the rest) and the per-state action gating are node-unit-testable; the
// components are thin consumers.

import type { RunSubstateKind } from "./run-substate";
import type { Card } from "./types";
import { riceScore } from "./rice";

/** Split a list into the first `max` shown + how many are hidden (>= 0). */
export function splitPreview<T>(items: readonly T[], max: number): { shown: T[]; hiddenCount: number } {
  if (max < 0) max = 0;
  return { shown: items.slice(0, max), hiddenCount: Math.max(0, items.length - max) };
}

/**
 * The single summary line a minimalist CLOSED kanban card shows under its title
 * (story-2ulzzl). It answers "do que se trata" in one glance without opening the card:
 *  - `narrative.soThat` (the value/benefit) wins — it's the most decision-relevant phrase;
 *  - else the first non-empty line of the markdown `body` (a leading `#`/`>` marker is
 *    stripped so a heading reads as plain prose), trimmed;
 *  - else `null` → the line is OMITTED silently, never a placeholder (AC7).
 * React-free so the omit/fallback rule stays node-unit-testable.
 */
export function cardSummaryLine(card: Card): string | null {
  const soThat = card.narrative?.soThat?.trim();
  if (soThat) return soThat;
  const firstLine = card.body
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  // Strip a leading markdown heading / blockquote marker so a `## Escopo…` body reads cleanly.
  const cleaned = firstLine.replace(/^#{1,6}\s+/, "").replace(/^>\s+/, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Which of the three quick actions a closed card should surface, given its live state. */
export interface QuickActionVisibility {
  /** open the run's terminal/console — whenever there's a session to resume */
  terminal: boolean;
  /** show the +/− diff — once a branch with commits exists: the merge-queue states (always),
   * OR a LIVE run that already produced commits (the small-commits flow lights it up early). */
  diff: boolean;
  /** advance to the recommended column — only when idle AND there's a recommended hop */
  advance: boolean;
}

/**
 * Decide the closed-card quick actions from the resolved sub-state + context.
 * - terminal: reachable whenever a session exists OR a run is live (resume the loop).
 * - diff: meaningful once the run branch carries commits — the post-run merge-queue states
 *   always qualify; a still-`running` card qualifies as soon as `hasDiff` (its branch already
 *   has commits vs main), so a skill's incremental commits surface the +/− LIVE, not only at settle.
 * - advance: offered only when NOT running and there IS a recommended next column
 *   (advancing mid-run would race the autorun).
 */
export function cardQuickActionVisibility(input: {
  kind: RunSubstateKind | null;
  hasSession: boolean;
  hasRecommendedMove: boolean;
  /** does the run branch already have a non-empty diff vs main? (lets a `running` card show diff) */
  hasDiff?: boolean;
}): QuickActionVisibility {
  const { kind, hasSession, hasRecommendedMove, hasDiff = false } = input;
  const running = kind === "running";
  const branchExists = kind === "merging" || kind === "conflict" || kind === "waiting" || kind === "failed" || kind === "done";
  return {
    terminal: hasSession || running,
    diff: branchExists || (running && hasDiff),
    advance: !running && hasRecommendedMove,
  };
}

/** The +/− line totals of a run's diff (mirrors parseDiffStat/parseShortstat in runner/diff.ts). */
export interface DiffStat {
  additions: number;
  deletions: number;
}

/**
 * Should a CLOSED, IDLE card (one with no live run sub-state) surface the run's +/−
 * diff totals in its footer? (story-wdmio4 — persist the +/− past the live run.)
 * Yes only when BOTH:
 *  - there's NO live sub-state — while a run is alive the command strip already owns
 *    the +/−, so the idle footer must not double it; and
 *  - a run branch resolved with REAL changes (`stat` non-null and not 0/0).
 * A card that never ran here (`stat == null`) or a no-op branch (+0 −0) shows nothing:
 * a clean footer, never an empty "+0 −0" badge.
 */
export function idleDiffVisible(input: { hasLiveSubstate: boolean; stat: DiffStat | null }): boolean {
  if (input.hasLiveSubstate) return false;
  if (!input.stat) return false;
  return input.stat.additions > 0 || input.stat.deletions > 0;
}

/**
 * Which spec sections of a card have visible content (used by CardSpecRead to hide empties).
 * Pure, node-unit-testable. Covers AC1: "campos de spec vazios não aparecem" na view leitura.
 */
export interface ReadViewSpec {
  narrative: boolean;
  acceptance: boolean;
  personas: boolean;
  systems: boolean;
  kano: boolean;
  funnelStage: boolean;
  rice: boolean;
  body: boolean;
  /** true when NO section has content — drives the "estado vazio elegante" fallback */
  empty: boolean;
}

export function cardReadViewSpec(card: Pick<Card, "narrative" | "acceptance" | "personas" | "systems" | "kano" | "funnelStage" | "rice" | "body">): ReadViewSpec {
  const narrative = !!(card.narrative?.role?.trim() || card.narrative?.want?.trim() || card.narrative?.soThat?.trim());
  const acceptance = (card.acceptance?.length ?? 0) > 0;
  const personas = (card.personas?.length ?? 0) > 0;
  const systems = (card.systems?.length ?? 0) > 0;
  const kano = card.kano != null;
  const funnelStage = card.funnelStage != null;
  const rice = riceScore(card.rice) != null;
  const body = (card.body?.trim().length ?? 0) > 0;
  const empty = !narrative && !acceptance && !personas && !systems && !kano && !funnelStage && !rice && !body;
  return { narrative, acceptance, personas, systems, kano, funnelStage, rice, body, empty };
}

/** Canonical URL to the /perguntas page filtered for one specific card (AC4). */
export function perguntasHref(boardId: string, cardId: string): string {
  return `/perguntas?board=${boardId}&card=${cardId}`;
}
