// Web Push channel — the server sink that delivers an AgileHarness event to the user's
// PHONE as a real push notification, even with the app/tab CLOSED. Unlike the client
// WebNotificationChannel (Notification API, needs the tab open + SSE connected), this
// rides the Web Push protocol: the server POSTs an encrypted payload to the browser's
// push service, which wakes the installed PWA's service worker (public/sw.js). It is
// zero-cost until the VAPID keys are configured (mirrors the Slack channel's opt-in
// shape), so a dev without keys pays nothing.
//
// TWO trigger sources can feed push — and since v0.9 NEITHER pushes by default. Each fact below has a name in
// the push POLICY (notifications/push-policy: "push só para o crítico"), and only the facts the owner lists as
// critical (`settings.yaml` → `notifications.push.critical`) reach the phone; the rest wait in the Inbox:
//   - AgileHarnessEvent (dispatcher): a card's pending DEMAND (event.demand — question/blocker/review/
//     gate) → `card-demand` EVEN WITH NO move (story-rl5v03); card.moved into a manual stop → `card-needs-you`;
//     any other card.moved → `card-moved`. card.created (capture storms) and demand-less updated/deleted are
//     never a push fact (a board-declared CRITICAL card is — through the alert bus, see critical-signal-channel).
//   - RunnerFailure (registry): a headless harness-* run failed → `run-failed`. The registry — NOT the
//     dispatcher — is the source, so we subscribe to it directly (non-invasive; the
//     same public API the SSE route uses), de-duping by failure key.

import type { NotificationChannel, AgileHarnessEvent } from "../../event";
import { describeEvent } from "../../event";
import { shouldPush, shouldSlack, type PushEventKind } from "../../push-policy";
import { loadSubscriptions, removeSubscription } from "../push-store";
import { currentPushPolicy } from "../push-policy-config";
import { BOARD_EVENT_PUSH_KINDS, BoardEventPushClassifier, destinationOf } from "./board-event-push";
import { sendSlackAlert } from "./slack-channel";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";

/** What the service worker receives (public/sw.js reads exactly these fields). */
interface PushPayload {
  title: string;
  body: string;
  /** collapses bursts on the same card into one notification */
  tag: string;
  /** deep-link opened on tap (notificationclick) */
  url: string;
  /** high → requireInteraction + vibrate in the SW */
  priority: "normal" | "high";
}

/**
 * O contato VAPID — DECLARADO, nunca assumido.
 *
 * O default embutido aqui era o `mailto:` do autor: numa instalação de terceiro, o serviço de push
 * (FCM/Mozilla/Apple) passava a ter o endereço de OUTRA PESSOA como responsável pelo tráfego — é
 * para lá que ele escreve quando um envio degrada ou abusa. O campo identifica quem opera; herdá-lo
 * por default é anunciar um responsável que não concordou em ser.
 *
 * A ausência não quebra nada: o push é opt-in e simplesmente não liga sem contato (mesma disciplina
 * das duas chaves). O RFC 8292 exige o campo, então inventá-lo seria a única alternativa.
 */
function vapidSubject(): string | null {
  const declared = (process.env.AGILEHARNESS_VAPID_SUBJECT ?? "").trim();
  if (!declared) return null;
  return /^(mailto:|https:\/\/)/i.test(declared) ? declared : null;
}

/** Push is live only when both VAPID keys AND the declared contact are present (opt-in, like Slack). */
export function isPushConfigured(): boolean {
  return !!(process.env.AGILEHARNESS_VAPID_PUBLIC_KEY && process.env.AGILEHARNESS_VAPID_PRIVATE_KEY && vapidSubject());
}

// web-push is imported LAZILY (dynamic import), never statically. A static
// `import ... from "web-push"` drags its transitive deps (https-proxy-agent →
// agent-base → node net/http/https) into the instrumentation.ts → watcher → dispatcher
// → here chunk, and Next 14 fails the build trying to bundle those builtins. Deferring
// to a runtime import keeps web-push out of that graph — it loads as a plain node
// require the first time we actually send a push (a runtime-only path).
type WebPush = typeof import("web-push");
let _webpush: WebPush | null = null;
let vapidReady = false;

async function ensureVapid(): Promise<WebPush | null> {
  if (!isPushConfigured()) return null;
  if (!_webpush) {
    // web-push is CommonJS (`export =`); the dynamic import may arrive bare or wrapped
    // in `.default` depending on interop — accept either.
    const mod = await import("web-push");
    _webpush = ((mod as unknown as { default?: WebPush }).default ?? mod) as WebPush;
  }
  const webpush = _webpush;
  if (!vapidReady) {
    webpush.setVapidDetails(
      vapidSubject()!,
      process.env.AGILEHARNESS_VAPID_PUBLIC_KEY!,
      process.env.AGILEHARNESS_VAPID_PRIVATE_KEY!,
    );
    vapidReady = true;
  }
  return webpush;
}

