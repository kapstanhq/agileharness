// transcript-usage — the CONTEXT LEVEL of a Claude Code session (the number `/context` prints), read
// from the CLI's own transcript (JSONL). Single source for the web terminal's meter.
//
// WHY a new module instead of extending `claude-transcript.ts`: `mcp/dev-tools.ts:288-292` re-exports
// that module so `dev-tools.test.ts` keeps importing the names from there, and the extraction comment
// records that reversing the import recreates the `dev-tools → session-spawn → deps → dev-tools` cycle.
// Its signatures are frozen. `computeContextPct` stays untouched.
//
// FOUR facts — all measured on this box — that the naive reading gets wrong:
//
//  1. CONTEXT IS A LEVEL, NOT A SUM OVER TURNS. Turn N's `input_tokens` already carries the whole prior
//     conversation, so adding turns counts it N times. The answer is
//     `input + cache_creation + cache_read + output` of the LAST `type:"assistant"` record — and
//     `output_tokens` belongs in it (the model's own reply occupies the window too; the older
//     `contextPctFromTranscript` drops it, `claude-transcript.ts:47-50`).
//  2. ONLY `type:"assistant"` RECORDS COUNT. A live transcript also holds `user`, `system`, `mode`,
//     `attachment`, `file-history-snapshot`, `file-history-delta`, `last-prompt`, `ai-title` and
//     `queue-operation` records, and some carry a `usage` object of their own. Accepting `usage` from
//     any record type reports a different turn's number. Sidechains (sub-agents) are a separate
//     context and are skipped for the same reason.
//  3. THE TRANSCRIPT'S MODEL ID IS BARE. A real record says `"claude-opus-4-8"` — it NEVER carries the
//     `[1m]` suffix. Deriving the window from it alone reports 200k for a session actually running a 1M
//     window, which turns a 15%-full session into a screaming 253%. The suffix is discoverable only
//     OUTSIDE the transcript: in a hint the spawner pinned, in the CLI's OWN per-project record
//     (`~/.claude.json` `projects[<cwd>].lastModelUsage`, whose KEYS are full ids — `claude-opus-5[1m]`)
//     or in the operator default (`<configDir>/settings.json` `model`) — hence `resolveWindow` reads
//     those FIRST, and then lets the OBSERVATION falsify a limit that cannot possibly hold: you can
//     never hold more tokens than the window.
//  4. TRANSCRIPTS ARE HUGE. They reach 24.9 MB here; whole-file read+parse costs 280–415 ms, a bounded
//     256 KB tail costs ~4 ms (65×). p100 distance EOF→last usage record over 340 transcripts >100 KB
//     is 62.2 KB and the largest single line is 99.5 KB — so 256 KB is 4× the worst case and >2.5× the
//     longest line, and it still ESCALATES (1 MB → 8 MB) rather than report a wrong number.
//
// What this module must NEVER do:
//   • never clamp the percentage — `Math.min(100, …)` is precisely the lie that hides an over-full
//     session from the operator; >100 is reported as >100;
//   • never invent a window — an unknown model yields `limit: null` and `pct: null` while the raw token
//     count is still reported: the count is honest, the percentage would not be;
//   • never report `0` for "no model turn yet" — absent is `null`, and `undefined`/`0` are bugs;
//   • never read the whole file, and never scan a directory looking for "the newest transcript" (that
//     misattribution was reproduced live: another session's 384,725 tok for a pane holding 146,979);
//   • never throw. Every IO entry point degrades to `null`.
//
// SERVER-ONLY (node:fs).

