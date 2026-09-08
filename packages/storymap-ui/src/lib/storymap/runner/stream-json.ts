// Parser for the `claude -p --output-format stream-json --verbose` event stream.
// Two pure pieces: a line-buffered NDJSON splitter (robust to chunks that split
// mid-JSON) and a DEFENSIVE summarizer that turns one event into a single human
// console line (or null to skip noise). Defensive on purpose — the exact event
// schema shifts across CLI versions, so unknown shapes degrade gracefully.

import type { LogLevel } from "./types";

/** Feed raw stdout chunks; get whole JSON objects, one per NDJSON line. */
export function createNdjsonParser(onObject: (obj: unknown) => void) {
  let buffer = "";
  const drain = (final: boolean) => {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) tryParse(line, onObject);
    }
    if (final && buffer.trim()) {
      tryParse(buffer.trim(), onObject);
      buffer = "";
    }
  };
  return {
    feed(chunk: string) {
      buffer += chunk;
      drain(false);
    },
    flush() {
      drain(true);
    },
  };
}

function tryParse(line: string, onObject: (obj: unknown) => void): void {
  try {
    onObject(JSON.parse(line));
  } catch {
    // Non-JSON line (verbose can interleave plain text) — ignore.
  }
}

/**
 * Best-effort human summary of one stream-json event → a console frame, or null
 * to skip (token deltas / tool-result echoes are too noisy for a progress view).
 */
export function summarizeStreamEvent(obj: unknown): { level: LogLevel; text: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Record<string, any>;
  const type = e.type;

  if (type === "system") {
    const sub = e.subtype ?? "system";
    if (sub === "init") return { level: "system", text: `▶ sessão iniciada${e.model ? ` (${e.model})` : ""}` };
    if (sub === "api_retry") return { level: "system", text: "↻ retry da API" };
    return { level: "system", text: `[${sub}]` };
  }

  if (type === "assistant" && e.message?.content) {
    const lines: string[] = [];
    for (const block of e.message.content as any[]) {
      if (block?.type === "text" && block.text?.trim()) lines.push(block.text.trim());
      else if (block?.type === "tool_use") lines.push(`🔧 ${block.name}${toolHint(block.input)}`);
    }
    const text = lines.join("\n").trim();
    return text ? { level: "info", text } : null;
  }

  if (type === "result") {
    if (e.is_error || e.subtype === "error" || e.subtype === "error_during_execution") {
      return { level: "error", text: `✗ ${e.subtype ?? "erro"}` };
    }
    const turns = typeof e.num_turns === "number" ? ` · ${e.num_turns} turns` : "";
    const cost = typeof e.total_cost_usd === "number" ? ` · $${e.total_cost_usd.toFixed(3)}` : "";
    return { level: "result", text: `✓ concluído${turns}${cost}` };
  }

  // stream_event (token deltas), user (tool results) → skipped as noise.
  return null;
}

/**
 * The tool NAMES invoked in one stream-json `assistant` event (the `tool_use` blocks) — e.g.
 * `mcp__graphify__get_pr_impact`, `mcp__chrome-devtools__resize_page`, `Bash`, `Task`, `Workflow`.
 * The engine accumulates these across the run into a Set → durable telemetry (`toolsUsed`), which the
 * step-history surfaces as "did this step exercise graphify / the browser MCP / subagents". DEFENSIVE:
 * any non-assistant event (or odd shape) yields []. Pure — exported for tests.
 */
export function extractToolNames(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  const e = obj as Record<string, any>;
  if (e.type !== "assistant" || !e.message?.content || !Array.isArray(e.message.content)) return [];
  const names: string[] = [];
  for (const block of e.message.content as any[]) {
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name.trim()) {
      names.push(block.name.trim());
    }
  }
  return names;
}

/**
 * WS4 — the specialist AGENT SLUGS a run delegated to in one `assistant` event: the `subagent_type` of any
 * `Task` tool_use block (e.g. `security-reviewer`, `performance-auditor`). The engine accumulates these into
 * a Set → durable `TelemetryRecord.specialistsUsed`, closing the expected×used loop for specialists (the
 * step declares `toolkit.specialists`; this records which ones were actually engaged). DEFENSIVE: a
 * non-assistant event, a non-Task tool, or a missing/odd `subagent_type` yields nothing. Pure — for tests.
 */
export function extractSpecialistDelegations(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  const e = obj as Record<string, any>;
  if (e.type !== "assistant" || !e.message?.content || !Array.isArray(e.message.content)) return [];
  const out: string[] = [];
  for (const block of e.message.content as any[]) {
    if (block?.type === "tool_use" && block.name === "Task" && block.input && typeof block.input === "object") {
      const st = (block.input as Record<string, any>).subagent_type;
      if (typeof st === "string" && st.trim()) out.push(st.trim());
    }
  }
  return out;
}

