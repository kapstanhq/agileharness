import { describe, expect, it } from "vitest";
import { isNearBottom, joinFramesText, shouldCloseOnBackdrop } from "./console";
import type { LogFrame } from "./types";

const frame = (seq: number, text: string): LogFrame => ({
  board: "acme",
  cardId: "c1",
  seq,
  level: "info",
  text,
  at: 0,
});

describe("joinFramesText", () => {
  it("joins every frame's text with newlines, in order", () => {
    const frames = [frame(1, "linha um"), frame(2, "linha dois"), frame(3, "linha três")];
    expect(joinFramesText(frames)).toBe("linha um\nlinha dois\nlinha três");
  });

  it("returns an empty string when there are no frames", () => {
    expect(joinFramesText([])).toBe("");
  });

  it("preserves internal newlines and blank frames (no trimming/collapsing)", () => {
    const frames = [frame(1, "a\nb"), frame(2, ""), frame(3, "c")];
    expect(joinFramesText(frames)).toBe("a\nb\n\nc");
  });
});

describe("isNearBottom", () => {
  it("is true when exactly pinned to the bottom", () => {
    expect(isNearBottom({ scrollTop: 800, clientHeight: 200, scrollHeight: 1000 })).toBe(true);
  });

  it("is true within the default threshold (sub-pixel / one-line gap)", () => {
    // 1000 - 780 - 200 = 20px from the bottom → within the 24px default.
    expect(isNearBottom({ scrollTop: 780, clientHeight: 200, scrollHeight: 1000 })).toBe(true);
  });

  it("is false when the user scrolled up past the threshold", () => {
    // 1000 - 400 - 200 = 400px from the bottom.
    expect(isNearBottom({ scrollTop: 400, clientHeight: 200, scrollHeight: 1000 })).toBe(false);
  });

  it("is false just past the boundary, true just inside it", () => {
    expect(isNearBottom({ scrollTop: 775, clientHeight: 200, scrollHeight: 1000 }, 24)).toBe(false); // 25px
    expect(isNearBottom({ scrollTop: 776, clientHeight: 200, scrollHeight: 1000 }, 24)).toBe(true); // 24px
  });

  it("treats a non-scrollable (short) console as at-bottom", () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 300 })).toBe(true);
  });
});

describe("shouldCloseOnBackdrop", () => {
  it("closes only when the press started on the backdrop AND the click landed on it (clean click)", () => {
    expect(shouldCloseOnBackdrop({ downOnBackdrop: true, clickTargetIsBackdrop: true })).toBe(true);
  });

  it("does NOT close when the press started inside the modal (drag-out selection released on backdrop)", () => {
    expect(shouldCloseOnBackdrop({ downOnBackdrop: false, clickTargetIsBackdrop: true })).toBe(false);
  });

  it("does NOT close when the click target is inside the modal", () => {
    expect(shouldCloseOnBackdrop({ downOnBackdrop: true, clickTargetIsBackdrop: false })).toBe(false);
    expect(shouldCloseOnBackdrop({ downOnBackdrop: false, clickTargetIsBackdrop: false })).toBe(false);
  });
});
