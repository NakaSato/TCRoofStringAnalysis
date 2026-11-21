/** Engineering O&M: period presets, the views of the work lists and the formatters. */
import { fmt } from "../../components/ui";
import { dateLocale } from "../../i18n";

export const RANGES = ["mtd", "7d", "30d", "90d", "ytd"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_LABEL: Record<Range, string> = { mtd: "Month to date", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", ytd: "Year to date" };

export const VIEWS = ["issues", "plants", "billing", "finance", "sites", "outages", "meter"] as const;
export type View = (typeof VIEWS)[number];

export const ENTERED = "Entered by the team; items without a cost are not in the sum";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** first day of a preset, counted back from today (the browser's date) */
export const rangeStart = (r: Range): string => {
  const d = new Date();
  if (r === "mtd") d.setDate(1);
  else if (r === "ytd") d.setMonth(0, 1);
  else d.setDate(d.getDate() - (r === "7d" ? 6 : r === "30d" ? 29 : 89));
  return iso(d);
};

export const fmtDay = (s: string | null | undefined): string =>
  s ? parseDay(s).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" }) : "—";

export const thb = (v: number | null | undefined): string => (v == null ? "—" : `฿${fmt(v, 0)}`);

/** baht for a tile: millions as "฿12.34 M" so a large figure fits; the exact value goes in the tooltip */
export const thbShort = (v: number | null | undefined): string => (v == null ? "—" : Math.abs(v) >= 1e6 ? `฿${fmt(v / 1e6, 2)} M` : thb(v));
