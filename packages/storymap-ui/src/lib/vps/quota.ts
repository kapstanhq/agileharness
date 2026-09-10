// The `quota` block behind GET /api/terminal/meter — "quanto da cota já foi, e o ritmo de agora
// estoura a janela antes dela resetar?" — derived from ONE authoritative source and explicitly
// marked as an estimate whenever it is not that source.
//
// THE HEADLINE IS THE SUBSCRIPTION WINDOW (`VpsMetrics.usage`, source "subscription"): what the
// headroom proxy polls straight from Anthropic, i.e. the same numbers Claude's `/usage` screen
// shows. ccusage (`VpsMetrics.tokens`) is a FALLBACK and is ALWAYS flagged `approximate: true`,
// because its percentage is a ratio against a GUESSED budget (`DEFAULT_WEEKLY_TOKEN_LIMIT =
// 760_000_000`, metrics.ts) — live, ccusage reported 100% consumed while the real subscription week
// said 17%. Promoting that to the headline tells the operator to stop working with 83% of the week
// still in hand; that is the exact lie this module exists to refuse.
//
// `stale` is ALWAYS recomputed here from `polledAt` against the caller's `now`. `parseHeadroomStats`
// writes a placeholder `false` because it has no clock (subscription.ts), and `readQuota` serves a
// snapshot that may be up to 60 s old on top of MetricsHub's own cache — so a trusted flag would age
// silently and present a frozen poll as the live figure.
//
// `projectBucket` is LINEAR EXTRAPOLATION over a rolling window: an approximation, which is why the
// UI carries the `≈` marker and why it refuses to answer before 5% of the window has elapsed
// (extrapolating a 7-day week from 5 minutes of data is noise, not a forecast) and why a zero burn
// rate yields `minutesToLimit: null` instead of `Infinity`.
//
// It must NEVER: invent a bucket the proxy did not report (a window absent from the payload is
// absent from the array — never a zeroed third bar); clamp or round a percentage into a friendlier
// story; or throw. Every failure — timeout, cold hub, no window at all — returns `null`, so the
// caller renders an honest absent state instead of a confident zero.
//
// Server-only (the default reader touches MetricsHub, which spawns ccusage and fetches the proxy).

import { getMetricsHub } from "./metrics";
import { isUsageStale } from "./subscription";
import type { TokenWindow, UsageBucket, UsageWindow, VpsMetrics } from "./types";

/** Length of each rolling window, in minutes: 5h session, 7d week, 7d Sonnet-only. */
export const WINDOW_MINUTES = { session: 300, week: 10080, weekSonnet: 10080 } as const;

export type QuotaBucketId = keyof typeof WINDOW_MINUTES;

/** Emission order of `QuotaBlock.buckets` — session first (the tightest), then the two weeklies. */
const BUCKET_ORDER: readonly QuotaBucketId[] = ["session", "week", "weekSonnet"];

/** Below this fraction of the window elapsed, the extrapolation is noise and we decline to answer. */
const MIN_ELAPSED_FRACTION = 0.05;

/** How long a metrics snapshot is reused before a fresh read (the §1.6 cadence table). */
const QUOTA_TTL_MS = 60_000;

/** Hard ceiling on the read itself — a cold/wedged hub must never stall the meter request. */
const QUOTA_TIMEOUT_MS = 2_000;

/** Freshness budget for the proxy's subscription poll. Same env knob metrics.ts reads (it keeps its
 *  own private copy); the env var — not either copy — is the single source of truth. */
const DEFAULT_USAGE_MAX_AGE_MIN = 20;

/** The projection for one window: where this burn rate lands by the time the window resets. */
export interface Burn {
  /** usedPct × windowMinutes ÷ elapsedMinutes, 1 decimal. NOT clamped — 240 means 240. */
  projectedPct: number;
  /** projectedPct >= 100 — read off the ROUNDED value so the flag and the printed number agree */
  willExceedBeforeReset: boolean;
  /** (100 − usedPct) ÷ rate, integer minutes; null when the rate is 0 (never Infinity) */
  minutesToLimit: number | null;
}

/** One rolling window, as the meter renders it. */
export interface QuotaBucket {
  id: QuotaBucketId;
  /** 0..100 — % of the window already consumed, verbatim from the source */
  usedPct: number;
  /** minutes until this window resets */
  resetsInMinutes: number;
  /** null when it is too early to extrapolate, or the burn rate is 0 */
  burn: Burn | null;
}

/** The `quota` field of the meter payload. `null` (not an empty block) when nothing is knowable. */
export interface QuotaBlock {
  source: "subscription" | "ccusage";
  /** true iff source === "ccusage" — the UI prefixes the value with `≈` and mutes it */
  approximate: boolean;
  /** recomputed against the caller's `now`, never trusted from the parser */
  stale: boolean;
  polledAt: number | null;
  /** ccusage's window cost when known; null otherwise (never a fabricated 0) */
  costUSD: number | null;
  /** ordered session → week → weekSonnet, INCLUDING ONLY the windows actually reported */
  buckets: QuotaBucket[];
}

/** Snapshot source. Injectable so the pure decision logic is testable with zero IO. */
export type MetricsReader = () => Promise<VpsMetrics>;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * PURE. Project a rolling window forward at its current average rate.
 *
 * `elapsed = windowMinutes − resetsInMinutes`. Returns null when any input is non-finite, when the
 * window length is not positive, or when less than 5% of the window has elapsed — the honest answer
 * early in a window is "I don't know yet", not a number extrapolated from a handful of minutes.
 * A zero (or negative) rate yields `minutesToLimit: null` rather than Infinity.
 */
