/* Alarm push notifications (Firebase Cloud Messaging web push).
 *
 * A second, tiny service worker with its own scope (/firebase-cloud-messaging-push-scope), apart
 * from the Workbox one that precaches the app: it controls no page and caches nothing. The
 * backend sends data-only messages ({ title, body, url, tag }); this shows them and opens the
 * app on click. No Firebase SDK is loaded here: the payload is plain JSON.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = (event.data ? event.data.json() : {}).data || {};
  } catch {
    /* not JSON: shown as a generic notification below */
  }
  // every push must show a notification, or the browser shows its own "updated in the background"
  event.waitUntil(
    self.registration.showNotification(data.title || "TC Roof alarm", {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "/icons/icon-192.png",
      // Android status bar: drawn as an alpha mask, so the white logo on transparent (icons/badge.svg)
      badge: "/icons/badge-96.png",
      data: { url: data.url || "/alarms" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/alarms", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
