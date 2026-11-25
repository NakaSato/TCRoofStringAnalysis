/**
 * Devices page, Inverters tab: the table's logic without React (rows, filter, sort, CSV, formatting).
 * Used by `InvertersTab`, `InvertersFilterBar` and `InverterTableRow`.
 */
import type { DeviceInverter, GrowattInverterSnapshotRow } from "../../api/client";
import { downloadCsv } from "../pwaMeter/format";
import { STATE_RANK } from "./inverters";
import type { LiveFilter, LiveState } from "./inverters";

export const PAGE = 50;
export const SHOWS = ["all", "limited", "issues"] as const;
export type Show = (typeof SHOWS)[number];
export const SORTS = [
  "plant", "phase", "province", "inv", "sn", "model", "kw", "fw", "dl",
  "status", "pac", "eac", "temp", "rec", "last", "yield", "pct", "limit", "onoff", "issues", "alarms",
] as const;
export type SortKey = (typeof SORTS)[number];
/** sorted A → Z first; every other column largest first */
export const TEXT_SORTS: ReadonlySet<SortKey> = new Set<SortKey>(["plant", "phase", "province", "inv", "sn", "model", "fw", "dl", "status"]);

export const TIER_VARIANT: Record<string, "crit" | "warn" | "info" | "neutral"> = { P1: "crit", P2: "warn", P3: "info", Info: "neutral" };
export const LIMIT_SOURCE: Record<string, string> = {
  read_power: "Power setting read from the inverter (read_power)",
  max_data_info: "Inverter info record (max_data_info)",
};

export interface Row {
  inv: DeviceInverter;
  live: GrowattInverterSnapshotRow | undefined;
  /** null = not installed (never swept) */
  st: LiveState | null;
}

/** The table's filters, as read from the URL. */
export interface InverterFilters {
  query: string;
  phase: string;
  model: string;
  fw: string;
  status: LiveFilter | "";
  show: Show;
  ni: boolean;
}

export const modelOf = (i: DeviceInverter) => i.device_model ?? i.model;
/** limited = a configured power limit below 100 %, or switched off */
export const isLimited = (i: DeviceInverter) => (i.power_limit_pct != null && i.power_limit_pct < 100) || i.on_off === 0;
/** W → kW; null stays null */
export const kw = (w: number | null | undefined) => (w == null ? null : w / 1000);

