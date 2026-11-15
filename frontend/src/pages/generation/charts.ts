/** Generation page: chart specs, built from the stored-day plant overview (DB only). */
import type { PanelChartSpec, RefLine, XBand, XMarker } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { IRR_AXIS_MIN } from "../sensors/dayChart";
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
 * amber, so a dip from a missing record is not read as a production dip. Also: the plant's rated AC
 * (sum of the inverters' nameplate, only when every inverter has one) to show clipping, the day's AC
 * peak as a point, the rest of today shaded, and per slot AC as % of clear-sky and DC → AC in the tooltip.
 *
 * `extra`: grid frequency in the tooltip. No load or consumption: the plants have no meter, so nothing measures it.
 */
export const powerSpec = (
  ov: Overview,
  now: string | null,
  o: {
    extra?: boolean;
    /** the curve to draw instead of `ov.timeseries` (e.g. with a live tail) */ ts?: PowerCurve["ts"];
    growatt?: PowerCurve["growatt"];
    /** add the weather sensor's POA irradiance as a second panel (only when the rows carry any) */
    irradiance?: boolean;
    /** add the energy meter: derived load in the power panel, grid import / export in its own panel */
    grid?: boolean;
  } = {}
): PanelChartSpec | null => {
  if (!ov.meta.day) return null;
  // rated AC: only a full sum, a partial one would draw the limit too low
  const rated = ov.inverters.map((i) => i.nominal_power_kw ?? null);
  const ratedKw = rated.length && rated.every((v) => v != null && v > 0) ? rated.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  return powerCurveSpec({ ts: o.ts ?? ov.timeseries, day: ov.meta.day, inverters: ov.inverters.length, ratedKw, growatt: o.growatt }, now, o);
};

/** A stored plant curve over one day or a day range, optionally a time-of-day window on every day. */
export interface PowerCurve {
  /** `live`: summed from the live records past the newest stored slot (memory only, not stored yet) */
  ts: Array<Omit<Overview["timeseries"][number], "module_temp_c" | "ambient_temp_c"> & { live?: boolean }>;
  day: string;
  /** last day of a range (null / same = one day) */
  endDay?: string | null;
  /** "HH:MM" window ("" = open end) */
  start?: string;
  end?: string;
  inverters: number;
  ratedKw: number | null;
  /** Growatt's own 5-min plant AC curve (`plant/power`, finished days only): drawn dashed on its own x */
  growatt?: Array<{ timestamp: string; pac_kw: number }>;
}

/** `powerSpec` for any stored period: the x axis spans the window (default 05:00–19:00) of the first to the last day. */
export const powerCurveSpec = (c: PowerCurve, now: string | null, o: { extra?: boolean; irradiance?: boolean; grid?: boolean } = {}): PanelChartSpec | null => {
  const { day, ratedKw } = c;
  const last = c.endDay && c.endDay > day ? c.endDay : day;
  const multi = last !== day;
  const total = c.inverters;
  const lo = c.start || (c.end && c.end <= "05:00" ? "00:00" : "05:00");
  const hi = c.end || (lo >= "19:00" ? "23:59" : "19:00");
  const begin = `${day} ${lo}:00`;
  const end = `${last} ${hi}:00`;
  // only the shown range: the stored day starts at 00:00 with night zeros, which would widen the axis
  const inRange = c.ts.filter((r) => r.timestamp >= begin && r.timestamp <= end);
  const ts = inRange;
  const gw = (c.growatt ?? []).filter((r) => r.timestamp >= begin && r.timestamp <= end);
  const growattSeries = gw.length
    ? [
        {
          key: "growatt",
          name: "Growatt curve (plant/power)",
          type: "line" as const,
          dash: "dash" as const,
          width: 1.5,
          color: SERIES.secondary,
          x: gw.map((r) => r.timestamp),
          y: gw.map((r) => r.pac_kw),
          unit: "kW",
        },
      ]
    : [];
  const markers: XMarker[] = [];
  const bands: XBand[] = [];
  if (now && now.slice(0, 10) >= day && now.slice(0, 10) <= last) {
    markers.push({ x: now, label: `Now ${now.slice(11, 16)}` });
    if (now < end) bands.push({ from: now, to: end, label: "Later today", kind: "muted" });
  }
  // the slots drawn from the live records: shaded and named, so they read as not stored yet
  const liveTs = ts.filter((r) => r.live);
  if (liveTs.length) bands.push({ from: liveTs[0].timestamp, to: liveTs[liveTs.length - 1].timestamp, label: "Live · not stored yet", kind: "live" });
  const refLines: RefLine[] = ratedKw ? [{ y: ratedKw, label: `Rated AC ${fmt(ratedKw, 0)} kW`, color: SERIES.reference }] : [];
  // nothing stored in the range: still the frame (axes, rated AC), so the card keeps its shape
  if (!ts.length)
    return {
      xKind: "time",
      x: [begin, end],
      xDomain: [begin, end],
      frame: true,
      markers,
      bands,
      // the same legend as with data, so the chart keeps its height
      panels: [
        {
          key: "p",
          title: "Power (kW)",
          yMin: 0,
          refLines,
          series: [
            { key: "ref", name: "Clear-sky envelope (modelled)", type: "line", dash: "dot", color: SERIES.reference, y: [null, null], unit: "kW" },
            { key: "dc", name: "DC input", type: "line", color: SERIES.dc, y: [null, null], unit: "kW" },
            { key: "ac", name: "AC output", type: "line", color: SERIES.ac, y: [null, null], unit: "kW" },
            ...growattSeries,
          ],
        },
      ],
    };
  const partial = ts.map((r) => (r.inverters != null && total && r.inverters < total && r.pac_kw > 0 ? r.pac_kw : null));
  let pk = -1;
  ts.forEach((r, i) => {
    if (r.pac_kw > 0 && (pk < 0 || r.pac_kw > ts[pk].pac_kw)) pk = i;
  });
  const peak = ts.map((r, i) => (i === pk ? r.pac_kw : null));
  const pct = (a: number, b: number) => `${fmt((a / b) * 100, 0)} %`;
  // measured POA irradiance (weather sensor) under the power: a sensor-less plant or live rows have none
  const irr = ts.map((r) => r.irradiance_wm2 ?? null);
  const irrPeak = Math.max(0, ...irr.map((v) => v ?? 0));
  const irrPanels: PanelChartSpec["panels"] =
    o.irradiance && irr.some((v) => v != null)
      ? [
          {
            key: "g",
            title: "POA irradiance (W/m²)",
            yMin: 0,
            yMax: Math.max(IRR_AXIS_MIN, Math.ceil(irrPeak / 200) * 200),
            series: [
              {
                key: "g",
                name: "POA irradiance (sensor)",
                type: "line",
                area: true,
                color: SERIES.irradianceWithDc,
                y: irr,
                format: (v) => `${fmt(v, 0)} W/m²`,
              },
            ],
          },
        ]
      : [];
  // energy meter at the grid connection point: one signed line (+ import / − export) in its own
  // panel; load is not measured, it is PV AC + grid, drawn dashed and named "derived"
  const hasGrid = Boolean(o.grid) && ts.some((r) => r.grid_import_kw != null);
  const gridSigned = ts.map((r) => (r.grid_import_kw == null || r.grid_export_kw == null ? null : Math.round((r.grid_import_kw - r.grid_export_kw) * 100) / 100));
  const gridPanels: PanelChartSpec["panels"] = hasGrid
    ? [
        {
          key: "grid",
          title: "Grid at the meter (kW, + import / − export)",
          zero: true,
          refLines: [{ y: 0, label: "", color: SERIES.reference }],
          series: [
            {
              key: "grid",
              name: "Grid (meter)",
              type: "line",
              area: true,
              color: SERIES.grid,
              y: gridSigned,
              format: (v) => (v >= 0 ? `import ${fmt(v, 1)} kW` : `export ${fmt(-v, 1)} kW`),
            },
          ],
        },
      ]
    : [];
  const loadSeries = hasGrid
    ? [
        {
          key: "load",
          name: "Load (derived: PV + grid)",
          type: "line" as const,
          dash: "dash" as const,
          width: 1.75,
          color: SERIES.load,
          y: ts.map((r) => r.load_kw ?? null),
          unit: "kW",
        },
      ]
    : [];
  const at = (t: string) => (pk < 0 ? "" : multi ? `${Number(t.slice(8, 10))}/${Number(t.slice(5, 7))} ${t.slice(11, 16)}` : t.slice(11, 16));
  return {
    xKind: "time",
    x: ts.map((r) => r.timestamp),
    xDomain: [begin, end],
    xStep: 5 * 60_000,
    // over several days the nights (or the hours outside the window) are not missing data
    gaps: multi ? undefined : "No data",
    markers,
    bands,
    panels: [
      {
        key: "p",
        title: "Power (kW)",
        weight: irrPanels.length || gridPanels.length ? 2.2 : 1,
        refLines,
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
          ...growattSeries,
          ...loadSeries,
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
          ...(pk >= 0
            ? [
                {
                  key: "peak",
                  name: `Peak ${fmt(ts[pk].pac_kw, 1)} kW · ${at(ts[pk].timestamp)}`,
                  type: "points" as const,
                  symbol: "diamond" as const,
                  size: 8,
                  color: SERIES.ac,
                  y: peak,
                  noTip: true,
                },
              ]
            : []),
        ],
      },
      ...gridPanels,
      ...irrPanels,
    ],
    tipExtra: (i) => {
      const r = ts[i];
      const rows: Array<{ label: string; value: string }> = [];
      if (r.live) rows.push({ label: "Source", value: "Live records (not stored yet)" });
      if (r.expected_kw != null && r.expected_kw > 0 && r.pac_kw > 0) rows.push({ label: "AC of clear-sky (modelled)", value: pct(r.pac_kw, r.expected_kw) });
      // DC → AC only with real input: near dawn / dusk the ratio is noise
      if (r.ppv_kw > 0 && r.pac_kw > 0 && (!ratedKw || r.ppv_kw >= ratedKw * 0.05)) rows.push({ label: "DC → AC", value: pct(r.pac_kw, r.ppv_kw) });
      if (o.extra && r.freq_hz != null) rows.push({ label: "Grid frequency", value: `${fmt(r.freq_hz, 2)} Hz` });
      if (r.inverters != null && total && (r.inverters < total || r.held))
        rows.push({ label: "Inverters in sum", value: `${r.inverters} of ${total}${r.held ? ` · ${r.held} held ≤ 10 min` : ""}` });
      return rows;
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
