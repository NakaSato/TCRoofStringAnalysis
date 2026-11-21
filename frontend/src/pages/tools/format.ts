/** Measuring Tools: labels, spec fields per category, badges, day maths and CSV. */
import type { LucideIcon } from "lucide-react";
import { Activity, Box, Earth, Magnet, Plane, ScanEye, ShieldCheck, Sun, Waves, Zap } from "lucide-react";
import type { DueKind, DueState, Instrument, InstrumentCategory, InstrumentStatus } from "../../api/client";
import { dayLabel } from "@/lib/day";
import { fmtInt } from "../../components/ui";
import { translate } from "../../i18n";

type BadgeVariant = "ok" | "warn" | "crit" | "info" | "neutral";

export interface SpecField {
  key: string;
  label: string;
  unit?: string;
  kind: "text" | "number";
  placeholder?: string;
}

export interface CategoryDef {
  value: InstrumentCategory;
  label: string;
  icon: LucideIcon;
  specs: SpecField[];
  /** what runs out for this category */
  dueKinds: DueKind[];
  /** keys that must be entered before the instrument is used on PV strings (CAT rating, max DC V) */
  pvRating?: string[];
}

const CAT_RATING: SpecField = { key: "cat_rating", label: "CAT rating", kind: "text", placeholder: "e.g. CAT III 1500 V DC" };
const MAX_DC_V: SpecField = { key: "max_dc_v", label: "Max DC voltage", unit: "V", kind: "number" };

export const CATEGORIES: readonly CategoryDef[] = [
  {
    value: "drone",
    label: "Drone",
    icon: Plane,
    specs: [
      { key: "thermal_resolution", label: "Thermal resolution", kind: "text", placeholder: "e.g. 640×512" },
      { key: "camera", label: "Visual camera", kind: "text", placeholder: "e.g. 48 MP" },
      { key: "batteries", label: "Batteries", unit: "pcs", kind: "number" },
    ],
    dueKinds: ["caat", "nbtc", "insurance"],
  },
  {
    value: "thermal_camera",
    label: "Thermal camera",
    icon: ScanEye,
    specs: [
      { key: "resolution", label: "IR resolution", kind: "text", placeholder: "e.g. 320×240" },
      { key: "temp_range", label: "Temperature range", kind: "text", placeholder: "e.g. −20 … 550 °C" },
    ],
    dueKinds: ["calibration"],
  },
  {
    value: "iv_tracer",
    label: "I-V curve tracer",
    icon: Activity,
    specs: [
      { key: "max_v", label: "Max voltage", unit: "V", kind: "number" },
      { key: "max_a", label: "Max current", unit: "A", kind: "number" },
    ],
    dueKinds: ["calibration"],
  },
  {
    value: "insulation_tester",
    label: "Insulation tester",
    icon: ShieldCheck,
    specs: [{ key: "test_voltages", label: "Test voltages", kind: "text", placeholder: "e.g. 250 / 500 / 1000 V" }, CAT_RATING],
    dueKinds: ["calibration"],
  },
  {
    value: "clamp_meter",
    label: "Clamp meter",
    icon: Magnet,
    specs: [CAT_RATING, MAX_DC_V, { key: "max_a", label: "Max current", unit: "A", kind: "number" }],
    dueKinds: ["calibration"],
    pvRating: ["cat_rating", "max_dc_v"],
  },
  {
    value: "multimeter",
    label: "Multimeter",
    icon: Zap,
    specs: [CAT_RATING, MAX_DC_V],
    dueKinds: ["calibration"],
    pvRating: ["cat_rating", "max_dc_v"],
  },
  {
    value: "irradiance_meter",
    label: "Irradiance meter",
    icon: Sun,
    specs: [{ key: "range_wm2", label: "Range", kind: "text", placeholder: "e.g. 0 … 1,500 W/m²" }],
    dueKinds: ["calibration"],
  },
  {
    value: "earth_tester",
    label: "Earth tester",
    icon: Earth,
    specs: [{ key: "method", label: "Method", kind: "text", placeholder: "e.g. 3-pole, clamp" }],
    dueKinds: ["calibration"],
  },
  {
    value: "power_analyser",
    label: "Power analyser",
    icon: Waves,
    specs: [{ key: "channels", label: "Channels", kind: "number" }],
    dueKinds: ["calibration"],
  },
  {
    value: "other",
    label: "Other",
    icon: Box,
    specs: [{ key: "description", label: "What it measures", kind: "text" }],
    dueKinds: ["calibration"],
  },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.value);
