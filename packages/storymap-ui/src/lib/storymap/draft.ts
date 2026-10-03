// Build a brand-new card IN MEMORY (no disk write) so the editor can open on a
// draft and only persist on "Salvar". Isomorphic: id.ts/order.ts are pure and
// imported client-side too. Mirrors the defaults `createCardAction` used to apply
// server-side — the difference is WHEN it touches disk (now: never, until save).

import { makeId, randomCardId } from "./id";
import { byOrder, midpoint } from "./order";
import type { Card, CardType } from "./types";

/** Empty defaults shared by every freshly-created card (no enrichment yet). */
export function emptyCardFields(): Omit<Card, "id" | "type" | "title" | "storyType" | "status" | "parent" | "release" | "order"> {
  return {
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    findings: [],
    created: null,
    updated: null,
    body: "",
  };
}

/** The order value that places a new card at the END of its sibling group. */
export function nextOrder(
  cards: Card[],
  type: CardType,
  parent: string | null,
  release: string | null,
): number {
  const siblings = cards
    .filter(
      (c) =>
        c.type === type &&
        (c.parent ?? null) === (parent ?? null) &&
        (type !== "story" || (c.release ?? null) === (release ?? null)),
    )
    .sort(byOrder);
  return midpoint(siblings.at(-1)?.order, undefined);
}

/**
 * Compose an unsaved draft card. `cards` is the board's current set — used to keep
 * the id collision-free and to compute the trailing `order`. Stories get a random
 * id (quick-capture; /harness-enrich renames later); backbone gets a title-slug id.
 */
export function makeDraftCard(input: {
  type: CardType;
  title: string;
  parent?: string | null;
  release?: string | null;
  status?: string | null;
  cards: Card[];
}): Card {
  const { type, cards } = input;
  const title = input.title || "Sem título";
  const parent = input.parent ?? null;
  const release = input.release ?? null;
  const existing = new Set(cards.map((c) => c.id));
  const id = type === "story" ? randomCardId(type, existing) : makeId(type, title, existing);

  return {
    id,
    type,
    title,
    storyType: type === "story" ? "user" : null,
    status: input.status ?? null,
    parent,
    release,
    order: nextOrder(cards, type, parent, release),
    ...emptyCardFields(),
  };
}
