// VPS metrics collector + a process-global hub the SSE route subscribes to.
//
// RAM (/proc/meminfo → MemAvailable, falling back to os), disk (fs.statfs on the repo
// mount), CPU load (os.loadavg) and the Claude Code usage window (ccusage, cached). The
// hub polls every POLL_MS while at least one stream is connected and fans the snapshot to
// all subscribers — exactly like the runner registry. Token data is refreshed on a slower
// cadence (ccusage spawns a child) and reused between polls.
//
// SERVER-ONLY (node:*). Singleton via globalThis Symbol (survives Next HMR), mirroring
// getRunnerRegistry / getBroadcaster.

import { readFileSync, promises as fsp } from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { findRepoRoot, settingsPath } from "@/lib/storymap/paths";
import { parseWeeklyTokenWindow } from "./ccusage";
import { isUsageStale, parseHeadroomStats } from "./subscription";
import type { DiskMetric, HeadroomSavings, LoadMetric, RamMetric, TokenWindow, UsageWindow, VpsMetrics } from "./types";

const pexec = promisify(execFile);

const POLL_MS = 15_000;
// ccusage spawns a child (bunx download on first run) → refresh less often than the cheap
// /proc reads; the reset countdown is recomputed every poll regardless (see collect()).
const TOKENS_TTL_MS = 30_000;

function pct(used: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10)) : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Exported for the terminal meter route: one `/proc/meminfo` read, cheap enough to ride that poll
 *  without pulling in the whole snapshot (disk + load + ccusage) the hub collects. */
export async function readRam(): Promise<RamMetric | null> {
  try {
    // MemAvailable is the truthful "free" figure (os.freemem is MemFree, which undercounts
    // reclaimable cache). Linux only; fall through to os on other platforms.
    const info = await fsp.readFile("/proc/meminfo", "utf8");
    const kb = (key: string): number | null => {
      const m = info.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("MemTotal");
    const avail = kb("MemAvailable");
    if (total && avail != null) {
      const used = Math.max(0, total - avail);
      return { totalBytes: total, usedBytes: used, availBytes: avail, usedPct: pct(used, total) };
    }
  } catch {
    /* not linux / no /proc */
  }
  const total = os.totalmem();
  const free = os.freemem();
  if (!total) return null;
  const used = Math.max(0, total - free);
  return { totalBytes: total, usedBytes: used, availBytes: free, usedPct: pct(used, total) };
}

async function readDisk(path: string): Promise<DiskMetric | null> {
  try {
    // fs.statfs is available on Node 18.15+ (we're on 22). Block counts × block size.
    const st: any = await (fsp as any).statfs(path);
    const bsize = Number(st.bsize) || 0;
    const total = Number(st.blocks) * bsize;
    const avail = Number(st.bavail) * bsize;
    const used = total - Number(st.bfree) * bsize;
    if (!total) return null;
    return { totalBytes: total, usedBytes: Math.max(0, used), availBytes: avail, usedPct: pct(used, total), mount: path };
  } catch {
    return null;
  }
}

function readLoad(): LoadMetric | null {
  try {
    const [a1, a5, a15] = os.loadavg();
    const cores = os.cpus()?.length || 1;
    return { avg1: round2(a1), avg5: round2(a5), avg15: round2(a15), cores, pct1: pct(a1, cores) };
  } catch {
    return null;
  }
}

// The plan's WEEKLY token budget (denominator for "% usado"). AGILEHARNESS_WEEKLY_TOKEN_LIMIT env
// wins, else settings.yaml `vps.weeklyTokenLimit`, else the per-plan default below. This box is
// Max 20x; ~760M tokens/week is calibrated so a ~381M week reads ~50% (matching Claude's
// /usage). ccusage can't read the real plan limit — tune via the env on the systemd unit if it
// drifts. (settings.yaml is fragile here — the Config panel rewrite drops unknown keys — so the
// env/default is the durable knob.)
const DEFAULT_WEEKLY_TOKEN_LIMIT = 760_000_000;
function configuredWeeklyTokenLimit(): number {
  const env = Number(process.env.AGILEHARNESS_WEEKLY_TOKEN_LIMIT);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  try {
    const raw = yaml.load(readFileSync(settingsPath(), "utf8")) as any;
    const v = raw?.vps?.weeklyTokenLimit;
    if (typeof v === "number" && v > 0) return Math.floor(v);
  } catch {
    /* no settings file */
  }
  return DEFAULT_WEEKLY_TOKEN_LIMIT;
}

async function readTokens(now: number): Promise<{ window: TokenWindow | null; error?: string }> {
  // `ccusage` if installed, else `bunx ccusage@latest` (bun caches it after first download).
  // ccusage reads ~/.claude/projects transcripts by default. AGILEHARNESS_CCUSAGE_CMD overrides.
  // We read the WEEKLY aggregation (the rate-limit window the user tracks in /usage).
  const override = process.env.AGILEHARNESS_CCUSAGE_CMD?.trim();
  const attempts: Array<[string, string[]]> = override
    ? [[override, ["weekly", "--json"]]]
    : [
        ["ccusage", ["weekly", "--json"]],
        ["bunx", ["ccusage@latest", "weekly", "--json"]],
      ];
  let lastErr = "";
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await pexec(cmd, args, { timeout: 30_000, maxBuffer: 16_000_000, env: process.env });
      const window = parseWeeklyTokenWindow(String(stdout), now, configuredWeeklyTokenLimit());
      if (window) return { window };
      lastErr = "ccusage não retornou uso semanal";
    } catch (e: any) {
      lastErr = String(e?.shortMessage ?? e?.message ?? e).slice(0, 200);
    }
  }
  return { window: null, error: lastErr || "ccusage indisponível" };
}

