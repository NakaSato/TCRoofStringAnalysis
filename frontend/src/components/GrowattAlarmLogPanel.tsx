import React, { useEffect, useState } from "react";
import { Bell, CheckCircle2, CloudOff } from "lucide-react";
import { api, GrowattLive, GrowattLiveAlarms } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import type { StatusLevel } from "./ui";
import { EmptyState, Led, LoadingState, Panel, StatusBadge } from "./ui";

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

  useEffect(() => {
    setRes(null);
    setError(null);
  }, [plantId, day]);

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

  const alarms = (res?.data.alarms ?? []).filter((a) => !deviceSn || a.device_sn === deviceSn);
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
        res?.stale ? (
          <span className="text-[11px] text-amber-400" title={res.error ?? undefined}>
            stale
          </span>
        ) : undefined
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
          <ul className="max-h-[340px] divide-y divide-white/[0.05] overflow-y-auto">
            {alarms.map((a, i) => {
              const lvl = alarmLevel(a.fault_type);
              return (
                <li key={`${a.device_sn}-${a.start_time}-${a.alarm_code}-${i}`} className="flex items-start gap-3 px-4 py-3">
                  <Led level={lvl} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-white">{a.alarm_message ?? "—"}</span>
                      <StatusBadge status={a.fault_type ?? "—"} level={lvl} dot={false} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                      <span className="num text-slate-300">{a.device_sn}</span>
                      <span className="num">Code {a.alarm_code ?? "—"}</span>
                      <span className="num">
                        {a.start_time ? `${a.start_time.slice(0, 10)} ${hhmm(a.start_time)}` : "—"}
                        {a.end_time && a.end_time !== a.start_time ? ` → ${hhmm(a.end_time)}` : ""}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
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
