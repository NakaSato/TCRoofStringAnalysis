// One-shot native messaging calls to the IP Switcher helper (ipswitcher/PROTOCOL.md).
// The host is stateless between calls; the rollback timer runs in its own watchdog process.

import { t } from "./strings.js";

export const HOST_NAME = "com.tcroof.ipswitcher";
export const PROTOCOL_VERSION = 1;
// The host itself gives up after ~30 s; this only guards against a call that never returns.
const CLIENT_TIMEOUT_MS = 60_000;

export class HostError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.detail = detail;
  }
}

/** Map chrome.runtime.lastError to the extension-side codes in PROTOCOL.md. */
export function mapLastError(lastError) {
  const msg = lastError?.message || String(lastError || "");
  if (/native messaging host not found/i.test(msg)) return new HostError("host_missing", t("err_host_missing"), msg);
  if (/forbidden/i.test(msg)) return new HostError("host_forbidden", t("err_host_forbidden"), msg);
  return new HostError("host_crashed", t("err_host_crashed"), msg);
}

/**
 * Send one command. Resolves with `data`; rejects with a HostError carrying `code`, `message`
 * and `detail` (the host's error, or one of host_missing / host_forbidden / host_crashed).
 */
export function callHost(cmd, args) {
  const id = crypto.randomUUID();
  const msg = { id, v: PROTOCOL_VERSION, cmd };
  if (args !== undefined) msg.args = args;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new HostError("timeout", t("err_timeout")));
    }, CLIENT_TIMEOUT_MS);
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, msg, (reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const le = chrome.runtime.lastError;
        if (le) return reject(mapLastError(le));
        if (!reply || typeof reply !== "object" || (reply.id !== undefined && reply.id !== id)) {
          return reject(new HostError("host_crashed", t("err_bad_reply"), reply ?? null));
        }
        if (reply.ok === true) return resolve(reply.data ?? null);
        const e = reply.error || {};
        reject(new HostError(String(e.code || "internal"), String(e.message || t("err_bad_reply")), e.detail ?? null));
      });
    } catch (err) {
      done = true;
      clearTimeout(timer);
      reject(mapLastError(err));
    }
  });
}

/** Ask the background service worker to refresh the toolbar badge. Never throws. */
export function requestBadgeRefresh() {
  try {
    chrome.runtime.sendMessage({ type: "refresh" }).catch(() => {});
  } catch { /* no receiver */ }
}
