// AgileHarness service worker — Web Push receiver + PWA shell. Vanilla JS, served as a
// static asset (NOT bundled/transpiled by Next). It has two jobs:
//   1. `push`            → show the notification the server sent (fires with the app
//                          or tab CLOSED — this is what makes it feel like an app).
//   2. `notificationclick` → focus an open AgileHarness tab (navigating it to the card's
//                          board) or open a new one.
// The payload shape is produced by lib/notifications/server/channels/web-push-channel.ts.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "AgileHarness";
  const high = data.priority === "high";
  const options = {
    body: data.body || "",
    tag: data.tag || "storymap",
    renotify: true,
    requireInteraction: high, // high-priority stays until you act on it
    vibrate: high ? [80, 40, 80] : [40],
    icon: "/icon-192.png",
    badge: "/badge-96.png", // estêncil de ALFA — o Android descarta a cor; um PNG opaco vira um círculo branco chapado
    lang: "pt-BR",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
