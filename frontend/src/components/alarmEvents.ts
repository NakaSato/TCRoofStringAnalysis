/**
 * Growatt alarm log → alarm events, shared by Active Alarm (table) and the Sensors Info view
 * (the sensor's plant "Alarms by hour" chart).
 *
 * Growatt's `alarm_data` reports an alarm that is still present again every ~5 min, each record
 * with end_time = start_time. Records of the same inverter + code no more than `EVENT_GAP_MIN`
 * apart are one event (first report → last report).
 */
import type { AlarmLogResult, AlarmRow } from "../context/alarmLogStore";
import type { PanelChartSpec } from "./PanelChart";
import type { StatusLevel } from "./ui";
import { STATUS } from "./chartTheme";
import { fmtInt } from "./ui";
import { translate } from "../i18n";

export const EVENT_GAP_MIN = 10;

/** plant-local "YYYY-MM-DD HH:MM:SS" → epoch ms (only differences are used) */
export const ms = (t: string | null) => (t ? Date.parse(t.replace(" ", "T")) : NaN);
/** UTC ISO → plant-local "YYYY-MM-DD HH:MM:SS" (Growatt alarm times are plant-local) */
export const toPlantLocal = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });
export const codeKey = (a: { alarm_code: number | string | null }) => (a.alarm_code == null ? "—" : String(a.alarm_code));

export type Level = "crit" | "warn" | "info";
export const LEVELS: Array<{ level: Level; label: string; color: string; text: string }> = [
  { level: "crit", label: "Faults", color: STATUS.crit, text: "text-red-300" },
  { level: "warn", label: "Warnings", color: STATUS.warn, text: "text-amber-300" },
  { level: "info", label: "Other", color: STATUS.none, text: "text-slate-300" },
];

/** One alarm event: consecutive reports of one code on one inverter (or one weather sensor). */
export interface AlarmEvent {
  key: string;
  /** Growatt inverter alarm log, or a weather sensor that needs attention */
  source: "inverter" | "sensor";
  /** state label when not Open / Cleared (sensors: Offline, Late, Flagged, Data gap) */
  state?: string;
  /** device link (sensors: the Sensors page Info view) */
  href?: string;
  plant_id: number;
  plant_name: string;
  device_sn: string;
  alarm_code: number | string | null;
  alarm_message: string | null;
  /** English text of a message the frontend builds (sensor rows), for CSV exports, which stay English */
  alarm_message_en?: string | null;
  fault_type: string | null;
  level: StatusLevel;
  start: string | null;
  /** last report (or Growatt's end time when it gives a later one) */
  last: string | null;
  reports: number;
  /** still being reported at the plant's last sync (today), or Growatt gave no end time */
  open: boolean;
  /** first → last report; null for a single report */
  minutes: number | null;
}

/** `openSince(row)`: epoch ms (plant-local) from which a last report counts as still present;
 * undefined = the row's alarm can only be open when Growatt gave no end time. */
export function toEvents(rows: AlarmRow[], openSince: (a: AlarmRow) => number | undefined): AlarmEvent[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.plant_id - b.plant_id ||
      a.device_sn.localeCompare(b.device_sn) ||
      codeKey(a).localeCompare(codeKey(b)) ||
      (a.fault_type ?? "").localeCompare(b.fault_type ?? "") ||
      (a.start_time ?? "").localeCompare(b.start_time ?? "")
  );
  const out: AlarmEvent[] = [];
  let cur: (AlarmEvent & { noEnd: boolean; group: string; since: number | undefined }) | null = null;
  const flush = () => {
    if (!cur) return;
    const span = ms(cur.last) - ms(cur.start);
    const { noEnd, group: _g, since, ...e } = cur;
    out.push({
      ...e,
      open: noEnd || (since != null && ms(cur.last) >= since),
      minutes: cur.reports > 1 && Number.isFinite(span) ? Math.max(0, Math.round(span / 60000)) : null,
    });
    cur = null;
  };
  for (const a of sorted) {
    const group = `${a.plant_id}|${a.device_sn}|${codeKey(a)}|${a.fault_type ?? ""}`;
    const end = a.end_time && a.end_time > (a.start_time ?? "") ? a.end_time : a.start_time;
    if (cur && cur.group === group && ms(a.start_time) - ms(cur.last) <= EVENT_GAP_MIN * 60000) {
      cur.reports++;
      if (end && end > (cur.last ?? "")) cur.last = end;
      cur.noEnd ||= !a.end_time;
      cur.since = openSince(a) ?? cur.since;
      continue;
    }
    flush();
    cur = {
      key: `${group}|${a.start_time}`,
      group,
      source: "inverter",
      plant_id: a.plant_id,
      plant_name: a.plant_name,
      device_sn: a.device_sn,
      alarm_code: a.alarm_code,
      alarm_message: a.alarm_message,
      fault_type: a.fault_type,
      level: a.level,
      start: a.start_time,
      last: end,
      reports: 1,
      noEnd: !a.end_time,
      since: openSince(a),
      open: false,
      minutes: null,
    };
  }
  flush();
  return out;
}

/** The day's inverter alarm events; today, an event still reported within EVENT_GAP_MIN of its
 * inverter's last read is open. Per inverter, not per plant: the worker re-reads inverters on
 * different tiers (10 / 30 / 60 min), so a plant's oldest read says nothing about another inverter. */
export function inverterEvents(result: AlarmLogResult | null, isToday: boolean): AlarmEvent[] {
  if (!result) return [];
  // older API without per-row read_at: fall back to the plant's oldest read
  const plantRead = new Map(result.plants.map((p) => [p.plant_id, p.synced_at] as const));
  return toEvents(result.rows, (a) => {
    if (!isToday) return undefined;
    const at = a.read_at ?? plantRead.get(a.plant_id);
    return at ? ms(toPlantLocal(at)) - EVENT_GAP_MIN * 60000 : undefined;
  });
}

/** Event starts per plant-local hour, stacked by level; null when no event has a start time. */
export function alarmHourSpec(events: AlarmEvent[]): PanelChartSpec | null {
  const timed = events.filter((a) => a.start);
  if (!timed.length) return null;
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
  const counts: Record<Level, number[]> = { crit: Array(24).fill(0), warn: Array(24).fill(0), info: Array(24).fill(0) };
  for (const a of timed) {
    const h = Number(a.start?.slice(11, 13));
    if (Number.isInteger(h) && h >= 0 && h < 24) counts[a.level as Level][h]++;
  }
  const shown = LEVELS.filter((l) => counts[l.level].some((n) => n > 0));
  return {
    xKind: "band",
    x: hours,
    xTickLabel: (v) => `${v}`,
    xTipLabel: (v) => translate("{h}:00–{h}:59 (plant time)", { h: v }),
    panels: [
      {
        key: "starts",
        title: translate("Alarms started"),
        series: shown.map((l) => ({
          key: l.level,
          name: translate(l.label),
          type: "bar" as const,
          color: l.color,
          y: counts[l.level],
          format: (v: number) => fmtInt(v),
        })),
      },
    ],
  };
}
