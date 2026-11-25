/** Engineering O&M (`/growatt/center`, docs/plans/om-center-dashboard.md). Lost kWh and baht are
 * estimates with each kWh counted once across overlapping rules; costs are entered by the team. */
import type { ClaimStatus } from "./claims";
import type { Issue, IssueTier } from "./issues";

export type LossFamily = "down" | "strings" | "conversion" | "underyield" | "soiling" | "plant" | "data_gap";

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
  /** claims linked to the issue (`claim_links`), newest first */
  claims: OmCenterLinkedClaim[];
};

export interface OmCenterLinkedClaim {
  id: number;
  number: string;
  status: ClaimStatus;
  open: boolean;
}

/** This week's (Mon … Sun of today) Calendar tasks on the plants in scope; counts only */
export interface OmCenterWork {
  week: { start: string; end: string };
  tasks: { total: number; by_status: Record<"planned" | "in_progress" | "done" | "skipped" | "cancelled", number>; open: number; overdue: number };
  /** of this week's tasks, those a recurring plan generated (cancelled left out) */
  from_plans: { total: number; done: number; open: number; overdue: number };
  active_plans: number;
  /** every planned / started task whose end day is past, any week */
  overdue_all: number;
  overdue_oldest_days: number | null;
}

/** Response to the issues first seen in the window, per tier, in whole days (issues are dated by
 * day). Medians are over the issues that had the event; null = none had it. */
export interface OmCenterResponseTier {
  tier: IssueTier;
  /** P1 0 (same day), P2 2; null = no target */
  target_days: number | null;
  opened: number;
  acknowledged: number;
  ack_median_days: number | null;
  /** resolved or dismissed by a person (auto-closed counted apart) */
  closed_by_team: number;
  close_median_days: number | null;
  auto_closed: number;
  /** acknowledged or closed by a person: the earlier of the two */
  responded: number;
  first_response_median_days: number | null;
  within_target: number | null;
  /** still open and nobody has acted */
  waiting: number;
  waiting_oldest_days: number | null;
}

export interface OmCenterClaims {
  open: number;
  by_status: Partial<Record<ClaimStatus, number>>;
  waiting_us: number;
  waiting_them: number;
  followup_overdue: number;
  /** age from the day submitted, else created */
  oldest: { id: number; number: string; status: ClaimStatus; plant_id: number; age_days: number } | null;
}

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
  open_claims: number;
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
  work: OmCenterWork;
  response: { start: string; end: string; tiers: OmCenterResponseTier[]; targets: Record<string, number> };
  claims: OmCenterClaims;
  /** admins: active issues of rules still in shadow mode that are not counted; null = not applicable */
  shadow_hidden: number | null;
  include_shadow: boolean;
  meta: { source: "db"; estimated: string[]; modelled: string[]; entered: string[]; tariff_source: "default" | "saved"; plant_rates: number };
}
