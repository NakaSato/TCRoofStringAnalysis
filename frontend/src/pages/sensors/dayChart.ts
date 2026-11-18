/** A sensor's day chart: `sensorDaySpec` and the plant AC power it can add. */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { GrowattPlantOverview, GrowattWeatherPoint, GrowattWeatherField } from "../../api/client";
import { fmt } from "../../components/ui";
import type { ChartSeries, PanelChartSpec, XBand, XMarker } from "../../components/PanelChart";
import { CATEGORICAL, SERIES, STATUS } from "../../components/chartTheme";
import { minutesBetween, compass } from "./format";

/** Default x range of a sensor's day chart (plant-local), so days line up and today shows what is left. */
const CHART_START = "05:00";

const CHART_END = "19:00";

/** Irradiance axis reaches at least this, so a dull day looks dull next to a bright one. */
export const IRR_AXIS_MIN = 1200;

/** Today: no record for longer than this before "now" is shaded as a gap. */
const TRAILING_GAP_MIN = 20;

const WIND_TICK = ["N", "E", "S", "W", "N"];

/** Wind has no role colour; the free palette slot keeps it apart from AC power (cyan). */
const WIND_COLOR = CATEGORICAL[5];

/** The plant's stored 5-min AC curve for a day (the overview's `timeseries`) and its inverter count. */
type PlantPower = { ts: GrowattPlantOverview["timeseries"]; inverters: number };

/** Past days' curves, kept in tab memory (a past day only changes when the worker back-fills it). */
const powerCache = new Map<string, PlantPower>();

/**
 * Plant AC power for the sensor chart: today comes from the plant overview the plant pages
 * already hold (refreshed every 5 min); another day reads `/growatt/plants/{id}/overview?day=`
 * once. DB only. Null while loading, on error, or when the plant has nothing stored that day.
 */
export const usePlantPower = (plantId: number | undefined, day: string, today: string, ov: GrowattPlantOverview | null): PlantPower | null => {
  const ctx = ov && ov.plant.plant_id === plantId && (ov.meta.day ?? today) === day ? ov : null;
  const fromCtx = useMemo(() => (ctx ? { ts: ctx.timeseries, inverters: ctx.kpis.inverter_count } : null), [ctx]);
  const key = plantId == null ? "" : `${plantId}:${day}`;
  const [fetched, setFetched] = useState<{ key: string; v: PlantPower | null } | null>(null);
  const useCtx = Boolean(fromCtx);
  useEffect(() => {
    if (useCtx || !key || plantId == null) return;
    const hit = powerCache.get(key);
    if (hit) return setFetched({ key, v: hit });
    let cancelled = false;
    api
      .getGrowattPlantOverview(plantId, day)
      .then((o) => {
        const v = { ts: o.timeseries, inverters: o.kpis.inverter_count };
        if (day < today) powerCache.set(key, v);
        if (!cancelled) setFetched({ key, v });
      })
      .catch(() => !cancelled && setFetched({ key, v: null }));
    return () => {
      cancelled = true;
    };
  }, [key, useCtx, plantId, day, today]);
  return fromCtx ?? (fetched?.key === key ? fetched.v : null);
};

/**
 * The day chart of one sensor: fixed daylight x range (or the time window), stable y axes,
 * record gaps hatched, today's "now" marker with the rest of the day shaded, and the live
 * readings not stored yet in a band of their own. `all` = every fitted probe (else irradiance
 * and temperatures only).
 */
