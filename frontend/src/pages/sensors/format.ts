/** Weather sensor pages: units, digits, compass and plant-local time helpers. */
import type { GrowattWeatherField } from "../../api/client";
import { FIELD_LABEL } from "../../components/sensorView";

/** Below this share of today's daylight slots a sensor counts as having gaps. */
export const LOW_COVERAGE_PCT = 80;

export const FIELD_UNIT: Record<GrowattWeatherField, string> = {
  irradiance_wm2: "W/m²",
  module_temp_c: "°C",
  ambient_temp_c: "°C",
  humidity_pct: "%",
  wind_speed_ms: "m/s",
  wind_dir_deg: "°",
};

export const FIELDS = Object.keys(FIELD_LABEL) as GrowattWeatherField[];

/** Start of the 5-minute slot, like the stored series ("YYYY-MM-DD HH:MM:SS"). */
export const slotOf = (ts: string) => {
  const m = Number(ts.slice(14, 16));
  return `${ts.slice(0, 14)}${String(m - (m % 5)).padStart(2, "0")}:00`;
};

export const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Plant-local now as "YYYY-MM-DD HH:MM:SS", the format of stored timestamps. */
export const plantNow = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });

export const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to.replace(" ", "T")) - Date.parse(from.replace(" ", "T"))) / 60000);

export const fmtAge = (min: number) =>
  min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.floor(min / 60)} h ${min % 60} m ago` : `${Math.floor(min / 1440)} d ago`;

export const coverageTone = (pct: number | null) =>
  pct == null ? "text-slate-500" : pct >= 90 ? "text-emerald-300" : pct >= LOW_COVERAGE_PCT ? "text-amber-300" : "text-red-300";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export const compass = (deg: number | null | undefined) => (deg == null ? "" : COMPASS[Math.round(deg / 45) % 8]);

export const DIGITS: Record<GrowattWeatherField, number> = {
  irradiance_wm2: 0,
  module_temp_c: 1,
  ambient_temp_c: 1,
  humidity_pct: 0,
  wind_speed_ms: 1,
  wind_dir_deg: 0,
};
