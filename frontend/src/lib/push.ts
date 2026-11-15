/**
 * Alarm push notifications on this browser (Firebase Cloud Messaging web push).
 *
 * The Firebase SDK is loaded only when notifications are (being turned) on. What is kept in
 * localStorage is bookkeeping, never data: which user turned them on here, and the FCM token so
 * it can be unregistered on sign-out.
 */
import { api, type PushStatus } from "../api/client";

const KEY = "tcroof.push";
const SW_URL = "/firebase-messaging-sw.js";
/** FCM's own default scope: apart from the app's Workbox service worker at "/" */
const SW_SCOPE = "/firebase-cloud-messaging-push-scope";

interface Stored {
  userId: number;
  token: string;
}

const read = (): Stored | null => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.userId === "number" && typeof v.token === "string" ? v : null;
  } catch {
    return null;
  }
};

const write = (v: Stored | null) => {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the choice lasts this tab only */
  }
};

export type PushSupport = "ok" | "ios-install" | "unsupported";

/** iOS only offers web push to an app added to the Home Screen. */
export const pushSupport = (): PushSupport => {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios ? "ios-install" : "unsupported";
};

export const pushBlocked = () => pushSupport() === "ok" && Notification.permission === "denied";

/** Notifications are on in this browser for this user. */
export const pushOn = (userId: number) =>
  pushSupport() === "ok" && Notification.permission === "granted" && read()?.userId === userId;

/** The push service worker, active (a push subscription needs an active worker). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  const pending = reg.installing ?? reg.waiting;
  if (reg.active || !pending) return reg;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The notification service worker did not start.")), 10_000);
    pending.addEventListener("statechange", () => {
      if (pending.state !== "activated" && pending.state !== "redundant") return;
      window.clearTimeout(timer);
      if (pending.state === "activated") resolve();
      else reject(new Error("The notification service worker could not be installed."));
    });
  });
  return reg;
}

async function fetchToken(status: PushStatus): Promise<string> {
  if (!status.config || !status.vapid_key) throw new Error("Push notifications are not configured.");
  const [reg, { initializeApp, getApps }, fcm] = await Promise.all([
    registration(),
    import("firebase/app"),
    import("firebase/messaging"),
  ]);
  const app = getApps().find((a) => a.name === "push") ?? initializeApp(status.config, "push");
  const token = await fcm.getToken(fcm.getMessaging(app), { vapidKey: status.vapid_key, serviceWorkerRegistration: reg });
  if (!token) throw new Error("The browser gave no notification token.");
  return token;
}

const label = () => navigator.userAgent.slice(0, 120);

/** Ask for permission, register this browser with FCM and the backend. Throws with a reason. */
export async function enablePush(status: PushStatus, userId: number): Promise<void> {
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.");
  const token = await fetchToken(status);
  await api.registerPushToken(token, label());
  write({ userId, token });
}

/** Drop this browser's push subscription, so the token stops working whatever the backend knows. */
const unsubscribeBrowser = () =>
  navigator.serviceWorker
    ?.getRegistration(SW_SCOPE)
    .then((reg) => reg?.pushManager.getSubscription())
    .then((sub) => sub?.unsubscribe())
    .catch(() => undefined);

/**
 * Turn notifications off here. `tellBackend` = the session is still valid (the user's choice,
 * or sign-out before the token is cleared); without it FCM reports the token gone at the next
 * send and the backend deletes it then.
 */
export function releasePush(tellBackend: boolean): Promise<void> {
  const s = read();
  if (!s) return Promise.resolve();
  write(null);
  // started synchronously: on sign-out the stored JWT is cleared right after this call
  const told = tellBackend ? api.removePushToken(s.token).catch(() => undefined) : Promise.resolve();
  return Promise.all([told, unsubscribeBrowser()]).then(() => undefined);
}

/**
 * Once per session: keep this browser's token fresh on the backend. If someone else turned
 * notifications on here (or permission was withdrawn), they are turned off instead, so one
 * user's plants never notify the next user of the browser. Returns whether they are on.
 */
export async function refreshPush(status: PushStatus, userId: number): Promise<boolean> {
  const s = read();
  if (!s || pushSupport() !== "ok") return false;
  if (s.userId !== userId || Notification.permission !== "granted") {
    await releasePush(false);
    return false;
  }
  try {
    const token = await fetchToken(status);
    await api.registerPushToken(token, label());
    write({ userId, token });
  } catch {
    /* offline or FCM unreachable: the stored token stays registered */
  }
  return true;
}
