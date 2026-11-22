/** API types: Growatt plants, inverters, strings and alarms: DB history (`/growatt/plants*`) and live (`/growatt/live/*`) shapes. */
import type { GrowattLiveDiagnostics, GrowattLiveGrid, GrowattMpptEnergy, LiveStringCheck, LiveStringStatus } from "./live";
import type { GrowattIecPr, GrowattWeatherKpis, GrowattWeatherSensor } from "./weather";

export type * from "./live";
export type * from "./alarms";
export type * from "./layout";
export type * from "./iv";

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
  /** overview only: links to the plant's as-built PDF / site photo folder on Google Drive (a kind without a link is absent) */
  documents?: Partial<Record<PlantDocumentKind, { url: string; title: string | null; revision: string | null }>>;
}

/** `/growatt/plants/{id}/documents`: links only; the files stay on Google Drive */
export type PlantDocumentKind = "asbuilt" | "site_photos";

export interface PlantDocument {
  kind: PlantDocumentKind;
  url: string;
  title: string | null;
  /** "REV.3" as read from the Drive file name */
  revision: string | null;
  /** matched = Drive name matcher, manual = set by an admin (a re-import keeps it) */
  source: "matched" | "manual";
  /** name-match confidence 0…1 (matched only) */
  match_score: number | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface PlantDocumentRow {
  plant_id: number;
  name: string;
  phase: number | null;
  asbuilt: PlantDocument | null;
  site_photos: PlantDocument | null;
}

export interface GrowattDbMeta {
  source: "db";
  day: string | null;
  data_until?: string | null;
  synced_at?: string | null;
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
    dc_yield_today_kwh?: number | null;
    total_yield_kwh: number | null;
    specific_yield_kwh_per_kwp: number | null;
    ya_kwh_kwp?: number | null;
    ya_minus_yf?: number | null;
    /** peer-relative string index (strings compared with each other), not IEC */
    plant_pr_pct: number | null;
    /** IEC 61724-1 PR from the plant's weather sensor; null without one or with poor coverage */
    iec_pr_pct?: number | null;
    /** Temperature-corrected PR' = PR / [1 + gamma*(T_mod - 25 °C)] */
    iec_pr_temp_corrected_pct?: number | null;
    /** Energy Performance Index (measured / modelled energy over filtered slots) */
    epi?: number | null;
    /** the EPI model's system factor (modelled): fitted per plant on its clearest good days, else the default 0.985 */
    epi_factor?: EpiFactor;
    /** R16 verdict on the day's weather sensor; ok false = IEC PR, PR' and EPI rest on a suspect sensor; null = not judged */
    sensor_health?: { ok: boolean; flags: string[]; reasons: string[] } | null;
    insolation_kwh_m2?: number | null;
    peak_irradiance_wm2?: number | null;
    avg_module_temp_c?: number | null;
    irradiance_weighted_module_temp_c?: number | null;
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
    /** energy meter at the grid connection point: import / export measured, load derived (null = no readings) */
    has_meter?: boolean;
    grid_import_kwh?: number | null;
    grid_export_kwh?: number | null;
    load_kwh?: number | null;
    /** curtailed energy of the day (estimated; backend services/growatt_curtailment.py) */
    curtailment?: Curtailment;
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
    /** when the device was added to Growatt (`device/all/create_date`), as reported; not a commissioning date */
    growatt_created_at?: string | null;
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
    dc_energy_kwh?: number | null;
    total_yield_kwh: number | null;
    specific_yield: number | null;
    ya_kwh_kwp?: number | null;
    ya_minus_yf?: number | null;
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
  /** listed in Growatt but marked not installed on site: in no figure of this overview */
  not_installed_inverters?: GrowattInverter[];
  timeseries: Array<{
    timestamp: string;
    /** null = no inverter record in this slot (a row of the energy meter only, e.g. at night); never 0 */
    pac_kw: number | null;
    ppv_kw: number | null;
    expected_kw: number | null;
    temp_c: number | null;
    freq_hz: number | null;
    /** inverters in the pac_kw / ppv_kw sum: measured in this slot, or held (below) */
    inverters?: number;
    /** of those, inverters with no record in this slot, carrying their own value from ≤ 10 min earlier */
    held?: number;
    /** measured by the weather sensor (null without one) */
    irradiance_wm2?: number | null;
    /** energy meter at the grid connection point (null without a record in the slot) */
    grid_import_kw?: number | null;
    grid_export_kw?: number | null;
    /** derived: PV AC + import − export (null where that would be negative) */
    load_kw?: number | null;
    module_temp_c?: number | null;
    ambient_temp_c?: number | null;
    /** what the array could give in the slot (modelled: kWp × POA × temperature × EPI factor, capped at rated AC); null without a sensor reading */
    available_kw?: number | null;
    /** available − AC where the plant was held back (estimated); 0 = judged, not curtailed; null = not judged */
    curtailed_kw?: number | null;
    /** why: the meter holds ~0 kW (zero-export, PV follows the load) or AC at the power-limit setting */
    curtailed_by?: CurtailCause | null;
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
  /** when the device was added to Growatt (`device/all/create_date`), as reported; not a commissioning date */
  growatt_created_at?: string | null;
  settings?: GrowattInverterSettings;
  /** marked by an admin as listed in Growatt but not installed on site (null = installed) */
  not_installed?: InverterNotInstalled | null;
}

export interface InverterNotInstalled {
  at: string;
  by: string | null;
  note: string | null;
}

/** /growatt/plants/{id}/power — the plant's stored 5-min AC / DC curve over a day or day range (DB only). */
export interface GrowattPlantPower {
  meta: { source: "db"; day: string; end_day: string; window: [string | null, string | null] };
  plant_id: number;
  inverter_count: number;
  /** sum of the inverters' nameplate AC; null unless every inverter has one */
  rated_ac_kw: number | null;
  /** `irradiance_wm2`: the weather sensor's POA irradiance (measured; null without a sensor) */
  timeseries: Omit<GrowattPlantOverview["timeseries"][number], "module_temp_c" | "ambient_temp_c">[];
  /** the plant has an energy meter (grid / load columns in `timeseries`) */
  has_meter?: boolean;
  /** the period's grid import / export (meter) and load (derived) in kWh, integrated by the
   *  backend like a whole day's; null without meter readings in the period */
  grid_import_kwh?: number | null;
  grid_export_kwh?: number | null;
  load_kwh?: number | null;
  /** curtailed energy of the period (estimated); per slot in `timeseries`, per day in `daily` */
  curtailment?: Curtailment;
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
    /** curtailed kWh of the day (estimated); null = no slot could be judged */
    curtailed_kwh?: number | null;
  }>;
}

export type CurtailCause = "export_limit" | "power_limit";

/** Curtailment estimate of a day or period (backend services/growatt_curtailment.py). Estimated,
 * never measured: the modelled available power minus the AC in slots where the meter held ~0 kW
 * or the AC sat at the power-limit setting. */
export interface Curtailment {
  /** null = no slot could be judged (no sensor reading, no kWp) */
  kwh: number | null;
  slots: number;
  judged_slots: number;
  by: Partial<Record<CurtailCause, number>>;
  reason: "no_capacity" | "no_sensor_slots" | null;
  estimated: true;
  /** the EPI system factor in the model */
  factor: number;
  limit_kw: number | null;
}

/** The EPI model's system factor in use for a plant (backend services/epi_fit.py). Modelled. */
export interface EpiFactor {
  factor: number;
  basis: "fitted" | "default";
  /** fitted | too_few_days | rejected; null = never tried */
  status: "fitted" | "too_few_days" | "rejected" | null;
  /** the median found, also when rejected */
  fit_factor: number | null;
  days_used: number;
  candidate_days: number;
  start_day: string | null;
  end_day: string | null;
  spread_pct: number | null;
  reason: string | null;
  fitted_at: string | null;
  modelled: true;
}

/** One stored plant-day of `growatt_plant_daily` (`/growatt/plants/{id}/kpi-daily`). DB only.
 * PR / PR' come from the plant's weather sensor (IEC 61724; null without one). `modelled_energy_kwh`,
 * `epi` and `system_factor` are modelled. */
export interface PlantKpiDay {
  day: string;
  capacity_kwp: number | null;
  energy_kwh: number | null;
  dc_energy_kwh: number | null;
  /** modelled */
  modelled_energy_kwh: number | null;
  /** reference yield: POA insolation ÷ 1 kW/m² (h) */
  yr_h: number | null;
  /** array yield, DC (kWh/kWp) */
  ya_kwh_kwp: number | null;
  /** final (specific) yield, AC (kWh/kWp) */
  yf_kwh_kwp: number | null;
  ya_minus_yf: number | null;
  pr_pct: number | null;
  pr_temp_corrected_pct: number | null;
  /** modelled */
  epi: number | null;
  /** modelled */
  system_factor: number | null;
  irradiance_weighted_tmod_c: number | null;
  filtered_slots: number | null;
  stale_masked_slots: number | null;
  clipped_masked_slots: number | null;
  curtailed_masked_slots: number | null;
  sensor_stale_slots: number | null;
  sensor_high_slots: number | null;
  sensor_midday_wm2: number | null;
  sensor_neighbour_ratio: number | null;
  sensor_neighbours: number | null;
  /** Google cloud cover at midday (modelled) */
  cloud_midday_pct: number | null;
  /** R16: false = PR, PR' and EPI of the day rest on a suspect sensor; null = not judged */
  sensor_ok: boolean | null;
  /** "stale" | "above_clear_sky" | "below_neighbours" */
  sensor_flags: string[];
}

export interface PlantKpiDaily {
  plant_id: number;
  start: string;
  end: string;
  /** stored days only, oldest first (a day with no row is missing, not zero) */
  days: PlantKpiDay[];
  epi_factor: EpiFactor;
  meta: { source: "db"; modelled: string[] };
}
