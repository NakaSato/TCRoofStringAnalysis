/** API types: Growatt plants, inverters, strings and alarms: DB history (`/growatt/plants*`) and live (`/growatt/live/*`) shapes. */
import type { GrowattIecPr, GrowattWeatherKpis, GrowattWeatherSensor } from "./weather";

export interface GrowattPlant {
  plant_id: number;
  /** project phase = the Growatt account listing this plant; null until the fleet sync tags it */
  phase?: number | null;
  name: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  /** null when missing, or when Growatt's value is impossible for the plant's inverters */
  peak_power_kwp: number | null;
  /** Growatt's peak power when rejected (> 3x the inverters' rated AC power, e.g. typed in W) */
  reported_peak_power_kwp?: number | null;
  current_power_w: number | null;
  today_energy_kwh?: number | null;
  total_energy_kwh: number | null;
  inverter_count?: number;
  /** realtime: always null from the DB, filled by the live overlay */
  status: number | null;
  create_date: string | null;
  /** from Growatt plant/details (weekly; overview only): time zone ("GMT+7"), address, counts as entered in Growatt */
  timezone?: string | null;
  address?: string | null;
  growatt_inverter_count?: number | null;
  growatt_datalogger_count?: number | null;
  energy_date?: string | null;
  synced_at?: string | null;
}

export interface GrowattDbMeta {
  source: "db";
  day: string | null;
  data_until?: string | null;
  synced_at?: string | null;
}

/** Realtime envelope from /growatt/live/* (backend memory cache only, never persisted). */
export interface GrowattLive<T> {
  source: "live";
  fetched_at: string;
  stale: boolean;
  error: string | null;
  /** Seconds until polling again can return anything new (cache expiry / cooldown end). */
  refresh_in_s?: number;
  data: T;
}

/** One record of the Growatt alarm / fault log (`device/max/alarm_data`); times are plant-local. */
export interface GrowattAlarm {
  device_sn: string;
  start_time: string | null;
  end_time: string | null;
  alarm_code: number | string | null;
  alarm_message: string | null;
  /** as Growatt labels it: "Warning", "Fault", … */
  fault_type: string | null;
  status: number | null;
}

/** /growatt/live/plants/{id}/alarms — memory only, never stored. */
export interface GrowattLiveAlarms {
  plant_id: number;
  /** first / last plant-local day of the window */
  from: string;
  to: string;
  alarms: GrowattAlarm[];
  /** inverter-days whose log could not be read ("SN YYYY-MM-DD" -> error) */
  errors: Record<string, string>;
}

/** One plant's alarm-log coverage for a day in /growatt/alarms. */
export interface FleetAlarmPlant {
  plant_id: number;
  name: string;
  inverters: number;
  /** inverters whose log for the day the worker has read (0 = not synced yet, not "no alarms") */
  synced_inverters: number;
  /** oldest read among them (UTC ISO); null when none was read */
  synced_at: string | null;
}

/** /growatt/alarms — stored alarm log of every visible plant for one plant-local day (DB only). */
export interface FleetAlarmDay {
  day: string;
  /** `read_at`: when this inverter's log was last read (UTC ISO), the reference for "still open" */
  alarms: Array<GrowattAlarm & { plant_id: number; plant_name: string; read_at?: string | null }>;
  plants: FleetAlarmPlant[];
  meta: {
    source: "db";
    synced_at: string | null;
    /** when the worker's `alarms` job last started (UTC ISO) */
    last_run_at?: string | null;
    /** when it will next start (UTC ISO); today only */
    next_run_at?: string | null;
  };
}

export interface GrowattLivePlant {
  plant_id: number;
  phase: number;
  name: string | null;
  current_power_w: number | null;
  total_energy_kwh: number | null;
  peak_power_kwp: number | null;
  status: number | null;
}

/** /growatt/live/plants/today: today's energy per plant from Growatt `plant/data` (memory only),
 * swept a batch of plants per request; `sweep` says how many are fresh. */