import { promises as fs, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LastUsage {
  inputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  outputTokens: number;
  /** input + cacheCreation + cacheRead + outputTokens — the LEVEL, not a sum over turns */
  contextTokens: number;
  /** message.model, bare (a real record NEVER carries the `[1m]` suffix) */
  model: string | null;
  /** the CLI's reasoning effort for that turn — a TOP-LEVEL `effort` on the record, sibling of
   *  `message` (`"xhigh"` on this box, claude 2.1.220). `null` when the record does not carry it: an
   *  older CLI, or a spawn that never set one. Never defaulted to the operator's `effortLevel` —
   *  that is config, not what this session ran with. */
  effort: string | null;
  /** ISO timestamp of that record */
  at: string | null;
}

export interface CompactBoundary {
  at: string;
  postTokens: number | null;
}

/** Where the window figure came from. `observed` means the evidence falsified the declared limit. */
export type LimitSource = "model" | "config" | "observed";

export interface SessionContext {
  /** the LEVEL (see LastUsage.contextTokens) */
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** bare model id as the transcript recorded it (or the caller's hint), never fabricated */
  model: string | null;
  /** reasoning effort the last turn ran at (see LastUsage.effort); null when the record omits it */
  effort: string | null;
  at: string | null;
  /** context window in tokens, or null when it could not be established */
  limit: number | null;
  /** null exactly when `limit` is null — a source for a non-existent limit would be noise */
  limitSource: LimitSource | null;
  /** NOT clamped: >100 is a real, reportable state */
  pct: number | null;
  /** a compact boundary NEWER than the usage record (readings must never be diffed across it) */
  compacted: boolean;
  compact: CompactBoundary | null;
}

/** Ladder for the tail read. 256 KB covers 340/340 measured transcripts; the rest is insurance. */
const TAIL_BUDGET = 256 * 1024;
const TAIL_LADDER = [1024 * 1024, 8 * 1024 * 1024];

const WINDOW_1M = 1_000_000;
const WINDOW_200K = 200_000;
/** Smallest first — `resolveWindow` walks this to escalate a limit the observation has falsified. */
const KNOWN_TIERS = [WINDOW_200K, WINDOW_1M];

/** The CLI's own naming: full ids (`claude-opus-4-8`) and the short aliases a settings/`--model` knob takes. */
const KNOWN_BARE_MODEL = /^(claude-(opus|sonnet|haiku)[a-z0-9.\-]*|opus|opusplan|sonnet|haiku)$/i;
const ONE_M_SUFFIX = /\[1m\]$/i;

/** The CLI's placeholder model on an interrupt / API error record. Never a real model turn. */
const SYNTHETIC_MODEL = "<synthetic>";

/** The tier word inside any spelling of a model id (`claude-opus-4-8`, `opus[1m]`, `opusplan`) — or
 *  null when we cannot tell. Used ONLY to decide whether two ids describe the SAME model family. */
export function modelFamily(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const m = /\b(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1].toLowerCase() : null;
}

interface RawUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

interface RawRecord {
  type?: unknown;
  subtype?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  /** TOP-LEVEL on an assistant record — NOT inside `message` */
  effort?: unknown;
  message?: { model?: unknown; usage?: RawUsage } | null;
  compactMetadata?: { postTokens?: unknown } | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Yields non-blank lines from last to first — the last usage record is the answer, so scan backwards. */
function* reverseLines(chunk: string): Generator<string> {
  let end = chunk.length;
  while (end > 0) {
    const nl = chunk.lastIndexOf("\n", end - 1);
    const line = chunk.slice(nl + 1, end);
    if (line.trim()) yield line;
    if (nl < 0) return;
    end = nl;
  }
}

/**
 * PURE. The newest real model turn in `chunk`: the first record, scanning backwards, with
 * `type === "assistant"`, not a sidechain, and a numeric `message.usage.input_tokens`. Malformed lines
 * are skipped, never fatal — a transcript is appended to live, so the caller's window can start or end
 * mid-line. `null` when the chunk holds no model turn (a fresh session is absent, not 0%).
 */
export function parseLastAssistantUsage(chunk: string): LastUsage | null {
  for (const line of reverseLines(chunk)) {
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue; // truncated / non-JSON line — skip, never fatal
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.type !== "assistant") continue;
    if (rec.isSidechain === true) continue; // a sub-agent has its OWN context window
    // `<synthetic>` records are the CLI's placeholder for an interrupt or an API error. They carry a
    // usage object whose every field is 0 — a NUMBER, so the guard below happily accepts it — and, being
    // the newest record, they would report a real session as "0 tokens · 0.0%": a fabricated zero, and
    // exactly the class of lie the absent-state contract exists to prevent. They are not model turns.
    if (rec.message?.model === SYNTHETIC_MODEL) continue;
    const usage = rec.message?.usage;
    if (!usage || typeof usage.input_tokens !== "number") continue;

    const inputTokens = num(usage.input_tokens);
    const cacheCreation = num(usage.cache_creation_input_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const outputTokens = num(usage.output_tokens);
    return {
      inputTokens,
      cacheCreation,
      cacheRead,
      outputTokens,
      contextTokens: inputTokens + cacheCreation + cacheRead + outputTokens,
      model: typeof rec.message?.model === "string" ? rec.message.model : null,
      effort: typeof rec.effort === "string" && rec.effort.trim() ? rec.effort.trim() : null,
      at: typeof rec.timestamp === "string" ? rec.timestamp : null,
    };
  }
  return null;
}

/**
 * PURE. The newest `{type:"system", subtype:"compact_boundary"}` in `chunk`. It exists so the UI can SAY
 * the session was compacted; two readings across a boundary describe different conversations and must
 * never be diffed. `postTokens` (from `compactMetadata`) is informational — it is NOT the context level.
 */
export function parseLastCompactBoundary(chunk: string): CompactBoundary | null {
  for (const line of reverseLines(chunk)) {
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }
    if (!rec || rec.type !== "system" || rec.subtype !== "compact_boundary") continue;
    const post = rec.compactMetadata?.postTokens;
    return {
      at: typeof rec.timestamp === "string" ? rec.timestamp : "",
      postTokens: typeof post === "number" && Number.isFinite(post) ? post : null,
    };
  }
  return null;
}

/**
 * PURE. Trailing `[1m]` → 1M; a known bare model id → 200k; anything else → `null` (an unknown model
 * gets NO window, never a guessed one). Note fact #3: the transcript id is always bare, so this alone
 * can only ever answer 200k for a real record — `resolveWindow` is what makes that safe.
 */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (typeof model !== "string") return null;
  const id = model.trim();
  if (!id) return null;
  if (ONE_M_SUFFIX.test(id)) return WINDOW_1M;
  return KNOWN_BARE_MODEL.test(id) ? WINDOW_200K : null;
}

/**
 * PURE. Ratio in percent, ONE decimal, **never clamped** — `Math.min(100, …)` against a hardcoded 200k
 * is exactly the lie that renders a 50.8%-full `[1m]` session as "100% — recycle now", and the operator
 * needs to see 253% when it is 253%. `null` (not 0) when the window is unknown.
 */
export function contextPct(tokens: number, limit: number | null): number | null {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(tokens)) return null;
  return Math.round((tokens / limit) * 1000) / 10;
}

