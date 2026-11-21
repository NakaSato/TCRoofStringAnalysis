/** PWA daily meter report (`/pwa/meter/*`): the Cewe meter kWh each phase 1–2 site sends to PEA
 * per day, linked to its Growatt plant. DB only, imported monthly. `contract_*` / `pvsyst_*` are
 * modelled; losses, the meter gap and THB values are estimated (`labels`). docs/plans/pwa-meter-daily.md */

export type PwaDayStatus = "ok" | "outage" | "loss_inv" | "loss_meter";
export type PwaWeather = "clear" | "cloudy" | "rain";

export interface PwaMeterSite {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  kwp: number;
  contract_seq: number | null;
  pvsyst_seq: number | null;
  growatt_plant_id: number | null;
  growatt_name: string | null;
  growatt_kwp: number | null;
  kwp_mismatch: boolean;
}

export interface PwaMeterDay {
  day: string;
  meter_kwh: number | null;
  inverter_kwh: number | null;
  contract_kwh: number | null;
  pvsyst_kwh: number | null;
  status: PwaDayStatus;
  curtailment_note: boolean;
  weather: PwaWeather | null;
  note: string | null;
  yield_kwh_kwp: number | null;
}

export interface PwaMeterSiteDays {
  site: PwaMeterSite;
  days: PwaMeterDay[];
}

export interface PwaMeterSiteSummary {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  kwp: number | null;
  growatt_plant_id: number | null;
  days: number;
  meter_mwh: number | null;
  contract_mwh: number | null;
  pvsyst_mwh: number | null;
  vs_contract_pct: number | null;
  vs_pvsyst_pct: number | null;
  yield_kwh_kwp: number | null;
  availability_pct: number | null;
  data_availability_pct: number | null;
  outage_days: number;
  data_gap_days: number;
  outage_recent_days: number;
  curtailment_note_days: number;
  curtailed: boolean;
  curtailment_loss_mwh: number | null;
  outage_loss_mwh: number | null;
  under_loss_mwh: number | null;
  loss_thb: number | null;
  issues: string[];
  owner: string | null;
  rank: number;
}

export interface PwaMeterPhaseSummary {
  phase: number;
  sites: number;
  kwp: number | null;
  first_day: string;
  last_day: string;
  meter_mwh: number | null;
  contract_mwh: number | null;
  pvsyst_mwh: number | null;
  vs_contract_pct: number | null;
  pi_free_pct: number | null;
  availability_pct: number | null;
  data_availability_pct: number | null;
  curtailed_sites: number;
  curtailment_loss_mwh: number | null;
  outage_loss_mwh: number | null;
  under_loss_mwh: number | null;
  fee_thb: number | null;
}

export interface PwaMeterSummary {
  window: { start: string | null; end: string | null };
  /** per-phase totals; empty for engineers (they compare with plants an engineer may not see) */
  phases: PwaMeterPhaseSummary[];
  sites: PwaMeterSiteSummary[];
  /** field → "modelled" | "estimated" */
  labels: Record<string, string>;
}

export interface PwaOutageEvent {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  start: string;
  end: string;
  days: number;
  lost_mwh: number | null;
  lost_thb: number | null;
  cause: string;
  note: string | null;
}

export interface PwaMeterCheck {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  median_ratio_pct: number | null;
  p05_ratio_pct: number | null;
  low_days: number;
  high_days: number;
  inverter_missing_days: number;
  meter_missing_days: number;
  gap_mwh: number | null;
  gap_thb: number | null;
  flags: string[];
}

export interface PwaMeterWindow {
  start?: string | null;
  end?: string | null;
}

/** the criteria file (pwa_meter_criteria.json); only the parts the UI reads are typed */
export interface PwaMeterCriteria {
  outage_event: { long_event_days: number; fixed_fast_days: number };
  [key: string]: unknown;
}

/** one report day of a Growatt plant, with Growatt's own `plant/energy` day beside the meter */
export interface PwaPlantDay {
  day: string;
  meter_kwh: number | null;
  inverter_kwh: number | null;
  contract_kwh: number | null;
  pvsyst_kwh: number | null;
  status: PwaDayStatus;
  weather: PwaWeather | null;
  note: string | null;
  /** null = no Growatt day stored, or withheld as implausible (`growatt_implausible`) */
  growatt_kwh: number | null;
  growatt_implausible: boolean;
  meter_vs_growatt_pct: number | null;
}

export interface PwaPlantDays {
  site: PwaMeterSite;
  last_report_day: string | null;
  window: { start: string | null; end: string | null };
  days: PwaPlantDay[];
  summary: {
    report_days: number;
    compared_days: number;
    meter_kwh: number | null;
    median_meter_vs_growatt_pct: number | null;
    meter_vs_growatt_pct: number | null;
  };
  labels: Record<string, string>;
}
