/** Generation page: chart specs, built from the stored-day plant overview (DB only). */
import type { PanelChartSpec, RefLine, XBand, XMarker } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { translate } from "../../i18n";
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

/** The plant's active power limit from the inverters' own setting (`settings.active_rate_pct`,
 * configured, not measured): Σ nameplate × limit %. Null unless every inverter has both and at least
 * one is limited below 100 %. `readAt` = the oldest read of those settings (UTC ISO). */
export const plantPowerLimit = (inverters: Overview["inverters"]): { kw: number; readAt: string | null } | null => {
  if (!inverters.length) return null;
  let kw = 0;
  let limited = false;
  let readAt: string | null = null;
  for (const i of inverters) {
    const pct = i.settings?.active_rate_pct ?? null;
    const nom = i.nominal_power_kw ?? null;
    if (pct == null || nom == null || !(nom > 0)) return null;
    if (pct < 100) limited = true;
    kw += (nom * Math.min(pct, 100)) / 100;
    const at = i.settings?.power_limit_read_at ?? i.settings?.read_at ?? null;
    if (at && (readAt == null || at < readAt)) readAt = at;
  }
  return limited ? { kw: Math.round(kw * 10) / 10, readAt } : null;
};

/**
 * Plant power on the stored day: AC and DC (measured, summed over the inverters) and the
 * clear-sky envelope (modelled). Slots summed over fewer inverters than the plant has are dotted
 * amber, so a dip from a missing record is not read as a production dip. Also: the plant's rated AC
 * (sum of the inverters' nameplate, only when every inverter has one) to show clipping, the day's AC
 * peak as a point, the rest of today shaded, and per slot AC as % of clear-sky and DC → AC in the tooltip.
 *
 * `extra`: grid frequency in the tooltip. `grid`: the energy meter's import / export and the load derived from it
 * (PV + grid, never measured), all in the power panel; a plant or day without meter records shows none.
 */
export const powerSpec = (
  ov: Overview,
  now: string | null,
  o: {
    extra?: boolean;
    /** the curve to draw instead of `ov.timeseries` (e.g. with a live tail) */ ts?: PowerCurve["ts"];
    growatt?: PowerCurve["growatt"];
    /** add the weather sensor's POA irradiance: as modelled kW (× kWp) in the power panel and as W/m² in its own panel */
    irradiance?: boolean;
    /** add the energy meter: grid import / export and the derived load in the power panel */
    grid?: boolean;
    /** draw the rated AC reference line (default true; the Plant Overview's Production chart leaves it out) */
    ratedLine?: boolean;
    /** draw the clear-sky envelope (modelled) and its tooltip row (default true; off on the Production chart) */
    clearSky?: boolean;
    /** time axis from the first to the last drawn slot instead of the fixed span (a picked time window is kept) */
    fitX?: boolean;
    /** power axis from the lowest to the highest value drawn instead of from 0 */
    fitY?: boolean;
  } & CurveViewOpts = {}
): PanelChartSpec | null => {
  if (!ov.meta.day) return null;
  // rated AC: only a full sum, a partial one would draw the limit too low
  const rated = ov.inverters.map((i) => i.nominal_power_kw ?? null);
  const ratedKw = rated.length && rated.every((v) => v != null && v > 0) ? rated.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  return powerCurveSpec(
    { ts: o.ts ?? ov.timeseries, day: ov.meta.day, inverters: ov.inverters.length, ratedKw, kwp: ov.kpis.capacity_kwp ?? null, growatt: o.growatt, limit: plantPowerLimit(ov.inverters) },
    now,
    o
  );
};

/** AC at or above this share of the power limit = curtailed slot (the decision rules' CLIP_FRACTION). */
const CURTAIL_AT = 0.98;