export const categoryOf = (c: InstrumentCategory): CategoryDef => CATEGORIES.find((d) => d.value === c) ?? CATEGORIES[CATEGORIES.length - 1];

export const STATUS: Record<InstrumentStatus, { label: string; variant: BadgeVariant }> = {
  available: { label: "Available", variant: "ok" },
  checked_out: { label: "Checked out", variant: "info" },
  at_calibration: { label: "At calibration", variant: "neutral" },
  repair: { label: "Repair", variant: "warn" },
  retired: { label: "Retired", variant: "neutral" },
};
export const STATUS_KEYS = Object.keys(STATUS) as InstrumentStatus[];

export const DUE_KIND: Record<DueKind, string> = {
  calibration: "Calibration",
  caat: "CAAT registration",
  nbtc: "NBTC registration",
  insurance: "Insurance",
  pilot_licence: "Pilot licence",
  other: "Other",
};

export const DUE_STATE: Record<DueState, { label: string; variant: BadgeVariant }> = {
  overdue: { label: "Overdue", variant: "crit" },
  due_soon: { label: "Due soon", variant: "warn" },
  ok: { label: "OK", variant: "ok" },
  none: { label: "No date", variant: "neutral" },
};
export const DUE_STATE_KEYS = Object.keys(DUE_STATE) as DueState[];
/** worst first; "no date" is unknown, so it sorts before ok */
export const DUE_RANK: Record<DueState, number> = { overdue: 0, due_soon: 1, none: 2, ok: 3 };

/** "YYYY-MM-DD" + n days */
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "YYYY-MM-DD" + n months (end of month clamps: 31 Jan + 1 = 28/29 Feb) */
export const addMonths = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
};
/** whole days from `a` to `b` */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const fmtDay = (day: string | null) => (day ? dayLabel(day) : "—");
export const thb = (v: number | null) => (v == null ? "—" : `฿${fmtInt(v)}`);

/** "in 12 d", "3 d ago", "today" relative to `today` */
export const relDays = (day: string | null, today: string) => {
  if (!day) return "";
  const n = daysBetween(today, day);
  return n === 0 ? translate("today") : n > 0 ? translate("in {n} d", { n }) : translate("{n} d ago", { n: -n });
};

const specText = (v: number | string | null | undefined, unit?: string) =>
  v == null || v === "" ? null : typeof v === "number" ? `${fmtInt(v)}${unit ? ` ${unit}` : ""}` : v;

/** one-line key spec for the table; "—" when nothing is entered */
export const keySpec = (i: Instrument): string => {
  const def = categoryOf(i.category);
  const parts = def.specs.slice(0, 2).map((f) => specText(i.specs[f.key], f.unit)).filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
};

/** spec labels still missing for use on PV strings (clamp meters, multimeters); empty = fine */
export const missingPvRating = (i: Instrument): string[] => {
  const def = categoryOf(i.category);
  return (def.pvRating ?? [])
    .filter((k) => i.specs[k] == null || i.specs[k] === "")
    .map((k) => def.specs.find((f) => f.key === k)?.label ?? k);
};

export const specValue = (i: Instrument, f: SpecField) => specText(i.specs[f.key], f.unit) ?? "—";

/** holder / place text */
export const whereText = (i: Instrument, plantName: (id: number) => string) => {
  const c = i.open_checkout;
  if (!c) return i.status === "at_calibration" ? "Calibration lab" : "Store";
  const who = c.holder?.name ?? "—";
  return c.plant_id != null ? `${who} · ${c.plant_name ?? plantName(c.plant_id)}` : who;
};

export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const esc = (v: unknown) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
  const text = [head.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}
