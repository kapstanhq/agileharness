// 🟨 Lean Canvas — the pure domain kernel (no fs, no React, no spawn → fully unit-testable).
//
// The canvas moved from "one prose blob per block" to "a block holds ITEMS, an item carries TAGS".
// Everything that has to agree on that shape — the read coercer (repo.ts), the governance diff, the
// agent proposal parser and the view — goes through THIS module, so the shape has exactly one owner.
//
// Two invariants the rest of the system leans on:
//   1. LEGACY NEVER BREAKS. A board whose YAML still holds a flat string per block is promoted to a
//      single item on read. Nothing is lost, nothing needs migrating before the feature works.
//   2. EMPTY IS NULL. A block with zero items is indistinguishable from an absent block — for the
//      YAML, for the governance conflict gate (which JSON-compares `before` against the canonical)
//      and for the UI. `isEmptyCanvasValue` is the single answer to "is there anything here?".

import type { BoardConfig, CanvasBlock, CanvasItem, CanvasTag } from "./types";

/** The canvas of a board, resolved: block key → its items (or null when the block is empty). */
export type CanvasMap = Record<string, CanvasBlock | null>;

// ── Item ids ────────────────────────────────────────────────────────────────

/**
 * The next free item id within a block — `i1`, `i2`, … Sequential (not random) so the YAML diff of a
 * canvas edit stays readable and a test can assert it. Scans the taken ids, so it never collides with
 * an id the agent supplied or an item that was deleted and re-added.
 */
export function nextItemId(taken: Iterable<string>): string {
  const seen = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `i${n}`;
    if (!seen.has(id)) return id;
  }
}

/**
 * Fill in a stable id for every item that lacks one (agent proposals omit ids for NEW items), and
 * RE-KEY any duplicate — a model that repeats an id would otherwise hand us two items React renders
 * as one, where deleting either deletes both. Explicit ids are reserved BEFORE any id is minted, so a
 * new item can never steal the id of an item declared later in the list.
 */
export function ensureItemIds(items: Array<Partial<CanvasItem> & { text: string }>): CanvasItem[] {
  const declared = items.map((i) => (typeof i.id === "string" ? i.id.trim() : ""));
  const reserved = new Set(declared.filter(Boolean));
  const used = new Set<string>();
  const out: CanvasItem[] = [];
  items.forEach((raw, idx) => {
    let id = declared[idx];
    if (!id || used.has(id)) {
      // sem id, ou id repetido → cunha um livre (sem colidir com os explícitos ainda por vir)
      id = nextItemId(new Set([...reserved, ...used]));
    }
    used.add(id);
    out.push(cleanItem({ ...raw, id }));
  });
  return out;
}

// ── Coercion (the read path) ────────────────────────────────────────────────

/** Normalize one item, dropping empty/unknown fields so the YAML stays minimal. */
function cleanItem(raw: Partial<CanvasItem> & { id: string; text: string }): CanvasItem {
  const item: CanvasItem = { id: raw.id, text: String(raw.text ?? "").trim() };
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (tags.length > 0) item.tags = [...new Set(tags)];
  const group = typeof raw.group === "string" ? raw.group.trim() : "";
  if (group) item.group = group;
  if (raw.highlight === true) item.highlight = true;
  return item;
}

// Bounds. The canvas is written by an LLM and by a browser payload: without a ceiling, one runaway
// proposal can wedge every subsequent READ of the board (the YAML is parsed on every request). These
// are far above any honest Lean Canvas and far below "the board is now unusable".
export const MAX_ITEMS_PER_BLOCK = 60;
export const MAX_ITEM_TEXT = 2000;
export const MAX_TAGS = 40;

/** Coerce one raw item (from YAML or an agent's JSON). Returns null when there's no text to show. */
export function coerceCanvasItem(raw: unknown, fallbackId: string): CanvasItem | null {
  const partial = toPartialItem(raw);
  if (!partial) return null;
  return cleanItem({ ...partial, id: partial.id || fallbackId });
}

