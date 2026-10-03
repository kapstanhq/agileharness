import { describe, expect, it } from "vitest";
import { isUsageStale, parseHeadroomStats } from "./subscription";

// Shape of a `GET /stats` response (invented values): session 23%, week 61%, Sonnet 9%,
// extra-usage enabled with a monthly cap.
const STATS_FIXTURE = JSON.stringify({
  summary: { compression: { requests_compressed: 0, avg_compression_pct: 0, total_tokens_removed: 0 }, cost: { total_saved_usd: 0 } },
  tokens: { input: 0, output: 0, saved: 0, savings_percent: 0 },
  requests: { total: 0 },
  subscription_window: {
    latest: {
      five_hour: { utilization_pct: 23.0, seconds_to_reset: 9120, resets_at: "2026-02-17T11:42:00Z" },
      seven_day: { utilization_pct: 61.0, seconds_to_reset: 200400, resets_at: "2026-02-19T16:50:00Z" },
      seven_day_sonnet: { utilization_pct: 9.0, seconds_to_reset: 200400 },
      extra_usage: { is_enabled: true, monthly_limit_usd: 120.0, used_credits_usd: 12.5 },
      polled_at: "2026-02-17T09:10:00Z",
    },
  },
});

describe("parseHeadroomStats — subscription window (the /usage numbers)", () => {
  it("maps the 5h / 7d / Sonnet windows verbatim", () => {
    const { usage } = parseHeadroomStats(STATS_FIXTURE);
    expect(usage?.source).toBe("subscription");
    expect(usage?.session?.usedPct).toBe(23);
    expect(usage?.week?.usedPct).toBe(61);
    expect(usage?.weekSonnet?.usedPct).toBe(9);
    // seconds_to_reset → minutes
    expect(usage?.session?.resetsInMinutes).toBe(Math.round(9120 / 60));
    expect(usage?.week?.resetsInMinutes).toBe(Math.round(200400 / 60));
  });

  it("keeps the ABSOLUTE reset instant when the proxy reports `resets_at` (null when it does not)", () => {
    const { usage } = parseHeadroomStats(STATS_FIXTURE);
    expect(usage?.week?.resetsAt).toBe(Date.parse("2026-02-19T16:50:00Z"));
    expect(usage?.session?.resetsAt).toBe(Date.parse("2026-02-17T11:42:00Z"));
    expect(usage?.weekSonnet?.resetsAt).toBeNull(); // o fixture não traz resets_at nesta janela
  });

  it("reads extra-usage credits and the poll timestamp", () => {
    const { usage } = parseHeadroomStats(STATS_FIXTURE);
    expect(usage?.extra).toEqual({ enabled: true, usedUsd: 12.5, limitUsd: 120 });
    expect(usage?.polledAt).toBe(Date.parse("2026-02-17T09:10:00Z"));
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
      summary: { compression: { requests_compressed: 85, avg_compression_pct: 3.4 }, cost: { total_saved_usd: 1.7 } },
      tokens: { saved: 640_000, savings_percent: 8.6 },
    });
    const { savings } = parseHeadroomStats(raw);
    expect(savings).toEqual({
      savingsPct: 8.6,
      avgCompressionPct: 3.4,
      tokensSaved: 640_000,
      requestsCompressed: 85,
      savedUsd: 1.7,
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
  const now = Date.parse("2026-02-17T19:45:00Z");
  const maxAge = 20 * 60_000; // 20min budget

  it("is fresh when the poll is within the budget", () => {
    expect(isUsageStale(now - 5 * 60_000, now, maxAge)).toBe(false);
    expect(isUsageStale(now, now, maxAge)).toBe(false);
  });

  it("is stale when the poll is older than the budget (a poll that stopped refreshing)", () => {
    expect(isUsageStale(now - 21 * 60_000, now, maxAge)).toBe(true);
    expect(isUsageStale(Date.parse("2026-02-16T03:54:17Z"), now, maxAge)).toBe(true);
  });

  it("treats an absent poll timestamp as stale (never assumes fresh)", () => {
    expect(isUsageStale(null, now, maxAge)).toBe(true);
  });

  it("is exactly-at-budget fresh (boundary is strictly greater-than)", () => {
    expect(isUsageStale(now - maxAge, now, maxAge)).toBe(false);
    expect(isUsageStale(now - maxAge - 1, now, maxAge)).toBe(true);
  });
});
