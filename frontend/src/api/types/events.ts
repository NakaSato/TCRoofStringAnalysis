/** API types: site events (`/growatt/plants/{id}/events`, `/growatt/events`): work done on a plant. DB only. */

export type SiteEventType =
  | "cleaning"
  | "repair"
  | "module_replaced"
  | "inverter_replaced"
  | "ir_flight"
  | "pm_inspection"
  | "inverter_service"
  | "site_visit"
  | "curtailment"
  | "other";

export interface SiteEvent {
  id: number;
  plant_id: number;
  plant_name: string | null;
  event_type: SiteEventType;
  label: string;
  /** plant-local date of the work (start when it took several days) */
  day: string;
  end_day: string | null;
  device_sn: string | null;
  inverter_name: string | null;
  string_no: number | null;
  /** what was paid; null = not entered */
  cost_thb: number | null;
  issue_id: number | null;
  /** the linked decision-rule issue (null when not linked, or not visible to the user) */
  issue: { id: number; rule: string; status: string; string_no: number | null; device_sn: string | null } | null;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SiteEventList {
  plant_id?: number;
  total: number;
  summary: { by_type: Partial<Record<SiteEventType, number>>; cost_thb: number | null; costed: number };
  events: SiteEvent[];
  types: Array<{ value: SiteEventType; label: string }>;
  meta: { source: "db" };
}

export interface SiteEventBody {
  event_type: SiteEventType;
  day: string;
  end_day?: string | null;
  device_sn?: string | null;
  string_no?: number | null;
  cost_thb?: number | null;
  issue_id?: number | null;
  /** resolve the linked issue (feedback confirmed) */
  close_issue?: boolean;
  note?: string | null;
}

export interface SiteEventQuery {
  type?: SiteEventType;
  sn?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** One recorded cleaning measured on the plant's EPI (`/growatt/plants/{id}/soiling`, DB only). */
export interface CleaningStep {
  event_id: number;
  day: string;
  end_day: string | null;
  /** inverter = only part of the plant was cleaned: the plant EPI step is diluted */
  scope: "plant" | "inverter";
  device_sn: string | null;
  cost_thb: number | null;
  status: "measured" | "waiting" | "too_few_days" | "no_epi";
  reason: string | null;
  before_days: string[];
  after_days: string[];
  /** median EPI (measured ÷ modelled) of the good days */
  epi_before: number | null;
  epi_after: number | null;
  step_pct: number | null;
  recovered_epi: number | null;
  /** heavy rain (Google, modelled) between the compared days: it washed the array too */
  rain_between: Array<{ day: string; rain_mm: number | null }>;
  /** estimated: the step spread over the days since the last cleaning or heavy rain */
  soiling_rate_pct_per_day: number | null;
  rate_reason: string | null;
  rate_since?: string;
  rate_days?: number;
}

export interface R13Verdict {
  day: string;
  fires: boolean;
  rain_day: string;
  rain_mm: number | null;
  epi_before: number;
  epi_after: number;
  epi_clean: number;
  clean_basis: "cleaning" | "epi_fit";
  clean_day: string | null;
  recovery_pct: number;
  before_days: number;
  after_days: number;
}

/** R12 soiling wallet on the plant's newest stored day: THB lost to dirt since the last plant-wide
 * cleaning or heavy rain (estimated), against the entered cleaning cost. */
export interface SoilingWallet {
  day: string;
  status: "ok" | "no_rate" | "no_reset" | "rain_unknown";
  reason: string | null;
  reset_day: string | null;
  reset_by: "cleaning" | "rain" | null;
  days_since_reset: number | null;
  /** estimated, %/day: the plant's own measured rate, else the fleet median */
  rate_pct_per_day: number | null;
  rate_basis: "plant" | "fleet" | null;
  soiling_pct: number | null;
  wallet_thb: number | null;
  wallet_kwh: number | null;
  day_lost_kwh: number | null;
  day_thb: number | null;
  days_without_energy: number;
  /** entered: the plant's planning cost, else the median cost on its Site log cleanings */
  cost_thb: number | null;
  cost_basis: "plant_setting" | "site_log" | null;
  monsoon: boolean;
  optimal_interval_days: number | null;
  fires: boolean;
}

export interface PlantSoiling {
  plant_id: number;
  has_epi: boolean;
  epi_fitted: boolean;
  /** newest first */
  cleanings: CleaningStep[];
  summary: { cleanings: number; measured: number; median_step_pct: number | null; median_soiling_rate_pct_per_day: number | null };
  /** null = not judged (or a shadow rule, for engineers) */
  r13: R13Verdict | null;
  r13_day: string | null;
  r13_rule: { enabled: boolean; shadow: boolean };
  /** null = no daily row yet (or a shadow rule, for engineers) */
  wallet: SoilingWallet | null;
  r12_rule: { enabled: boolean; shadow: boolean };
  monsoon: string[];
  days: Array<{ day: string; epi: number | null; good: boolean; rain_mm: number | null }>;
  settings: Record<string, number>;
  meta: { source: "db" };
}
