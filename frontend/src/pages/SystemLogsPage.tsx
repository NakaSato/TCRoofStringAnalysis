import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Search,
  ServerCrash,
  X,
} from "lucide-react";
import { api } from "../api/client";
import type { SystemLogEntry, SystemLogLevel, SystemLogPage, SystemLogSource, SystemLogSummary } from "../api/client";
import { EmptyState, KpiTile, LoadingState, PageHeader, Panel, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { cn } from "@/lib/utils";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** New rows are polled this often while the newest page is shown and the tab is visible. */
const POLL_MS = 15_000;
const PAGE = 200;

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"] as const;
const SOURCES = ["all", "api", "worker", "cli"] as const;
const RANGES = { "1h": 1, "24h": 24, "7d": 24 * 7, "14d": 24 * 14 } as const;
type Range = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as Range[];
/** Worker jobs (`app.services.jobs.JOBS`). */
const JOBS = ["all", "history", "env_history", "backfill", "fleet", "alarms", "alarms_yesterday", "google_weather", "publish_today", "publish_yesterday", "pwa_sheet", "retention"] as const;

const LEVEL_VIEW: Record<SystemLogLevel, StatusLevel> = { DEBUG: "neutral", INFO: "info", WARNING: "warn", ERROR: "crit", CRITICAL: "crit" };

/** "2026-11-13T02:00:04Z" → Bangkok "2026-11-13" and "09:00:04". */
const bkk = (iso: string) => {
  const s = new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });
  return { day: s.slice(0, 10), time: s.slice(11, 19) };
};
const shortLogger = (name: string) => name.replace(/^app\.(services|api\.routes|api)\./, "");

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : "Copy"}
    </Button>
  );
};

/**
 * System → Logs (admin only): the API's and worker's log records from SQL (`/system/logs`),
 * redacted on the backend. Filters live in the URL; new rows are polled while the newest page
 * is shown. Nothing is kept in browser storage.
 */
