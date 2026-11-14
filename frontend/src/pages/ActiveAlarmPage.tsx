import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { plantToday, useAlarmLog } from "../context/alarmLogStore";
import { Link } from "react-router-dom";
import { pickDay, useUrlState } from "@/lib/useUrlState";
import { dayLabel, fromDate, toDate } from "@/lib/day";
import { plantPath } from "../context/routes";
import { SkeletonRows, fmt, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { useSensorAlarms } from "../components/SensorAlarmPanel";
import { STATUS_VIEW, flagLabel } from "../components/sensorView";
import type { ViewRow } from "../components/sensorView";
import { LEVELS, codeKey, inverterEvents, ms, toPlantLocal } from "../components/alarmEvents";
import type { AlarmEvent, Level } from "../components/alarmEvents";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePager, pageBounds } from "../components/TablePager";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";


const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "YYYY-MM-DD" ⇄ local-midnight Date (the Calendar works in local dates) */
/** sensor last upload: time on `day`, else date + time; null = never */
const fmtWhen = (t: string | null, day: string) => (!t ? "never" : t.slice(0, 10) === day ? t.slice(11, 16) : t.slice(0, 16));
/** "2026-11-10 06:16:07" → "06:16" */
const hm = (t: string | null) => (t ? t.slice(11, 16) : "—");
const fmtDuration = (min: number | null) =>
  min == null
    ? "—"
    : min < 60
      ? `${min} min`
      : min < 24 * 60
        ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} m`
        : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
/**
 * Weather sensors as rows of the same table. Today: offline / late (live sweep) or with a health
 * flag, all open; duration = time since the last upload. Past day: stored daylight coverage below
 * the threshold ("Data gap"), never open (there is no online state for a past day).
 */
function sensorEvents(rows: ViewRow[], isToday: boolean, now: string): AlarmEvent[] {
  const out: AlarmEvent[] = [];
  for (const s of rows) {
    const live = isToday && (s.st === "offline" || s.st === "late");
    // `stale_history` = our stored history is behind (a sync issue, not a sensor fault): it is
    // reported with the sync state, not as an alarm row
    const sensorFlags = s.allFlags.filter((f) => f.code !== "stale_history");
    if (isToday && !live && !sensorFlags.length) continue;
    const at = isToday ? s.upload : s.last_reading_at;
    const since = ms(now) - ms(at);
    const flags = sensorFlags.map(flagLabel).join(", ");
    out.push({
      key: `sensor|${s.key}`,
      source: "sensor",
      state: isToday ? (live ? STATUS_VIEW[s.st].label : "Flagged") : "Data gap",
      href: `/sensors?tab=info&sensor=${encodeURIComponent(s.key)}`,
      plant_id: s.plant_id,
      plant_name: s.plant_name,
      device_sn: `${s.datalogger_sn}#${s.address}`,
      alarm_code: null,
      alarm_message: isToday
        ? [live ? (s.st === "offline" ? "Weather sensor offline" : "Weather sensor uploading late") : null, flags || null].filter(Boolean).join(" · ")
        : `Weather sensor: ${fmt(s.coverage_pct, 0)}% of daylight readings stored`,
      fault_type: "Sensor",
      level: isToday ? (s.st === "offline" ? "crit" : "warn") : s.coverage_pct === 0 ? "crit" : "warn",
      start: null,
      last: at,
      reports: 0,
      open: isToday,
      minutes: isToday && live && Number.isFinite(since) ? Math.max(0, Math.round(since / 60000)) : null,
    });
  }
  return out;
}

/** px kept free under the table card for the pager and the page's bottom padding */
const PAGER_H = 52;
const BOTTOM_GAP = 24;

/** Badge variant for an alarm level (`info` = Growatt type that is neither fault nor warning). */
const badgeOf = (l: StatusLevel) => (l === "info" ? "neutral" : l);

/** One number of the summary row; clickable when `onClick` is given. */
const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string; onClick?: () => void }> = ({
  label,
  value,
  tone = "text-foreground",
  onClick,
}) => {
  const body = (
    <>
      <span className="eyebrow">{label}</span>
      <span className={cn("num text-3xl font-bold tracking-tight", tone)}>{value}</span>
    </>
  );
  const cls = "flex flex-col gap-1 px-5 py-4 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "transition-colors hover:bg-muted")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
};

