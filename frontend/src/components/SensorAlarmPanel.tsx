/**
 * Active Alarm: weather sensors that need attention. Kept apart from the Growatt alarm log
 * (that log is SQL history with Growatt's own times; sensor online state is live only).
 *
 * - Today: sensors the live sweep found `offline` / `late`, plus sensors with a health flag.
 *   A sensor not checked yet is never listed as offline.
 * - Past day: online state does not exist for a past day, so it lists sensors whose stored
 *   daylight coverage was below `meta.alarm_coverage_pct` that day ("Data gaps").
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, CloudOff, Gauge } from "lucide-react";
import { api } from "../api/client";
import type { GrowattLive, SensorList, SensorLiveStatus } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { plantPath } from "../context/routes";
import { EmptyState, LoadingState, Panel, StatusBadge, fmt, fmtInt } from "./ui";
import { FlagChips, STATUS_VIEW, overlay } from "./sensorView";
import type { ViewRow } from "./sensorView";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** DB list re-read while today is shown: the worker stores new readings every 30 min. */
const REFRESH_MS = 5 * 60_000;
export const SENSOR_PANEL_ID = "weather-sensors";

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

const fmtUpload = (ts: string | null, today: string) => (ts ? (ts.slice(0, 10) === today ? ts.slice(11, 16) : ts.slice(0, 16)) : "—");

export const SensorAlarmPanel: React.FC<{ alarms: SensorAlarms; day: string; plantFilter: number | null }> = ({ alarms, day, plantFilter }) => {
  const a = alarms;
  const rows = plantFilter == null ? a.rows : a.rows.filter((s) => s.plant_id === plantFilter);
  const total = plantFilter == null ? a.sensors.length : a.sensors.filter((s) => s.plant_id === plantFilter).length;
  const subtitle = a.isToday
    ? `Live: offline or late, plus health flags · offline → late → flags, longest silent first${a.sweeping ? ` · status checked for ${fmtInt(a.checked)} / ${fmtInt(a.sensors.length)} sensors` : ""}`
    : `Data gaps (stored readings): daylight coverage 06:00–18:00 below ${fmt(a.threshold, 0)}% on ${day} · history, not a live state`;

  return (
    <Panel
      icon={Gauge}
      title="Weather sensors"
      subtitle={`${subtitle}${a.error ? ` · list failed: ${a.error}` : ""}${a.liveError ? ` · live check failed: ${a.liveError}` : ""}`}
      bodyClassName="p-0"
      actions={
        <Link to={`/sensors${a.isToday ? "?status=offline" : ""}`} className="text-xs text-solar-300 hover:text-solar-200">
          All sensors →
        </Link>
      }
    >
      <div id={SENSOR_PANEL_ID} className="scroll-mt-20" />
      {a.loading && !a.sensors.length ? (
        <LoadingState label="Loading weather sensors…" />
      ) : a.error && !a.sensors.length ? (
        <EmptyState icon={CloudOff} title="Sensor list unavailable" description={a.error} className="py-8" />
      ) : !total ? (
        <EmptyState icon={Gauge} title="No weather sensors" description="No visible plant has a Growatt weather sensor." className="py-8" />
      ) : !rows.length ? (
        <EmptyState
          icon={CheckCircle2}
          title={a.isToday ? (a.sweeping ? "Nothing found yet" : "All sensors fine") : "No data gaps"}
          description={
            a.isToday
              ? a.sweeping
                ? `No offline, late or flagged sensor among the ${fmtInt(a.checked)} checked so far; the live check is still running.`
                : `All ${fmtInt(total)} sensors are online with no health flag.`
              : `Every sensor stored at least ${fmt(a.threshold, 0)}% of the daylight slots on ${day}.`
          }
          className="py-8"
        />
      ) : (
        <Table containerClassName="max-h-[420px] overflow-auto">
          <TableHeader className="sticky top-0 z-10">
            <TableRow>
              <TableHead>{a.isToday ? "Status" : "Coverage"}</TableHead>
              <TableHead>Plant</TableHead>
              <TableHead>Sensor</TableHead>
              <TableHead>{a.isToday ? "Last upload" : "Newest stored"}</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => {
              const st = STATUS_VIEW[s.st];
              return (
                <TableRow key={s.key}>
                  <TableCell>
                    {a.isToday ? (
                      <StatusBadge status={st.label} level={st.level} />
                    ) : (
                      <Badge variant={s.coverage_pct === 0 ? "crit" : "warn"} className="num px-2 py-0.5 text-[11px] font-semibold">
                        {fmt(s.coverage_pct, 0)}%
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[240px]">
                    <Link
                      to={`${plantPath(s.plant_id, "generation")}#weather-station`}
                      className="block truncate text-slate-200 hover:text-solar-300"
                      title={s.plant_name}
                    >
                      {s.plant_name}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Link to={`/sensors?tab=info&sensor=${encodeURIComponent(s.key)}`} className="num text-slate-300 hover:text-solar-300">
                      {s.datalogger_sn}#{s.address}
                    </Link>
                  </TableCell>
                  <TableCell
                    className="num whitespace-nowrap text-slate-300"
                    title={a.isToday && s.uploadLive ? `Last upload to Growatt ${s.upload}` : s.last_reading_at ? `Newest stored reading ${s.last_reading_at}` : undefined}
                  >
                    {fmtUpload(a.isToday ? s.upload : s.last_reading_at, day)}
                    {a.isToday && s.upload && <span className="ml-1 text-[11px] text-slate-500">{s.uploadLive ? "live" : "last sync"}</span>}
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    <FlagChips flags={s.allFlags} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
};
