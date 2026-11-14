import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client";
import type { FleetAlarmPlant, GrowattAlarm } from "../api/client";
import type { StatusLevel } from "../components/ui";

/**
 * Fleet alarm log per plant-local day, read from the backend DB (`/growatt/alarms`, one request
 * for every plant the user may see; the worker syncs Growatt's alarm log into SQL). Each day's
 * last answer is kept in this tab's memory so a revisit shows it at once (never localStorage).
 *
 * - A re-read happens in the background: the last result stays on screen until the new one arrives.
 * - Today is re-read just after the worker's next `alarms` run (`meta.next_run_at` + `AFTER_RUN_S`,
 *   every 10 min in the daytime), within `TODAY_MIN_S`..`TODAY_MAX_S`; past days every
 *   `PAST_REFRESH_S` (yesterday is completed by the worker after midnight). Only while the page
 *   is open and visible.
 */

/** A tiered run takes seconds; the first run of the day (whole fleet) about 2 min. */
const AFTER_RUN_S = 45;
/** The next run is overdue (worker busy or down) or unknown: re-read on this fallback. */
const TODAY_FALLBACK_S = 120;
const TODAY_MIN_S = 60;
/** Upper bound, so a "next run tomorrow 05:00" still notices a manual sync or the day rolling over. */
const TODAY_MAX_S = 900;
const PAST_REFRESH_S = 1800;
/** Days kept in memory; the oldest idle one is dropped beyond this. */
const MAX_DAYS = 7;

export interface AlarmRow extends GrowattAlarm {
  plant_id: number;
  plant_name: string;
  /** when this inverter's log was last read (UTC ISO); absent from the live endpoint */
  read_at?: string | null;
  level: StatusLevel;
  open: boolean;
}

export interface AlarmLogResult {
  rows: AlarmRow[];
  /** every visible plant with inverters, with how much of its day the worker has read */
  plants: FleetAlarmPlant[];
  /** newest worker read among the plants (UTC ISO), null when nothing is synced for the day */
  syncedAt: string | null;
  /** when the worker's `alarms` job last started (UTC ISO; any day) */
  lastRunAt: string | null;
  /** when it will next start (UTC ISO; today only, null for a past day) */
  nextRunAt: string | null;
  fetchedAt: Date;
}

export interface AlarmLogView {
  day: string;
  /** last answer; null until the first one arrives */
  result: AlarmLogResult | null;
  /** a read is in progress (first read or background refresh) */
  running: boolean;
  /** the last read failed (the previous result, if any, stays) */
  error: string | null;
  /** epoch ms of the next background re-read */
  dueAt: number;
}

/** Growatt's own fault_type label → colour. */
export const alarmLevel = (faultType: string | null): StatusLevel => {
  const s = (faultType ?? "").toLowerCase();
  if (/fault|error|fail/.test(s)) return "crit";
  if (/warn/.test(s)) return "warn";
  return "info";
};

/** Today in plant-local time (Growatt alarm times are plant-local, Asia/Bangkok). */
export const plantToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });

interface Entry {
  view: AlarmLogView;
  run: number;
  usedAt: number;
}

const entries = new Map<string, Entry>();
/** Global, so a read abandoned by `clearAlarmLogs` can never write into a newer entry. */
let runSeq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function evict() {
  if (entries.size <= MAX_DAYS) return;
  const idle = [...entries.entries()].filter(([, e]) => !e.view.running).sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [k] of idle.slice(0, entries.size - MAX_DAYS)) entries.delete(k);
}

/** ms until the next background re-read of `day` (`nextRunAt` from the answer just received). */
function refreshMs(day: string, nextRunAt: string | null | undefined): number {
  if (day !== plantToday()) return PAST_REFRESH_S * 1000;
  const next = nextRunAt ? Date.parse(nextRunAt) : NaN;
  if (!Number.isFinite(next)) return TODAY_FALLBACK_S * 1000;
  const s = (next - Date.now()) / 1000 + AFTER_RUN_S;
  if (s < TODAY_MIN_S) return TODAY_FALLBACK_S * 1000;
  return Math.min(TODAY_MAX_S, s) * 1000;
}

/** Start a read of `day` unless one is running or the last answer is still current (`force` skips that check). */
function read(day: string, force: boolean) {
  const prev = entries.get(day);
  if (prev?.view.running) return;
  if (prev && !force && Date.now() < prev.view.dueAt) return;

  const run = ++runSeq;
  entries.set(day, {
    run,
    usedAt: Date.now(),
    view: { day, result: prev?.view.result ?? null, running: true, error: null, dueAt: prev?.view.dueAt ?? 0 },
  });
  evict();
  emit();

  const done = (patch: Partial<AlarmLogView>) => {
    const e = entries.get(day);
    if (!e || e.run !== run) return; // superseded or cleared
    const next = patch.result?.nextRunAt ?? e.view.result?.nextRunAt;
    e.view = { ...e.view, running: false, dueAt: Date.now() + refreshMs(day, next), ...patch };
    emit();
  };

  api
    .getFleetAlarms(day)
    .then((r) =>
      done({
        result: {
          rows: r.alarms.map((a) => ({ ...a, level: alarmLevel(a.fault_type), open: !a.end_time })),
          plants: r.plants,
          syncedAt: r.meta.synced_at,
          lastRunAt: r.meta.last_run_at ?? null,
          nextRunAt: r.meta.next_run_at ?? null,
          fetchedAt: new Date(),
        },
      })
    )
    .catch((err) => done({ error: err instanceof Error ? err.message : String(err) }));
}

/** Drop everything (on sign-out: the next user may see other plants). Running reads are abandoned. */
export function clearAlarmLogs() {
  entries.clear();
  emit();
}

/**
 * The stored alarm log of `day`: the cached view at once, a read when there is none or it is due,
 * and background re-reads while the page is visible. `refresh()` forces a re-read.
 */
export function useAlarmLog(day: string): { view: AlarmLogView | null; refresh: () => void } {
  const view = useSyncExternalStore(subscribe, () => entries.get(day)?.view ?? null);

  useEffect(() => {
    const e = entries.get(day);
    if (e) e.usedAt = Date.now();
    read(day, false);
  }, [day]);

  // re-read when due, only while visible
  const dueAt = view?.dueAt ?? Infinity;
  const running = view?.running ?? false;
  useEffect(() => {
    if (running || !Number.isFinite(dueAt)) return;
    const tick = () => {
      if (!document.hidden) read(day, false);
    };
    const onVisible = () => {
      if (!document.hidden && Date.now() >= dueAt) tick();
    };
    const timer = window.setTimeout(tick, Math.max(0, dueAt - Date.now()));
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [day, running, dueAt]);

  return { view, refresh: () => read(day, true) };
}
