/** PWA daily meter report (`/pwa/meter/*`): the Cewe meter kWh each phase 1–2 site sends to PEA
 * per day, linked to its Growatt plant. DB only, imported monthly. `contract_*` / `pvsyst_*` are
 * modelled; losses, the meter gap and THB values are estimated (`labels`). docs/plans/pwa-meter-daily.md */
import type { OmCenterSpendMonth } from "./center";

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

/** `/pwa/meter/daily`: the report days of a window, for the fleet lines and the site × day chart */
export interface PwaMeterPhaseDay {
  phase: number;
  day: string;
  /** sites with a meter reading on the day */
  sites: number;
  meter_mwh: number | null;
  /** modelled */
  contract_mwh: number | null;
  /** metered energy of the sites with a contract figure that day (no reading = 0): the like-for-like
   * numerator of `vs_contract_pct` */
  meter_on_contract_mwh?: number | null;
  /** metered energy ÷ kWp of the sites with a reading */
  yield_kwh_kwp: number | null;
  vs_contract_pct: number | null;
  /** sites whose report remark says the system was curtailed (หรี่) that day */
  curtailment_sites: number;
}

export interface PwaMeterSiteDaily {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  kwp: number;
  growatt_plant_id: number | null;
  /** one value per entry of `days`; null = no reading */
  yield_kwh_kwp: Array<number | null>;
  /** null = the site has no row for the day */
  status: Array<PwaDayStatus | null>;
  /** the report's weather word for the day; null = none given or no row */
  weather: Array<PwaWeather | null>;
  /** the report's remark says curtailed (หรี่); null = no row */
  curtailment: Array<boolean | null>;
}

