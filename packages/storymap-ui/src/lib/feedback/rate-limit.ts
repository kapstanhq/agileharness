// A small fixed-window rate limiter for the feedback intake's UNTRUSTED lanes (relay + embed).
//
// WHY at all: those lanes are reachable by anyone who can load the product app, and each accepted
// batch spawns a triage agent — an expensive, LLM-backed side effect. Without a ceiling, one page
// looping submit() is an unbounded bill and a flooded Triagem column.
//
// WHY fixed-window and in-process: the board is ONE Next server (systemd, single instance), so a
// module-level counter is a truthful ceiling here — not an approximation of a distributed one. It is
// deliberately NOT a security boundary (a determined caller who already has a valid token can still
// send `limit` batches per window); it is the blast-radius cap on accidents and casual abuse. If the
// board ever runs multiple replicas, this must move to the proxy — the shape below (verdict + retry
// hint) is what a proxy-based limiter would return too, so callers won't change.
//
// Pure: the clock is injected, so the tests pin behaviour at window edges instead of sleeping.

export interface RateLimitVerdict {
  ok: boolean;
  /** ms until the current window rolls over — 0 when the request was allowed. */
  retryAfterMs: number;
  /** how many requests remain in this window after this one (0 when refused). */
  remaining: number;
}

export interface RateLimiterOptions {
  /** requests allowed per window, per key. */
  limit: number;
  windowMs: number;
  /** memory ceiling: distinct keys tracked at once (a hostile caller can't grow the map forever). */
  maxKeys?: number;
}

export interface RateLimiter {
  take(key: string, now: number): RateLimitVerdict;
}

interface Window {
  start: number;
  count: number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  const maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 1000));
  const windows = new Map<string, Window>();

  /** Evict expired windows; if the map is STILL at the ceiling, drop it entirely rather than grow.
   *  A full reset is the safe direction here: it can only ever be more permissive for one window, and
   *  it keeps an attacker from turning distinct keys into unbounded memory. */
  function evict(now: number): void {
    for (const [k, w] of windows) {
      if (now - w.start >= windowMs) windows.delete(k);
    }
    if (windows.size >= maxKeys) windows.clear();
  }

  return {
    take(key: string, now: number): RateLimitVerdict {
      const current = windows.get(key);
      if (!current || now - current.start >= windowMs) {
        if (windows.size >= maxKeys) evict(now);
        windows.set(key, { start: now, count: 1 });
        return { ok: true, retryAfterMs: 0, remaining: limit - 1 };
      }
      if (current.count >= limit) {
        return { ok: false, retryAfterMs: Math.max(1, current.start + windowMs - now), remaining: 0 };
      }
      current.count += 1;
      return { ok: true, retryAfterMs: 0, remaining: limit - current.count };
    },
  };
}
