/**
 * Today's stored plant curve continued with the live records: each inverter's live answer carries
 * today's newest `max_data` records (`power`, memory only), which this sums into 5-minute plant
 * slots the same way the backend sums stored records (`_plant_curve`): an inverter's samples are
 * averaged within the slot, then summed across inverters, and an inverter missing from a slot keeps
 * its own value from ≤ 10 min earlier (`held`). Only slots after the newest stored one are added,
 * flagged `live`, so the chart never mixes the two sources in one slot.
 */
import type { LiveInverter } from "../inverters/shared";
import type { PowerCurve } from "../generation/charts";

type Row = PowerCurve["ts"][number];

const SLOT_MS = 5 * 60_000;
const HOLD_MS = 10 * 60_000;

/** "YYYY-MM-DD HH:MM:SS" (plant-local, no zone) ↔ ms; parsed as UTC so no zone shifts it. */
const toMs = (t: string) => Date.parse(`${t.slice(0, 10)}T${t.slice(11, 19)}Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Modelled clear-sky envelope, as the backend's `_expected_kw` (not measured): 82 % of kWp at solar noon. */
const expectedKw = (capKwp: number | null, hr: number): number | null => {
  if (!capKwp) return null;
  if (hr < 6 || hr > 18) return 0;
  const x = (hr - 12.15) / 5.85;
  return Math.round(capKwp * 0.82 * Math.max(0, Math.cos((x * Math.PI) / 2)) ** 1.3 * 100) / 100;
};

const mean = (xs: number[]) => xs.reduce((a, v) => a + v, 0) / xs.length;

export const withLiveTail = (stored: Row[], recs: LiveInverter[], day: string, capKwp: number | null): Row[] => {
  const after = stored.length ? stored[stored.length - 1].timestamp : "";
  // (slot ms) -> sn -> samples
  const slots = new Map<number, Map<string, { pac: number[]; ppv: number[] }>>();
  for (const r of recs) {
    for (const [t, pac, ppv] of r.power ?? []) {
      if (t.slice(0, 10) !== day) continue;
      const ms = toMs(t);
      if (Number.isNaN(ms)) continue;
      const slot = ms - (ms % SLOT_MS);
      const bySn = slots.get(slot) ?? new Map<string, { pac: number[]; ppv: number[] }>();
      slots.set(slot, bySn);
      const b = bySn.get(r.device_sn) ?? { pac: [], ppv: [] };
      bySn.set(r.device_sn, b);
      // as the backend: a record without a value counts as 0 W in its slot
      b.pac.push(pac ?? 0);
      b.ppv.push(ppv ?? 0);
    }
  }
  if (!slots.size) return stored;
  const out: Row[] = [];
  const last = new Map<string, { at: number; pac: number; ppv: number }>();
  for (const slot of [...slots.keys()].sort((a, b) => a - b)) {
    const bySn = slots.get(slot)!;
    let pac = 0;
    let ppv = 0;
    let n = 0;
    let held = 0;
    for (const [sn, b] of bySn) {
      const v = { at: slot, pac: mean(b.pac), ppv: mean(b.ppv) };
      last.set(sn, v);
      pac += v.pac;
      ppv += v.ppv;
      n++;
    }
    for (const [sn, v] of last) {
      if (bySn.has(sn) || slot - v.at > HOLD_MS) continue;
      pac += v.pac;
      ppv += v.ppv;
      n++;
      held++;
    }
    const ts = fromMs(slot);
    if (ts <= after) continue;
    const d = new Date(slot);
    out.push({
      timestamp: ts,
      pac_kw: Math.round(pac / 10) / 100,
      ppv_kw: Math.round(ppv / 10) / 100,
      expected_kw: expectedKw(capKwp, d.getUTCHours() + d.getUTCMinutes() / 60),
      temp_c: null,
      freq_hz: null,
      inverters: n,
      held,
      live: true,
    });
  }
  return out.length ? [...stored, ...out] : stored;
};
