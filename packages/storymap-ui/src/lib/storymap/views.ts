// Pure view-filtering logic for the prioritization page (no React), so it can be
// unit-tested in isolation. The component (PrioritizationView.tsx) owns the React
// state (useViewFilter); this module owns the math.

import type { BoardConfig, Card, StatusDef } from "./types";
import { isContainerCard } from "./unplaced";

/** A ranked story row: the card plus its derived RICE score (null = not scored). */
export type Row = { card: Card; score: number | null };

/**
 * The status a BRAND-NEW card enters: the STAGING intake lane (e.g. `triage`) when the
 * board has one — the single cheap door where a fresh card rests until a human/agent
 * routes it into the build flow, so it never auto-fires an autorun skill before any
 * decision (deleting the old `rascunho` draft column made the staging lane the entry;
 * see ADR-056). Falls back to the first non-staging, non-terminal column for boards
 * without a staging lane, then to the first status, then null.
 */
export function entryStatus(config: BoardConfig): StatusDef | null {
  return (
    config.statuses.find((s) => s.staging) ??
    config.statuses.find((s) => !s.staging && !s.terminal) ??
    config.statuses[0] ??
    null
  );
}

/** The id of {@link entryStatus} (null when the board has no statuses). */
export function entryStatusId(config: BoardConfig): string | null {
  return entryStatus(config)?.id ?? null;
}

/** Status scope of a view: "open" (in-flight), "all", or a specific status id. */
export type StatusScope = "open" | "all" | string;

export interface ViewFilter {
  scope: StatusScope;
  /** null = show all; otherwise keep the N highest-ranked SCORED rows */
  topN: number | null;
}

export const DEFAULT_VIEW_FILTER: ViewFilter = { scope: "open", topN: null };
export const TOP_N_OPTIONS = [5, 10, 20];

/**
 * Terminal ("done") statuses — the END of the pipeline (e.g. `concluida`).
 * Resolved from the EXPLICIT `terminal` flag in board.yaml, NOT by array position:
 * the pipeline carries a `refinar` re-entry column near the tail, so the terminal
 * status is NOT guaranteed to be `statuses[length-1]`. The old positional heuristic
 * could point at the wrong column and let concluded cards leak through the
 * "Em aberto" scope. Fallback (boards predating the flag): the last column.
 */
export function terminalStatusIds(config: BoardConfig): Set<string> {
  const flagged = config.statuses.filter((s) => s.terminal).map((s) => s.id);
  if (flagged.length) return new Set(flagged);
  const last = config.statuses[config.statuses.length - 1];
  return last ? new Set([last.id]) : new Set<string>();
}

/**
 * STAGING ("intake") statuses — the holding-pen lanes (e.g. `triage`/Triagem) where a fresh card RESTS
 * before a human/agent triages it into the build flow. A staging card is pre-map BY DESIGN (it has no
 * place YET — that is exactly what triage decides), so it is the symmetric twin of a terminal card for
 * placement purposes: terminal = past the map, staging = before it. Resolved from the EXPLICIT `staging`
 * flag (StatusDef.staging, board.yaml) — the SAME flag `entryStatus` reads, so the entry lane and the
 * exemption can't drift. Empty when the board declares no staging lane. Consumed by isPlacementDebt
 * (unplaced.ts) so the WS6 lint stops counting the un-triaged inbox as debt (which fail-closed the gate).
 */
export function stagingStatusIds(config: BoardConfig): Set<string> {
  return new Set(config.statuses.filter((s) => s.staging).map((s) => s.id));
}

/**
 * Apply a view's status scope + top-N to the globally-ranked rows (order preserved).
 * Top-N counts only SCORED rows, so an unscored (no-RICE) tail never masquerades as
 * "top" priority when fewer than N cards are scored.
 */
