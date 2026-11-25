/** API types: Calendar Team (`/growatt/calendar/*`, `/growatt/plants/{id}/tasks`): planned O&M work. DB only. */

export type OmTaskType =
  | "cleaning"
  | "repair"
  | "module_replaced"
  | "inverter_replaced"
  | "ir_flight"
  | "pm_inspection"
  | "inverter_service"
  | "site_visit"
  | "other";

export type OmTaskStatus = "planned" | "in_progress" | "done" | "skipped" | "cancelled";

export interface OmPerson {
  id: number;
  username: string | null;
  full_name: string;
  role: "admin" | "engineer";
}

export interface OmTeam {
  id: number;
  name: string;
  /** "#rrggbb" or null */
  color: string | null;
  active: boolean;
  members: OmPerson[];
}

export interface OmTask {
  id: number;
  busy: false;
  plant_id: number;
  plant_name: string | null;
  task_type: OmTaskType;
  label: string;
  title: string | null;
  /** plant-local planned days (may be in the future) */
  start_day: string;
  end_day: string;
  /** recurring plans (Phase 2): the occurrence's original day; null = one-off */
  scheduled_day: string | null;
  device_sn: string | null;
  inverter_name: string | null;
  string_no: number | null;
  status: OmTaskStatus;
  /** computed: end_day before today while planned / in progress */
  overdue: boolean;
  team: { id: number; name: string; color: string | null } | null;
  assignees: OmPerson[];
  issue_id: number | null;
  issue: { id: number; rule: string; status: string; string_no: number | null; device_sn: string | null } | null;
  est_cost_thb: number | null;
  note: string | null;
  /** the Site log event written when the task was done */
  site_event_id: number | null;
  plan_id: number | null;
  done_at: string | null;
  done_by: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Someone's work on a plant the viewer can't see: dates and the visible assignees only. */
export interface OmBusyBlock {
  id: null;
  busy: true;
  plant_id: null;
  plant_name: null;
  title: "Busy";
  label: "Busy";
  start_day: string;
  end_day: string;
  assignees: OmPerson[];
}

export interface OmTaskHistoryEntry {
  at: string | null;
  by: string | null;
  /** field → [old, new], or { created: … } */
  change: Record<string, unknown>;
  comment: string | null;
}

export interface OmTaskDetail extends OmTask {
  history: OmTaskHistoryEntry[];
  can_delete: boolean;
}

export interface OmTaskList {
  from: string;
  to: string;
  today: string;
  total: number;
  summary: { by_status: Partial<Record<OmTaskStatus, number>>; overdue: number };
  tasks: OmTask[];
  busy: OmBusyBlock[];
  types: Array<{ value: OmTaskType; label: string }>;
  meta: { source: "db" };
}

export interface OmTaskQuery {
  from: string;
  to: string;
  plant_id?: number;
  type?: OmTaskType;
  status?: OmTaskStatus;
  user_id?: number;
  team_id?: number;
  overdue?: boolean;
}

export interface OmTaskBody {
  task_type: OmTaskType;
  title?: string | null;
  start_day: string;
  end_day?: string | null;
  device_sn?: string | null;
  string_no?: number | null;
  team_id?: number | null;
  assignee_ids?: number[];
  issue_id?: number | null;
  est_cost_thb?: number | null;
  note?: string | null;
}

export type OmTaskPatch = Partial<OmTaskBody> & {
  status?: Exclude<OmTaskStatus, "done">;
  /** goes to the history with the change */
  comment?: string | null;
};

export interface OmTaskDoneBody {
  /** default: planned start, capped at today */
  day?: string | null;
  end_day?: string | null;
  cost_thb?: number | null;
  note?: string | null;
  close_issue?: boolean;
}

export interface OmAssignees {
  users: OmPerson[];
  teams: OmTeam[];
}

export interface OmTeamBody {
  name: string;
  color?: string | null;
  active?: boolean;
  member_ids?: number[];
}

// --------------------------------------------------------------------------- Phase 2: plans, due, rounds

export type OmPlanUnit = "week" | "month";

export interface OmPlan {
  id: number;
  name: string;
  task_type: OmTaskType;
  label: string;
  every_n: number;
  unit: OmPlanUnit;
  /** 1–12; both null = all year; may wrap the year (11 → 4) */
  season_from_month: number | null;
  season_to_month: number | null;
  /** 0 = Monday; null = first working day (Mon–Fri, not a holiday) */
  weekday: number | null;
  duration_days: number;
  team: { id: number; name: string; color: string | null } | null;
  assignees: OmPerson[];
  /** for an engineer: only their plants */
  plant_ids: number[];
  plants: Array<{ plant_id: number; name: string | null }>;
  starts_on: string;
  ends_on: string | null;
  active: boolean;
  note: string | null;
  /** the next (up to 3) days it falls on */
  next_days: string[];
  /** planned tasks of it from today on */
  upcoming_tasks: number;
  created_by: string | null;
  updated_by: string | null;
}

export interface OmPlanPreset {
  key: string;
  name: string;
  task_type: OmTaskType;
  every_n: number;
  unit: OmPlanUnit;
  season_from_month: number | null;
  season_to_month: number | null;
  duration_days: number;
}

export interface OmPlanList {
  plans: OmPlan[];
  presets: OmPlanPreset[];
  horizon_days: number;
}

export interface OmPlanBody {
  name: string;
  task_type: OmTaskType;
  every_n: number;
  unit: OmPlanUnit;
  season_from_month: number | null;
  season_to_month: number | null;
  weekday: number | null;
  duration_days: number;
  default_team_id: number | null;
  assignee_ids: number[];
  plant_ids: number[];
  starts_on: string;
  ends_on: string | null;
  active: boolean;
  note: string | null;
}

export type OmPlanSaved = OmPlan & { result: { created: number; deleted: number; updated: number } };

export interface OmPlantSettings {
  /** as entered; null = not entered */
  cleaning_crew_days: number | null;
  cleaning_cost_thb: number | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface OmDueRow {
  plant_id: number;
  name: string;
  city: string | null;
  phase: number | null;
  /** last Site log day per type (cleaning, pm_inspection, inverter_service, ir_flight) */
  last: Partial<Record<OmTaskType, string>>;
  /** null = no cleaning recorded */
  days_since_cleaning: number | null;
  /** earliest open (planned / started) task per type */
  next: Partial<Record<OmTaskType, string>>;
  next_cleaning: string | null;
  overdue: number;
  month: { total: number; done: number; open: number };
  plans: string[];
  settings: OmPlantSettings;
}

export interface OmDue {
  month: string;
  from: string;
  to: string;
  today: string;
  plants: OmDueRow[];
  summary: { plants: number; never_cleaned: number; cleaning_planned: number; with_overdue: number; month_tasks: number };
  meta: { source: "db" };
}

export interface OmRoundPreviewBody {
  plant_ids: number[];
  start_day: string;
  crews: number;
  include_saturday: boolean;
  group_by: "city" | "phase" | "none";
}

export interface OmRoundItem {
  plant_id: number;
  plant_name: string;
  city: string | null;
  phase: number | null;
  start_day: string;
  end_day: string;
  crew: number;
  crew_days: number;
  /** false = crew-days not entered, counted as 1 */
  duration_set: boolean;
  days_since_cleaning: number | null;
  cost_thb: number | null;
  /** an open cleaning task already planned on the plant (its start day) */
  already_planned: string | null;
}

export interface OmRoundPreview {
  items: OmRoundItem[];
  unscheduled: Array<{ plant_id: number; name: string }>;
  /** left out: one task would span max_task_days or more */
  too_long: Array<{ plant_id: number; name: string }>;
  max_task_days: number;
  start_day: string;
  end_day: string | null;
  crews: number;
  weekdays: number[];
  holidays_skipped: string[];
  /** sum of the entered costs; null when none entered */
  cost_thb: number | null;
  cost_missing: number;
  duration_missing: number;
}

export interface OmRoundSaveBody {
  title: string | null;
  team_id: number | null;
  assignee_ids: number[];
  note: string | null;
  items: Array<{ plant_id: number; start_day: string; end_day: string; crew?: number | null }>;
}

/** The user's read-only calendar subscription (ICS). The secret link is returned only by `newOmFeedLink`. */
export interface OmFeedStatus {
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
  past_days: number;
  ahead_days: number;
}

export interface OmFeedLink extends OmFeedStatus {
  /** e.g. /api/ics/calendar/<secret>.ics, served on the app's own origin */
  path: string;
}

/** Phase 4: why a plant is or is not suggested a cleaning (R12 soiling wallet). */
export type OmSuggestionStatus =
  | "suggested"
  | "below_cost"
  | "no_cost"
  | "monsoon"
  | "no_rate"
  | "no_reset"
  | "rain_unknown"
  | "no_data"
  | "accepted"
  | "dismissed"
  | "planned";

/** One plant's cleaning suggestion. Wallet figures are **estimates**, the cost is entered; null = not known. */
export interface OmCleaningSuggestion {
  plant_id: number;
  plant_name: string | null;
  status: OmSuggestionStatus;
  suggested: boolean;
  reason: string | null;
  /** the stored plant day the wallet is judged on */
  day: string | null;
  wallet_thb: number | null;
  wallet_kwh: number | null;
  cost_thb: number | null;
  /** plant_setting = Calendar → Due; site_log = median cost on its cleanings */
  cost_basis: "plant_setting" | "site_log" | null;
  /** first day the wallet reached the cost (estimate) */
  crossed_day: string | null;
  reset_day: string | null;
  reset_by: "cleaning" | "rain" | null;
  days_since_reset: number | null;
  rate_pct_per_day: number | null;
  rate_basis: "plant" | "fleet" | null;
  soiling_pct: number | null;
  optimal_interval_days: number | null;
  days_without_energy: number | null;
  monsoon: boolean | null;
  /** where the ghost chip sits: the next working day (only while suggested) */
  suggested_day: string | null;
  cleaning_crew_days: number | null;
  open_task: { id: number; start_day: string; status: OmTaskStatus } | null;
  mark: { action: "accepted" | "dismissed"; task_id: number | null; by: string | null; at: string | null } | null;
}

export interface OmCleaningSuggestions {
  today: string;
  rule: { enabled: boolean; shadow: boolean };
  shadow: boolean;
  monsoon_window: string[];
  in_monsoon: boolean;
  /** why nothing is listed for this user: R12 in shadow mode (engineers) or disabled */
  hidden: "r12_shadow" | "r12_disabled" | null;
  suggestions: OmCleaningSuggestion[];
  plants: OmCleaningSuggestion[];
  summary: Partial<Record<OmSuggestionStatus, number>>;
  labels: Record<string, string>;
  meta: { source: "db" };
}

export interface OmSuggestionAcceptBody {
  start_day?: string;
  end_day?: string;
  title?: string;
  team_id?: number | null;
  assignee_ids?: number[];
  note?: string;
}
