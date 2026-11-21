/** Decision rules and the Issues queue (docs/plans/decision-rules.md). kWh and baht are estimates. */

export type IssueTier = "P1" | "P2" | "P3" | "P4" | "Info";
export type IssueStatus = "open" | "acknowledged" | "resolved" | "dismissed";
export type IssueStatusFilter = "active" | "open" | "acknowledged" | "resolved" | "dismissed" | "closed" | "all";
export type IssueFeedback = "confirmed" | "false_alarm";
export type IssueActionName = "acknowledge" | "resolve" | "dismiss" | "reopen" | "note";

export interface Issue {
  id: number;
  plant_id: number;
  plant_name: string | null;
  device_sn: string | null;
  inverter_name: string | null;
  string_no: number | null;
  rule: string;
  name: string;
  tier: IssueTier;
  safety: boolean;
  parent_id: number | null;
  opened_day: string;
  last_seen_day: string;
  days_seen: number;
  /** mean of the last 3 days it fired (estimated) */
  lost_kwh_est: number | null;
  thb_per_day_est: number | null;
  lost_kwh_total_est: number | null;
  thb_total_est: number | null;
  evidence: Record<string, unknown>;
  /** each day it fired: { "YYYY-MM-DD": { kwh, thb } } */
  daily: Record<string, { kwh: number | null; thb: number | null }>;
  status: IssueStatus;
  ack_by: string | null;
  ack_at: string | null;
  note: string | null;
  feedback: IssueFeedback | null;
  shadow: boolean;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: "auto" | "resolved" | "dismissed" | null;
}

export interface IssueSummary {
  active: number;
  safety: number;
  by_tier: Partial<Record<IssueTier, number>>;
  by_rule: Record<string, number>;
  thb_per_day_est: number | null;
}

export interface IssueList {
  summary: IssueSummary;
  total: number;
  issues: Issue[];
  meta: { source: "db"; estimated: string[] };
}

export interface IssueQuery {
  plant_id?: number;
  status?: IssueStatusFilter;
  tier?: IssueTier;
  rule?: string;
  /** admin only: true = shadow issues */
  shadow?: boolean;
  /** admin only: live and shadow issues together */
  include_shadow?: boolean;
}

export interface IssueActionBody {
  action: IssueActionName;
  note?: string | null;
  feedback?: IssueFeedback | null;
}

/** Each visible plant's THB/kWh for a day (`/growatt/tariff/rates`): flat plant rate, else TOU
 * weighted by the on-peak share of its stored power; no power yet = off-peak. An estimate. */
export interface TariffRates {
  day: string;
  plants: Record<string, { thb_per_kwh: number; on_peak_share: number | null; basis: "plant_rate" | "tou" | "off_peak_unknown_split" }>;
  meta: { source: "db"; estimated: boolean };
}

export interface StringRuleDay {
  day: string;
  gated_slots: number;
  ratio_median: number | null;
  low_min: number | null;
  severe_min: number | null;
  open_min: number;
  v_ratio_median: number | null;
  voltage_sensing?: "per_string" | "shared_mppt" | null;
  energy_kwh: number | null;
  lost_kwh_est: number | null;
}

/** One inverter-day of `growatt_inverter_daily` (minutes over sunrise+30 min … sunset−30 min;
 * lost kWh are estimates; `yf_vs_median_pct` null = no comparison with the plant's other inverters). */
export interface InverterRuleDay {
  day: string;
  daylight_min: number | null;
  producing_min: number;
  fault_min: number;
  off_min: number;
  standby_min: number;
  limited_min: number;
  no_data_min: number;
  energy_kwh: number | null;
  dc_energy_kwh: number | null;
  kwp: number | null;
  ya_kwh_kwp: number | null;
  yf_kwh_kwp: number | null;
  ya_minus_yf: number | null;
  yf_vs_median_pct: number | null;
  plant_kwp_share_pct: number | null;
  lost_fault_kwh_est: number | null;
  lost_off_kwh_est: number | null;
  lost_standby_kwh_est: number | null;
  lost_no_data_kwh_est: number | null;
}

export interface RuleDaily<T = StringRuleDay | Record<string, number | string | null>> {
  plant_id: number;
  device_sn: string;
  string_no: number | null;
  start: string;
  end: string;
  days: T[];
}
