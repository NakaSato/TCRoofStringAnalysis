/** Generation page: chart specs, built from the stored-day plant overview (DB only). */
import type { PanelChartSpec, XMarker } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import type { GrowattPlantOverview } from "../../api/client";
import { invName } from "../inverters/shared";
import type { OverviewInverter } from "../inverters/shared";

type Overview = GrowattPlantOverview;

/** Colour of a PR value against the plant's target: at / within 5 pts / below. */
export const prColor = (v: number | null, target: number) =>
  v == null ? STATUS.none : v >= target ? STATUS.good : v >= target - 5 ? STATUS.warn : STATUS.crit;

/** Tailwind text class of the same three bands. */
export const prTone = (v: number | null, target: number) =>
  v == null ? "text-muted-foreground" : v >= target ? "text-emerald-300" : v >= target - 5 ? "text-amber-300" : "text-red-300";

/**
 * Plant power on the stored day: AC and DC (measured, summed over the inverters) and the
 * clear-sky envelope (modelled). Slots summed over fewer inverters than the plant has are dotted
 * amber, so a dip from a missing record is not read as a production dip.
 */
export const powerSpec = (ov: Overview, now: string | null): PanelChartSpec | null => {
  const ts = ov.timeseries;
  const day = ov.meta.day;
  if (ts.length === 0 || !day) return null;
  const total = ov.inverters.length;
  const partial = ts.map((r) => (r.inverters != null && total && r.inverters < total && r.pac_kw > 0 ? r.pac_kw : null));
  const markers: XMarker[] = [];
  if (now && now.slice(0, 10) === day) markers.push({ x: now, label: `Now ${now.slice(11, 16)}` });
  return {
    xKind: "time",
    x: ts.map((r) => r.timestamp),
    xDomain: [`${day} 05:00:00`, `${day} 19:00:00`],
    xStep: 5 * 60_000,
    gaps: "No data",
    markers,
    panels: [
      {
        key: "p",
        title: "Power (kW)",
        series: [
          {
            key: "ref",
            name: "Clear-sky envelope (modelled)",
            type: "line",
            dash: "dot",
            width: 1.5,
            color: SERIES.reference,
            y: ts.map((r) => r.expected_kw),
            unit: "kW",
          },
          { key: "dc", name: "DC input", type: "line", color: SERIES.dc, y: ts.map((r) => r.ppv_kw), unit: "kW" },
          { key: "ac", name: "AC output", type: "line", area: true, color: SERIES.ac, y: ts.map((r) => r.pac_kw), unit: "kW" },
          ...(partial.some((v) => v != null)
            ? [
                {
                  key: "partial",
                  name: "Fewer inverters in sum",
                  type: "points" as const,
                  size: 4,
                  color: STATUS.warn,
                  y: partial,
                  noTip: true,
                },
              ]
            : []),
        ],
      },
    ],
    tipExtra: (i) => {
      const r = ts[i];
      if (r.inverters == null || !total || (r.inverters >= total && !r.held)) return [];
      return [{ label: "Inverters in sum", value: `${r.inverters} of ${total}${r.held ? ` · ${r.held} held ≤ 10 min` : ""}` }];
    },
  };
};

const bandX = (inverters: OverviewInverter[]) => ({
  xKind: "band" as const,
  x: inverters.map((i) => i.device_sn),
  xTickLabel: (sn: string | number | Date) => {
    const inv = inverters.find((i) => i.device_sn === sn);
    return inv ? invName(inv) : String(sn);
  },
  xTipLabel: (sn: string | number | Date) => {
    const inv = inverters.find((i) => i.device_sn === sn);
    return inv?.alias ? `${inv.alias} · ${sn}` : String(sn);
  },
});