export const SystemLogsPage: React.FC = () => {
  const [url, setUrl] = useUrlState();
  const level: SystemLogLevel = pick(url.get("level"), LEVELS, "INFO");
  const source = pick(url.get("source"), SOURCES, "all");
  const range: Range = pick(url.get("range"), RANGE_KEYS, "24h");
  const job = pick(url.get("job"), JOBS, "all");
  const runParam = url.get("run");
  const runId = runParam && /^\d+$/.test(runParam) ? Number(runParam) : null;
  const q = url.get("q") ?? "";

  // the search box updates the URL 300 ms after typing stops
  const [qInput, setQInput] = useState(q);
  useEffect(() => setQInput(q), [q]);
  useEffect(() => {
    if (qInput === q) return;
    const id = window.setTimeout(() => setUrl({ q: qInput.trim() || null }), 300);
    return () => window.clearTimeout(id);
  }, [qInput, q, setUrl]);

  const [items, setItems] = useState<SystemLogEntry[]>([]);
  const [meta, setMeta] = useState<SystemLogPage["meta"] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SystemLogSummary | null>(null);
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [polledAt, setPolledAt] = useState<Date | null>(null);

  const query = useMemo(
    () => ({
      level,
      source: source === "all" ? undefined : [source as SystemLogSource],
      job: job === "all" ? undefined : job,
      run_id: runId ?? undefined,
      q: q || undefined,
      // a job run is shown whole; otherwise the chosen window
      since: runId != null ? undefined : new Date(Date.now() - RANGES[range] * 3600_000).toISOString(),
    }),
    // `since` is fixed when the filters change; polling adds newer rows by id
    [level, source, job, runId, q, range]
  );

  // a response for an older filter set is dropped
  const seq = useRef(0);
  const load = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    Promise.all([api.listSystemLogs({ ...query, limit: PAGE }), api.getSystemLogSummary()])
      .then(([page, sum]) => {
        if (my !== seq.current) return;
        setItems(page.items);
        setMeta(page.meta);
        setNextBefore(page.next_before_id);
        setOlderLoaded(false);
        setSummary(sum);
        setError(null);
        setPolledAt(new Date());
      })
      .catch((err) => my === seq.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => my === seq.current && setLoading(false));
  }, [query]);

  useEffect(() => {
    setOpen(new Set());
    load();
  }, [load]);

  // poll for rows newer than the newest shown (only on the newest page, tab visible)
  const newestId = items[0]?.id ?? null;
  useEffect(() => {
    if (!auto || olderLoaded) return;
    const tick = () => {
      if (document.hidden) return;
      const my = seq.current;
      Promise.all([api.listSystemLogs({ ...query, after_id: newestId ?? 0, limit: PAGE }), api.getSystemLogSummary()])
        .then(([page, sum]) => {
          if (my !== seq.current) return;
          setSummary(sum);
          setPolledAt(new Date());
          if (!page.items.length) return;
          if (page.items.length >= PAGE) return load(); // more new rows than a page: start over
          setItems((prev) => [...page.items, ...prev]);
        })
        .catch(() => undefined); // the next tick retries; the header keeps the last poll time
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auto, olderLoaded, query, newestId, load]);

  const loadOlder = () => {
    if (nextBefore == null) return;
    const my = seq.current;
    setLoadingOlder(true);
    api
      .listSystemLogs({ ...query, before_id: nextBefore, limit: PAGE })
      .then((page) => {
        if (my !== seq.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setNextBefore(page.next_before_id);
        setOlderLoaded(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingOlder(false));
  };

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const errors = summary ? summary.by_level.ERROR + summary.by_level.CRITICAL : 0;
  const lastError = summary?.last_error ?? null;
  const anyFilter = level !== "INFO" || source !== "all" || range !== "24h" || job !== "all" || runId != null || q !== "";
  const chips = [
    ...(runId != null ? [{ label: `Run #${runId}`, clear: () => setUrl({ run: null }) }] : []),
    ...(q ? [{ label: `“${q}”`, clear: () => setUrl({ q: null }) }] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        icon={ScrollText}
        eyebrow="System"
        title="Logs"
        description="Log records of the API (Cloud Run) and the growatt-worker (VM), stored in the database with tokens, keys and passwords removed. Only problems are logged for API requests (5xx, slow requests, failed logins, admin actions)."
        actions={
          <>
            <Badge variant={auto && !olderLoaded ? "ok" : "neutral"} className="px-2 py-0.5 text-[11px] font-semibold">
              {auto && !olderLoaded ? "Auto-refresh 15 s" : "Paused"}
              {polledAt ? ` · ${polledAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => setAuto(!auto)} aria-pressed={auto}>
              {auto ? <Pause /> : <Play />} {auto ? "Pause" : "Resume"}
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
            </Button>
          </>
        }
      />

      {meta && !meta.enabled && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-200">
          Database logging is switched off (<span className="num">LOG_DB_ENABLED=false</span>): no new records are stored. Older ones are shown until retention removes them.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label="Errors · 24 h" value={fmtInt(errors)} icon={AlertOctagon} tone={errors ? "crit" : "ok"} hint="ERROR and CRITICAL" />
        <KpiTile label="Warnings · 24 h" value={fmtInt(summary?.by_level.WARNING ?? 0)} icon={AlertTriangle} tone={summary?.by_level.WARNING ? "warn" : "neutral"} hint="e.g. rate limits, partial runs" />
        <KpiTile
          label="Records · 24 h"
          value={fmtInt(summary?.total ?? 0)}
          icon={ScrollText}
          tone="info"
          hint={summary ? `API ${fmtInt(summary.by_source.api)} · worker ${fmtInt(summary.by_source.worker)} · CLI ${fmtInt(summary.by_source.cli)}` : undefined}
        />
        <KpiTile
          label="Last error"
          value={lastError ? bkk(lastError.ts).time.slice(0, 5) : "—"}
          icon={ServerCrash}
          tone={lastError ? "crit" : "neutral"}
          hint={
            lastError ? (
              <button type="button" className="truncate text-left hover:text-slate-300" title={lastError.message} onClick={() => setUrl({ level: "ERROR", run: null, q: null })}>
                {shortLogger(lastError.logger)}: {lastError.message.slice(0, 60)}
              </button>
            ) : (
              "None in 24 h"
            )
          }
        />
      </div>

      <Panel
        icon={ScrollText}
        title="Log records"
        subtitle={`${fmtInt(items.length)} shown · newest first · times in Bangkok${meta ? ` · kept ${meta.retention_days} days, stored from ${meta.level}` : ""}${error ? ` · failed: ${error}` : ""}`}
        bodyClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <Select value={level} onValueChange={(v) => setUrl({ level: v === "INFO" ? null : v })}>
            <SelectTrigger size="sm" className="w-32" aria-label="Minimum level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {l === "ERROR" ? "Errors" : l === "WARNING" ? "Warnings +" : l === "INFO" ? "Info +" : "Debug +"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={(v) => setUrl({ source: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-32" aria-label="Source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="api">API</SelectItem>
              <SelectItem value="worker">Worker</SelectItem>
              <SelectItem value="cli">CLI</SelectItem>
            </SelectContent>
          </Select>
          <Select value={job} onValueChange={(v) => setUrl({ job: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label="Job">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JOBS.map((j) => (
                <SelectItem key={j} value={j}>
                  {j === "all" ? "All jobs" : j}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={(v) => setUrl({ range: v === "24h" ? null : v })} disabled={runId != null}>
            <SelectTrigger size="sm" className="w-28" aria-label="Time range" title={runId != null ? "A job run is shown whole" : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_KEYS.map((r) => (
                <SelectItem key={r} value={r}>
                  Last {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InputGroup className="h-8 w-64">
            <InputGroupAddon>
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Text in message" aria-label="Search messages" maxLength={200} />
            {qInput && (
              <InputGroupAddon align="inline-end">
                <button type="button" onClick={() => setQInput("")} aria-label="Clear search">
                  <X className="size-3.5" />
                </button>
              </InputGroupAddon>
            )}
          </InputGroup>
          {chips.map((c) => (
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
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setUrl({ level: null, source: null, range: null, job: null, run: null, q: null })}>
              Clear all
            </Button>
          )}
        </div>

        {loading && !items.length ? (
          <LoadingState label="Loading log records…" />
        ) : error && !items.length ? (
          <EmptyState icon={ServerCrash} title="Logs unavailable" description={error} />
        ) : !items.length ? (
          <EmptyState
            icon={Check}
            title={anyFilter ? "No matching records" : "No records"}
            description={anyFilter ? "Change or clear the filters to see more." : `Nothing at ${level} or above in the last ${range}.`}
            className="py-10"
          />
        ) : (
          <>
            <Table containerClassName="table-wrap max-h-[720px] overflow-auto">
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Time</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Logger</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r, i) => {
                  const t = bkk(r.ts);
                  const newDay = i === 0 || bkk(items[i - 1].ts).day !== t.day;
                  const isOpen = open.has(r.id);
                  const full = [r.message, r.exc_text].filter(Boolean).join("\n\n");
                  return (
                    <React.Fragment key={r.id}>
                      <TableRow className={cn("cursor-pointer", r.level === "ERROR" || r.level === "CRITICAL" ? "bg-red-500/[0.04]" : "")} onClick={() => toggle(r.id)}>
                        <TableCell className="pr-0 text-slate-500">{isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</TableCell>
                        <TableCell className="num whitespace-nowrap text-slate-300" title={`${t.day} ${t.time} Bangkok · ${r.ts}`}>
                          {newDay && <span className="mr-1.5 text-slate-500">{t.day.slice(5)}</span>}
                          {t.time}
                        </TableCell>
                        <TableCell>
                          <Badge variant={LEVEL_VIEW[r.level]} className="px-1.5 py-0 text-[10px] font-semibold">
                            {r.level}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-slate-400">{r.source}</TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-slate-400" title={r.logger}>
                          {shortLogger(r.logger)}
                        </TableCell>
                        <TableCell className="max-w-[640px]">
                          <span className="block truncate text-slate-200" title={r.message}>
                            {r.message}
                          </span>
                          {r.exc_text && !isOpen && <span className="text-[11px] text-red-300/80">traceback · click to expand</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.run_id != null ? (
                            <button
                              type="button"
                              className="num rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-solar-400/40 hover:text-solar-200"
                              title="Show only this job run"
                              onClick={(e) => {
                                e.stopPropagation();
                                setUrl({ run: r.run_id, job: null, range: null });
                              }}
                            >
                              {r.job ?? "run"} #{r.run_id}
                            </button>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell />
                          <TableCell colSpan={6} className="pb-4">
                            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                              <span>Logger <span className="num text-slate-300">{r.logger}</span></span>
                              {r.host && <span>Host <span className="num text-slate-300">{r.host}</span></span>}
                              {r.request_id && <span>Request <span className="num text-slate-300">{r.request_id}</span></span>}
                              <span>Record <span className="num text-slate-300">#{r.id}</span></span>
                              <span className="ml-auto">
                                <CopyButton text={full} />
                              </span>
                            </div>
                            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-ink-950/80 p-3 font-mono text-[11px] leading-relaxed text-slate-200">
                              {full}
                              {r.extra ? `\n\n${JSON.stringify(r.extra, null, 2)}` : ""}
                            </pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2.5 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5">
                <Clock className="size-3" />
                {olderLoaded ? "Older rows loaded: auto-refresh paused (Refresh returns to the newest)" : "Newest first"}
              </span>
              {nextBefore != null ? (
                <Button variant="outline" size="xs" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? "Loading…" : "Load older"}
                </Button>
              ) : (
                <span>End of the {runId != null ? "run" : `last ${range}`}</span>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
};

export default SystemLogsPage;
