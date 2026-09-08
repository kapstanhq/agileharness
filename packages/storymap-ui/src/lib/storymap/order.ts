import type { Card } from "./types";

export const ORDER_STEP = 10;

/**
 * Return an order value placing a card between neighbours `a` and `b`.
 * Either may be undefined (start/end of a list). Drag-and-drop uses this so a
 * single move rewrites only one card file.
 */
export function midpoint(a: number | undefined, b: number | undefined): number {
  if (a == null && b == null) return ORDER_STEP;
  if (a == null) return (b as number) - ORDER_STEP;
  if (b == null) return a + ORDER_STEP;
  return (a + b) / 2;
}

/** Stable comparator: by `order`, then by id for determinism. */
export function byOrder(a: Card, b: Card): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}

/**
 * Recency comparator for the kanban columns: the most-recently-touched card on top.
 * Primary signal is the file mtime (`updatedMs`, set by readCards) — sub-second and
 * bumped by EVERY write (human edit, drag, or harness-* skill run), so a card rises the
 * instant anything touches it, even several times the same day. Falls back, for cards
 * with no mtime yet (in-memory drafts, or a fresh git clone that reset file mtimes),
 * to the day-granular `updated` frontmatter date, then to `order`, then `id` — every
 * tier deterministic so the sort is stable.
 */
export function byUpdatedDesc(a: Card, b: Card): number {
  const ams = a.updatedMs ?? 0;
  const bms = b.updatedMs ?? 0;
  if (ams !== bms) return bms - ams; // larger ms (more recent) first
  const ad = a.updated ?? "";
  const bd = b.updated ?? "";
  if (ad !== bd) return ad < bd ? 1 : -1; // later YYYY-MM-DD first; missing date sinks
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}
