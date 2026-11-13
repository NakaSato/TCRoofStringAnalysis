import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  RefreshCw,
  AlertTriangle,
  Search,
  Building2,
  Download,
} from "lucide-react";
import { api } from "../api/client";
import type { GrowattAlarm, GrowattPlant } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { PageHeader, Panel, KpiTile, StatusBadge, Led, EmptyState, LoadingState, Meter, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Plants read at once: each request fans out to one Growatt call per inverter on the backend. */
const PLANT_CONCURRENCY = 3;

/** Growatt's own fault_type label → colour. */
const alarmLevel = (faultType: string | null): StatusLevel => {
  const s = (faultType ?? "").toLowerCase();
  if (/fault|error|fail/.test(s)) return "crit";
  if (/warn/.test(s)) return "warn";
  return "info";
};

/** Today in plant-local time (Growatt alarm times are plant-local, Asia/Bangkok). */
const plantToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "2026-11-10 06:16:07" → "06:16:07" */
const hms = (t: string | null) => (t ? t.slice(11, 19) : "—");
const durationMin = (a: GrowattAlarm): number | null => {
  if (!a.start_time || !a.end_time) return null;
  const ms = Date.parse(a.end_time.replace(" ", "T")) - Date.parse(a.start_time.replace(" ", "T"));
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : null;
};

interface AlarmRow extends GrowattAlarm {
  plant_id: number;
  plant_name: string;
  level: StatusLevel;
  open: boolean;
}

type LevelFilter = "all" | "crit" | "warn" | "info";
type StateFilter = "all" | "open" | "cleared";

interface LoadState {
  day: string;
  done: number;
  total: number;
  rows: AlarmRow[];
  /** plant id → error message (whole plant unreadable) */
  failed: Record<number, string>;
  /** plants where some inverter's log could not be read */
  partial: Record<number, string[]>;
  stale: number;
  finishedAt: Date | null;
}

/**
 * Growatt alarm log of every plant the user can see, for one plant-local day. Read through the
 * backend's memory cache plant by plant (a closed day stays cached for hours); nothing is stored.
 */
export const ActiveAlarmPage: React.FC = () => {
  const { growattPlants, selectGrowattPlant } = useAppContext();
  const today = plantToday();
  const [day, setDay] = useState(today);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState | null>(null);

  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [plantFilter, setPlantFilter] = useState<number | "all">("all");

  // plants that have inverters (others have no alarm log); stable across live-status overlays
  const plantKey = growattPlants.map((p) => p.plant_id).join(",");
  const plants = useMemo<GrowattPlant[]>(
    () => growattPlants.filter((p) => p.inverter_count !== 0),
    [plantKey]
  );

  const runId = useRef(0);
  const load = useCallback(
    (targetDay: string) => {
      const id = ++runId.current;
      const queue = [...plants];
      setState({ day: targetDay, done: 0, total: queue.length, rows: [], failed: {}, partial: {}, stale: 0, finishedAt: null });
      if (!queue.length) {
        setState((s) => (s ? { ...s, finishedAt: new Date() } : s));
        return;
      }
      let active = 0;
      const next = () => {
        if (id !== runId.current) return;
        const p = queue.shift();
        if (!p) {
          if (active === 0) setState((s) => (s && id === runId.current ? { ...s, finishedAt: new Date() } : s));
          return;
        }
        active++;
        api
          .getGrowattLiveAlarms(p.plant_id, targetDay, 1)
          .then((r) => {
            if (id !== runId.current) return;
            const rows: AlarmRow[] = r.data.alarms.map((a) => {
              const level = alarmLevel(a.fault_type);
              return { ...a, plant_id: p.plant_id, plant_name: p.name, level, open: !a.end_time };
            });
            const bad = [...new Set(Object.keys(r.data.errors ?? {}).map((k) => k.split(" ")[0]))];
            setState((s) =>
              s
                ? {
                    ...s,
                    done: s.done + 1,
                    rows: [...s.rows, ...rows],
                    partial: bad.length ? { ...s.partial, [p.plant_id]: bad } : s.partial,
                    stale: s.stale + (r.stale ? 1 : 0),
                  }
                : s
            );
          })
          .catch((err) => {
            if (id !== runId.current) return;
            const msg = err instanceof Error ? err.message : String(err);
            setState((s) => (s ? { ...s, done: s.done + 1, failed: { ...s.failed, [p.plant_id]: msg } } : s));
          })
          .finally(() => {
            active--;
            next();
          });
      };
      for (let i = 0; i < PLANT_CONCURRENCY; i++) next();
    },
    [plants]
  );

  useEffect(() => {
    load(day);
    return () => {
      runId.current++; // cancel the in-flight run
    };
  }, [day, reloadKey, load]);

  const loading = state != null && state.finishedAt == null;
  const allRows = state?.rows ?? [];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows
      .filter((a) => levelFilter === "all" || a.level === levelFilter)
      .filter((a) => stateFilter === "all" || (stateFilter === "open" ? a.open : !a.open))
      .filter((a) => plantFilter === "all" || a.plant_id === plantFilter)
      .filter(
        (a) =>
          !q ||
          [a.plant_name, String(a.plant_id), a.device_sn, a.alarm_message, a.fault_type, String(a.alarm_code ?? "")]
            .join(" ")
            .toLowerCase()
            .includes(q)
      )
      .sort((a, b) => Number(b.open) - Number(a.open) || (b.start_time ?? "").localeCompare(a.start_time ?? ""));
  }, [allRows, query, levelFilter, stateFilter, plantFilter]);

  const stats = useMemo(() => {
    const plantsHit = new Set(allRows.map((a) => a.plant_id));
    return {
      total: allRows.length,
      open: allRows.filter((a) => a.open).length,
      faults: allRows.filter((a) => a.level === "crit").length,
      warnings: allRows.filter((a) => a.level === "warn").length,
      plants: plantsHit.size,
    };
  }, [allRows]);

  // top plants by alarm count (for the plant filter + summary)
  const byPlant = useMemo(() => {
    const m = new Map<number, { name: string; count: number; open: number; faults: number }>();
    for (const a of allRows) {
      const e = m.get(a.plant_id) ?? { name: a.plant_name, count: 0, open: 0, faults: 0 };
      e.count++;
      if (a.open) e.open++;
      if (a.level === "crit") e.faults++;
      m.set(a.plant_id, e);
    }
    return [...m.entries()].sort((a, b) => b[1].open - a[1].open || b[1].count - a[1].count);
  }, [allRows]);

  const failedIds = Object.keys(state?.failed ?? {}).map(Number);
  const partialIds = Object.keys(state?.partial ?? {}).map(Number);
  const nameOf = (id: number) => growattPlants.find((p) => p.plant_id === id)?.name ?? `Plant ${id}`;
  const isToday = day === today;

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

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BellRing}
        eyebrow="Operations"
        title="Active Alarm"
        description={`Growatt alarm log of all ${fmtInt(plants.length)} plants for one plant-local day, read live through the backend cache (not stored).${
          state?.finishedAt ? ` Read at ${state.finishedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : ""
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">
              <ChevronLeft />
            </Button>
            <Input
              type="date"
              className="h-7 w-auto"
              value={day}
              max={today}
              onChange={(e) => e.target.value && setDay(e.target.value > today ? today : e.target.value)}
              aria-label="Alarm day"
            />
            <Button variant="ghost" size="icon-sm" onClick={() => setDay(shiftDay(day, 1))} disabled={isToday} aria-label="Next day">
              <ChevronRight />
            </Button>
            {!isToday && (
              <Button variant="ghost" size="sm" onClick={() => setDay(today)}>
                Today
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} /> Refresh
            </Button>
          </div>
        }
      />

      {loading && state && (
        <div className="panel px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
            <span>Reading Growatt alarm logs for {state.day}…</span>
            <span className="num">
              {fmtInt(state.done)} / {fmtInt(state.total)} plants
            </span>
          </div>
          <Meter value={state.done} max={state.total || 1} tone="info" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiTile accentBar={false} label="Alarms" value={fmtInt(stats.total)} icon={BellRing} tone="info" hint={isToday ? "today" : day} />
        <KpiTile accentBar={false} label="Open (no end time)" value={fmtInt(stats.open)} icon={AlertTriangle} tone={stats.open ? "crit" : "ok"} />
        <KpiTile accentBar={false} label="Faults" value={fmtInt(stats.faults)} icon={AlertTriangle} tone="crit" />
        <KpiTile accentBar={false} label="Warnings" value={fmtInt(stats.warnings)} icon={AlertTriangle} tone="warn" />
        <KpiTile accentBar={false} label="Plants affected" value={fmtInt(stats.plants)} icon={Building2} tone="solar"
          hint={`of ${fmtInt(plants.length)}`} />
      </div>

      {(failedIds.length > 0 || partialIds.length > 0 || (state?.stale ?? 0) > 0) && !loading && (
        <div className="callout-warn space-y-1 text-[12px]">
          {failedIds.length > 0 && (
            <div title={failedIds.map((id) => `${nameOf(id)}: ${state!.failed[id]}`).join("\n")}>
              Could not read {failedIds.length} plant{failedIds.length === 1 ? "" : "s"}: {failedIds.slice(0, 6).map(nameOf).join(", ")}
              {failedIds.length > 6 ? ` +${failedIds.length - 6} more` : ""}. Their alarms are missing from this list.
            </div>
          )}
          {partialIds.length > 0 && (
            <div>
              Some inverters could not be read at {partialIds.length} plant{partialIds.length === 1 ? "" : "s"}:{" "}
              {partialIds.slice(0, 6).map(nameOf).join(", ")}
              {partialIds.length > 6 ? ` +${partialIds.length - 6} more` : ""}.
            </div>
          )}
          {(state?.stale ?? 0) > 0 && <div>{state!.stale} plant log(s) are stale (Growatt refused; last good value shown).</div>}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-4">
        <Panel className="xl:col-span-1" icon={Building2} title="By plant" subtitle="Click to filter" bodyClassName="p-0">
          {byPlant.length === 0 ? (
            loading ? (
              <LoadingState label="Waiting for alarms…" />
            ) : (
              <EmptyState icon={CheckCircle2} title="No alarms" description={`No plant reported an alarm on ${day}.`} />
            )
          ) : (
            <ul className="max-h-[620px] divide-y divide-white/[0.05] overflow-y-auto">
              <li>
                <button
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-xs ${plantFilter === "all" ? "bg-solar-500/10 text-white" : "text-slate-300"}`}
                  onClick={() => setPlantFilter("all")}
                >
                  <span className="font-semibold">All plants</span>
                  <span className="num">{fmtInt(stats.total)}</span>
                </button>
              </li>
              {byPlant.map(([id, e]) => (
                <li key={id}>
                  <button
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs ${plantFilter === id ? "bg-solar-500/10" : ""}`}
                    onClick={() => setPlantFilter(plantFilter === id ? "all" : id)}
                  >
                    <Led level={e.open ? (e.faults ? "crit" : "warn") : "off"} />
                    <span className="min-w-0 flex-1 truncate text-slate-200">{e.name}</span>
                    {e.open > 0 && <span className="num text-red-400">{e.open} open</span>}
                    <span className="num text-slate-400">{e.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          className="xl:col-span-3"
          icon={BellRing}
          title={`Alarm log · ${day}`}
          subtitle={`${fmtInt(rows.length)} of ${fmtInt(stats.total)} alarms${plantFilter !== "all" ? ` · ${nameOf(plantFilter)}` : ""}`}
          bodyClassName="p-0"
          actions={
            <Button variant="ghost" size="sm" onClick={exportCsv} disabled={!rows.length} title="Download the filtered list as CSV">
              <Download /> CSV
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <InputGroup className="h-7 w-56 bg-ink-950/70">
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
            <Tabs value={levelFilter} onValueChange={(v) => setLevelFilter(v as LevelFilter)}>
              <TabsList aria-label="Alarm type">
                {(["all", "crit", "warn", "info"] as LevelFilter[]).map((l) => (
                  <TabsTrigger key={l} value={l}>
                    {l === "all" ? "All types" : l === "crit" ? "Fault" : l === "warn" ? "Warning" : "Other"}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
              <TabsList aria-label="Alarm state">
                {(["all", "open", "cleared"] as StateFilter[]).map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {s === "all" ? "All" : s === "open" ? "Open" : "Cleared"}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {rows.length === 0 ? (
            loading ? (
              <LoadingState label="Reading alarm logs…" />
            ) : !growattPlants.length ? (
              <LoadingState label="Loading plant list…" />
            ) : !plants.length ? (
              <EmptyState icon={CloudOff} title="No plants" description="There are no plants with inverters to read." />
            ) : (
              <EmptyState icon={CheckCircle2} title="No matching alarms" description={stats.total ? "Change the filters to see more." : `Growatt reported no alarms on ${day}.`} />
            )
          ) : (
            <Table containerClassName="max-h-[620px] overflow-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead>State</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead className="text-right">Min</TableHead>
                    <TableHead>Plant</TableHead>
                    <TableHead>Inverter</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a, i) => (
                    <TableRow key={`${a.plant_id}-${a.device_sn}-${a.start_time}-${a.alarm_code}-${i}`} className={a.open ? undefined : "opacity-70"}>
                      <TableCell>
                        <StatusBadge status={a.open ? "Open" : "Cleared"} level={a.open ? a.level : "neutral"} />
                      </TableCell>
                      <TableCell className="num whitespace-nowrap">{hms(a.start_time)}</TableCell>
                      <TableCell className="num whitespace-nowrap">{a.open ? "—" : hms(a.end_time)}</TableCell>
                      <TableCell className="num whitespace-nowrap text-right">{fmtInt(durationMin(a))}</TableCell>
                      <TableCell>
                        <button
                          className="text-left text-slate-200 hover:text-solar-400"
                          title="Make this the selected plant across the app"
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
