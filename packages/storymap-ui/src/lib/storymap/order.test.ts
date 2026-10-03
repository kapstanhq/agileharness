import { describe, expect, it } from "vitest";
import { byOrder, byUpdatedDesc, midpoint, ORDER_STEP } from "./order";
import type { Card } from "./types";

// Sparse ordering for drag-and-drop: a single move rewrites only one card file.
describe("midpoint", () => {
  it("returns ORDER_STEP for an empty list (both neighbours undefined)", () => {
    expect(midpoint(undefined, undefined)).toBe(ORDER_STEP); // 10
  });

  it("inserts at the head: b - ORDER_STEP", () => {
    expect(midpoint(undefined, 20)).toBe(10);
  });

  it("inserts at the tail: a + ORDER_STEP (the new-card / nextOrder path)", () => {
    expect(midpoint(10, undefined)).toBe(20);
  });

  it("inserts between two neighbours: the arithmetic mean", () => {
    expect(midpoint(5, 15)).toBe(10);
    expect(midpoint(10, 11)).toBe(10.5);
  });

  it("treats 0 as a real value, NOT as null (loose-eq guard)", () => {
    // midpoint(0, 10) must be 5, never -10 — 0 is a valid order key.
    expect(midpoint(0, 10)).toBe(5);
    expect(midpoint(0, undefined)).toBe(10); // tail after a 0-ordered card
  });

  it("KNOWN EDGE — equal neighbours produce a COLLIDING key", () => {
    // (10 + 10) / 2 === 10, i.e. the new card shares its neighbours' order.
    // This only arises if two siblings already hold the same order; byOrder's
    // id tiebreak keeps rendering deterministic, so it is not corrupting today.
    // Pinned to document the behavior — a true fix (rebalancing when gaps close)
    // belongs in the reorder caller, not in midpoint(). See order.test notes.
    expect(midpoint(10, 10)).toBe(10);
  });
});

describe("byOrder — stable comparator", () => {
  const c = (id: string, order: number): Card => ({ id, order } as Card);

  it("sorts ascending by numeric order", () => {
    const sorted = [c("a", 30), c("b", 10), c("d", 20)].sort(byOrder).map((x) => x.id);
    expect(sorted).toEqual(["b", "d", "a"]);
  });

  it("breaks ties by id for determinism when orders are equal", () => {
    const sorted = [c("zebra", 10), c("apple", 10), c("mango", 10)].sort(byOrder).map((x) => x.id);
    expect(sorted).toEqual(["apple", "mango", "zebra"]);
  });

  it("is sign-correct: lower id sorts first at equal order", () => {
    expect(byOrder(c("a", 10), c("b", 10))).toBeLessThan(0);
    expect(byOrder(c("b", 10), c("a", 10))).toBeGreaterThan(0);
  });
});

// The kanban columns put the most-recently-touched card on top. mtime (updatedMs) is
// the primary signal; the day-granular `updated` date, then order, then id are the
// deterministic fallbacks for cards with no/equal mtime.
describe("byUpdatedDesc — recency comparator (most-recent on top)", () => {
  const c = (id: string, fields: Partial<Card>): Card =>
    ({ id, order: 0, updated: null, ...fields } as Card);

  it("sorts by file mtime descending — newest first", () => {
    const sorted = [
      c("old", { updatedMs: 100 }),
      c("new", { updatedMs: 300 }),
      c("mid", { updatedMs: 200 }),
    ]
      .sort(byUpdatedDesc)
      .map((x) => x.id);
    expect(sorted).toEqual(["new", "mid", "old"]);
  });

  it("a just-touched card (larger ms) rises above same-day siblings", () => {
    // Both updated the SAME day; only mtime distinguishes them → the bumped one wins.
    const a = c("a", { updated: "2026-06-03", updatedMs: 1_000 });
    const justBumped = c("b", { updated: "2026-06-03", updatedMs: 9_999 });
    expect([a, justBumped].sort(byUpdatedDesc).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("falls back to the `updated` date when mtime is absent (e.g. fresh clone)", () => {
    const older = c("older", { updated: "2026-06-01" });
    const newer = c("newer", { updated: "2026-06-03" });
    expect([older, newer].sort(byUpdatedDesc).map((x) => x.id)).toEqual(["newer", "older"]);
  });

  it("sinks cards with no recency info at all (null date + no mtime) to the bottom", () => {
    const dated = c("dated", { updated: "2026-06-02" });
    const undatedA = c("z-undated", {});
    const undatedB = c("a-undated", {});
    const sorted = [undatedA, dated, undatedB].sort(byUpdatedDesc).map((x) => x.id);
    // dated first; the two recency-less cards follow, deterministically ordered by id.
    expect(sorted).toEqual(["dated", "a-undated", "z-undated"]);
  });

  it("breaks a full tie (same mtime + same date) by order then id — deterministic", () => {
    const base = { updated: "2026-06-03", updatedMs: 500 };
    const sorted = [
      c("b", { ...base, order: 20 }),
      c("a", { ...base, order: 20 }),
      c("c", { ...base, order: 10 }),
    ]
      .sort(byUpdatedDesc)
      .map((x) => x.id);
    expect(sorted).toEqual(["c", "a", "b"]);
  });
});