/**
 * Best-effort read of the operator default (`model` in `<config>/settings.json`, e.g. `"opus[1m]"`).
 * One of the places the `[1m]` suffix is discoverable — the transcript never carries it (fact #3).
 * Honours `CLAUDE_CONFIG_DIR`, else `<home>/.claude`. Never throws; `null` on any failure.
 *
 * It is OFTEN ABSENT, and that absence is what made this whole second source necessary: `model` only
 * appears in settings.json when the operator pinned a default there by hand. Picking the model from
 * the CLI's `/model` menu — which is how it is normally chosen — writes nothing to this file. On this
 * box the key does not exist at all while every interactive session runs `claude-opus-5[1m]`.
 */
export function readConfiguredModel(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(configDir(), "settings.json"), "utf8")) as { model?: unknown };
    const model = typeof raw?.model === "string" ? raw.model.trim() : "";
    return model || null;
  } catch {
    return null;
  }
}

/** `$CLAUDE_CONFIG_DIR ?? <home>/.claude` — the same rule pane-claude-map.ts applies. */
function configDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv || path.join(os.homedir(), ".claude");
}

/** The CLI's global config. NOT inside the config dir by default (`~/.claude.json`, sibling of
 *  `~/.claude/`), and never searched for elsewhere: an env-relocated config dir that does not hold
 *  it simply yields no signal, which degrades to the bare-id table — never to a wrong window. */
