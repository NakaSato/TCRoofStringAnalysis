/** Claims (`/claims*`): warranty and insurance claims for plant equipment. DB only; every
 * date and serial is as entered. docs/plans/claims.md */

export type ClaimType = "inverter_warranty" | "module_warranty" | "equipment_warranty" | "insurance" | "workmanship";

export type ClaimStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "info_requested"
  | "approved"
  | "rejected"
  | "fulfilled"
  | "closed"
  | "withdrawn";

export type ClaimCause =
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
  | "other";

/** whose move it is; null once closed / withdrawn */
export type ClaimWaiting = "us" | "them";

/** one checklist item; the list per type comes from the backend */
export interface ClaimEvidence {
  key: string;
  label: string;
  required: boolean;
  done: boolean;
  url: string | null;
  note: string | null;
  by: string | null;
  at: string | null;
}

export type ClaimEventKind = "created" | "status" | "note" | "message" | "shipment" | "edit";

export interface ClaimEvent {
  id: number;
  kind: ClaimEventKind;
  /** when it was recorded */
  at: string;
  /** the day it happened (message sent, parcel shipped); null for status / note */
  day: string | null;
  by: string | null;
  from_status: ClaimStatus | null;
  to_status: ClaimStatus | null;
  /** message: out = sent, in = received; shipment: out = to them, in = to us */
  direction: "out" | "in" | null;
  summary: string;
  carrier: string | null;
  tracking_no: string | null;
  sn: string | null;
}

export type ClaimLinkKind = "issue" | "iv_sweep" | "site_log";

export interface ClaimLink {
  id: number;
  kind: ClaimLinkKind;
  ref_id: number;
  label: string | null;
}

export interface Claim {
  id: number;
  /** CL-YYYY-NNN */
  number: string;
  type: ClaimType;
  status: ClaimStatus;
  cause: ClaimCause;
  plant_id: number;
  plant_name: string | null;
  device_sn: string | null;
  string_nos: number[];
  module_serials: string[];
  /** a device that is not an inverter (datalogger, meter, sensor, …) */
  device_label: string | null;
  counterparty: string;
  counterparty_ref: string | null;
  description: string | null;
  incident_day: string | null;
  discovered_day: string | null;
  submitted_day: string | null;
  closed_day: string | null;
  next_action_day: string | null;
  /** next_action_day is past and the claim is still open */
  followup_overdue: boolean;
  waiting_on: ClaimWaiting | null;
  old_sn: string | null;
  new_sn: string | null;
  /** as entered on the claim; never looked up or assumed */
  warranty_end_day: string | null;
  evidence_done: number;
  evidence_required: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ClaimDetail extends Claim {
  events: ClaimEvent[];
  evidence: ClaimEvidence[];
  links: ClaimLink[];
}

export interface ClaimList {
  claims: Claim[];
  summary: {
    open: number;
    waiting_us: number;
    waiting_them: number;
    followup_overdue: number;
  };
  meta: { source: "db"; today: string };
}

export interface ClaimBody {
  type: ClaimType;
  cause: ClaimCause;
  plant_id: number;
  device_sn: string | null;
  string_nos: number[];
  module_serials: string[];
  device_label: string | null;
  counterparty: string;
  counterparty_ref: string | null;
  description: string | null;
  incident_day: string | null;
  discovered_day: string | null;
  warranty_end_day: string | null;
  /** create only: records to link at once */
  links?: ClaimLinkBody[];
}

export interface ClaimStatusBody {
  status: ClaimStatus;
  note: string;
  next_action_day?: string | null;
  /** inverter swap on fulfilled */
  new_sn?: string | null;
}

export interface ClaimEventBody {
  kind: "note" | "message" | "shipment";
  day: string | null;
  direction?: "out" | "in" | null;
  summary: string;
  carrier?: string | null;
  tracking_no?: string | null;
  sn?: string | null;
}

export interface ClaimEvidenceBody {
  done: boolean;
  url?: string | null;
  note?: string | null;
}

export interface ClaimLinkBody {
  kind: ClaimLinkKind;
  ref_id: number;
}
