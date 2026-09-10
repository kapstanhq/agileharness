// Web Push channel — the server sink that delivers an AgileHarness event to the user's
// PHONE as a real push notification, even with the app/tab CLOSED. Unlike the client
// WebNotificationChannel (Notification API, needs the tab open + SSE connected), this
// rides the Web Push protocol: the server POSTs an encrypted payload to the browser's
// push service, which wakes the installed PWA's service worker (public/sw.js). It is
// zero-cost until the VAPID keys are configured (mirrors the Slack channel's opt-in
// shape), so a dev without keys pays nothing.
//
// TWO trigger sources feed push, by user choice (see the AskUserQuestion that scoped
// this): "advanced a column", the higher-priority "needs you" subset, and "run failed".
//   - AgileHarnessEvent (dispatcher): a card's pending DEMAND (event.demand — question/blocker/review/
//     gate) → "precisa de você" push EVEN WITH NO move (story-rl5v03); plus card.moved → advanced.
//     card.created (capture storms) and demand-less updated/deleted are NOT pushed.
//   - RunnerFailure (registry): a headless harness-* run failed. The registry — NOT the
//     dispatcher — is the source, so we subscribe to it directly (non-invasive; the
//     same public API the SSE route uses), de-duping by failure key.

import type { NotificationChannel, AgileHarnessEvent } from "../../event";
import { describeEvent } from "../../event";
import { loadSubscriptions, removeSubscription } from "../push-store";
import { readBoardConfig } from "@/lib/storymap/repo";
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

// Dedup pending-demand pushes per card by demand TYPE — so repeated card.updated edits (or a count
// changing within the same type, e.g. answering 1 of 2 questions) don't re-push; cleared when the
// card has no demand, so a future re-appearance pushes again.
const notifiedDemands = new Map<string, string>();

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

/** Turn a board event into a push payload, or null when it shouldn't be pushed. */
async function buildEventPayload(event: AgileHarnessEvent): Promise<PushPayload | null> {
  // 1) A pending HUMAN DEMAND on the card (question/blocker/review/gate) — the highest-value push: it
  //    fires even when the card did NOT move (harness-grill writes questions in place — story-rl5v03). Skip
  //    card.created (a brain-dump capture would push a storm); dedupe per card by demand type.
  if (event.demand && event.cardId && event.type !== "card.created") {
    const key = `${event.boardId}/${event.cardId}`;
    if (notifiedDemands.get(key) !== event.demand.type) {
      notifiedDemands.set(key, event.demand.type);
      return demandPushPayload(event);
    }
    return null; // same demand already pushed for this card
  }
  if (event.cardId && !event.demand) notifiedDemands.delete(`${event.boardId}/${event.cardId}`);

  // 2) Otherwise: the original "advanced a column" / needs-you push on card.moved.
  if (event.type !== "card.moved" || !event.cardId) return null;

  const config = await readBoardConfig(event.boardId).catch(() => null);
  const toDef = config?.statuses.find((s) => s.id === event.toStatus);
  // "Needs you" = the card entered a NON-terminal status that does NOT autorun — the
  // pipeline parks here and waits for a human (com-design / revisao / descontinuar).
  // Derived from board.yaml (autorun !== true && !terminal), so it survives pipeline
  // edits with zero hardcoded status ids.
  const needsYou = !!toDef && toDef.autorun !== true && toDef.terminal !== true;
  const tag = `storymap:${event.boardId}:${event.cardId}`;
  const url = `/board/${event.boardId}`;

  if (needsYou) {
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
  // Plain "advanced a column".
  const { title, body } = describeEvent(event);
  return { title, body, tag, url, priority: "normal" };
}

/** The dispatcher channel: pushes card.moved (advanced + needs-you). Null when push is off. */
export function createWebPushChannel(): NotificationChannel | null {
  if (!isPushConfigured()) return null;
  return {
    id: "web-push",
    async notify(event: AgileHarnessEvent) {
      const payload = await buildEventPayload(event);
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

/** Wire runner failures → push. Idempotent; no-op if push is unconfigured. */
export function initRunnerFailurePush(): void {
  if (failurePushInit) return;
  failurePushInit = true;
  if (!isPushConfigured()) return;

  getRunnerRegistry().subscribe((snapshot) => {
    for (const f of snapshot.failures) {
      const key = `${f.board}/${f.cardId}/${f.at}`;
      if (notifiedFailures.has(key)) continue;
      notifiedFailures.add(key);
      void sendPush({
        title: `❌ Run falhou — ${f.trigger}`,
        body: `${f.cardId} em ${f.board}${f.detail ? ` · ${f.detail}` : ""}`,
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