export interface GrowattLivePlantsToday {
  /** plant-local day the values are judged against */
  day: string;
  /** keyed by plant id; a plant not checked yet is absent */
  plants: Record<
    string,
    {
      fetched_at: string;
      stale: boolean;
      /** plant-local time of the plant's last upload */
      last_update_time: string | null;
      /** null when the last upload is not from today */
      today_energy_kwh: number | null;
    }
  >;
  errors: Record<string, string>;
  sweep: { fresh: number; checked: number; total: number; oldest_age_s: number };
}

export interface GrowattLiveGrid {
  v_r: number | null; v_s: number | null; v_t: number | null;
  v_rs: number | null; v_st: number | null; v_tr: number | null;
  i_r: number | null; i_s: number | null; i_t: number | null;
  pf: number | null;
  reactive_var: number | null;
  fac_hz: number | null;
}

/** Fault / warning codes and internal temperatures of the newest record (0 = none, null = not reported). */
export interface GrowattLiveDiagnostics {
  fault_type: number | null;
  fault_code1: number | null;
  fault_code2: number | null;
  fault_value: number | null;
  warn_code: number | null;
  warning_values: Array<number | null>;
  pid_fault_code: number | null;
  /** Growatt string-break bit field, 0 = none */
  str_break: number | null;
  pv_iso_kohm: number | null;
  temperature_c: number | null;
  ipm_temperature_c: number | null;
  boost_temperature_c: number | null;
  /** arc-fault detection status code and level per AFCI channel, as reported */
  afci_status?: number | null;
  afci_pv?: Array<number | null>;
  /** residual (leakage) current and DC injection R/S/T, as reported by Growatt */
  gfci?: number | null;
  dci?: Array<number | null>;
  /** lifetime operating hours (Growatt timeTotal) */
  time_total_h?: number | null;
}

export interface GrowattMpptEnergy {
  mppt: number;
  today_kwh: number | null;
  total_kwh: number | null;
}

/** Inverter settings as configured (read daily by the fleet job), not measurements. */
export interface GrowattInverterSettings {
  /** active power limit, % of rated: < 100 = curtailed; null = unknown */
  active_rate_pct: number | null;
  /** where the limit comes from: `read_power` (read from the inverter, daily) or `max_data_info` */
  active_rate_source?: "read_power" | "max_data_info" | null;
  /** when readPower last answered (UTC ISO); the limit may be older than `read_at` */
  power_limit_read_at?: string | null;
  reactive_rate_pct: number | null;
  pf_setting: number | null;
  pf_model: number | null;
  export_limit: number | null;
  export_limit_rate_pct: number | null;
  /** 1 = on, 0 = switched off */
  on_off: number | null;
  /** when Growatt was last asked (UTC ISO) */
  read_at: string | null;
}

export interface GrowattLiveInverterLatest {
  device_sn: string;
  timestamp: string; // plant-local
  status: number | null;
  pac_w: number | null;
  ppv_w: number | null;
  eac_today_kwh: number | null;
  temperature_c: number | null;
  fac_hz: number | null;
  mppt: Array<{ mppt: number; v: number; i: number; p: number }>;
  grid?: GrowattLiveGrid;
  diagnostics?: GrowattLiveDiagnostics;
  mppt_energy?: GrowattMpptEnergy[];
  strings: Array<{ string_no: number; mppt_no: number; voltage_v: number; current_a: number; power_w: number }>;
  /** true = Growatt refused this inverter just now; this is its last good record */
  stale?: boolean;
  fetched_at?: string;
}

export type LiveStringStatus = "Healthy" | "Warning" | "Critical";

/** One string judged against its inverter's other strings in the same live record. */
export interface LiveStringVerdict {
  /** null = no verdict (low light, too few strings, wiring unknown) */
  status: LiveStringStatus | null;
  current_dev_pct: number | null;
  voltage_dev_pct: number | null;
  reason: string;
}

