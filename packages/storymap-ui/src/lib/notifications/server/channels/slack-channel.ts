// Slack channel — example of a future server-side sink. Disabled unless a
// webhook URL is configured, so it is zero-cost until you opt in:
//
//   AGILEHARNESS_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
//
// To add another channel (Discord, email, a DB audit log, …) copy this shape:
// implement NotificationChannel and register it in dispatcher.ts. Nothing else
// in the pipeline needs to change.

import type { NotificationChannel, AgileHarnessEvent } from "../../event";
import { describeEvent } from "../../event";

export function createSlackChannel(): NotificationChannel | null {
  const url = process.env.AGILEHARNESS_SLACK_WEBHOOK_URL;
  if (!url) return null;

  return {
    id: "slack",
    async notify(event: AgileHarnessEvent) {
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
 * Um AVISO pronto (não um evento de board) para o mesmo webhook — hoje só o governador de capacidade o usa, e
 * só para o que é CRÍTICO (runner/capacity-notify.ts). Mesmo opt-in do canal: sem webhook, no-op. NUNCA lança
 * (um Slack fora do ar não pode derrubar quem avisa).
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
