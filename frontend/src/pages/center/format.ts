/** Engineering O&M: period presets, the views of the work lists, loss-family colours and the loss-by-cause chart spec. */
import type { LossFamily, OmCenter } from "../../api/client";
import type { PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { dateLocale, translate } from "../../i18n";

export const RANGES = ["mtd", "7d", "30d", "90d", "ytd"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_LABEL: Record<Range, string> = { mtd: "Month to date", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", ytd: "Year to date" };

export const VIEWS = ["issues", "plants", "recover", "billing", "sites", "outages", "meter"] as const;
export type View = (typeof VIEWS)[number];

export const EST = "Estimated: lost kWh from the decision rules, priced with the tariff. Each kWh is counted once across overlapping rules.";
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

/** one colour per family, the same in the chart and the totals */
export const FAMILY_COLOR: Record<LossFamily, string> = {
  down: CATEGORICAL[3],
  strings: CATEGORICAL[1],
  conversion: CATEGORICAL[2],
  underyield: CATEGORICAL[0],
  plant: CATEGORICAL[4],
  data_gap: CATEGORICAL[5],
};

const dayList = (start: string, end: string): string[] => {
  const out: string[] = [];
  for (const d = parseDay(start); iso(d) <= end; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
};

/** Estimated THB lost per day, one stacked bar per day, a segment per cause. Null when nothing was lost. */
export const lossSpec = (c: OmCenter): PanelChartSpec | null => {
  const rows = c.loss_by_cause.days;
  if (!rows.length) return null;
  const days = dayList(c.window.start, c.window.end);
  const idx = new Map(days.map((d, i) => [d, i]));
  const fams = c.loss_by_cause.families.filter((f) => rows.some((r) => r.family === f.key));
  const val = new Map(fams.map((f) => [f.key, days.map(() => null as number | null)]));
  const kwh = days.map(() => 0);
  for (const r of rows) {
    const i = idx.get(r.day);
    if (i == null) continue;
    val.get(r.family)![i] = r.thb_est;
    kwh[i] += r.kwh_est ?? 0;
  }
  const base = days.map(() => 0);
  const series = fams.map((f) => {
    const v = val.get(f.key)!;
    const y0 = v.map((x, i) => (x == null ? null : base[i]));
    const y = v.map((x, i) => (x == null ? null : (base[i] += x)));
    return { key: f.key, name: f.label, type: "bar" as const, color: FAMILY_COLOR[f.key], y, y0, noTip: true };
  });
  return {
    xKind: "band",
    x: days,
    xTickLabel: (v) => String(v).slice(8),
    xTipLabel: (v) => fmtDay(String(v)),
    panels: [{ key: "thb", title: translate("Estimated loss (THB per day)"), stacked: true, yMin: 0, series }],
    tipExtra: (i) => [
      ...fams.filter((f) => val.get(f.key)![i] != null).map((f) => ({ label: f.label, value: thb(val.get(f.key)![i]) })),
      ...(base[i] > 0 ? [{ label: translate("Total (est.)"), value: `${thb(base[i])} · ${fmt(kwh[i], 0)} kWh` }] : []),
    ],
  };
};