/** `data.string_check` of /live/plants/{id}/latest: realtime only, never stored. */
export interface LiveStringCheck {
  inverters: Record<
    string,
    {
      status: "ok" | "low_light" | "too_few_strings";
      median_current_a: number | null;
      voltage_basis: "per_module" | null;
      timestamp: string | null;
      stale: boolean;
      strings: Record<string, LiveStringVerdict>;
    }
  >;
  summary: { healthy: number; warning: number; critical: number; unknown: number; checked_inverters: number; at: string | null };
}

export interface GrowattLivePlantLatest {
  plant_id: number;
  day: string;
  inverters: GrowattLiveInverterLatest[];
  errors: Record<string, string>;
  string_check?: LiveStringCheck;
}

/** /growatt/plants/{id}/inverters/{sn}/timeseries — one inverter's stored 5-minute day curve (DB only). */
export interface GrowattInverterTimeseries {
  meta: GrowattDbMeta;
  plant_id: number;
  device_sn: string;
  /** kWp behind the modelled reference; null when unknown */
  capacity_kwp: number | null;
  /** "string_layout": modules × Wp of its strings; "plant_share": plant kWp / inverters */
  capacity_basis: "string_layout" | "plant_share" | null;
  timeseries: Array<{
    timestamp: string;
    pac_kw: number;
    ppv_kw: number;
    /** modelled clear-sky reference, not measured */
    expected_kw: number | null;
    temp_c: number | null;
  }>;
  /** rated AC power from Growatt; null until the fleet job has read it */
  nominal_power_kw?: number | null;
  /** string current per 5-min slot: current_a[string][slot], null = no record */
  strings?: { string_nos: number[]; timestamps: string[]; current_a: Array<Array<number | null>> };
}

export interface GrowattInverterDaily {
  meta: { source: "db"; from: string; to: string; days: number };
  plant_id: number;
  device_sn: string;
  nominal_power_kw: number | null;
  daily: Array<{
    day: string;
    yield_kwh: number | null;
    /** mean yield of the plant's inverters that reported that day */
    plant_avg_yield_kwh: number | null;
    inverters_reporting: number;
    vs_plant_pct: number | null;
    peak_ac_kw: number | null;
    max_temp_c: number | null;
  }>;
}

