// session-cost — what an INTERACTIVE agent session spent, estimated from its own transcript.
//
// WHY this exists: `cardBudgetUSD` (the per-card $ backstop) and `runner_status` sum the telemetry ledger, and
// the ledger only ever held HEADLESS runs — their `claude -p` stream ends in a `result` event that carries
// `total_cost_usd`. An interactive session (a conductor carrying a whole story in one context) never emits that
// event: the CLI's transcript records per-message TOKEN usage and no dollar figure. So the conductor — by design
// the most expensive single actor on a card — was invisible to every budget. This module turns the transcript's
// usage into an ESTIMATE the ledger can hold (role `session`).
//
// Why a sum here when transcript-usage.ts says "context is a LEVEL, not a sum": that module answers "how full is
// the window NOW" (the last turn). This one answers "what did every turn COST" — every request is billed, so the
// cost IS the sum over requests, each request counted ONCE. Three facts about the transcript make that sum honest:
//
//  1. ONE REQUEST, SEVERAL RECORDS. A response with N content blocks is written as N `assistant` records that
//     share `message.id` (and `requestId`) and REPEAT the same `usage`. Summing records would bill a tool-heavy
//     turn N times — so usage is keyed by message id and counted once.
//  2. SUB-AGENTS ARE BILLED TOO. A Task sub-agent's turns live in `<projectDir>/<sessionId>/subagents/*.jsonl`
//     (and, on older CLIs, as `isSidechain` records in the main file). Both are included — unlike the context
//     meter, which rightly skips them (a sub-agent has its own window, but not its own wallet).
//  3. CACHE WRITES HAVE TWO PRICES. `usage.cache_creation` splits the write into the 5-minute and the 1-hour
//     TTL (1.25× and 2× the input price). When the split is absent, the whole write is priced as 5-minute —
//     the cheaper side, so the estimate never inflates on a guess.
//
// The PRICE TABLE is embedded and dated (the first-party per-MTok rates as of 2026-06-24). It is an ESTIMATE
// and every record says so; a model the table does not know is priced by its FAMILY at the current generation's
// rate (flagged `approximate`), and a model with no recognisable family is left UNPRICED (cost `null`, never 0 —
// "we don't know" must not read as "it was free").
//
// SERVER-ONLY (node:fs). Never throws from the IO entry point.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** USD per million tokens. `cacheRead`/`cacheWrite*` default from `input` when absent (0.1× / 1.25× / 2×). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/**
 * The embedded table (first-party API rates, cached 2026-06-24). Longest prefix wins, so a point release
 * (`claude-opus-5-5`) is matched before its line (`claude-opus-5`). A dated snapshot id
 * (`claude-sonnet-4-5-20250929`) matches its prefix.
 */
export const SESSION_PRICE_TABLE: ReadonlyArray<{ prefix: string; price: ModelPrice }> = [
  { prefix: "claude-fable-5-1", price: { input: 10, output: 50, cacheRead: 0.25 } },
  { prefix: "claude-mythos-5-1", price: { input: 10, output: 50 } },
  { prefix: "claude-fable-5", price: { input: 10, output: 50 } },
  { prefix: "claude-opus-5-5", price: { input: 4, output: 20, cacheRead: 0.2 } },
  { prefix: "claude-opus-5", price: { input: 5, output: 25 } },
  { prefix: "claude-opus-4-8", price: { input: 5, output: 25 } },
  { prefix: "claude-opus-4-7", price: { input: 5, output: 25 } },
  { prefix: "claude-opus-4-6", price: { input: 5, output: 25 } },
  { prefix: "claude-sonnet-5", price: { input: 2, output: 10 } },
  { prefix: "claude-sonnet-4-6", price: { input: 3, output: 15 } },
  { prefix: "claude-sonnet-4-5", price: { input: 3, output: 15 } },
  { prefix: "claude-haiku-4-5", price: { input: 1, output: 5 } },
];

