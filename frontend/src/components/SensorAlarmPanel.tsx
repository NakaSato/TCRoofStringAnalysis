/**
 * Active Alarm: weather sensors that need attention, shown as rows of the alarm table
 * (`ActiveAlarmPage` → `sensorEvents`). Sensor online state is live only, never stored.
 *
 * - Today: sensors the live sweep found `offline` / `late`, plus sensors with a health flag.
 *   A sensor not checked yet is never listed as offline.
 * - Past day: online state does not exist for a past day, so it lists sensors whose stored
 *   daylight coverage was below `meta.alarm_coverage_pct` that day ("Data gaps").
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { GrowattLive, SensorList, SensorLiveStatus } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { overlay } from "./sensorView";
import type { ViewRow } from "./sensorView";

/** DB list re-read while today is shown: the worker stores new readings every 30 min. */
const REFRESH_MS = 5 * 60_000;

const RANK: Record<string, number> = { offline: 0, late: 1 };

export interface SensorAlarms {
  isToday: boolean;
  /** every sensor of the day, live overlaid (today) */
  sensors: ViewRow[];
  /** the rows the panel lists (before the plant filter) */
  rows: ViewRow[];
  offline: number;
  late: number;
  flagged: number;
  gaps: number;
  threshold: number;
  /** dataloggers' sensors checked live / total (today only) */
  checked: number;
  sweeping: boolean;
  loading: boolean;
  error: string | null;
  liveError: string | null;
}

/** DB list for `day` + the live sweep (today only), shared by the KPI tile and the panel. */
export function useSensorAlarms(day: string, isToday: boolean): SensorAlarms {
  const [data, setData] = useState<SensorList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<GrowattLive<SensorLiveStatus> | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listSensors(undefined, day)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [day, isToday]);

  useEffect(() => {
    setData(null);
    load();
    if (!isToday) return;
    const id = window.setInterval(() => !document.hidden && load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load, isToday]);

  // same backend sweep as the Sensors page: opening both does not double Growatt calls
  useLivePoll(
    isToday && Boolean(data?.sensors.length),
    "sensors:all",
    () => api.getLiveSensorStatus(),
    (r) => {
      setLive(r);
      setLiveError(null);
    },
    (err) => setLiveError(err instanceof Error ? err.message : String(err))
  );

  return useMemo(() => {
    const byKey = new Map((isToday ? (live?.data.sensors ?? []) : []).map((l) => [l.key, l]));
    // only the list judged on `day` (a late answer for the previous day is dropped); a past
    // day has no live state
    const sensors = (data?.meta.day === day ? data.sensors : []).map((s) => overlay(s, byKey.get(s.key)));
    const threshold = data?.meta.alarm_coverage_pct ?? 80;
    const isGap = (s: ViewRow) => s.coverage_pct != null && s.coverage_pct < threshold;
    const rows = isToday
      ? sensors
          .filter((s) => s.st === "offline" || s.st === "late" || s.allFlags.length > 0)
          .sort(
            (a, b) =>
              (RANK[a.st] ?? 2) - (RANK[b.st] ?? 2) ||
              // longest silent first; no upload time at all = silent longest
              (a.upload ?? "").localeCompare(b.upload ?? "")
          )
      : sensors.filter(isGap).sort((a, b) => (a.coverage_pct ?? 0) - (b.coverage_pct ?? 0));
    const sweep = live?.data.sweep;
    return {
      isToday,
      sensors,
      rows,
      offline: sensors.filter((s) => s.st === "offline").length,
      late: sensors.filter((s) => s.st === "late").length,
      flagged: sensors.filter((s) => s.allFlags.length > 0).length,
      gaps: sensors.filter(isGap).length,
      threshold,
      checked: sensors.filter((s) => s.live?.checked_at != null).length,
      sweeping: isToday && (!live || (sweep != null && sweep.fresh < sweep.total)),
      loading,
      error,
      liveError,
    };
  }, [data, live, isToday, day, loading, error, liveError]);
}
