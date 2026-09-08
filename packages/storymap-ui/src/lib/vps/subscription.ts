// Parse the headroom proxy's `/stats` JSON into our UsageWindow + HeadroomSavings. PURE
// (no fetch/fs) so it is unit-testable against a captured fixture; metrics.ts owns the fetch.
//
// The headroom proxy polls Anthropic's subscription endpoint and exposes, under
// `subscription_window.latest`, the SAME numbers Claude's `/usage` screen shows — the
// authoritative figure ccusage cannot see (5h session, 7d week, 7d Sonnet, extra-usage).
// It also reports its own compression effectiveness (tokens/requests saved), which lets the
// UI prove the proxy is working rather than merely "connected".
//
// DEFENSIVE: the proxy's JSON shape is large and shifts across versions, so every field is
// read optionally and the parser degrades to null rather than throwing.

import type { HeadroomSavings, UsageBucket, UsageWindow } from "./types";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
function minutesFromSeconds(v: unknown): number {
  const s = num(v);
  return s != null ? Math.max(0, Math.round(s / 60)) : 0;
}

/**
 * Has the proxy's subscription poll gone stale? PURE so metrics.ts can recompute it every
 * snapshot against a fresh `now` (freshness depends on wall-clock, not on poll time, so it must
 * NOT be frozen into the cached window). A null `polledAt` counts as stale — unknown freshness is
 * treated conservatively, never as "fresh".
 *
 * @param polledAt epoch ms the proxy last polled Anthropic (UsageWindow.polledAt), or null
 * @param now      epoch ms
 * @param maxAgeMs the freshness budget — older than this is stale
 */
export function isUsageStale(polledAt: number | null, now: number, maxAgeMs: number): boolean {
  if (polledAt == null) return true;
  return now - polledAt > maxAgeMs;
}

/** One subscription window → UsageBucket (null when the % is absent). */
function bucket(raw: any): UsageBucket | null {
  if (!raw || typeof raw !== "object") return null;
  const pct = num(raw.utilization_pct);
  if (pct == null) return null;
  return { usedPct: clampPct(pct), resetsInMinutes: minutesFromSeconds(raw.seconds_to_reset) };
}

/**
 * @param raw stdout/body of the proxy's `GET /stats`
 * @returns the real usage windows and the proxy's compression effectiveness (each null when absent)
 */
export function parseHeadroomStats(raw: string): { usage: UsageWindow | null; savings: HeadroomSavings | null } {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return { usage: null, savings: null };
  }

  // --- subscription window (the real /usage numbers) -----------------------
  let usage: UsageWindow | null = null;
  const latest = data?.subscription_window?.latest;
  if (latest && typeof latest === "object") {
    const session = bucket(latest.five_hour);
    const week = bucket(latest.seven_day);
    const weekSonnet = bucket(latest.seven_day_sonnet);
    const ex = latest.extra_usage;
    const extra =
      ex && typeof ex === "object"
        ? { enabled: !!ex.is_enabled, usedUsd: num(ex.used_credits_usd) ?? 0, limitUsd: num(ex.monthly_limit_usd) ?? 0 }
        : null;
    const polledAtRaw = typeof latest.polled_at === "string" ? Date.parse(latest.polled_at) : NaN;
    // Only build a window when at least one bucket parsed — otherwise it's just noise.
    if (session || week || weekSonnet) {
      usage = {
        source: "subscription",
        session,
        week,
        weekSonnet,
        extra,
        polledAt: Number.isFinite(polledAtRaw) ? polledAtRaw : null,
        // Placeholder — this parser has no clock; metrics.ts recomputes it against `now`.
        stale: false,
      };
    }
  }

  // --- compression effectiveness -------------------------------------------
  let savings: HeadroomSavings | null = null;
  const tokens = data?.tokens;
  const compression = data?.summary?.compression;
  if ((tokens && typeof tokens === "object") || (compression && typeof compression === "object")) {
    const savingsPct = num(tokens?.savings_percent) ?? num(compression?.avg_compression_pct) ?? 0;
    const avgCompressionPct = num(compression?.avg_compression_pct) ?? 0;
    const tokensSaved = num(tokens?.saved) ?? num(compression?.total_tokens_removed) ?? 0;
    const requestsCompressed = num(compression?.requests_compressed) ?? num(data?.requests?.total) ?? 0;
    const savedUsd = num(data?.summary?.cost?.total_saved_usd) ?? num(data?.cost?.savings_usd) ?? 0;
    savings = {
      savingsPct: clampPct(savingsPct),
      avgCompressionPct: clampPct(avgCompressionPct),
      tokensSaved: Math.max(0, Math.round(tokensSaved)),
      requestsCompressed: Math.max(0, Math.round(requestsCompressed)),
      savedUsd: Math.max(0, savedUsd),
    };
  }

  return { usage, savings };
}
