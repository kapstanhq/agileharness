// Cascade decision kernel — the PURE core of the autorun pipeline, extracted from
// trigger-runner-channel.ts so the RUN / FORWARD / STOP branch logic is unit-testable
// without spawning a process or touching the filesystem.
//
// The channel keeps the side-effectful shell (the live master-switch read, the fs
// reads of the board + card, the engine.runSkill spawn, the writeCard forward, the
// re-entrant dedup). This module decides ONLY "given a card and its board config,
// what should the cascade do?" — pure, so it depends on nothing but gates (also pure).

import { checkGate } from "@/lib/storymap/gates";
import { nextBuildStatus } from "@/lib/storymap/pipeline-routing";
import { routeSkip, triggerForCard } from "@/lib/storymap/skip-routing";
import type { BoardConfig, Card, StatusDef, TriggerId } from "@/lib/storymap/types";

export type CascadeDecision =
  | { action: "run"; trigger: TriggerId }
  | { action: "forward"; to: string }
  | { action: "stop"; reason: string };

/** Options for {@link decideCascade}. */
export interface CascadeOpts {
  /**
   * The skill that JUST finished, when re-evaluating on run-completion. If the card is
   * still resting in a column whose trigger equals it (i.e. the run did NOT advance the
   * card), STOP instead of re-firing the same skill — the loop guard that keeps a
   * failing/no-op run from re-spawning itself. Omitted on the watcher (event) path.
   */
  suppressTrigger?: TriggerId;
}

/**
 * Decide what the autorun cascade should do for `card` sitting in its current status:
 *   - the card has no status, OR its status id is unknown to the board  → STOP
 *   - the status is one THIS card instance skips (routeSkip)             → FORWARD past it
 *   - the status is manual (autorun !== true)                            → STOP
 *   - the status has a `trigger` (≠ suppressTrigger)                    → RUN that skill
 *   - the status's trigger === suppressTrigger (didn't advance)         → STOP (no retry loop)
 *   - the status is a gated landing (no trigger)                         → FORWARD (see decideForward)
 *
 * The skip is evaluated BEFORE the manual guard ON PURPOSE: a non-skip card has no
 * business resting in a step it bypasses, so the cascade forwards it past the block
 * even when that column is `autorun:false` (so the auto-skip works on EVERY board,
 * not only where the step is autorun:true). The skip is INSTANCE-AWARE (routeSkip,
 * skip-routing.ts): the static storyType case (a non-user story skips the design
 * block) PLUS the reopen overrides (a refine/fix skips the discovery interview; a
 * TEXT/BEHAVIOUR-only refine skips the design block) and any persisted per-instance
 * decision. The manual guard still governs every NON-skip status (e.g. the `pronta`
 * go/no-go) and every step a `user` build story traverses.
 *
 * PURE — assumes the master switch is already ON and the card was read from disk.
 */
