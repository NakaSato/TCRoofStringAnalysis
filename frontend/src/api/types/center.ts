/** Engineering O&M (`/growatt/center`, docs/plans/om-center-dashboard.md). Lost kWh and baht are
 * estimates with each kWh counted once across overlapping rules; costs are entered by the team. */
import type { Issue, IssueTier } from "./issues";

export type LossFamily = "down" | "strings" | "conversion" | "underyield" | "plant" | "data_gap";

export interface OmCenterMoney {
  losing_now_thb_per_day_est: number | null;
  active_issues: number;
  safety_issues: number;
  by_tier: Partial<Record<IssueTier, number>>;
  lost_kwh_est: number | null;
  lost_thb_est: number | null;
  /** lost ÷ (produced + lost), in kWh */
  loss_share_pct: number | null;
  /** measured: the inverters' day energy summed over the window */
  produced_kwh: number | null;
  /** inverter minutes not in fault / off / standby ÷ daylight minutes with data */
  availability_pct: number | null;
  limited_min: number;
  spend_thb: number | null;
  spend_events: number;
  spend_events_priced: number;
  committed_thb: number | null;
  committed_tasks: number;
  committed_tasks_priced: number;
}

export type OmCenterIssue = Omit<Issue, "daily" | "evidence"> & {
  age_days: number;
  next_visit: string | null;
  days_to_visit: number | null;
  cost_of_waiting_thb_est: number | null;
};

export interface OmCenterPlant {
  plant_id: number;
  name: string;
  capacity_kwp: number | null;
  energy_kwh: number | null;
  lost_kwh_est: number | null;
  lost_thb_est: number | null;
  loss_share_pct: number | null;
  thb_per_day_est: number | null;
  active_issues: number;
  epi_median: number | null;
  pr_temp_corrected_median_pct: number | null;
  availability_pct: number | null;
  days_since_cleaning: number | null;
  next_visit: string | null;
  spend_thb: number | null;
}

export interface OmCenterSpendMonth {
  plant_id: number;
  /** YYYY-MM */
  month: string;
  event_type: string;
  spend_thb: number | null;
  events: number;
  events_priced: number;
}

export interface OmCenter {
  window: { start: string; end: string; days: number; today: string };
  scope: "fleet" | "assigned";
  plant_count: number;
  money: OmCenterMoney;
  loss_by_cause: {
    families: Array<{ key: LossFamily; label: string; rules: string[] }>;
    days: Array<{ day: string; family: LossFamily; kwh_est: number | null; thb_est: number | null }>;
    totals: Array<{ family: LossFamily; kwh_est: number | null; thb_est: number | null }>;
  };
  issues: { total: number; top: OmCenterIssue[] };
  plants: OmCenterPlant[];
  /** Site log costs per plant, calendar month and event type in the window (entered; `spend_thb`
   * null = none of those events has a cost, never 0) */
  spend_by_month: OmCenterSpendMonth[];
  /** admins: active issues of rules still in shadow mode that are not counted; null = not applicable */
  shadow_hidden: number | null;
  include_shadow: boolean;
  meta: { source: "db"; estimated: string[]; modelled: string[]; entered: string[]; tariff_source: "default" | "saved"; plant_rates: number };
}
