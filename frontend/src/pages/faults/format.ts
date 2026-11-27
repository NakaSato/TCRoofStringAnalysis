/** Field faults: labels, badges, the allowed status changes (mirror of `TRANSITIONS` in backend
 * `services/faults.py`; the backend checks them too, 409), what each change needs, and links into
 * the app. Display labels are English; components pass them through `t()`. docs/plans/defects.md */
import type {
  Fault,
  FaultCause,
  FaultDecisionKind,
  FaultHowFound,
  FaultKind,
  FaultLink,
  FaultLinkKind,
  FaultPosition,
  FaultSeverity,
  FaultStatus,
  FaultSubKind,
  FaultWaitingReason,
} from "../../api/client";
import { plantPath } from "../../context/routes";

export { daysBetween, downloadCsv, fmtDay, relDays } from "../tools/format";

type BadgeVariant = "ok" | "warn" | "crit" | "info" | "neutral";

export const KIND: Record<FaultKind, string> = {
  inverter: "Inverter",
  pv_module: "PV module",
  optimizer: "Optimizer",
  rsd: "RSD",
  datalogger: "Data logger",
  router_4g: "Router 4G",
  revenue_meter: "Revenue meter",
  grid_meter: "Grid meter",
  weather_station: "Weather station",
  pqm: "PQM",
  shinemaster: "ShineMaster",
  dc_bos: "DC BOS",
  ac_bos: "AC BOS",
  structure: "Structure",
  service: "Service (VPN / SIM / config)",
  other: "Other",
};
export const KIND_KEYS = Object.keys(KIND) as FaultKind[];

export const SUB_KIND: Record<FaultSubKind, string> = { vpn: "VPN tunnel", sim: "SIM", config: "Router / APN config", other: "Other" };
export const SUB_KIND_KEYS = Object.keys(SUB_KIND) as FaultSubKind[];

export const SEVERITY: Record<FaultSeverity, { label: string; hint: string; variant: BadgeVariant }> = {
  S1: { label: "S1 Safety", hint: "Exposed live parts, burnt connector, broken glass on a walkway", variant: "crit" },
  S2: { label: "S2 Generation", hint: "Generation or revenue affected", variant: "warn" },
  S3: { label: "S3 Data", hint: "Data / monitoring only", variant: "info" },
  S4: { label: "S4 Minor", hint: "Minor", variant: "neutral" },
};
export const SEVERITY_KEYS = Object.keys(SEVERITY) as FaultSeverity[];

export const STATUS: Record<FaultStatus, { label: string; variant: BadgeVariant }> = {
  open: { label: "Open", variant: "warn" },
  diagnosed: { label: "Diagnosed", variant: "warn" },
  waiting: { label: "Waiting", variant: "info" },
  scheduled: { label: "Scheduled", variant: "info" },
  monitor: { label: "Monitor", variant: "neutral" },
  restored: { label: "Restored", variant: "ok" },
  no_action: { label: "No action", variant: "neutral" },
  closed: { label: "Closed", variant: "neutral" },
  cancelled: { label: "Cancelled", variant: "neutral" },
};
export const STATUS_KEYS = Object.keys(STATUS) as FaultStatus[];
/** still needs work (the backend's ACTIVE) */
export const ACTIVE: readonly FaultStatus[] = ["open", "diagnosed", "waiting", "scheduled", "monitor"];
export const isActive = (s: FaultStatus) => ACTIVE.includes(s);

/** allowed next statuses: the same table as backend `services/faults.TRANSITIONS` */
export const TRANSITIONS: Record<FaultStatus, readonly FaultStatus[]> = {
  open: ["diagnosed", "waiting", "scheduled", "monitor", "restored", "no_action", "cancelled"],
  diagnosed: ["waiting", "scheduled", "monitor", "restored", "no_action", "cancelled"],
  waiting: ["diagnosed", "scheduled", "monitor", "restored", "cancelled"],
  scheduled: ["diagnosed", "waiting", "restored", "cancelled"],
  monitor: ["diagnosed", "waiting", "scheduled", "restored", "closed", "cancelled"],
  restored: ["closed", "open"],
  no_action: ["closed", "open"],
  closed: ["open"],
  cancelled: ["open"],
};

/** the statuses a fault can be moved to from the status dialog: the table, plus `waiting` again
 * from `waiting` (a new reason; the backend accepts it when the reason changes) */
