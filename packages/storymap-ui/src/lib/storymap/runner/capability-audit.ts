// WS3 (F2) — CAPABILITY AUDIT. A run that SUCCEEDS on a step which PROVISIONED a capability at
// `expected` level but never exercised it (the codegraph MCP mounted, no `mcp__graphify__*` in
// toolsUsed) gets a SOFT, GATE-FREE nudge stamped on the card — closing the graphify subutilization
// (6/42 runs, diagnóstico-I4) at the surface the operator actually sees, without ever holding a card.
//
// Same seam as run-death.ts: a SUBSCRIBER of engine.onComplete (registered by trigger-runner-channel
// alongside setupEventLog + registerRunDeathFindings), so the settle stays lean and the durable card
// write happens AFTER teardown. The toolGap itself is computed at settle (where toolsUsed is finalized)
// and rides the completion event — DEFINED (possibly `[]`) on the success emits, undefined otherwise:
//   • non-empty → STAMP the advisory (per step, upsert).
//   • empty     → CLEAR a prior advisory for this step (it used the tool this time).
//   • undefined → not a success emit → ignore.
//
// SERVER-ONLY, best-effort: logs and NEVER throws (a completion callback must not crash on a stamp that
// couldn't write). The durable, aggregate-able signal lives in TelemetryRecord.toolGap regardless — this
// only adds the human-facing card nudge.

import { updateCardOnDisk } from "@/lib/storymap/write";
import { STEP_LABEL_BY_TRIGGER } from "@/lib/storymap/step-rollup";
import { routeUndersizedSkips } from "@/lib/storymap/skip-routing";
import {
  withRouteUndersizedFinding,
  withRouteUndersizedResolved,
  withToolingUnusedFinding,
  withToolingUnusedResolved,
} from "./findings";

/** WS4 — the triggers after which a route-undersizing check is meaningful (the card's hasUiSurface + route
 *  are both settled by harness-enrich, so the mismatch is knowable at plan/dev time — the furo do juiz #1). */
const ROUTE_AUDIT_TRIGGERS = new Set(["harness-plan", "harness-do"]);

/** Minimal port over the engine's completion event — avoids coupling to the concrete engine type. */
interface CapabilityCompletionSource {
  onComplete(fn: (ev: { board: string; cardId: string; trigger: string; toolGap?: string[] }) => void): () => void;
}

/**
 * IO: stamp the tooling-unused advisory (per step) on the card. Best-effort — logs and NEVER throws.
 * Idempotent (upsert by the step id). Called only when the run left a non-empty toolGap on a success.
 */
export async function stampToolingUnusedFinding(
  board: string,
  cardId: string,
  trigger: string,
  toolGap: string[],
): Promise<void> {
  try {
    // O mapa é SEGURO aqui: o lint `step-label-consistency` garante que ele não pode divergir do board.
    // (Ler o BoardConfig só para o rótulo custaria um await a mais no caminho de um callback de conclusão —
    // sem ganho, já que a divergência que motivava isso agora é impossível.)
    const label = STEP_LABEL_BY_TRIGGER[trigger];
    await updateCardOnDisk(board, cardId, (card) => ({
      ...card,
      findings: withToolingUnusedFinding(card.findings ?? [], trigger, toolGap, label),
    }));
    console.warn(
      `[capability-audit ${board}/${cardId}] ${trigger}: capacidade esperada não usada (${toolGap.join(", ")}) ` +
        `→ aviso SOFT carimbado (não bloqueia).`,
    );
  } catch (err) {
    console.error(`[capability-audit ${board}/${cardId}] carimbo falhou:`, err instanceof Error ? err.message : err);
  }
}

/** IO: clear the step's tooling-unused advisory when a later run exercised the tool. Best-effort; skips
 *  the write when nothing is open (no write→watch→eval loop). Never throws. */
export async function clearToolingUnusedFinding(board: string, cardId: string, trigger: string): Promise<void> {
  try {
    await updateCardOnDisk(board, cardId, (card) => {
      const next = withToolingUnusedResolved(card.findings ?? [], trigger, {
        by: `audit:${trigger}`,
        at: new Date().toISOString().slice(0, 10),
      });
      return next ? { ...card, findings: next } : null; // null → no open advisory → skip write
    });
  } catch (err) {
    console.error(`[capability-audit ${board}/${cardId}] limpeza falhou:`, err instanceof Error ? err.message : err);
  }
}

/**
 * WS4 (furo do juiz #1) — DETERMINISTIC route-undersizing audit: read the card once, and if it declares UI
 * surface yet its route skipped the design block, STAMP the SOFT `route-undersized` advisory (else CLEAR a
 * prior one). Runs after a plan/dev success — robust (doesn't depend on the agent remembering to raise it).
 * Best-effort; logs and NEVER throws. Idempotent (single card-scoped id).
 */
export async function auditRouteUndersized(board: string, cardId: string): Promise<void> {
  try {
    await updateCardOnDisk(board, cardId, (card) => {
      const skipped = routeUndersizedSkips(card);
      if (skipped.length) {
        return { ...card, findings: withRouteUndersizedFinding(card.findings ?? [], skipped) };
      }
      const cleared = withRouteUndersizedResolved(card.findings ?? [], {
        by: "audit:route",
        at: new Date().toISOString().slice(0, 10),
      });
      return cleared ? { ...card, findings: cleared } : null; // null → nothing open → skip write
    });
  } catch (err) {
    console.error(`[route-audit ${board}/${cardId}] auditoria falhou:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Subscribe the capability audit to run completions — called ONCE by trigger-runner-channel, without
 * touching engine.ts. Only success emits carry a DEFINED toolGap; a non-empty one stamps, an empty one
 * clears the step's prior advisory. WS4 — the same success emits also drive the route-undersizing audit
 * (for plan/dev triggers).
 */
export function registerCapabilityAudit(engine: CapabilityCompletionSource): void {
  engine.onComplete((ev) => {
    if (ev.toolGap === undefined) return; // not a success emit (cancel/error) → nothing to audit
    if (ev.toolGap.length) void stampToolingUnusedFinding(ev.board, ev.cardId, ev.trigger, ev.toolGap);
    else void clearToolingUnusedFinding(ev.board, ev.cardId, ev.trigger);
    // WS4 — deterministic route-undersizing check after a plan/dev run.
    if (ROUTE_AUDIT_TRIGGERS.has(ev.trigger)) void auditRouteUndersized(ev.board, ev.cardId);
  });
}
