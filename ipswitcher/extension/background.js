// Service worker: toolbar badge (spec §14.2) and first-run profile seeding.
// Badge source is the host's fast `status` command (no PowerShell).

import { callHost } from "./lib/host.js";
import { seedIfEmpty, getSettings } from "./lib/store.js";
import { t, setLang } from "./lib/strings.js";

const ALARM = "badge-refresh";
const STATIC_TOO_LONG_MS = 4 * 60 * 60 * 1000;
const AMBER = "#F59E0B";
const BLUE = "#2563EB";

let deadlineTimer = null;

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeTextColor({ color: color === AMBER ? "#000000" : "#FFFFFF" });
  }
  await chrome.action.setTitle({ title: title ? `IP Switcher · ${title}` : "IP Switcher" });
}

export function badgeFor(status, now = Date.now()) {
  const pending = status?.pending || null;
  const statics = Array.isArray(status?.statics) ? status.statics : [];
  if (pending) return { text: "!", color: AMBER, title: t("badgePending", { adapter: pending.adapter }) };
  const old = statics.find((s) => typeof s.since === "number" && now - s.since > STATIC_TOO_LONG_MS);
  if (old) return { text: "S", color: AMBER, title: t("badgeStaticLong", { adapter: old.adapter }) };
  if (statics.length) return { text: "S", color: BLUE, title: t("badgeStatic", { adapter: statics[0].adapter, profile: statics[0].profile || t("customName") }) };
  return { text: "", color: BLUE, title: "" };
}

async function refreshBadge() {
  try { setLang((await getSettings()).lang); } catch { /* keep the current language */ }
  let status;
  try {
    status = await callHost("status");
  } catch {
    // Host missing, forbidden or broken: stay quiet, the popup explains.
    await setBadge("", BLUE, "");
    return;
  }
  const b = badgeFor(status);
  await setBadge(b.text, b.color, b.title);

  // While a change is pending, re-check just after its deadline (the watchdog reverts it).
  clearTimeout(deadlineTimer);
  const dl = status?.pending?.deadline;
  if (typeof dl === "number") {
    const wait = Math.min(Math.max(dl - Date.now() + 2000, 1000), 5 * 60 * 1000);
    deadlineTimer = setTimeout(() => refreshBadge().catch(() => {}), wait);
  }
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  try { await seedIfEmpty(); } catch (e) { console.warn("seed failed", e); }
  await ensureAlarm();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refreshBadge().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own pages can reach onMessage (no externally_connectable, no content scripts).
  if (sender.id !== chrome.runtime.id || msg?.type !== "refresh") return false;
  refreshBadge().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});
