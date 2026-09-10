"use client";

// Web Push client — registers the service worker, subscribes via the PushManager
// with the server's VAPID public key, and POSTs the subscription to the API. This is
// what makes notifications arrive on the phone with the app CLOSED — distinct from the
// Notification-API WebNotificationChannel (web-notification-channel.ts), which only
// fires while the tab is open + the SSE stream is connected.
//
// PLATFORM NOTE: iOS only delivers Web Push when the PWA is INSTALLED to the home
// screen (Add to Home Screen) and the device is on iOS 16.4+. Android/Chrome works in
// a normal tab too, but installing is the better UX. HTTPS with a valid cert is
// mandatory everywhere (localhost is exempt for dev).

export type PushState = "unsupported" | "denied" | "subscribed" | "unsubscribed";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// VAPID keys are URL-safe base64; the PushManager wants the bytes as a BufferSource.
// Allocate over an explicit ArrayBuffer so the inferred type is Uint8Array<ArrayBuffer>
// (not <ArrayBufferLike>), which `applicationServerKey: BufferSource` requires on TS 5.7+.
function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Current push state without prompting (for initial toggle render). */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

/** Register SW, prompt for permission, subscribe, and persist the subscription server-side. */
export async function subscribeToPush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "unsubscribed";

  const { publicKey } = (await fetch("/api/notifications/vapid").then((r) => r.json())) as {
    publicKey: string | null;
  };
  if (!publicKey) {
    console.warn("[web-push] o servidor não tem VAPID configurado (AGILEHARNESS_VAPID_PUBLIC_KEY)");
    return "unsubscribed";
  }

  const reg = await getRegistration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await fetch("/api/notifications/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  return "subscribed";
}

/** Unsubscribe locally + tell the server to forget this device. */
export async function unsubscribeFromPush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await fetch("/api/notifications/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return "unsubscribed";
}