/** Deliver one payload to every stored subscription; prune the ones the push service rejects as gone. */
export async function sendPush(payload: PushPayload): Promise<void> {
  const webpush = await ensureVapid();
  if (!webpush) return;
  const subs = loadSubscriptions();
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        // 404/410 = subscription expired/unsubscribed at the push service → drop it.
        if (code === 404 || code === 410) removeSubscription(sub.endpoint);
        else console.error(`[web-push] send failed (${code ?? "?"})`, (err as Error).message);
      }
    }),
  );
}

/** Pure: a pending-demand event → its push payload (no dedup, no IO). null when the event carries no demand. */
export function demandPushPayload(event: AgileHarnessEvent): PushPayload | null {
  if (!event.demand || !event.cardId) return null;
  const name = event.title ? `“${event.title}” ` : "";
  const high = event.demand.severity === "critical" || event.demand.severity === "high";
  return {
    title: `⏳ Precisa de você — ${event.demand.label}`,
    body: `${name}${event.boardName ?? event.boardId} aguarda sua ação`,
    tag: `storymap:${event.boardId}:${event.cardId}`,
    url: `/board/${event.boardId}`,
    priority: high ? "high" : "normal",
  };
}

/** Pure: a classified board event → its push payload. */
export function boardEventPushPayload(kind: PushEventKind, event: AgileHarnessEvent): PushPayload | null {
  if (kind === "card-demand") return demandPushPayload(event);
  const tag = `storymap:${event.boardId}:${event.cardId}`;
  const url = `/board/${event.boardId}`;
  if (kind === "card-needs-you") {
    const where = event.toStatusName ?? event.toStatus ?? "";
    const name = event.title ? `“${event.title}” ` : "";
    return {
      title: `⏳ Precisa de você — ${where}`,
      body: `${name}${event.boardName ?? event.boardId} aguarda sua ação`,
      tag,
      url,
      priority: "high",
    };
  }
  if (kind === "card-moved") {
    // Plain "advanced a column".
    const { title, body } = describeEvent(event);
    return { title, body, tag, url, priority: "normal" };
  }
  return null;
}

/**
 * The dispatcher channel: a board event reaches the phone only as a fact the push POLICY lists as critical (by
 * default none of the board-event facts is — the owner opens the Inbox when they want). Null when push is off.
 */
export function createWebPushChannel(): NotificationChannel | null {
  if (!isPushConfigured()) return null;
  const classifier = new BoardEventPushClassifier();
  return {
    id: "web-push",
    async notify(event: AgileHarnessEvent) {
      const policy = currentPushPolicy();
      // The default policy lists no board-event fact: skip the board.yaml read entirely on the common path.
      if (!BOARD_EVENT_PUSH_KINDS.some((k) => shouldPush(k, policy))) return;
      const kind = classifier.classify(event, await destinationOf(event));
      if (!kind || !shouldPush(kind, policy)) return;
      const payload = boardEventPushPayload(kind, event);
      if (payload) await sendPush(payload);
    },
  };
}

// --- Runner failure bridge --------------------------------------------------
// Run failures live in the runner registry (RunnerSnapshot.failures), NOT in the
// dispatcher, so we subscribe to the registry and push each NEW failure once. The
// snapshot is the full failure list every emit, so we de-dupe by (board/card/at).

let failurePushInit = false;
const notifiedFailures = new Set<string>();

/** Wire runner failures → push/Slack (the `run-failed` fact — NOT critical by default: a failed run is a TRAVADO
 *  item on the Inbox). Idempotent; no-op when neither push nor Slack is configured. */
export function initRunnerFailurePush(): void {
  if (failurePushInit) return;
  failurePushInit = true;
  if (!isPushConfigured() && !process.env.AGILEHARNESS_SLACK_WEBHOOK_URL) return;

  getRunnerRegistry().subscribe((snapshot) => {
    for (const f of snapshot.failures) {
      const key = `${f.board}/${f.cardId}/${f.at}`;
      if (notifiedFailures.has(key)) continue;
      notifiedFailures.add(key);
      const policy = currentPushPolicy();
      const title = `❌ Run falhou — ${f.trigger}`;
      const body = `${f.cardId} em ${f.board}${f.detail ? ` · ${f.detail}` : ""}`;
      if (shouldSlack("run-failed", policy)) void sendSlackAlert(title, body);
      if (!shouldPush("run-failed", policy)) continue;
      void sendPush({
        title,
        body,
        tag: `storymap:fail:${f.board}:${f.cardId}`,
        url: `/board/${f.board}`,
        priority: "high",
      });
    }
    // Bound the de-dupe set: failures self-expire from the snapshot (15min TTL), so
    // forget any key no longer present once the set grows.
    if (notifiedFailures.size > 200) {
      const live = new Set(snapshot.failures.map((f) => `${f.board}/${f.cardId}/${f.at}`));
      for (const k of notifiedFailures) if (!live.has(k)) notifiedFailures.delete(k);
    }
  });
}
