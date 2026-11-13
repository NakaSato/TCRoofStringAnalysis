import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  CircleCheck,
  CircleHelp,
  Clock,
  CloudOff,
  Code,
  Database,
  Gauge,
  Info,
  ListChecks,
  RefreshCw,
  Search,
  Sun,
  TriangleAlert,
  WifiOff,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../api/client";
import type {
  GrowattLive,
  GrowattWeatherPoint,
  GrowattWeatherDay,
  GrowattWeatherField,
  SensorList,
  SensorLive,
  SensorLiveRow,
  SensorLiveStatus,
  SensorFlag,
  SensorRow,
  SensorStatus,
} from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { useAppContext } from "../context/AppContext";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { plantPath } from "../context/routes";
import { EmptyState, KpiTile, Led, LoadingState, Meter, PageHeader, Panel, StatusBadge, fmt, fmtInt } from "../components/ui";
import { FIELD_LABEL, FlagChips, FlagList, STATUS_VIEW, overlay } from "../components/sensorView";
import type { ViewRow } from "../components/sensorView";
import { PanelChart } from "../components/PanelChart";
import type { ChartSeries, PanelChartSpec } from "../components/PanelChart";
import { SERIES } from "../components/chartTheme";
import type { StatusLevel } from "../components/ui";
import { cn } from "@/lib/utils";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** DB list re-read while the page is visible: the worker stores new readings every 30 min. */
const REFRESH_MS = 5 * 60_000;
/** Below this share of today's daylight slots a sensor counts as having gaps. */
const LOW_COVERAGE_PCT = 80;