function claudeConfigJsonPath(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? path.join(fromEnv, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** `<bare>` for any spelling of a model id: `claude-opus-5[1m]` → `claude-opus-5`. */
function bareId(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, "").trim();
}

/**
 * PURE. The FULL model id (suffix included) that `keys` records for the model this session actually
 * ran — or `null` when the record cannot describe it unambiguously.
 *
 * `keys` are the keys of `projects[<cwd>].lastModelUsage` in `~/.claude.json`: the CLI's own ledger of
 * which model id burned tokens in this working directory, and one of the few places on the box where
 * the id is written IN FULL (`claude-opus-5[1m]`). The transcript's id is the same string minus the
 * suffix (fact #3), so the join is an EXACT bare-id match, not a family guess.
 *
 * Refuses in three cases, all of them "I cannot tell" rather than "probably":
 *   • no `observed` id — with nothing to anchor to, any key would be an arbitrary pick;
 *   • no key with that bare id — the ledger is about some other model, and says nothing about this run;
 *   • MORE than one (`claude-opus-5` and `claude-opus-5[1m]` both present) — the operator has run both
 *     variants here and the ledger cannot say which one this session is. Guessing the 1M one would
 *     UNDER-report a full 200k session, which is the dangerous direction.
 */
export function pickProjectModel(keys: string[], observed: string | null): string | null {
  const anchor = typeof observed === "string" ? bareId(observed) : "";
  if (!anchor) return null;
  const hits = keys.filter((k) => typeof k === "string" && bareId(k) === anchor);
  return hits.length === 1 ? hits[0].trim() : null;
}

interface ProjectModelsMemo {
  size: number;
  mtimeMs: number;
  byCwd: Map<string, string[]>;
}

let projectModelsMemo: ProjectModelsMemo | null = null;

/** Test seam — the memo is process-global and would leak between cases otherwise. */
export function clearProjectModelMemo(): void {
  projectModelsMemo = null;
}

/**
 * IO. The model ids the CLI recorded for `cwd`, from its own `~/.claude.json`.
 *
 * `cwd` is the directory the session was LAUNCHED in (the pidfile's `cwd`), which is exactly how the
 * CLI keys `projects` — not wherever the agent has since navigated to. Memoised by `{size, mtimeMs}`
 * because the file is tens of KB, is parsed on every meter poll, and changes only when a session ends.
 * Never throws: any failure is an empty list, i.e. no signal.
 */
export function readProjectModels(cwd: string | null | undefined): string[] {
  if (!cwd) return [];
  const file = claudeConfigJsonPath();
  try {
    const st = statSync(file);
    if (!projectModelsMemo || projectModelsMemo.size !== st.size || projectModelsMemo.mtimeMs !== st.mtimeMs) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        projects?: Record<string, { lastModelUsage?: Record<string, unknown> }>;
      };
      const byCwd = new Map<string, string[]>();
      for (const [dir, entry] of Object.entries(raw?.projects ?? {})) {
        const usage = entry?.lastModelUsage;
        if (usage && typeof usage === "object") byCwd.set(dir, Object.keys(usage));
      }
      projectModelsMemo = { size: st.size, mtimeMs: st.mtimeMs, byCwd };
    }
    return projectModelsMemo.byCwd.get(cwd) ?? [];
  } catch {
    return [];
  }
}

/**
 * PURE. Which context window this session actually has.
 *
 * The whole difficulty: the transcript's model id is always BARE (`claude-opus-4-8`), so it cannot
 * express the 1M window, and the only place `[1m]` is written down is a model string in config or in
 * the spawner's pin. Reaching for that string carelessly produces the opposite lie, though — this box's
 * `settings.json` says `opus[1m]` while most fleet work runs on sonnet (a 200k window), so a global
 * default applied to every pane under-reports a sonnet session by 5×. Hence:
 *
 *   1. `pinnedModel` — the model the SPAWNER pinned for this session (`--model …`). An explicit pin
 *      overrides everything else by construction, so when it exists it is the ONLY signal used.
 *   2. `projectModel` — the full id the CLI itself recorded for this session's working directory
 *      (`pickProjectModel`). Above the operator default because it is cwd-scoped and is what the CLI
 *      actually ran, not what someone once wrote in a config file.
 *   3. `configuredModel` (the operator default) — the weakest, and frequently absent (see
 *      `readConfiguredModel`).
 *   4. `contextWindowFor(model)` → that, source `model`.
 *   5. nothing → `limit: null` (source still `model`: the table was consulted and had no entry —
 *      `readSessionContext` nulls the source alongside the limit for its consumers).
 *
 * Both config tiers are read through the SAME family guard, and only ever to UPGRADE to the 1M window:
 * a config string that is not `[1m]` teaches nothing the bare-id table does not already know.
 *
 * THEN the observation override: a non-null limit BELOW `observedTokens` is provably wrong — you cannot
 * hold more tokens than the window — so it escalates to the smallest known tier ≥ the observation and
 * reports source `observed`. When the observation exceeds every known tier the largest is kept and the
 * percentage is allowed past 100.
 *
 * This is NOT clamping: clamping fakes the numerator to fit a denominator it distrusts; this corrects a
 * denominator the evidence has falsified, and leaves the measured tokens untouched.
 */
