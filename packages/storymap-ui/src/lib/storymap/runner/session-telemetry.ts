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

/**
 * Fase 7 — the ledger id of a BATCH ITEM's share of a conductor session (`session:<id>#<cardId>`). The lead keeps the
 * plain {@link sessionTelemetryId}, so a single-card session records exactly as before. PURE.
 */
export function batchItemTelemetryId(sessionId: string, cardId: string): string {
  return `${sessionTelemetryId(sessionId)}#${cardId}`;
}

/**
 * The cards a conductor session's spend is split across: the lead first, then every item that was EVER in its batch
 * (an item that left the batch still consumed part of the session). PURE.
 */
export function sessionSpendCards(s: Pick<AgentSession, "cardId" | "batch">): string[] {
  const out: string[] = [];
  for (const id of [s.cardId, ...(s.batch?.cardIds ?? []), ...(s.batch?.dropped ?? []).map((d) => d.cardId)]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Split `n` into `parts` integer shares that sum to `n` (the remainder goes to the first shares). PURE. */
function splitInt(n: number | null, parts: number): Array<number | null> {
  if (n == null) return Array.from({ length: parts }, () => null);
  const base = Math.floor(n / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < n - base * parts ? 1 : 0));
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
  // Fase 7 — a session that carried a BATCH writes one row per card, each with its share of the cost (costUSD/N, the
  // tokens split the same way): the per-item numbers stay readable and sum to the real cost. The lead keeps the plain id.
  const cards = sessionSpendCards(s);
  const rowId = (c: string) => (c === cardId ? sessionTelemetryId(s.sessionId) : batchItemTelemetryId(s.sessionId, c));
  const missing: string[] = [];
  for (const c of cards) {
    const prior = await deps.telemetry.listByCard(board, c).catch(() => []);
    if (!prior.some((r) => r.id === rowId(c))) missing.push(c);
  }
  if (!missing.length) return "already";
  const est = await deps.readCost(s).catch(() => null);
  if (!est || est.requests === 0) {
    (deps.log ?? console.log)(`[session-cost] ${board}/${cardId} sessão ${s.sessionId.slice(0, 8)}: nenhum transcript legível — gasto não registrado`);
    return "no-transcript";
  }
  const now = (deps.now ?? Date.now)();
  const opened = Date.parse(s.openedAt);
  const n = cards.length;
  const turns = splitInt(est.requests, n);
  const input = splitInt(est.inputTokens, n);
  const output = splitInt(est.outputTokens, n);
  for (const [i, c] of cards.entries()) {
    if (!missing.includes(c)) continue;
    await deps.telemetry.recordRun({
      id: rowId(c),
      board,
      cardId: c,
      trigger: CONDUCTOR_SKILL,
      startedAt: Number.isFinite(opened) ? opened : now,
      durationMs: Number.isFinite(opened) ? Math.max(0, now - opened) : null,
      turns: turns[i],
      inputTokens: input[i],
      outputTokens: output[i],
      costUSD: est.costUSD == null ? null : n > 1 ? Math.round((est.costUSD / n) * 1e6) / 1e6 : est.costUSD,
      model: est.model,
      effort: null,
      summary: null,
      toolsUsed: null,
      specialistsUsed: null,
      toolGap: null,
      role: "session",
      status: "ok",
    });
  }
  (deps.log ?? console.log)(
    `[session-cost] ${board}/${cardId}${n > 1 ? ` (lote de ${n} cards, ${n} linhas)` : ""} sessão condutora ${s.sessionId.slice(0, 8)}: ` +
      `${est.costUSD == null ? "custo desconhecido (modelo sem preço)" : `~$${est.costUSD.toFixed(2)}`} ` +
      `(${est.requests} requisições${est.approximate ? ", ESTIMATIVA aproximada" : ", estimativa"}) registrado no ledger do card`,
  );
  return "recorded";
}
