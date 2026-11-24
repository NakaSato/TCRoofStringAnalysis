// Local profiles and settings in chrome.storage.local (spec §11.1).
// Keys: "profiles" (array of stored profiles, without the built-in DHCP one) and "settings".

import { t } from "./strings.js";
import { parsePrefix, validateProfile } from "./net.js";

export const DHCP_ID = "dhcp";
export const EXPORT_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({ rollbackSec: 30, lastAdapterGuid: "", showAll: false });

// First-run profiles. The fixed IDs match the one tools/om_network_to_profiles.py writes, so
// importing the plant file updates it instead of adding a copy.
export const GROWATT_ECOSYSTEM_ID = "4d50c8e9-0d58-5b61-9c2c-c41342824379";
export const HUAWEI_SMARTLOGGER_ID = "f053ed22-5c76-5a11-9cc1-97891e6ab401";
const SEED = [{
  id: GROWATT_ECOSYSTEM_ID, name: "Growatt Ecosystem · 192.168.10.x", mode: "static", ip: "192.168.10.250",
  prefix: 24, gateway: "", dns: [], testHost: "", openUrl: "", preferredAdapter: "",
  note: "Laptop on the Growatt devices' local network 192.168.10.0/24 (direct link, no gateway).",
}, {
  id: HUAWEI_SMARTLOGGER_ID, name: "Huawei SmartLogger · 192.168.0.10", mode: "static", ip: "192.168.0.250",
  prefix: 24, gateway: "", dns: [], testHost: "192.168.0.10", openUrl: "https://192.168.0.10/", preferredAdapter: "",
  note: "Huawei SmartLogger at 192.168.0.10 (direct link, no gateway). Web UI: https://192.168.0.10/",
}];

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

/** Seed the Growatt Ecosystem and Huawei SmartLogger profiles when nothing is stored yet. Returns true if seeded. */
export async function seedIfEmpty() {
  const got = await local().get("profiles");
  if (Array.isArray(got.profiles)) {
    await migrateSeeds();
    return false;
  }
  await writeStored(SEED.map((p) => ({ ...p })));
  await local().set({ seedVersion: SEED_VERSION });
  return true;
}

// v1 seeded "TC LAN · 10.100.35.1 / .2": those are the revenue meters' IPs at plant P2-055, so a
// laptop on them clashes with the meters. Once per install: remove them if still unchanged and add
// the current first-run profiles that are missing. Profiles the user edited are left alone.
const SEED_VERSION = 2;
const LEGACY_SEEDS = [["TC LAN · 10.100.35.1", "10.100.35.1"], ["TC LAN · 10.100.35.2", "10.100.35.2"]];

async function migrateSeeds() {
  const { seedVersion } = await local().get("seedVersion");
  if ((seedVersion || 1) >= SEED_VERSION) return;
  let list = await readStored();
  list = list.filter((p) => !LEGACY_SEEDS.some(([name, ip]) =>
    p.name === name && p.ip === ip && p.gateway === "10.100.35.254" && Number(p.prefix) === 24));
  for (const seed of SEED) if (!list.some((p) => p.id === seed.id)) list.push({ ...seed });
  await writeStored(list);
  await local().set({ seedVersion: SEED_VERSION });
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
