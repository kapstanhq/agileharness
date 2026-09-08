"use server";

// WS-0 (copilot-actionability, D7) — the human-click audit trail. The F5 guard re-gates only SCOPED
// agents; it does NOT intercept the FULL operator, so a human's 1-click on a sensitive quick-action
// (run / merge-resolve / deploy / destructive) would leave NO trace. The dispatcher (QuickActionButton)
// records one line here, fire-and-forget, onto the SAME append-only ledger the guard writes
// (agent-actions.jsonl) with an actor of `human:<surface>`.
//
// Deliberately a NEW file (not actions.ts) so the four WS-1..4 branches that append to actions.ts never
// conflict with it (D6).

import { requireSession } from "@/lib/auth/action-guard";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";
import type { RiskClass } from "@/lib/storymap/types";

export async function logHumanActionAction(input: {
  /** the click surface — becomes the actor: `human:kanban` | `human:inbox` | … */
  surface: string;
  /** the name of the server action executed, e.g. "resolveMergeConflictAction". */
  tool: string;
  cls: RiskClass;
  boardId?: string;
  cardId?: string;
  note?: string;
}): Promise<{ ok: true }> {
  await requireSession("logHumanActionAction");
  // Sanitize the surface before it becomes part of the actor string (defense: it flows from the client).
  const surface = /^[a-z0-9-]{1,32}$/.test(input.surface) ? input.surface : "unknown";
  // AgentAction has no cardId field — it rides in `note` (verified against agent-actions.ts).
  const note = [input.cardId ? `card=${input.cardId}` : null, input.note].filter(Boolean).join(" · ") || undefined;
  // Fire-and-forget: appendAgentAction never rejects (warn+swallow), and we NEVER await it — a failed
  // ledger write must never break the human's click (the ledger is fail-open, README risk 1).
  void appendAgentAction({
    actor: `human:${surface}`,
    board: input.boardId,
    tool: input.tool,
    cls: input.cls,
    disposition: "auto", // a human click resolves directly by definition
    outcome: "executed", // we only log AFTER the action returned ok
    note,
  });
  return { ok: true };
}
