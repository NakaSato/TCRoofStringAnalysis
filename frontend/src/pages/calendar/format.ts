/** Calendar Team: labels, colours and plant-local day helpers ("YYYY-MM-DD" strings). */
import type { OmBusyBlock, OmPerson, OmTask, OmTaskStatus, OmTaskType } from "../../api/client";
import { fromDate, toDate } from "@/lib/day";

export const TASK_TYPES: ReadonlyArray<{ value: OmTaskType; label: string }> = [
  { value: "cleaning", label: "Cleaning" },
  { value: "pm_inspection", label: "PM inspection" },
  { value: "inverter_service", label: "Inverter service" },
  { value: "repair", label: "Repair" },
  { value: "module_replaced", label: "Module replaced" },
  { value: "inverter_replaced", label: "Inverter replaced" },
  { value: "ir_flight", label: "IR flight" },
  { value: "site_visit", label: "Site visit" },
  { value: "other", label: "Other" },
];
export const TYPE_KEYS = TASK_TYPES.map((t) => t.value);
export const typeLabel = (t: OmTaskType) => TASK_TYPES.find((x) => x.value === t)?.label ?? t;

/** chip colours: cleaning blue, PM green, repairs amber, IR violet, visits / other grey */
export const TYPE_CHIP: Record<OmTaskType, string> = {
  cleaning: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  pm_inspection: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  inverter_service: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  repair: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  module_replaced: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  inverter_replaced: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  ir_flight: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  site_visit: "border-white/15 bg-white/5 text-slate-300",
  other: "border-white/15 bg-white/5 text-slate-300",
};
export const BUSY_CHIP = "border-dashed border-white/15 bg-transparent text-slate-500";

export const STATUSES: ReadonlyArray<{ value: OmTaskStatus; label: string; variant: "info" | "warn" | "ok" | "neutral" }> = [
  { value: "planned", label: "Planned", variant: "info" },
  { value: "in_progress", label: "In progress", variant: "warn" },
  { value: "done", label: "Done", variant: "ok" },
  { value: "skipped", label: "Skipped", variant: "neutral" },
  { value: "cancelled", label: "Cancelled", variant: "neutral" },
];
export const STATUS_KEYS = STATUSES.map((s) => s.value);
export const statusOf = (s: OmTaskStatus) => STATUSES.find((x) => x.value === s) ?? STATUSES[0];

/** extra chip classes for the status: finished ones fade, overdue gets a red ring */
export const statusChip = (t: OmTask) =>
  t.status === "done"
    ? "opacity-60"
    : t.status === "skipped" || t.status === "cancelled"
      ? "opacity-40 line-through"
      : t.overdue
        ? "ring-1 ring-red-400/70"
        : "";

export const personName = (p: OmPerson) => p.full_name || p.username || `User ${p.id}`;
export const taskTitle = (t: OmTask) => t.title || t.label;
export const taskWhere = (t: OmTask) => {
  const inv = t.inverter_name || t.device_sn;
  if (inv && t.string_no != null) return `${inv} · PV${t.string_no}`;
  return inv || "Whole plant";
};

// --------------------------------------------------------------------------- days

export const addDays = (day: string, n: number) => {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return fromDate(d);
};

/** Monday of the day's week */
export const weekStart = (day: string) => {
  const d = toDate(day);
  return addDays(day, -((d.getDay() + 6) % 7));
};

export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
export const monthEnd = (day: string) => {
  const d = toDate(monthStart(day));
  return fromDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
};
export const addMonths = (day: string, n: number) => {
  const d = toDate(monthStart(day));
  return fromDate(new Date(d.getFullYear(), d.getMonth() + n, 1));
};

/** inclusive list of days */
export const daysBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export type View = "month" | "week" | "list";
export const VIEWS: readonly View[] = ["month", "week", "list"];

/** what the API is asked for: the 6-week grid around the month, or the Mon–Sun week */
export const rangeFor = (view: View, day: string): { from: string; to: string } => {
  if (view === "week") {
    const from = weekStart(day);
    return { from, to: addDays(from, 6) };
  }
  if (view === "list") return { from: monthStart(day), to: monthEnd(day) };
  const from = weekStart(monthStart(day));
  return { from, to: addDays(from, 41) };
};

export const covers = (t: { start_day: string; end_day: string }, day: string) => t.start_day <= day && day <= t.end_day;

export const shortDay = (day: string) => toDate(day).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
export const spanLabel = (t: { start_day: string; end_day: string }) =>
  t.start_day === t.end_day ? shortDay(t.start_day) : `${shortDay(t.start_day)} → ${shortDay(t.end_day)}`;
export const monthLabel = (day: string) => toDate(day).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
export const weekLabel = (from: string) => `${shortDay(from)} – ${shortDay(addDays(from, 6))} ${from.slice(0, 4)}`;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type Entry = OmTask | OmBusyBlock;

/** CSV of the tasks shown (busy blocks are not exported) */
export const tasksCsv = (tasks: OmTask[]) => {
  const head = ["id", "plant_id", "plant", "type", "title", "start_day", "end_day", "status", "overdue", "team", "assignees", "where", "est_cost_thb", "note"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = tasks.map((t) => [
    t.id,
    t.plant_id,
    t.plant_name,
    t.label,
    t.title,
    t.start_day,
    t.end_day,
    t.status,
    t.overdue ? "yes" : "",
    t.team?.name,
    t.assignees.map(personName).join("; "),
    taskWhere(t),
    t.est_cost_thb,
    t.note,
  ]);
  return [head, ...rows].map((r) => r.map(esc).join(",")).join("\n");
};