export const sensorDaySpec = (
  pts: GrowattWeatherPoint[],
  has: (f: GrowattWeatherField) => boolean,
  o: { day: string; from?: string; to?: string; now?: string | null; liveFrom?: number; all: boolean; power?: PlantPower | null }
): PanelChartSpec | null => {
  if (!pts.length) return null;
  const y = (f: GrowattWeatherField) => pts.map((p) => p[f]);
  const panels: PanelChartSpec["panels"] = [];
  const temps: ChartSeries[] = [];
  if (has("module_temp_c")) temps.push({ key: "mod", name: "Module temp", type: "line", color: SERIES.temp, y: y("module_temp_c"), unit: "°C" });
  if (has("ambient_temp_c")) temps.push({ key: "amb", name: "Ambient temp", type: "line", color: SERIES.ambient, width: 1.5, y: y("ambient_temp_c"), unit: "°C" });
  if (has("irradiance_wm2")) {
    const peak = Math.max(0, ...pts.map((p) => p.irradiance_wm2 ?? 0));
    panels.push({
      key: "g",
      title: "POA irradiance (W/m²)",
      weight: temps.length ? 1.4 : 1,
      yMin: 0,
      yMax: Math.max(IRR_AXIS_MIN, Math.ceil(peak / 200) * 200),
      series: [{ key: "g", name: "POA irradiance", type: "line", area: true, color: SERIES.irradiance, y: y("irradiance_wm2"), format: (v) => `${fmt(v, 0)} W/m²` }],
    });
  }
  // plant AC power on its own x (the plant's 5-min slots), under irradiance so the two shapes compare
  // (rows of the energy meter only, with no inverter record, carry no AC power: left out)
  const pw = (o.power?.ts ?? []).filter((r): r is typeof r & { pac_kw: number } => {
    const t = r.timestamp.slice(11, 16);
    return r.pac_kw != null && r.timestamp.slice(0, 10) === o.day && (!o.from || t >= o.from) && (!o.to || t <= o.to);
  });
  const fullCount = Math.max(0, ...pw.map((r) => r.inverters ?? 0));
  // only producing slots: at night a few inverters logging 0 kW says nothing about the sum
  const partial = (r: (typeof pw)[number]) => r.pac_kw > 0 && r.inverters != null && r.inverters < fullCount;
  if (o.all && pw.length) {
    const px = pw.map((r) => r.timestamp);
    const series: ChartSeries[] = [
      { key: "pac", name: "Plant AC power", type: "line", color: SERIES.ac, x: px, y: pw.map((r) => r.pac_kw), format: (v) => `${fmt(v, 1)} kW` },
    ];
    // a slot summed over fewer inverters than the day's usual count reads low: mark it, don't hide it
    if (pw.some(partial))
      series.push({
        key: "pacPart",
        name: "Not every inverter reported",
        type: "points",
        size: 6,
        color: STATUS.warn,
        x: px,
        y: pw.map((r) => (partial(r) ? r.pac_kw : null)),
        noTip: true,
      });
    panels.push({ key: "p", title: "Plant AC power (kW)", series });
  }
  if (temps.length) panels.push({ key: "t", title: "Temperature (°C)", zero: false, series: temps });
  if (o.all && has("humidity_pct"))
    panels.push({
      key: "h",
      title: "Humidity (%)",
      yMin: 0,
      yMax: 100,
      ticks: [0, 50, 100],
      series: [{ key: "h", name: "Humidity", type: "line", color: SERIES.secondary, y: y("humidity_pct"), format: (v) => `${fmt(v, 0)} %` }],
    });
  if (o.all && has("wind_speed_ms"))
    panels.push({ key: "w", title: "Wind speed (m/s)", series: [{ key: "w", name: "Wind speed", type: "line", color: WIND_COLOR, y: y("wind_speed_ms"), unit: "m/s" }] });
  if (o.all && has("wind_dir_deg"))
    panels.push({
      key: "d",
      title: "Wind direction",
      weight: 0.8,
      yMin: 0,
      yMax: 360,
      ticks: [0, 90, 180, 270, 360],
      tickFormat: (t) => WIND_TICK[Math.round(t / 90)] ?? "",
      series: [{ key: "d", name: "Wind direction", type: "points", size: 5, color: WIND_COLOR, y: y("wind_dir_deg"), format: (v) => `${fmt(v, 0)}° ${compass(v)}` }],
    });
  if (!panels.length) return null;

  // x range: the time window, else daylight; a "from" after "to" falls back to the default end
  const lo = o.from || CHART_START;
  const hi = o.to && o.to > lo ? o.to : CHART_END > lo ? CHART_END : "23:59";
  const at = (t: string) => `${o.day} ${t}:00`;
  const xDomain: [string, string] = [at(lo), at(hi)];
  const last = pts[pts.length - 1].timestamp;

  const bands: XBand[] = [];
  const markers: XMarker[] = [];
  if (o.liveFrom != null && o.liveFrom < pts.length)
    bands.push({ from: pts[Math.max(0, o.liveFrom - 1)].timestamp, to: last, label: "Live, not stored yet", kind: "live" });
  if (o.now && o.now.slice(0, 10) === o.day) {
    const now = o.now > last ? o.now : last;
    if (minutesBetween(last, now) > TRAILING_GAP_MIN) bands.push({ from: last, to: now, label: `No reading since ${last.slice(11, 16)}`, kind: "gap" });
    if (now < xDomain[1]) bands.push({ from: now, to: xDomain[1], label: "Later today", kind: "muted" });
    markers.push({ x: now, label: `Now ${now.slice(11, 16)}` });
  }

  const mod = y("module_temp_c");
  const amb = y("ambient_temp_c");
  const pwAt = new Map(pw.map((r) => [r.timestamp, r]));
  const total = o.power?.inverters ?? 0;
  const tipExtra = (i: number) => {
    const rows: Array<{ label: string; value: string }> = [];
    if (temps.length === 2 && mod[i] != null && amb[i] != null) rows.push({ label: "Module − ambient", value: `${fmt(mod[i]! - amb[i]!, 1)} °C` });
    const r = o.all ? pwAt.get(pts[i].timestamp) : undefined;
    if (r?.inverters != null && total && (r.inverters < total || r.held))
      rows.push({ label: "Inverters in AC", value: `${r.inverters} of ${total}${r.held ? ` · ${r.held} held ≤ 10 min` : ""}` });
    return rows;
  };
  return {
    xKind: "time",
    x: pts.map((p) => p.timestamp),
    xDomain,
    xStep: 5 * 60_000,
    gaps: "No data",
    bands,
    markers,
    panels,
    tipExtra,
  };
};
