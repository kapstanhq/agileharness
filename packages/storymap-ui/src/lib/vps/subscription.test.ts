import { describe, expect, it } from "vitest";
import { isUsageStale, parseHeadroomStats } from "./subscription";

// Trimmed from a real `GET /stats` capture (2026-06-09) — the same window the user sees in
// Claude's `/usage`: session 7%, week 98%, Sonnet 14%, extra-usage enabled, $250/mo cap.
const STATS_FIXTURE = JSON.stringify({
  summary: { compression: { requests_compressed: 0, avg_compression_pct: 0, total_tokens_removed: 0 }, cost: { total_saved_usd: 0 } },
  tokens: { input: 0, output: 0, saved: 0, savings_percent: 0 },
  requests: { total: 0 },
  subscription_window: {
    latest: {
      five_hour: { utilization_pct: 7.0, seconds_to_reset: 13947, resets_at: "2026-06-09T19:20:00Z" },
      seven_day: { utilization_pct: 98.0, seconds_to_reset: 48747, resets_at: "2026-06-10T05:00:00Z" },
      seven_day_sonnet: { utilization_pct: 14.0, seconds_to_reset: 48747 },
      extra_usage: { is_enabled: true, monthly_limit_usd: 250.0, used_credits_usd: 0.0 },
      polled_at: "2026-06-09T15:25:38Z",
    },
  },
});

describe("parseHeadroomStats — subscription window (the real /usage numbers)", () => {
  it("maps the 5h / 7d / Sonnet windows verbatim", () => {
    const { usage } = parseHeadroomStats(STATS_FIXTURE);
    expect(usage?.source).toBe("subscription");
    expect(usage?.session?.usedPct).toBe(7);
    expect(usage?.week?.usedPct).toBe(98);
    expect(usage?.weekSonnet?.usedPct).toBe(14);
    // seconds_to_reset → minutes
    expect(usage?.session?.resetsInMinutes).toBe(Math.round(13947 / 60));
    expect(usage?.week?.resetsInMinutes).toBe(Math.round(48747 / 60));
  });

  it("reads extra-usage credits and the poll timestamp", () => {
    const { usage } = parseHeadroomStats(STATS_FIXTURE);
    expect(usage?.extra).toEqual({ enabled: true, usedUsd: 0, limitUsd: 250 });
    expect(usage?.polledAt).toBe(Date.parse("2026-06-09T15:25:38Z"));
  });

  it("sets stale=false as a placeholder (metrics.ts owns the clock-based recompute)", () => {
    const { usage } = parseHeadroomStats(STATS_FIXTURE);
    expect(usage?.stale).toBe(false);
  });

  it("reports compression effectiveness honestly — 0 requests when nothing flowed through", () => {
    const { savings } = parseHeadroomStats(STATS_FIXTURE);
    expect(savings).toEqual({ savingsPct: 0, avgCompressionPct: 0, tokensSaved: 0, requestsCompressed: 0, savedUsd: 0 });
  });

  it("surfaces real savings + avg per-request compression when the proxy has compressed traffic", () => {
    const raw = JSON.stringify({
      summary: { compression: { requests_compressed: 340, avg_compression_pct: 2.8 }, cost: { total_saved_usd: 4.1 } },
      tokens: { saved: 1_200_000, savings_percent: 12.3 },
    });
    const { savings } = parseHeadroomStats(raw);
    expect(savings).toEqual({
      savingsPct: 12.3,
      avgCompressionPct: 2.8,
      tokensSaved: 1_200_000,
      requestsCompressed: 340,
      savedUsd: 4.1,
    });
  });

  it("degrades to null on garbage / missing sections (never throws)", () => {
    expect(parseHeadroomStats("not json")).toEqual({ usage: null, savings: null });
    expect(parseHeadroomStats("{}")).toEqual({ usage: null, savings: null });
    // a subscription block with no parseable bucket is treated as absent
    expect(parseHeadroomStats(JSON.stringify({ subscription_window: { latest: { five_hour: {} } } })).usage).toBeNull();
  });
});

describe("isUsageStale — freshness budget for the subscription poll", () => {
  const now = Date.parse("2026-06-19T19:45:00Z");
  const maxAge = 20 * 60_000; // 20min budget

  it("is fresh when the poll is within the budget", () => {
    expect(isUsageStale(now - 5 * 60_000, now, maxAge)).toBe(false);
    expect(isUsageStale(now, now, maxAge)).toBe(false);
  });

  it("is stale when the poll is older than the budget (the 40h-frozen bug)", () => {
    expect(isUsageStale(now - 21 * 60_000, now, maxAge)).toBe(true);
    expect(isUsageStale(Date.parse("2026-06-18T03:54:17Z"), now, maxAge)).toBe(true);
  });

  it("treats an absent poll timestamp as stale (never assumes fresh)", () => {
    expect(isUsageStale(null, now, maxAge)).toBe(true);
  });

  it("is exactly-at-budget fresh (boundary is strictly greater-than)", () => {
    expect(isUsageStale(now - maxAge, now, maxAge)).toBe(false);
    expect(isUsageStale(now - maxAge - 1, now, maxAge)).toBe(true);
  });
});
