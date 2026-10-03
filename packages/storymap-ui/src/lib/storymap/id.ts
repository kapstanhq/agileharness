import type { Card, CardType } from "./types";

const PREFIX: Record<CardType, string> = {
  activity: "act",
  step: "step",
  story: "story",
  idea: "idea",
};

export function slugify(input: string): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Build a readable, collision-free id from a title; the id is the filename stem. */
export function makeId(type: CardType, title: string, existing: Set<string>): string {
  const base = `${PREFIX[type] ?? "card"}-${slugify(title) || "sem-titulo"}`;
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * The CANONICAL, permanent id for a story: a random, collision-free hash
 * (`story-<6 base36>`). Minted ONCE at capture and IMMUTABLE for the card's whole
 * life — no skill or transformation renames it (the card-id-immutability fix). A
 * title-slug id was abandoned because `/harness-enrich` rewriting it mid-pipeline broke
 * parent/links references, run-branch tracking and copy/paste. `pinCardId` enforces
 * the immutability in code. Math.random keeps this isomorphic (id.ts is imported
 * client-side too).
 */
export function randomCardId(type: CardType, existing: Set<string>): string {
  const prefix = PREFIX[type] ?? "card";
  for (let i = 0; i < 50; i++) {
    const hash = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const id = `${prefix}-${hash}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The id immutability contract (card-id-immutability fix). A card's id is its `.md`
 * filename stem AND the key every `parent`/`links[].to`/run-branch references, so it
 * MUST be generated once and never change. This pins a (possibly tampered) mutation
 * result back to the canonical on-disk id `currentId`, so NO transformation —
 * enrich, a stale drawer draft, a buggy action — can silently rewrite it. Returns
 * `next` untouched when the id already matches (the normal case). Compat: an EXISTING
 * slug id is frozen exactly as-is too — there is no retroactive rebatism to a hash.
 */
export function pinCardId(next: Card, currentId: string): Card {
  return next.id === currentId ? next : { ...next, id: currentId };
}
