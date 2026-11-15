/**
 * The period the Plant Overview's top card shows (URL `day`, `to`, `from_t`, `to_t`): today by
 * default (the overview already held when its stored day is today), another whole day (its own overview, so PR and every
 * figure match the Generation page), or a day range and / or a time-of-day window
 * (`/growatt/plants/{id}/power`: curve + energy integrated from the 5-min records; no PR, which is
 * a whole-day figure). DB only; a period that includes today is re-read every 5 min while visible.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { GrowattPlantOverview, GrowattPlantPower } from "../../api/client";
import type { PanelChartSpec } from "../../components/PanelChart";
import { plantToday } from "../../context/alarmLogStore";
import { isWindowed, periodDayText, periodFromQuery, periodToQuery, windowText } from "../../components/stringDetail/period";
import type { StringPeriod } from "../../components/stringDetail/period";
import { useUrlState } from "@/lib/useUrlState";
import { powerCurveSpec, powerSpec } from "../generation/charts";
import type { PowerCurve } from "../generation/charts";
import type { LiveInverter } from "../inverters/shared";
import { withLiveTail } from "./liveTail";
import { withLiveMeter } from "./useLiveMeter";
import type { MeterPoint } from "./useLiveMeter";

const REFRESH_MS = 5 * 60_000;

export interface PeriodFigures {
  energyKwh: number | null;
  /** IEC 61724 PR when the plant's sensor gives one, else peer-relative; null for a range / window */
  prPct: number | null;
  prIec: boolean;
  peakKw: number | null;
  peakAt: string | null;
  specificKwhKwp: number | null;
  /** the day's tariff (energy-weighted, from that day's overview); null for a range / window */
  tariffThbPerKwh: number | null;
  /** Growatt's own kWh for the period (`plant/energy`, finished whole days only); null otherwise */
  growattKwh?: number | null;
  /** a Growatt day figure of the period was withheld as impossible (> 10 kWh/kWp) */
  growattImplausible?: boolean;
  /** energy meter at the grid point (null without meter readings): import / export measured,
   *  load derived (PV + grid). A whole day = the overview's kpis; a range / window = summed 5-min rows */
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  loadKwh: number | null;
}

/** kWh of one column of 5-min rows (kW × 5 min); null when no row carries it. */
const sumKwh = (rows: PowerCurve["ts"], key: "grid_import_kw" | "grid_export_kw" | "load_kw"): number | null => {
  const vs = rows.map((r) => r[key]).filter((v): v is number => v != null);
  return vs.length ? Math.round(vs.reduce((a, v) => a + v, 0) * (5 / 60) * 10) / 10 : null;
};

type Loaded = { key: string; ov?: GrowattPlantOverview; power?: GrowattPlantPower; error?: string };

