/**
 * Today's POA irradiance from the plant's weather sensor(s) for the Production chart's slots the
 * worker has not stored yet: `/growatt/live/sensors/{dl}/{addr}/today` (Growatt's `env_data` of
 * today in 5-min slots, memory only; the same cache the Weather sensor card reads, so no extra
 * Growatt calls). Several sensors are averaged per slot, as the backend does for the stored day.
 * Measured, never stored; polled only while today is shown.
 */
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { GrowattLive, GrowattPlantOverview, SensorToday } from "../../api/client";
import { useLivePoll } from "../../context/useLivePoll";
import type { PowerCurve } from "../generation/charts";

type Row = PowerCurve["ts"][number];
export type IrrPoint = { timestamp: string; irradiance_wm2: number };

export const useLiveIrradiance = (ov: GrowattPlantOverview | null, on: boolean): IrrPoint[] => {
  const sensors = ov?.weather?.has_sensor ? (ov.weather.sensors ?? []) : [];
  const key = sensors.map((s) => `${s.datalogger_sn}:${s.address}`).join(",");
  const [pts, setPts] = useState<IrrPoint[]>([]);
  useEffect(() => setPts([]), [key]);
  useLivePoll(
    on && sensors.length > 0,
    key,
    async (): Promise<GrowattLive<SensorToday[]>> => {
      const rs = await Promise.allSettled(sensors.map((s) => api.getLiveSensorToday(s.datalogger_sn, s.address)));
      const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!ok.length) throw (rs[0] as PromiseRejectedResult).reason;
      const refresh = ok.map((r) => r.refresh_in_s).filter((v): v is number => v != null);
      return { ...ok[0], refresh_in_s: refresh.length ? Math.min(...refresh) : undefined, data: ok.map((r) => r.data) };
    },
    (r) => {
      const bySlot = new Map<string, number[]>();
      for (const d of r.data)
        for (const p of d.series) if (p.irradiance_wm2 != null) bySlot.set(p.timestamp, [...(bySlot.get(p.timestamp) ?? []), p.irradiance_wm2]);
      setPts(
        [...bySlot.entries()]
          .map(([timestamp, vs]) => ({ timestamp, irradiance_wm2: Math.round((vs.reduce((a, v) => a + v, 0) / vs.length) * 10) / 10 }))
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      );
    },
    () => undefined // the stored irradiance stays; a failed poll adds nothing
  );
  return pts;
};

/**
 * The curve's rows with the live sensor irradiance in every slot of `day` that has none stored:
 * into the row of that slot, else a row of its own (PV unknown, null, never 0), flagged `live`.
 */
export const withLiveIrradiance = (rows: Row[], pts: IrrPoint[], day: string): Row[] => {
  if (!pts.length) return rows;
  const bySlot = new Map(pts.filter((p) => p.timestamp.slice(0, 10) === day).map((p) => [p.timestamp, p.irradiance_wm2]));
  if (!bySlot.size) return rows;
  const out = rows.map((r) => {
    const g = bySlot.get(r.timestamp);
    if (g == null) return r;
    bySlot.delete(r.timestamp);
    return r.irradiance_wm2 != null ? r : { ...r, irradiance_wm2: g };
  });
  for (const [timestamp, g] of bySlot)
    out.push({
      timestamp,
      pac_kw: null,
      ppv_kw: null,
      expected_kw: null,
      temp_c: null,
      freq_hz: null,
      irradiance_wm2: g,
      live: true,
    });
  return out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
};