/** Parse a raw item WITHOUT minting an id — so the caller can reserve every explicit id first. */
function toPartialItem(raw: unknown): (Partial<CanvasItem> & { text: string }) | null {
  if (raw == null) return null;
  // A bare string item is legal shorthand in hand-written YAML: `- "a dor do cliente"`.
  if (typeof raw === "string" || typeof raw === "number") {
    const text = String(raw).trim();
    return text ? { text } : null;
  }
  if (typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = r.text == null ? "" : String(r.text).trim();
  if (!text) return null;
  return {
    id: typeof r.id === "string" ? r.id.trim() : undefined,
    text: text.slice(0, MAX_ITEM_TEXT),
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map((t) => String(t)) : undefined,
    group: typeof r.group === "string" ? r.group : undefined,
    highlight: r.highlight === true,
  };
}

/**
 * Coerce one raw BLOCK value. Tolerates every shape the field has ever had:
 *   - `{ items: [...] }`        the current model
 *   - `"prose"`                 LEGACY — promoted to a single item (the migration is data, not code)
 *   - `["a", "b"]`              a bare list (hand-written YAML)
 *   - null / "" / `{items:[]}`  → null (empty is null)
 * Ids are settled by ensureItemIds: explicit ids are reserved first, duplicates are re-keyed.
 */
export function coerceCanvasBlock(raw: unknown): CanvasBlock | null {
  if (raw == null) return null;

  let rawItems: unknown[];
  if (typeof raw === "string" || typeof raw === "number") {
    const text = String(raw).trim();
    if (!text) return null;
    rawItems = [{ text }]; // LEGACY: the whole prose becomes item #1 — lossless, migrate later.
  } else if (Array.isArray(raw)) {
    rawItems = raw;
  } else if (typeof raw === "object") {
    const items = (raw as Record<string, unknown>).items;
    if (!Array.isArray(items)) return null;
    rawItems = items;
  } else {
    return null;
  }

  const partials = rawItems
    .slice(0, MAX_ITEMS_PER_BLOCK)
    .map(toPartialItem)
    .filter((p): p is Partial<CanvasItem> & { text: string } => p != null);
  const items = ensureItemIds(partials);
  return items.length > 0 ? { items } : null;
}

/**
 * Coerce the whole `canvas` map. Empty blocks collapse to null and an all-empty canvas to undefined
 * (absent), so `deriveBoardConfigForPersist` never writes a husk into board.yaml.
 */
export function coerceCanvas(raw: unknown): CanvasMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: CanvasMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = coerceCanvasBlock(value);
  }
  const hasContent = Object.values(out).some((b) => b != null);
  return hasContent ? out : undefined;
}

/**
 * A tag colour must be a plain hex — it is interpolated into an inline `style` (`${color}1a` for the
 * tint), so anything else is dropped rather than trusted. The chip then falls back to neutral.
 */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Slugify a tag name into a stable id (`Early adopters` → `early-adopters`). */
export function tagIdFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Coerce the board's canvas tag vocabulary. Drops entries with no id/name; dedupes by id. */
export function coerceCanvasTags(raw: unknown): CanvasTag[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: CanvasTag[] = [];
  for (const entry of raw.slice(0, MAX_TAGS)) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const tag: CanvasTag = { id, name };
    const color = typeof r.color === "string" ? r.color.trim() : "";
    if (HEX_COLOR_RE.test(color)) tag.color = color;
    out.push(tag);
  }
  return out.length > 0 ? out : undefined;
}

// ── Emptiness (the governance conflict gate leans on this) ──────────────────

/**
 * Is this canvas value "nothing"? null/undefined/""/[]/{items:[]} all mean the same thing to a human,
 * but NOT to `JSON.stringify` — and the governance gate compares `before` to the canonical with
 * exactly that. Without this, the FIRST edit of an unset block (before:{items:[]} vs canonical:
 * undefined) would be refused as a phantom conflict.
 */
export function isEmptyCanvasValue(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const items = (v as Record<string, unknown>).items;
    return Array.isArray(items) && items.length === 0;
  }
  return false;
}

/** The value a block should be PERSISTED as: an empty block is null, never `{ items: [] }`. */
export function blockOrNull(block: CanvasBlock | null | undefined): CanvasBlock | null {
  return block && block.items.length > 0 ? block : null;
}

// ── Reading (view + prompt helpers) ─────────────────────────────────────────

/** The items of one block — always an array, so a caller never branches on null. */
export function itemsOf(canvas: CanvasMap | null | undefined, key: string): CanvasItem[] {
  return canvas?.[key]?.items ?? [];
}

/** The block rendered as plain text (one item per line) — for prompts and legacy exports. */
export function blockToText(block: CanvasBlock | null | undefined): string {
  if (!block || block.items.length === 0) return "";
  return block.items.map((i) => `- ${i.text}`).join("\n");
}

/**
 * The block as the operator must REVIEW it — text PLUS the metadata a diff of bare text would hide.
 * This is not cosmetic: an agent that re-emits an item with the same text but WITHOUT its tags is
 * proposing to silently un-segment it, and a text-only diff renders that as "no change". What the
 * operator approves has to be what actually lands.
 */