export interface PwaMeterDaily {
  days: string[];
  /** per phase and day; empty for engineers (fleet totals) */
  phases: PwaMeterPhaseDay[];
  sites: PwaMeterSiteDaily[];
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

/** Cewe meter vs Growatt's own day energy (`plant/energy`) of one report site over the window; both measured */
export interface PwaVsGrowattSite {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  kwp: number;
  /** null = the site has no Growatt plant: nothing to compare */
  growatt_plant_id: number | null;
  report_days: number;
  /** days both read > 0 (a Growatt glitch day withheld) */
  compared_days: number;
  /** summed over the compared days only */
  meter_kwh: number | null;
  growatt_kwh: number | null;
  /** pooled meter ÷ Growatt on the compared days */
  ratio_pct: number | null;
  median_ratio_pct: number | null;
  p05_ratio_pct: number | null;
  low_days: number;
  high_days: number;
  /** Growatt produced, the meter read nothing */
  meter_missing_days: number;
  /** the meter read, Growatt has no day stored (only on days Growatt is stored for some plant) */
  growatt_missing_days: number;
  /** Growatt day above the plausible maximum, withheld */
  implausible_days: number;
  flags: string[];
}

export interface PwaVsGrowattDay {
  day: string;
  phase: number;
  /** sites compared that day */
  sites: number;
  meter_kwh: number | null;
  growatt_kwh: number | null;
}

export interface PwaVsGrowatt {
  window: { start: string | null; end: string | null };
  summary: {
    sites: number;
    linked_sites: number;
    compared_sites: number;
    compared_site_days: number;
    meter_kwh: number | null;
    growatt_kwh: number | null;
    ratio_pct: number | null;
    median_site_ratio_pct: number | null;
    flagged_sites: number;
    /** how far Growatt's stored day energy reaches inside the window */
    growatt_first_day: string | null;
    growatt_last_day: string | null;
  };
  days: PwaVsGrowattDay[];
  sites: PwaVsGrowattSite[];
  labels: Record<string, string>;
}

export interface PwaMeterWindow {
  start?: string | null;
  end?: string | null;
}

/** the criteria file (pwa_meter_criteria.json); only the parts the UI reads are typed */
export interface PwaMeterCriteria {
  outage_event: { long_event_days: number; fixed_fast_days: number };
  tariff: { book_price_thb_per_kwh: number };
  /** Meter vs Growatt: a site is flagged when its median ratio is under `flags.ratio_low_median`;
   * a day reads high above `high_day_ratio` (both as fractions, e.g. 0.97 / 1.005) */
  meter_vs_growatt?: { high_day_ratio: number; flags: { ratio_low_median: number } };
  /** meter ÷ contract reference lines (fractions): below `good_min` = watch, below `watch_min` = red */
  performance?: { vs_contract_bands?: { good_min: number; watch_min: number } };
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

/** `/pwa/meter/plants/{id}/baseline`: the Energy & Billing contract baseline per day (modelled).
 * `source` = "report" (the figure billed against on a report day), "model" (the month's expected
 * row), null = none. Totals are null unless every day has a figure. */
export interface PwaPlantBaseline {
  site: PwaMeterSite;
  window: { start: string; end: string };
  days: Array<{ day: string; contract_kwh: number | null; pvsyst_kwh: number | null; source: "report" | "model" | null }>;
  contract_kwh: number | null;
  pvsyst_kwh: number | null;
  missing_days: number;
  labels: Record<string, string>;
}

/** one day sheet of an uploaded daily report, as the import preview judged it */
export interface PwaImportSheet {
  /** `file::sheet`, the key for a day override or "skip" */
  key: string;
  file: string;
  sheet: string | null;
  day: string | null;
  day_source: "title" | "sheet name" | "set by you" | null;
  skipped: boolean;
  rows: number;
  matched: number;
  unmatched: Array<{ row: number; name: string; comp_id: number | null; meter_no: string | null; reason: string }>;
  new: number;
  changed: number;
  unchanged: number;
  /** rows of days before the phase's contract start: counted, never stored */
  before_start: number;
  errors: string[];
  warnings: string[];
}

export interface PwaImportResult {
  /** no problem in any included sheet: a commit would store everything */
  ok: boolean;
  committed: boolean;
  sheets: PwaImportSheet[];
  totals: { rows: number; matched: number; new: number; changed: number; unchanged: number; before_start: number; unmatched: number };
  days: { first: string | null; last: string | null };
  /** months with no expected energy: those days get no contract / PVsyst figure */
  months_without_expected: string[];
  meter_numbers_learned: number;
}

/** `/pwa/meter/billing`: billed meter energy per site and calendar month at the book price, the
 * contract's energy (modelled), the shortfall against it and the engineering causes that explain it.
 * Outage, under-performance and meter gap are what O&M can win back (`recoverable_*`); curtailment
 * is PM's (PWA's own load). Causes and recoverable values are estimated; a month's causes are judged
 * on that month alone. Missing values are null. */
export type PwaBillingCause = "outage" | "under" | "meter_gap" | "curtailment";

interface PwaBillingFigures {
  site_id: string;
  phase: number;
  name: string;
  region: string | null;
  kwp: number | null;
  growatt_plant_id: number | null;
  meter_days: number;
  /** days from the site's first report day with no billed reading */
  missing_days: number;
  outage_days: number;
  billed_kwh: number | null;
  /** billed kWh × the contract's book price */
  billed_thb: number | null;
  /** modelled */
  contract_kwh: number | null;
  vs_contract_pct: number | null;
  /** contract − meter on the days with a contract figure (modelled); negative = above contract */
  shortfall_kwh: number | null;
  shortfall_thb: number | null;
  outage_kwh: number | null;
  under_kwh: number | null;
  meter_gap_kwh: number | null;
  curtailment_kwh: number | null;
  recoverable_kwh: number | null;
  recoverable_thb: number | null;
  /** shortfall the causes don't explain (weather against the model, …); may be negative */
  unexplained_kwh: number | null;
}

export interface PwaBillingRow extends PwaBillingFigures {
  /** YYYY-MM */
  month: string;
  start: string;
  end: string;
  /** report days in the month */
  days: number;
  curtailment_note_days: number;
}

export interface PwaBillingSite extends PwaBillingFigures {
  months: number;
  /** cause with the most energy (curtailment included) */
  top_cause: PwaBillingCause | null;
  /** recoverable cause with the most energy: what to act on */
  action_cause: PwaBillingCause | null;
  owner: string | null;
  action: string | null;
  /** 1 = the most recoverable baht */
  rank: number;
}

export interface PwaBilling {
  window: { start: string | null; end: string | null };
  months: string[];
  rows: PwaBillingRow[];
  sites: PwaBillingSite[];
  price_thb_per_kwh: number;
  recoverable_causes: PwaBillingCause[];
  cause_owner: Record<PwaBillingCause, string>;
  cause_action: Record<PwaBillingCause, string>;
  labels: Record<string, string>;
}

/** `/pwa/meter/coverage`: the report days the user can see; `report_month` = the last month the report
 * covers to its end (else the month of the last day), the month Engineering O&M opens on */
export interface PwaMeterCoverage {
  first_day: string | null;
  last_day: string | null;
  report_month: string | null;
}

/** `/pwa/meter/plants/{id}/billing` (plant tab Energy & Billing): the fleet page's billing, outages and
 * meter check narrowed to the plant's report site(s), plus its Site log spend per month (entered).
 * Default window = the site's report month; `billing` is null when the site has no report day yet. */
export interface PwaPlantBilling {
  sites: PwaMeterSite[];
  coverage: PwaMeterCoverage;
  window: { start: string | null; end: string | null };
  billing: PwaBilling | null;
  outages: PwaOutageEvent[];
  meter_check: PwaMeterCheck[];
  spend_by_month: OmCenterSpendMonth[];
  labels?: Record<string, string>;
}
