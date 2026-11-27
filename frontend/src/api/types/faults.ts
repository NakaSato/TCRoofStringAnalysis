/** Field faults (`/faults*`): the defect register, one physical or service problem on one plant,
 * recorded by a person. DB only; dates, serials and positions as entered or scanned; restore time
 * is computed from the fault's own timestamps. No money here. docs/plans/defects.md */

import type { InputMethod } from "./scan";

export type FaultKind =
  | "inverter"
  | "pv_module"
  | "optimizer"
  | "rsd"
  | "datalogger"
  | "router_4g"
  | "revenue_meter"
  | "grid_meter"
  | "weather_station"
  | "pqm"
  | "shinemaster"
  | "dc_bos"
  | "ac_bos"
  | "structure"
  | "service"
  | "other";

export type FaultSubKind = "vpn" | "sim" | "config" | "other";
export type FaultSeverity = "S1" | "S2" | "S3" | "S4";
export type FaultHowFound = "alarm" | "issue" | "device_check" | "site_visit" | "client_report" | "ir_flight" | "iv_sweep" | "other";
export type FaultCause =
  | "lightning"
  | "storm_wind"
  | "flood"
  | "fire"
  | "theft"
  | "animal"
  | "manufacturing_defect"
  | "degradation"
  | "installation"
  | "unknown"
  | "other"
  | "config"
  | "carrier";
export type FaultDecisionKind = "repair_on_site" | "replace" | "claim" | "remote_fix" | "monitor" | "no_action";
export type FaultWaitingReason = "part" | "claim" | "supplier" | "access" | "carrier" | "other";
export type FaultStatus = "open" | "diagnosed" | "waiting" | "scheduled" | "monitor" | "restored" | "no_action" | "closed" | "cancelled";
export type FaultTab = "open" | "restored" | "closed" | "all";
export type FaultLinkKind = "issue" | "alarm" | "device_check" | "claim" | "failed_unit" | "stock_batch" | "site_event" | "om_task" | "kb";
/** how the serial got in: from the picked device's register, or typed / scanned */
export type FaultSerialInput = InputMethod | "register";

export interface FaultPosition {
  mppt?: number;
  string_no?: number;
  module_no?: number;
  location?: string;
}

export interface FaultOwner {
  id: number;
  username: string | null;
  full_name: string | null;
}

/** One fault as listed (`services/faults.serialize` + `links` counts per kind). Times are plant-local ISO with offset. */
export interface Fault {
  id: number;
  /** DF-YYYY-NNNN */
  no: string;
  plant_id: number;
  plant_name: string | null;
  kind: FaultKind;
  sub_kind: FaultSubKind | null;
  inverter_sn: string | null;
  site_device_id: number | null;
  meter: { datalogger_sn: string; address: number } | null;
  stock_unit_id: number | null;
  /** the picked device as the register names it; null = no device picked */
  device_label: string | null;
  position: FaultPosition | null;
  serial: string | null;
  serial_input: FaultSerialInput | null;
  serial_raw: string | null;
  symptom: string;
  how_found: FaultHowFound;
  found_at: string | null;
  found_by: string | null;
  severity: FaultSeverity;
  cause: FaultCause | null;
  status: FaultStatus;
  /** open / diagnosed / waiting / scheduled / monitor */
  active: boolean;
  waiting_reason: FaultWaitingReason | null;
  /** whose move it is; null = nobody's (monitor, done) */
  waiting_on: "us" | "them" | null;
  decision: FaultDecisionKind | null;
  decision_reason: string | null;
  owner: FaultOwner | null;
  next_action_day: string | null;
  /** only past an entered next action day (no assumed response time) */
  followup_overdue: boolean;
  age_days: number | null;
  restored_at: string | null;
  /** restored − found, computed; null until restored */
  restore_hours: number | null;
  closed_at: string | null;
  closed_by: string | null;
  close_note: string | null;
  evidence_urls: string[];
  /** carrier ticket / config version */
  reference: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** linked records per kind (shadow issues left out for engineers) */
  links: Partial<Record<FaultLinkKind, number>>;
}

export interface FaultLink {
  id: number;
  kind: FaultLinkKind;
  ref_id: number | null;
  ref_key: string | null;
  /** resolved label; null when the record is gone */
  label: string | null;
  created_by: string | null;
  created_at: string | null;
}

export type FaultEventKind = "created" | "edit" | "status" | "decision" | "severity" | "note" | "link" | "unlink";

export interface FaultEvent {
  id: number;
  at: string | null;
  by: string | null;
  kind: FaultEventKind;
  from: string | null;
  to: string | null;
  text: string | null;
}

export interface FaultDetail extends Fault {
  link_list: FaultLink[];
  /** newest first */
  events: FaultEvent[];
}

/** counts every visible fault (of `plant_id` when given), not only the filtered ones */
export interface FaultSummary {
  open: number;
  s1_open: number;
  waiting_us: number;
  waiting_them: number;
  followup_overdue: number;
  restored: number;
}

export interface FaultList {
  faults: Fault[];
  /** rows matching the filters (the page holds at most `limit`) */
  total: number;
  summary: FaultSummary;
  meta: { source: "db"; today: string };
}

export interface FaultQuery {
  tab?: FaultTab;
  /** one or more statuses (overrides tab) */
  status?: FaultStatus[];
  kind?: FaultKind;
  severity?: FaultSeverity;
  plant_id?: number;
  waiting?: "us" | "them";
  overdue?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface FaultLinkBody {
  kind: FaultLinkKind;
  ref_id?: number | null;
  ref_key?: string | null;
}

export interface FaultCreateBody {
  plant_id: number;
  kind: FaultKind;
  sub_kind?: FaultSubKind | null;
  severity: FaultSeverity;
  how_found: FaultHowFound;
  symptom: string;
  cause?: FaultCause | null;
  /** naive = plant-local; never in the future */
  found_at?: string | null;
  found_by?: string | null;
  /** at most one of inverter_sn / site_device_id / meter / stock_unit_id */
  inverter_sn?: string | null;
  site_device_id?: number | null;
  meter?: { datalogger_sn: string; address: number } | null;
  stock_unit_id?: number | null;
  position?: FaultPosition | null;
  /** typed / scanned; a picked device's register serial wins */
  serial?: string | null;
  serial_input?: InputMethod | null;
  serial_raw?: string | null;
  owner_user_id?: number | null;
  next_action_day?: string | null;
  evidence_urls?: string[];
  reference?: string | null;
  links?: FaultLinkBody[];
  allow_duplicate?: boolean;
}

/** only the fields sent change; null clears an optional one */
export interface FaultPatchBody {
  symptom?: string;
  cause?: FaultCause | null;
  severity?: FaultSeverity;
  owner_user_id?: number | null;
  next_action_day?: string | null;
  evidence_urls?: string[];
  reference?: string | null;
  position?: FaultPosition | null;
  sub_kind?: FaultSubKind;
  found_at?: string;
}

export interface FaultStatusBody {
  status: FaultStatus;
  /** required for `waiting` */
  waiting_reason?: FaultWaitingReason | null;
  /** `restored`: default now; not in the future, not before found_at */
  restored_at?: string | null;
  /** required to close from monitor / no_action */
  note?: string | null;
}

export interface FaultDecisionBody {
  decision: FaultDecisionKind;
  reason: string;
}

/** 409 detail of a create on a device that already has an active fault of that kind */
export interface FaultDuplicateDetail {
  message: string;
  fault_id: number;
  no: string;
}
