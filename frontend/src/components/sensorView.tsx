/** Weather-sensor pieces shared by the Sensors page and Active Alarm. */
import React from "react";
import { TriangleAlert } from "lucide-react";
import type { GrowattWeatherField, SensorFlag, SensorLiveRow, SensorRow, SensorStatus } from "../api/client";
import type { StatusLevel } from "./ui";
import { Badge } from "@/components/ui/badge";
import { translate, type Lang } from "../i18n";

export const STATUS_VIEW: Record<SensorStatus, { label: string; level: StatusLevel }> = {
  online: { label: "Online", level: "ok" },
  late: { label: "Late", level: "warn" },
  offline: { label: "Offline", level: "crit" },
  inactive: { label: "Inactive", level: "neutral" },
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
/** `lang`: the UI language by default; "en" for CSV exports. */
export const flagLabel = (f: SensorFlag, lang?: Lang) =>
  f.code === "probe_missing"
    ? translate("{field}: reads 0", { field: translate(f.field ? FIELD_LABEL[f.field] : "Probe", undefined, lang) }, lang)
    : f.code === "irradiance_zero_daylight"
      ? translate("Irradiance 0 by day", undefined, lang)
      : translate("History behind", undefined, lang);

/** "45 min" / "4 h 20 min", in the UI language. */
const spanText = (minutes: number, lang?: Lang) =>
  minutes < 60
    ? translate("{n} min", { n: minutes }, lang)
    : translate("{h} h {m} min", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") }, lang);

/** Why the flag fired, in the UI language, from the backend's `params` (else its English `reason`). */
export const flagReason = (f: SensorFlag, lang?: Lang): string => {
  const p = f.params;
  if (!p) return f.reason;
  const field = translate(f.field ? FIELD_LABEL[f.field] : "Probe", undefined, lang);
  if (f.code === "probe_missing")
    return translate(
      p.day
        ? "{field} read 0 in all {n} stored slots on {day} ({from}–{to}) but reported in the last 7 days: probe fault or disconnected"
        : "{field} read 0 in all {n} stored slots today ({from}–{to}) but reported in the last 7 days: probe fault or disconnected",
      { field, n: p.slots ?? "—", day: p.day ?? "", from: p.from ?? "—", to: p.to ?? "—" },
      lang
    );
  if (f.code === "irradiance_zero_daylight")
    return translate(
      "Irradiance read 0 W/m² for {span} between {lo} and {hi} ({from}–{to}) while the plant's inverters produced power: shaded, dirty or faulty irradiance probe",
      { span: spanText(Number(p.minutes ?? 0), lang), lo: p.from_h ?? "—", hi: p.to_h ?? "—", from: p.from ?? "—", to: p.to ?? "—" },
      lang
    );
  return translate(
    "Online (last upload {at}) but stored readings end at {until}, {span} behind: history sync problem, not a sensor fault",
    { at: p.last_upload ?? "—", until: p.synced_until ?? "—", span: spanText(Number(p.minutes ?? 0), lang) },
    lang
  );
};

/** Health-check chips; the reason is the tooltip. */
export const FlagChips: React.FC<{ flags: SensorFlag[] }> = ({ flags }) =>
  flags.length ? (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={`${f.code}:${f.field ?? ""}`} variant="warn" className="px-1.5 py-0 text-[10px] font-semibold" title={flagReason(f)}>
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
          <span className="font-semibold text-amber-200">{flagLabel(f)}</span> · {flagReason(f)}
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