export function resolveWindow(input: {
  model: string | null;
  /** the model the spawner pinned for THIS session, when known (registry `AgentSession.model`) */
  pinnedModel?: string | null;
  /** the full id the CLI recorded for this session's cwd (`pickProjectModel`) */
  projectModel?: string | null;
  configuredModel: string | null;
  observedTokens: number;
}): { limit: number | null; source: LimitSource } {
  let limit: number | null = null;
  let source: LimitSource = "model";

  const pinned = typeof input.pinnedModel === "string" && input.pinnedModel.trim() ? input.pinnedModel.trim() : null;
  /** A config string only speaks for this session when it describes the SAME model family the
   *  transcript recorded — `opus[1m]` says nothing about a session that ran sonnet, and applying it
   *  anyway would under-report that session by 5x. No observed model at all ⇒ nothing to contradict it. */
  const describesThisRun = (candidate: string): boolean =>
    ONE_M_SUFFIX.test(candidate) &&
    (modelFamily(input.model) === null || modelFamily(candidate) === modelFamily(input.model));
  const fromConfig = [input.projectModel, input.configuredModel]
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .find((c) => c && describesThisRun(c));

  if (pinned) {
    // An explicit per-session pin beats every config source, and beats the bare transcript id (only
    // the pin can carry `[1m]`). `config` names "a model string from configuration", pin included.
    limit = contextWindowFor(pinned);
    source = ONE_M_SUFFIX.test(pinned) ? "config" : "model";
  } else if (fromConfig) {
    limit = WINDOW_1M;
    source = "config";
  } else {
    limit = contextWindowFor(input.model);
  }

  const observed = Number.isFinite(input.observedTokens) ? input.observedTokens : 0;
  if (limit !== null && observed > limit) {
    limit = KNOWN_TIERS.find((tier) => tier >= observed) ?? KNOWN_TIERS[KNOWN_TIERS.length - 1];
    source = "observed";
  }

  return { limit, source };
}

/**
 * IO. Bounded TAIL read with escalation (`budget` → 1 MB → 8 MB), so a 24.9 MB transcript costs ~4 ms
 * instead of ~281 ms. When the window starts mid-file the first (partial) line is DROPPED: a JSON
 * fragment can parse as a valid — and different — record, which would silently report another turn's
 * numbers.
 *
 * Three distinct outcomes, deliberately: `null` = unreadable/absent file; `{usage:null}` = readable but
 * no model turn in 8 MB of tail; `{usage}` = the answer. The caller needs that distinction to render
 * "transcript indisponível" vs "sessão ainda sem turno do modelo". Never throws.
 */
export async function readLastUsage(
  file: string,
  budget = TAIL_BUDGET,
): Promise<{ usage: LastUsage | null; compact: CompactBoundary | null } | null> {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size <= 0) return { usage: null, compact: null };

    const ladder = [budget, ...TAIL_LADDER].filter((b) => Number.isFinite(b) && b > 0);
    let readSoFar = 0;
    let compact: CompactBoundary | null = null;

    for (const step of ladder) {
      const len = Math.min(Math.floor(step), size);
      if (len <= readSoFar) continue; // this rung reads nothing new
      const start = size - len;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, start);
      let chunk = buf.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        const nl = chunk.indexOf("\n");
        chunk = nl === -1 ? "" : chunk.slice(nl + 1); // drop the partial first line
      }
      compact = parseLastCompactBoundary(chunk) ?? compact;
      const usage = parseLastAssistantUsage(chunk);
      if (usage) return { usage, compact };
      readSoFar = len;
      if (len >= size) break; // whole file already scanned — escalating cannot help
    }
    return { usage: null, compact };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * IO. Há quanto tempo (ms) este transcript não RECEBE uma linha — a testemunha de "há um turno em voo"
 * que nenhum repaint de tela consegue forjar.
 *
 * Um `stat`, sub-milissegundo, e de propósito FORA de `readSessionContext`: aquela função devolve
 * `null` tanto para "arquivo ilegível" quanto para "ainda sem turno do modelo", e é exatamente no
 * segundo caso — uma sessão recém-limpa — que o mtime ainda importa (o arquivo é novo em folha).
 * Amarrar a idade ao resultado dela perderia justamente o caso interessante.
 *
 * `null` = não deu para medir. Nunca 0: um zero aqui seria lido como "escreveu agora".
 */
