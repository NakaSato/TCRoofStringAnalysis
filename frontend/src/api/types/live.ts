/** API types: live Growatt values (`/growatt/live/*`, memory only on the backend). */

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

/** `/growatt/live/plants/{id}/meter`: the energy meter's newest record (`meter_last_data`), memory only. */
export interface GrowattLiveMeter {
  plant_id: number;
  meters: Array<{
    datalogger_sn: string;
    address: number;
    /** plant-local record time */
    timestamp: string;
    interval_s: number | null;
    lost: boolean | null;
    /** signed grid power at the meter: + import / − export */
    active_power_w: number | null;
    active_power_l1_w: number | null;
    active_power_l2_w: number | null;
    active_power_l3_w: number | null;
    reactive_power_var: number | null;
    power_factor: number | null;
    frequency_hz: number | null;
    /** import counter, kWh */
    import_counter_kwh: number | null;
    stale: boolean;
    fetched_at: string;
  }>;
  /** measured, summed over the plant's meters; null unless every meter has a record */
  grid: { timestamp: string | null; grid_power_kw: number | null; grid_import_kw: number | null; grid_export_kw: number | null };
  /** PV AC + grid: derived, never measured (absent with `load=false`); null with `reason` when PV is not known */
  load?: { timestamp: string | null; pv_kw: number | null; load_kw: number | null; reason: string | null; derived: true };
  errors: Record<string, string>;
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
  /** Growatt `temperature` = AMTemp1 of its history export (also the stored `temperature_c`) */
  temperature_c: number | null;
  /** Growatt `temperature2` = the export's INVTemp (the key's "ipm" was a guess, kept for compatibility) */
  ipm_temperature_c: number | null;
  /** Growatt `temperature3` = the export's BTTemp */
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

export interface GrowattLiveInverterLatest {
  /** which Growatt call gave the record; other than `max_data` = a newest-record fallback (no older records, one-point `power`) */
  record_source?: "max_data" | "max_last_data" | "queryLastData";
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
  /** today's power from the same live answer, oldest first: [plant-local timestamp, pac W, ppv W]; memory only */
  power?: Array<[string, number | null, number | null]>;
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

/** One datalogger of `data.dataloggers` (/live/plants/{id}/latest, Growatt `device/datalogger/list`): realtime only. */
export interface GrowattLiveDatalogger {
  datalogger_sn: string;
  model: string | null;
  /** Growatt's own flag: true = it lost contact with the datalogger; null = not reported */
  lost: boolean | null;
  /** last upload, plant-local "YYYY-MM-DD HH:MM:SS"; null = not reported */
  last_update_time: string | null;
  stale: boolean;
  fetched_at: string;
}

export interface GrowattLivePlantLatest {
  plant_id: number;
  day: string;
  inverters: GrowattLiveInverterLatest[];
  errors: Record<string, string>;
  string_check?: LiveStringCheck;
  /** null = the datalogger call failed (`dataloggers_error` says why); the inverters are unaffected */
  dataloggers?: GrowattLiveDatalogger[] | null;
  dataloggers_error?: string | null;
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