export const usePowerPeriod = (ov: GrowattPlantOverview | null, liveAt: string | null, recs: LiveInverter[] = [], meterPts: MeterPoint[] = []) => {
  const [query, setQuery] = useUrlState();
  const period = periodFromQuery(query);
  const setPeriod = (p: StringPeriod) => setQuery(periodToQuery(p));
  const today = plantToday();
  const plantId = ov?.plant.plant_id ?? null;
  const ovDay = ov?.meta.day ?? null;

  const windowed = isWindowed(period);
  // default: today (plant-local), even when the newest stored day is older
  const day = period.day ?? today;
  const endDay = period.endDay && day && period.endDay > day ? period.endDay : null;
  const start = windowed ? period.start : "";
  const end = windowed ? period.end : "";
  /** "own" = the context's overview; "day" = another whole day's overview; "curve" = /power */
  const mode: "own" | "day" | "curve" = !day || (day === ovDay && !endDay && !windowed) ? "own" : !endDay && !windowed ? "day" : "curve";
  const key = mode === "own" || plantId == null ? null : `${plantId}|${mode}|${day}|${endDay ?? ""}|${start}|${end}`;
  const live = Boolean(day && (endDay ?? day) >= today);

  const [res, setRes] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!key || !day || plantId == null) return;
    let cancelled = false;
    const load = () => {
      setLoading(true);
      const req =
        mode === "day"
          ? api.getGrowattPlantOverview(plantId, day).then((o): Loaded => ({ key, ov: o }))
          : api.getGrowattPlantPower(plantId, { day, end_day: endDay, start, end }).then((p): Loaded => ({ key, power: p }));
      req
        .then((r) => !cancelled && setRes(r))
        .catch((e) => !cancelled && setRes({ key, error: e instanceof Error ? e.message : String(e) }))
        .finally(() => !cancelled && setLoading(false));
    };
    load();
    const id = live ? window.setInterval(() => !document.hidden && load(), REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
    };
  }, [key, mode, plantId, day, endDay, start, end, live]);

  // a finished single day shown from an overview: Growatt's own curve and kWh read alongside
  // (`records=false`: no stored records read twice). Today has none (finished days only).
  const gKey = mode !== "curve" && day && day < today && plantId != null ? `${plantId}|${day}` : null;
  const [gRes, setGRes] = useState<{ key: string; power: GrowattPlantPower | null } | null>(null);
  useEffect(() => {
    if (!gKey || !day || plantId == null) return;
    let cancelled = false;
    api
      .getGrowattPlantPower(plantId, { day, records: "false" })
      .then((p) => !cancelled && setGRes({ key: gKey, power: p }))
      .catch(() => !cancelled && setGRes({ key: gKey, power: null }));
    return () => {
      cancelled = true;
    };
  }, [gKey, plantId, day]);

  const got = res?.key === key ? res : null;
  const dayOv = mode === "own" ? ov : (got?.ov ?? null);
  const power = got?.power ?? null;
  // Growatt's own figures of the shown period: from /power in curve mode, else the side request
  const gPower = mode === "curve" ? power : gRes?.key === gKey ? gRes.power : null;
  const growattTs = windowed ? undefined : gPower?.growatt_timeseries;

  const answered = mode === "own" || got != null;
  // today's whole day: the stored curve continued with the live records past its newest slot
  const liveDay = Boolean(dayOv && dayOv.meta.day === today);
  const ts = useMemo(
    () =>
      dayOv && liveDay
        ? withLiveMeter(withLiveTail(dayOv.timeseries, recs, today, dayOv.kpis.capacity_kwp ?? null), meterPts, today)
        : (dayOv?.timeseries ?? null),
    [dayOv, liveDay, recs, meterPts, today]
  );
  // each inverter's own today's yield from its live record, only when every inverter has one
  const liveYield = useMemo(() => {
    if (!dayOv || !liveDay) return null;
    const todays = recs.filter((r) => r.timestamp?.slice(0, 10) === today && r.eac_today_kwh != null);
    const n = dayOv.inverters.length;
    return n && todays.length >= n ? todays.reduce((a, r) => a + (r.eac_today_kwh ?? 0), 0) : null;
  }, [dayOv, liveDay, recs, today]);
  const spec = useMemo<PanelChartSpec | null>(() => {
    const ratedKw = power?.rated_ac_kw ?? null;
    // answered without a curve (error, or a day the backend has no records for): the empty frame
    const frame = () => (day ? powerCurveSpec({ ts: [], day, endDay, start, end, inverters: 0, ratedKw }, liveAt) : null);
    if (dayOv) return powerSpec(dayOv, liveAt, { extra: true, irradiance: true, grid: true, ts: ts ?? undefined, growatt: growattTs }) ?? frame();
    if (!power) return answered ? frame() : null;
    return powerCurveSpec(
      {
        ts: power.timeseries,
        day: power.meta.day,
        endDay: power.meta.end_day,
        start,
        end,
        inverters: power.inverter_count,
        ratedKw: power.rated_ac_kw,
        kwp: ov?.kpis.capacity_kwp ?? null,
        growatt: growattTs,
      },
      liveAt,
      { extra: true, irradiance: true, grid: true }
    );
  }, [dayOv, ts, power, liveAt, start, end, day, endDay, answered, growattTs, ov]);

  // Growatt's figure covers whole days: only without a time window, and only when every day has one
  const gDaily = gPower?.daily ?? null;
  const growattKwh = useMemo(() => {
    const gs = (gDaily ?? []).map((d) => d.growatt_energy_kwh ?? null);
    return !windowed && gs.length && gs.every((v) => v != null) ? gs.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  }, [gDaily, windowed]);
  const growattImplausible = Boolean(gDaily?.some((d) => d.growatt_implausible));

  const figures = useMemo<PeriodFigures | null>(() => {
    const rows: PowerCurve["ts"] | undefined = ts ?? power?.timeseries;
    if (!rows) return null;
    const pk = rows.reduce<(typeof rows)[number] | null>((m, r) => ((r.pac_kw ?? 0) > 0 && (m == null || (r.pac_kw ?? 0) > (m.pac_kw ?? 0)) ? r : m), null);
    if (dayOv) {
      const k = dayOv.kpis;
      const iec = k.iec_pr_pct ?? null;
      const kwp = k.capacity_kwp ?? null;
      // a live peak past the stored records beats the stored one
      const livePeak = Boolean(pk?.live && pk.pac_kw != null && (k.peak_power_kw == null || pk.pac_kw > k.peak_power_kw));
      // the time goes with the figure shown: the live slot's, else the stored curve's own peak slot
      const storedPk = livePeak
        ? null
        : rows.reduce<(typeof rows)[number] | null>((m, r) => (!r.live && (r.pac_kw ?? 0) > 0 && (m == null || (r.pac_kw ?? 0) > (m.pac_kw ?? 0)) ? r : m), null);
      // a live total older than the newest stored sync never shows less than the stored one
      const yieldKwh =
        liveYield != null && (k.yield_today_kwh == null || liveYield > k.yield_today_kwh) ? liveYield : k.yield_today_kwh;
      const yieldIsLive = yieldKwh != null && yieldKwh === liveYield && yieldKwh !== k.yield_today_kwh;
      return {
        energyKwh: yieldKwh,
        // PR stays the stored day's: a whole-day figure from stored records
        prPct: iec ?? k.plant_pr_pct,
        prIec: iec != null,
        peakKw: livePeak && pk ? pk.pac_kw : k.peak_power_kw,
        peakAt: livePeak ? (pk?.timestamp ?? null) : k.peak_power_kw != null ? (storedPk?.timestamp ?? null) : null,
        specificKwhKwp: yieldIsLive ? (kwp ? yieldKwh / kwp : null) : k.specific_yield_kwh_per_kwp,
        tariffThbPerKwh: k.tariff_thb_per_kwh,
        growattKwh,
        growattImplausible,
        gridImportKwh: k.grid_import_kwh ?? null,
        gridExportKwh: k.grid_export_kwh ?? null,
        loadKwh: k.load_kwh ?? null,
      };
    }
    const es = power!.daily.map((d) => d.energy_kwh).filter((v): v is number => v != null);
    const energy = es.length ? es.reduce((a, v) => a + v, 0) : null;
    const kwp = ov?.kpis.capacity_kwp ?? null;
    return {
      energyKwh: energy,
      prPct: null,
      prIec: false,
      peakKw: pk?.pac_kw ?? null,
      peakAt: pk?.timestamp ?? null,
      specificKwhKwp: energy != null && kwp ? energy / kwp : null,
      tariffThbPerKwh: null,
      growattKwh,
      growattImplausible,
      gridImportKwh: sumKwh(rows, "grid_import_kw"),
      gridExportKwh: sumKwh(rows, "grid_export_kw"),
      loadKwh: sumKwh(rows, "load_kw"),
    };
  }, [dayOv, ts, liveYield, power, ov, growattKwh, growattImplausible]);

  const multi = Boolean(endDay);
  const win = windowText(period);
  /** what the figures cover: "12 Nov", "6–12 Nov", "12 Nov · 10:00–12:00" */
  const label = day ? `${periodDayText(day, endDay, today)}${win ? ` · ${win}` : ""}` : "—";

  return {
    period,
    setPeriod,
    today,
    ovDay,
    day,
    multi,
    mode,
    label,
    spec,
    figures,
    /** the request for a picked period is running (or has not answered yet) */
    loading: loading || (key != null && !got),
    error: got?.error ?? null,
  };
};
