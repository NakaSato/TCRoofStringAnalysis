/** Live detail and the stored day of one weather sensor. */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { GrowattLive, GrowattWeatherDay, SensorLive } from "../../api/client";
import { useLivePoll } from "../../context/useLivePoll";
import type { ViewRow } from "../../components/sensorView";
import type { PanelChartSpec } from "../../components/PanelChart";
import { FIELDS } from "./format";
import { sensorDaySpec } from "./dayChart";

/** Seconds left until `at` (ms), ticking once a second while mounted. */
const useCountdown = (at: number | null) => {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at == null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [at]);
  return at == null ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
};

/** Live detail (polled on `refresh_in_s`, memory only) and today's stored series (DB) of one sensor. */
export const useSensorDetail = (sensor: ViewRow | null, now: string, dayArg?: string, win?: { start: string; end: string }) => {
  const [detail, setDetail] = useState<GrowattLive<SensorLive> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [stored, setStored] = useState<GrowattWeatherDay | null>(null);
  const [storedError, setStoredError] = useState<string | null>(null);
  const key = sensor?.key ?? "";
  const today = now.slice(0, 10);
  /** day of the stored series; default today */
  const day = dayArg && dayArg < today ? dayArg : today;

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setNextAt(null);
  }, [key]);

  useLivePoll(
    Boolean(sensor),
    key,
    () => api.getLiveSensor(sensor!.datalogger_sn, sensor!.address),
    (r) => {
      setDetail(r);
      setDetailError(null);
      setNextAt(Date.now() + (r.refresh_in_s ?? 60) * 1000);
    },
    (err) => setDetailError(err instanceof Error ? err.message : String(err))
  );
  const countdown = useCountdown(nextAt);

  // today's stored series of this sensor alone (DB), re-read with the page's list
  const plantId = sensor?.plant_id;
  const lastReading = sensor?.last_reading_at;
  const winStart = win?.start ?? "";
  const winEnd = win?.end ?? "";
  useEffect(() => {
    if (plantId == null || !key) return;
    let cancelled = false;
    setStoredError(null);
    api
      .getGrowattPlantWeather(plantId, day, winStart || winEnd ? { start: winStart || undefined, end: winEnd || undefined } : undefined, key)
      .then((r) => !cancelled && setStored(r))
      .catch((err) => {
        if (cancelled) return;
        setStored(null);
        setStoredError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [plantId, key, day, lastReading, winStart, winEnd]);

  const spec = useMemo<PanelChartSpec | null>(() => {
    const pts = stored?.meta.sensor && stored.meta.sensor.datalogger_sn === sensor?.datalogger_sn && stored.meta.sensor.address === sensor?.address ? stored.series : null;
    if (!pts?.length) return null;
    const measured = new Set(stored?.sensors.find((x) => x.datalogger_sn === sensor?.datalogger_sn && x.address === sensor?.address)?.measured ?? FIELDS);
    // irradiance always has a panel here (empty = "—"), as before
    return sensorDaySpec(pts, (f) => f === "irradiance_wm2" || measured.has(f), { day: stored!.meta.day ?? today, now: (stored!.meta.day ?? today) === today ? now : null, all: false });
  }, [stored, sensor?.datalogger_sn, sensor?.address, today, now]);

  return { detail, detailError, countdown, stored, storedError, spec, today, day };
};
