// F5.6 — WRITERS-ONLY audit ledger of the guard's per-call decisions (append-only JSONL) at
// storymap/.runner/agent-actions.jsonl. Every time the guard (register.ts, 5.2) decides what to do with a
// SCOPED agent's tool call, it records ONE line here: which tool, its risk class, the resolved disposition,
// and the outcome (executed / grant-consumed / pending-approval / refused). This is the forensic trail that
// makes an autonomous tick auditable — "what did the copiloto try, and what did the policy do about it".
//
// Same discipline as transitions.ts: FAIL-OPEN (an append failure warns, never throws into the guard),
// SERIALIZED (a single writeChain so lines never interleave), and a VITEST no-op default sink (a test that
// exercises the guard doesn't churn the gitignored ledger; the ledger's own tests inject a collector).

import { promises as fsp } from "node:fs";
import { agentActionsPath } from "@/lib/storymap/paths";
import type { RiskClass, RiskDisposition } from "@/lib/storymap/types";

export const AGENT_ACTIONS_VERSION = 1;

/** What the guard did with a scoped agent's tool call. */
export type AgentActionOutcome = "executed" | "grant-consumed" | "pending" | "refused";

export interface AgentAction {
  v: number;
  /** ISO timestamp of the guard decision. */
  at: string;
  /** the scoped token's env-var (the actor), when known. */
  actor?: string;
  board?: string;
  /** WS-12 (D16) — the CARD the call targets, from the canonical `cardId` arg the guard already reads. This is
   *  what makes the per-item anti-noop streak attributable to a real ATTEMPT (noop-attribution.ts) instead of to
   *  mere presence on the board. Absent when the tool takes no card (`resolve_merge` takes a runId; `deploy`
   *  takes a pkg) and on LEGACY lines written before this field existed — both are simply not attributable
   *  (fail-safe: an unattributable action never bumps anyone's streak). */
  cardId?: string;
  tool: string;
  cls: RiskClass;
  disposition: RiskDisposition;
  outcome: AgentActionOutcome;
  /** the ApprovalRequest id, on a `pending` (created) or `grant-consumed` (spent) outcome. */
  approvalId?: string;
  note?: string;
}

export type AppendAgentActionInput = Omit<AgentAction, "v" | "at">;

/** Injectable persist port — tests swap it for an in-memory collector; prod appends to the JSONL file. */
export interface AgentActionSink {
  append(line: string): Promise<void>;
}

function fileSink(): AgentActionSink {
  return {
    async append(line: string): Promise<void> {
      if (process.env.VITEST) return; // default no-op under vitest (the ledger's own tests inject a collector)
      await fsp.appendFile(agentActionsPath(), line, "utf8");
    },
  };
}

let sink: AgentActionSink = fileSink();
let writeChain: Promise<void> = Promise.resolve();

/** TEST SEAM — swap the persist port. Pair with resetAgentActionSink() in afterEach. */
export function setAgentActionSink(s: AgentActionSink): void {
  sink = s;
}
/** TEST SEAM — restore the production file sink. */
export function resetAgentActionSink(): void {
  sink = fileSink();
}

/**
 * Append ONE audit line. Fire-and-forget (the guard `void`s it): the returned promise resolves after the
 * serialized write and NEVER rejects (a failure is warned + swallowed — the audit ledger must never break a
 * tool call). Chains onto the previous append so lines can't interleave.
 */
export function appendAgentAction(input: AppendAgentActionInput): Promise<void> {
  const rec: AgentAction = { v: AGENT_ACTIONS_VERSION, at: new Date().toISOString(), ...input };
  const line = JSON.stringify(rec) + "\n";
  writeChain = writeChain
    .then(() => sink.append(line))
    .catch((err) => console.warn("[agent-actions] append falhou (não-fatal):", err instanceof Error ? err.message : err));
  return writeChain;
}

/**
 * WS-12 (D16) — DRAIN the append chain: resolves once every append enqueued SO FAR has been persisted. The
 * guard fire-and-forgets its appends (`void appendAgentAction(...)`), so a reader that runs right after a run
 * dies could miss the run's LAST action — and a missed action reads as "the run mutated nothing", which is
 * exactly the verdict that bumps every item's streak. A reader that attributes MUST flush first. Never rejects
 * (appendAgentAction already swallows its own failures).
 */
export function flushAgentActions(): Promise<void> {
  return writeChain;
}

/**
 * Read the audit ledger (tolerant per-line parse; a corrupt line is skipped). Filters: `board`, and the
 * half-open time window `[since, until]` (epoch ms, inclusive) a WS-12 attribution reads — a line whose `at`
 * is unparseable is dropped by the window filter (it can't be placed in a run).
 */
export async function readAgentActions(filter?: { board?: string; since?: number; until?: number }): Promise<AgentAction[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(agentActionsPath(), "utf8");
  } catch {
    return [];
  }
  const out: AgentAction[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as AgentAction;
      if (!rec || typeof rec.tool !== "string") continue;
      if (filter?.board && rec.board !== filter.board) continue;
      if (filter?.since != null || filter?.until != null) {
        const at = Date.parse(rec.at ?? "");
        if (!Number.isFinite(at)) continue;
        if (filter.since != null && at < filter.since) continue;
        if (filter.until != null && at > filter.until) continue;
      }
      out.push(rec);
    } catch {
      /* skip a malformed line */
    }
  }
  return out;
}