export interface GrowattPlantOverview {
  meta: GrowattDbMeta;
  /** set by AppContext when live values are overlaid */
  live?: {
    fetched_at: string;
    stale: boolean;
    /** plant-local time of the newest inverter record in the overlay */
    data_at?: string | null;
    /** sum of the inverters' live PV input power (ppv), kW; null when none reported it */
    dc_kw?: number | null;
    /** string status judged on the live record (realtime); null when the backend sent none */
    strings?: LiveStringCheck["summary"] | null;
  } | null;
  plant: GrowattPlant;
  kpis: {
    capacity_kwp: number | null;
    current_power_kw: number | null;
    peak_power_kw: number | null;
    yield_today_kwh: number | null;
    total_yield_kwh: number | null;
    specific_yield_kwh_per_kwp: number | null;
    /** peer-relative string index (strings compared with each other), not IEC */
    plant_pr_pct: number | null;
    /** IEC 61724-1 PR from the plant's weather sensor; null without one or with poor coverage */
    iec_pr_pct?: number | null;
    insolation_kwh_m2?: number | null;
    peak_irradiance_wm2?: number | null;
    avg_module_temp_c?: number | null;
    avg_ambient_temp_c?: number | null;
    target_pr_pct: number;
    conversion_efficiency_pct: number | null;
    avg_temp_c: number | null;
    max_temp_c: number | null;
    avg_freq_hz: number | null;
    inverter_count: number;
    /** realtime: null from the DB, counted from live inverter status by AppContext */
    online_inverters: number | null;
    string_count: number;
    healthy_strings: number;
    warning_strings: number;
    critical_strings: number;
    /** string inputs with no current today (not in `strings`) */
    inactive_strings?: number;
    /** strings with a module count in the layout registry / compared per module with peers */
    strings_with_module_count?: number;
    strings_normalized?: number;
    avg_health_score: number | null;
    tariff_thb_per_kwh: number;
  };
  inverters: Array<{
    device_sn: string;
    model: string;
    datalogger_sn: string;
    /** name set in Growatt (e.g. "INVERTER 7"), rated AC power and firmware, from max_data_info */
    alias?: string | null;
    nominal_power_kw?: number | null;
    fw_version?: string | null;
    inner_version?: string | null;
    /** from Growatt queryDeviceInfoParam (monthly): model text, datalogger model, rating as listed */
    device_model?: string | null;
    datalogger_model?: string | null;
    rated_power_kw?: number | null;
    settings?: GrowattInverterSettings;
    status: number | null;
    status_label: string | null;
    lost: boolean | null;
    last_update_time: string | null;
    capacity_kwp: number | null;
    current_ac_kw: number | null;
    peak_ac_kw: number | null;
    peak_dc_kw: number | null;
    yield_today_kwh: number | null;
    period_energy_kwh: number | null;
    total_yield_kwh: number | null;
    specific_yield: number | null;
    efficiency_pct: number | null;
    pr_pct: number | null;
    avg_temp_c: number | null;
    max_temp_c: number | null;
    avg_freq_hz: number | null;
    string_count: number;
    mppt_latest: Array<{ mppt: number; v: number; i: number; p: number }>;
    /** plant-local time of the live record overlaid on current_ac_kw / mppt_latest (frontend only) */
    live_at?: string | null;
    /** grid side and fault / warning codes of the live record (frontend only) */
    live_grid?: GrowattLiveGrid | null;
    live_diagnostics?: GrowattLiveDiagnostics | null;
    live_mppt_energy?: GrowattMpptEnergy[] | null;
  }>;
  timeseries: Array<{
    timestamp: string;
    pac_kw: number;
    ppv_kw: number;
    expected_kw: number | null;
    temp_c: number | null;
    freq_hz: number | null;
    /** inverters in the pac_kw / ppv_kw sum: measured in this slot, or held (below) */
    inverters?: number;
    /** of those, inverters with no record in this slot, carrying their own value from ≤ 10 min earlier */
    held?: number;
    /** measured by the weather sensor (null without one) */
    irradiance_wm2?: number | null;
    module_temp_c?: number | null;
    ambient_temp_c?: number | null;
  }>;
  weather?: {
    has_sensor: boolean;
    sensors: GrowattWeatherSensor[];
    data_until: string | null;
    kpis: GrowattWeatherKpis;
    iec_pr: GrowattIecPr;
  };
  loss_waterfall: Array<{
    stage: string;
    kwh: number;
    type: "base" | "loss" | "net";
  }>;
  strings: Array<{
    string_id: string;
    short_label: string;
    inverter_id: string;
    device_sn: string;
    string_no: number;
    mppt_id: string;
    mppt_no: number;
    capacity_kwp: number | null;
    /** as-built module count from the string layout registry (null = not entered) */
    modules?: number | null;
    module_wp?: number | null;
    peer_basis?: GrowattPeerBasis;
    actual_energy_kwh: number;
    expected_energy_kwh: number | null;
    energy_loss_kwh: number | null;
    pr_pct: number | null;
    v_avg: number | null;
    v_max: number;
    i_avg: number | null;
    i_max: number;
    p_max_w: number;
    current_mismatch_pct: number | null;
    voltage_mismatch_pct: number | null;
    underperf_pct: number | null;
    availability_pct: number;
    health_score: number | null;
    status: "Healthy" | "Warning" | "Critical";
    diagnosis: string;
    /** realtime overlay from /growatt/live/plants/{id}/latest (frontend only, never stored) */
    live_voltage_v?: number | null;
    live_current_a?: number | null;
    live_power_w?: number | null;
    live_at?: string | null;
    /** live string check (same record as live_*); absent without live data */
    live_status?: LiveStringStatus | null;
    live_reason?: string | null;
  }>;
  /** String inputs with no current today, one per input slot (2 per MPPT). Not in `strings`. */
  inactive_strings?: Array<{
    string_id: string;
    short_label: string;
    device_sn: string;
    string_no: number;
    mppt_no: number;
    mppt_id: string;
    status: "Not Active";
    /** no_current: MPPT has voltage, string carries no current; no_data: input not reported */
    reason: "no_current" | "no_data";
    v_max: number | null;
  }>;
  anomalies: Array<{
    string_id: string;
    inverter_id: string;
    device_sn: string;
    string_no: number;
    severity: "Critical" | "Warning";
    category: string;
    description: string;
    pr_pct: number | null;
    energy_loss_kwh: number | null;
    recommended_action: string;
  }>;
}

