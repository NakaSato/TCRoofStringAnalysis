// Local profiles and settings in chrome.storage.local (spec §11.1).
// Keys: "profiles" (array of stored profiles, without the built-in DHCP one) and "settings".

import { t } from "./strings.js";
import { parsePrefix, validateProfile } from "./net.js";

export const DHCP_ID = "dhcp";
export const EXPORT_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({ rollbackSec: 30, lastAdapterGuid: "", showAll: false });

const SEED = [
  { name: "TC LAN · 10.100.35.1", ip: "10.100.35.1" },
  { name: "TC LAN · 10.100.35.2", ip: "10.100.35.2" },
].map((s) => ({
  name: s.name, mode: "static", ip: s.ip, prefix: 24, gateway: "10.100.35.254", dns: [],
  testHost: "10.100.35.254", openUrl: "", preferredAdapter: "", note: "",
}));

const local = () => globalThis.chrome.storage.local;

/** The built-in profile: always first, never stored, not editable. */
export function builtinDhcp() {
  return {
    id: DHCP_ID, name: t("dhcpProfileName"), mode: "dhcp", ip: "", prefix: null, gateway: "",
    dns: [], testHost: "", openUrl: "", preferredAdapter: "", note: "", builtin: true,
  };
}

const s = (v) => (typeof v === "string" ? v.trim() : "");

/** Keep only the known fields with the right types. Does not validate. */
export function normalizeProfile(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mode = r.mode === "dhcp" ? "dhcp" : r.mode === "static" ? "static" : s(r.mode);
  let prefix = null;
  if (mode === "static") {
    const p = typeof r.prefix === "number" ? r.prefix : typeof r.prefix === "string" ? parsePrefix(r.prefix) : null;
    prefix = p;
  }
  const dns = Array.isArray(r.dns) ? r.dns.map(s).filter(Boolean) : [];
  return {
    id: s(r.id),
    name: s(r.name),
    mode,
    ip: mode === "static" ? s(r.ip) : "",
    prefix,
    gateway: mode === "static" ? s(r.gateway) : "",
    dns: mode === "static" ? dns : [],
    testHost: s(r.testHost),
    openUrl: s(r.openUrl),
    preferredAdapter: s(r.preferredAdapter),
    note: typeof r.note === "string" ? r.note : "",
  };
}

async function readStored() {
  const { profiles } = await local().get("profiles");
  return Array.isArray(profiles) ? profiles : [];
}

async function writeStored(list) {
  await local().set({ profiles: list });
}

/** Seed the user's two TC LAN profiles when nothing is stored yet. Returns true if seeded. */
export async function seedIfEmpty() {
  const got = await local().get("profiles");
  if (Array.isArray(got.profiles)) return false;
  await writeStored(SEED.map((p) => ({ ...p, id: crypto.randomUUID() })));
  return true;
}

/** Built-in DHCP first, then the stored profiles in order. */
export async function listProfiles() {
  return [builtinDhcp(), ...(await readStored())];
}

export async function getProfile(id) {
  return (await listProfiles()).find((p) => p.id === id) || null;
}

/** Create or update. Throws {errors} when invalid. Returns the saved profile. */
export async function saveProfile(raw) {
  if (raw?.id === DHCP_ID) throw Object.assign(new Error("built-in"), { errors: { name: t("builtIn") } });
  const p = normalizeProfile(raw);
  const errors = validateProfile(p);
  if (Object.keys(errors).length) throw Object.assign(new Error("invalid"), { errors });
  const list = await readStored();
  const i = p.id ? list.findIndex((x) => x.id === p.id) : -1;
  if (i >= 0) list[i] = p;
  else list.push({ ...p, id: crypto.randomUUID() });
  await writeStored(list);
  return i >= 0 ? p : list[list.length - 1];
}

export async function deleteProfile(id) {
  if (id === DHCP_ID) return false;
  const list = await readStored();
  const next = list.filter((x) => x.id !== id);
  await writeStored(next);
  return next.length !== list.length;
}

/** Move a stored profile up (-1) or down (+1). The built-in DHCP profile stays first. */
export async function moveProfile(id, delta) {
  const list = await readStored();
  const i = list.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  await writeStored(list);
  return true;
}

export async function getSettings() {
  const { settings } = await local().get("settings");
  const out = { ...DEFAULT_SETTINGS, ...(settings && typeof settings === "object" ? settings : {}) };
  if (!Number.isInteger(out.rollbackSec) || out.rollbackSec < 0 || out.rollbackSec > 300) out.rollbackSec = DEFAULT_SETTINGS.rollbackSec;
  if (typeof out.lastAdapterGuid !== "string") out.lastAdapterGuid = "";
  out.showAll = out.showAll === true;
  return out;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  if (!Number.isInteger(next.rollbackSec) || next.rollbackSec < 0 || next.rollbackSec > 300) {
    throw Object.assign(new Error("invalid"), { errors: { rollbackSec: t("rollbackBad") } });
  }
  await local().set({ settings: next });
  return next;
}

/** `{version: 1, profiles: [...]}` (stored profiles only; the built-in one is never exported). */
export async function exportJSON() {
  return JSON.stringify({ version: EXPORT_VERSION, profiles: await readStored() }, null, 2);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Import profiles from exported JSON. Valid profiles are appended; one with the ID of an
 * existing profile replaces it. Invalid ones (and the built-in "dhcp" ID) are skipped.
 * Returns {added, skipped}. Throws Error(message) when the file itself is not usable.
 */
export async function importJSON(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(t("importBad", { message: e.message })); }
  if (!doc || typeof doc !== "object" || doc.version !== EXPORT_VERSION || !Array.isArray(doc.profiles)) {
    throw new Error(t("importBad", { message: `expected {"version": ${EXPORT_VERSION}, "profiles": [...]}` }));
  }
  const list = await readStored();
  let added = 0;
  let skipped = 0;
  for (const raw of doc.profiles) {
    if (!raw || typeof raw !== "object" || raw.id === DHCP_ID) { skipped++; continue; }
    const p = normalizeProfile(raw);
    if (Object.keys(validateProfile(p)).length) { skipped++; continue; }
    if (!UUID.test(p.id)) p.id = crypto.randomUUID();
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p;
    else list.push(p);
    added++;
  }
  await writeStored(list);
  return { added, skipped };
}
