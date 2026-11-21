/** Engineering O&M charts drawn with PanelChart: the fleet's report days, loss by region and the plants
 * losing the most. Losses are estimates and the contract is modelled; the cards say so. */
import type { OmCenterPlant, PwaMeterDaily, PwaMeterSiteSummary } from "../../api/client";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL, SERIES } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { DAY_MS } from "../pwaMeter/chart";
import { thb } from "./format";
import { translate } from "../../i18n";

export const PHASE_COLOR: Record<number, string> = { 1: CATEGORICAL[0], 2: CATEGORICAL[1] };
/** the meter report's three causes, the colours of the "Loss by cause" bars */
export const CAUSES = [
  { key: "curtailment_loss_mwh", label: "Curtailment", color: "#38bdf8" },
  { key: "outage_loss_mwh", label: "Outage", color: "#f87171" },
  { key: "under_loss_mwh", label: "Under-performance", color: "#fbbf24" },
] as const;

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

/** Estimated lost energy of the meter report per PWA region, a stacked bar per region. */
export const regionSpec = (sites: PwaMeterSiteSummary[]): PanelChartSpec | null => {
  const by = new Map<string, { n: number; kwp: number; thb: number; v: number[] }>();
  for (const s of sites) {
    const k = s.region ?? translate("No region");
    const g = by.get(k) ?? { n: 0, kwp: 0, thb: 0, v: CAUSES.map(() => 0) };
    g.n += 1;
    g.kwp += s.kwp ?? 0;
    g.thb += s.loss_thb ?? 0;
    CAUSES.forEach((c, j) => (g.v[j] += s[c.key] ?? 0));
    by.set(k, g);
  }
  const total = (g: { v: number[] }) => g.v.reduce((a, b) => a + b, 0);
  const regions = [...by.entries()].filter(([, g]) => total(g) > 0).sort((a, b) => total(b[1]) - total(a[1]));
  if (!regions.length) return null;
  const base = regions.map(() => 0);
  const series = CAUSES.map((c, j) => {
    const y0 = regions.map((_, i) => base[i]);
    const y = regions.map(([, g], i) => (base[i] += g.v[j]));
    return { key: c.key, name: translate(c.label), type: "bar" as const, color: c.color, y, y0, noTip: true };
  });
  return {
    xKind: "band",
    x: regions.map(([k]) => k),
    panels: [{ key: "mwh", title: translate("Estimated lost energy (MWh)"), stacked: true, yMin: 0, series }],
    tipExtra: (i) => {
      const g = regions[i][1];
      return [
        ...CAUSES.map((c, j) => ({ label: translate(c.label), value: `${fmt(g.v[j], 1)} MWh` })),
        { label: translate("Total (est.)"), value: `${fmt(total(g), 1)} MWh · ${thb(g.thb)}` },
        { label: translate("Sites"), value: `${g.n} · ${fmt(g.kwp, 0)} kWp` },
        { label: translate("Per kWp"), value: g.kwp ? `${fmt((total(g) * 1000) / g.kwp, 1)} kWh/kWp` : "—" },
      ];
    },
  };
};

const short = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The plants with the largest estimated loss in the period (inverter side, ฿ at the tariff). */
export const topPlantsSpec = (plants: OmCenterPlant[], n = 10): PanelChartSpec | null => {
  const rows = plants.filter((p) => (p.lost_thb_est ?? 0) > 0).sort((a, b) => (b.lost_thb_est ?? 0) - (a.lost_thb_est ?? 0)).slice(0, n);
  if (!rows.length) return null;
  return {
    xKind: "band",
    x: rows.map((r) => String(r.plant_id)),
    xTickLabel: (v) => short(rows.find((r) => String(r.plant_id) === String(v))?.name ?? String(v)),
    xTipLabel: (v) => rows.find((r) => String(r.plant_id) === String(v))?.name ?? String(v),
    panels: [
      {
        key: "thb",
        title: translate("Estimated loss in the period (THB)"),
        yMin: 0,
        series: [{ key: "lost", name: translate("Lost (est.)"), type: "bar", color: CATEGORICAL[3], y: rows.map((r) => r.lost_thb_est), format: (v) => thb(v), noLegend: true }],
      },
    ],
    tipExtra: (i) => {
      const r = rows[i];
      return [
        { label: translate("Lost energy (est.)"), value: `${fmt(r.lost_kwh_est, 0)} kWh` },
        { label: translate("Share of energy"), value: r.loss_share_pct == null ? "—" : `${fmt(r.loss_share_pct, 1)} %` },
        { label: translate("Active issues"), value: String(r.active_issues) },
      ];
    },
  };
};