/**
 * How a string is compared with its inverter peers. "raw": measured values (some string of the
 * inverter has no module count); "per_module": energy and voltage per module; "per_kwp": energy
 * per kWp (module ratings known too) and voltage per module.
 */
export type GrowattPeerBasis = "raw" | "per_module" | "per_kwp";

export interface GrowattStringLayoutEntry {
  device_sn: string;
  string_no: number;
  modules: number;
  module_wp?: number | null;
}

/** Result of mirroring a saved registry change to the summary sink (Firestore or JSON files). */
export interface PublishResult {
  sink: string | null;
  written: number;
  deferred?: boolean;
  error?: string;
}

/** PV module used across the fleet (global setting; SQL, mirrored to Firestore config/fleet_module). */
export interface FleetModule {
  manufacturer: string;
  model: string;
  wp: number;
  vmp_stc: number | null;
  imp_stc: number | null;
  voc_stc: number | null;
  isc_stc: number | null;
  efficiency_pct: number | null;
  temp_coeff_pmax_pct: number | null;
  temp_coeff_voc_pct: number | null;
  temp_coeff_isc_pct: number | null;
  bifacial_factor_pct: number | null;
  datasheet_url: string | null;
}

export interface FleetModuleOut extends FleetModule {
  /** "default" = operator-stated module, not yet saved by anyone */
  source: "default" | "saved";
  updated_by: string | null;
  updated_at: string | null;
  /** result of mirroring to the summary sink (PUT only) */
  published?: PublishResult;
}

export interface GrowattStringLayout {
  plant_id: number;
  plant_name: string;
  /** rating applied to strings whose module_wp is null */
  fleet_module_wp: number | null;
  inverters: Array<{
    device_sn: string;
    model: string;
    strings: Array<{
      string_no: number;
      mppt_no: number;
      modules: number | null;
      module_wp: number | null;
      /** carried current in the last 7 days of stored history */
      active: boolean;
    }>;
  }>;
}

