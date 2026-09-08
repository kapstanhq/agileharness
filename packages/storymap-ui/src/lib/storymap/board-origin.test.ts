import { describe, expect, it } from "vitest";
import { classifyOrigin, isBaseOrigin } from "./board-origin";

describe("classifyOrigin (5.2) — where a board-config entry came from", () => {
  const base = new Set(["full", "standard", "express"]);
  const own = new Set(["express", "board-only"]);

  it("'base-inherited' when the id is only in _base", () => {
    expect(classifyOrigin("full", own, base)).toBe("base-inherited");
    expect(classifyOrigin("standard", own, base)).toBe("base-inherited");
  });
  it("'base-override' when the id is in BOTH own raw and _base", () => {
    expect(classifyOrigin("express", own, base)).toBe("base-override");
  });
  it("'board' when the id is only in the board's own raw", () => {
    expect(classifyOrigin("board-only", own, base)).toBe("board");
  });
  it("opt-out board (empty baseKeys) → everything reads as 'board'", () => {
    expect(classifyOrigin("express", own, new Set())).toBe("board");
  });

  it("isBaseOrigin: true for inherited/override, false for board", () => {
    expect(isBaseOrigin("base-inherited")).toBe(true);
    expect(isBaseOrigin("base-override")).toBe(true);
    expect(isBaseOrigin("board")).toBe(false);
  });
});
