/** PWA Meter: labels, badge tones, period presets and CSV. The issue / flag / cause words come from
 * the backend (pwa_meter_criteria.json) in Thai and are shown as given. */
import type { PwaDayStatus, PwaMeterWindow } from "../../api/client";
import { dateLocale } from "../../i18n";

export const TABS = ["sites", "outages", "meter"] as const;
export type Tab = (typeof TABS)[number];

export const SHOW = ["all", "issues", "om", "pm"] as const;
export type Show = (typeof SHOW)[number];

export const PHASES = ["all", "1", "2"] as const;

export const DAY_STATUS: Record<PwaDayStatus, { label: string; hint: string }> = {
  ok: { label: "Producing", hint: "Meter and inverter both ≥ 1 kWh" },
  outage: { label: "Outage", hint: "Meter and inverter both < 1 kWh" },
  loss_inv: { label: "Inverter data missing", hint: "Inverter < 1 kWh while the meter read ≥ 1 kWh (usually communications)" },
  loss_meter: { label: "Meter reading missing", hint: "Meter < 1 kWh while the inverter made ≥ 1 kWh" },
};

export const WEATHER: Record<string, string> = { clear: "Clear sky", cloudy: "Cloudy", rain: "Rain" };

type Tone = "crit" | "warn" | "info" | "neutral";

/** badge tone of a site issue (หรี่กำลัง is a PM matter, the rest O&M) */
export const issueTone = (issue: string): Tone =>
  issue.startsWith("ล่ม") || issue === "ระบบล่ม" ? "crit" : issue === "หรี่กำลัง" ? "info" : issue === "ข้อมูลขาด" ? "neutral" : "warn";

/** the meter-check gap and flags, and the losses, are estimates; contract / PVsyst are modelled */
export const EST = "Estimated from the report and the criteria file, not measured";
export const MODELLED = "Modelled: contract expected energy or PVsyst P50, not measured";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const isDay = (s: string | null): s is string => s != null && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDay(s).getTime());

export const PRESETS = ["all", "ytd", "90d", "30d"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABEL: Record<Preset, string> = { all: "Whole report", ytd: "Year to date", "90d": "Last 90 days", "30d": "Last 30 days" };

/** a preset window ending on the report's last day (the report lags up to a month, so "last 30
 * days" counts back from the data, not from today) */
export const presetWindow = (p: Preset, lastDay: string | null): PwaMeterWindow => {
  if (p === "all" || !lastDay) return {};
  const end = parseDay(lastDay);
  if (p === "ytd") return { start: `${end.getFullYear()}-01-01` };
  const back = new Date(end);
  back.setDate(back.getDate() - (p === "90d" ? 89 : 29));
  return { start: iso(back) };
};

export const presetOf = (w: PwaMeterWindow, lastDay: string | null): Preset | null => {
  if (w.end) return null;
  return PRESETS.find((p) => (presetWindow(p, lastDay).start ?? null) === (w.start ?? null)) ?? null;
};

export const fmtDay = (s: string | null | undefined): string => {
  if (!s) return "—";
  return parseDay(s).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
};

export const dayMs = (s: string): number => parseDay(s).getTime();

/** "21 Nov" (Thai short month in Thai): chart ticks */
export const fmtDayShort = (s: string): string => parseDay(s).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });

/** Every calendar day from `first` to `last` (YYYY-MM-DD), both included */
export const daysBetween = (first: string, last: string): string[] => {
  const out: string[] = [];
  const d = parseDay(first);
  const end = parseDay(last).getTime();
  for (let i = 0; d.getTime() <= end && i < 400; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
};

/** CSV with a BOM, so Excel reads the Thai issue words and notes */
export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const esc = (v: unknown) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
  const text = "﻿" + [head.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

/** sort with nulls last whatever the direction */
export const byKey = <T,>(rows: T[], get: (r: T) => number | string | null, desc: boolean): T[] =>
  [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "string" ? x.localeCompare(String(y), "th") : x - (y as number);
    return desc ? -c : c;
  });