/** The family fallback for an id the table does not list (a newer point release, a bare alias). */
const FAMILY_FALLBACK: Readonly<Record<string, ModelPrice>> = {
  fable: { input: 10, output: 50 },
  mythos: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

/** The price of `model`, and whether it was matched exactly or only by family — or null (unpriced). PURE. */
export function priceFor(model: string | null | undefined): { price: ModelPrice; approximate: boolean } | null {
  if (typeof model !== "string" || !model.trim()) return null;
  const id = model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const hit = [...SESSION_PRICE_TABLE].sort((a, b) => b.prefix.length - a.prefix.length).find((r) => id.startsWith(r.prefix));
  if (hit) return { price: hit.price, approximate: false };
  const fam = /\b(fable|mythos|opus|sonnet|haiku)/.exec(id)?.[1];
  return fam ? { price: FAMILY_FALLBACK[fam], approximate: true } : null;
}

/** Token totals of ONE model across a session. */
export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** distinct requests (deduped message ids) */
  requests: number;
}

const emptyUsage = (): ModelUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0 });
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The CLI's placeholder model on an interrupt / API error record — never a billed request. */
const SYNTHETIC_MODEL = "<synthetic>";

/** One billed request, keyed by `message.id:requestId` — the unit fact 1 counts once. */
interface RequestUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** The per-request accumulator threaded across the files of ONE session (main transcript + sub-agents). */
export type UsageAccumulator = Map<string, RequestUsage>;

/**
 * PURE — fold transcript JSONL text into the per-REQUEST accumulator (fact 1). A request seen twice (N content
 * blocks, or the same record in two files) keeps the per-field MAXIMUM of its snapshots: the CLI repeats the
 * final usage on every block today, and a streaming snapshot that recorded a partial `output_tokens` first can
 * never be counted twice nor under-count the final. Malformed lines are skipped (a live transcript can end
 * mid-line); records without a message id are keyed by their own uuid (counted once each).
 */
export function accumulateTranscriptUsage(jsonl: string, acc: UsageAccumulator = new Map()): UsageAccumulator {
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: unknown; requestId?: unknown; uuid?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | null };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== "assistant") continue;
    const model = typeof rec.message?.model === "string" ? rec.message.model : null;
    if (!model || model === SYNTHETIC_MODEL) continue;
    const usage = rec.message?.usage;
    if (!usage || typeof usage.input_tokens !== "number") continue;
    const key =
      typeof rec.message?.id === "string"
        ? `${rec.message.id}:${typeof rec.requestId === "string" ? rec.requestId : ""}`
        : typeof rec.uuid === "string"
          ? `uuid:${rec.uuid}`
          : `line:${acc.size}`;
    const split = usage.cache_creation as Record<string, unknown> | undefined;
    const write5m = num(split?.ephemeral_5m_input_tokens);
    const write1h = num(split?.ephemeral_1h_input_tokens);
    const snap: RequestUsage = {
      model,
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      // no split recorded → the whole write at the cheaper TTL (fact 3)
      cacheWrite5m: write5m + write1h > 0 ? write5m : num(usage.cache_creation_input_tokens),
      cacheWrite1h: write1h,
    };
    const prev = acc.get(key);
    acc.set(
      key,
      prev
        ? {
            model: prev.model,
            input: Math.max(prev.input, snap.input),
            output: Math.max(prev.output, snap.output),
            cacheRead: Math.max(prev.cacheRead, snap.cacheRead),
            cacheWrite5m: Math.max(prev.cacheWrite5m, snap.cacheWrite5m),
            cacheWrite1h: Math.max(prev.cacheWrite1h, snap.cacheWrite1h),
          }
        : snap,
    );
  }
  return acc;
}

/** PURE — the per-request accumulator folded into per-model totals. */
export function usageByModel(acc: UsageAccumulator): Map<string, ModelUsage> {
  const out = new Map<string, ModelUsage>();
  for (const r of acc.values()) {
    const u = out.get(r.model) ?? emptyUsage();
    u.input += r.input;
    u.output += r.output;
    u.cacheRead += r.cacheRead;
    u.cacheWrite5m += r.cacheWrite5m;
    u.cacheWrite1h += r.cacheWrite1h;
    u.requests += 1;
    out.set(r.model, u);
  }
  return out;
}

