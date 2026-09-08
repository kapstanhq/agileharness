// Board-aware "advance to the next pipeline step" — the decoupling seam that lets
// ONE shared skill (harness-enrich, harness-ux, …) advance correctly on boards with DIFFERENT
// pipelines. A skill no longer hardcodes `status: priorizar`; it asks for the NEXT step
// of THIS board (scripts/advance-card.ts wraps this for the headless skill runs).
//
// PURE — reuses the same primitives the autorun cascade uses, so manual `advance-card`
// and the engine forward agree exactly:
//   - nextBuildStatus  → the next non-skipped step in board order (storyType-aware)
//   - checkGate        → the entry gate of that step
// It deliberately does NOT write; the caller (the script) performs the atomic write.

import { checkGate } from "./gates";
import { nextBuildStatus } from "./pipeline-routing";
import type { BoardConfig, Card } from "./types";

export type AdvanceDecision =
  /** advance the card to `to` (its entry gate passes) */
  | { action: "advance"; from: string; to: string }
  /** the next step exists but its entry gate is unmet — the skill must satisfy it first */
  | { action: "blocked"; from: string; to: string; gate: string }
  /** nowhere to advance: no current status, or the next step is terminal / end of pipeline */
  | { action: "done"; from: string; reason: string };

/**
 * Decide the board-aware forward move for `card`:
 *   - no current status                          → done (nothing to advance)
 *   - no next                                    → done (end of pipeline)
 *   - next is terminal AND current lacks `autoEnterTerminal` → done (closing is explicit); a
 *     current step WITH `autoEnterTerminal` (the `deploy`/Publicar step, ADR-059) advances INTO it
 *   - next step's entry gate fails               → blocked (the skill must satisfy it)
 *   - otherwise                                  → advance to the next step id
 *
 * Mirrors decideForward (cascade-decision.ts) but in an advance-specific shape so a CLI
 * / skill can report the outcome. Monotonic + pure. The "next" is INSTANCE-aware
 * (nextBuildStatus → routeSkip): it skips steps THIS card bypasses — the design block
 * for a non-user story, and the discovery interview / design block for a refine/fix.
 */
/** The HONEST outcome advance-card reports — derived from the DECISION *and* whether the write actually
 *  persisted (`written`), so the CLI's exit code / message / `ok` can never claim a success that didn't
 *  happen. Separated (pure) so that honesty is unit-testable without git. */
export interface AdvanceReport {
  ok: boolean;
  /** 0 advanced/done · 1 blocked (gate unmet) · 3 decided-but-NOT-persisted (silent-failure guard). */
  exitCode: number;
  message: string;
  written: boolean;
}

/**
 * Compute the report for an advance attempt from the decision + the ACTUAL write result.
 *
 * story-m3x2uq — the bug this closes: advance-card printed the optimistic `from → to` and exited 0
 * whenever the DECISION was `advance`, IGNORING whether `updateCardOnDisk` actually wrote (`written`).
 * So a decided-but-unpersisted advance (the card changed between the two reads — a concurrent writer, the
 * in-process lock not spanning processes) read as "success with no effect" — the exact "sucesso aparente"
 * a headless run hit before burning turns misdiagnosing the sandbox. Here the outcome FOLLOWS `written`:
 *   - advance + written (or dryRun) → success (exit 0)
 *   - advance + NOT written          → LOUD failure (exit 3) — never mistake a no-op for done
 *   - blocked                        → exit 1 (the actionable gate reason)
 *   - done                           → exit 0 (nothing to advance)
 * Pure — exported for tests.
 */
export function reportAdvance(
  cardId: string,
  d: AdvanceDecision,
  written: boolean,
  dryRun: boolean,
): AdvanceReport {
  const tag = dryRun ? "[dry-run] " : "";
  switch (d.action) {
    case "advance":
      if (written || dryRun) {
        return { ok: true, exitCode: 0, written, message: `${tag}${cardId}: ${d.from} → ${d.to}${dryRun ? "" : " ✓"}` };
      }
      // Decided to advance but the write did NOT land — the silent-failure this fixes. Loud + actionable.
      return {
        ok: false,
        exitCode: 3,
        written,
        message:
          `${cardId}: decidiu avançar ${d.from} → ${d.to} mas NÃO persistiu — o card mudou entre a leitura e a ` +
          `escrita (write concorrente) ou o gate deixou de passar. NADA foi alterado; re-verifique o card e tente de novo.`,
      };
    case "done":
      return { ok: true, exitCode: 0, written, message: `${tag}${cardId}: sem avanço (${d.reason})` };
    case "blocked":
      return { ok: false, exitCode: 1, written, message: `${cardId}: BLOQUEADO em ${d.from} → ${d.to} — ${d.gate}` };
  }
}

export function decideAdvance(card: Card, config: BoardConfig): AdvanceDecision {
  const from = card.status ?? "";
  if (!from) return { action: "done", from, reason: "card sem status" };
  // A card already IN a terminal step never advances — even if the board declares
  // active re-entry steps (refinar/corrigir) AFTER the terminal in array order, which
  // a forward scan would otherwise walk into. (The engine never forwards a terminal
  // card either; this keeps the helper honest if a skill mistakenly invokes it there.)
  const current = config.statuses.find((s) => s.id === from);
  if (current?.terminal) return { action: "done", from, reason: "card em status terminal" };
  const next = nextBuildStatus(config, from, card);
  if (!next) return { action: "done", from, reason: "sem próximo step (fim do pipeline)" };
  // Parity with decideForward (ADR-059): the next being terminal is `done` UNLESS the current step opts
  // into auto-entering it (`autoEnterTerminal` — the `deploy`/Publicar step → `concluida`). Default-off
  // for every other terminal, so closing the pipeline stays an explicit act everywhere else.
  if (next.status.terminal && !current?.autoEnterTerminal) {
    return { action: "done", from, reason: "sem próximo step (fim do pipeline / terminal)" };
  }
  const gate = checkGate(card, next.status.id, config);
  if (gate) return { action: "blocked", from, to: next.status.id, gate };
  return { action: "advance", from, to: next.status.id };
}