const TABS = ["status", "info"] as const;
type Tab = (typeof TABS)[number];
const FILTERS = ["all", "online", "late", "offline", "unknown", "not_synced", "low", "flags"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = ["plant", "sensor", "last", "coverage", "irradiance"] as const;
type SortKey = (typeof SORTS)[number];

const FIELD_UNIT: Record<GrowattWeatherField, string> = {
  irradiance_wm2: "W/m²",
  module_temp_c: "°C",
  ambient_temp_c: "°C",
  humidity_pct: "%",
  wind_speed_ms: "m/s",
  wind_dir_deg: "°",
};
const FIELDS = Object.keys(FIELD_LABEL) as GrowattWeatherField[];

/** Live readings kept for the chart's tail (tab memory only): 24 × 5 min = 2 h. */
const TAIL_MAX = 24;

/** Start of the 5-minute slot, like the stored series ("YYYY-MM-DD HH:MM:SS"). */
const slotOf = (ts: string) => {
  const m = Number(ts.slice(14, 16));
  return `${ts.slice(0, 14)}${String(m - (m % 5)).padStart(2, "0")}:00`;
};

const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Plant-local now as "YYYY-MM-DD HH:MM:SS", the format of stored timestamps. */
const plantNow = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });
const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to.replace(" ", "T")) - Date.parse(from.replace(" ", "T"))) / 60000);
const fmtAge = (min: number) =>
  min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.floor(min / 60)} h ${min % 60} m ago` : `${Math.floor(min / 1440)} d ago`;

/** A stored value: "—" when null, "Not fitted" when the probe never reports. */
const reading = (s: SensorRow, f: GrowattWeatherField, digits = 1) =>
  s.measured && !s.measured.includes(f) ? <span className="text-slate-600">n/f</span> : fmt(s.last?.[f], digits);

const coverageTone = (pct: number | null) =>
  pct == null ? "text-slate-500" : pct >= 90 ? "text-emerald-300" : pct >= LOW_COVERAGE_PCT ? "text-amber-300" : "text-red-300";

const Tile: React.FC<{
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
  text: string;
  active?: boolean;
  onClick?: () => void;
}> = ({ label, value, hint, icon: Icon, text, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!onClick}
    aria-pressed={active}
    className={cn(
      "flex flex-col gap-1 rounded-xl border border-white/[0.07] bg-ink-900/80 px-4 py-3 text-left transition enabled:hover:border-white/15 enabled:hover:bg-ink-850",
      active && "bg-ink-850 ring-1 ring-solar-400/40"
    )}
  >
    <span className="flex items-center justify-between gap-2">
      <span className="eyebrow">{label}</span>
      <Icon className={cn("size-3.5", text)} />
    </span>
    <span className={cn("num text-2xl font-bold tracking-tight", value ? text : "text-slate-500")}>{fmtInt(value)}</span>
    <span className="text-[11px] text-slate-500">{hint}</span>
  </button>
);

const SortHead: React.FC<{
  id: SortKey;
  sort: SortKey;
  desc: boolean;
  onSort: (k: SortKey) => void;
  className?: string;
  children: React.ReactNode;
}> = ({ id, sort, desc, onSort, className, children }) => (
  <TableHead className={className} aria-sort={sort === id ? (desc ? "descending" : "ascending") : undefined}>
    <button type="button" className="inline-flex items-center gap-1 hover:text-white" onClick={() => onSort(id)}>
      {children}
      {sort === id && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </button>
  </TableHead>
);

/**
 * Every weather sensor the user can see (`/growatt/sensors`, DB only): newest stored reading,
 * probes that report, and today's stored coverage, overlaid with the live online state
 * (`/growatt/live/sensors/status`, polled on `refresh_in_s` while visible). A sensor whose
 * datalogger the sweep has not reached yet stays "Not checked". Nothing is written to browser storage.
 */
export const SensorsPage: React.FC = () => <SensorsView />;

/**
 * Plant tab "Sensors": the same Status / Info views for the URL plant's sensors only
 * (`?plant_id=` on both endpoints, so the live sweep checks only this plant's dataloggers).
 */
export const PlantSensorsPage: React.FC = () => {
  const { selectedGrowattPlantId } = useAppContext();
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {selectedGrowattPlantId == null ? (
        <LoadingState label="Loading the plant…" />
      ) : (
        // remount on plant switch: no rows of the previous plant shown under the new one
        <SensorsView key={selectedGrowattPlantId} plantId={selectedGrowattPlantId} />
      )}
    </div>
  );
};

/** `plantId` set = one plant's sensors (no plant column / phase filter), else every visible sensor. */
const SensorsView: React.FC<{ plantId?: number }> = ({ plantId }) => {
  const one = plantId != null;
  const [data, setData] = useState<SensorList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(plantNow);

  // view state in the URL (?tab=&sensor=&status=&phase=&q=&sort=&desc=1)
  const [url, setUrl] = useUrlState();
  const tab: Tab = pick(url.get("tab"), TABS, "status");
  const filter: Filter = pick(url.get("status"), FILTERS, "all");
  const sort: SortKey = pick(url.get("sort"), SORTS, "plant");
  const desc = url.get("desc") === "1";
  const query = url.get("q") ?? "";
  const phaseParam = url.get("phase") ?? "";
  const selectedKey = url.get("sensor") ?? "";

  const [live, setLive] = useState<GrowattLive<SensorLiveStatus> | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listSensors(plantId)
      .then((r) => {
        setData(r);
        setError(null);
        setNow(plantNow());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [plantId]);

  useEffect(() => {
    load();
    const id = window.setInterval(() => !document.hidden && load(), REFRESH_MS);
    const onVisible = () => !document.hidden && setNow(plantNow());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // live online state: the backend sweeps a few dataloggers per request, so poll on refresh_in_s
  // (15 s while the sweep is incomplete, then when the first entry expires)
  useLivePoll(
    Boolean(data?.sensors.length),
    `sensors:${plantId ?? "all"}`,
    () => api.getLiveSensorStatus(plantId),
    (r) => {
      setLive(r);
      setLiveError(null);
      setNow(plantNow());
    },
    (err) => setLiveError(err instanceof Error ? err.message : String(err))
  );

  const sensors = useMemo(() => {
    const byKey = new Map((live?.data.sensors ?? []).map((l) => [l.key, l]));
    return (data?.sensors ?? []).map((s) => overlay(s, byKey.get(s.key)));
  }, [data, live]);
  const phases = useMemo(() => [...new Set(sensors.map((s) => s.phase).filter((p): p is number => p != null))].sort(), [sensors]);
  const phase = phases.map(String).includes(phaseParam) ? phaseParam : "";

  const counts = useMemo(() => {
    const n = (st: SensorStatus) => sensors.filter((s) => s.st === st).length;
    return {
      online: n("online"),
      late: n("late"),
      offline: n("offline"),
      unknown: n("unknown"),
      notSynced: n("not_synced"),
      checked: sensors.filter((s) => s.live?.checked_at != null).length,
      low: sensors.filter((s) => s.coverage_today_pct != null && s.coverage_today_pct < LOW_COVERAGE_PCT).length,
      flags: sensors.filter((s) => s.allFlags.length > 0).length,
    };
  }, [sensors]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = sensors.filter(
      (s) =>
        (filter === "all" ||
          (filter === "low"
            ? s.coverage_today_pct != null && s.coverage_today_pct < LOW_COVERAGE_PCT
            : filter === "flags"
              ? s.allFlags.length > 0
              : s.st === filter)) &&
        (!phase || String(s.phase) === phase) &&
        (!q || `${s.plant_name} ${s.datalogger_sn}#${s.address} ${s.device_name ?? ""}`.toLowerCase().includes(q))
    );
    // nulls last in either direction
    const val = (s: ViewRow): string | number | null =>
      sort === "plant"
        ? s.plant_name.toLowerCase()
        : sort === "sensor"
          ? s.key
          : sort === "last"
            ? s.upload
            : sort === "coverage"
              ? s.coverage_today_pct
              : s.last?.irradiance_wm2 ?? null;
    return out.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return desc ? -c : c;
    });
  }, [sensors, filter, phase, query, sort, desc]);

  const onSort = (k: SortKey) => setUrl({ sort: k === "plant" ? null : k, desc: sort === k ? !desc : false });
  const toggleFilter = (f: Filter) => setUrl({ status: filter === f ? null : f });
  const openInfo = (key: string) => setUrl({ tab: "info", sensor: key });
  const selected = sensors.find((s) => s.key === selectedKey) ?? null;
  const until = data?.meta.coverage_window.until;
  const syncedAt = data?.meta.synced_at ? hhmm(data.meta.synced_at) : null;
  const sweep = live?.data.sweep;
  const sweeping = !live || (sweep != null && sweep.fresh < sweep.total);
  const liveErrors = live ? Object.keys(live.data.errors).length : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Gauge}
        eyebrow={one ? "Plant" : "Monitoring"}
        title={one ? "Sensors" : "Weather Sensors"}
        description={one
          ? "This plant's Growatt weather sensors: online state from Growatt's live sensor list (never stored), plus the newest stored reading, probes that report, and how much of today's daylight is stored."
          : "Every Growatt weather sensor you can see: online state from Growatt's live sensor list (checked a few dataloggers at a time, never stored), plus the newest stored reading, probes that report, and how much of today's daylight is stored."}
        actions={
          <>
            {live && !sweeping && !live.stale ? (
              <Badge variant="ok" className="px-2 py-0.5 text-[11px] font-semibold" title={`Oldest datalogger check ${live.fetched_at}`}>
                Live · {hhmm(live.fetched_at)}
              </Badge>
            ) : (
              <Badge variant="info" className="px-2 py-0.5 text-[11px] font-semibold" title="Growatt's sensor list is fetched a few dataloggers per request">
                {liveError && !live ? "Live status unavailable" : `Status checked ${fmtInt(counts.checked)} / ${fmtInt(sensors.length)}`}
              </Badge>
            )}
            {syncedAt && (
              <Badge variant="neutral" className="px-2 py-0.5 text-[11px] font-semibold" title={`History stored up to the sync that started ${data?.meta.synced_at}`}>
                Last sync {syncedAt}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </>
        }
      />

      {!one && <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "status" ? null : v })}>
        <TabsList>
          <TabsTrigger value="status">
            <ListChecks className="h-3.5 w-3.5" />
            Status
          </TabsTrigger>
          <TabsTrigger value="info">
            <Info className="h-3.5 w-3.5" />
            Info
          </TabsTrigger>
        </TabsList>
      </Tabs>}

      {loading && !data ? (
        <LoadingState label="Loading weather sensors…" />
      ) : error && !data ? (
        <EmptyState icon={CloudOff} title="Sensor list unavailable" description={error} />
      ) : !sensors.length ? (
        <EmptyState
          icon={Gauge}
          title="No weather sensors"
          description={
            one
              ? "This plant has no Growatt weather sensor registered."
              : "None of the plants you can see has a Growatt weather sensor registered. Engineers see only the plants an admin assigned to them."
          }
        />
      ) : one ? (
        <PlantSensorView
          sensors={sensors}
          selected={selected}
          now={now}
          until={until ?? null}
          onPick={(key) => setUrl({ sensor: key })}
          thresholds={live?.data.thresholds ?? { late_min: 15, offline_min: 60 }}
          notes={[error ? `List refresh failed: ${error}` : "", liveError ? `Live check failed: ${liveError}` : ""].filter(Boolean)}
        />
      ) : tab === "status" ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
            {(
              [
                ["online", "Online", counts.online, `Upload ≤ ${live?.data.thresholds.late_min ?? 15} min ago`, CircleCheck, "text-emerald-300"],
                ["late", "Late", counts.late, `${live?.data.thresholds.late_min ?? 15}–${live?.data.thresholds.offline_min ?? 60} min since upload`, Clock, "text-amber-300"],
                ["offline", "Offline", counts.offline, "Lost, or silent > 1 h", WifiOff, "text-red-300"],
                ["unknown", "Not checked", counts.unknown, sweeping ? "Live check in progress" : "No usable live answer", CircleHelp, "text-slate-300"],
              ] as const
            ).map(([f, label, value, hint, icon, text]) => (
              <Tile key={f} label={label} value={value} hint={hint} icon={icon} text={text} active={filter === f} onClick={() => toggleFilter(f)} />
            ))}
            <Tile
              label="Data gaps today"
              value={counts.low}
              hint={`Coverage below ${LOW_COVERAGE_PCT}% · click to filter`}
              icon={TriangleAlert}
              text="text-red-300"
              active={filter === "low"}
              onClick={() => toggleFilter("low")}
            />
            <Tile
              label="Not synced"
              value={counts.notSynced}
              hint="Live unknown, nothing stored"
              icon={CloudOff}
              text="text-amber-300"
              active={filter === "not_synced"}
              onClick={() => toggleFilter("not_synced")}
            />
            <Tile
              label="Health flags"
              value={counts.flags}
              hint="Checks on stored data · click to filter"
              icon={TriangleAlert}
              text="text-amber-300"
              active={filter === "flags"}
              onClick={() => toggleFilter("flags")}
            />
          </div>

          <Panel
            icon={ListChecks}
            title="Sensor status"
            subtitle={`${rows.length} of ${sensors.length} sensors${filter !== "all" ? ` · filter: ${filter === "low" ? "data gaps" : filter === "flags" ? "health flags" : STATUS_VIEW[filter].label}` : ""} · coverage = stored 5-min slots, 06:00–${until ?? "—"} today${error ? ` · refresh failed: ${error}` : ""}${liveError ? ` · live check failed: ${liveError}` : liveErrors ? ` · ${liveErrors} datalogger(s) not answering` : ""}`}
            bodyClassName="p-0"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {!one && phases.length > 1 && (
                  <Select value={phase || "all"} onValueChange={(v) => setUrl({ phase: v === "all" ? null : v })}>
                    <SelectTrigger size="sm" className="w-28" aria-label="Phase">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All phases</SelectItem>
                      {phases.map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          Phase {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <InputGroup className="w-56">
                  <InputGroupAddon>
                    <Search className="size-3.5" />
                  </InputGroupAddon>
                  <InputGroupInput value={query} onChange={(e) => setUrl({ q: e.target.value })} placeholder={one ? "Sensor" : "Plant or sensor"} aria-label="Search sensors" />
                  {query && (
                    <InputGroupAddon align="inline-end">
                      <button type="button" onClick={() => setUrl({ q: null })} aria-label="Clear search">
                        <X className="size-3.5" />
                      </button>
                    </InputGroupAddon>
                  )}
                </InputGroup>
              </div>
            }
          >
            {!rows.length ? (
              <EmptyState icon={Search} title="No sensor matches" description="Change the filter or search." className="py-10" />
            ) : (
              <Table containerClassName="table-wrap max-h-[680px] overflow-auto">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <TableHead>Status</TableHead>
                    {!one && <SortHead id="plant" sort={sort} desc={desc} onSort={onSort}>Plant</SortHead>}
                    <SortHead id="sensor" sort={sort} desc={desc} onSort={onSort}>Sensor</SortHead>
                    <SortHead id="last" sort={sort} desc={desc} onSort={onSort}>Last upload</SortHead>
                    <SortHead id="irradiance" sort={sort} desc={desc} onSort={onSort} className="text-right">W/m²</SortHead>
                    <TableHead className="text-right">Module °C</TableHead>
                    <TableHead className="text-right">Ambient °C</TableHead>
                    <TableHead className="text-right">RH %</TableHead>
                    <TableHead className="text-right">Wind m/s</TableHead>
                    <SortHead id="coverage" sort={sort} desc={desc} onSort={onSort} className="text-right">Coverage</SortHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => {
                    const st = STATUS_VIEW[s.st];
                    return (
                      <TableRow key={s.key} className="cursor-pointer" onClick={() => openInfo(s.key)}>
                        <TableCell>
                          <StatusBadge status={st.label} level={st.level} />
                        </TableCell>
                        {!one && <TableCell className="max-w-[220px]">
                          <Link
                            to={`${plantPath(s.plant_id, "generation")}#weather-station`}
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate font-medium text-slate-100 hover:text-solar-300"
                            title={s.plant_name}
                          >
                            {s.plant_name}
                          </Link>
                          {s.phase != null && <span className="text-[11px] text-slate-500">Phase {s.phase}</span>}
                        </TableCell>}
                        <TableCell className="whitespace-nowrap">
                          <span className="num text-slate-200">
                            {s.datalogger_sn}#{s.address}
                          </span>
                          {s.device_name && <div className="text-[11px] text-slate-500">{s.device_name}</div>}
                        </TableCell>
                        <TableCell
                          className="num whitespace-nowrap"
                          title={
                            s.uploadLive
                              ? `Last upload to Growatt ${s.upload} · newest stored reading ${s.last_reading_at ?? "none"}`
                              : s.upload
                                ? `Newest stored reading ${s.upload}`
                                : undefined
                          }
                        >
                          {s.upload ? (
                            <>
                              {s.upload.slice(0, 10) === now.slice(0, 10) ? s.upload.slice(11, 16) : s.upload.slice(0, 16)}
                              <div className="text-[11px] text-slate-500">
                                {fmtAge(minutesBetween(s.upload, now))} · {s.uploadLive ? "Live" : "Last sync"}
                              </div>
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="num text-right">{reading(s, "irradiance_wm2", 0)}</TableCell>
                        <TableCell className="num text-right">{reading(s, "module_temp_c")}</TableCell>
                        <TableCell className="num text-right">{reading(s, "ambient_temp_c")}</TableCell>
                        <TableCell className="num text-right">{reading(s, "humidity_pct", 0)}</TableCell>
                        <TableCell className="num text-right">{reading(s, "wind_speed_ms")}</TableCell>
                        <TableCell className={cn("num text-right font-semibold", coverageTone(s.coverage_today_pct))}>
                          {s.coverage_today_pct == null ? "—" : `${fmt(s.coverage_today_pct, 0)}%`}
                        </TableCell>
                        <TableCell className="max-w-[240px]">
                          <FlagChips flags={s.allFlags} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Panel>
          <p className="text-[11px] text-slate-500">
            Status: online = last upload ≤ {live?.data.thresholds.late_min ?? 15} min ago, late up to {live?.data.thresholds.offline_min ?? 60} min, offline after that or when Growatt reports the sensor lost.
            Readings are the newest stored record, not live values. n/f = probe not fitted (read 0 all of the last 7 days).
            Coverage counts 5-min slots from 06:00 up to the last history sync{until ? ` (${until})` : ""}.
            Flags are checks, not measurements (hover for the reason): a probe that reported this week reads 0 all of today (wind not checked: calm days read 0),
            irradiance 0 for ≥ 1 h between 10:00 and 15:00 while the plant's inverters produced, or stored history over 2 h behind an online sensor.
            No flag is raised without stored data to support it.
          </p>
        </>
      ) : (
        <SensorInfo sensor={selected} sensors={sensors} now={now} until={until ?? null} onPick={openInfo} />
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.04] py-1.5 last:border-0">
    <span className="text-xs text-slate-400">{label}</span>
    <span className="num text-right text-sm text-slate-100">{children}</span>
  </div>
);

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number | null | undefined) => (deg == null ? "" : COMPASS[Math.round(deg / 45) % 8]);
const DIGITS: Record<GrowattWeatherField, number> = {
  irradiance_wm2: 0,
  module_temp_c: 1,
  ambient_temp_c: 1,
  humidity_pct: 0,
  wind_speed_ms: 1,
  wind_dir_deg: 0,
};

/** Seconds left until `at` (ms), ticking once a second while mounted. */
const useCountdown = (at: number | null) => {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at == null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [at]);
  return at == null ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
};

/** Live detail (polled on `refresh_in_s`, memory only) and today's stored series (DB) of one sensor. */
const useSensorDetail = (sensor: ViewRow | null, now: string, dayArg?: string) => {
  const [detail, setDetail] = useState<GrowattLive<SensorLive> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [stored, setStored] = useState<GrowattWeatherDay | null>(null);
  const [storedError, setStoredError] = useState<string | null>(null);
  const key = sensor?.key ?? "";
  const today = now.slice(0, 10);
  /** day of the stored series; default today */
  const day = dayArg && dayArg < today ? dayArg : today;

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setNextAt(null);
  }, [key]);

  useLivePoll(
    Boolean(sensor),
    key,
    () => api.getLiveSensor(sensor!.datalogger_sn, sensor!.address),
    (r) => {
      setDetail(r);
      setDetailError(null);
      setNextAt(Date.now() + (r.refresh_in_s ?? 60) * 1000);
    },
    (err) => setDetailError(err instanceof Error ? err.message : String(err))
  );
  const countdown = useCountdown(nextAt);

  // today's stored series of this sensor alone (DB), re-read with the page's list
  const plantId = sensor?.plant_id;
  const lastReading = sensor?.last_reading_at;
  useEffect(() => {
    if (plantId == null || !key) return;
    let cancelled = false;
    setStoredError(null);
    api
      .getGrowattPlantWeather(plantId, day, undefined, key)
      .then((r) => !cancelled && setStored(r))
      .catch((err) => {
        if (cancelled) return;
        setStored(null);
        setStoredError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [plantId, key, day, lastReading]);

  const spec = useMemo<PanelChartSpec | null>(() => {
    const pts = stored?.meta.sensor && stored.meta.sensor.datalogger_sn === sensor?.datalogger_sn && stored.meta.sensor.address === sensor?.address ? stored.series : null;
    if (!pts?.length) return null;
    const measured = new Set(stored?.sensors.find((x) => x.datalogger_sn === sensor?.datalogger_sn && x.address === sensor?.address)?.measured ?? FIELDS);
    const temps: ChartSeries[] = [];
    if (measured.has("module_temp_c"))
      temps.push({ key: "mod", name: "Module temp", type: "line", color: SERIES.temp, y: pts.map((p) => p.module_temp_c), unit: "°C" });
    if (measured.has("ambient_temp_c"))
      temps.push({ key: "amb", name: "Ambient temp", type: "line", color: SERIES.ambient, width: 1.5, y: pts.map((p) => p.ambient_temp_c), unit: "°C" });
    return {
      xKind: "time",
      x: pts.map((p) => p.timestamp),
      panels: [
        {
          key: "g",
          title: "POA irradiance (W/m²)",
          weight: temps.length ? 1.4 : 1,
          series: [{ key: "g", name: "POA irradiance", type: "line", area: true, color: SERIES.irradiance, y: pts.map((p) => p.irradiance_wm2), format: (v) => `${fmt(v, 0)} W/m²` }],
        },
        ...(temps.length ? [{ key: "t", title: "Temperature (°C)", zero: false, series: temps }] : []),
      ],
    };
  }, [stored, sensor?.datalogger_sn, sensor?.address]);

  return { detail, detailError, countdown, stored, storedError, spec, today, day };
};

/**
 * One sensor: identity, live state and newest reading (`/growatt/live/sensors/{dl}/{addr}`,
 * polled on `refresh_in_s` while open; memory only), plus today's stored series and coverage (DB).
 * The raw record is sent to admins only.
 */
const SensorInfo: React.FC<{
  sensor: ViewRow | null;
  sensors: ViewRow[];
  now: string;
  until: string | null;
  onPick: (key: string) => void;
}> = ({ sensor, sensors, now, until, onPick }) => {
  const { detail, detailError, countdown, storedError, spec, today } = useSensorDetail(sensor, now);
  const picker = (
    <Select value={sensor?.key ?? ""} onValueChange={onPick}>
      <SelectTrigger size="sm" className="w-72" aria-label="Sensor">
        <SelectValue placeholder="Pick a sensor" />
      </SelectTrigger>
      <SelectContent>
        {sensors.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            {s.plant_name} · {s.datalogger_sn}#{s.address}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (!sensor)
    return (
      <Panel icon={Info} title="Sensor info" actions={picker}>
        <EmptyState icon={Gauge} title="No sensor selected" description="Pick one here, or click a row on the Status tab." />
      </Panel>
    );

  // the sensor's own live answer is newer than the fleet sweep's row once it has arrived
  const l = detail?.data.status ?? sensor.live;
  const stView = STATUS_VIEW[l && l.status !== "unknown" ? l.status : sensor.status];
  const rd = detail?.data.reading ?? null;
  const measured = detail?.data.measured !== undefined ? detail.data.measured : sensor.measured;
  const fitted = (f: GrowattWeatherField) => !measured || measured.includes(f);
  const raw = detail?.data.raw ?? null;
  const readingError = detail?.data.errors.reading;
  const infoFlags = [...sensor.flags, ...(l?.flags ?? [])];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={Info} title={`${sensor.datalogger_sn}#${sensor.address}`} subtitle={sensor.device_name ?? undefined} actions={picker}>
          <Row label="Status">
            <StatusBadge status={stView.label} level={stView.level} />
          </Row>
          <Row label="Plant">
            <Link to={`${plantPath(sensor.plant_id, "generation")}#weather-station`} className="hover:text-solar-300">
              {sensor.plant_name}
            </Link>
          </Row>
          <Row label="Phase (Growatt account)">{sensor.phase ?? "—"}</Row>
          <Row label="Datalogger SN">{sensor.datalogger_sn}</Row>
          <Row label="Bus address">{sensor.address}</Row>
          <Row label="Device name">{sensor.device_name ?? "—"}</Row>
          <Row label="Last upload (Growatt)">
            {l?.last_update_time ? `${l.last_update_time} · ${fmtAge(minutesBetween(l.last_update_time, now))}` : "—"}
          </Row>
          <Row label="Growatt says lost">{l?.lost == null ? "—" : l.lost ? "Yes" : "No"}</Row>
          <Row label="Live check">
            {l?.checked_at ? `${hhmm(l.checked_at)}${l.stale ? " · stale" : ""}${l.listed === false ? " · not in the datalogger's list" : ""}` : "Not checked yet"}
          </Row>
          <Row label="Next refresh">{countdown == null ? (detailError ? "—" : "…") : countdown ? `in ${countdown} s` : "now"}</Row>
          <Row label="Health flags">{infoFlags.length ? `${infoFlags.length}` : "None"}</Row>
          {infoFlags.length > 0 && (
            <div className="mt-2">
              <FlagList flags={infoFlags} />
            </div>
          )}
          <p className="mt-3 text-[11px] text-slate-500">
            Online state comes from Growatt's live sensor list (memory only). Online = upload ≤ {detail?.data.thresholds.late_min ?? 15} min ago, late up to{" "}
            {detail?.data.thresholds.offline_min ?? 60} min.
            {detailError ? ` Live request failed: ${detailError}` : detail?.data.errors.status ? ` Status check failed: ${detail.data.errors.status}` : ""}
          </p>
        </Panel>

        <Panel
          icon={Sun}
          title="Newest reading"
          subtitle={rd ? `Record ${rd.timestamp} · ${fmtAge(minutesBetween(rd.timestamp, now))}` : "From Growatt, live"}
          actions={
            rd ? (
              <Badge variant={rd.stale ? "warn" : "ok"} className="px-2 py-0.5 text-[11px] font-semibold" title={`Fetched ${hhmm(rd.fetched_at)}`}>
                {rd.stale ? "LIVE (STALE)" : "LIVE"} {rd.timestamp.slice(11, 16)}
              </Badge>
            ) : null
          }
        >
          {!detail && !detailError ? (
            <LoadingState label="Asking Growatt for the newest reading…" />
          ) : !rd ? (
            <EmptyState
              icon={CloudOff}
              title="No live reading"
              description={readingError ?? detailError ?? "Growatt has no record for this sensor."}
              className="py-8"
            />
          ) : (
            <>
              <div className="mb-3 rounded-lg border border-white/[0.06] bg-ink-850/70 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">Irradiance</span>
                  <span className="num text-xl font-bold text-solar-300">
                    {fitted("irradiance_wm2") ? fmt(rd.irradiance_wm2, 0) : "—"} <span className="text-xs font-normal text-slate-500">W/m²</span>
                  </span>
                </div>
                {fitted("irradiance_wm2") && rd.irradiance_wm2 != null && <Meter value={rd.irradiance_wm2} max={1100} tone="solar" className="mt-2" />}
              </div>
              {FIELDS.filter((f) => f !== "irradiance_wm2").map((f) => (
                <Row key={f} label={FIELD_LABEL[f]}>
                  {!fitted(f) ? (
                    <span className="text-slate-500">Not fitted</span>
                  ) : (
                    <>
                      {fmt(rd[f], DIGITS[f])} <span className="text-xs text-slate-500">{FIELD_UNIT[f]}</span>
                      {f === "wind_dir_deg" && rd[f] != null && <span className="ml-1 text-xs text-slate-400">{compass(rd[f])}</span>}
                    </>
                  )}
                </Row>
              ))}
            </>
          )}
          <p className="mt-3 text-[11px] text-slate-500">
            {measured
              ? "Live from Growatt, never stored here. Not fitted = the probe read 0 in every stored record of the last 7 days."
              : "Live from Growatt, never stored here. Nothing stored in the last 7 days, so every probe is shown as reported."}
          </p>
        </Panel>
      </div>

      <Panel icon={Database} title="Stored data" subtitle={`Today ${today} · 5-min records in the database`}>
        <div className="grid gap-x-8 md:grid-cols-3">
          <Row label="Newest stored reading">
            {sensor.last_reading_at ? `${sensor.last_reading_at.slice(11, 16)} · ${fmtAge(minutesBetween(sensor.last_reading_at, now))}` : "Nothing stored yet"}
          </Row>
          <Row label={`Coverage today (06:00–${until ?? "—"})`}>
            <span className={coverageTone(sensor.coverage_today_pct)}>{sensor.coverage_today_pct == null ? "—" : `${fmt(sensor.coverage_today_pct, 0)}%`}</span>
          </Row>
          <Row label="Probes reporting (7 d)">{sensor.measured ? sensor.measured.map((f) => FIELD_LABEL[f]).join(", ") || "none" : "—"}</Row>
        </div>
        <div className="mt-3">
          {spec ? (
            <PanelChart spec={spec} height={240} />
          ) : (
            <EmptyState
              icon={Sun}
              title="No readings stored today"
              description={storedError ?? "The worker stores this sensor's 5-min records every 30 min; nothing has arrived for today yet."}
              className="py-8"
            />
          )}
        </div>
      </Panel>

      {raw && (
        <Panel icon={Code} title="Raw record" subtitle="Admin only · every field of the newest record as Growatt reported it">
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 hover:text-white">Show {Object.keys(raw).length} fields</summary>
            <div className="mt-2 grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
              {Object.entries(raw)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <Row key={k} label={k}>
                    {v == null ? "null" : String(v)}
                  </Row>
                ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Only irradiance, temperatures, humidity and wind are used; the other fields are always 0 at these plants.
            </p>
          </details>
        </Panel>
      )}
    </div>
  );
};

const HERO_TONE: Record<StatusLevel, { ring: string; text: string; bg: string }> = {
  ok: { ring: "border-emerald-400/25", text: "text-emerald-300", bg: "from-emerald-500/10" },
  warn: { ring: "border-amber-400/30", text: "text-amber-300", bg: "from-amber-500/10" },
  crit: { ring: "border-red-400/30", text: "text-red-300", bg: "from-red-500/10" },
  info: { ring: "border-sky-400/25", text: "text-sky-300", bg: "from-sky-500/10" },
  neutral: { ring: "border-white/[0.08]", text: "text-slate-300", bg: "from-white/[0.03]" },
};

/** One plain sentence on why the sensor has its status. */
const statusWhy = (st: SensorStatus, l: SensorLiveRow | null, now: string, th: { late_min: number; offline_min: number }) => {
  const age = l?.last_update_time ? fmtAge(minutesBetween(l.last_update_time, now)) : null;
  switch (st) {
    case "online":
      return `Uploading normally · last upload ${age ?? "—"}`;
    case "late":
      return `Last upload ${age ?? "—"}: later than the ${th.late_min} min it should take`;
    case "offline":
      return l?.lost ? "Growatt reports the sensor as lost" : `No upload for over ${th.offline_min} min · last ${age ?? "never"}`;
    case "not_synced":
      return "Nothing stored yet and not checked live";
    default:
      return l?.listed === false ? "Its datalogger no longer lists this sensor" : "Live check in progress…";
  }
};

const Stat: React.FC<{ label: string; children: React.ReactNode; hint?: React.ReactNode }> = ({ label, children, hint }) => (
  <div className="min-w-0">
    <div className="eyebrow">{label}</div>
    <div className="num mt-1 truncate text-sm font-semibold text-slate-100">{children}</div>
    {hint && <div className="mt-0.5 truncate text-[11px] text-slate-500">{hint}</div>}
  </div>
);

/**
 * Plant tab "Sensors": most plants have one sensor, so it opens on that sensor at once — a status
 * hero (why it has its state), the newest live reading as tiles, today's stored chart, and the device
 * details / raw record folded away. With several sensors a switcher picks one (`?sensor=`).
 */
const PlantSensorView: React.FC<{
  sensors: ViewRow[];
  selected: ViewRow | null;
  now: string;
  until: string | null;
  onPick: (key: string) => void;
  thresholds: { late_min: number; offline_min: number };
  notes: string[];
}> = ({ sensors, selected, now, until, onPick, thresholds, notes }) => {
  const sensor = selected ?? sensors[0] ?? null;
  const [url, setUrl] = useUrlState();
  const { detail, detailError, countdown, stored, storedError, today, day } = useSensorDetail(sensor, now, pickDay(url.get("day")) ?? undefined);
  const setDay = (d: string) => setUrl({ day: d >= today ? null : d });

  // the stored day of this sensor alone (a response for another sensor / day is not shown)
  const dayStored =
    stored && stored.meta.day === day && stored.meta.sensor?.datalogger_sn === sensor?.datalogger_sn && stored.meta.sensor?.address === sensor?.address ? stored : null;
  const pts = dayStored?.series ?? [];

  // Live tail: each newest reading the live poll brings (today only) is kept as a point until the
  // worker has stored that slot (the DB wins), so today's chart moves without waiting for a sync.
  const liveRd = detail?.data.reading ?? null;
  const [tail, setTail] = useState<GrowattWeatherPoint[]>([]);
  useEffect(() => setTail([]), [sensor?.key]);
  useEffect(() => {
    if (!liveRd || liveRd.timestamp.slice(0, 10) !== today) return;
    const ts = slotOf(liveRd.timestamp);
    setTail((prev) => {
      if (prev.some((p) => p.timestamp === ts)) return prev;
      const pt = { timestamp: ts } as GrowattWeatherPoint;
      FIELDS.forEach((f) => (pt[f] = liveRd[f] ?? null));
      return [...prev, pt].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-TAIL_MAX);
    });
  }, [liveRd, today]);
  const lastStoredTs = pts.length ? pts[pts.length - 1].timestamp : "";
  const tailPts = useMemo(
    () => (day === today && dayStored ? tail.filter((p) => p.timestamp > lastStoredTs && p.timestamp.slice(0, 10) === day) : []),
    [day, today, dayStored, tail, lastStoredTs]
  );
  const chartPts = useMemo(() => (tailPts.length ? [...pts, ...tailPts] : pts), [pts, tailPts]);
  const dayMeasured = useMemo(
    () => new Set<GrowattWeatherField>(dayStored?.sensors.find((x) => x.datalogger_sn === sensor?.datalogger_sn && x.address === sensor?.address)?.measured ?? []),
    [dayStored, sensor?.datalogger_sn, sensor?.address]
  );
  const daySpec = useMemo<PanelChartSpec | null>(() => {
    // a lone live point draws nothing: wait for a second one (or for stored data)
    if (!chartPts.length || (!pts.length && chartPts.length < 2)) return null;
    // with nothing stored yet today, the live points alone decide which probes to draw
    const has = (f: GrowattWeatherField) => (dayMeasured.size ? dayMeasured.has(f) : chartPts.some((p) => p[f] != null));
    const y = (f: GrowattWeatherField) => chartPts.map((p) => p[f]);
    const panels: PanelChartSpec["panels"] = [];
    if (has("irradiance_wm2"))
      panels.push({
        key: "g",
        title: "POA irradiance (W/m²)",
        weight: 1.4,
        series: [{ key: "g", name: "POA irradiance", type: "line", area: true, color: SERIES.irradiance, y: y("irradiance_wm2"), format: (v) => `${fmt(v, 0)} W/m²` }],
      });
    const temps: ChartSeries[] = [];
    if (has("module_temp_c")) temps.push({ key: "mod", name: "Module temp", type: "line", color: SERIES.temp, y: y("module_temp_c"), unit: "°C" });
    if (has("ambient_temp_c")) temps.push({ key: "amb", name: "Ambient temp", type: "line", color: SERIES.ambient, width: 1.5, y: y("ambient_temp_c"), unit: "°C" });
    if (temps.length) panels.push({ key: "t", title: "Temperature (°C)", zero: false, series: temps });
    if (has("humidity_pct"))
      panels.push({ key: "h", title: "Humidity (%)", series: [{ key: "h", name: "Humidity", type: "line", color: SERIES.secondary, y: y("humidity_pct"), format: (v) => `${fmt(v, 0)} %` }] });
    if (has("wind_speed_ms"))
      panels.push({ key: "w", title: "Wind speed (m/s)", series: [{ key: "w", name: "Wind speed", type: "line", color: SERIES.ac, y: y("wind_speed_ms"), unit: "m/s" }] });
    if (has("wind_dir_deg"))
      panels.push({
        key: "d",
        title: "Wind direction (°)",
        weight: 0.7,
        series: [{ key: "d", name: "Wind direction", type: "points", color: SERIES.ac, y: y("wind_dir_deg"), format: (v) => `${fmt(v, 0)}° ${compass(v)}` }],
      });
    return panels.length ? { xKind: "time", x: chartPts.map((p) => p.timestamp), panels } : null;
  }, [chartPts, dayMeasured]);

  const exportCsv = () => {
    if (!sensor || !pts.length) return;
    const cols = FIELDS.filter((f) => dayMeasured.has(f));
    const head = ["timestamp", ...cols.map((f) => `${f}`)];
    const body = pts.map((p) => [p.timestamp, ...cols.map((f) => (p[f] == null ? "" : String(p[f])))].join(","));
    const meta = `# plant ${sensor.plant_id} ${sensor.plant_name.replace(/[\r\n,]/g, " ")} · sensor ${sensor.datalogger_sn}#${sensor.address} · ${day} · stored 5-min records, plant-local time`;
    const blob = new Blob([[meta, head.join(","), ...body].join("\n")], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `weather-sensor-${sensor.plant_id}-${sensor.datalogger_sn}-${sensor.address}-${day}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  };

  if (!sensor) return null;

  // the sensor's own live answer is newer than the sweep's row once it has arrived
  const l = detail?.data.status ?? sensor.live;
  const st: SensorStatus = l && l.status !== "unknown" ? l.status : sensor.status;
  const view = STATUS_VIEW[st];
  const tone = HERO_TONE[view.level];
  const plantFlags = [...sensor.flags, ...(l?.flags ?? [])];
  const th = detail?.data.thresholds ?? thresholds;
  const rd = detail?.data.reading ?? null;
  const measured = detail?.data.measured !== undefined ? detail.data.measured : sensor.measured;
  const fitted = (f: GrowattWeatherField) => !measured || measured.includes(f);
  const raw = detail?.data.raw ?? null;
  const readingError = detail?.data.errors.reading ?? detail?.data.errors.status;
  const cov = sensor.coverage_today_pct;

  const tile = (f: GrowattWeatherField, icon: LucideIcon, t: React.ComponentProps<typeof KpiTile>["tone"], extra?: React.ReactNode) => (
    <KpiTile
      key={f}
      label={FIELD_LABEL[f]}
      icon={icon}
      tone={fitted(f) && rd?.[f] != null ? t : "neutral"}
      value={!fitted(f) ? <span className="text-slate-600">—</span> : fmt(rd?.[f], DIGITS[f])}
      unit={fitted(f) ? FIELD_UNIT[f] : undefined}
      hint={!fitted(f) ? "Probe not fitted" : extra}
    />
  );

  return (
    <div className="space-y-4">
      {sensors.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Sensors of this plant">
          {sensors.map((s) => {
            const v = STATUS_VIEW[s.st];
            const on = s.key === sensor.key;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onPick(s.key)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-ink-900/80 px-3 py-2 text-left transition hover:border-white/15",
                  on && "bg-ink-850 ring-1 ring-solar-400/40"
                )}
              >
                <Led level={v.level === "info" ? "neutral" : v.level} />
                <span>
                  <span className="num block text-xs font-semibold text-slate-100">
                    {s.datalogger_sn}#{s.address}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {v.label}
                    {s.upload ? ` · ${fmtAge(minutesBetween(s.upload, now))}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* status hero */}
      <section className={cn("rounded-xl border bg-gradient-to-br to-transparent p-5", tone.ring, tone.bg)}>
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-ink-900/70 ring-1 ring-white/10", tone.text)}>
              {st === "online" ? <CircleCheck className="size-5" /> : st === "late" ? <Clock className="size-5" /> : st === "offline" ? <WifiOff className="size-5" /> : st === "not_synced" ? <CloudOff className="size-5" /> : <CircleHelp className="size-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("text-xl font-bold", tone.text)}>{view.label}</span>
                <span className="num text-xs text-slate-400">
                  {sensor.datalogger_sn}#{sensor.address}
                  {sensor.device_name ? ` · ${sensor.device_name}` : ""}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-300">{statusWhy(st, l, now, th)}</p>
              {plantFlags.length > 0 && (
                <div className="mt-2">
                  <FlagList flags={plantFlags} />
                </div>
              )}
              {(detailError || readingError) && <p className="mt-1 text-[11px] text-amber-300">Live request failed: {detailError ?? readingError}</p>}
            </div>
          </div>
          <div className="grid w-full grid-cols-2 gap-x-6 gap-y-3 sm:w-auto sm:grid-cols-4">
            <Stat label="Last upload" hint={l?.last_update_time ? fmtAge(minutesBetween(l.last_update_time, now)) : "Growatt"}>
              {l?.last_update_time ? l.last_update_time.slice(11, 16) : "—"}
            </Stat>
            <Stat
              label="Live check"
              hint={countdown == null ? (detailError ? "retrying" : "…") : countdown ? `next in ${countdown} s` : "refreshing"}
            >
              {l?.checked_at ? `${hhmm(l.checked_at)}${l.stale ? " · stale" : ""}` : "—"}
            </Stat>
            <Stat label="Stored today" hint={`06:00–${until ?? "—"} · 5-min slots`}>
              <span className={coverageTone(cov)}>{cov == null ? "—" : `${fmt(cov, 0)}%`}</span>
              {cov != null && <Meter value={cov} max={100} tone={cov >= 90 ? "ok" : cov >= LOW_COVERAGE_PCT ? "warn" : "crit"} className="mt-1.5 w-24" />}
            </Stat>
            <Stat label="Newest stored" hint={sensor.last_reading_at ? fmtAge(minutesBetween(sensor.last_reading_at, now)) : "nothing yet"}>
              {sensor.last_reading_at ? sensor.last_reading_at.slice(11, 16) : "—"}
            </Stat>
          </div>
        </div>
      </section>

      {/* newest live reading */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Sun className="size-4 text-solar-300" />
            Newest reading
          </h3>
          {rd ? (
            <Badge variant={rd.stale ? "warn" : "ok"} className="px-2 py-0.5 text-[11px] font-semibold" title={`Record ${rd.timestamp} · fetched ${hhmm(rd.fetched_at)}`}>
              {rd.stale ? "LIVE (STALE)" : "LIVE"} · record {rd.timestamp.slice(11, 16)} · {fmtAge(minutesBetween(rd.timestamp, now))}
            </Badge>
          ) : detail || detailError ? (
            <Badge variant="neutral" className="px-2 py-0.5 text-[11px] font-semibold">No live record</Badge>
          ) : null}
        </div>
        {!detail && !detailError ? (
          <LoadingState label="Asking Growatt for the newest reading…" />
        ) : !rd ? (
          <EmptyState icon={CloudOff} title="No live reading" description={readingError ?? detailError ?? "Growatt has no record for this sensor."} className="py-8" />
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <KpiTile
              label="POA irradiance"
              icon={Sun}
              tone={fitted("irradiance_wm2") && rd.irradiance_wm2 != null ? "solar" : "neutral"}
              value={fitted("irradiance_wm2") ? fmt(rd.irradiance_wm2, 0) : <span className="text-slate-600">—</span>}
              unit={fitted("irradiance_wm2") ? "W/m²" : undefined}
              hint={
                !fitted("irradiance_wm2") ? "Probe not fitted" : rd.irradiance_wm2 != null ? <Meter value={rd.irradiance_wm2} max={1100} tone="solar" className="mt-1" /> : undefined
              }
            />
            {tile("module_temp_c", Gauge, "warn")}
            {tile("ambient_temp_c", Gauge, "info")}
            {tile("humidity_pct", Gauge, "info")}
            {tile(
              "wind_speed_ms",
              Gauge,
              "energy",
              fitted("wind_dir_deg") && rd.wind_dir_deg != null ? `from ${compass(rd.wind_dir_deg)} · ${fmt(rd.wind_dir_deg, 0)}°` : undefined
            )}
          </div>
        )}
      </div>

      <Panel
        icon={Database}
        title={day === today ? "Today" : "Day history"}
        subtitle={`${day} · stored 5-min records${pts.length ? ` · ${fmtInt(pts.length)} records, ${pts[0].timestamp.slice(11, 16)}–${pts[pts.length - 1].timestamp.slice(11, 16)}` : ""}${
          tailPts.length ? ` · + ${tailPts.length} live to ${tailPts[tailPts.length - 1].timestamp.slice(11, 16)} (not stored yet)` : ""
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-ink-900/80 p-1">
              <Button variant="ghost" size="icon-sm" onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">
                <ChevronLeft />
              </Button>
              <Input
                type="date"
                className="h-7 w-auto border-0 bg-transparent"
                value={day}
                max={today}
                onChange={(e) => e.target.value && setDay(e.target.value)}
                aria-label="Day"
              />
              <Button variant="ghost" size="icon-sm" onClick={() => setDay(shiftDay(day, 1))} disabled={day >= today} aria-label="Next day">
                <ChevronRight />
              </Button>
            </div>
            {day !== today && (
              <Button variant="ghost" size="sm" onClick={() => setDay(today)}>
                Today
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!pts.length} title="Download this day's stored 5-min records as CSV">
              <Download /> CSV
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to={`${plantPath(sensor.plant_id, "generation")}#weather-station`}>Weather Station</Link>
            </Button>
          </div>
        }
      >
        {dayStored && pts.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-white/[0.06] bg-ink-850/60 p-3 sm:grid-cols-4 xl:grid-cols-8">
            {(
              [
                ["Insolation", dayStored.kpis.insolation_kwh_m2, 2, "kWh/m²", "irradiance_wm2"],
                ["Peak irradiance", dayStored.kpis.peak_irradiance_wm2, 0, "W/m²", "irradiance_wm2"],
                ["Max module", dayStored.kpis.max_module_temp_c, 1, "°C", "module_temp_c"],
                ["Avg module (day)", dayStored.kpis.avg_module_temp_daylight_c, 1, "°C", "module_temp_c"],
                ["Max ambient", dayStored.kpis.max_ambient_temp_c, 1, "°C", "ambient_temp_c"],
                ["Avg humidity", dayStored.kpis.avg_humidity_pct, 0, "%", "humidity_pct"],
                ["Avg wind", dayStored.kpis.avg_wind_speed_ms, 1, "m/s", "wind_speed_ms"],
                ["Max wind", dayStored.kpis.max_wind_speed_ms, 1, "m/s", "wind_speed_ms"],
              ] as const
            ).map(([label, v, d, unit, f]) => (
              <Stat key={label} label={label}>
                {dayMeasured.has(f) ? (
                  <>
                    {fmt(v, d)} <span className="text-[11px] font-normal text-slate-500">{unit}</span>
                  </>
                ) : (
                  <span className="text-slate-600" title="Probe not fitted">—</span>
                )}
              </Stat>
            ))}
          </div>
        )}
        {daySpec ? (
          <PanelChart spec={daySpec} height={120 + daySpec.panels.length * 110} />
        ) : !dayStored && !storedError ? (
          <LoadingState label="Loading stored readings…" />
        ) : (
          <EmptyState
            icon={Sun}
            title={day === today ? "No readings stored today" : `No readings stored for ${day}`}
            description={
              <>
                {storedError ??
                  (day === today ? "The worker stores this sensor's 5-min records every 30 min; nothing has arrived for today yet." : "Raw readings are kept for 90 days.")}
                {!storedError && sensor.last_reading_at && sensor.last_reading_at.slice(0, 10) !== day && (
                  <span className="mt-3 block">
                    <Button variant="outline" size="sm" onClick={() => setDay(sensor.last_reading_at!.slice(0, 10))}>
                      Show {sensor.last_reading_at.slice(0, 10)} · newest stored
                    </Button>
                  </span>
                )}
              </>
            }
            className="py-8"
          />
        )}
      </Panel>

      <Panel icon={Info} title="Device details" bodyClassName="pt-0">
        <details>
          <summary className="cursor-pointer py-2 text-xs text-slate-400 hover:text-white">
            Datalogger, bus address, Growatt flags{raw ? ` and the raw record (${Object.keys(raw).length} fields, admin only)` : ""}
          </summary>
          <div className="grid gap-x-8 md:grid-cols-2">
            <div>
              <Row label="Datalogger SN">{sensor.datalogger_sn}</Row>
              <Row label="Bus address">{sensor.address}</Row>
              <Row label="Device name">{sensor.device_name ?? "—"}</Row>
              <Row label="Phase (Growatt account)">{sensor.phase ?? "—"}</Row>
            </div>
            <div>
              <Row label="Growatt says lost">{l?.lost == null ? "—" : l.lost ? "Yes" : "No"}</Row>
              <Row label="Listed by datalogger">{l?.listed == null ? "—" : l.listed ? "Yes" : "No"}</Row>
              <Row label="Last upload (plant time)">{l?.last_update_time ?? "—"}</Row>
              <Row label="Status rule">
                <span className="text-xs">
                  online ≤ {th.late_min} min · late ≤ {th.offline_min} min
                </span>
              </Row>
            </div>
          </div>
          {raw && (
            <div className="mt-3 grid gap-x-8 border-t border-white/[0.06] pt-2 sm:grid-cols-2 xl:grid-cols-3">
              {Object.entries(raw)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <Row key={k} label={k}>
                    {v == null ? "null" : String(v)}
                  </Row>
                ))}
            </div>
          )}
        </details>
      </Panel>

      <p className="text-[11px] text-slate-500">
        Live values come from Growatt and are never stored here; the chart and coverage are the stored 5-min history. “—” = no value; probe not fitted = it read 0 in every
        stored record of the last 7 days.
        {notes.length ? ` ${notes.join(" · ")}` : ""}
      </p>
    </div>
  );
};

export default SensorsPage;