const EmptyBlock: React.FC<{ title: string; description?: string | null }> = ({ title, description }) => (
  <Empty className="py-12">
    <EmptyHeader>
      <EmptyTitle>{title}</EmptyTitle>
      {description && <EmptyDescription>{description}</EmptyDescription>}
    </EmptyHeader>
  </Empty>
);

const ALL = "all";

/**
 * Growatt alarm log of every plant the user can see, for one plant-local day. One DB read
 * (`/growatt/alarms`): the worker syncs inverters' logs into SQL in the daytime by tier (open
 * alarm or fault every 10 min, alarms today 30 min, none today 60 min).
 * Repeated reports are grouped into events (see `EVENT_GAP_MIN`).
 */
export const ActiveAlarmPage: React.FC = () => {
  const today = plantToday();
  // day and filters live in the URL (?day=&q=&level=&open=1&plant=&code=); a missing or future
  // day means today
  const [url, setUrl] = useUrlState();
  const urlDay = pickDay(url.get("day"));
  const day = urlDay && urlDay < today ? urlDay : today;
  const setDay = (d: string) => setUrl({ day: d >= today ? null : d });
  const query = url.get("q") ?? "";
  const setQuery = (q: string) => setUrl({ q });
  const levelParam = url.get("level");
  const levelFilter: Level | null = levelParam === "crit" || levelParam === "warn" || levelParam === "info" ? levelParam : null;
  const setLevelFilter = (l: Level | null) => setUrl({ level: l });
  const openOnly = url.get("open") === "1";
  const setOpenOnly = (v: boolean) => setUrl({ open: v });
  const plantParam = url.get("plant");
  const plantFilter = plantParam && /^\d+$/.test(plantParam) ? Number(plantParam) : null;
  const setPlantFilter = (id: number | null) => setUrl({ plant: id });
  const codeFilter = url.get("code");
  const setCodeFilter = (c: string | null) => setUrl({ code: c });
  const srcParam = url.get("src");
  const sourceFilter: AlarmEvent["source"] | null = srcParam === "inverter" || srcParam === "sensor" ? srcParam : null;
  const setSourceFilter = (v: AlarmEvent["source"] | null) => setUrl({ src: v });
  const isToday = day === today;
  const [pickerOpen, setPickerOpen] = useState(false);

  const { view, refresh } = useAlarmLog(day);
  // weather sensors: live offline / late / flagged today, stored data gaps for a past day
  const sensorAlarms = useSensorAlarms(day, isToday);
  const sensorTileCount = (() => {
    const inPlant = (s: { plant_id: number }) => plantFilter == null || s.plant_id === plantFilter;
    return isToday ? sensorAlarms.sensors.filter((s) => inPlant(s) && s.st === "offline").length : sensorAlarms.rows.filter(inPlant).length;
  })();
  const result = view?.result ?? null;
  const loading = view?.running ?? false;
  const error = view?.error ?? null;
  /** first read of this day: nothing to show yet */
  const firstRead = !result && !error;
  /** every visible plant with inverters, and how much of the day the worker has read */
  const plants = useMemo(() => result?.plants ?? [], [result]);

  const events = useMemo(() => {
    const sensors = sensorEvents(sensorAlarms.rows, isToday, toPlantLocal(new Date().toISOString()));
    return [...inverterEvents(result, isToday), ...sensors];
  }, [result, isToday, sensorAlarms.rows]);

  /** Every filter except the one named, so each control can show counts for its own options. */
  const matches = useCallback(
    (a: AlarmEvent, skip?: "level" | "open" | "plant" | "code" | "source") => {
      const q = query.trim().toLowerCase();
      if (skip !== "level" && levelFilter && a.level !== levelFilter) return false;
      if (skip !== "open" && openOnly && !a.open) return false;
      if (skip !== "plant" && plantFilter != null && a.plant_id !== plantFilter) return false;
      if (skip !== "code" && codeFilter != null && (a.source !== "inverter" || codeKey(a) !== codeFilter)) return false;
      if (skip !== "source" && sourceFilter != null && a.source !== sourceFilter) return false;
      if (!q) return true;
      return [a.plant_name, String(a.plant_id), a.device_sn, a.alarm_message, a.fault_type, String(a.alarm_code ?? "")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    },
    [query, levelFilter, openOnly, plantFilter, codeFilter, sourceFilter]
  );

  const rows = useMemo(
    () =>
      events
        .filter((a) => matches(a))
        .sort(
          (a, b) =>
            Number(b.open) - Number(a.open) ||
            Number(b.level === "crit") - Number(a.level === "crit") ||
            (b.last ?? "").localeCompare(a.last ?? "")
        ),
    [events, matches]
  );

  // the table ends at the bottom of the screen: as many rows per page as fit, then pages
  const tableRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ height: number; pageSize: number }>({ height: 480, pageSize: 10 });
  const [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const el = tableRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(260, window.innerHeight - top - PAGER_H - BOTTOM_GAP);
      const headH = el.querySelector("thead")?.getBoundingClientRect().height || 36;
      const rowH = el.querySelector("tbody tr")?.getBoundingClientRect().height || 40;
      const pageSize = Math.max(5, Math.floor((height - headH) / rowH));
      setFit((f) => (f.height === height && f.pageSize === pageSize ? f : { height, pageSize }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rows.length > 0, firstRead]);
  // back to the first page when the day or a filter changes
  useEffect(() => setPage(0), [day, query, levelFilter, openOnly, plantFilter, codeFilter, sourceFilter]);
  const { pageNo } = pageBounds(rows.length, fit.pageSize, page);
  const pageRows = rows.slice(pageNo * fit.pageSize, (pageNo + 1) * fit.pageSize);

  const stats = useMemo(() => {
    const byLevel: Record<Level, number> = { crit: 0, warn: 0, info: 0 };
    for (const a of events) if (matches(a, "level")) byLevel[a.level as Level]++;
    return {
      total: events.length,
      open: events.filter((a) => matches(a, "open") && a.open).length,
      byLevel,
      plants: new Set(events.filter((a) => matches(a, "plant")).map((a) => a.plant_id)).size,
      bySource: {
        inverter: events.filter((a) => a.source === "inverter" && matches(a, "source")).length,
        sensor: events.filter((a) => a.source === "sensor" && matches(a, "source")).length,
      },
    };
  }, [events, matches]);

  // plants by open events, then by count (for the plant filter)
  const byPlant = useMemo(() => {
    const m = new Map<number, { name: string; count: number; open: number; faults: number }>();
    for (const a of events) {
      if (!matches(a, "plant")) continue;
      const e = m.get(a.plant_id) ?? { name: a.plant_name, count: 0, open: 0, faults: 0 };
      e.count++;
      if (a.open) e.open++;
      if (a.level === "crit") e.faults++;
      m.set(a.plant_id, e);
    }
    return [...m.entries()].sort((a, b) => b[1].open - a[1].open || b[1].count - a[1].count);
  }, [events, matches]);

  // most frequent alarm codes in the current view
  const byCode = useMemo(() => {
    const m = new Map<string, { message: string | null; level: StatusLevel; count: number; open: number }>();
    for (const a of events) {
      if (a.source !== "inverter" || !matches(a, "code")) continue;
      const k = codeKey(a);
      const e = m.get(k) ?? { message: a.alarm_message, level: a.level, count: 0, open: 0 };
      e.count++;
      if (a.open) e.open++;
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].open - a[1].open || b[1].count - a[1].count);
  }, [events, matches]);


  const unsynced = plants.filter((p) => p.synced_inverters === 0);
  const partly = plants.filter((p) => p.synced_inverters > 0 && p.synced_inverters < p.inverters);
  const syncedCount = plants.length - unsynced.length;
  const nameOf = (id: number) => plants.find((p) => p.plant_id === id)?.name ?? `Plant ${id}`;
  const anyFilter = levelFilter != null || openOnly || plantFilter != null || codeFilter != null || sourceFilter != null || query.trim() !== "";
  const clearFilters = () => setUrl({ level: null, open: null, plant: null, code: null, src: null, q: null });
  const lastSync = result?.syncedAt ? toPlantLocal(result.syncedAt) : null;

  const exportCsv = () => {
    const head = ["source", "plant_id", "plant", "device", "start_time", "last_report", "reports", "state", "fault_type", "alarm_code", "alarm_message"];
    const esc = (v: unknown) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const body = rows.map((a) =>
      [a.source, a.plant_id, a.plant_name, a.device_sn, a.start, a.last, a.reports || null, a.state ?? (a.open ? "open" : "cleared"), a.fault_type, a.alarm_code, a.alarm_message]
        .map(esc)
        .join(",")
    );
    const href = URL.createObjectURL(new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `growatt-alarms-${day}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  };


  /** today's next sync is 20 min overdue (the worker is busy or down); without the schedule (an
   * older API), the newest read is over an hour old */
  const STALE_MS = 20 * 60000;
  const stale =
    isToday &&
    (result?.nextRunAt != null
      ? Date.now() - Date.parse(result.nextRunAt) > STALE_MS
      : result?.syncedAt != null && Date.now() - Date.parse(result.syncedAt) > 60 * 60000);
  const syncVariant = error && !result ? "crit" : !result ? "neutral" : stale || unsynced.length || partly.length ? "warn" : "ok";
  const notSynced = unsynced.length + partly.length;
  const historyBehind = isToday ? sensorAlarms.sensors.filter((x) => x.allFlags.some((f) => f.code === "stale_history")).length : 0;
  const syncText = lastSync ? (lastSync.slice(0, 10) === day ? hm(lastSync) : lastSync.slice(5, 16)) : "—";
  const levelsShown = LEVELS.filter((l) => l.level !== "info" || stats.byLevel.info > 0 || levelFilter === "info");

  return (
    <div className="flex flex-col gap-4">
      {/* header: title, sync state, day */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">Active Alarm</h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={syncVariant} className="text-xs">
                {loading && !result && !error && <Spinner data-icon="inline-start" className="size-3" />}
                {error && !result ? "Not loaded" : loading && !result ? "Loading…" : `Sync ${syncText}`}
                {notSynced > 0 && <span className="num">· {notSynced} pending</span>}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {error ? (
                <p>Could not load: {error}</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  <p>
                    {fmtInt(syncedCount)} of {fmtInt(plants.length)} plants read for {day}
                  </p>
                  {stale && <p>The worker's alarm sync is behind: open alarms are as of {syncText}</p>}
                  {isToday && <p>Open alarms and faults re-read every 10 min, other inverters hourly</p>}
                  {historyBehind > 0 && <p>{historyBehind} weather sensors' stored history is behind</p>}
                  {unsynced.length > 0 && <p>{unsynced.length} not read yet</p>}
                  {partly.length > 0 && <p>{partly.length} partly read</p>}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup>
            <Button variant="outline" size="icon-sm" onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">
              <ChevronLeft />
            </Button>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="num min-w-36" aria-label="Alarm day">
                  {dayLabel(day)}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={toDate(day)}
                  defaultMonth={toDate(day)}
                  disabled={{ after: toDate(today) }}
                  onSelect={(d) => {
                    if (!d) return;
                    setDay(fromDate(d));
                    setPickerOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            <Button variant="outline" size="icon-sm" onClick={() => setDay(shiftDay(day, 1))} disabled={isToday} aria-label="Next day">
              <ChevronRight />
            </Button>
          </ButtonGroup>
          <Button variant="outline" size="sm" onClick={() => setDay(today)} disabled={isToday}>
            Today
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* summary */}
      <Card className="py-0">
        <CardContent className="grid grid-cols-2 divide-white/[0.06] px-0 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          <Stat label="Open" value={fmtInt(stats.open)} tone={stats.open ? "text-red-300" : "text-emerald-300"} />
          <Stat label="Faults" value={fmtInt(stats.byLevel.crit)} tone={stats.byLevel.crit ? "text-red-300" : "text-muted-foreground"} />
          <Stat label="Warnings" value={fmtInt(stats.byLevel.warn)} tone={stats.byLevel.warn ? "text-amber-300" : "text-muted-foreground"} />
          <Stat
            label="Plants affected"
            value={
              <>
                {fmtInt(stats.plants)}
                <span className="text-base font-medium text-muted-foreground"> / {fmtInt(plants.length)}</span>
              </>
            }
          />
          <Stat
            label={isToday ? "Sensors offline" : "Sensor data gaps"}
            value={fmtInt(sensorTileCount)}
            tone={!sensorTileCount ? "text-muted-foreground" : isToday ? "text-red-300" : "text-amber-300"}
            onClick={() => setSourceFilter(sourceFilter === "sensor" ? null : "sensor")}
          />
        </CardContent>
      </Card>

      {/* the log: filters on top, table as long as the page (no inner scroll) */}
      <Card className="gap-0 py-0">
        {/* state tabs, search, export */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={openOnly ? "open" : ALL} onValueChange={(v) => setOpenOnly(v === "open")}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value={ALL} className="px-3 py-2.5 text-sm">
                All alarms <span className="num text-muted-foreground">{fmtInt(stats.total)}</span>
              </TabsTrigger>
              <TabsTrigger value="open" className="px-3 py-2.5 text-sm">
                Open <span className="num text-red-300">{fmtInt(stats.open)}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 pb-2">
            <Input className="h-8 w-60" placeholder="Search plant, SN, message" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search alarms" />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              Export CSV
            </Button>
          </div>
        </div>

        {/* filters: one control type, one line */}
        <CardContent className="flex flex-wrap items-center gap-2 border-b py-3">
          <Select value={sourceFilter ?? ALL} onValueChange={(v) => setSourceFilter(v === "inverter" || v === "sensor" ? v : null)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All sources</SelectItem>
                <SelectItem value="inverter">Inverters ({fmtInt(stats.bySource.inverter)})</SelectItem>
                <SelectItem value="sensor">Weather sensors ({fmtInt(stats.bySource.sensor)})</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={levelFilter ?? ALL} onValueChange={(v) => setLevelFilter(v === "crit" || v === "warn" || v === "info" ? v : null)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All levels</SelectItem>
                {levelsShown.map((l) => (
                  <SelectItem key={l.level} value={l.level}>
                    {l.label} ({fmtInt(stats.byLevel[l.level])})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={plantFilter != null ? String(plantFilter) : ALL} onValueChange={(v) => setPlantFilter(v === ALL ? null : Number(v))}>
            <SelectTrigger size="sm" className="w-56" aria-label="Plant">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All plants</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                {plantFilter != null && !byPlant.some(([id]) => id === plantFilter) && (
                  <SelectItem value={String(plantFilter)}>{nameOf(plantFilter)} (0)</SelectItem>
                )}
                {byPlant.map(([id, e]) => (
                  <SelectItem key={id} value={String(id)}>
                    {e.name} ({e.open ? `${e.open} open · ` : ""}
                    {e.count})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={codeFilter ?? ALL} onValueChange={(v) => setCodeFilter(v === ALL ? null : v)}>
            <SelectTrigger size="sm" className="w-56" aria-label="Alarm code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All codes</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                {codeFilter != null && !byCode.some(([c]) => c === codeFilter) && <SelectItem value={codeFilter}>Code {codeFilter} (0)</SelectItem>}
                {byCode.map(([code, e]) => (
                  <SelectItem key={code} value={code}>
                    {code} · {e.message ?? "—"} ({e.count})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto">
              Clear
            </Button>
          )}
        </CardContent>
        <CardContent ref={tableRef} className="overflow-hidden px-0" style={{ height: fit.height }}>
          {rows.length === 0 ? (
            firstRead ? (
              <SkeletonRows rows={8} className="p-4" />
            ) : !result ? (
              <EmptyBlock title="Alarm log unavailable" description={error} />
            ) : (
              <EmptyBlock title={!plants.length ? "No plants" : stats.total ? "No matching alarms" : syncedCount ? "No alarms" : "Not synced yet"} />
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Last</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Plant</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((a) => (
                  <TableRow key={a.key} className={cn(!a.open && "opacity-70")}>
                    <TableCell>
                      <Badge variant={a.open || a.state ? badgeOf(a.level) : "neutral"}>{a.state ?? (a.open ? "Open" : "Cleared")}</Badge>
                    </TableCell>
                    <TableCell className="num whitespace-nowrap">{hm(a.start)}</TableCell>
                    <TableCell
                      className="num whitespace-nowrap"
                      title={a.source === "sensor" ? (a.last ? `Last upload ${a.last}` : undefined) : `${a.reports} report${a.reports === 1 ? "" : "s"} from Growatt`}
                    >
                      {a.source === "sensor" ? fmtWhen(a.last, day) : a.reports > 1 ? hm(a.last) : "—"}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right">{fmtDuration(a.minutes)}</TableCell>
                    <TableCell className="max-w-[260px]">
                      <Link to={plantPath(a.plant_id)} className="block max-w-full truncate hover:text-solar-400" title={a.plant_name}>
                        {a.plant_name}
                      </Link>
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-muted-foreground">
                      {a.href ? (
                        <Link to={a.href} className="hover:text-solar-400">
                          {a.device_sn}
                        </Link>
                      ) : (
                        a.device_sn
                      )}
                    </TableCell>
                    <TableCell>
                      {a.source === "sensor" ? (
                        <Badge variant="info">Sensor</Badge>
                      ) : (
                        <Badge variant={badgeOf(a.level)} className="num" title={a.fault_type ?? undefined}>
                          {a.alarm_code ?? "—"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{a.alarm_message ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        <CardContent className="border-t py-2.5">
          <TablePager rows={rows.length} pageSize={fit.pageSize} pageNo={pageNo} onPage={setPage} />
        </CardContent>
      </Card>


    </div>
  );
};

export default ActiveAlarmPage;
