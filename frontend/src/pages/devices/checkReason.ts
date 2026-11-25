/** Why a device check fired, in the UI language, from the backend's `params`.
 * The backend's English `reason` stays the fallback (unknown code, older backend) and the CSV text.
 * The device itself (label and SN) is in the row's Device column, so the sentences leave it out. */
import type { DeviceCheck, SensorFlag } from "../../api/client";
import { flagReason } from "../../components/sensorView";
import { translate, type Lang } from "../../i18n";
import { markedAt } from "./invertersTable";

type P = DeviceCheck["params"];

const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "—");
const str = (v: unknown): string => (v == null || v === "" ? "—" : String(v));

/** A plant-local "YYYY-MM-DDTHH:MM:SS" as a short date and time (no time zone shift). */
const localStamp = (v: unknown, locale: string): string => {
  if (typeof v !== "string" || v.length < 16) return "—";
  const day = new Date(`${v.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(day.getTime())) return "—";
  return `${day.toLocaleDateString(locale, { day: "numeric", month: "short", year: "2-digit" })} ${v.slice(11, 16)}`;
};
const localDay = (v: unknown, locale: string): string =>
  typeof v === "string" && v.length >= 10 ? new Date(`${v.slice(0, 10)}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : "—";

const SENSOR_CODE = { sensor_probe_missing: "probe_missing", sensor_irradiance_zero_daylight: "irradiance_zero_daylight" } as const;

export const checkReason = (c: DeviceCheck, lang: Lang, locale: string): string => {
  const p: P = c.params ?? {};
  const tr = (en: string, vars?: Record<string, string | number>) => translate(en, vars, lang);
  switch (c.code) {
    case "inverter_never_reported":
      return p.growatt_created_at
        ? tr("No record stored since it was added to Growatt on {day} ({n} days ago): mark it not installed, or check it on site", {
            day: localDay(p.growatt_created_at, locale),
            n: num(p.days),
          })
        : tr("No record stored, and Growatt gives no create date to tell how long it has been listed");
    case "inverter_silent":
      return tr("Newest stored record {last}, {h} h behind the plant's other inverters (newest {ref}); more than {limit} h", {
        last: localStamp(p.last_record, locale),
        h: num(p.behind_h),
        ref: localStamp(p.plant_newest, locale),
        limit: num(p.limit_h),
      });
    case "inverter_switched_off":
      return tr("Switched off in its settings (on/off = 0)");
    case "inverter_limited":
      return tr("Active power limit set to {pct} % (configured)", { pct: num(p.limit_pct) });
    case "nameplate_missing":
      return tr("No rated power from Growatt (nominal and model rating both missing): rated AC kW and the clipping checks are off");
    case "info_not_read": {
      const parts: string[] = [];
      // the same rule as the backend: never read, or older than refresh interval × factor
      const factor = typeof p.factor === "number" ? p.factor : 3;
      const older = (at: unknown, hours: number) => !at || Date.now() - Date.parse(String(at)) > hours * factor * 3_600_000;
      const infoStale = older(p.info_synced_at, Number(p.info_refresh_h) || 0);
      const paramStale = older(p.param_synced_at, (Number(p.param_refresh_days) || 0) * 24);
      if (infoStale)
        parts.push(
          p.info_synced_at
            ? tr("Inverter info last read {at} (refresh every {n} h)", { at: markedAt(String(p.info_synced_at), locale), n: num(p.info_refresh_h) })
            : tr("Inverter info never read (refresh every {n} h)", { n: num(p.info_refresh_h) })
        );
      if (paramStale)
        parts.push(
          p.param_synced_at
            ? tr("Model parameters last read {at} (refresh every {n} days)", { at: markedAt(String(p.param_synced_at), locale), n: num(p.param_refresh_days) })
            : tr("Model parameters never read (refresh every {n} days)", { n: num(p.param_refresh_days) })
        );
      return parts.length ? parts.join("; ") : c.reason;
    }
    case "firmware_minority":
      return tr("Firmware {fw}, while {n} of {total} {model} inverters run {major}", {
        fw: str(p.fw_version),
        n: num(p.majority),
        total: num(p.group),
        model: str(p.device_model),
        major: str(p.majority_fw),
      });
    case "no_string_layout":
      return tr("{n} of {total} installed inverters have no String Layout ({sns}): voltage per module and per-kWp peer checks stay off", {
        n: num(p.missing),
        total: num(p.installed),
        sns: str(p.inverters),
      });
    case "inverter_count_mismatch":
      return p.registry_total !== p.installed
        ? tr("{n} installed inverters in the registry ({total} with those marked not installed), {gc} entered in Growatt", {
            n: num(p.installed),
            total: num(p.registry_total),
            gc: num(p.growatt_count),
          })
        : tr("{n} installed inverters in the registry, {gc} entered in Growatt", { n: num(p.installed), gc: num(p.growatt_count) });
    case "logger_sn_mismatch":
      return tr("Logger SN {sn} in the site register {site}, {sns} in Growatt", { sn: str(p.register_sn), site: str(p.site_code), sns: str(p.growatt_sns) });
    case "no_meter":
      return tr("No energy meter registered in Growatt: grid import / export are not measured");
    case "meter_silent":
      return p.last_record
        ? tr("Newest stored meter record {last}, {h} h before {ref}; more than {limit} h", {
            last: localStamp(p.last_record, locale),
            h: num(p.behind_h),
            ref: localStamp(p.reference, locale),
            limit: num(p.limit_h),
          })
        : tr("No meter record ever stored since it was registered");
    case "sensor_probe_missing":
    case "sensor_irradiance_zero_daylight": {
      const { field, ...rest } = p;
      const flag: SensorFlag = {
        code: SENSOR_CODE[c.code],
        field: (field ?? undefined) as SensorFlag["field"],
        reason: c.reason,
        params: rest as SensorFlag["params"],
      };
      return flagReason(flag, lang);
    }
    default:
      return c.reason;
  }
};
