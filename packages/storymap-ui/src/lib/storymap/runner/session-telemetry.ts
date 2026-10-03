// The spend of a CONDUCTOR session, written into the run ledger when the session ends — so the per-card budget
// (`autorun.cardBudgetUSD`, which sums the ledger) and `runner_status` finally see the actor that carries a
// whole story. The estimate itself comes from the session's transcripts (lib/vps/session-cost.ts); this module
// is only the bookkeeping: WHEN to record, under WHICH id, and never twice.
//
// "Ends" has two doors and the record goes through whichever comes first:
//   • the session DISCARDS its tree (worktree_discard — the conductor's last act after the human approves the
//     delivery). The registry row disappears there, so it is the last moment the service knows the tree;
//   • the fleet reconcile finds its tmux GONE (crash, operator kill). The row stays until someone discards it,
//     so this door fires on every tick — which is why the record is idempotent by id and the ledger is checked
//     BEFORE the transcripts are read (reading a 25 MB transcript every minute for a dead session would be the
//     bill for being correct once).
// A tail spent after the discard (the conductor's closing message before the operator closes the tmux) is not
// counted — it is bounded and small, and the alternative (a watcher per tmux) is not worth a daemon.

import { CONDUCTOR_SKILL } from "@/lib/storymap/driver";
import type { SessionCostEstimate } from "@/lib/vps/session-cost";
import type { AgentSession } from "./session-worktree";
import type { TelemetryPort } from "./telemetry";

/** The ledger id of a session's spend — distinct from every run id (runs are bare uuids). PURE. */
export function sessionTelemetryId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Does this session's spend belong in a card's ledger? Today: a CONDUCTOR on a card. PURE. */
export function isRecordableSession(s: Pick<AgentSession, "driver" | "board" | "cardId">): boolean {
  return s.driver === "conductor" && !!s.board && !!s.cardId;
}

export interface SessionTelemetryDeps {
  telemetry: Pick<TelemetryPort, "recordRun" | "listByCard">;
  /** the session's estimated spend (its worktree's transcripts) — null when there is nothing to read. */
  readCost(s: AgentSession): Promise<SessionCostEstimate | null>;
  now?(): number;
  log?(line: string): void;
}

export type SessionTelemetryOutcome = "recorded" | "already" | "not-recordable" | "no-transcript";

/**
 * Record `s`'s spend ONCE (role `session`, trigger `harness-conductor`, id `session:<sessionId>`). The status is
 * `ok` and the summary is null ON PURPOSE: a session is not a column step, so it must never be offered to the
 * next run as the "previous step's decision" (the engine's handoff reads `ok` records WITH a summary). An
 * unpriced model yields `costUSD: null` with the tokens still recorded — "we don't know" never reads as "$0".
 */
export async function recordSessionSpend(deps: SessionTelemetryDeps, s: AgentSession): Promise<SessionTelemetryOutcome> {
  if (!isRecordableSession(s)) return "not-recordable";
  const board = s.board!;
  const cardId = s.cardId!;
  const id = sessionTelemetryId(s.sessionId);
  const prior = await deps.telemetry.listByCard(board, cardId).catch(() => []);
  if (prior.some((r) => r.id === id)) return "already";
  const est = await deps.readCost(s).catch(() => null);
  if (!est || est.requests === 0) {
    (deps.log ?? console.log)(`[session-cost] ${board}/${cardId} sessão ${s.sessionId.slice(0, 8)}: nenhum transcript legível — gasto não registrado`);
    return "no-transcript";
  }
  const now = (deps.now ?? Date.now)();
  const opened = Date.parse(s.openedAt);
  await deps.telemetry.recordRun({
    id,
    board,
    cardId,
    trigger: CONDUCTOR_SKILL,
    startedAt: Number.isFinite(opened) ? opened : now,
    durationMs: Number.isFinite(opened) ? Math.max(0, now - opened) : null,
    turns: est.requests,
    inputTokens: est.inputTokens,
    outputTokens: est.outputTokens,
    costUSD: est.costUSD,
    model: est.model,
    effort: null,
    summary: null,
    toolsUsed: null,
    specialistsUsed: null,
    toolGap: null,
    role: "session",
    status: "ok",
  });
  (deps.log ?? console.log)(
    `[session-cost] ${board}/${cardId} sessão condutora ${s.sessionId.slice(0, 8)}: ` +
      `${est.costUSD == null ? "custo desconhecido (modelo sem preço)" : `~$${est.costUSD.toFixed(2)}`} ` +
      `(${est.requests} requisições${est.approximate ? ", ESTIMATIVA aproximada" : ", estimativa"}) registrado no ledger do card`,
  );
  return "recorded";
}
