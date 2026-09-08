// Where can a card go RIGHT NOW? — the pure core shared by the kanban focus mode
// (highlight the columns a card may enter) and the card's ⋮ "Mover para" quick action.
// It mirrors the SAME gate check the move action enforces server-side (moveCardAction →
// checkGate), so the UI never offers — nor highlights — a destination the server rejects.

import { checkGate } from "./gates";
import { REOPEN_GATES } from "./reopen";
import type { BoardConfig, Card, GateId, StatusDef } from "./types";

export interface MoveTarget {
  status: StatusDef;
  /** the single most-recommended destination — the natural next stage for this card */
  recommended: boolean;
}

/**
 * Gates that guard OPTIONAL branch / re-entry lanes (refinar/corrigir/descontinuar/
 * duplicado), entered ONLY via an explicit human action that first stamps the brief or
 * pointer. These columns sit in the pipeline array order between human review and the
 * terminal "Concluída", so the recommendation must walk PAST them (when inactive) to reach
 * the real finish — instead of stalling on a lane the card isn't entering. A MANDATORY
 * readiness gate (hasTasks, hasPrioritization, …) is the opposite: when it fails the card
 * genuinely isn't ready, so the recommendation stops there rather than skipping real work.
 */
// The reopen lanes (refinar/corrigir/descontinuar) DERIVE from REOPEN_KINDS via REOPEN_GATES; the
// triage `hasDuplicateOf` "marcar duplicado" lane is the only non-reopen branch, added explicitly.
const BRANCH_GATES: ReadonlySet<GateId> = new Set<GateId>([...REOPEN_GATES, "hasDuplicateOf"]);

/**
 * The statuses a card may move INTO right now — every status whose entry gate passes,
 * minus the card's current one — ordered with the RECOMMENDED destination first, then
 * the remaining eligible statuses in pipeline order.
 *
 * "Recommended" = the natural next destination: walking FORWARD from the card's status,
 * the first stage whose gate passes. Inactive branch/re-entry lanes (BRANCH_GATES) are
 * stepped over (so a card in human review recommends Concluída, not the refinar lane that
 * precedes it in array order); but a failing MANDATORY readiness gate stops the walk (the
 * card isn't ready to advance, so nothing is promoted as "the next step"). For an
 * unstatused card the walk starts at the first stage. Terminal columns CAN be recommended
 * (finishing is a legitimate next step) and are always at least listed.
 *
 * PURE — no React, no IO; fully unit-testable.
 */
export function moveTargets(card: Card, config: BoardConfig): MoveTarget[] {
  const eligible = config.statuses.filter(
    (s) => s.id !== card.status && checkGate(card, s.id, config) === null,
  );
  if (eligible.length === 0) return [];

  const eligibleIds = new Set(eligible.map((s) => s.id));
  const curIdx = config.statuses.findIndex((s) => s.id === card.status);

  // Walk forward (curIdx + 1…; an unstatused card starts at 0): the first ready stage is
  // the recommendation; step over inactive branch lanes; stop at a failing mandatory gate.
  let recommended: StatusDef | null = null;
  for (let i = curIdx + 1; i < config.statuses.length; i++) {
    const s = config.statuses[i];
    if (eligibleIds.has(s.id)) {
      recommended = s;
      break;
    }
    if (s.gate && BRANCH_GATES.has(s.gate)) continue; // inactive branch lane → skip past it
    break; // a mandatory readiness gate isn't met → don't recommend skipping it
  }

  const ordered = recommended
    ? [recommended, ...eligible.filter((s) => s.id !== recommended!.id)]
    : eligible;

  return ordered.map((s) => ({ status: s, recommended: s.id === recommended?.id }));
}

/** The set of status ids a card may move into (cheap membership test for the focus highlight). */
export function movableStatusIds(card: Card, config: BoardConfig): Set<string> {
  return new Set(moveTargets(card, config).map((t) => t.status.id));
}