/** Cost/token totals pulled from a stream-json `result` event (the run's LAST event).
 * Structurally a RunUsage (registry.setUsage consumes it as one), so it carries the same
 * input/output split — see types.ts RunUsage. */
export interface ResultUsage {
  /** total cost in USD for the run, or null if the CLI didn't report it */
  costUSD: number | null;
  /** input+output+cache tokens for the run, or null if no usage block */
  tokens: number | null;
  /** number of agent turns, or null */
  numTurns: number | null;
  /** input + cache-creation + cache-read tokens, or null if none present */
  inputTokens: number | null;
  /** output tokens only, or null if absent */
  outputTokens: number | null;
}

/**
 * Pull the cost/token totals from a stream-json `result` event (emitted once, at the end
 * of a headless run). Returns null for any other event. DEFENSIVE on purpose — the usage
 * shape shifts across CLI versions, so every field degrades to null independently and a
 * missing/odd `usage` block never throws.
 */
export function extractResultUsage(obj: unknown): ResultUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Record<string, any>;
  if (e.type !== "result") return null;
  const u = e.usage && typeof e.usage === "object" ? (e.usage as Record<string, any>) : null;
  const num = (k: string) => (u && typeof u[k] === "number" ? (u[k] as number) : 0);
  // input = prompt + ambos os caches (cobrados como entrada); output = geração só. tokens = soma dos quatro.
  const input = num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
  const output = num("output_tokens");
  const tokens = input + output;
  return {
    costUSD: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
    tokens: tokens > 0 ? tokens : null,
    numTurns: typeof e.num_turns === "number" ? e.num_turns : null,
    inputTokens: input > 0 ? input : null,
    outputTokens: output > 0 ? output : null,
  };
}

/**
 * story-9s52tu HALF B: does this stream-json event signal the run STOPPED because it hit `--max-turns`?
 * The claude CLI emits a final `result` event with `subtype: "error_max_turns"` (and `is_error: true`)
 * when the agentic loop reaches the turn cap, THEN exits non-zero. This is NOT a code error — partial
 * task commits (t1/t2…) exist on the branch, so the run is RESUMABLE (`claude --resume` continues from
 * where it stopped). The engine reads this off the parsed stdout to PRESERVE the worktree+branch on
 * teardown instead of force-deleting (a genuine error still force-deletes). DEFENSIVE: any other event
 * (or shape) returns false, so an unrelated error keeps the normal force-delete path. Exported for tests.
 */
export function isMaxTurnsResult(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, any>;
  return e.type === "result" && e.subtype === "error_max_turns";
}

/**
 * story-harness-cc #4: the structured TAIL of a run, captured from the terminal stream-json `result`
 * event — the agent's own final message (`result`), why it stopped (`subtype`), and cost/turns. A
 * first-class RETURN channel that complements the side-effect inference (did the card advance on disk?):
 * the engine threads it onto {@link RunCompletion} so the operator/telemetry can SEE what the agent
 * reported, not just guess from whether the status moved. Absent when the run died before any result
 * (kill/OOM/timeout). Additive/diagnostic — never changes routing. Pure — exported for tests.
 */
export interface RunResult {
  /** the agent's final assistant text (`result`), trimmed; absent if empty/missing. */
  finalText?: string;
  /** the result subtype: "success" | "error_max_turns" | "error_during_execution" | … */
  subtype?: string;
  /** total cost in USD the run reported (mirrors RunUsage.costUSD). */
  cost?: number;
  /** number of turns the run took. */
  turns?: number;
}

/** Capture {@link RunResult} from a terminal `result` event; null for any other event. Pure. */
export function extractFinalResult(obj: unknown): RunResult | null {
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Record<string, any>;
  if (e.type !== "result") return null;
  const out: RunResult = {};
  if (typeof e.result === "string" && e.result.trim()) out.finalText = e.result.trim();
  if (typeof e.subtype === "string") out.subtype = e.subtype;
  if (typeof e.total_cost_usd === "number") out.cost = e.total_cost_usd;
  if (typeof e.num_turns === "number") out.turns = e.num_turns;
  // A contentless result event yields null (not an empty object) so it never pollutes RunCompletion.result.
  return Object.keys(out).length ? out : null;
}

function toolHint(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const hint = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.description ?? o.prompt;
  if (hint == null) return "";
  const s = String(hint).replace(/\s+/g, " ").trim();
  return s ? ` ${s.length > 60 ? `${s.slice(0, 57)}…` : s}` : "";
}