/** A stored plant curve over one day or a day range, optionally a time-of-day window on every day. */
export interface PowerCurve {
  /** `live`: summed from the live records past the newest stored slot (memory only, not stored yet) */
  ts: Array<
    Omit<Overview["timeseries"][number], "module_temp_c" | "ambient_temp_c" | "pac_kw" | "ppv_kw"> & {
      /** null only on a live meter row with no inverter record in its slot (PV not known, never 0) */
      pac_kw: number | null;
      ppv_kw: number | null;
      live?: boolean;
    }
  >;
  day: string;
  /** last day of a range (null / same = one day) */
  endDay?: string | null;
  /** "HH:MM" window ("" = open end) */
  start?: string;
  end?: string;
  inverters: number;
  ratedKw: number | null;
  /** DC capacity: turns POA irradiance into modelled kW (POA × kWp / 1000) in the power panel */
  kwp?: number | null;
  /** Growatt's own 5-min plant AC curve (`plant/power`, finished days only): drawn dashed on its own x */
  growatt?: Array<{ timestamp: string; pac_kw: number }>;
  /** the inverters' active power limit (setting, `plantPowerLimit`): a reference line, and the slots
   * at it (AC ≥ 98 % of the limit, as the decision rules' "limited") marked as curtailed */
  limit?: { kw: number; readAt: string | null } | null;
}

/** Plant Overview's Production chart options (the Generation page passes neither). */
export interface CurveViewOpts {
  /** draw the backend's `available_kw` as "Expected (modelled)" (kWp × POA × temperature × EPI factor,
   * capped at rated AC) instead of "Irradiance × kWp (modelled)"; slots without it are gaps */
  expected?: boolean;
  /** a single day without a time window: the x axis is fixed at 00:00–24:00 instead of fitted or the PV hours
   * (Plant Overview, today), so the rest of the day is shown as "Later today" */
  fullDay?: boolean;
  /** one panel only: the measured irradiance (W/m², another unit) goes to the tooltip instead of a
   * panel of its own, as a second y axis is never drawn (default: its own panel, Generation page) */
  singlePanel?: boolean;
}

