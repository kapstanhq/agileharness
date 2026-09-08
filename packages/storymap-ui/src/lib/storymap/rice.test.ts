import { describe, expect, it } from "vitest";
import { riceScore } from "./rice";
import type { Rice } from "./types";

const rice = (r: Partial<Rice>): Rice => ({
  reach: null,
  impact: null,
  confidence: null,
  effort: null,
  ...r,
});

// riceScore is the SINGLE source of truth for the hasRice + hasPrioritization
// gates AND the prioritization ranking (Row.score). A number where null was
// meant opens the gate on an unprioritized card; a null where a number was meant
// silently drops a valid card from every Top-N view.
describe("riceScore", () => {
  it("computes (reach*impact*confidence)/effort for a full, valid set", () => {
    expect(riceScore(rice({ reach: 100, impact: 2, confidence: 0.8, effort: 4 }))).toBe(40);
    expect(riceScore(rice({ reach: 10, impact: 3, confidence: 1, effort: 2 }))).toBe(15);
  });

  it("treats effort <= 0 as null (division by zero / negative is meaningless)", () => {
    expect(riceScore(rice({ reach: 100, impact: 2, confidence: 0.8, effort: 0 }))).toBeNull();
    expect(riceScore(rice({ reach: 100, impact: 2, confidence: 0.8, effort: -4 }))).toBeNull();
  });

  it("treats effort NaN as null (!(NaN > 0) === true)", () => {
    expect(riceScore(rice({ reach: 100, impact: 2, confidence: 0.8, effort: NaN }))).toBeNull();
  });

  it("returns 0 — NOT null — when reach is a legitimate 0", () => {
    // 0 is a real, lowest-priority score; it must NOT be conflated with "unset".
    expect(riceScore(rice({ reach: 0, impact: 2, confidence: 0.8, effort: 4 }))).toBe(0);
  });

  it("returns null if ANY of the four inputs is null/unset", () => {
    expect(riceScore(rice({ impact: 2, confidence: 0.8, effort: 4 }))).toBeNull(); // reach null
    expect(riceScore(rice({ reach: 100, confidence: 0.8, effort: 4 }))).toBeNull(); // impact null
    expect(riceScore(rice({ reach: 100, impact: 2, effort: 4 }))).toBeNull(); // confidence null
    expect(riceScore(rice({ reach: 100, impact: 2, confidence: 0.8 }))).toBeNull(); // effort null
    expect(riceScore(rice({}))).toBeNull(); // all null
  });

  it("returns null for a null/undefined rice object", () => {
    expect(riceScore(null)).toBeNull();
    expect(riceScore(undefined)).toBeNull();
  });
});
