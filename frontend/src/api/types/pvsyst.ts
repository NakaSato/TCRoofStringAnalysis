/** PVsyst design data of the PWA stations (`/pvsyst/*`, backend services/pvsyst.py). Every figure is
 * modelled (PVsyst simulation reports, P50, unlimited load), never measured. */

/** One phase of the model's `PVsyst_สรุป` sheet (admins only; `phase` 0 = the whole project). */
export interface PvsystPhase {
  phase: number;
  stations_model: number | null;
  reports: number | null;
  kwp_pvsyst: number | null;
  kwp_model: number | null;
  mwh_year: number | null;
  /** kWh/kWp/yr */
  specific_yield: number | null;
  /** 0–1, the sheet's weighted PR */
  pr_weighted: number | null;
  /** first contract year, kWh/kWp/yr */
  contract_specific_yield: number | null;
  /** the sheet's kWh ÷ kWh */
  contract_over_pvsyst: number | null;
  /** contract kWh/kWp ÷ PVsyst kWh/kWp (derived) */
  contract_over_pvsyst_per_kwp: number | null;
  contract_kwh_y1: number | null;
  station_rows: number;
}

export interface PvsystStation {
  phase: number;
  seq: number;
  name: string;
  branch: string | null;
  project: string | null;
  lat: number | null;
  lon: number | null;
  tilt_azimuth: string | null;
  /** [[tilt, azimuth], …]; null when the text did not read */
  orientations: Array<[number, number]> | null;
  /** single-orientation stations only (PVsyst: 0 = south, −90 = east, 90 = west) */
  tilt_deg: number | null;
  azimuth_deg: number | null;
  modules: number | null;
  wp_per_module: number | null;
  kwp: number | null;
  kwac: number | null;
  kwp_model: number | null;
  /** derived kWp ÷ kWac */
  dc_ac_ratio: number | null;
  /** 0–1 */
  pr: number | null;
  /** E_Grid MWh, Jan..Dec */
  mwh_month: Array<number | null>;
  /** derived E_Grid ÷ kWp, Jan..Dec */
  kwh_kwp_month: Array<number | null>;
  mwh_year: number | null;
  mwh_year_report: number | null;
  specific_yield: number | null;
  contract_kwh_y1: number | null;
  /** contract = the contract sheet (phase 1); estimated = the model's estimate (phases 2–4) */
  contract_basis: "contract" | "estimated" | null;
  contract_specific_yield: number | null;
  contract_over_pvsyst: number | null;
  report_code: string | null;
  note: string | null;
  /** PWA report sites joined to the station */
  site_ids: string[];
}

export interface PvsystDesign {
  phases: PvsystPhase[];
  total: PvsystPhase | null;
  stations: PvsystStation[];
  meta: { source: string | null; imported_at: string | null; scope: "fleet" | "assigned"; azimuth_convention: string };
  labels: Record<string, string>;
}

export interface PvsystVsMeterMonth {
  /** YYYY-MM */
  month: string;
  days_read: number;
  /** measured (PWA report meter) */
  meter_kwh: number;
  /** modelled; null when a day of the month has no PVsyst figure */
  pvsyst_kwh: number | null;
  pvsyst_missing_days: number;
  meter_over_pvsyst: number | null;
}

export interface PvsystVsMeterSite {
  site_id: string;
  name: string;
  phase: number;
  region: string | null;
  kwp: number;
  station_seq: number;
  station_kwp: number | null;
  kwp_ratio: number | null;
  months: PvsystVsMeterMonth[];
}

export interface PvsystVsMeter {
  sites: PvsystVsMeterSite[];
  matched: number;
  unmatched: number;
  unmatched_sites: string[];
  sites_without_readings: number;
  start: string | null;
  end: string | null;
  labels: Record<string, string>;
}
