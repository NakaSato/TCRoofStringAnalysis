/** One sensor's day chart: the stored day, plus (today only) the records Growatt holds that are not stored yet. */
import { useEffect, useMemo, useState } from "react";
import type { GrowattPlantOverview, GrowattWeatherField, GrowattWeatherPoint } from "../../api/client";
import type { PanelChartSpec } from "../../components/PanelChart";
import { FIELDS, slotOf } from "./format";
import { sensorDaySpec, usePlantPower } from "./dayChart";
import { useSensorDetail } from "./useSensorDetail";
import type { SensorRef } from "./useSensorDetail";

/** Live readings kept for the chart's tail (tab memory only): 24 × 5 min = 2 h. */
const TAIL_MAX = 24;

/**
 * Used by the Sensors tab and the Plant Overview. `dayArg` (default today) and the time window
 * pick what is stored (DB); `ov` = the plant overview the plant pages already hold (its AC curve
 * is drawn under irradiance).
 */
export const useSensorDayChart = (
  sensor: SensorRef | null,
  now: string,
  o: { day?: string; from?: string; to?: string; ov: GrowattPlantOverview | null }
) => {
  const windowed = Boolean(o.from || o.to);
  const reqWin = windowed ? { start: o.from ?? "", end: o.to ?? "" } : undefined;
  const det = useSensorDetail(sensor, now, o.day, reqWin);
  const { detail, stored, today, day, liveDay } = det;
  const power = usePlantPower(sensor?.plant_id, day, today, o.ov);

  // the stored day of this sensor alone (a response for another sensor / day / window is not shown)
  const dayStored =
    stored &&
    stored.meta.day === day &&
    stored.meta.sensor?.datalogger_sn === sensor?.datalogger_sn &&
    stored.meta.sensor?.address === sensor?.address &&
    (stored.meta.window?.start ?? "") === (reqWin?.start ?? "") &&
    (stored.meta.window?.end ?? "") === (reqWin?.end ?? "")
      ? stored
      : null;
  const pts = useMemo(() => dayStored?.series ?? [], [dayStored]);

  // Live tail: each newest reading the live poll brings (today only) is kept as a point until the
  // worker has stored that slot (the DB wins), so today's chart moves without waiting for a sync.
  const liveRd = detail?.data.reading ?? null;
  const [tail, setTail] = useState<GrowattWeatherPoint[]>([]);
  useEffect(() => setTail([]), [sensor?.key]);
  useEffect(() => {
    if (!liveRd || liveRd.timestamp.slice(0, 10) !== today) return;
    const ts = slotOf(liveRd.timestamp);
    setTail((prev) => {
      if (prev.some((p) => p.timestamp === ts)) return prev;
      const pt = { timestamp: ts } as GrowattWeatherPoint;
      FIELDS.forEach((f) => (pt[f] = liveRd[f] ?? null));
      return [...prev, pt].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-TAIL_MAX);
    });
  }, [liveRd, today]);
  const lastStoredTs = pts.length ? pts[pts.length - 1].timestamp : "";
  // today's records from Growatt (`env_data`, memory only) after the newest stored slot, plus
  // the `env_last_data` points newer than them; the DB wins for every slot it holds
  const tailPts = useMemo(() => {
    if (day !== today || !dayStored || windowed) return [];
    const bySlot = new Map<string, GrowattWeatherPoint>();
    for (const p of tail) bySlot.set(p.timestamp, p);
    for (const p of liveDay?.series ?? []) bySlot.set(p.timestamp, p); // a full env_data record beats a polled one
    return [...bySlot.values()]
      .filter((p) => p.timestamp > lastStoredTs && p.timestamp.slice(0, 10) === day)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [day, today, dayStored, windowed, tail, liveDay, lastStoredTs]);
  const chartPts = useMemo(() => (tailPts.length ? [...pts, ...tailPts] : pts), [pts, tailPts]);
  const dayMeasured = useMemo(
    () => new Set<GrowattWeatherField>(dayStored?.sensors.find((x) => x.datalogger_sn === sensor?.datalogger_sn && x.address === sensor?.address)?.measured ?? []),
    [dayStored, sensor?.datalogger_sn, sensor?.address]
  );
  const daySpec = useMemo<PanelChartSpec | null>(() => {
    // a lone live point draws nothing: wait for a second one (or for stored data)
    if (!chartPts.length || (!pts.length && chartPts.length < 2)) return null;
    // with nothing stored yet today, the live points alone decide which probes to draw
    const has = (f: GrowattWeatherField) => (dayMeasured.size ? dayMeasured.has(f) : chartPts.some((p) => p[f] != null));
    return sensorDaySpec(chartPts, has, {
      day,
      from: windowed ? o.from : undefined,
      to: windowed ? o.to : undefined,
      now: day === today ? now : null,
      liveFrom: tailPts.length ? pts.length : undefined,
      all: true,
      power,
    });
  }, [chartPts, dayMeasured, pts.length, tailPts.length, day, today, now, windowed, o.from, o.to, power]);

  return { ...det, dayStored, pts, tailPts, dayMeasured, daySpec, windowed };
};
