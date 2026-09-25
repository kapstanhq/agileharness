// The board-event half of the PUSH POLICY (notifications/push-policy): which push FACT a board write is — shared by
// the two sinks that can take one (web-push, Slack), so "does this card write reach the phone?" has ONE answer.
// Server-only (reads board.yaml for a card.moved's destination).

import type { AgileHarnessEvent } from "../../event";
import { shouldSlack, type PushEventKind } from "../../push-policy";
import { currentPushPolicy } from "../push-policy-config";
import { readBoardConfig } from "@/lib/storymap/repo";
import type { StatusDef } from "@/lib/storymap/types";

/** The board-event facts of the push policy — what a card write can be, as far as the phone is concerned. */
export const BOARD_EVENT_PUSH_KINDS: readonly PushEventKind[] = ["card-demand", "card-needs-you", "card-moved"];

/**
 * Classify a board event into its push FACT (or null — it is never one). Stateful only for the per-card DEMAND
 * dedupe: a card's pending demand is ONE fact per demand TYPE, so repeated card.updated edits (or a count changing
 * within the same type, e.g. answering 1 of 2 questions) are not new facts; the memory is cleared when the card has
 * no demand, so a future re-appearance is. One instance per sink (web-push, Slack) — they must not steal each
 * other's first sighting. `toDef` is the DESTINATION status of a card.moved (null when unknown).
 */
export class BoardEventPushClassifier {
  private notifiedDemands = new Map<string, string>();

  classify(event: AgileHarnessEvent, toDef: Pick<StatusDef, "autorun" | "terminal"> | null | undefined): PushEventKind | null {
    const key = `${event.boardId}/${event.cardId}`;
    // 1) A pending HUMAN DEMAND on the card (question/blocker/review/gate) — even when the card did NOT move
    //    (harness-grill writes questions in place — story-rl5v03). Skip card.created (a brain-dump capture would
    //    be a storm); dedupe per card by demand type.
    if (event.demand && event.cardId && event.type !== "card.created") {
      if (this.notifiedDemands.get(key) === event.demand.type) return null; // same demand already seen
      this.notifiedDemands.set(key, event.demand.type);
      return "card-demand";
    }
    if (event.cardId && !event.demand) this.notifiedDemands.delete(key);
    // 2) Otherwise: a card.moved. "Needs you" = it entered a NON-terminal status that does NOT autorun — the
    //    pipeline parks there and waits for a human. Derived from board.yaml (autorun !== true && !terminal), so
    //    it survives pipeline edits with zero hardcoded status ids.
    if (event.type !== "card.moved" || !event.cardId) return null;
    return toDef && toDef.autorun !== true && toDef.terminal !== true ? "card-needs-you" : "card-moved";
  }
}

/** The destination status of a card.moved (the only event whose classification reads board.yaml). */
export async function destinationOf(event: AgileHarnessEvent): Promise<StatusDef | null> {
  if (event.type !== "card.moved" || !event.cardId) return null;
  const config = await readBoardConfig(event.boardId).catch(() => null);
  return config?.statuses.find((s) => s.id === event.toStatus) ?? null;
}

/**
 * The SAME rule for the Slack sink: a board event is posted only as a critical fact (by default, none is). Before
 * v0.9 the Slack channel posted EVERY card write — the phone buzzed for the whole board through another app.
 * slack-channel.ts owns the webhook; the rule lives here, next to the classifier it shares with web-push.
 */
export async function slackWorthyBoardEvent(
  classifier: BoardEventPushClassifier,
  event: AgileHarnessEvent,
): Promise<boolean> {
  const policy = currentPushPolicy();
  if (!BOARD_EVENT_PUSH_KINDS.some((k) => shouldSlack(k, policy))) return false;
  const kind = classifier.classify(event, await destinationOf(event));
  return !!kind && shouldSlack(kind, policy);
}