// The REAL Claude usage windows + headroom effectiveness come from the local headroom proxy's
// `/stats` (it polls Anthropic's subscription endpoint). AGILEHARNESS_HEADROOM_URL overrides / kills
// it (`off`/`0`/`false`), else the per-board default port. Returns null when headroom is off.
// How old the proxy's subscription poll may be before the UI stops trusting it. The proxy
// normally re-polls every few minutes; AGILEHARNESS_USAGE_MAX_AGE_MIN (default 20) is the budget
// beyond which a frozen poll (the poller stalled while the process stayed up) is flagged stale
// rather than shown as the live `/usage` figure.
const DEFAULT_USAGE_MAX_AGE_MIN = 20;
function configuredUsageMaxAgeMs(): number {
  const env = Number(process.env.AGILEHARNESS_USAGE_MAX_AGE_MIN);
  const min = Number.isFinite(env) && env > 0 ? env : DEFAULT_USAGE_MAX_AGE_MIN;
  return Math.floor(min * 60_000);
}

function headroomStatsUrl(): string | null {
  const env = process.env.AGILEHARNESS_HEADROOM_URL?.trim();
  if (env && /^(0|off|false|none|disabled)$/i.test(env)) return null;
  const base = (env || "http://127.0.0.1:8787").replace(/\/+$/, "");
  return `${base}/stats`;
}

async function readUsage(): Promise<{ usage: UsageWindow | null; headroom: HeadroomSavings | null }> {
  const url = headroomStatsUrl();
  if (!url) return { usage: null, headroom: null };
  // A broken/absent proxy must NEVER stall the metrics poll — short timeout, fail to null.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return { usage: null, headroom: null };
    const { usage, savings } = parseHeadroomStats(await res.text());
    return { usage, headroom: savings };
  } catch {
    return { usage: null, headroom: null };
  } finally {
    clearTimeout(timer);
  }
}

type Listener = (m: VpsMetrics) => void;

class MetricsHub {
  private listeners = new Set<Listener>();
  private last: VpsMetrics | null = null;
  private tokensCache: { at: number; window: TokenWindow | null; error?: string } | null = null;
  private usageCache: { at: number; usage: UsageWindow | null; headroom: HeadroomSavings | null } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  /** Collect a fresh snapshot (token window reused from cache within its TTL). */
  async collect(): Promise<VpsMetrics> {
    const now = Date.now();
    const [ram, disk] = await Promise.all([readRam(), readDisk(findRepoRoot())]);
    const load = readLoad();

    let tokens: TokenWindow | null;
    let tokenError: string | undefined;
    if (this.tokensCache && now - this.tokensCache.at < TOKENS_TTL_MS) {
      tokens = this.tokensCache.window;
      tokenError = this.tokensCache.error;
    } else {
      const t = await readTokens(now);
      this.tokensCache = { at: now, window: t.window, error: t.error };
      tokens = t.window;
      tokenError = t.error;
    }
    // Recompute the reset countdown every snapshot so it stays live between ccusage refreshes.
    if (tokens) tokens = { ...tokens, resetsInMinutes: Math.max(0, Math.round((tokens.resetsAt - now) / 60_000)) };

    // The real subscription windows + headroom effectiveness (headroom proxy /stats), cached on
    // the same slow cadence as ccusage (a network hop). The proxy owns its own reset countdowns.
    let usage: UsageWindow | null;
    let headroom: HeadroomSavings | null;
    if (this.usageCache && now - this.usageCache.at < TOKENS_TTL_MS) {
      usage = this.usageCache.usage;
      headroom = this.usageCache.headroom;
    } else {
      const u = await readUsage();
      this.usageCache = { at: now, usage: u.usage, headroom: u.headroom };
      usage = u.usage;
      headroom = u.headroom;
    }
    // Recompute staleness every snapshot (it depends on `now`, not on the cached poll time) so a
    // frozen proxy poll flips to "stale" between the slow /stats refreshes.
    if (usage) usage = { ...usage, stale: isUsageStale(usage.polledAt, now, configuredUsageMaxAgeMs()) };

    this.last = { at: now, ram, disk, load, tokens, tokenError, usage, headroom };
    return this.last;
  }

  /** Latest snapshot, collecting one if stale/absent (for force-dynamic route reads). */
  async current(): Promise<VpsMetrics> {
    if (this.last && Date.now() - this.last.at < POLL_MS) return this.last;
    return this.collect();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const m = await this.collect();
      for (const fn of this.listeners) {
        try {
          fn(m);
        } catch {
          this.listeners.delete(fn);
        }
      }
    } catch {
      /* a transient read error must not wedge the interval */
    } finally {
      this.polling = false;
    }
  }

  /** Subscribe an SSE sink. Starts polling on the first subscriber; stops on the last. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.last) fn(this.last); // hand the newcomer the cached snapshot immediately
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
      void this.poll();
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

const KEY = Symbol.for("storymap.vps.metricsHub");
const store = globalThis as unknown as { [KEY]?: MetricsHub };

export function getMetricsHub(): MetricsHub {
  return (store[KEY] ??= new MetricsHub());
}
