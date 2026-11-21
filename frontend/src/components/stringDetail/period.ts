/**
 * The period a string detail covers: one stored day (default: the string's newest), or a day range
 * (≤ MAX_RANGE_DAYS, both inclusive), optionally narrowed to a plant-local time-of-day window.
 * Shared by the String Inspector drawer and the string page.
 */
import { fromDate, toDate } from "@/lib/day";
import { dateLocale } from "../../i18n";

export interface StringPeriod {
  /** first (or only) day, "YYYY-MM-DD"; null = the string's newest stored day */
  day: string | null;
  /** last day of a range; null = one day */
  endDay: string | null;
  /** time-of-day window "HH:MM" ("" = open end) */
  start: string;
  end: string;
}

export const NEWEST: StringPeriod = { day: null, endDay: null, start: "", end: "" };
/** as the backend allows */
export const MAX_RANGE_DAYS = 31;

/** quick time-of-day windows (plant-local, inclusive 5-min slots) */
export const WINDOW_PRESETS = [
  { label: "Morning", start: "06:00", end: "09:55" },
  { label: "Midday", start: "10:00", end: "13:55" },
  { label: "Afternoon", start: "14:00", end: "18:00" },
] as const;

export const shiftDay = (day: string, n: number) => {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return fromDate(d);
};

/** whole days from `day` to `today` (both "YYYY-MM-DD", plant-local) */
export const daysBetween = (day: string, today: string) => Math.round((toDate(today).getTime() - toDate(day).getTime()) / 86_400_000);

/** "12 Nov" (with the year when it isn't this year's) */
export const shortDay = (day: string, today: string) =>
  toDate(day).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) && { year: "numeric" }) });

/** "12 Nov" or "6–12 Nov" / "28 Oct – 3 Nov" */
export const periodDayText = (day: string, endDay: string | null, today: string) => {
  if (!endDay || endDay === day) return shortDay(day, today);
  if (day.slice(0, 7) === endDay.slice(0, 7)) return `${Number(day.slice(8, 10))}–${shortDay(endDay, today)}`;
  return `${shortDay(day, today)} – ${shortDay(endDay, today)}`;
};

export const isWindowBad = (p: StringPeriod) => Boolean(p.start && p.end && p.start > p.end);
export const isWindowed = (p: StringPeriod) => Boolean(p.start || p.end) && !isWindowBad(p);
export const windowText = (p: StringPeriod) => (isWindowed(p) ? `${p.start || "00:00"}–${p.end || "24:00"}` : null);
export const isRange = (p: StringPeriod) => Boolean(p.day && p.endDay && p.endDay !== p.day);
export const rangeDays = (p: StringPeriod) => (p.day && p.endDay ? daysBetween(p.day, p.endDay) + 1 : 1);

/** chart x (ms) → "HH:MM" of its 5-min slot on `day`, clamped to the day */
export const slotTime = (ms: number, day: string, up: boolean) => {
  const d = new Date(ms);
  const ymd = fromDate(d);
  if (ymd < day) return "00:00";
  if (ymd > day) return "23:55";
  const min = d.getHours() * 60 + d.getMinutes();
  const m = Math.min(23 * 60 + 55, up ? Math.ceil(min / 5) * 5 : Math.floor(min / 5) * 5);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** URL query ⇄ period (string page): `day`, `to`, `from_t`, `to_t` */
export const periodFromQuery = (q: URLSearchParams): StringPeriod => {
  const d = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const t = (v: string | null) => (v && /^\d{2}:\d{2}$/.test(v) ? v : "");
  const day = d(q.get("day"));
  const endDay = day ? d(q.get("to")) : null;
  return { day, endDay: endDay && endDay > day! ? endDay : null, start: t(q.get("from_t")), end: t(q.get("to_t")) };
};
export const periodToQuery = (p: StringPeriod) => ({ day: p.day, to: p.endDay, from_t: p.start || null, to_t: p.end || null });
