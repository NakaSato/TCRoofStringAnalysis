import React, { useCallback, useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  BellRing,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Download,
  Hash,
  Info,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { GrowattAlarm } from "../api/client";
import { plantToday, useAlarmLog } from "../context/alarmLogStore";
import type { AlarmRow } from "../context/alarmLogStore";
import { useAppContext } from "../context/AppContext";
import { PageHeader, Panel, StatusBadge, Led, EmptyState, LoadingState, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { PanelChart } from "../components/PanelChart";
import type { PanelChartSpec } from "../components/PanelChart";
import { STATUS } from "../components/chartTheme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
/** "2026-11-10 06:16:07" → "06:16:07" */
const hms = (t: string | null) => (t ? t.slice(11, 19) : "—");
const durationMin = (a: GrowattAlarm): number | null => {
  if (!a.start_time || !a.end_time) return null;
  const ms = Date.parse(a.end_time.replace(" ", "T")) - Date.parse(a.start_time.replace(" ", "T"));
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : null;
};
const fmtDuration = (min: number | null) =>
  min == null ? "—" : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} m`;
const codeKey = (a: GrowattAlarm) => (a.alarm_code == null ? "—" : String(a.alarm_code));

type Level = "crit" | "warn" | "info";
const LEVELS: Array<{ level: Level; label: string; icon: LucideIcon; color: string; text: string; ring: string }> = [
  { level: "crit", label: "Faults", icon: AlertOctagon, color: STATUS.crit, text: "text-red-300", ring: "ring-red-400/50" },
  { level: "warn", label: "Warnings", icon: AlertTriangle, color: STATUS.warn, text: "text-amber-300", ring: "ring-amber-400/50" },
  { level: "info", label: "Other", icon: Info, color: STATUS.none, text: "text-slate-300", ring: "ring-slate-400/50" },
];

/** Severity / state tile that doubles as a filter toggle. */
const FilterTile: React.FC<{
  label: string;
  value: number;
  icon: LucideIcon;
  text: string;
  ring: string;
  active: boolean;
  hint?: string;
  onClick: () => void;
}> = ({ label, value, icon: Icon, text, ring, active, hint, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      "group flex flex-col gap-1 rounded-xl border border-white/[0.07] bg-ink-900/80 px-4 py-3 text-left transition hover:border-white/15 hover:bg-ink-850",
      active && `bg-ink-850 ring-1 ${ring}`
    )}
  >
    <span className="flex items-center justify-between gap-2">
      <span className="eyebrow">{label}</span>
      <Icon className={cn("size-3.5", text)} />
    </span>
    <span className={cn("num text-2xl font-bold tracking-tight", value ? text : "text-slate-500")}>{fmtInt(value)}</span>
    <span className="text-[11px] text-slate-500">{hint ?? (active ? "Filtering · click to clear" : "Click to filter")}</span>
  </button>
);

const hhmm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * Growatt alarm log of every plant the user can see, for one plant-local day. One DB read
 * (`/growatt/alarms`): the worker syncs each inverter's log into SQL every 30 min in the daytime.
 */
export const ActiveAlarmPage: React.FC = () => {
  const { selectGrowattPlant } = useAppContext();
  const today = plantToday();
  const [day, setDay] = useState(today);
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<Level | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [plantFilter, setPlantFilter] = useState<number | null>(null);
  const [codeFilter, setCodeFilter] = useState<string | null>(null);

  const { view, refresh } = useAlarmLog(day);
  const result = view?.result ?? null;
  const loading = view?.running ?? false;
  const error = view?.error ?? null;
  /** first read of this day: nothing to show yet */
  const firstRead = !result && !error;
  const allRows = useMemo(() => result?.rows ?? [], [result]);
  /** every visible plant with inverters, and how much of the day the worker has read */
  const plants = result?.plants ?? [];

  /** Every filter except the one named, so each control can show counts for its own options. */
  const matches = useCallback(
    (a: AlarmRow, skip?: "level" | "open" | "plant" | "code") => {
      const q = query.trim().toLowerCase();
      if (skip !== "level" && levelFilter && a.level !== levelFilter) return false;
      if (skip !== "open" && openOnly && !a.open) return false;
      if (skip !== "plant" && plantFilter != null && a.plant_id !== plantFilter) return false;
      if (skip !== "code" && codeFilter != null && codeKey(a) !== codeFilter) return false;
      if (!q) return true;
      return [a.plant_name, String(a.plant_id), a.device_sn, a.alarm_message, a.fault_type, String(a.alarm_code ?? "")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    },
    [query, levelFilter, openOnly, plantFilter, codeFilter]
  );

  const rows = useMemo(
    () =>
      allRows
        .filter((a) => matches(a))
        .sort((a, b) => Number(b.open) - Number(a.open) || (b.start_time ?? "").localeCompare(a.start_time ?? "")),
    [allRows, matches]
  );

  const stats = useMemo(() => {
    const byLevel: Record<Level, number> = { crit: 0, warn: 0, info: 0 };
    for (const a of allRows) if (matches(a, "level")) byLevel[a.level as Level]++;
    return {
      total: allRows.length,
      open: allRows.filter((a) => matches(a, "open") && a.open).length,
      byLevel,
      plants: new Set(allRows.map((a) => a.plant_id)).size,
    };
  }, [allRows, matches]);

  // plants by open alarms, then by count (for the plant filter)
  const byPlant = useMemo(() => {
    const m = new Map<number, { name: string; count: number; open: number; faults: number }>();
    for (const a of allRows) {
      if (!matches(a, "plant")) continue;
      const e = m.get(a.plant_id) ?? { name: a.plant_name, count: 0, open: 0, faults: 0 };
      e.count++;
      if (a.open) e.open++;
      if (a.level === "crit") e.faults++;
      m.set(a.plant_id, e);
    }
    return [...m.entries()].sort((a, b) => b[1].open - a[1].open || b[1].count - a[1].count);
  }, [allRows, matches]);

  // most frequent alarm codes in the current view
  const byCode = useMemo(() => {
    const m = new Map<string, { message: string | null; level: StatusLevel; count: number; plants: Set<number> }>();
    for (const a of allRows) {
      if (!matches(a, "code")) continue;
      const k = codeKey(a);
      const e = m.get(k) ?? { message: a.alarm_message, level: a.level, count: 0, plants: new Set<number>() };
      e.count++;
      e.plants.add(a.plant_id);
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  }, [allRows, matches]);

  // alarm starts per plant-local hour, by severity, for the rows in view
  const hourSpec = useMemo<PanelChartSpec | null>(() => {
    if (!rows.length) return null;
    const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
    const counts: Record<Level, number[]> = { crit: Array(24).fill(0), warn: Array(24).fill(0), info: Array(24).fill(0) };
    for (const a of rows) {
      const h = Number(a.start_time?.slice(11, 13));
      if (Number.isInteger(h) && h >= 0 && h < 24) counts[a.level as Level][h]++;
    }
    const shown = LEVELS.filter((l) => counts[l.level].some((n) => n > 0));
    return {
      xKind: "band",
      x: hours,
      xTickLabel: (v) => `${v}`,
      xTipLabel: (v) => `${v}:00–${v}:59 (plant time)`,
      panels: [
        {
          key: "starts",
          title: "Alarms started (count)",
          series: shown.map((l) => ({
            key: l.level,
            name: l.label,
            type: "bar" as const,
            color: l.color,
            y: counts[l.level],
            format: (v: number) => fmtInt(v),
          })),
        },
      ],
    };
  }, [rows]);

  const unsynced = plants.filter((p) => p.synced_inverters === 0);
  const partly = plants.filter((p) => p.synced_inverters > 0 && p.synced_inverters < p.inverters);
  const syncedCount = plants.length - unsynced.length;
  const nameOf = (id: number) => plants.find((p) => p.plant_id === id)?.name ?? `Plant ${id}`;
  const isToday = day === today;
  const anyFilter = levelFilter != null || openOnly || plantFilter != null || codeFilter != null || query.trim() !== "";
  const clearFilters = () => {
    setLevelFilter(null);
    setOpenOnly(false);
    setPlantFilter(null);
    setCodeFilter(null);
    setQuery("");
  };

  const exportCsv = () => {
    const head = ["plant_id", "plant", "device_sn", "start_time", "end_time", "state", "fault_type", "alarm_code", "alarm_message"];
    const esc = (v: unknown) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const body = rows.map((a) =>
      [a.plant_id, a.plant_name, a.device_sn, a.start_time, a.end_time, a.open ? "open" : "cleared", a.fault_type, a.alarm_code, a.alarm_message]
        .map(esc)
        .join(",")
    );
    const url = URL.createObjectURL(new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `growatt-alarms-${day}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filterChips: Array<{ label: string; clear: () => void }> = [
    ...(openOnly ? [{ label: "Open only", clear: () => setOpenOnly(false) }] : []),
    ...(levelFilter ? [{ label: LEVELS.find((l) => l.level === levelFilter)!.label, clear: () => setLevelFilter(null) }] : []),
    ...(plantFilter != null ? [{ label: nameOf(plantFilter), clear: () => setPlantFilter(null) }] : []),
    ...(codeFilter != null ? [{ label: `Code ${codeFilter}`, clear: () => setCodeFilter(null) }] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        icon={BellRing}
        eyebrow="Operations"
        title="Active Alarm"
        description={`Growatt alarm log of ${result ? fmtInt(plants.length) : "all"} plants for one plant-local day, synced from Growatt every 30 min (05:00–21:00) and completed after midnight.`}
        actions={
          <>
            <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-ink-900/80 p-1">
              <Button variant="ghost" size="icon-sm" onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">
                <ChevronLeft />
              </Button>
              <Input
                type="date"
                className="h-7 w-auto border-0 bg-transparent"
                value={day}
                max={today}
                onChange={(e) => e.target.value && setDay(e.target.value > today ? today : e.target.value)}
                aria-label="Alarm day"
              />
              <Button variant="ghost" size="icon-sm" onClick={() => setDay(shiftDay(day, 1))} disabled={isToday} aria-label="Next day">
                <ChevronRight />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDay(today)} disabled={isToday}>
                Today
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} /> Refresh
            </Button>
          </>
        }
      />

      {/* sync status: how much of the day the worker has read, and when */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/[0.06] bg-ink-900/60 px-4 py-2.5 text-[11px] text-slate-400">
        <span className="flex items-center gap-2">
          <Led
            level={error && !result ? "crit" : !result ? "off" : unsynced.length || partly.length ? "warn" : "ok"}
            pulse={loading}
          />
          <span className="font-semibold text-slate-200">{dayLabel(day)}</span>
          {isToday && <span className="text-slate-500">· today, still changing</span>}
        </span>
        {result && (
          <span>
            Synced {fmtInt(syncedCount)} of {fmtInt(plants.length)} plants · last sync{" "}
            <span className="num text-slate-300">{hhmm(result.syncedAt)}</span>
          </span>
        )}
        {loading && <span className="text-slate-500">{result ? "Refreshing…" : "Loading…"}</span>}
        {error && <span className="text-red-300">Could not load: {error}</span>}
        {result && (unsynced.length > 0 || partly.length > 0) && (
          <span className="ml-auto flex flex-wrap gap-x-3 text-amber-300/90">
            {unsynced.length > 0 && (
              <span title={unsynced.map((p) => p.name).join("\n")}>
                {unsynced.length} plant{unsynced.length === 1 ? "" : "s"} not synced yet for this day
              </span>
            )}
            {partly.length > 0 && (
              <span
                title={partly.map((p) => `${p.name}: ${p.synced_inverters} of ${p.inverters} inverters`).join("\n")}
              >
                {partly.length} plant{partly.length === 1 ? "" : "s"} partly synced
              </span>
            )}
          </span>
        )}
      </div>

      {/* severity tiles = filters */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <FilterTile
          label="Open now"
          value={stats.open}
          icon={BellRing}
          text={stats.open ? "text-red-300" : "text-emerald-300"}
          ring="ring-red-400/50"
          active={openOnly}
          hint={openOnly ? undefined : "No end time yet"}
          onClick={() => setOpenOnly((v) => !v)}
        />
        {LEVELS.map((l) => (
          <FilterTile
            key={l.level}
            label={l.label}
            value={stats.byLevel[l.level]}
            icon={l.icon}
            text={l.text}
            ring={l.ring}
            active={levelFilter === l.level}
            onClick={() => setLevelFilter(levelFilter === l.level ? null : l.level)}
          />
        ))}
        <div className="flex flex-col gap-1 rounded-xl border border-white/[0.07] bg-ink-900/80 px-4 py-3">
          <span className="flex items-center justify-between gap-2">
            <span className="eyebrow">Plants affected</span>
            <Building2 className="size-3.5 text-solar-400" />
          </span>
          <span className="num text-2xl font-bold tracking-tight text-white">{fmtInt(stats.plants)}</span>
          <span className="text-[11px] text-slate-500">
            of {fmtInt(plants.length)} · {fmtInt(stats.total)} alarms
          </span>
        </div>
      </div>

      {/* when and what */}
      <div className="grid gap-5 xl:grid-cols-3">
        <Panel className="xl:col-span-2" icon={BellRing} title="Alarms by hour" subtitle="Start time, plant-local · follows the filters">
          {hourSpec ? (
            <PanelChart spec={hourSpec} height={220} />
          ) : firstRead ? (
            <LoadingState label="Waiting for alarms…" />
          ) : (
            <EmptyState icon={CheckCircle2} title="No alarms to chart" />
          )}
        </Panel>
        <Panel icon={Hash} title="Top alarm codes" subtitle="Click to filter the log" bodyClassName="p-0">
          {byCode.length === 0 ? (
            <EmptyState icon={CheckCircle2} title={firstRead ? "Waiting for alarms…" : "No alarm codes"} />
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {byCode.map(([code, e]) => {
                const active = codeFilter === code;
                return (
                  <li key={code}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCodeFilter(active ? null : code)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2 text-left text-xs transition hover:bg-white/[0.03]",
                        active && "bg-solar-500/10"
                      )}
                    >
                      <Led level={e.level === "neutral" ? "off" : e.level} />
                      <span className="num w-12 shrink-0 text-slate-300">{code}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-200" title={e.message ?? undefined}>
                        {e.message ?? "—"}
                      </span>
                      <span className="num shrink-0 text-slate-500" title="Plants">
                        {e.plants.size}p
                      </span>
                      <span className="num w-8 shrink-0 text-right font-semibold text-white">{e.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* where, and the log itself */}
      <div className="grid gap-5 xl:grid-cols-4">
        <Panel className="xl:col-span-1" icon={Building2} title="By plant" subtitle="Open alarms first · click to filter" bodyClassName="p-0">
          {byPlant.length === 0 ? (
            firstRead ? (
              <LoadingState label="Waiting for alarms…" />
            ) : (
              <EmptyState icon={CheckCircle2} title="No alarms" description={`No plant matches on ${day}.`} />
            )
          ) : (
            <ul className="max-h-[640px] divide-y divide-white/[0.05] overflow-y-auto">
              {byPlant.map(([id, e]) => {
                const active = plantFilter === id;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      className={cn(
                        "flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition hover:bg-white/[0.03]",
                        active && "bg-solar-500/10"
                      )}
                      onClick={() => setPlantFilter(active ? null : id)}
                    >
                      <Led level={e.open ? (e.faults ? "crit" : "warn") : "off"} />
                      <span className="min-w-0 flex-1 truncate text-slate-200">{e.name}</span>
                      {e.open > 0 && <span className="num text-red-400">{e.open} open</span>}
                      <span className="num w-8 text-right text-slate-400">{e.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          className="xl:col-span-3"
          icon={BellRing}
          title="Alarm log"
          subtitle={`${fmtInt(rows.length)} of ${fmtInt(stats.total)} alarms · open first, newest first`}
          bodyClassName="p-0"
          actions={
            <Button variant="ghost" size="sm" onClick={exportCsv} disabled={!rows.length} title="Download the filtered list as CSV">
              <Download /> CSV
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <InputGroup className="h-7 w-64 bg-ink-950/70">
              <InputGroupAddon>
                <Search className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="Plant, SN, message, code"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search alarms"
              />
            </InputGroup>
            {filterChips.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={c.clear}
                className="inline-flex items-center gap-1 rounded-full border border-solar-400/30 bg-solar-500/10 px-2 py-0.5 text-[11px] text-solar-200 transition hover:bg-solar-500/20"
                title="Remove this filter"
              >
                {c.label}
                <X className="size-3" />
              </button>
            ))}
            {anyFilter && (
              <Button variant="ghost" size="xs" onClick={clearFilters} className="ml-auto">
                Clear all
              </Button>
            )}
          </div>

          {rows.length === 0 ? (
            firstRead ? (
              <LoadingState label="Loading alarm log…" />
            ) : !result ? (
              <EmptyState icon={CloudOff} title="Alarm log unavailable" description={error ?? undefined} />
            ) : !plants.length ? (
              <EmptyState icon={CloudOff} title="No plants" description="There are no plants with inverters to read." />
            ) : (
              <EmptyState
                icon={CheckCircle2}
                title={stats.total ? "No matching alarms" : syncedCount ? "No alarms" : "Not synced yet"}
                description={
                  stats.total
                    ? "Change or clear the filters to see more."
                    : syncedCount
                      ? `Growatt reported no alarms on ${day} for the ${fmtInt(syncedCount)} synced plants.`
                      : `No plant has been synced for ${day} yet.`
                }
              />
            )
          ) : (
            <Table containerClassName="max-h-[640px] overflow-auto">
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Plant</TableHead>
                  <TableHead>Inverter</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a, i) => (
                  <TableRow
                    key={`${a.plant_id}-${a.device_sn}-${a.start_time}-${a.alarm_code}-${i}`}
                    className={cn(a.open ? "bg-red-500/[0.03]" : "opacity-70")}
                  >
                    <TableCell>
                      <StatusBadge status={a.open ? "Open" : "Cleared"} level={a.open ? a.level : "neutral"} />
                    </TableCell>
                    <TableCell className="num whitespace-nowrap">{hms(a.start_time)}</TableCell>
                    <TableCell className="num whitespace-nowrap">{a.open ? "—" : hms(a.end_time)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right">{fmtDuration(durationMin(a))}</TableCell>
                    <TableCell className="max-w-[220px]">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left text-slate-200 hover:text-solar-400"
                        title={`${a.plant_name} · make this the selected plant across the app`}
                        onClick={() => selectGrowattPlant(a.plant_id, false)}
                      >
                        {a.plant_name}
                      </button>
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-slate-400">{a.device_sn}</TableCell>
                    <TableCell>
                      <StatusBadge status={a.fault_type ?? "—"} level={a.level} dot={false} />
                    </TableCell>
                    <TableCell className="num whitespace-nowrap">{a.alarm_code ?? "—"}</TableCell>
                    <TableCell className="text-slate-200">{a.alarm_message ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
};

export default ActiveAlarmPage;
