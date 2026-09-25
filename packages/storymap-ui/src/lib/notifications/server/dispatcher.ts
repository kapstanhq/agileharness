// Dispatcher — the single fan-out point. The watcher detects a change and calls
// dispatch(event); the dispatcher delivers it to every registered server-side
// channel (SSE bridge, Slack, …). One channel throwing never blocks the others.
//
// Process-global singleton (survives HMR). Channels are registered once on first
// access: the SSE broadcaster is always on; optional channels self-gate on env.

import type { NotificationChannel, AgileHarnessEvent } from "../event";
import { getBroadcaster } from "./sse-broadcaster";
import { createSlackChannel } from "./channels/slack-channel";
import { createCopilotWakeChannel } from "./channels/copilot-wake-channel";
import { createTriggerRunnerChannel } from "./channels/trigger-runner-channel";
import { createWebPushChannel, initRunnerFailurePush } from "./channels/web-push-channel";
import { createCriticalSignalChannel } from "./channels/critical-signal-channel";
import { publishAgentAlert } from "./alert-bus";
import { createDeliveryAuditChannel } from "./channels/delivery-audit-channel";
import { readBoardConfig, readCard } from "@/lib/storymap/repo";
import { readTransitions } from "@/lib/storymap/runner/transitions";
import { updateCardOnDisk } from "@/lib/storymap/write";

class Dispatcher {
  private channels: NotificationChannel[] = [];

  register(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  async dispatch(event: AgileHarnessEvent): Promise<void> {
    await Promise.all(
      this.channels.map(async (ch) => {
        try {
          await ch.notify(event);
        } catch (err) {
          console.error(`[notifications] channel "${ch.id}" failed`, err);
        }
      }),
    );
  }
}

const KEY = Symbol.for("storymap.notifications.dispatcher");
const store = globalThis as unknown as { [KEY]?: Dispatcher };

export function getDispatcher(): Dispatcher {
  if (store[KEY]) return store[KEY];

  const dispatcher = new Dispatcher();
  dispatcher.register(getBroadcaster()); // always: the bridge to the browser
  // Slack and phone push both follow the PUSH POLICY (notifications/push-policy — "push só para o crítico"):
  // by default no plain board write reaches either; the Inbox holds them.
  const slack = createSlackChannel(); // opt-in via AGILEHARNESS_SLACK_WEBHOOK_URL
  if (slack) dispatcher.register(slack);
  // Phone push: opt-in via AGILEHARNESS_VAPID_* keys. The channel classifies a card write (demand / needs-you /
  // moved); the bridge wires runner failures (which flow through the registry, NOT this dispatcher) into the same
  // push sender. Each fact goes out only when the policy lists it.
  const webPush = createWebPushChannel();
  if (webPush) dispatcher.register(webPush);
  initRunnerFailurePush(); // no-op when neither push nor Slack is configured
  // The board-declared CRITICAL signals (board.yaml notifications.criticalTitlePrefixes): a card born with one of
  // those prefixes becomes a `critical-signal` alert on the bus — once per card. Always registered; a board with no
  // prefixes never emits.
  dispatcher.register(createCriticalSignalChannel({ readBoardConfig, publish: (a) => publishAgentAlert(a) }));
  // The ultra DELIVERY AUDIT (delivery-audit.ts): a story that reaches a `delivered` status through an autonomous
  // path is sampled onto the owner's Inbox. Always registered; a board without ultra never stamps. It sits HERE —
  // the observer of every write — because a card reaches "No ar" through many writers (deploy settle, MCP move,
  // cascade, a skill editing the file).
  dispatcher.register(createDeliveryAuditChannel({ readBoardConfig, readCard, readTransitions, updateCardOnDisk }));
  // Always registered; gated LIVE per event by autorun.enabled (settings.yaml)
  // or AGILEHARNESS_AUTORUN=0 (env) — so the Config panel can toggle it without a restart.
  dispatcher.register(createTriggerRunnerChannel());
  // O copiloto AUTÔNOMO acorda por evento (card travado, finding novo, item na fila de decisão) em vez de só
  // pelo tick de 30min. Sempre registrado; gated ao vivo (orchestrator.enabled + wake.enabled + o board estar
  // em `autonomous`) dentro do channel — um board em off/paired nunca acorda.
  dispatcher.register(createCopilotWakeChannel());

  store[KEY] = dispatcher;
  return dispatcher;
}