export interface GrowattStringDetail {
  meta: GrowattDbMeta & {
    /** plant-local time-of-day window (HH:MM, inclusive) everything covers; null = whole day */
    window?: { start: string | null; end: string | null } | null;
    /** last day of a day range starting at `day`; null = one day */
    end_day?: string | null;
  };
  plant_id: number;
  plant_name: string;
  device_sn: string;
  string_no: number;
  mppt_no: number;
  string_id: string;
  modules?: number | null;
  module_wp?: number | null;
  /** peer series scaled to this string's module count (per_module) or kWp (per_kwp); raw = as measured */
  peer_basis?: GrowattPeerBasis;
  summary: {
    v_avg: number | null;
    v_max: number | null;
    v_mpp: number | null;
    v_oc_est: number | null;
    i_avg: number | null;
    i_max: number | null;
    i_mpp: number | null;
    i_sc_est: number | null;
    p_max_w: number | null;
    energy_kwh: number;
    peer_energy_kwh: number | null;
    pr_pct: number | null;
  };
  timeseries: Array<{
    timestamp: string;
    voltage_v: number;
    current_a: number;
    power_w: number;
    peer_voltage_v: number | null;
    peer_current_a: number | null;
    peer_power_w: number | null;
  }>;
  /** each day of the range (one entry for a single day); null = no records that day */
  daily?: Array<{ day: string; energy_kwh: number | null; peer_energy_kwh: number | null; pr_pct: number | null }>;
  iv_pv_curve: {
    nominal_points: Array<{ v: number; i: number; p: number }>;
    actual_points: Array<{ v: number; i: number; p: number }>;
    measured_scatter: Array<{ v: number; i: number; p: number; timestamp: string }>;
    /** null (and an empty curve) when there is nothing measured to model it from */
    mpp_nominal: { v: number; i: number; p: number } | null;
    mpp_actual: { v: number; i: number; p: number } | null;
  };
}

export interface GrowattInverter {
  device_sn: string;
  model: string;
  datalogger_sn: string;
  manufacturer: string;
  status: number | null;
  status_label: string | null;
  lost: boolean | null;
  last_update_time: string | null;
  device_types: string[];
  synced_at?: string | null;
  /** name set in Growatt (e.g. "INVERTER 7"), rated AC power and firmware, from max_data_info */
  alias?: string | null;
  nominal_power_kw?: number | null;
  fw_version?: string | null;
  inner_version?: string | null;
  /** from Growatt queryDeviceInfoParam (monthly): model text, datalogger model, rating as listed */
  device_model?: string | null;
  datalogger_model?: string | null;
  rated_power_kw?: number | null;
  settings?: GrowattInverterSettings;
}

/** /growatt/plants/{id}/power — the plant's stored 5-min AC / DC curve over a day or day range (DB only). */
export interface GrowattPlantPower {
  meta: { source: "db"; day: string; end_day: string; window: [string | null, string | null] };
  plant_id: number;
  inverter_count: number;
  /** sum of the inverters' nameplate AC; null unless every inverter has one */
  rated_ac_kw: number | null;
  timeseries: Omit<GrowattPlantOverview["timeseries"][number], "irradiance_wm2" | "module_temp_c" | "ambient_temp_c">[];
  /** Growatt's own 5-min plant AC curve (`plant/power`), stored for finished days only */
  growatt_timeseries?: Array<{ timestamp: string; pac_kw: number }>;
  /** AC energy per day integrated from the records (in the time window); null = no records.
   *  `growatt_*`: Growatt's own figures for the whole day (finished days only; null = not read) */
  daily: Array<{
    day: string;
    energy_kwh: number | null;
    growatt_energy_kwh?: number | null;
    growatt_inverters_kwh?: number | null;
    growatt_inverters_reported?: number;
    /** a Growatt figure above 10 kWh/kWp was withheld (null), as a Growatt glitch */
    growatt_implausible?: boolean;
  }>;
}

/** /growatt/live/inverters/snapshot — newest record of every visible inverter (`maxs_data`, memory only). */
export interface GrowattInverterSnapshotRow {
  plant_id: number | null;
  /** plant-local time of this record (can be months old for a silent inverter) */
  record_time: string | null;
  status: number | null;
  status_label: string | null;
  pac_w: number | null;
  ppv_w: number | null;
  /** null unless the record is from today */
  eac_today_kwh: number | null;
  temperature_c: number | null;
  fault_type: number | null;
  warn_code: number | null;
  lost: boolean | null;
  datalogger_sn: string | null;
  fetched_at: string;
  stale: boolean;
}

export interface GrowattInverterSnapshot {
  day: string;
  inverters: Record<string, GrowattInverterSnapshotRow>;
  errors: Record<string, string>;
  sweep: { fresh: number; checked: number; total: number; oldest_age_s: number; inverters: number; answered: number };
}