/** A session's estimated spend. */
export interface SessionCostEstimate {
  /** null when NO model of the session could be priced (never a fabricated 0). */
  costUSD: number | null;
  /** input-side tokens (input + cache read + cache write), as the ledger's `inputTokens` counts them. */
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** the model with the most requests (the ledger's `model`). */
  model: string | null;
  /** some usage was priced only by family, or some model was not priced at all. */
  approximate: boolean;
  unpricedModels: string[];
}

/** PURE — price per-model usage with the embedded table. */
export function estimateSessionCost(usage: Map<string, ModelUsage>): SessionCostEstimate {
  let cost = 0;
  let priced = false;
  let approximate = false;
  const unpriced: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  let top: { model: string; requests: number } | null = null;
  for (const [model, u] of usage) {
    inputTokens += u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    outputTokens += u.output;
    requests += u.requests;
    if (!top || u.requests > top.requests) top = { model, requests: u.requests };
    const p = priceFor(model);
    if (!p) {
      unpriced.push(model);
      continue;
    }
    priced = true;
    if (p.approximate) approximate = true;
    const { input, output } = p.price;
    const cacheRead = p.price.cacheRead ?? input * 0.1;
    const write5m = p.price.cacheWrite5m ?? input * 1.25;
    const write1h = p.price.cacheWrite1h ?? input * 2;
    cost +=
      (u.input * input + u.output * output + u.cacheRead * cacheRead + u.cacheWrite5m * write5m + u.cacheWrite1h * write1h) /
      1_000_000;
  }
  return {
    costUSD: priced ? Math.round(cost * 10_000) / 10_000 : null,
    inputTokens,
    outputTokens,
    requests,
    model: top?.model ?? null,
    approximate: approximate || unpriced.length > 0,
    unpricedModels: unpriced,
  };
}

/**
 * The sub-agent transcripts of a session: `<dir>/<basename-without-.jsonl>/subagents/*.jsonl`, next to the
 * main transcript. PURE path math — the IO lists it.
 */
export function subagentsDirFor(transcriptFile: string): string {
  const dir = path.dirname(transcriptFile);
  const base = path.basename(transcriptFile, ".jsonl");
  return path.join(dir, base, "subagents");
}

/**
 * IO — the estimated spend of the session whose MAIN transcript is `transcriptFile` (sub-agents included).
 * Never throws: an unreadable main transcript ⇒ null (the caller records nothing rather than a fake 0).
 */
export async function readSessionCost(transcriptFile: string | null | undefined): Promise<SessionCostEstimate | null> {
  if (!transcriptFile) return null;
  let main: string;
  try {
    main = await fs.readFile(transcriptFile, "utf8");
  } catch {
    return null;
  }
  const acc: UsageAccumulator = new Map();
  accumulateTranscriptUsage(main, acc);
  try {
    const dir = subagentsDirFor(transcriptFile);
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      accumulateTranscriptUsage(await fs.readFile(path.join(dir, f), "utf8").catch(() => ""), acc);
    }
  } catch {
    /* no sub-agents directory — the common case */
  }
  return estimateSessionCost(usageByModel(acc));
}

/**
 * PURE — the CLI's per-project transcript directory for a session whose cwd is `cwd`:
 * `<configDir>/projects/<slug>` where EVERY non-alphanumeric byte of the cwd becomes `-` (the CLI's own rule —
 * the same one `transcriptPathFor` in pane-claude-map.ts applies; kept local so this module stays free of the
 * fleet registry import that one carries).
 */
export function projectDirForCwd(cwd: string, home?: string): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = fromEnv || path.join(home ?? os.homedir(), ".claude");
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * IO — the estimated spend of EVERY process that ever ran in the worktree `cwd`: all the main transcripts of its
 * project directory plus their sub-agents. This is the right ruler for a fleet session with its OWN tree (a
 * conductor): the tree is unique to the session, so its project directory is too — and a RECYCLED session (a new
 * process on the same tree, WS-6.3) keeps writing there, so the whole agent is counted, not only its last
 * process. Deliberately NOT a "newest transcript since T" scan (the mtime heuristic that misattributes another
 * session's transcript). Null when the directory holds no transcript.
 */
export async function readWorktreeSessionCost(cwd: string | null | undefined, home?: string): Promise<SessionCostEstimate | null> {
  if (!cwd) return null;
  const dir = projectDirForCwd(cwd, home);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const acc: UsageAccumulator = new Map();
  for (const f of files) {
    const main = path.join(dir, f);
    accumulateTranscriptUsage(await fs.readFile(main, "utf8").catch(() => ""), acc);
    try {
      const sub = subagentsDirFor(main);
      for (const g of await fs.readdir(sub)) {
        if (g.endsWith(".jsonl")) accumulateTranscriptUsage(await fs.readFile(path.join(sub, g), "utf8").catch(() => ""), acc);
      }
    } catch {
      /* no sub-agents for this process */
    }
  }
  return estimateSessionCost(usageByModel(acc));
}