/** "YYYY-MM-DD" → the next calendar day (date arithmetic in UTC, so no zone shifts it). */
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** `powerSpec` for any stored period: the x axis spans the window (default 05:00–19:00) of the first to the last day. */
export const powerCurveSpec = (
  c: PowerCurve,
  now: string | null,
  o: { extra?: boolean; irradiance?: boolean; grid?: boolean; ratedLine?: boolean; clearSky?: boolean; fitX?: boolean; fitY?: boolean } & CurveViewOpts = {}
): PanelChartSpec | null => {
  const { day, ratedKw } = c;
  const last = c.endDay && c.endDay > day ? c.endDay : day;
  const multi = last !== day;
  // `fullDay`: one whole day on a fixed 00:00–24:00 axis (no window picked); overrides `fitX`
  const fullDay = Boolean(o.fullDay) && !multi && !c.start && !c.end;
  const total = c.inverters;
  // the meter reads around the clock (night load comes all from the grid): with meter rows the
  // axis covers the whole day, so grid, PV and load are all shown; else PV hours 05:00–19:00
  const meterRows = Boolean(o.grid) && c.ts.some((r) => r.grid_import_kw != null || r.grid_export_kw != null);
  const lo = c.start || (fullDay || meterRows || (c.end && c.end <= "05:00") ? "00:00" : "05:00");
  const hi = c.end || (fullDay || meterRows || lo >= "19:00" ? "23:59" : "19:00");
  const begin = `${day} ${lo}:00`;
  const end = `${last} ${hi}:00`;
  // only the shown range: the stored day starts at 00:00 with night zeros, which would widen the axis
  // a row of the energy meter only (no inverter record, PV null) is drawn only with the grid series
  // a live sensor-only row (PV not known yet) is drawn for its irradiance
  const inRange = c.ts.filter((r) => r.timestamp >= begin && r.timestamp <= end && (meterRows || r.pac_kw != null || r.irradiance_wm2 != null));
  const ts = inRange;
  const gw = (c.growatt ?? []).filter((r) => r.timestamp >= begin && r.timestamp <= end);
  const growattSeries = gw.length
    ? [
        {
          key: "growatt",
          name: translate("Growatt curve (plant/power)"),
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
  // `fitX`: the axis spans the slots drawn (ours and Growatt's curve), not the fixed hours; a picked window stays as picked
  const drawn = [...ts.map((r) => r.timestamp), ...gw.map((r) => r.timestamp)].sort();
  const fit = !fullDay && Boolean(o.fitX) && !c.start && !c.end && drawn.length > 1;
  const x0 = fit ? drawn[0] : begin;
  const x1 = fit ? drawn[drawn.length - 1] : fullDay ? `${nextDay(day)} 00:00:00` : end;
  const markers: XMarker[] = [];
  const bands: XBand[] = [];
  if (now && now.slice(0, 10) >= day && now.slice(0, 10) <= last && now >= x0 && now <= x1) {
    markers.push({ x: now, label: translate("Now {t}", { t: now.slice(11, 16) }) });
    if (now < x1) bands.push({ from: now, to: x1, label: translate("Later today"), kind: "muted" });
  }
  // the slots drawn from the live records: shaded and named, so they read as not stored yet
  // one band per run of live rows, so any stored slot between them is not shaded as live
  ts.forEach((r, i) => {
    if (!r.live || ts[i - 1]?.live) return;
    let j = i;
    while (ts[j + 1]?.live) j++;
    bands.push({ from: r.timestamp, to: ts[j].timestamp, label: translate("Live · not stored yet"), kind: "live" });
  });
  const clearSky = o.clearSky !== false;
  const refLines: RefLine[] = ratedKw && o.ratedLine !== false ? [{ y: ratedKw, label: translate("Rated AC {v} kW", { v: fmt(ratedKw, 0) }), color: SERIES.reference }] : [];
  const limit = c.limit ?? null;
  if (limit)
    refLines.push({
      y: limit.kw,
      label: translate("Power limit {v} kW (inverter setting{read})", {
        v: fmt(limit.kw, 0),
        read: limit.readAt ? translate(", read {d}", { d: limit.readAt.slice(0, 10) }) : "",
      }),
      color: STATUS.warn,
    });
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
          title: translate("Power (kW)"),
          yMin: 0,
          refLines,
          series: [
            ...(clearSky
              ? [{ key: "ref", name: translate("Clear-sky envelope (modelled)"), type: "line" as const, dash: "dot" as const, color: SERIES.reference, y: [null, null], unit: "kW" }]
              : []),
            { key: "dc", name: translate("DC input"), type: "line", color: SERIES.dc, y: [null, null], unit: "kW" },
            { key: "ac", name: translate("AC output"), type: "line", color: SERIES.ac, y: [null, null], unit: "kW" },
            ...growattSeries,
          ],
        },
      ],
    };
  const partial = ts.map((r) => (r.inverters != null && total && r.inverters < total && (r.pac_kw ?? 0) > 0 ? r.pac_kw : null));
  // curtailment: slots where the plant's AC sits at the inverters' power limit (setting), kept to runs
  // of ≥ 2 slots so one passing value does not read as curtailment
  const atLimit = ts.map((r) => (limit && r.pac_kw != null && r.pac_kw >= limit.kw * CURTAIL_AT ? r.pac_kw : null));
  // the backend's curtailment estimate (sensor + meter / power limit): a band from the AC up to the
  // modelled available power where the plant was held back. Without any judged slot (no sensor)
  // the power-limit runs above are drawn instead
  const curtKw = ts.map((r) => (r.curtailed_kw != null && r.curtailed_kw > 0 && r.pac_kw != null ? r.curtailed_kw : null));
  const estimated = ts.some((r) => r.curtailed_kw != null);
  const curtailed = estimated
    ? ts.map(() => null)
    : atLimit.map((v, i) => (v != null && (atLimit[i - 1] != null || atLimit[i + 1] != null) ? v : null));
  const bandSeries = curtKw.some((v) => v != null)
    ? [
        {
          key: "curtailEst",
          name: translate("Curtailed (estimated)"),
          type: "line" as const,
          area: true,
          dash: "dash" as const,
          width: 1,
          color: STATUS.warn,
          y: ts.map((r, i) => (curtKw[i] == null ? null : Math.round(((r.pac_kw ?? 0) + (curtKw[i] ?? 0)) * 100) / 100)),
          y0: ts.map((r, i) => (curtKw[i] == null ? null : r.pac_kw)),
          noTip: true,
        },
      ]
    : [];
  let pk = -1;
  ts.forEach((r, i) => {
    const v = r.pac_kw ?? 0;
    if (v > 0 && (pk < 0 || v > (ts[pk].pac_kw ?? 0))) pk = i;
  });
  const peak = ts.map((r, i) => (i === pk ? r.pac_kw : null));
  const pkKw = pk >= 0 ? (ts[pk].pac_kw ?? 0) : 0;
  const pct = (a: number, b: number) => `${fmt((a / b) * 100, 0)} %`;
  // measured POA irradiance (weather sensor) under the power: a sensor-less plant or live rows have none
  const irr = ts.map((r) => r.irradiance_wm2 ?? null);
  const irrPeak = Math.max(0, ...irr.map((v) => v ?? 0));
  // the same irradiance as kW the array would give at STC efficiency (POA × kWp / 1000): modelled, so it
  // is drawn dashed in the reference colour; the measured W/m² stays in its own panel
  const kwp = c.kwp != null && c.kwp > 0 ? c.kwp : null;
  // `expected`: the backend's modelled available power (temperature and the plant's fitted factor in),
  // so a healthy plant's AC runs close to it; replaces the plain POA × kWp line
  const expKw = ts.map((r) => r.available_kw ?? null);
  const expSeries =
    o.expected && expKw.some((v) => v != null)
      ? [
          {
            key: "expected",
            name: translate("Expected (modelled)"),
            type: "line" as const,
            dash: "dash" as const,
            width: 1.25,
            opacity: 0.8,
            color: SERIES.reference,
            y: expKw,
            unit: "kW",
          },
        ]
      : [];
  const irrKwSeries =
    !o.expected && o.irradiance && kwp && irr.some((v) => v != null)
      ? [
          {
            key: "irrkw",
            name: translate("Irradiance × kWp (modelled)"),
            type: "line" as const,
            dash: "dash" as const,
            width: 1,
            opacity: 0.55,
            color: SERIES.reference,
            y: irr.map((v) => (v == null ? null : Math.round(((v * kwp) / 1000) * 100) / 100)),
            format: (v: number) => `${fmt(v, 1)} kW (POA × ${fmt(kwp, 0)} kWp)`,
          },
        ]
      : [];
  const irrPanels: PanelChartSpec["panels"] =
    o.irradiance && !o.singlePanel && irr.some((v) => v != null)
      ? [
          {
            key: "g",
            title: translate("POA irradiance (W/m²)"),
            yMin: 0,
            yMax: Math.max(IRR_AXIS_MIN, Math.ceil(irrPeak / 200) * 200),
            series: [
              {
                key: "g",
                name: translate("POA irradiance (sensor)"),
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
  // energy meter at the grid connection point, in the power panel (same unit): import and export as
  // measured; load is not measured, it is PV AC + grid, drawn dashed and named "derived"
  const hasGrid = meterRows && ts.some((r) => r.grid_import_kw != null || r.grid_export_kw != null);
  const gridSeries = hasGrid
    ? [
        {
          key: "imp",
          name: translate("Grid import (meter)"),
          type: "line" as const,
          width: 1.25,
          color: SERIES.grid,
          y: ts.map((r) => r.grid_import_kw ?? null),
          unit: "kW",
        },
        {
          key: "exp",
          name: translate("Grid export (meter)"),
          type: "line" as const,
          width: 1.25,
          color: SERIES.gridExport,
          y: ts.map((r) => r.grid_export_kw ?? null),
          unit: "kW",
        },
        {
          key: "load",
          name: translate("Load (derived: PV + grid)"),
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
    xDomain: [x0, x1],
    xStep: 5 * 60_000,
    // over several days the nights (or the hours outside the window) are not missing data
    gaps: multi ? undefined : translate("No data"),
    markers,
    bands,
    panels: [
      {
        key: "p",
        title: translate("Power (kW)"),
        weight: irrPanels.length ? 2.2 : 1,
        zero: o.fitY ? false : undefined,
        refLines,
        series: [
          ...(clearSky
            ? [
                {
                  key: "ref",
                  name: translate("Clear-sky envelope (modelled)"),
                  type: "line" as const,
                  dash: "dot" as const,
                  width: 1.5,
                  color: SERIES.reference,
                  y: ts.map((r) => r.expected_kw),
                  unit: "kW",
                },
              ]
            : []),
          { key: "dc", name: translate("DC input"), type: "line", width: 1.5, color: SERIES.dc, y: ts.map((r) => r.ppv_kw), unit: "kW" },
          { key: "ac", name: translate("AC output"), type: "line", area: true, width: 2.25, color: SERIES.ac, y: ts.map((r) => r.pac_kw), unit: "kW" },
          ...growattSeries,
          ...expSeries,
          ...irrKwSeries,
          ...gridSeries,
          ...bandSeries,
          ...(curtailed.some((v) => v != null)
            ? [
                {
                  key: "curtail",
                  name: translate("Curtailed (at power limit)"),
                  type: "line" as const,
                  width: 3.5,
                  color: STATUS.warn,
                  y: curtailed,
                  unit: "kW",
                },
              ]
            : []),
          ...(partial.some((v) => v != null)
            ? [
                {
                  key: "partial",
                  name: translate("Fewer inverters in sum"),
                  type: "points" as const,
                  size: 3,
                  opacity: 0.7,
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
                  name: translate("Peak {v} kW · {t}", { v: fmt(pkKw, 1), t: at(ts[pk].timestamp) }),
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
      ...irrPanels,
    ],
    tipExtra: (i) => {
      const r = ts[i];
      const rows: Array<{ label: string; value: string }> = [];
      if (r.live) rows.push({ label: translate("Source"), value: translate("Live records (not stored yet)") });
      const pac = r.pac_kw ?? 0;
      const ppv = r.ppv_kw ?? 0;
      if (r.pac_kw == null) rows.push({ label: "PV", value: translate("No inverter record in this slot") });
      // one panel: the irradiance is not drawn (another unit), so it is read here
      if (o.singlePanel && o.irradiance && r.irradiance_wm2 != null) rows.push({ label: translate("POA irradiance (sensor)"), value: `${fmt(r.irradiance_wm2, 0)} W/m²` });
      if (clearSky && r.expected_kw != null && r.expected_kw > 0 && pac > 0) rows.push({ label: translate("AC of clear-sky (modelled)"), value: pct(pac, r.expected_kw) });
      if (expSeries.length && r.available_kw != null && r.available_kw > 0 && pac > 0) rows.push({ label: translate("AC of expected (modelled)"), value: pct(pac, r.available_kw) });
      // DC → AC only with real input: near dawn / dusk the ratio is noise
      if (ppv > 0 && pac > 0 && (!ratedKw || ppv >= ratedKw * 0.05)) rows.push({ label: "DC → AC", value: pct(pac, ppv) });
      if (curtailed[i] != null && limit) rows.push({ label: translate("Curtailment"), value: translate("at the power limit ({v} kW, inverter setting)", { v: fmt(limit.kw, 0) }) });
      if (curtKw[i] != null) {
        rows.push({
          label: translate("Curtailed (estimated)"),
          value: `${fmt(curtKw[i], 1)} kW · ${r.curtailed_by === "power_limit" ? translate("AC at the power limit (inverter setting)") : translate("zero export: grid ≈ 0 kW, PV follows the load")}`,
        });
        rows.push({ label: translate("Available (modelled)"), value: `${fmt(r.available_kw, 1)} kW` });
      }
            if (o.extra && r.freq_hz != null) rows.push({ label: translate("Grid frequency"), value: `${fmt(r.freq_hz, 2)} Hz` });
      if (r.inverters != null && total && (r.inverters < total || r.held))
        rows.push({
          label: translate("Inverters in sum"),
          value: `${translate("{n} of {total}", { n: r.inverters, total })}${r.held ? ` · ${translate("{n} held ≤ 10 min", { n: r.held })}` : ""}`,
        });
      return rows;
    },
  };
};

/** Days in a period ("2026-11-01" … "2026-11-07" = 7). */
export const periodDays = (day: string, endDay: string | null) =>
  endDay && endDay > day ? Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000) + 1 : 1;

/** Longer periods than this are drawn as one bar per day instead of the 5-min curve. */
export const DAILY_BARS_AFTER_DAYS = 3;

/**
 * One bar per day of a `/power` answer (Plant Overview, ranges over `DAILY_BARS_AFTER_DAYS`): AC
 * energy integrated from the stored records, the day's curtailed kWh (estimated) stacked on top of
 * it, and Growatt's own day figure (`plant/energy`, finished days; not with a time window, which
 * it does not cover) as a diamond beside. A day without records has no bar, never a 0 one.
 */
export const dailyEnergySpec = (
  daily: Array<{ day: string; energy_kwh: number | null; growatt_energy_kwh?: number | null; curtailed_kwh?: number | null }>,
  o: { kwp: number | null; windowed: boolean; locale: string }
): PanelChartSpec | null => {
  if (!daily.length) return null;
  const days = daily.map((d) => d.day);
  const e = daily.map((d) => d.energy_kwh ?? null);
  const curt = daily.map((d) => (d.energy_kwh != null && d.curtailed_kwh != null && d.curtailed_kwh > 0 ? d.curtailed_kwh : null));
  const gw = o.windowed ? [] : daily.map((d) => d.growatt_energy_kwh ?? null);
  const kwp = o.kwp != null && o.kwp > 0 ? o.kwp : null;
  const short = (d: string | number) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(o.locale, { day: "numeric", month: "short" });
  return {
    xKind: "band",
    x: days,
    xTickLabel: (d) => short(d),
    xTipLabel: (d) => new Date(`${d}T00:00:00`).toLocaleDateString(o.locale, { weekday: "short", day: "numeric", month: "short" }),
    panels: [
      {
        key: "e",
        title: o.windowed ? translate("Energy in the time window (kWh)") : translate("Energy per day (kWh)"),
        stacked: true,
        yMin: 0,
        series: [
          { key: "e", name: translate("AC energy (stored records)"), type: "bar", color: SERIES.ac, y: e, unit: "kWh" },
          ...(curt.some((v) => v != null)
            ? [
                {
                  key: "curt",
                  name: translate("Curtailed (estimated)"),
                  type: "bar" as const,
                  color: STATUS.warn,
                  opacity: 0.7,
                  y: curt.map((v, i) => (v == null ? null : Math.round(((e[i] ?? 0) + v) * 10) / 10)),
                  y0: curt.map((v, i) => (v == null ? null : e[i])),
                  noTip: true,
                },
              ]
            : []),
          ...(gw.some((v) => v != null)
            ? [
                {
                  key: "gw",
                  name: translate("Growatt (plant/energy)"),
                  type: "points" as const,
                  symbol: "diamond" as const,
                  size: 7,
                  color: SERIES.secondary,
                  y: gw,
                  unit: "kWh",
                },
              ]
            : []),
        ],
      },
    ],
    tipExtra: (i) => {
      const rows: Array<{ label: string; value: string }> = [];
      if (e[i] == null) rows.push({ label: translate("AC energy (stored records)"), value: translate("No stored records") });
      if (e[i] != null && kwp) rows.push({ label: translate("Specific yield"), value: `${fmt((e[i] ?? 0) / kwp, 2)} kWh/kWp` });
      if (curt[i] != null) rows.push({ label: translate("Curtailed (estimated)"), value: `${fmt(curt[i], 1)} kWh` });
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
      { label: translate("≥ target {v} %", { v: fmt(target, 0) }), color: STATUS.good, shape: "bar" },
      { label: translate("within 5 pts"), color: STATUS.warn, shape: "bar" },
      { label: translate("below"), color: STATUS.crit, shape: "bar" },
      { label: translate("Specific yield"), color: SERIES.secondary, shape: "line" },
    ],
    panels: [
      {
        key: "pr",
        title: translate("Peer-relative PR (%)"),
        weight: 1.4,
        yMin: 0,
        yMax: 105,
        tickSuffix: "%",
        refLines: [{ y: target, label: translate("Target {v} %", { v: fmt(target, 0) }), color: SERIES.reference }],
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
        title: translate("Specific yield (kWh/kWp)"),
        series: [
          {
            key: "sy",
            name: translate("Specific yield"),
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
        title: translate("Inverter temperature (°C)"),
        weight: 1.4,
        tickSuffix: "°",
        series: [
          { key: "avg", name: translate("Avg temp"), type: "bar", color: SERIES.ambient, y: inverters.map((i) => i.avg_temp_c), unit: "°C" },
          { key: "max", name: translate("Peak temp"), type: "bar", color: SERIES.temp, y: inverters.map((i) => i.max_temp_c), unit: "°C" },
        ],
      },
      {
        key: "eff",
        title: translate("DC→AC efficiency (%)"),
        zero: false,
        tickSuffix: "%",
        series: [
          {
            key: "eff",
            name: translate("Efficiency"),
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
    xTickLabel: (s) => translate(STAGE_SHORT[String(s)] ?? String(s)),
    legend: [
      { label: translate("Reference"), color: SERIES.reference, shape: "bar" },
      { label: translate("Loss"), color: STATUS.crit, shape: "bar" },
      { label: translate("AC yield (measured)"), color: STATUS.good, shape: "bar" },
    ],
    panels: [
      {
        key: "e",
        title: translate("Energy (kWh)"),
        series: [
          {
            key: "e",
            name: translate("Energy"),
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
      const rows = [{ label: translate(w.type === "loss" ? "Loss" : "Energy"), value: `${fmt(Math.abs(w.kwh), 1)} kWh` }];
      if (base) rows.push({ label: translate("Share of reference"), value: `${fmt((Math.abs(w.kwh) / base) * 100, 1)} %` });
      return rows;
    },
  };
};