export const nextStatuses = (from: FaultStatus): FaultStatus[] => [...TRANSITIONS[from], ...(from === "waiting" ? (["waiting"] as const) : [])];

export const canMove = (from: FaultStatus, to: FaultStatus) => nextStatuses(from).includes(to);

/** what the button / option says for each next status */
export const TRANSITION_LABEL: Record<FaultStatus, string> = {
  open: "Reopen",
  diagnosed: "Diagnosed",
  waiting: "Waiting for…",
  scheduled: "Visit scheduled",
  monitor: "Monitor",
  restored: "Restored (working again)",
  no_action: "No action needed",
  closed: "Close",
  cancelled: "Cancel (recorded in error / duplicate)",
};

/** what the status change needs, as the backend checks it (`set_status`) */
export function statusNeeds(from: FaultStatus, to: FaultStatus): { reason: boolean; restoredAt: boolean; note: boolean } {
  return {
    reason: to === "waiting",
    restoredAt: to === "restored",
    // closing from monitor / no_action needs a note; a cancel gets one so the timeline says why (plan §4)
    note: (to === "closed" && (from === "monitor" || from === "no_action")) || to === "cancelled",
  };
}

export const WAITING_REASON: Record<FaultWaitingReason, string> = {
  part: "Part (no spare on hand)",
  claim: "Claim (manufacturer)",
  supplier: "Supplier (unit away for repair)",
  access: "Site access / permit",
  carrier: "Carrier (SIM / network ticket)",
  other: "Other",
};
export const WAITING_REASON_KEYS = Object.keys(WAITING_REASON) as FaultWaitingReason[];
/** short form for the table */
export const WAITING_SHORT: Record<FaultWaitingReason, string> = { part: "part", claim: "claim", supplier: "supplier", access: "access", carrier: "carrier", other: "other" };

export const DECISION: Record<FaultDecisionKind, string> = {
  repair_on_site: "Repair on site",
  replace: "Replace",
  claim: "Claim",
  remote_fix: "Remote fix",
  monitor: "Monitor",
  no_action: "No action",
};
/** remote_fix is for service faults only (the backend refuses it otherwise) */
export const decisionsFor = (kind: FaultKind): FaultDecisionKind[] =>
  (Object.keys(DECISION) as FaultDecisionKind[]).filter((d) => d !== "remote_fix" || kind === "service");
/** a closed / cancelled fault takes no decision (reopen it first) */
export const canDecide = (s: FaultStatus) => s !== "closed" && s !== "cancelled";

export const HOW_FOUND: Record<FaultHowFound, string> = {
  alarm: "Alarm",
  issue: "Issue",
  device_check: "Device check",
  site_visit: "Site visit",
  client_report: "Client report",
  ir_flight: "IR flight",
  iv_sweep: "I-V sweep",
  other: "Other",
};
export const HOW_FOUND_KEYS = Object.keys(HOW_FOUND) as FaultHowFound[];

export const CAUSE: Record<FaultCause, string> = {
  lightning: "Lightning",
  storm_wind: "Storm / wind",
  flood: "Flood",
  fire: "Fire",
  theft: "Theft",
  animal: "Animal",
  manufacturing_defect: "Manufacturing defect",
  degradation: "Degradation",
  installation: "Installation",
  unknown: "Unknown",
  other: "Other",
  config: "Configuration",
  carrier: "Carrier / network",
};
export const CAUSE_KEYS = Object.keys(CAUSE) as FaultCause[];

export const LINK_KIND: Record<FaultLinkKind, string> = {
  issue: "Issue",
  alarm: "Alarm",
  device_check: "Device check",
  claim: "Claim",
  failed_unit: "Failed unit",
  stock_batch: "Replacement",
  site_event: "Site log entry",
  om_task: "Calendar task",
  kb: "Knowledge Base",
};

/** kinds that are told apart by where they sit on an inverter (MPPT, string, module no.) */
export const POSITION_KINDS: readonly FaultKind[] = ["pv_module", "optimizer", "rsd"];
/** kinds identified by a place in words (combiner, panel, feeder, …) */
export const LOCATION_KINDS: readonly FaultKind[] = ["pv_module", "optimizer", "rsd", "dc_bos", "ac_bos", "structure", "other"];

