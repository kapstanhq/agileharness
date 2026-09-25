// Slack channel — a server-side sink. Disabled unless a webhook URL is configured, so it is zero-cost until
// you opt in:
//
//   AGILEHARNESS_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
//
// Since v0.9 it follows the PUSH POLICY (notifications/push-policy): Slack is another way the phone buzzes, so a
// board event is posted only when it is a fact the owner listed as critical — by default none is (before, EVERY
// card write was posted). The critical AgentAlerts (capacity latch, deploy rollback, board-declared signals) reach
// Slack through the alert bus, under the same rule.
//
// To add another channel (Discord, email, a DB audit log, …) copy this shape:
// implement NotificationChannel and register it in dispatcher.ts. Nothing else
// in the pipeline needs to change.

import type { NotificationChannel, AgileHarnessEvent } from "../../event";
import { describeEvent } from "../../event";
import { BoardEventPushClassifier, slackWorthyBoardEvent } from "./board-event-push";

export function createSlackChannel(): NotificationChannel | null {
  const url = process.env.AGILEHARNESS_SLACK_WEBHOOK_URL;
  if (!url) return null;
  const classifier = new BoardEventPushClassifier();

  return {
    id: "slack",
    async notify(event: AgileHarnessEvent) {
      if (!(await slackWorthyBoardEvent(classifier, event))) return;
      const { title, body } = describeEvent(event);
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${title}* — ${body}  _(${event.boardId})_` }),
      });
    },
  };
}

/**
 * Um AVISO pronto (não um evento de board) para o mesmo webhook — quem chama é o barramento de avisos (e a ponte
 * de runs falhos), e só para o que a política de push lista como CRÍTICO. Mesmo opt-in do canal: sem webhook,
 * no-op. NUNCA lança (um Slack fora do ar não pode derrubar quem avisa).
 */
export async function sendSlackAlert(title: string, body: string): Promise<void> {
  const url = process.env.AGILEHARNESS_SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*${title}* — ${body}` }),
    });
  } catch (err) {
    console.error("[slack] aviso falhou:", err instanceof Error ? err.message : err);
  }
}
