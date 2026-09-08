// noop-rearm.ts — WS-12.3 (D16) — the THREE ways out of the per-item anti-noop backoff, each with an OWNER.
//
// The backoff of WS-5.4 had exactly one exit: the item's own progress. Which required the card to move, which
// required the tick to act, which the backoff forbade — a deadlock (colisão #7, the same shape as the guarda C2
// deadlock of colisão #4). Worse: an EXTERNAL change of fact — the deploy pipeline being fixed on 2026-07-16 —
// re-armed nothing at all. The exits:
//
//   1. PROGRESS (already exists, elsewhere): the item leaves the actionable set ⇒ pruned on the next bump.
//   2. HUMAN, one click: the chip on Inbox → `rearmNoopItem({by: "human"})`. Advisory: the human never has
//      to justify anything to the machine; the copiloto's diary records who re-armed it.
//   3. STEWARD (WS-8.2), with a change of fact it can PROVE: the deploy pipeline is green again (a later deploy
//      of another card passed), or convergence shows the code already landed (WS-5 deltaLanded). No proof ⇒ NO
//      re-arm: the item stays with the human. Same fail-closed as D14/D11 — doubt is not evidence.
//   4. DOCTRINE REVOKED (autonomy-endgame WS-4 — automatic, ONCE per bump): the item was given up on under a
//      rule that NO LONGER EXISTS. Not a fact about the CARD (those are inference and are forbidden, below) —
//      a fact about the SYSTEM, with an owner (whoever raised AUTONOMO_DOCTRINE_VERSION), monotonic and rare.
//      Each item gets PER_ITEM_NOOP_MAX tries PER DOCTRINE, not forever. Mechanism: the streak carries the
//      doctrine it was taken under (orchestrator-state.ts NoopStreak); itemsInNoopBackoff only counts entries
//      stamped with the doctrine IN FORCE. Legacy `number` entries coerce to `doctrine: "pre"`, which never
//      matches — so the items stuck when this shipped re-armed themselves on the next tick, no click.
//      WHY IT IS NOT A LOOP: the cap is not weakened, it is RE-ISSUED. Fixed doctrine ⇒ 2 tries forever,
//      exactly as today. New doctrine ⇒ 2 more, once. The version is a hand-edited literal, so the number of
//      re-arms in a year equals the number of times a human DECIDED to change the agent's behaviour — which is
//      precisely when retrying is right. Its existence answers the case that made this necessary: the fix of
//      2026-07-17 (the "decide questions with options" rule) could not reach the very items it was written
//      for, because they had already left the actionable set.
//
// What is REJECTED and must not come back (D16): an automatic fact-signature derived from card fields
// (`card.updated`/status/findings). The churn of the failed attempt ITSELF moves those fields (a deploy fails ⇒
// a new finding ⇒ `updated` advances) ⇒ every attempt would look like "a new fact" ⇒ the streak would never
// grow ⇒ the 2026-07-15 no-op loop returns. Re-arm by fact is EXPLICIT and owned, never inferred.
// Exit 4 does NOT re-open that door, and the distinction is the whole reason it is allowed: a doctrine version
// is untouched by the attempt (the tick cannot edit it), owned, monotonic and rare — the four properties the
// card-derived signature fails on every count. The two sibling proposals fail too, for the same reason:
// a TIME TTL ("re-arm after 6h") is not a fact at all (an item the tick cannot solve at 03:00 is not solvable
// at 09:00 — it just buys the loop back, billed hourly), and RE-ARM ON DEPLOY is the card-churn problem by
// another door (the board deploys all day ⇒ every deploy re-arms everything ⇒ the streak never reaches 2).

import { appendCopilotActivity } from "@/lib/storymap/copilot/activity";
import { clearNoopItem, markStewardRearm, readOrchestratorState, writeOrchestratorState } from "./orchestrator-state";

/** Who is asking for the re-arm. `human` never needs a proof; `steward` (the autonomous copiloto) always does. */
export type RearmActor = "human" | "steward";

