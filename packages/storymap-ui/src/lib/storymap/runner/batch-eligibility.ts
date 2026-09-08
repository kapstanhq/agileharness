// batch-eligibility.ts — WS7 (F6) — PURE server-side validation for a GROUP-RUN admission (many sibling
// cards processed in ONE run/worktree/spawn, one merge-train entry). NO I/O: the caller passes the resolved
// facts (each card's status, storyType, the step trigger, the resolved toolkit mount set, and the group's
// intra deps). Returns NAMED violations (per card / per rule) so the operator sees exactly why a group was
// refused — never a silent drop. Board-agnostic: the only skill-specific fact is `AgentDef.batchable`, read
// from the registry by the caller. The kernel/engine consume the boolean result; this decides nothing itself.

import type { TriggerId } from "../types";

/** The per-card facts the eligibility check reads (all resolved by the caller — this module is pure). */
export interface BatchCandidate {
  /** `board/cardId` — the batch key (matches enqueue_batch). */
  key: string;
  board: string;
  cardId: string;
  /** the card's current status id (must match across the group). */
  status: string;
  /** the effective trigger of that status (must match + be batchable). */
  trigger: TriggerId;
  /** whether the trigger's skill writes code (isCode) — a non-code skill never group-runs. */
  isCode: boolean;
  /** whether the trigger is declared `batchable` in the registry (v1: only harness-do). */
  batchable: boolean;
  /** the resolved toolkit MOUNT SET (sorted mcpConfigPaths) — the group must share an identical toolkit so
   *  the single spawn provisions the same capabilities for every member. */
  toolkitMounts: string[];
}

export interface BatchEligibility {
  ok: boolean;
  /** named reasons the group was refused (empty when ok). */
  violations: string[];
}

/** Default cap on a group's size — a bigger group risks one bad member stalling the rest; keep it small. */
export const DEFAULT_MAX_GROUP_SIZE = 3;

/**
 * Decide whether `candidates` may run as ONE group. All-or-nothing: any failing rule refuses the WHOLE
 * group with a named violation. Rules (WS7 blueprint):
 *   - ≥2 members (a group of 1 is just a normal run — not an error, but not a group either);
 *   - within `maxGroupSize` (default {@link DEFAULT_MAX_GROUP_SIZE});
 *   - SAME board;
 *   - SAME status AND SAME trigger;
 *   - the trigger is `batchable` AND `isCode` (v1: only harness-do);
 *   - IDENTICAL resolved toolkit mount set (the one spawn provisions the same tools for all);
 *   - NO intra-group `depends-on` edge (a dependency ⇒ sequence via deps, not a concurrent group).
 * `internalDeps` are the group-internal scheduling edges (from depsFromLinks, filtered to this set). PURE.
 */
export function checkBatchEligibility(
  candidates: BatchCandidate[],
  internalDeps: { from: string; to: string }[] = [],
  opts?: { maxGroupSize?: number },
): BatchEligibility {
  const violations: string[] = [];
  const max = opts?.maxGroupSize ?? DEFAULT_MAX_GROUP_SIZE;
  const keys = new Set(candidates.map((c) => c.key));

  if (candidates.length < 2) violations.push("grupo precisa de ≥2 cards (um card só roda normal, sem grupo)");
  if (candidates.length > max) violations.push(`grupo excede o teto de ${max} cards (${candidates.length})`);

  const boards = new Set(candidates.map((c) => c.board));
  if (boards.size > 1) violations.push(`cards de boards diferentes não agrupam: ${[...boards].join(", ")}`);

  const statuses = new Set(candidates.map((c) => c.status));
  if (statuses.size > 1) violations.push(`cards em status diferentes não agrupam: ${[...statuses].join(", ")}`);

  const triggers = new Set(candidates.map((c) => c.trigger));
  if (triggers.size > 1) violations.push(`cards com triggers diferentes não agrupam: ${[...triggers].join(", ")}`);

  for (const c of candidates) {
    if (!c.batchable) violations.push(`${c.cardId}: o trigger "${c.trigger}" não é batchable (só harness-do na v1)`);
    if (!c.isCode) violations.push(`${c.cardId}: o trigger "${c.trigger}" não é de código — não agrupa`);
  }

  // Identical toolkit mount set across the group (order-insensitive).
  const toolkitSig = (c: BatchCandidate) => [...c.toolkitMounts].sort().join("|");
  const sigs = new Set(candidates.map(toolkitSig));
  if (sigs.size > 1) violations.push("toolkit resolvido difere entre os cards — o spawn único proveria capacidades diferentes");

  // No intra-group dependency: a depends-on between two members means they must SEQUENCE, not run together.
  for (const e of internalDeps) {
    if (keys.has(e.from) && keys.has(e.to)) {
      violations.push(`dependência interna ao grupo (${e.from} → ${e.to}): use deps (sequência), não grupo`);
    }
  }

  return { ok: violations.length === 0, violations };
}
