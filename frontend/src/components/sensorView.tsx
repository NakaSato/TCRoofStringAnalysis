/** Weather-sensor pieces shared by the Sensors page and Active Alarm. */
import React from "react";
import { TriangleAlert } from "lucide-react";
import type { GrowattWeatherField, SensorFlag, SensorLiveRow, SensorRow, SensorStatus } from "../api/client";
import type { StatusLevel } from "./ui";
import { Badge } from "@/components/ui/badge";

export const STATUS_VIEW: Record<SensorStatus, { label: string; level: StatusLevel }> = {
  online: { label: "Online", level: "ok" },
  late: { label: "Late", level: "warn" },
  offline: { label: "Offline", level: "crit" },
  unknown: { label: "Not checked", level: "neutral" },
  not_synced: { label: "Not synced", level: "warn" },
};

export const FIELD_LABEL: Record<GrowattWeatherField, string> = {
  irradiance_wm2: "Irradiance",
  module_temp_c: "Module temp",
  ambient_temp_c: "Ambient temp",
  humidity_pct: "Humidity",
  wind_speed_ms: "Wind speed",
  wind_dir_deg: "Wind direction",
};
export const flagLabel = (f: SensorFlag) =>
  f.code === "probe_missing"
    ? `${f.field ? FIELD_LABEL[f.field] : "Probe"}: reads 0`
    : f.code === "irradiance_zero_daylight"
      ? "Irradiance 0 by day"
      : "History behind";

/** Health-check chips; the reason is the tooltip. */
export const FlagChips: React.FC<{ flags: SensorFlag[] }> = ({ flags }) =>
  flags.length ? (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={`${f.code}:${f.field ?? ""}`} variant="warn" className="px-1.5 py-0 text-[10px] font-semibold" title={f.reason}>
          {flagLabel(f)}
        </Badge>
      ))}
    </div>
  ) : (
    <span className="text-slate-600">—</span>
  );

/** Each flag with its reason written out (Info views). */
export const FlagList: React.FC<{ flags: SensorFlag[] }> = ({ flags }) => (
  <ul className="space-y-1.5">
    {flags.map((f) => (
      <li key={`${f.code}:${f.field ?? ""}`} className="flex items-start gap-2 text-[12px] text-slate-300">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
        <span>
          <span className="font-semibold text-amber-200">{flagLabel(f)}</span> · {f.reason}
        </span>
      </li>
    ))}
  </ul>
);

/** A DB row with the live state laid over it. */
export type ViewRow = SensorRow & {
  /** live status once its datalogger is checked, else the DB one (`unknown` / `not_synced`) */
  st: SensorStatus;
  /** last upload to Growatt when live is known ("Live"), else the newest stored reading ("Last sync") */
  upload: string | null;
  uploadLive: boolean;
  live: SensorLiveRow | null;
  /** stored-data checks plus the live ones (`stale_history`) */
  allFlags: SensorFlag[];
};

export const overlay = (s: SensorRow, l: SensorLiveRow | undefined): ViewRow => {
  const known = l != null && l.status !== "unknown";
  return {
    ...s,
    st: known ? l.status : s.status,
    upload: l?.last_update_time ?? s.last_reading_at,
    uploadLive: l?.last_update_time != null,
    live: l ?? null,
    allFlags: [...s.flags, ...(l?.flags ?? [])],
  };
};