/** Per inverter: peer-relative PR (bars coloured against the target) above specific yield. */
export const inverterYieldSpec = (inverters: OverviewInverter[], target: number): PanelChartSpec | null => {
  if (inverters.length === 0) return null;
  const prs = inverters.map((i) => i.pr_pct);
  return {
    ...bandX(inverters),
    legend: [
      { label: `≥ target ${fmt(target, 0)} %`, color: STATUS.good, shape: "bar" },
      { label: "within 5 pts", color: STATUS.warn, shape: "bar" },
      { label: "below", color: STATUS.crit, shape: "bar" },
      { label: "Specific yield", color: SERIES.secondary, shape: "line" },
    ],
    panels: [
      {
        key: "pr",
        title: "Peer-relative PR (%)",
        weight: 1.4,
        yMin: 0,
        yMax: 105,
        tickSuffix: "%",
        refLines: [{ y: target, label: `Target ${fmt(target, 0)} %`, color: SERIES.reference }],
        series: [
          {
            key: "pr",
            name: "PR",
            type: "bar",
            color: STATUS.none,
            y: prs,
            colors: prs.map((v) => prColor(v, target)),
            format: (v) => `${fmt(v, 1)} %`,
          },
        ],
      },
      {
        key: "sy",
        title: "Specific yield (kWh/kWp)",
        series: [
          {
            key: "sy",
            name: "Specific yield",
            type: "line",
            color: SERIES.secondary,
            y: inverters.map((i) => i.specific_yield),
            format: (v) => `${fmt(v, 2)} kWh/kWp`,
          },
        ],
      },
    ],
  };
};

/** Per inverter: day average / peak temperature above DC→AC efficiency. */
export const inverterThermalSpec = (inverters: OverviewInverter[]): PanelChartSpec | null => {
  if (inverters.length === 0) return null;
  return {
    ...bandX(inverters),
    panels: [
      {
        key: "t",
        title: "Inverter temperature (°C)",
        weight: 1.4,
        tickSuffix: "°",
        series: [
          { key: "avg", name: "Avg temp", type: "bar", color: SERIES.ambient, y: inverters.map((i) => i.avg_temp_c), unit: "°C" },
          { key: "max", name: "Peak temp", type: "bar", color: SERIES.temp, y: inverters.map((i) => i.max_temp_c), unit: "°C" },
        ],
      },
      {
        key: "eff",
        title: "DC→AC efficiency (%)",
        zero: false,
        tickSuffix: "%",
        series: [
          {
            key: "eff",
            name: "Efficiency",
            type: "line",
            color: SERIES.secondary,
            y: inverters.map((i) => i.efficiency_pct),
            format: (v) => `${fmt(v, 2)} %`,
          },
        ],
      },
    ],
  };
};

/** Short axis labels of the backend's waterfall stages (full name stays in the tooltip). */
const STAGE_SHORT: Record<string, string> = {
  "POA Insolation × kWp (measured)": "Reference",
  "Nominal DC Reference": "Reference",
  "Optical & Soiling Loss": "Optical",
  "Thermal Derating Loss": "Thermal",
  "String & MPPT Mismatch": "Mismatch",
  "Inverter Conversion Loss": "Conversion",
  "Net AC Grid Export": "AC yield",
};

/** Loss breakdown (modelled): each loss floats down from the running total. */
export const waterfallSpec = (waterfall: Overview["loss_waterfall"]): PanelChartSpec | null => {
  if (waterfall.length === 0) return null;
  let running = 0;
  const y: number[] = [];
  const y0: number[] = [];
  for (const w of waterfall) {
    if (w.type === "loss") {
      y0.push(running + w.kwh);
      y.push(running);
      running += w.kwh;
    } else {
      y0.push(0);
      y.push(w.kwh);
      running = w.kwh;
    }
  }
  const base = waterfall[0]?.kwh || null;
  return {
    xKind: "band",
    x: waterfall.map((w) => w.stage),
    xTickLabel: (s) => STAGE_SHORT[String(s)] ?? String(s),
    legend: [
      { label: "Reference", color: SERIES.reference, shape: "bar" },
      { label: "Loss", color: STATUS.crit, shape: "bar" },
      { label: "AC yield (measured)", color: STATUS.good, shape: "bar" },
    ],
    panels: [
      {
        key: "e",
        title: "Energy (kWh)",
        series: [
          {
            key: "e",
            name: "Energy",
            type: "bar",
            color: SERIES.reference,
            y,
            y0,
            colors: waterfall.map((w) => (w.type === "base" ? SERIES.reference : w.type === "net" ? STATUS.good : STATUS.crit)),
            labels: waterfall.map((w) => fmt(Math.abs(w.kwh), 0)),
            noTip: true,
          },
        ],
      },
    ],
    tipExtra: (i) => {
      const w = waterfall[i];
      const rows = [{ label: w.type === "loss" ? "Loss" : "Energy", value: `${fmt(Math.abs(w.kwh), 1)} kWh` }];
      if (base) rows.push({ label: "Share of reference", value: `${fmt((Math.abs(w.kwh) / base) * 100, 1)} %` });
      return rows;
    },
  };
};