export async function readTranscriptIdle(file: string, now: number = Date.now()): Promise<number | null> {
  try {
    const st = await fs.stat(file);
    return Math.max(0, now - st.mtimeMs);
  } catch {
    return null;
  }
}

interface MemoEntry {
  size: number;
  mtimeMs: number;
  at: number;
  value: SessionContext | null;
}

/** Cadence contract: the meter polls at 15 s, so a 10 s memo absorbs bursts without ever serving stale. */
const MEMO_TTL_MS = 10_000;
const MEMO_MAX = 64;
const memo = new Map<string, MemoEntry>();

/** Test seam — the memo is process-global and would leak between cases otherwise. */
export function clearSessionContextMemo(): void {
  memo.clear();
}

/**
 * IO + memo. The whole answer for one session: level, window, percentage and compaction state.
 *
 * `modelHint` is what the spawner pinned (registry/argv). A hint carrying `[1m]` is treated as a
 * CONFIGURED signal — stronger than `settings.json`, because it is what this session actually ran with;
 * the reported `model` stays the bare id the transcript recorded (never a fabrication).
 *
 * `cwd` is the directory the session was LAUNCHED in (the pidfile's `cwd` — `pane.cwd`), and it is what
 * unlocks the CLI's own per-project model record. Omitting it is not an error: the window then falls
 * back to the operator default and the bare-id table, exactly as before.
 *
 * Memo: key = path, hit requires identical `{size, mtimeMs}` AND age < 10 s; the Map is capped at 64
 * entries, oldest insertion evicted. `null` for BOTH "unreadable" and "no model turn yet" — a caller
 * needing to tell them apart calls `readLastUsage` directly. Never throws.
 */
export async function readSessionContext(
  file: string,
  modelHint?: string | null,
  cwd?: string | null,
): Promise<SessionContext | null> {
  let size: number;
  let mtimeMs: number;
  try {
    const st = await fs.stat(file);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null; // unreadable — nothing to key a memo on either
  }

  const now = Date.now();
  const cached = memo.get(file);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs && now - cached.at < MEMO_TTL_MS) {
    return cached.value;
  }

  const value = await computeSessionContext(file, modelHint, cwd);
  memo.delete(file); // re-insert so the eviction order below is insertion order
  memo.set(file, { size, mtimeMs, at: now, value });
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
  return value;
}

async function computeSessionContext(
  file: string,
  modelHint?: string | null,
  cwd?: string | null,
): Promise<SessionContext | null> {
  const read = await readLastUsage(file);
  if (!read || !read.usage) return null;
  const { usage, compact } = read;

  const hint = typeof modelHint === "string" && modelHint.trim() ? modelHint.trim() : null;
  const model = usage.model ?? hint;
  const { limit, source } = resolveWindow({
    model,
    pinnedModel: hint,
    projectModel: pickProjectModel(readProjectModels(cwd), model),
    configuredModel: readConfiguredModel(),
    observedTokens: usage.contextTokens,
  });

  return {
    contextTokens: usage.contextTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model: usage.model ?? hint,
    effort: usage.effort,
    at: usage.at,
    limit,
    limitSource: limit === null ? null : source,
    pct: contextPct(usage.contextTokens, limit),
    compacted: isNewer(compact?.at, usage.at),
    compact,
  };
}

/** True only when BOTH timestamps parse and `a` is strictly newer — an unknown order never claims one. */
function isNewer(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return ta > tb;
}