/** The not-installed mark's UTC timestamp (aware on Postgres, naive UTC on SQLite) in Bangkok time; "—" when missing. */
export const markedAt = (v: string | null | undefined, locale: string): string => {
  if (!v) return "—";
  const ms = Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString(locale, { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";
};

/** A plant-local "YYYY-MM-DDTHH:MM…": the time alone on `now`'s day, else the date and time. */
export const fmtStamp = (ts: string | null | undefined, now: string, locale: string) => {
  if (!ts) return "—";
  const d0 = ts.slice(0, 10);
  const time = ts.slice(11, 16);
  if (d0 === now.slice(0, 10)) return time;
  return `${new Date(`${d0}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "2-digit" })} ${time}`;
};

const sortValue = (r: Row, k: SortKey): number | string | null => {
  const i = r.inv;
  switch (k) {
    case "plant":
      return i.plant_name.toLowerCase();
    case "phase":
      return i.phase;
    case "province":
      return i.province?.toLowerCase() ?? null;
    case "inv":
      return i.label || null;
    case "sn":
      return i.device_sn;
    case "model":
      return modelOf(i);
    case "kw":
      return i.rated_kw;
    case "fw":
      return i.fw_version;
    case "dl":
      return i.datalogger_sn;
    case "status":
      return r.st == null ? null : STATE_RANK[r.st];
    case "pac":
      return r.live?.pac_w ?? null;
    case "eac":
      return r.live?.eac_today_kwh ?? null;
    case "temp":
      return r.live?.temperature_c ?? null;
    case "rec":
      return r.live?.record_time ?? null;
    case "last":
      return i.last_record;
    case "yield":
      return i.yield_today_kwh;
    case "pct":
      return i.pct_of_plant_avg;
    case "limit":
      return i.power_limit_pct;
    case "onoff":
      return i.on_off;
    case "issues":
      return i.open_issues;
    case "alarms":
      return i.alarms_today;
  }
};

const cmp = (a: number | string, b: number | string) =>
  typeof a === "string" && typeof b === "string" ? a.localeCompare(b, undefined, { numeric: true }) : a < b ? -1 : a > b ? 1 : 0;

/** The rows that pass the filters, sorted by `sort` (nulls last either way; then plant, then inverter label). */
export function filterAndSort(all: Row[], f: InverterFilters, sort: SortKey, desc: boolean): Row[] {
  const q = f.query.trim().toLowerCase();
  const out = all.filter(({ inv, st }) => {
    if (!f.ni && inv.not_installed) return false;
    if (f.phase && String(inv.phase ?? "") !== f.phase) return false;
    if (f.model && modelOf(inv) !== f.model) return false;
    if (f.fw && inv.fw_version !== f.fw) return false;
    if (f.status && st !== f.status) return false;
    if (f.show === "limited" && !isLimited(inv)) return false;
    if (f.show === "issues" && !(inv.open_issues > 0)) return false;
    if (q) {
      const hay = `${inv.plant_name} ${inv.plant_id} ${inv.device_sn} ${inv.label} ${inv.alias ?? ""} ${inv.site_code ?? ""} ${inv.datalogger_sn ?? ""}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const dir = desc ? -1 : 1;
  return out.sort((a, b) => {
    const va = sortValue(a, sort);
    const vb = sortValue(b, sort);
    if (va == null || vb == null) {
      if (va != null) return -1; // nulls last in either direction
      if (vb != null) return 1;
    } else {
      const c = cmp(va, vb) * dir;
      if (c) return c;
    }
    // stable order inside a value: plant, then inverter label
    return cmp(a.inv.plant_name.toLowerCase(), b.inv.plant_name.toLowerCase()) || cmp(a.inv.label, b.inv.label);
  });
}

/** The rows shown, as a CSV download (every column of the list and the live record). */
export const exportInvertersCsv = (rows: Row[], day: string) =>
  downloadCsv(
    `devices_inverters_${day}.csv`,
    [
      "plant_id", "plant", "phase", "province", "site_code", "label", "alias", "device_sn", "model", "device_model", "rated_kw", "fw_version",
      "datalogger_sn", "datalogger_model", "installed", "live_status", "live_status_code", "live_status_label", "live_ac_kw", "live_today_kwh",
      "live_temperature_c", "live_record_time", "last_stored_record", "stored_yield_today_kwh", "pct_of_plant_avg", "power_limit_pct",
      "power_limit_source", "on_off", "open_issues", "top_tier", "alarms_today", "alarms_open", "has_string_layout",
      "not_installed_at", "not_installed_by", "not_installed_note",
    ],
    rows.map(({ inv: i, live, st }) => [
      i.plant_id, i.plant_name, i.phase, i.province, i.site_code, i.label, i.alias, i.device_sn, i.model, i.device_model, i.rated_kw, i.fw_version,
      i.datalogger_sn, i.datalogger_model, i.not_installed ? "no" : "yes", st == null ? "not_installed" : st === "unchecked" ? "not_checked" : st,
      live?.status ?? null, live?.status_label ?? null, kw(live?.pac_w), live?.eac_today_kwh ?? null,
      live?.temperature_c ?? null, live?.record_time ?? null, i.last_record, i.yield_today_kwh, i.pct_of_plant_avg, i.power_limit_pct,
      i.power_limit_source, i.on_off == null ? null : i.on_off === 1 ? "on" : "off", i.open_issues, i.top_tier, i.alarms_today, i.alarms_open,
      i.has_string_layout ? "yes" : "no", i.not_installed?.at ?? null, i.not_installed?.by ?? null, i.not_installed?.note ?? null,
    ])
  );
