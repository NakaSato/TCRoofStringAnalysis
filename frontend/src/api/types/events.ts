/** API types: site events (`/growatt/plants/{id}/events`, `/growatt/events`): work done on a plant. DB only. */

export type SiteEventType =
  | "cleaning"
  | "repair"
  | "module_replaced"
  | "inverter_replaced"
  | "ir_flight"
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
