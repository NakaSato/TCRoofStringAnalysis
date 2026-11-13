/** API types: Weather sensor list, health flags and live status (`/growatt/sensors`, `/growatt/live/sensors/*`). */
import type { GrowattWeatherField } from "./weather";

/** Sensor status. Phase 1 (DB only): `not_synced` (nothing stored) or `unknown` (online state
 * is realtime and comes from the live sweep). */
export type SensorStatus = "online" | "late" | "offline" | "unknown" | "not_synced";

/** A health check on a weather sensor (not a measurement), always with the reason it fired.
 * `probe_missing` / `irradiance_zero_daylight` come from stored data (`/growatt/sensors`);
 * `stale_history` needs the live state (`/growatt/live/sensors/*`). */
export interface SensorFlag {
  code: "probe_missing" | "irradiance_zero_daylight" | "stale_history";
  field?: GrowattWeatherField;
  reason: string;
}

/** /growatt/sensors — one weather sensor from the registry and stored history (DB only). */
export interface SensorRow {
  /** "DATALOGGER_SN:ADDRESS" */
  key: string;
  datalogger_sn: string;
  address: number;
  device_name: string | null;
  plant_id: number;
  plant_name: string;
  phase: number | null;
  status: SensorStatus;
  /** newest stored reading (plant-local); null = nothing stored yet */
  last_reading_at: string | null;
  /** probes that reported in the last 7 days; null = no stored reading in that window (unknown) */
  measured: GrowattWeatherField[] | null;
  /** newest stored reading; unmeasured probes are null */
  last: Record<GrowattWeatherField, number | null> | null;
  /** share of `meta.day`'s daylight 5-min slots (06:00 → `meta.coverage_window.until`) with a stored reading */
  coverage_pct: number | null;
  /** `coverage_pct` when `meta.day` is today, else null */
  coverage_today_pct: number | null;
  /** checks on stored data; empty = nothing found (or not enough data to judge) */
  flags: SensorFlag[];
}

export interface SensorList {
  meta: {
    source: "db";
    day: string;
    /** slots judged for coverage: 06:00 up to the last env sync (HH:MM, exclusive); until null = none yet */
    coverage_window: { start: string; until: string | null };
    /** start of the last finished history sync (UTC) */
    synced_at: string | null;
    is_today: boolean;
    /** Active Alarm, past day: stored coverage below this = data gap (`SENSOR_ALARM_COVERAGE_PCT`) */
    alarm_coverage_pct: number;
  };
  sensors: SensorRow[];
}

/** One sensor's live online state (`/growatt/live/sensors/status`, memory only). */
export interface SensorLiveRow {
  key: string;
  /** judged now from Growatt's `lost` + last upload; `unknown` until its datalogger is checked */
  status: Exclude<SensorStatus, "not_synced">;
  lost: boolean | null;
  /** last upload to Growatt, plant-local "YYYY-MM-DD HH:MM:SS" */
  last_update_time: string | null;
  /** when its datalogger's sensor list was fetched (ISO, UTC); null = not checked yet */
  checked_at: string | null;
  stale: boolean | null;
  /** false = the datalogger's sensor list no longer lists this sensor */
  listed: boolean | null;
  /** checks that need the live state (`stale_history`) */
  flags: SensorFlag[];
}

export interface SensorLiveStatus {
  sensors: SensorLiveRow[];
  errors: Record<string, string>;
  /** dataloggers fresh / checked at all / visible; the sweep refreshes a few per request */
  sweep: { fresh: number; checked: number; total: number; oldest_age_s: number };
  thresholds: { late_min: number; offline_min: number };
}

/** /growatt/live/sensors/{dl}/{addr} — one sensor for the Info view (memory only, never stored). */
export interface SensorLive {
  status: SensorLiveRow;
  /** probes that reported in the last 7 days; null = unknown (nothing stored), every field kept */
  measured: GrowattWeatherField[] | null;
  /** newest `env_last_data` record; unmeasured probes null; null = Growatt has none / failed */
  reading: ({ datalogger_sn: string; address: number; timestamp: string; stale: boolean; fetched_at: string } & Record<
    GrowattWeatherField,
    number | null
  >) | null;
  /** the record exactly as Growatt reported it; admins only (null for engineers) */
  raw: Record<string, string | number | boolean | null> | null;
  /** per part ("status", "reading") when Growatt failed for it */
  errors: Record<string, string>;
  thresholds: { late_min: number; offline_min: number };
}