export function blockToReviewText(
  block: CanvasBlock | null | undefined,
  tags: readonly CanvasTag[] | null | undefined,
): string {
  if (!block || block.items.length === 0) return "";
  return block.items
    .map((item) => {
      const meta = [
        item.group ? `grupo: ${item.group}` : null,
        item.tags?.length ? `tags: ${resolveItemTags(item, tags).map((t) => t.name).join(", ") || item.tags.join(", ")}` : null,
        item.highlight ? "destaque" : null,
      ].filter(Boolean);
      return `- ${item.text}${meta.length > 0 ? `\n    (${meta.join(" · ")})` : ""}`;
    })
    .join("\n");
}

/** Ordered, de-duplicated group headings of a block, by first appearance. `null` = ungrouped. */
export function groupsOf(items: readonly CanvasItem[]): Array<string | null> {
  const out: Array<string | null> = [];
  const seen = new Set<string>();
  let sawUngrouped = false;
  for (const item of items) {
    const g = item.group?.trim() || null;
    if (g == null) {
      if (!sawUngrouped) {
        sawUngrouped = true;
        out.push(null);
      }
      continue;
    }
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** Look up a tag by id. */
export function tagById(tags: readonly CanvasTag[] | null | undefined, id: string): CanvasTag | undefined {
  return (tags ?? []).find((t) => t.id === id);
}

/** The tags of an item, resolved against the board vocabulary (unknown ids are dropped). */
export function resolveItemTags(
  item: CanvasItem,
  tags: readonly CanvasTag[] | null | undefined,
): CanvasTag[] {
  return (item.tags ?? []).map((id) => tagById(tags, id)).filter((t): t is CanvasTag => t != null);
}

/**
 * The colour that paints an item — its FIRST resolvable tag. Undefined = neutral note. One rule,
 * applied everywhere, so an item's colour can never disagree between the note and its chip.
 */
export function itemColor(item: CanvasItem, tags: readonly CanvasTag[] | null | undefined): string | undefined {
  return resolveItemTags(item, tags)[0]?.color;
}

// ── Writing (pure transforms the UI + the agent path share) ─────────────────

/** Remove a deleted tag's id from every item of the canvas. Returns the blocks that CHANGED. */
export function stripTagFromCanvas(canvas: CanvasMap | null | undefined, tagId: string): CanvasMap {
  const changed: CanvasMap = {};
  for (const [key, block] of Object.entries(canvas ?? {})) {
    if (!block) continue;
    if (!block.items.some((i) => i.tags?.includes(tagId))) continue;
    changed[key] = {
      items: block.items.map((item) => {
        if (!item.tags?.includes(tagId)) return item;
        const tags = item.tags.filter((t) => t !== tagId);
        const next: CanvasItem = { ...item };
        if (tags.length > 0) next.tags = tags;
        else delete next.tags;
        return next;
      }),
    };
  }
  return changed;
}

/**
 * THE REFERENTIAL INVARIANT: an item may only wear a tag that EXISTS in the vocabulary.
 *
 * The hand path keeps it by construction (deleting a tag strips it from every item in the same atomic
 * proposal). The AGENT path cannot be trusted to: it may drop a tag and leave the refs behind, and the
 * operator can approve a block change while REJECTING the tag change that would have created the tag
 * it references. So the invariant is enforced at the WRITE CHOKEPOINT, over the final vocabulary —
 * whatever the caller believed. Returns only the blocks it had to repair.
 */
export function stripUnknownTagRefs(canvas: CanvasMap, tags: readonly CanvasTag[]): CanvasMap {
  const known = new Set(tags.map((t) => t.id));
  const repaired: CanvasMap = {};
  for (const [key, block] of Object.entries(canvas)) {
    if (!block) continue;
    if (!block.items.some((i) => i.tags?.some((t) => !known.has(t)))) continue;
    repaired[key] = {
      items: block.items.map((item) => {
        if (!item.tags?.some((t) => !known.has(t))) return item;
        const kept = item.tags.filter((t) => known.has(t));
        const next: CanvasItem = { ...item };
        if (kept.length > 0) next.tags = kept;
        else delete next.tags;
        return next;
      }),
    };
  }
  return repaired;
}

/** Upsert an item into a block (by id), preserving order; a new item is appended. */
export function upsertItem(block: CanvasBlock | null | undefined, item: CanvasItem): CanvasBlock {
  const items = block?.items ?? [];
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx < 0) return { items: [...items, item] };
  const next = [...items];
  next[idx] = item;
  return { items: next };
}

/** Remove an item from a block by id. */
export function removeItem(block: CanvasBlock | null | undefined, itemId: string): CanvasBlock | null {
  const items = (block?.items ?? []).filter((i) => i.id !== itemId);
  return items.length > 0 ? { items } : null;
}

// ── The agent's view of the canvas ──────────────────────────────────────────