export function decideCascade(card: Card, config: BoardConfig, opts: CascadeOpts = {}): CascadeDecision {
  if (!card.status) return { action: "stop", reason: "no-status" };
  const status = config.statuses.find((s) => s.id === card.status);
  if (!status) return { action: "stop", reason: "manual" };
  // skip branch: a status THIS card instance doesn't traverse — FORWARD straight past it
  // to the next status it does (decideForward skips the whole run of skip-statuses at once),
  // instead of running its trigger. The decision is INSTANCE-AWARE (routeSkip): the static
  // storyType case (a non-user story has no UI surface → skips the design block) PLUS the
  // reopen overrides (a refine/fix skips the discovery interview; a TEXT/BEHAVIOUR-only refine
  // skips the design block) and any per-instance persisted decision (card.routing.skips). This
  // runs BEFORE the manual guard so a skip-status forwards even under autorun:false.
  if (routeSkip(status, card)) {
    return decideForward(card, status, config);
  }
  // ADR-059: a step that declares `autoEnterTerminal` (the `deploy`/Publicar step) auto-advances into the
  // next terminal step even though it is `autorun:false` — the human Deploy CLICK is the trigger, the
  // forward into `concluida` (No ar) is the consequence. This runs BEFORE the manual guard so the
  // autorun:false Deploy still forwards on entry (the move fires the onEnter promote+deploy effect in
  // parallel; here we only decide the forward). It runs no trigger (deploy has none) — just decideForward,
  // which the new terminal guard below allows precisely because THIS status sets autoEnterTerminal.
  if (status.autoEnterTerminal) return decideForward(card, status, config);
  // MODE-AWARE OVERRIDE (reabertura R1): a card reopened for refine/fix runs its DEDICATED skill
  // (harness-refine/harness-fix) at its chosen destination column, overriding that column's normal trigger —
  // gated by the one-shot `reopenPending` flag (the skill clears it on its first pass, so downstream
  // columns run their OWN mode-aware skill while `mode` persists). Computed UP FRONT so the override
  // can fire even on an autorun:false column: an EXPLICIT human reopen INTO this column IS the trigger
  // (analogous to how autoEnterTerminal forwards from an autorun:false step), so the manual guard below
  // is bypassed ONLY for an active override. A normal card's effectiveTrigger === status.trigger, so the
  // manual guard still governs it unchanged. The loop-guard keys on the EFFECTIVE trigger: a reopen skill
  // that JUST ran and did NOT advance (suppressTrigger === effectiveTrigger) STOPs instead of re-firing.
  const effectiveTrigger = status.trigger ? triggerForCard(card, status.trigger) : undefined;
  const reopenOverride = !!effectiveTrigger && effectiveTrigger !== status.trigger;
  if (!reopenOverride && status.autorun !== true) return { action: "stop", reason: "manual" };
  if (effectiveTrigger) {
    if (opts.suppressTrigger && effectiveTrigger === opts.suppressTrigger) {
      return { action: "stop", reason: "already-ran" };
    }
    return { action: "run", trigger: effectiveTrigger };
  }
  return decideForward(card, status, config);
}

/**
 * Decide the FORWARD target for a status (the cascade bridge):
 *   - no next status                               → STOP (end of pipeline)
 *   - the next is terminal AND the source step does NOT set `autoEnterTerminal` → STOP (closing is
 *     an explicit act); a source step WITH `autoEnterTerminal` (the `deploy`/Publicar step, ADR-059)
 *     is the one exception that auto-advances into the terminal `concluida` on a successful Deploy
 *   - the next status's entry gate fails           → STOP (never forward past a gate)
 *   - otherwise                                    → FORWARD to the next status id
 *
 * The "next" status is INSTANCE-aware (nextBuildStatus → routeSkip): a `user` build
 * story lands on idx+1, but a non-user story (and a TEXT/BEHAVIOUR-only refine) skips
 * the design block in one hop — so the design gate (hasWireframe) is never even
 * evaluated for a card with no UI surface. Monotonic (only ever scans forward) so the
 * cascade terminates. PURE.
 */
export function decideForward(card: Card, status: StatusDef, config: BoardConfig): CascadeDecision {
  const next = nextBuildStatus(config, status.id, card);
  if (!next) return { action: "stop", reason: "no-next-or-terminal" };
  // Closing the pipeline is an explicit act → the cascade NEVER enters a terminal, UNLESS the SOURCE
  // step opts in via `autoEnterTerminal` (ADR-059: the `deploy`/Publicar step → `concluida` on a
  // successful Deploy). Default-off keeps every other terminal (re-entry close, archived) human-driven,
  // so the kernel stays pure/column-agnostic — it reads only this declarative flag, never a hardcoded id.
  if (next.status.terminal && !status.autoEnterTerminal) return { action: "stop", reason: "no-next-or-terminal" };
  const gateError = checkGate(card, next.status.id, config);
  if (gateError) return { action: "stop", reason: `gate: ${gateError}` };
  return { action: "forward", to: next.status.id };
}
