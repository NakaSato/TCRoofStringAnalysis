/** Generation page: the plant's daily PR history from the stored plant-days (`/kpi-daily`, DB only).
 * PR / PR' are IEC 61724 from the plant's weather sensor (null without one); EPI is modelled and only
 * named in the tooltip. A calendar day with no stored row is a gap, never 0. */
import type { PanelChartSpec, ChartSeries } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { translate } from "../../i18n";
import type { PlantKpiDay } from "../../api/client";
import { daysBetween, fmtDay, fmtDayShort } from "../pwaMeter/format";

/** the backend's R16 sensor flags (growatt_rules.SENSOR_FLAG_TEXT) */
const SENSOR_FLAG: Record<string, string> = {
  stale: "irradiance frozen at one value",
  above_clear_sky: "irradiance above the clear-sky value",
  below_neighbours: "irradiance far below nearby plants' sensors on a clear day",
};

const suspect = (r: PlantKpiDay | undefined) => r?.sensor_ok === false;

/** Why the day's sensor was judged suspect, in the UI language. */
export const sensorReason = (r: PlantKpiDay): string =>
  r.sensor_flags.length ? r.sensor_flags.map((f) => translate(SENSOR_FLAG[f] ?? f)).join(", ") : translate("flagged by the sensor check");

const pct = (v: number) => `${fmt(v, 1)} %`;

/** today in the browser's calendar (the fleet and its users are in Bangkok) */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Two panels on one day axis (every calendar day from `start` to `end`): PR % (IEC PR, PR'
 * temp-corrected, the target as a dashed line) and specific yield Yf (kWh/kWp, bars). On a day whose
 * sensor was judged suspect (`sensor_ok === false`) PR and PR' leave the lines and are drawn as grey
 * points, and the tooltip says why. `selectedDay` gets a marker. The chart's x values are the days
 * (YYYY-MM-DD), so `PanelChart`'s `onPick(i)` gives `spec.x[i]` = the day clicked.
 */
export const prHistorySpec = (
  rows: PlantKpiDay[],
  start: string,
  end: string,
  o: { target: number | null; selectedDay?: string | null }
): PanelChartSpec | null => {
  const days = daysBetween(start, end);
  if (!days.length) return null;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const at = days.map((d) => byDay.get(d));
  const ok = (r: PlantKpiDay | undefined, v: number | null | undefined) => (r && !suspect(r) ? (v ?? null) : null);
  const bad = (r: PlantKpiDay | undefined, v: number | null | undefined) => (r && suspect(r) ? (v ?? null) : null);

  const pr = at.map((r) => ok(r, r?.pr_pct));
  const prT = at.map((r) => ok(r, r?.pr_temp_corrected_pct));
  const prBad = at.map((r) => bad(r, r?.pr_pct));
  const prTBad = at.map((r) => bad(r, r?.pr_temp_corrected_pct));
  const has = (ys: Array<number | null>) => ys.some((v) => v != null);

  const prSeries: ChartSeries[] = [
    { key: "pr", name: translate("PR (IEC 61724)"), color: SERIES.ac, type: "line", width: 2, y: pr, format: pct },
  ];
  if (has(prT) || has(prTBad))
    prSeries.push({ key: "prt", name: translate("PR' (temp-corrected)"), color: SERIES.temp, type: "line", width: 1.5, opacity: 0.85, y: prT, format: pct });
  if (has(prBad))
    prSeries.push({ key: "pr-bad", name: translate("PR, suspect sensor"), color: STATUS.none, type: "points", size: 7, y: prBad, format: pct });
  if (has(prTBad))
    prSeries.push({ key: "prt-bad", name: translate("PR', suspect sensor"), color: STATUS.none, type: "points", symbol: "ring", size: 7, y: prTBad, format: pct });

  const stride = Math.max(1, Math.ceil(days.length / 10));
  return {
    xKind: "band",
    x: days,
    xTickLabel: (v) => fmtDayShort(String(v)),
    xTickEvery: stride,
    xTipLabel: (v) => fmtDay(String(v)),
    markers: o.selectedDay && days.includes(o.selectedDay) ? [{ x: o.selectedDay, label: translate("Shown day") }] : undefined,
    tipExtra: (i) => {
      const r = at[i];
      if (!r) return [{ label: translate("Stored KPIs"), value: translate("none for this day") }];
      const out = [
        { label: translate("Energy"), value: r.energy_kwh == null ? "—" : `${fmt(r.energy_kwh, 0)} kWh` },
        { label: translate("Reference yield Yr"), value: r.yr_h == null ? "—" : `${fmt(r.yr_h, 2)} h` },
      ];
      if (r.epi != null) out.push({ label: translate("EPI (modelled)"), value: fmt(r.epi, 2) });
      if (r.day === todayIso()) out.push({ label: translate("Today"), value: translate("partial, rewritten every 10 min") });
      if (suspect(r))
        out.push({ label: translate("Weather sensor"), value: translate("suspect: {why} · PR not trustworthy", { why: sensorReason(r) }) });
      return out;
    },
    panels: [
      {
        key: "pr",
        title: translate("PR (%)"),
        weight: 1.3,
        zero: false,
        series: prSeries,
        refLines: o.target != null ? [{ y: o.target, label: translate("Target {v} %", { v: fmt(o.target, 0) }) }] : undefined,
      },
      {
        key: "yf",
        title: translate("Specific yield Yf (kWh/kWp)"),
        series: [
          {
            key: "yf",
            name: translate("Specific yield Yf"),
            color: SERIES.secondary,
            type: "bar",
            y: at.map((r) => r?.yf_kwh_kwp ?? null),
            format: (v) => `${fmt(v, 2)} kWh/kWp`,
          },
        ],
      },
    ],
  };
};

