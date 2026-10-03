import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { boardsDir, cardsDir } from "@/lib/storymap/paths";
import { STORY_TYPE_IDS } from "@/lib/storymap/frameworks";

// Story-classification lint — the guard-rail that keeps the User Story Map (Patton) a
// USER backbone, not a kanban of delivery work.
//
// The map (AgileHarnessOutline) renders ONLY `storyType: "user"` stories (isBackboneStory,
// lib/storymap/unplaced.ts); technical/bug/chore/spike are delivery work and live in the
// Kanban view. A card LEAKS back onto the map when it is mis-classified — so this test
// scans every board's cards and FAILS CI on the leak vectors:
//   1. a `type: story` with no explicit `storyType` in frontmatter (coerceCard would
//      silently default it to "user" → it shows on the map even if it's delivery work);
//   2. a `storyType` outside the canonical set (typo → unhandled);
//   3. a card whose mode/shape says "bug" but whose `storyType` disagrees: `mode: fix`
//      or a `bugReport` block ⇒ it MUST be `storyType: bug` (mirrors the bug rule in
//      priority.ts:34 and triage/parse.ts:152) so a fix can't masquerade as a user story.
//
// Parses RAW frontmatter (NOT coerceCard) on purpose: coercion hides the "missing
// storyType" case by defaulting to "user", which is exactly the leak we want to catch.

const VALID = new Set<string>(STORY_TYPE_IDS);

interface Violation {
  board: string;
  card: string;
  rule: string;
}

function listBoards(): string[] {
  const dir = boardsDir();
  return readdirSync(dir).filter((b) => {
    const cd = cardsDir(b);
    return existsSync(cd) && statSync(cd).isDirectory();
  });
}

/** Normalize a possibly-blank frontmatter id field to a trimmed string or null. */
function asRef(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

interface Node {
  type: unknown;
  serves: string | null;
  parent: string | null;
}

/** Pure rule engine over a board's raw frontmatter (id → data) — unit-testable without the FS. */
export function validateBoard(board: string, raws: Map<string, Record<string, unknown>>): Violation[] {
  const out: Violation[] = [];
  {
    // First pass: index EVERY card (all types) so serves targets + parent chains resolve.
    const byId = new Map<string, Node>();
    for (const [id, data] of raws) {
      byId.set(id, { type: data.type, serves: asRef(data.serves), parent: asRef(data.parent) });
    }

    for (const [id, data] of raws) {
      if (data.type === "story") {
        const st = data.storyType;
        const hasBugReport = data.bugReport != null && typeof data.bugReport === "object";
        const isFix = data.mode === "fix";

        // Rule 1 — every story declares its storyType explicitly (no silent "user" default).
        if (st == null || st === "") {
          out.push({ board, card: id, rule: "missing storyType (delivery work would leak onto the map as a default user story)" });
        } else if (typeof st !== "string" || !VALID.has(st)) {
          // Rule 2 — the value is canonical.
          out.push({ board, card: id, rule: `invalid storyType "${String(st)}" (not in ${[...VALID].join("/")})` });
        } else if ((isFix || hasBugReport) && st !== "bug") {
          // Rule 3 — a fix / bug-report MUST be typed bug (so it leaves the map for the Kanban).
          const why = isFix ? "mode: fix" : "a bugReport block";
          out.push({ board, card: id, rule: `has ${why} but storyType is "${st}" (must be "bug")` });
        }
      }

      // Rule 4 — dual-track serves integrity + acyclicity (any card may carry serves; only delivery
      // stories emit it, but validate wherever it appears so a stray ref never slips through).
      const serves = byId.get(id)!.serves;
      if (!serves) continue;
      if (serves === id) {
        out.push({ board, card: id, rule: "serves points at itself (self-attribution)" });
        continue;
      }
      if (!byId.has(serves)) {
        out.push({ board, card: id, rule: `serves "${serves}" references a card that does not exist on board "${board}"` });
        continue;
      }
      // Cycle: walk serves ?? parent from the target; a return to a seen node is a loop.
      const seen = new Set<string>([id]);
      let cur: string | null = serves;
      while (cur) {
        if (seen.has(cur)) {
          out.push({ board, card: id, rule: `serves/parent chain has a cycle (revisits "${cur}")` });
          break;
        }
        seen.add(cur);
        const node: Node | undefined = byId.get(cur);
        if (!node) break;
        cur = node.serves ?? node.parent;
      }
    }
  }
  return out;
}

/** Read every board from disk and run the pure validator over each. */
function collectViolations(): Violation[] {
  const out: Violation[] = [];
  for (const board of listBoards()) {
    const dir = cardsDir(board);
    const raws = new Map<string, Record<string, unknown>>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const id = file.replace(/\.md$/, "");
      raws.set(id, matter(readFileSync(path.join(dir, file), "utf8")).data as Record<string, unknown>);
    }
    out.push(...validateBoard(board, raws));
  }
  return out;
}

describe("story classification lint — map stays a user backbone, delivery stays in the Kanban", () => {
  it("every story card is classified (explicit, canonical storyType; fixes are typed bug)", () => {
    const violations = collectViolations();
    // A readable failure: one line per offending card, so the fix is obvious.
    const report = violations.map((v) => `  • ${v.board}/${v.card}: ${v.rule}`).join("\n");
    expect(violations, violations.length ? `\nCards mis-classified (would pollute the Story Map):\n${report}\n` : "").toEqual([]);
  });
});

describe("validateBoard — dual-track serves integrity (Rule 4), on synthetic boards", () => {
  const raws = (entries: Record<string, Record<string, unknown>>) =>
    new Map(Object.entries(entries));

  it("accepts a delivery story whose serves points at a real backbone node", () => {
    const v = validateBoard("t", raws({
      "step-a": { type: "step" },
      "story-x": { type: "story", storyType: "technical", parent: "step-a", serves: "step-a" },
    }));
    expect(v).toEqual([]);
  });

  it("flags a serves that references a non-existent card", () => {
    const v = validateBoard("t", raws({
      "story-x": { type: "story", storyType: "bug", serves: "step-ghost" },
    }));
    expect(v).toHaveLength(1);
    expect(v[0].rule).toMatch(/does not exist/);
  });

  it("flags a serves that points at itself", () => {
    const v = validateBoard("t", raws({
      "story-x": { type: "story", storyType: "technical", serves: "story-x" },
    }));
    expect(v[0].rule).toMatch(/itself/);
  });

  it("flags a serves/parent cycle (A serves B, B serves A)", () => {
    const v = validateBoard("t", raws({
      "story-a": { type: "story", storyType: "technical", serves: "story-b" },
      "story-b": { type: "story", storyType: "technical", serves: "story-a" },
    }));
    expect(v.some((x) => /cycle/.test(x.rule))).toBe(true);
  });

  it("accepts a serves→story→step chain that terminates (no cycle)", () => {
    const v = validateBoard("t", raws({
      "act-1": { type: "activity" },
      "step-1": { type: "step", parent: "act-1" },
      "story-user": { type: "story", storyType: "user", parent: "step-1" },
      "story-bug": { type: "story", storyType: "bug", parent: "step-1", serves: "story-user" },
    }));
    expect(v).toEqual([]);
  });
});
