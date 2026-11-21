/** Claims: labels, badges, allowed status changes, links into the app, and the prefill a page passes
 * through the URL (`/claims?new=…`). Day / CSV helpers are shared with Measuring Tools. */
import type { Claim, ClaimCause, ClaimLinkKind, ClaimStatus, ClaimType } from "../../api/client";
import { plantPath } from "../../context/routes";
import { translate } from "../../i18n";

export { addDays, daysBetween, downloadCsv, fmtDay, relDays } from "../tools/format";

type BadgeVariant = "ok" | "warn" | "crit" | "info" | "neutral";

export const TYPE: Record<ClaimType, { label: string; short: string; hint: string }> = {
  inverter_warranty: { label: "Inverter warranty", short: "Inverter", hint: "Growatt RMA / replacement" },
  module_warranty: { label: "Module warranty", short: "Modules", hint: "Defect or below warranted power" },
  equipment_warranty: { label: "Equipment warranty", short: "Equipment", hint: "Datalogger, meter, sensor, optimiser, combiner, …" },
  insurance: { label: "Insurance", short: "Insurance", hint: "Lightning, storm, flood, fire, theft" },
  workmanship: { label: "Workmanship", short: "Workmanship", hint: "Installer / EPC defect" },
};
export const TYPE_KEYS = Object.keys(TYPE) as ClaimType[];

export const STATUS: Record<ClaimStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: "Draft", variant: "neutral" },
  submitted: { label: "Submitted", variant: "info" },
  under_review: { label: "Under review", variant: "info" },
  info_requested: { label: "Info requested", variant: "warn" },
  approved: { label: "Approved", variant: "ok" },
  rejected: { label: "Rejected", variant: "crit" },
  fulfilled: { label: "Fulfilled", variant: "ok" },
  closed: { label: "Closed", variant: "neutral" },
  withdrawn: { label: "Withdrawn", variant: "neutral" },
};
export const STATUS_KEYS = Object.keys(STATUS) as ClaimStatus[];
export const CLOSED_STATUSES: readonly ClaimStatus[] = ["closed", "withdrawn"];
export const isOpen = (c: Pick<Claim, "status">) => !CLOSED_STATUSES.includes(c.status);

/** what the button says for each next status */
export const TRANSITION_LABEL: Record<ClaimStatus, string> = {
  draft: "Reopen as draft",
  submitted: "Mark submitted",
  under_review: "Under review",
  info_requested: "They asked for info",
  approved: "Approved",
  rejected: "Rejected",
  fulfilled: "Fulfilled (replaced / repaired / paid)",
  closed: "Close claim",
  withdrawn: "Withdraw",
};

/** allowed next statuses; the backend checks them too (409) */
export const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["under_review", "info_requested", "approved", "rejected", "withdrawn"],
  under_review: ["info_requested", "approved", "rejected", "withdrawn"],
  info_requested: ["under_review", "withdrawn"],
  approved: ["fulfilled", "withdrawn"],
  rejected: ["under_review", "closed"],
  fulfilled: ["closed"],
  closed: ["under_review"],
  withdrawn: ["draft"],
};

export const CAUSE: Record<ClaimCause, string> = {
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
};
export const CAUSE_KEYS = Object.keys(CAUSE) as ClaimCause[];

export const LINK_KIND: Record<ClaimLinkKind, string> = { issue: "Issue", iv_sweep: "I-V sweep", site_log: "Site log entry" };

export const WAIT = ["us", "them", "followup"] as const;
export type Wait = (typeof WAIT)[number];

/** what failed, one line: inverter SN · PV3, 4 · device (display text: translated) */
export const whatText = (c: Pick<Claim, "device_sn" | "string_nos" | "device_label" | "module_serials">) => {
  const parts = [
    c.device_sn,
    c.string_nos.length ? `PV${c.string_nos.join(", ")}` : null,
    c.module_serials.length ? translate(c.module_serials.length === 1 ? "{n} module" : "{n} modules", { n: c.module_serials.length }) : null,
    c.device_label,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
};

/** days the claim has been running: since submitted, or since created for a draft */
export const ageStart = (c: Claim) => c.submitted_day ?? c.created_at?.slice(0, 10) ?? null;

export const inverterHref = (plantId: number, sn: string) => `${plantPath(plantId, "inverters")}?sn=${encodeURIComponent(sn)}`;
export const stringHref = (plantId: number, sn: string, no: number) => `${plantPath(plantId, "string")}?sn=${encodeURIComponent(sn)}&no=${no}`;

/** where in the app an evidence item can be found, when the claim says enough to point there */
export function evidenceHref(key: string, c: Claim): { label: string; href: string } | null {
  switch (key) {
    case "alarm_log":
      return c.device_sn
        ? { label: "Alarm log", href: `/alarms?${new URLSearchParams({ q: c.device_sn, ...(c.incident_day ? { day: c.incident_day } : {}) })}` }
        : null;
    case "iv_sweep":
      return c.device_sn && c.string_nos.length ? { label: "I-V sweeps", href: stringHref(c.plant_id, c.device_sn, c.string_nos[0]) } : null;
    case "second_source":
      return { label: "Plant inverters", href: c.device_sn ? inverterHref(c.plant_id, c.device_sn) : plantPath(c.plant_id, "inverters") };
    case "site_log":
      return { label: "Site log", href: plantPath(c.plant_id, "maintenance") };
    case "weather":
      return c.incident_day ? { label: "Plant on that day", href: `${plantPath(c.plant_id)}?day=${c.incident_day}` } : null;
    default:
      return null;
  }
}

export function linkHref(kind: ClaimLinkKind, c: Claim): string {
  switch (kind) {
    case "issue":
      return c.device_sn ? inverterHref(c.plant_id, c.device_sn) : plantPath(c.plant_id, "inverters");
    case "iv_sweep":
      return c.device_sn && c.string_nos.length ? stringHref(c.plant_id, c.device_sn, c.string_nos[0]) : plantPath(c.plant_id, "strings");
    case "site_log":
      return plantPath(c.plant_id, "maintenance");
  }
}

/* ---------------------------------------------------------------- prefill from other pages */

export const NEW_FROM = ["blank", "issue", "inverter", "sweep"] as const;
export type NewFrom = (typeof NEW_FROM)[number];

export interface Prefill {
  from: NewFrom;
  plant_id: number | null;
  device_sn: string | null;
  string_no: number | null;
  /** issue id or sweep id */
  ref: number | null;
}

const int = (v: string | null) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/** `new` = blank | issue | inverter | sweep, `p` = plant, `sn`, `no` = string, `ref` = issue / sweep id */
export function readPrefill(url: URLSearchParams): Prefill | null {
  const v = url.get("new");
  if (!v) return null;
  const from = (NEW_FROM as readonly string[]).includes(v) ? (v as NewFrom) : "blank";
  return { from, plant_id: int(url.get("p")), device_sn: url.get("sn") || null, string_no: int(url.get("no")), ref: int(url.get("ref")) };
}

export { newClaimHref } from "@/lib/claimLinks";

export const PREFILL_KEYS = { new: null, p: null, sn: null, no: null, ref: null } as const;
