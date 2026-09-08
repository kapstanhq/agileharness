import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter — the ceiling on the untrusted lanes", () => {
  it("allows exactly `limit` per window and refuses the next", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(rl.take("a", 0).ok).toBe(true);
    expect(rl.take("a", 10).ok).toBe(true);
    expect(rl.take("a", 20).ok).toBe(true);
    const refused = rl.take("a", 30);
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it("tells the caller WHEN to come back (the Retry-After hint)", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    rl.take("a", 500);
    expect(rl.take("a", 700).retryAfterMs).toBe(800); // window started at 500 → rolls at 1500
  });

  it("rolls over exactly at the window edge, not a tick before", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    rl.take("a", 0);
    expect(rl.take("a", 999).ok).toBe(false);
    expect(rl.take("a", 1000).ok).toBe(true);
  });

  it("keys are independent — one noisy consumer can't starve another", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.take("ingest:acme", 0).ok).toBe(true);
    expect(rl.take("ingest:acme", 1).ok).toBe(false);
    expect(rl.take("ingest:storymap", 1).ok).toBe(true);
  });

  it("is BOUNDED in memory — distinct keys can't grow the map forever", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 8 });
    // 200 distinct keys inside ONE window: without eviction this would retain all 200.
    for (let i = 0; i < 200; i++) expect(rl.take(`k${i}`, 10).ok).toBe(true);
    // Eviction may forget an earlier key (more permissive, never less) — what must hold is that the
    // limiter still LIMITS after the churn.
    expect(rl.take("stable", 20).ok).toBe(true);
    expect(rl.take("stable", 21).ok).toBe(false);
  });

  it("a degenerate config is coerced, never trusted as-is", () => {
    const rl = createRateLimiter({ limit: 0, windowMs: 0 });
    expect(rl.take("a", 0).ok).toBe(true); // limit floors at 1 rather than blocking everything
  });
});