export function projectBucket(b: { usedPct: number; resetsInMinutes: number }, windowMinutes: number): Burn | null {
  if (!b || !finite(b.usedPct) || !finite(b.resetsInMinutes) || !finite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }
  const elapsedMinutes = windowMinutes - b.resetsInMinutes;
  if (elapsedMinutes < windowMinutes * MIN_ELAPSED_FRACTION) return null;

  const projectedPct = round1((b.usedPct * windowMinutes) / elapsedMinutes);
  const ratePctPerMin = b.usedPct / elapsedMinutes;
  return {
    projectedPct,
    willExceedBeforeReset: projectedPct >= 100,
    minutesToLimit: ratePctPerMin > 0 ? Math.max(0, Math.round((100 - b.usedPct) / ratePctPerMin)) : null,
  };
}

function toBucket(id: QuotaBucketId, raw: UsageBucket | null | undefined): QuotaBucket | null {
  if (!raw || !finite(raw.usedPct) || !finite(raw.resetsInMinutes)) return null;
  return {
    id,
    usedPct: raw.usedPct,
    resetsInMinutes: raw.resetsInMinutes,
    burn: projectBucket({ usedPct: raw.usedPct, resetsInMinutes: raw.resetsInMinutes }, WINDOW_MINUTES[id]),
  };
}

/** The reported windows, in emission order. A window the proxy omits is simply not in the array. */
function subscriptionBuckets(usage: UsageWindow | null): QuotaBucket[] {
  if (!usage) return [];
  const out: QuotaBucket[] = [];
  for (const id of BUCKET_ORDER) {
    const bucket = toBucket(id, usage[id]);
    if (bucket) out.push(bucket);
  }
  return out;
}

/** ccusage aggregates the WEEKLY window (metrics.ts readTokens) — it is a week bucket, never a session one. */
function ccusageBucket(tokens: TokenWindow | null): QuotaBucket | null {
  if (!tokens || !finite(tokens.usedPct)) return null;
  return toBucket("week", { usedPct: tokens.usedPct, resetsInMinutes: tokens.resetsInMinutes });
}

function configuredUsageMaxAgeMs(): number {
  const env = Number(process.env.AGILEHARNESS_USAGE_MAX_AGE_MIN);
  const min = Number.isFinite(env) && env > 0 ? env : DEFAULT_USAGE_MAX_AGE_MIN;
  return Math.floor(min * 60_000);
}

/** PURE. Snapshot → the block, preferring the subscription window and marking the fallback. */
function buildQuotaBlock(m: VpsMetrics, now: number, maxAgeMs: number): QuotaBlock | null {
  const costUSD = finite(m.tokens?.costUSD) ? (m.tokens as TokenWindow).costUSD : null;

  const buckets = subscriptionBuckets(m.usage ?? null);
  if (buckets.length > 0) {
    const polledAt = m.usage?.polledAt ?? null;
    return {
      source: "subscription",
      approximate: false,
      stale: isUsageStale(polledAt, now, maxAgeMs),
      polledAt,
      costUSD,
      buckets,
    };
  }

  const fallback = ccusageBucket(m.tokens ?? null);
  if (!fallback) return null;
  // ccusage has no `polled_at` of its own: metrics.ts recomputes it at collect time (30 s cache), so
  // the snapshot's own clock IS its poll time.
  const polledAt = finite(m.at) ? m.at : null;
  return {
    source: "ccusage",
    approximate: true,
    stale: isUsageStale(polledAt, now, maxAgeMs),
    polledAt,
    costUSD,
    buckets: [fallback],
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cache: { at: number; metrics: VpsMetrics } | null = null;

/** Drop the memoised snapshot. For tests, and for any caller that must force a fresh read. */
export function clearQuotaCache(): void {
  cache = null;
}

async function liveMetrics(): Promise<VpsMetrics> {
  return getMetricsHub().current();
}

/**
 * IO, best-effort — NEVER throws. 60 s TTL over the metrics snapshot with a hard 2 s timeout;
 * a timeout, a failed read or a box with no window at all returns `null` so the caller renders an
 * honest absent state (an empty block would render as a quota of zero, which is a different claim).
 *
 * Only the SNAPSHOT is cached — the block is rebuilt on every call, so `stale` and every burn
 * projection track the caller's clock instead of freezing for a minute.
 *
 * @param now  epoch ms — the one clock governing TTL, staleness and projections
 * @param read snapshot source; injectable so tests exercise the real decision path with zero IO
 */
export async function readQuota(now: number = Date.now(), read: MetricsReader = liveMetrics): Promise<QuotaBlock | null> {
  let metrics: VpsMetrics | null = null;
  const age = cache ? now - cache.at : Number.POSITIVE_INFINITY;
  // `age >= 0` guards a clock that moved backwards: a snapshot from the "future" is not a hit.
  if (cache && age >= 0 && age < QUOTA_TTL_MS) {
    metrics = cache.metrics;
  } else {
    try {
      metrics = await withTimeout(read(), QUOTA_TIMEOUT_MS);
    } catch {
      metrics = null;
    }
    if (metrics) cache = { at: now, metrics };
  }
  if (!metrics) return null;

  try {
    return buildQuotaBlock(metrics, now, configuredUsageMaxAgeMs());
  } catch {
    return null;
  }
}