export function applyViewFilter(rows: Row[], filter: ViewFilter, config: BoardConfig): Row[] {
  let out = rows;
  if (filter.scope === "open") {
    const done = terminalStatusIds(config);
    out = out.filter((r) => !r.card.status || !done.has(r.card.status));
  } else if (filter.scope !== "all") {
    out = out.filter((r) => r.card.status === filter.scope);
  }
  if (filter.topN != null) out = out.filter((r) => r.score != null).slice(0, filter.topN);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kanban placement (pure) — the single source of truth for WHICH cards the board
// renders and in WHICH column. Extracted from KanbanBoard so the "never lose a card"
// invariant is unit-testable without React. The prime rule: a story is dropped ONLY
// when it is an archived terminal (the trash drawer owns it) or an ephemeral
// capture/style container (it has its own review surface). Every other story — even
// one sitting in a HIDDEN reentry status (corrigir/refinar/descontinuar) or in an
// UNKNOWN/future status — stays visible, landing in the loose lane rather than
// vanishing. This is what makes an active card (e.g. a bug being processed by autorun
// in `corrigir`) impossible to lose.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The synthetic column key for a story that maps to no rendered status-column — a hidden
 * reentry status, an unknown/future status, or no status at all. It is ALWAYS rendered
 * (see KanbanBoard's loose lane) so such a card is surfaced instead of silently dropped.
 */
export const KANBAN_LOOSE_COLUMN = "__nostatus__";

/** The ids of `system` columns (the archive tombstones the trash drawer owns). */
function systemColumnIds(config: BoardConfig): Set<string> {
  return new Set((config.columns ?? []).filter((c) => c.system).map((c) => c.id));
}

/**
 * Status ids whose COLUMN is not rendered on the kanban: a `hidden` status (the reentry
 * executors corrigir/refinar/descontinuar + the capture/style container lanes) OR a status in
 * a `system` column (archive). Drives the COLUMN LIST only — NOT which cards render — so the
 * eliminated reentry column (story-ql5mjm) and the archive-off-the-board rule both stay intact.
 */
export function unlistedKanbanStatusIds(config: BoardConfig): Set<string> {
  const sysCols = systemColumnIds(config);
  return new Set(
    config.statuses
      .filter((s) => s.hidden === true || (s.column != null && sysCols.has(s.column)))
      .map((s) => s.id),
  );
}

/**
 * Status ids that keep a card OFF the kanban ENTIRELY: ONLY the archive (a `system` column)
 * terminals. A `hidden` reentry status is deliberately EXCLUDED here — a card sitting there is
 * ACTIVE work (autorun is processing it, or it is stuck and needs attention), so it must stay
 * visible in the loose lane, never dropped. This narrower set is the whole fix: the old code
 * dropped every hidden status too, which is how a bug being fixed in `corrigir` went invisible.
 */
export function archivedKanbanStatusIds(config: BoardConfig): Set<string> {
  const sysCols = systemColumnIds(config);
  return new Set(config.statuses.filter((s) => s.column != null && sysCols.has(s.column)).map((s) => s.id));
}

/** The statuses that render as columns on the kanban (config order preserved). */
export function kanbanColumnStatuses(config: BoardConfig): StatusDef[] {
  const unlisted = unlistedKanbanStatusIds(config);
  return config.statuses.filter((s) => !unlisted.has(s.id));
}

/**
 * The stories the kanban renders. Only STORIES flow through the kanban (activities/steps are
 * backbone-only). A story is dropped ONLY when it is an archived terminal or an ephemeral
 * container; every other story is kept — including hidden-reentry and unknown-status cards —
 * so an active card is never silently lost.
 */
export function kanbanStories(cards: Card[], config: BoardConfig): Card[] {
  const archived = archivedKanbanStatusIds(config);
  return cards.filter(
    (c) => c.type === "story" && !isContainerCard(c) && !(c.status != null && archived.has(c.status)),
  );
}

/**
 * The column a story renders in: its own status column when that status renders one, else the
 * always-visible loose lane. NEVER returns null — this is the safe fallback that surfaces a card
 * with an unknown/hidden status instead of dropping it. `columnStatusIds` is the set of statuses
 * that render as columns (ids of {@link kanbanColumnStatuses}).
 */
export function kanbanColumnOf(card: Card, columnStatusIds: ReadonlySet<string>): string {
  return card.status != null && columnStatusIds.has(card.status) ? card.status : KANBAN_LOOSE_COLUMN;
}
