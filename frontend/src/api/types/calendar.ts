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
