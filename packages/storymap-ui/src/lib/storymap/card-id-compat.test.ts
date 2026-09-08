import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { findRepoRoot } from "@/lib/storymap/paths";

// Compat / migração (card-id-immutability fix). Ids minted before the fix — both the
// random `story-<hash>` and the legacy title-`slug` cards — stay VALID and FROZEN: no
// retroactive rebatism. The single invariant that proves the id is the stable key is
// `id (frontmatter) === filename stem`, and the proof that no past rename left orphans
// is that every `parent` / `links[].to` resolves to a real card. This test reads the
// live boards (read-only) so a future rename regression — or a dangling reference —
// trips here.

const ROOT = findRepoRoot();
const BOARDS_DIR = path.join(ROOT, "storymap", "boards");

interface CardRow {
  board: string;
  stem: string; // filename without .md
  id: string; // frontmatter id
  parent: string | null;
  links: string[]; // links[].to
}

function loadAllCards(): CardRow[] {
  const rows: CardRow[] = [];
  for (const board of readdirSync(BOARDS_DIR)) {
    const cardsDir = path.join(BOARDS_DIR, board, "cards");
    if (!existsSync(cardsDir)) continue;
    for (const file of readdirSync(cardsDir)) {
      if (!file.endsWith(".md")) continue;
      const stem = file.slice(0, -3);
      const { data } = matter(readFileSync(path.join(cardsDir, file), "utf8"));
      const d = data as Record<string, unknown>;
      const links = Array.isArray(d.links)
        ? (d.links as Array<{ to?: unknown }>).map((l) => String(l?.to ?? "")).filter(Boolean)
        : [];
      rows.push({
        board,
        stem,
        id: d.id != null ? String(d.id) : "",
        parent: d.parent != null ? String(d.parent) : null,
        links,
      });
    }
  }
  return rows;
}

const cards = loadAllCards();
const byBoard = new Map<string, Set<string>>();
for (const c of cards) {
  if (!byBoard.has(c.board)) byBoard.set(c.board, new Set());
  byBoard.get(c.board)!.add(c.id);
}

describe("card id compat / migração (no rename, no dangling refs)", () => {
  it("found cards to validate (sanity)", () => {
    expect(cards.length).toBeGreaterThan(0);
  });

  it("every card's frontmatter id EQUALS its filename stem (the id is the file key)", () => {
    for (const c of cards) {
      expect(c.id, `${c.board}/${c.stem}.md: frontmatter id "${c.id}" != filename stem`).toBe(c.stem);
    }
  });

  it("every `parent` resolves to an existing card on the same board (no orphan from a past rename)", () => {
    for (const c of cards) {
      if (!c.parent) continue;
      expect(
        byBoard.get(c.board)!.has(c.parent),
        `${c.board}/${c.id}: parent "${c.parent}" does not exist on the board`,
      ).toBe(true);
    }
  });

  it("every `links[].to` resolves to an existing card on the same board (refs stay intact)", () => {
    for (const c of cards) {
      for (const to of c.links) {
        expect(
          byBoard.get(c.board)!.has(to),
          `${c.board}/${c.id}: link to "${to}" does not exist on the board`,
        ).toBe(true);
      }
    }
  });
});
