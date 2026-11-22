import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCircle2, CloudOff } from "lucide-react";
import { api, GrowattLive, GrowattLiveAlarms } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import type { StatusLevel } from "./ui";
import { EmptyState, Led, LoadingState, Panel } from "./ui";
import type { AlarmEvent } from "./alarmEvents";
import { EVENT_GAP_MIN, ms, toEvents, toPlantLocal } from "./alarmEvents";
import { cn } from "@/lib/utils";
import { dayLabel } from "@/lib/day";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { translate, useI18n } from "../i18n";
import { FaultManualLinks } from "./KbManualLinks";

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

/** Minutes → "1 h 05 min" / "12 min" / "<1 min". */
function durationText(min: number): string {
  if (min < 1) return translate("<1 min");
  if (min < 60) return translate("{n} min", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return translate("{h} h {m} min", { h, m: String(min % 60).padStart(2, "0") });
  return translate("{d} d {h} h", { d: Math.floor(h / 24), h: h % 24 });
}

const LEVEL_LED: Record<string, "crit" | "warn" | "off"> = { crit: "crit", warn: "warn" };
const LEVEL_TEXT: Record<string, string> = { crit: "text-red-300", warn: "text-amber-300" };

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
  /** short subtitle (count · range) and a one-line "no alarms" instead of the large empty state */
  compact?: boolean;
  /** device SN → display name (alias) for the Inverter column */
  inverterNames?: Record<string, string>;
  /** device SN → link (e.g. the Inverters page with ?sn=) */
  inverterHref?: (sn: string) => string;
}> = ({ plantId, plantName, day, deviceSn = null, className = "", compact = false, inverterNames, inverterHref }) => {
  const { t } = useI18n();
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

  // Growatt re-reports an alarm that is still present every ~5 min: group those records into events
  const alarms = useMemo(() => {
    if (!res) return [];
    const rows = res.data.alarms
      .filter((a) => !deviceSn || a.device_sn === deviceSn)
      .map((a) => ({ ...a, plant_id: plantId, plant_name: plantName ?? "", level: alarmLevel(a.fault_type), open: false }));
    // the log is read live: an event of today still reported within EVENT_GAP_MIN of now is open
    const nowLocal = toPlantLocal(new Date().toISOString());
    const since = res.data.to === nowLocal.slice(0, 10) ? ms(nowLocal) - EVENT_GAP_MIN * 60000 : undefined;
    return toEvents(rows, () => since)
      .sort((x, y) => Number(y.open) - Number(x.open) || (y.start ?? "").localeCompare(x.start ?? ""))
      .map((e) => ({ e, lvl: e.level }));
  }, [res, deviceSn, plantId, plantName]);
  const reports = alarms.reduce((n, { e }) => n + e.reports, 0);
  const openCount = alarms.filter(({ e }) => e.open).length;
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
  const subject = deviceSn ? t("inverter {sn}", { sn: deviceSn }) : plantName ?? t("this plant");
  const range = res ? `${res.data.from} → ${res.data.to}` : t("last {n} days", { n: DAYS });

  return (
    <Panel
      className={className}
      icon={Bell}
      title={t("Growatt Fault Log")}
      subtitle={
        compact
          ? res
            ? `${t(alarms.length === 1 ? "{n} event" : "{n} events", { n: alarms.length })}${openCount ? ` · ${t("{n} open", { n: openCount })}` : ""} · ${range}`
            : range
          : res
            ? t(
                alarms.length === 1
                  ? "{n} alarm event ({reports}) by Growatt for {subject} · {range}"
                  : "{n} alarm events ({reports}) by Growatt for {subject} · {range}",
                { n: alarms.length, reports: t(reports === 1 ? "{n} report" : "{n} reports", { n: reports }), subject, range }
              )
            : t("Alarms reported by Growatt for {subject} · {range}", { subject, range })
      }
      bodyClassName="p-0"
      actions={
        <div className="flex items-center gap-2">
          {levels.length > 1 && (
            <Tabs value={active} onValueChange={(v) => setFilter(v as LevelFilter)}>
              <TabsList>
                {(["all", ...levels] as LevelFilter[]).map((l) => (
                  <TabsTrigger key={l} value={l} className="px-2 py-1 text-[11px]">
                    {t(LEVEL_LABEL[l])}
                    <span className="num text-slate-500">{counts[l]}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {res?.stale && (
            <Badge variant="warn" title={res.error ?? undefined}>
              {t("stale")}
            </Badge>
          )}
        </div>
      }
    >
      {!res && !error ? (
        <LoadingState label={t("Reading the Growatt fault log…")} shape="table" />
      ) : !res && error ? (
        <EmptyState icon={CloudOff} title={t("Growatt fault log unavailable")} description={error} />
      ) : alarms.length === 0 && compact ? (
        <div
          className="flex items-center gap-2 px-5 py-3 text-xs text-muted-foreground"
          title={failed.length ? t("Some days could not be read for {sns}", { sns: failed.join(", ") }) : undefined}
        >
          <CheckCircle2 className={failed.length ? "size-4 text-amber-300" : "size-4 text-emerald-400"} aria-hidden />
          {t("No alarms")}{failed.length ? ` · ${t("some days unread")}` : ""}
        </div>
      ) : alarms.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={t("No alarms reported")}
          description={
            failed.length
              ? t("Growatt reported no alarms, but some days could not be read for {sns}.", { sns: failed.join(", ") })
              : t("Growatt reported no alarms for {subject} in the last {n} days.", { subject, n: DAYS })
          }
        />
      ) : (
        <>
          {shown.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={t(active === "crit" ? "No fault alarms" : active === "warn" ? "No warning alarms" : active === "info" ? "No other alarms" : "No alarms")}
              description={t(
                alarms.length === 1 ? "Growatt reported {n} other alarm event for {subject}." : "Growatt reported {n} other alarm events for {subject}.",
                { n: alarms.length, subject }
              )}
              className="py-8"
            />
          ) : compact ? (
            <EventTimelineList events={shown.map(({ e }) => e)} inverterNames={inverterNames} inverterHref={inverterHref} />
          ) : (
            <Table containerClassName="max-h-[420px] overflow-auto">
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead>{t("Alarm")}</TableHead>
                  {!deviceSn && <TableHead>{t("Inverter")}</TableHead>}
                  <TableHead>{t("When")}</TableHead>
                  <TableHead className="text-right">{t("Duration")}</TableHead>
                  <TableHead className="w-[1%] text-right">{t("State")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map(({ e }) => (
                  <AlarmEventRow
                    key={e.key}
                    e={e}
                    showInverter={!deviceSn}
                    name={inverterNames?.[e.device_sn]}
                    href={inverterHref?.(e.device_sn)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {failed.length > 0 && (
            <div className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-amber-400">
              {t("Some days could not be read for {sns}.", { sns: failed.join(", ") })}
            </div>
          )}
        </>
      )}
    </Panel>
  );
};

/** One alarm event: level + message + code, inverter, first → last report, duration, Open / Cleared. */
const AlarmEventRow: React.FC<{ e: AlarmEvent; showInverter: boolean; name?: string; href?: string }> = ({ e, showInverter, name, href }) => {
  const sameDay = e.last?.slice(0, 10) === e.start?.slice(0, 10);
  const label = name ?? e.device_sn;
  const { t } = useI18n();
  return (
    <TableRow className={cn(e.open && "bg-red-500/[0.04]")}>
      <TableCell className="max-w-[360px]">
        <div className="flex min-w-0 items-center gap-2">
          <Led level={LEVEL_LED[e.level] ?? "off"} />
          <span className="truncate font-medium text-slate-100" title={e.alarm_message ?? undefined}>
            {e.alarm_message ?? "—"}
          </span>
          <span
            className={cn("num shrink-0 text-[11px]", LEVEL_TEXT[e.level] ?? "text-slate-500")}
            title={`${e.fault_type ?? t("Alarm")} · ${t("code {code}", { code: e.alarm_code ?? "—" })}`}
          >
            {e.alarm_code ?? ""}
          </span>
          <FaultManualLinks faultType={e.fault_type} code={e.alarm_code} className="shrink-0" />
        </div>
      </TableCell>
      {showInverter && (
        <TableCell className="num whitespace-nowrap" title={e.device_sn}>
          {href ? (
            <Link to={href} className="text-slate-300 hover:text-sky-300 hover:underline">
              {label}
            </Link>
          ) : (
            <span className="text-slate-300">{label}</span>
          )}
        </TableCell>
      )}
      <TableCell className="num whitespace-nowrap" title={e.start && e.last ? `${e.start} → ${e.last}` : (e.start ?? undefined)}>
        {e.start ? (
          <>
            <span className="text-slate-500">{e.start.slice(5, 10)}</span> {hhmm(e.start)}
            {e.reports > 1 && e.last && (
              <span className="text-slate-400">
                {" "}
                → {!sameDay && <span className="text-slate-500">{e.last.slice(5, 10)} </span>}
                {hhmm(e.last)}
              </span>
            )}
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="num whitespace-nowrap text-right text-slate-400">
        {e.minutes != null ? durationText(e.minutes) : "—"}
        {e.reports > 1 && (
          <span className="ml-1.5 text-[11px] text-slate-500" title={t("{n} reports from Growatt", { n: e.reports })}>
            ×{e.reports}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {e.open ? (
          <Badge variant="crit" className="gap-1.5">
            <Led level="crit" pulse /> {t("Open")}
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">{t("Cleared")}</span>
        )}
      </TableCell>
    </TableRow>
  );
};

/* ---------- compact view (Plant Overview): events by day on a 05:00–19:00 timeline ---------- */

const T0 = 5 * 60; // 05:00
const T1 = 19 * 60; // 19:00
const TICKS = [6, 9, 12, 15, 18];
const COMPACT_ROWS = 12;
const BAR_TONE: Record<string, string> = { crit: "bg-red-400/80", warn: "bg-amber-400/80" };
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_auto]";

const minOfDay = (t: string) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
const pctOf = (min: number) => ((Math.max(T0, Math.min(T1, min)) - T0) / (T1 - T0)) * 100;

const clockText = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Pointer x over a timeline cell → minute of the day window (whole minutes, clamped). */
function minAtPointer(ev: React.PointerEvent<HTMLElement>): number {
  const r = ev.currentTarget.getBoundingClientRect();
  const f = r.width > 0 ? Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) : 0;
  return Math.round(T0 + f * (T1 - T0));
}

/** The event's first / last report as minutes of its start day (a report on a later day ends at T1). */
function spanOf(e: AlarmEvent): { s: number; l: number } | null {
  if (!e.start) return null;
  const s = minOfDay(e.start);
  const l = e.last ? (e.last.slice(0, 10) === e.start.slice(0, 10) ? minOfDay(e.last) : T1) : s;
  return { s, l };
}

/** Growatt reports every ~5 min: an event "covers" the hovered minute within that slack. */
const SLACK_MIN = 5;
const covers = (e: AlarmEvent, min: number) => {
  const sp = spanOf(e);
  return sp != null && min >= sp.s - SLACK_MIN && min <= sp.l + SLACK_MIN;
};

/** "06:16 – 07:30" (first → last report; "now" while open; the date when it ends on a later day; one report = "06:16"). */
function rangeText(e: AlarmEvent): string {
  if (!e.start) return "—";
  if (e.open) return `${hhmm(e.start)} – ${translate("now")}`;
  if (e.reports <= 1 || !e.last || e.last === e.start) return hhmm(e.start);
  const later = e.last.slice(0, 10) !== e.start.slice(0, 10);
  return `${hhmm(e.start)} – ${later ? `${e.last.slice(5, 10)} ` : ""}${hhmm(e.last)}`;
}

/** Hover crosshair: a vertical line through the cell at the hovered minute. */
const HoverLine: React.FC<{ min: number | null; className?: string }> = ({ min, className }) =>
  min == null ? null : (
    <div
      className={cn("pointer-events-none absolute z-10 w-px -translate-x-1/2 bg-sky-300/70", className)}
      style={{ left: `${pctOf(min)}%` }}
      aria-hidden
    />
  );

/** Hour ticks of the day window (shown in each day header, above the bars); the hovered time replaces nearby ticks. */
const TimeAxis: React.FC<{ hoverMin: number | null; onHover: (min: number | null) => void }> = ({ hoverMin, onHover }) => (
  <div
    className="relative hidden h-3 cursor-crosshair sm:block"
    aria-hidden
    onPointerMove={(ev) => onHover(minAtPointer(ev))}
    onPointerLeave={() => onHover(null)}
  >
    {TICKS.filter((h) => hoverMin == null || Math.abs(h * 60 - hoverMin) > 45).map((h) => (
      <span key={h} className="num absolute -translate-x-1/2 text-[10px] text-slate-500" style={{ left: `${pctOf(h * 60)}%` }}>
        {String(h).padStart(2, "0")}
      </span>
    ))}
    {hoverMin != null && (
      <>
        <HoverLine min={hoverMin} className="top-3 -bottom-1.5" />
        <span
          className="num absolute -top-0.5 z-20 -translate-x-1/2 rounded bg-sky-400/20 px-1 text-[10px] leading-4 font-semibold text-sky-200"
          style={{ left: `${pctOf(hoverMin)}%` }}
        >
          {clockText(hoverMin)}
        </span>
      </>
    )}
  </div>
);

/** The event's first → last report as a bar on the day window; a single report is a dot. */
const EventBar: React.FC<{ e: AlarmEvent; hoverMin: number | null }> = ({ e, hoverMin }) => {
  const sp = spanOf(e);
  if (!e.start || !sp) return <span className="text-xs text-muted-foreground">—</span>;
  const day = e.start.slice(0, 10);
  const { s, l } = sp;
  const dim = hoverMin != null && !covers(e, hoverMin);
  const left = pctOf(s);
  const width = Math.max(0, pctOf(l) - left);
  const tone = BAR_TONE[e.level] ?? "bg-slate-400/70";
  const title = `${hhmm(e.start)}${e.reports > 1 && e.last ? ` → ${e.last.slice(0, 10) === day ? "" : e.last.slice(5, 11)}${hhmm(e.last)}` : ""}${
    e.reports > 1 ? ` · ${translate("{n} reports", { n: e.reports })}` : ""
  }`;
  return (
    <div className="relative h-4" title={hoverMin == null ? title : undefined} role="img" aria-label={title}>
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/[0.08]" />
      {TICKS.map((h) => (
        <div key={h} className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-white/[0.08]" style={{ left: `${pctOf(h * 60)}%` }} />
      ))}
      {width < 0.8 ? (
        <div
          className={cn("absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity", tone, dim && "opacity-30")}
          style={{ left: `${left}%` }}
        />
      ) : (
        <div
          className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-full transition-opacity", tone, dim && "opacity-30")}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      )}
      <HoverLine min={hoverMin} className="-top-2 -bottom-2" />
      {e.open && (
        <span
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-red-400/60"
          style={{ left: `${pctOf(l)}%` }}
        />
      )}
    </div>
  );
};

const EventTimelineList: React.FC<{
  events: AlarmEvent[];
  inverterNames?: Record<string, string>;
  inverterHref?: (sn: string) => string;
}> = ({ events, inverterNames, inverterHref }) => {
  const [all, setAll] = useState(false);
  const { t } = useI18n();
  // hovered minute of the day window: a crosshair through every day's timeline, with the time in the day headers
  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const today = toPlantLocal(new Date().toISOString()).slice(0, 10);
  const yesterday = toPlantLocal(new Date(Date.now() - 86_400_000).toISOString()).slice(0, 10);

  // newest day first; inside a day open events first, then newest
  const sorted = useMemo(
    () =>
      [...events].sort(
        (a, b) =>
          (b.start ?? "").slice(0, 10).localeCompare((a.start ?? "").slice(0, 10)) ||
          Number(b.open) - Number(a.open) ||
          (b.start ?? "").localeCompare(a.start ?? "")
      ),
    [events]
  );
  const visible = all ? sorted : sorted.slice(0, COMPACT_ROWS);
  const days: Array<{ day: string; items: AlarmEvent[]; total: number }> = [];
  for (const e of visible) {
    const day = (e.start ?? "").slice(0, 10);
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(e);
    else days.push({ day, items: [e], total: sorted.filter((x) => (x.start ?? "").slice(0, 10) === day).length });
  }

  return (
    <div className="flex flex-col">
      {days.map(({ day, items, total }) => (
        <section key={day} className="border-b border-white/[0.05] last:border-0">
          <div className={cn(ROW_GRID, "bg-white/[0.015] px-5 py-1.5")}>
            <span className="text-[11px] font-semibold tracking-wide text-slate-300 uppercase">
              {day === today ? t("Today") : day === yesterday ? t("Yesterday") : day ? dayLabel(day).replace(/ \d{4}$/, "") : t("Unknown day")}
              <span className="num ml-2 font-normal text-slate-500 normal-case">{total}</span>
            </span>
            <span className="hidden sm:block" />
            <TimeAxis hoverMin={hoverMin} onHover={setHoverMin} />
            <span className="hidden sm:block" />
          </div>
          {items.map((e) => {
            const name = inverterNames?.[e.device_sn] ?? e.device_sn;
            const href = inverterHref?.(e.device_sn);
            const hit = hoverMin != null && covers(e, hoverMin);
            return (
              <div
                key={e.key}
                className={cn(
                  ROW_GRID,
                  "px-5 py-2 transition-colors hover:bg-white/[0.02]",
                  e.open && "bg-red-500/[0.05]",
                  hit && "bg-sky-400/[0.06] hover:bg-sky-400/[0.08]"
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Led level={LEVEL_LED[e.level] ?? "off"} />
                  <span className="truncate text-sm text-slate-100" title={e.alarm_message ?? undefined}>
                    {e.alarm_message ?? "—"}
                  </span>
                  <span
                    className={cn("num shrink-0 text-[11px]", LEVEL_TEXT[e.level] ?? "text-slate-500")}
                    title={`${e.fault_type ?? t("Alarm")} · ${t("code {code}", { code: e.alarm_code ?? "—" })}`}
                  >
                    {e.alarm_code ?? ""}
                  </span>
                  <FaultManualLinks faultType={e.fault_type} code={e.alarm_code} className="shrink-0" />
                </div>
                <div className="num order-last col-span-2 truncate text-xs sm:order-none sm:col-span-1" title={e.device_sn}>
                  {href ? (
                    <Link to={href} className="text-slate-400 hover:text-sky-300 hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span className="text-slate-400">{name}</span>
                  )}
                </div>
                <div
                  className="order-last col-span-2 cursor-crosshair sm:order-none sm:col-span-1 sm:-my-2 sm:py-2"
                  onPointerMove={(ev) => setHoverMin(minAtPointer(ev))}
                  onPointerLeave={() => setHoverMin(null)}
                >
                  <EventBar e={e} hoverMin={hoverMin} />
                </div>
                <div
                  className="num flex items-center justify-end gap-2 text-xs whitespace-nowrap"
                  title={e.start ? `${e.start} → ${e.open ? t("still reported") : (e.last ?? e.start)}` : undefined}
                >
                  <span className="text-slate-200">{rangeText(e)}</span>
                  {e.open ? (
                    <Badge variant="crit">{t("Open")}</Badge>
                  ) : (
                    e.minutes != null &&
                    e.reports > 1 && <span className="text-[11px] text-slate-500">{durationText(e.minutes)}</span>
                  )}
                  {e.reports > 1 && (
                    <span className="text-[11px] text-slate-500" title={t("{n} reports from Growatt", { n: e.reports })}>
                      ×{e.reports}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {sorted.length > COMPACT_ROWS && (
        <div className="border-t border-white/[0.06] px-3 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? t("Show less") : t("Show all {n}", { n: sorted.length })}
          </Button>
        </div>
      )}
    </div>
  );
};
