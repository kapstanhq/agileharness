// Pure, browser-free helpers for the card run console (CardConsoleModal). Kept
// out of the `"use client"` component so they're unit-testable in the `node`
// vitest env — the component imports these and only owns the DOM wiring.

import type { LogFrame } from "./types";

/**
 * Flatten the console frames into one plain-text blob — one frame per line — for the
 * "Copiar log" button. Robust to streaming output: the user gets the FULL log even
 * while a run is live and even when text selection inside the scroll area is fiddly.
 */
export function joinFramesText(frames: ReadonlyArray<Pick<LogFrame, "text">>): string {
  return frames.map((f) => f.text).join("\n");
}

/** Scroll metrics — the subset of an HTMLElement we need (so it's trivially testable). */
export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Is the viewport effectively pinned to the bottom (within `threshold` px)? Drives
 * the live console's "stick to tail" decision: we only auto-scroll on new frames when
 * the user is ALREADY at the bottom — if they scrolled up to read or select, the
 * stream must not yank the view away. `threshold` absorbs sub-pixel rounding and the
 * one-line gap that can open up between a frame arriving and the scroll settling.
 */
export function isNearBottom(m: ScrollMetrics, threshold = 24): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/**
 * Should a backdrop interaction close the modal? Only when the press STARTED on the
 * backdrop itself AND the click also landed on it — so a text selection that begins
 * inside the modal and is released over the backdrop (a drag-out) never closes it.
 */
export function shouldCloseOnBackdrop(opts: {
  downOnBackdrop: boolean;
  clickTargetIsBackdrop: boolean;
}): boolean {
  return opts.downOnBackdrop && opts.clickTargetIsBackdrop;
}