export interface PrHistorySummary {
  /** Σ Yf ÷ Σ Yr × 100 over the days with an IEC PR, a Yf and a Yr > 0 and no suspect sensor
   * (= the period's energy-weighted IEC PR, since each day's PR is Yf ÷ Yr); null when none */
  periodPr: number | null;
  /** days the period PR rests on */
  prDays: number;
  /** days with an IEC PR whose sensor was judged suspect (left out of the period PR) */
  suspectDays: number;
  /** calendar days in the period */
  totalDays: number;
  /** stored plant-days in the period */
  storedDays: number;
  /** mean Yf over the stored days that have one */
  meanYf: number | null;
  /** Σ energy over the stored days that have one (kWh) */
  energyKwh: number | null;
  /** no stored day has an IEC PR (no weather sensor, or it never covered the day) */
  noPr: boolean;
}

export const prHistorySummary = (rows: PlantKpiDay[], totalDays: number): PrHistorySummary => {
  let yf = 0;
  let yr = 0;
  let prDays = 0;
  let suspectDays = 0;
  let yfSum = 0;
  let yfN = 0;
  let e = 0;
  let eN = 0;
  for (const r of rows) {
    if (r.pr_pct != null && suspect(r)) suspectDays++;
    else if (r.pr_pct != null && r.yf_kwh_kwp != null && r.yr_h != null && r.yr_h > 0) {
      yf += r.yf_kwh_kwp;
      yr += r.yr_h;
      prDays++;
    }
    if (r.yf_kwh_kwp != null) (yfSum += r.yf_kwh_kwp), yfN++;
    if (r.energy_kwh != null) (e += r.energy_kwh), eN++;
  }
  return {
    periodPr: prDays && yr > 0 ? (yf / yr) * 100 : null,
    prDays,
    suspectDays,
    totalDays,
    storedDays: rows.length,
    meanYf: yfN ? yfSum / yfN : null,
    energyKwh: eN ? e : null,
    noPr: rows.length > 0 && rows.every((r) => r.pr_pct == null),
  };
};
