/** Devices page (docs/plans/devices-page.md): fleet device lists and computed device checks.
 * All four endpoints are DB only (`meta.source = "db"`) and scoped to the user's plants. Live state
 * comes from the existing `/growatt/live/*` sweeps (inverter snapshot, sensor status). Missing = null. */

export interface DevicesMeta {
  source: "db";
  /** plant-local today (YYYY-MM-DD) */
  day: string;
  /** start of the last finished `history` run (UTC ISO), null = none */
  synced_at: string | null;
}

/** One inverter of `/growatt/devices/inverters`. */
export interface DeviceInverter {
  device_sn: string;
  plant_id: number;
  plant_name: string;
  phase: number | null;
  /** site register province, else Growatt `city` */
  province: string | null;
  site_code: string | null;
  /** "INV3" from the Growatt alias (`daily_checks.inverter_label`) */
  label: string;
  alias: string | null;
  model: string | null;
  device_model: string | null;
  /** nameplate AC kW (`nominal_power_w`, else `rated_power_w`) */
  rated_kw: number | null;
  fw_version: string | null;
  datalogger_sn: string | null;
  datalogger_model: string | null;
  growatt_created_at: string | null;
  /** configured active power limit % (`active_limit_pct`), null = not read */
  power_limit_pct: number | null;
  power_limit_source: "read_power" | "max_data_info" | null;
  /** 1 on, 0 switched off, null not read */
  on_off: number | null;
  /** newest stored record, plant-local "YYYY-MM-DDTHH:MM:SS"; null = nothing stored */
  last_record: string | null;
  /** today's stored yield (last `eac_today` of today), kWh; null = no record today */
  yield_today_kwh: number | null;
  /** yield ÷ mean yield of the plant's installed inverters with a yield today × 100 */
  pct_of_plant_avg: number | null;
  /** active (open / acknowledged) issues; engineers never count shadow ones */
  open_issues: number;
  /** highest tier of those ("P1" | "P2" | "P3" | "Info"), null = none */
  top_tier: string | null;
  /** stored alarm-log records today; null = the inverter's alarm log not read today */
  alarms_today: number | null;
  /** of those, still open (no end time) */
  alarms_open: number | null;
  has_string_layout: boolean;
  not_installed: { at: string | null; by: string | null; note: string | null } | null;
}

export interface DeviceInverterList {
  meta: DevicesMeta;
  inverters: DeviceInverter[];
  summary: { inverters: number; installed: number; not_installed: number; plants: number };
}

export interface DeviceMeter {
  plant_id: number;
  plant_name: string;
  phase: number | null;
  province: string | null;
  datalogger_sn: string;
  address: number;
  device_name: string | null;
  device_type: string | null;
  /** newest stored record, plant-local; null = nothing stored */
  last_record: string | null;
  /** today's stored import / export kWh (measured, `growatt_meter.day_energy`); null = not enough records */
  import_today_kwh: number | null;
  export_today_kwh: number | null;
  /** stored records today */
  records_today: number;
}

export interface DeviceMeterList {
  meta: DevicesMeta;
  meters: DeviceMeter[];
  /** plants the user may see with no registered meter */
  plants_without_meter: Array<{ plant_id: number; plant_name: string }>;
}

export interface DeviceDatalogger {
  datalogger_sn: string;
  plant_id: number;
  plant_name: string;
  phase: number | null;
  province: string | null;
  /** from the inverters' `datalogger_model`, null = unknown */
  model: string | null;
  inverters: number;
  sensors: number;
  meters: number;
  /** newest stored record of any device behind it (plant-local), null = none */
  last_record: string | null;
  /** site register logger SN of the plant's station; null = no station / empty */
  register_sn: string | null;
  /** register_sn vs this serial: "match" | "prefix" (register SN truncated) | "differs" (none of the plant's
   * serials matches it) | null (no register SN, or another serial of the plant matched it) */
  register_match: "match" | "prefix" | "differs" | null;
}

export interface DeviceDataloggerList {
  meta: DevicesMeta;
  dataloggers: DeviceDatalogger[];
  /** per plant: Growatt's entered datalogger count vs serials found */
  plants: Array<{ plant_id: number; plant_name: string; growatt_count: number | null; found: number }>;
}

export type DeviceCheckCode =
  | "inverter_never_reported"
  | "inverter_silent"
  | "inverter_switched_off"
  | "inverter_limited"
  | "nameplate_missing"
  | "info_not_read"
  | "firmware_minority"
  | "no_string_layout"
  | "inverter_count_mismatch"
  | "logger_sn_mismatch"
  | "no_meter"
  | "meter_silent"
  | "sensor_probe_missing"
  | "sensor_irradiance_zero_daylight";

export type DeviceKind = "inverter" | "meter" | "sensor" | "datalogger" | "plant";

/** A health check on a device, computed on request (never stored), always with its reason. */
export interface DeviceCheck {
  code: DeviceCheckCode;
  severity: "warn" | "info";
  kind: DeviceKind;
  plant_id: number;
  plant_name: string;
  /** serial, "dl:addr" for a sensor / meter, null for a plant-level check */
  device_key: string | null;
  device_label: string | null;
  /** English sentence with the values behind it */
  reason: string;
  params: Record<string, string | number | boolean | null>;
  /** app path where it gets fixed, e.g. "/plant/123/inverters?sn=ABC" */
  fix_path: string | null;
}

export interface DeviceCheckList {
  meta: DevicesMeta & { thresholds: Record<string, number> };
  checks: DeviceCheck[];
  summary: { total: number; warn: number; info: number; by_code: Partial<Record<DeviceCheckCode, number>> };
}
