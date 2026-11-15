/** Weather Sensors list (fleet `/sensors` and the plant Sensors tab): tiles, filters, table, and the Status / Info views. */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, CircleCheck, CircleHelp, Clock, CloudOff, Gauge, Info, ListChecks, RefreshCw, Search, TriangleAlert, WifiOff, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../api/client";
import type { GrowattLive, GrowattWeatherField, SensorList, SensorLiveStatus, SensorRow, SensorStatus } from "../../api/client";
import { useLivePoll } from "../../context/useLivePoll";
import { plantPath } from "../../context/routes";
import { EmptyState, LoadingState, PageHeader, Panel, StatusBadge, fmt, fmtInt } from "../../components/ui";
import { FlagChips, STATUS_VIEW, overlay } from "../../components/sensorView";
import type { ViewRow } from "../../components/sensorView";
import { cn } from "@/lib/utils";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { LOW_COVERAGE_PCT, hhmm, plantNow, minutesBetween, fmtAge, coverageTone } from "./format";
import { SensorInfo } from "./SensorInfo";
import { PlantSensorView } from "./PlantSensorView";

/** DB list re-read while the page is visible: the worker stores new readings every 10 min. */
const REFRESH_MS = 5 * 60_000;

const TABS = ["status", "info"] as const;

type Tab = (typeof TABS)[number];

const FILTERS = ["all", "online", "late", "offline", "unknown", "not_synced", "low", "flags"] as const;

type Filter = (typeof FILTERS)[number];

const SORTS = ["plant", "sensor", "last", "coverage", "irradiance"] as const;

type SortKey = (typeof SORTS)[number];

/** A stored value: "—" when null, "Not fitted" when the probe never reports. */
const reading = (s: SensorRow, f: GrowattWeatherField, digits = 1) =>
  s.measured && !s.measured.includes(f) ? <span className="text-slate-600">n/f</span> : fmt(s.last?.[f], digits);

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

/** `plantId` set = one plant's sensors (no plant column / phase filter), else every visible sensor. */
export const SensorsView: React.FC<{ plantId?: number }> = ({ plantId }) => {
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
    <div className="flex flex-col gap-5">
      {!one && (
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
              {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
              Refresh
            </Button>
          </>
        }
      />
      )}

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
        <LoadingState label="Loading weather sensors…" shape="table" />
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
          onRefresh={load}
          refreshing={loading}
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
                            to={`${plantPath(s.plant_id, "sensors")}#weather-station`}
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
