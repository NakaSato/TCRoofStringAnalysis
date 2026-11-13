import React, { useEffect, useMemo, useState } from "react";
import { Bell, CheckCircle2, CloudOff } from "lucide-react";
import { api, GrowattLive, GrowattLiveAlarms } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import type { StatusLevel } from "./ui";
import { EmptyState, LoadingState, Panel, StatusBadge } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Growatt's own fault_type label → badge colour. */
function alarmLevel(faultType: string | null): StatusLevel {
  const s = (faultType ?? "").toLowerCase();
  if (/fault|error|fail/.test(s)) return "crit";
  if (/warn/.test(s)) return "warn";
  return "info";
}

const DAYS = 7;

/** "2026-11-10 06:16:07" → "06:16" */
const hhmm = (t: string | null) => (t ? t.slice(11, 16) : "");

/** Plant-local "YYYY-MM-DD HH:MM:SS" pair → "1 h 05 min" / "12 min" / "<1 min"; "—" when unknown. */
function duration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = Date.parse(end.replace(" ", "T")) - Date.parse(start.replace(" ", "T"));
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

type LevelFilter = "all" | "crit" | "warn" | "info";
const LEVEL_LABEL: Record<LevelFilter, string> = { all: "All", crit: "Fault", warn: "Warning", info: "Other" };

/**
 * Fault log reported by Growatt for the plant's inverters over the last 7 days ending at the
 * overview's day (`device/max/alarm_data`), newest first. Read through the backend's memory cache; nothing is stored.
 */
export const GrowattAlarmLogPanel: React.FC<{
  plantId: number;
  plantName?: string | null;
  /** last plant-local day of the window: the overview's day (null = today) */
  day: string | null;
  /** show only this inverter's alarms (the plant log is cached per inverter-day, so this costs no extra calls) */
  deviceSn?: string | null;
  className?: string;
}> = ({ plantId, plantName, day, deviceSn = null, className = "" }) => {
  const [res, setRes] = useState<GrowattLive<GrowattLiveAlarms> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LevelFilter>("all");

  useEffect(() => {
    setRes(null);
    setError(null);
    setFilter("all");
  }, [plantId, day, deviceSn]);

  useLivePoll(
    true,
    `${plantId}|${day ?? ""}`,
    () => api.getGrowattLiveAlarms(plantId, day ?? undefined, DAYS),
    (r) => {
      setRes(r);
      setError(null);
    },
    (err) => setError(err instanceof Error ? err.message : String(err))
  );

  const alarms = useMemo(
    () =>
      (res?.data.alarms ?? [])
        .filter((a) => !deviceSn || a.device_sn === deviceSn)
        .map((a) => ({ a, lvl: alarmLevel(a.fault_type) })),
    [res, deviceSn]
  );
  const counts = useMemo(() => {
    const c: Record<LevelFilter, number> = { all: alarms.length, crit: 0, warn: 0, info: 0 };
    for (const { lvl } of alarms) if (lvl === "crit" || lvl === "warn" || lvl === "info") c[lvl] += 1;
    return c;
  }, [alarms]);
  // only offer the levels that occur; a filter on a level that vanished after a poll falls back to all
  const levels = (["crit", "warn", "info"] as const).filter((l) => counts[l] > 0);
  const active: LevelFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  const shown = active === "all" ? alarms : alarms.filter((x) => x.lvl === active);
  // "SN YYYY-MM-DD" keys → the inverters concerned
  const failed = [...new Set(Object.keys(res?.data.errors ?? {}).map((k) => k.split(" ")[0]))].filter(
    (sn) => !deviceSn || sn === deviceSn
  );
  const subject = deviceSn ? `inverter ${deviceSn}` : plantName ?? "this plant";
  const range = res ? `${res.data.from} → ${res.data.to}` : `last ${DAYS} days`;

  return (
    <Panel
      className={className}
      icon={Bell}
      title="Growatt Fault Log"
      subtitle={
        res
          ? `${alarms.length} alarm${alarms.length === 1 ? "" : "s"} reported by Growatt for ${subject} · ${range}`
          : `Alarms reported by Growatt for ${subject} · ${range}`
      }
      bodyClassName="p-0"
      actions={
        <div className="flex items-center gap-2">
          {levels.length > 1 && (
            <Tabs value={active} onValueChange={(v) => setFilter(v as LevelFilter)}>
              <TabsList>
                {(["all", ...levels] as LevelFilter[]).map((l) => (
                  <TabsTrigger key={l} value={l} className="px-2 py-1 text-[11px]">
                    {LEVEL_LABEL[l]}
                    <span className="num text-slate-500">{counts[l]}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {res?.stale && (
            <Badge variant="warn" title={res.error ?? undefined}>
              stale
            </Badge>
          )}
        </div>
      }
    >
      {!res && !error ? (
        <LoadingState label="Reading the Growatt fault log…" />
      ) : !res && error ? (
        <EmptyState icon={CloudOff} title="Growatt fault log unavailable" description={error} />
      ) : alarms.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No alarms reported"
          description={
            failed.length
              ? `Growatt reported no alarms, but some days could not be read for ${failed.join(", ")}.`
              : `Growatt reported no alarms for ${subject} in the last ${DAYS} days.`
          }
        />
      ) : (
        <>
          {shown.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={`No ${LEVEL_LABEL[active].toLowerCase()} alarms`}
              description={`Growatt reported ${alarms.length} other alarm${alarms.length === 1 ? "" : "s"} for ${subject}.`}
              className="py-8"
            />
          ) : (
            <Table containerClassName="max-h-[380px] overflow-auto">
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-[1%]">Type</TableHead>
                  <TableHead>Alarm</TableHead>
                  {!deviceSn && <TableHead>Inverter</TableHead>}
                  <TableHead className="text-right">Code</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map(({ a, lvl }, i) => (
                  <TableRow key={`${a.device_sn}-${a.start_time}-${a.alarm_code}-${i}`}>
                    <TableCell>
                      <StatusBadge status={a.fault_type ?? "—"} level={lvl} />
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <span className="block truncate font-medium text-slate-100" title={a.alarm_message ?? undefined}>
                        {a.alarm_message ?? "—"}
                      </span>
                    </TableCell>
                    {!deviceSn && <TableCell className="num whitespace-nowrap text-slate-300">{a.device_sn}</TableCell>}
                    <TableCell className="num text-right text-slate-400">{a.alarm_code ?? "—"}</TableCell>
                    <TableCell className="num whitespace-nowrap" title={a.start_time ?? undefined}>
                      {a.start_time ? (
                        <>
                          <span className="text-slate-500">{a.start_time.slice(5, 10)}</span> {hhmm(a.start_time)}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap" title={a.end_time ?? undefined}>
                      {a.end_time ? (
                        <>
                          {a.end_time.slice(0, 10) !== a.start_time?.slice(0, 10) && (
                            <span className="text-slate-500">{a.end_time.slice(5, 10)} </span>
                          )}
                          {hhmm(a.end_time)}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-slate-400">{duration(a.start_time, a.end_time)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {failed.length > 0 && (
            <div className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-amber-400">
              Some days could not be read for {failed.join(", ")}.
            </div>
          )}
        </>
      )}
    </Panel>
  );
};