/**
 * The families of proof the steward may present — as a RUNTIME array, not only a union of literals.
 *
 * Why an array: this union carried `deploy-recovered` and `conflict-resolved` with ZERO producers for its
 * whole life. A declared-but-unproduced kind reads as a working feature and is dead code with a good name;
 * concretely it meant every item that fell into the anti-noop backoff waited for a human click, while the
 * type promised the machine could free it. A literal union cannot be enumerated at runtime, so NOTHING could
 * assert the promise. `rearm-proof-exhaustiveness.test.ts` now enumerates THIS and demands a real producer
 * per kind (the molde of `gate-exhaustiveness.test.ts`). Adding a kind here without a producer fails RED.
 *
 * `conflict-resolved` was REMOVED rather than given a producer: the honest fix for a type with no producer
 * is to delete the type, not to invent a weak signal so the registry has something to point at.
 */
export const REARM_PROOF_KINDS = ["deploy-recovered", "delta-landed"] as const;

export type RearmProofKind = (typeof REARM_PROOF_KINDS)[number];

/**
 * The steward's evidence that the blocking FACT changed. `kind` is the machine-checkable family; `detail` is
 * what the diary shows the operator (the deploy/run/commit that proves it). Both are required — a `detail` of
 * whitespace is no proof.
 */
export interface RearmProof {
  kind: RearmProofKind;
  detail: string;
}

export interface RearmInput {
  board: string;
  /** the cockpit item id, exactly as it appears in `noopByItem` (e.g. `story-xfleex:approval:release`). */
  itemId: string;
  by: RearmActor;
  proof?: RearmProof;
}

export type RearmDecision = { ok: true } | { ok: false; error: string };

/**
 * May this re-arm proceed? PURE — the whole policy of exit #3 in one testable predicate.
 * The steward's proof must be BOTH a known kind and carry a non-empty detail: an empty detail is a claim, not
 * evidence, and the point of the gate is that the machine only re-arms what it can show.
 */
export function rearmAllowed(by: RearmActor, proof?: RearmProof): RearmDecision {
  if (by === "human") return { ok: true };
  if (!proof || !proof.detail.trim()) {
    return {
      ok: false,
      error:
        "Re-arm do steward exige PROVA de que o fato mudou (ex.: deploy posterior verde, delta já aterrissado). " +
        "Sem prova o item continua com o humano — re-arme pelo Inbox.",
    };
  }
  return { ok: true };
}

/** The diary line each owner leaves — the re-arm is never silent (it changes who is driving the item). */
function rearmNote(input: RearmInput): { kind: "acted"; text: string; detail?: string } {
  return input.by === "human"
    ? { kind: "acted", text: `Você me re-armou em \`${input.itemId}\` — vou tentar de novo no próximo ciclo.`, detail: input.board }
    : {
        kind: "acted",
        text: `Re-armei \`${input.itemId}\`: o fato que me bloqueava mudou (${input.proof?.kind}).`,
        detail: input.proof?.detail,
      };
}

/**
 * Clear ONE item's anti-noop streak so the tick tries it again, and record WHO re-armed it (and, for the
 * steward, the proof) in the copiloto's diary. Best-effort on the diary (never blocks the re-arm); the state
 * write itself is the same fail-open IO as the rest of orchestrator-state.
 *
 * The write DISPATCHES BY ACTOR, and the two doors are not interchangeable:
 *   • `human` → {@link clearNoopItem}: the entry is deleted outright. A human re-arm owes the machine no
 *     accounting, and forgetting is the point (the item starts over, clean).
 *   • `steward` → {@link markStewardRearm}: `streak: 0` + a stamp, so the item leaves backoff while the
 *     one-machine-re-arm-per-doctrine cap and the observed baseline SURVIVE. Routing the machine through the
 *     deleting door would erase the very evidence that bounds it — a cap that forgets is not a cap.
 */
export async function rearmNoopItem(input: RearmInput): Promise<RearmDecision> {
  const decision = rearmAllowed(input.by, input.proof);
  if (!decision.ok) return decision;
  const state = await readOrchestratorState(input.board);
  const next =
    input.by === "human"
      ? clearNoopItem(state, input.itemId)
      : markStewardRearm(state, input.itemId, new Date().toISOString());
  await writeOrchestratorState(input.board, next);
  await appendCopilotActivity(input.board, rearmNote(input)).catch(() => {});
  return { ok: true };
}
