import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  CloudOff,
  Database,
  Gauge,
  Info,
  ListChecks,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../api/client";
import type { GrowattWeatherField, SensorList, SensorRow, SensorStatus } from "../api/client";
import { plantPath } from "../context/routes";
import { EmptyState, LoadingState, PageHeader, Panel, StatusBadge, fmt, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { cn } from "@/lib/utils";
import { pick, useUrlState } from "@/lib/useUrlState";
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
const FILTERS = ["all", "unknown", "not_synced", "low"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = ["plant", "sensor", "last", "coverage", "irradiance"] as const;
type SortKey = (typeof SORTS)[number];

const STATUS_VIEW: Record<SensorStatus, { label: string; level: StatusLevel }> = {
  online: { label: "Online", level: "ok" },
  late: { label: "Late", level: "warn" },
  offline: { label: "Offline", level: "crit" },
  unknown: { label: "Not checked", level: "neutral" },
  not_synced: { label: "Not synced", level: "warn" },
};

const FIELD_LABEL: Record<GrowattWeatherField, string> = {
  irradiance_wm2: "Irradiance",
  module_temp_c: "Module temp",
  ambient_temp_c: "Ambient temp",
  humidity_pct: "Humidity",
  wind_speed_ms: "Wind speed",
  wind_dir_deg: "Wind direction",
};
const FIELD_UNIT: Record<GrowattWeatherField, string> = {
  irradiance_wm2: "W/m²",
  module_temp_c: "°C",
  ambient_temp_c: "°C",
  humidity_pct: "%",
  wind_speed_ms: "m/s",
  wind_dir_deg: "°",
};
const FIELDS = Object.keys(FIELD_LABEL) as GrowattWeatherField[];

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
 * probes that report, and today's stored coverage. Online / late / offline need Growatt's live
 * `env_list` and are not stored, so every synced sensor shows "Not checked" until the live
 * sweep exists. Nothing is written to browser storage.
 */
export const SensorsPage: React.FC = () => {
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

  const load = useCallback(() => {
    setLoading(true);
    api
      .listSensors()
      .then((r) => {
        setData(r);
        setError(null);
        setNow(plantNow());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

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

  const sensors = useMemo(() => data?.sensors ?? [], [data]);
  const phases = useMemo(() => [...new Set(sensors.map((s) => s.phase).filter((p): p is number => p != null))].sort(), [sensors]);
  const phase = phases.map(String).includes(phaseParam) ? phaseParam : "";

  const counts = useMemo(
    () => ({
      total: sensors.length,
      stored: sensors.filter((s) => (s.coverage_today_pct ?? 0) > 0).length,
      notSynced: sensors.filter((s) => s.status === "not_synced").length,
      low: sensors.filter((s) => s.coverage_today_pct != null && s.coverage_today_pct < LOW_COVERAGE_PCT).length,
    }),
    [sensors]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = sensors.filter(
      (s) =>
        (filter === "all" ||
          (filter === "low" ? s.coverage_today_pct != null && s.coverage_today_pct < LOW_COVERAGE_PCT : s.status === filter)) &&
        (!phase || String(s.phase) === phase) &&
        (!q || `${s.plant_name} ${s.datalogger_sn}#${s.address} ${s.device_name ?? ""}`.toLowerCase().includes(q))
    );
    // nulls last in either direction
    const val = (s: SensorRow): string | number | null =>
      sort === "plant"
        ? s.plant_name.toLowerCase()
        : sort === "sensor"
          ? s.key
          : sort === "last"
            ? s.last_reading_at
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
  const syncedAt = data?.meta.synced_at ? new Date(data.meta.synced_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Gauge}
        eyebrow="Monitoring"
        title="Weather Sensors"
        description="Every Growatt weather sensor you can see, from stored history: newest reading, probes that report, and how much of today's daylight is stored. Online / offline status needs Growatt's live sensor list and is not checked yet."
        actions={
          <>
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

      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === "status" ? null : v })}>
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
      </Tabs>

      {loading && !data ? (
        <LoadingState label="Loading weather sensors…" />
      ) : error && !data ? (
        <EmptyState icon={CloudOff} title="Sensor list unavailable" description={error} />
      ) : !sensors.length ? (
        <EmptyState
          icon={Gauge}
          title="No weather sensors"
          description="None of the plants you can see has a Growatt weather sensor registered. Engineers see only the plants an admin assigned to them."
        />
      ) : tab === "status" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Sensors" value={counts.total} hint="Registered on your plants" icon={Gauge} text="text-white" active={filter === "all"} onClick={() => setUrl({ status: null })} />
            <Tile label="Stored today" value={counts.stored} hint="At least one reading stored today" icon={Database} text="text-emerald-300" />
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
              hint="Registered, nothing stored yet"
              icon={CloudOff}
              text="text-amber-300"
              active={filter === "not_synced"}
              onClick={() => toggleFilter("not_synced")}
            />
          </div>

          <Panel
            icon={ListChecks}
            title="Sensor status"
            subtitle={`${rows.length} of ${sensors.length} sensors · coverage = stored 5-min slots, 06:00–${until ?? "—"} today${error ? ` · refresh failed: ${error}` : ""}`}
            bodyClassName="p-0"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {phases.length > 1 && (
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
                  <InputGroupInput value={query} onChange={(e) => setUrl({ q: e.target.value })} placeholder="Plant or sensor" aria-label="Search sensors" />
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
                    <SortHead id="plant" sort={sort} desc={desc} onSort={onSort}>Plant</SortHead>
                    <SortHead id="sensor" sort={sort} desc={desc} onSort={onSort}>Sensor</SortHead>
                    <SortHead id="last" sort={sort} desc={desc} onSort={onSort}>Last sync</SortHead>
                    <SortHead id="irradiance" sort={sort} desc={desc} onSort={onSort} className="text-right">W/m²</SortHead>
                    <TableHead className="text-right">Module °C</TableHead>
                    <TableHead className="text-right">Ambient °C</TableHead>
                    <TableHead className="text-right">RH %</TableHead>
                    <TableHead className="text-right">Wind m/s</TableHead>
                    <SortHead id="coverage" sort={sort} desc={desc} onSort={onSort} className="text-right">Coverage</SortHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => {
                    const st = STATUS_VIEW[s.status];
                    return (
                      <TableRow key={s.key} className="cursor-pointer" onClick={() => openInfo(s.key)}>
                        <TableCell>
                          <StatusBadge status={st.label} level={st.level} />
                        </TableCell>
                        <TableCell className="max-w-[220px]">
                          <Link
                            to={`${plantPath(s.plant_id, "generation")}#weather-station`}
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate font-medium text-slate-100 hover:text-solar-300"
                            title={s.plant_name}
                          >
                            {s.plant_name}
                          </Link>
                          {s.phase != null && <span className="text-[11px] text-slate-500">Phase {s.phase}</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="num text-slate-200">
                            {s.datalogger_sn}#{s.address}
                          </span>
                          {s.device_name && <div className="text-[11px] text-slate-500">{s.device_name}</div>}
                        </TableCell>
                        <TableCell className="num whitespace-nowrap" title={s.last_reading_at ? `Newest stored reading ${s.last_reading_at}` : undefined}>
                          {s.last_reading_at ? (
                            <>
                              {s.last_reading_at.slice(0, 10) === now.slice(0, 10) ? s.last_reading_at.slice(11, 16) : s.last_reading_at.slice(0, 16)}
                              <div className="text-[11px] text-slate-500">{fmtAge(minutesBetween(s.last_reading_at, now))}</div>
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
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Panel>
          <p className="text-[11px] text-slate-500">
            Readings are the newest stored record ("Last sync"), not live values. n/f = probe not fitted (read 0 all of the last 7 days).
            Coverage counts 5-min slots from 06:00 up to the last history sync{until ? ` (${until})` : ""}.
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

/** One sensor from the stored data. The live state and newest live reading come with the live sweep. */
const SensorInfo: React.FC<{
  sensor: SensorRow | null;
  sensors: SensorRow[];
  now: string;
  until: string | null;
  onPick: (key: string) => void;
}> = ({ sensor, sensors, now, until, onPick }) => {
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
  const st = STATUS_VIEW[sensor.status];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel icon={Info} title={`${sensor.datalogger_sn}#${sensor.address}`} subtitle={sensor.device_name ?? undefined} actions={picker}>
        <Row label="Status">
          <StatusBadge status={st.label} level={st.level} />
        </Row>
        <Row label="Plant">
          <Link to={`${plantPath(sensor.plant_id, "generation")}#weather-station`} className="hover:text-solar-300">
            {sensor.plant_name}
          </Link>
        </Row>
        <Row label="Phase (Growatt account)">{sensor.phase ?? "—"}</Row>
        <Row label="Datalogger SN">{sensor.datalogger_sn}</Row>
        <Row label="Bus address">{sensor.address}</Row>
        <Row label="Newest stored reading">
          {sensor.last_reading_at ? `${sensor.last_reading_at} · ${fmtAge(minutesBetween(sensor.last_reading_at, now))}` : "Nothing stored yet"}
        </Row>
        <Row label={`Coverage today (06:00–${until ?? "—"})`}>
          <span className={coverageTone(sensor.coverage_today_pct)}>
            {sensor.coverage_today_pct == null ? "—" : `${fmt(sensor.coverage_today_pct, 0)}%`}
          </span>
        </Row>
        <p className="mt-3 text-[11px] text-slate-500">Online state and the newest live reading come from Growatt's live sensor list, not checked yet.</p>
      </Panel>
      <Panel icon={Database} title="Newest stored reading" subtitle={sensor.last_reading_at ?? "Nothing stored yet"}>
        {FIELDS.map((f) => {
          const fitted = !sensor.measured || sensor.measured.includes(f);
          return (
            <Row key={f} label={FIELD_LABEL[f]}>
              {!fitted ? (
                <span className="text-slate-500">Not fitted</span>
              ) : (
                <>
                  {fmt(sensor.last?.[f], f === "irradiance_wm2" || f === "wind_dir_deg" || f === "humidity_pct" ? 0 : 1)}{" "}
                  <span className="text-xs text-slate-500">{FIELD_UNIT[f]}</span>
                </>
              )}
            </Row>
          );
        })}
        <p className="mt-3 text-[11px] text-slate-500">
          {sensor.measured
            ? "Not fitted = the probe read 0 in every stored record of the last 7 days."
            : "No stored reading in the last 7 days, so which probes are fitted is unknown."}
        </p>
      </Panel>
    </div>
  );
};

export default SensorsPage;
