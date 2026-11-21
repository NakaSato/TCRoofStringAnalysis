/** Engineering O&M charts drawn with PanelChart: the fleet's report days (measured meter yield; the
 * contract is modelled, the card says so). */
import type { PwaMeterDaily } from "../../api/client";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL, SERIES } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { DAY_MS } from "../pwaMeter/chart";
import { translate } from "../../i18n";

export const PHASE_COLOR: Record<number, string> = { 1: CATEGORICAL[0], 2: CATEGORICAL[1] };
const dayMs = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return +new Date(y, m - 1, d);
};

/** mean of the value and the up to six report days before it (null days left out) */
const trailingMean = (v: Array<number | null>, n = 7): Array<number | null> =>
  v.map((_, i) => {
    const w = v.slice(Math.max(0, i - n + 1), i + 1).filter((x): x is number => x != null);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });

/** Per phase and report day: specific yield (daily, and its 7-day mean on longer periods) and
 * metered energy as a share of the contract's. Null without phase totals (engineers). */
export const fleetDailySpec = (d: PwaMeterDaily, phase: number | null): PanelChartSpec | null => {
  const rows = d.phases.filter((r) => phase == null || r.phase === phase);
  if (!rows.length || !d.days.length) return null;
  const idx = new Map(d.days.map((day, i) => [day, i]));
  const phases = [...new Set(rows.map((r) => r.phase))].sort();
  const withMean = d.days.length >= 14;
  const yieldSeries: ChartSeries[] = [];
  const ratioSeries: ChartSeries[] = [];
  const sites = d.days.map(() => 0);
  for (const ph of phases) {
    const y = d.days.map(() => null as number | null);
    const ratio = d.days.map(() => null as number | null);
    for (const r of rows) {
      if (r.phase !== ph) continue;
      const i = idx.get(r.day);
      if (i == null) continue;
      y[i] = r.yield_kwh_kwp;
      ratio[i] = r.vs_contract_pct;
      sites[i] += r.sites;
    }
    const color = PHASE_COLOR[ph] ?? SERIES.secondary;
    const fmtY = (v: number) => `${fmt(v, 2)} kWh/kWp`;
    yieldSeries.push({ key: `y${ph}`, name: translate("Phase {n}", { n: ph }), type: "line", color, y, width: withMean ? 1 : 2, opacity: withMean ? 0.4 : 1, format: fmtY });
    if (withMean) yieldSeries.push({ key: `m${ph}`, name: translate("Phase {n}, 7-day mean", { n: ph }), type: "line", color, y: trailingMean(y), width: 2.2, noLegend: true, format: fmtY });
    ratioSeries.push({ key: `r${ph}`, name: translate("Phase {n}", { n: ph }), type: "line", color, y: ratio, width: 2, noLegend: true, format: (v) => `${fmt(v, 1)} %` });
  }
  return {
    xKind: "time",
    x: d.days.map(dayMs),
    xStep: DAY_MS,
    panels: [
      { key: "yield", title: withMean ? translate("Specific yield (kWh/kWp per day; bold = 7-day mean)") : translate("Specific yield (kWh/kWp per day)"), yMin: 0, series: yieldSeries },
      { key: "ratio", title: translate("Meter ÷ contract energy (%)"), weight: 0.8, zero: false, tickSuffix: " %", series: ratioSeries, refLines: [{ y: 100, label: translate("Contract") }] },
    ],
    tipExtra: (i) => [{ label: translate("Sites with a reading"), value: String(sites[i]) }],
  };
};