/** which device picker fits a kind first (the person can pick another) */
export type DeviceSource = "none" | "inverter" | "site" | "meter" | "serial";
export const defaultSource = (kind: FaultKind): DeviceSource => {
  switch (kind) {
    case "inverter":
    case "pv_module":
    case "optimizer":
    case "rsd":
      return "inverter";
    case "datalogger":
    case "router_4g":
    case "revenue_meter":
    case "weather_station":
    case "pqm":
    case "shinemaster":
    case "service":
      return "site";
    case "grid_meter":
      return "meter";
    default:
      return "none";
  }
};

/** "MPPT 2 · PV3 · module 12 · east roof"; null when there is no position */
export function positionText(p: FaultPosition | null | undefined): string | null {
  if (!p) return null;
  const parts = [p.mppt != null ? `MPPT ${p.mppt}` : null, p.string_no != null ? `PV${p.string_no}` : null, p.module_no != null ? `M${p.module_no}` : null, p.location || null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** the device in one line: the register's label, else the serial; "—" when nothing was given */
export function deviceText(f: Pick<Fault, "device_label" | "serial" | "inverter_sn" | "position">): string {
  const dev = f.device_label ?? f.serial ?? f.inverter_sn;
  const parts = [dev, f.device_label && f.serial && !f.device_label.includes(f.serial) ? f.serial : null, positionText(f.position)].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

/** found → restored as "2 d 5 h" / "3.5 h"; "—" when not restored (never estimated) */
export function restoreText(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return "—";
  if (hours < 24) return `${Math.round(hours * 10) / 10} h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** a plant-local ISO time with offset as "2026-11-27 10:15" (already plant-local); "—" for null */
export const fmtLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

/** now in plant time, as a `datetime-local` value (`YYYY-MM-DDTHH:mm`) */
export const plantNowLocal = (now: Date = new Date()) => now.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok", hour12: false }).slice(0, 16).replace(" ", "T");

/** a stored plant-local ISO as a `datetime-local` value */
export const toLocalInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : "");

/** http(s) links only: what the backend accepts as evidence */
export const isEvidenceUrl = (u: string) => /^https?:\/\/\S{3,}$/i.test(u.trim());
export const parseUrls = (text: string) => [...new Set(text.split(/[\n\s]+/).map((u) => u.trim()).filter(Boolean))];

/** where a linked record opens in the app; null when it has no page */
export function linkHref(l: Pick<FaultLink, "kind" | "ref_id" | "ref_key">, f: Pick<Fault, "plant_id" | "inverter_sn">): string | null {
  switch (l.kind) {
    case "issue":
      return f.inverter_sn ? `${plantPath(f.plant_id, "inverters")}?sn=${encodeURIComponent(f.inverter_sn)}&tab=issues` : plantPath(f.plant_id, "inverters");
    case "claim":
      return l.ref_id != null ? `/claims?claim=${l.ref_id}` : "/claims";
    case "failed_unit":
      return l.ref_id != null ? `/inventory?tab=failed&fu=${l.ref_id}` : "/inventory?tab=failed";
    case "stock_batch":
      return "/inventory?tab=movements";
    case "site_event":
      return plantPath(f.plant_id, "maintenance");
    case "om_task":
      return `/calendar?plant=${f.plant_id}`;
    case "kb":
      return l.ref_id != null ? `/kb/doc/${l.ref_id}` : "/kb";
    case "alarm":
      return `/alarms?plant=${f.plant_id}`;
    case "device_check":
      return "/devices?tab=checks";
  }
}

/** the timeline line for an event (English, for `t()`), and its vars */
export function eventTitle(kind: string, from: string | null, to: string | null): { text: string; vars?: Record<string, string> } {
  const st = (s: string | null) => (s && s in STATUS ? STATUS[s as FaultStatus].label : s ?? "—");
  const dec = (s: string | null) => (s && s in DECISION ? DECISION[s as FaultDecisionKind] : s ?? "—");
  switch (kind) {
    case "created":
      return { text: "Recorded" };
    case "edit":
      return { text: "Edited" };
    case "status":
      return { text: "{from} → {to}", vars: { from: st(from), to: st(to) } };
    case "decision":
      return from ? { text: "Decision {from} → {to}", vars: { from: dec(from), to: dec(to) } } : { text: "Decision: {to}", vars: { to: dec(to) } };
    case "severity":
      return { text: "Severity {from} → {to}", vars: { from: from ?? "—", to: to ?? "—" } };
    case "note":
      return { text: "Note" };
    case "link":
      return { text: "Linked a record" };
    case "unlink":
      return { text: "Unlinked a record" };
    default:
      return { text: kind };
  }
}
