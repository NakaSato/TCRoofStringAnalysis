/**
 * The period the Plant Overview's top card shows (URL `day`, `to`, `from_t`, `to_t`): the stored
 * day the overview already holds (default), another whole day (its own overview, so PR and every
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

const REFRESH_MS = 5 * 60_000;

export interface PeriodFigures {
  energyKwh: number | null;
  /** IEC 61724 PR when the plant's sensor gives one, else peer-relative; null for a range / window */
  prPct: number | null;
  prIec: boolean;
  peakKw: number | null;
  peakAt: string | null;
  specificKwhKwp: number | null;
}

type Loaded = { key: string; ov?: GrowattPlantOverview; power?: GrowattPlantPower; error?: string };

export const usePowerPeriod = (ov: GrowattPlantOverview | null, liveAt: string | null) => {
  const [query, setQuery] = useUrlState();
  const period = periodFromQuery(query);
  const setPeriod = (p: StringPeriod) => setQuery(periodToQuery(p));
  const today = plantToday();
  const plantId = ov?.plant.plant_id ?? null;
  const ovDay = ov?.meta.day ?? null;

  const windowed = isWindowed(period);
  const day = period.day ?? ovDay;
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

  const got = res?.key === key ? res : null;
  const dayOv = mode === "own" ? ov : (got?.ov ?? null);
  const power = got?.power ?? null;

  const answered = mode === "own" || got != null;
  const spec = useMemo<PanelChartSpec | null>(() => {
    const ratedKw = power?.rated_ac_kw ?? null;
    // answered without a curve (error, or a day the backend has no records for): the empty frame
    const frame = () => (day ? powerCurveSpec({ ts: [], day, endDay, start, end, inverters: 0, ratedKw }, liveAt) : null);
    if (dayOv) return powerSpec(dayOv, liveAt, { extra: true }) ?? frame();
    if (!power) return answered ? frame() : null;
    return powerCurveSpec(
      { ts: power.timeseries, day: power.meta.day, endDay: power.meta.end_day, start, end, inverters: power.inverter_count, ratedKw: power.rated_ac_kw },
      liveAt,
      { extra: true }
    );
  }, [dayOv, power, liveAt, start, end, day, endDay, answered]);

  const figures = useMemo<PeriodFigures | null>(() => {
    const ts = dayOv?.timeseries ?? power?.timeseries;
    if (!ts) return null;
    const pk = ts.reduce<(typeof ts)[number] | null>((m, r) => (r.pac_kw > 0 && (m == null || r.pac_kw > m.pac_kw) ? r : m), null);
    if (dayOv) {
      const k = dayOv.kpis;
      const iec = k.iec_pr_pct ?? null;
      return {
        energyKwh: k.yield_today_kwh,
        prPct: iec ?? k.plant_pr_pct,
        prIec: iec != null,
        peakKw: k.peak_power_kw,
        peakAt: pk?.timestamp ?? null,
        specificKwhKwp: k.specific_yield_kwh_per_kwp,
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
    };
  }, [dayOv, power, ov]);

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
