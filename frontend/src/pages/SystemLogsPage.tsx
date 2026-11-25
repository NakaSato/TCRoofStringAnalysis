import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, RefreshCw, Search, X } from "lucide-react";
import { api } from "../api/client";
import type { SystemLogEntry, SystemLogLevel, SystemLogPage, SystemLogSource, SystemLogSummary } from "../api/client";
import { LoadingState, Suspended, fmtInt } from "../components/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { LogHealthStrip } from "./systemLogs/LogHealthStrip";
import { LogTable } from "./systemLogs/LogTable";
import { useI18n } from "../i18n";

/** New rows are polled this often while the newest page is shown and the tab is visible. */
const POLL_MS = 15_000;
const PAGE = 200;

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"] as const;
const SOURCES = ["all", "api", "worker", "cli"] as const;
const RANGES = { "1h": 1, "24h": 24, "7d": 24 * 7, "14d": 24 * 14 } as const;
type Range = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as Range[];
/** Worker jobs (`app.services.jobs.JOBS`). */
const JOBS = ["all", "history", "env_history", "inverter_latest", "backfill", "fleet", "alarms", "alarms_yesterday", "google_weather", "publish_today", "publish_yesterday", "pwa_sheet", "retention", "om_plans"] as const;

/**
 * System → Logs (admin only): the API's and worker's log records from SQL (`/system/logs`),
 * redacted on the backend. Filters live in the URL; new rows are polled while the newest page
 * is shown. Nothing is kept in browser storage.
 */
export const SystemLogsPage: React.FC = () => {
  const [url, setUrl] = useUrlState();
  const { t } = useI18n();
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
  const [open, setOpen] = useState<Set<number>>(new Set());

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
    if (olderLoaded) return;
    const tick = () => {
      if (document.hidden) return;
      const my = seq.current;
      Promise.all([api.listSystemLogs({ ...query, after_id: newestId ?? 0, limit: PAGE }), api.getSystemLogSummary()])
        .then(([page, sum]) => {
          if (my !== seq.current) return;
          setSummary(sum);
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
  }, [olderLoaded, query, newestId, load]);

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

  const anyFilter = level !== "INFO" || source !== "all" || range !== "24h" || job !== "all" || runId != null || q !== "";
  const chips = [
    ...(runId != null ? [{ label: t("Run #{id}", { id: runId }), clear: () => setUrl({ run: null }) }] : []),
    ...(q ? [{ label: `“${q}”`, clear: () => setUrl({ q: null }) }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Logs")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("API and worker records, newest first, times in Bangkok")}
            {meta ? t(" · kept {days} days, stored from {level}", { days: meta.retention_days, level: meta.level }) : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
          {t("Refresh")}
        </Button>
      </div>

      {meta && !meta.enabled && (
        <Alert variant="warn">
          <AlertDescription>
            {t("Database logging is switched off ({setting}): no new records are stored. Older ones are shown until retention removes them.", { setting: "LOG_DB_ENABLED=false" })}
          </AlertDescription>
        </Alert>
      )}

      <LogHealthStrip
        summary={summary}
        level={level}
        source={source}
        onLevel={(l) => setUrl({ level: l === "INFO" ? null : l, run: null, q: null })}
        onSource={(src) => setUrl({ source: src === "all" ? null : src })}
      />

      <Card className="gap-0 py-0">
        <CardHeader className="border-b border-white/[0.06] px-4 py-3">
          <CardTitle>{t("Log records")}</CardTitle>
          <CardDescription>{t("{n} shown · newest first · times in Bangkok", { n: fmtInt(items.length) })}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
        {error && items.length > 0 && (
          <Alert variant="destructive" className="mx-4 mt-3 w-auto">
            <AlertDescription>{t("Refresh failed: {error}", { error })}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <Select value={level} onValueChange={(v) => setUrl({ level: v === "INFO" ? null : v })}>
            <SelectTrigger size="sm" className="w-32" aria-label={t("Minimum level")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {l === "ERROR" ? t("Errors") : l === "WARNING" ? t("Warnings +") : l === "INFO" ? t("Info +") : t("Debug +")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={(v) => setUrl({ source: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-32" aria-label={t("Source")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All sources")}</SelectItem>
              <SelectItem value="api">API</SelectItem>
              <SelectItem value="worker">Worker</SelectItem>
              <SelectItem value="cli">CLI</SelectItem>
            </SelectContent>
          </Select>
          <Select value={job} onValueChange={(v) => setUrl({ job: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("Job")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JOBS.map((j) => (
                <SelectItem key={j} value={j}>
                  {j === "all" ? t("All jobs") : j}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={(v) => setUrl({ range: v === "24h" ? null : v })} disabled={runId != null}>
            <SelectTrigger size="sm" className="w-28" aria-label={t("Time range")} title={runId != null ? t("A job run is shown whole") : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_KEYS.map((r) => (
                <SelectItem key={r} value={r}>
                  {t("Last {range}", { range: r })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InputGroup className="h-8 w-64">
            <InputGroupAddon>
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t("Text in message")} aria-label={t("Search messages")} maxLength={200} />
            {qInput && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" onClick={() => setQInput("")} aria-label={t("Clear search")}>
                  <X className="size-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          {chips.map((c) => (
            <Button
              key={c.label}
              type="button"
              variant="outline"
              size="xs"
              onClick={c.clear}
              className="h-auto gap-1 rounded-full border-solar-400/30 bg-solar-500/10 px-2 py-0.5 text-[11px] font-normal text-solar-200 hover:border-solar-400/30 hover:bg-solar-500/20"
              title={t("Remove this filter")}
            >
              {c.label}
              <X className="size-3" />
            </Button>
          ))}
          {anyFilter && (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setUrl({ level: null, source: null, range: null, job: null, run: null, q: null })}>
              {t("Clear all")}
            </Button>
          )}
        </div>

        {loading && !items.length ? (
          <LoadingState label={t("Loading log records…")} shape="table" />
        ) : error && !items.length ? (
          <Alert variant="destructive" className="m-4 w-auto">
            <AlertTitle>{t("Logs unavailable")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !items.length ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>{anyFilter ? t("No matching records") : t("No records")}</EmptyTitle>
              <EmptyDescription>
                {anyFilter ? t("Change or clear the filters to see more.") : t("Nothing at {level} or above in the last {range}.", { level, range })}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Suspended busy={loading} label={t("Loading log records…")}>
            <LogTable
              items={items}
              open={open}
              onToggle={toggle}
              onRun={(r) => setUrl({ run: r.run_id, job: null, range: null })}
              onSource={(src) => setUrl({ source: src })}
            />
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-2">
                <Clock className="size-3" />
                {olderLoaded ? t("Older rows loaded: new records are not added") : t("Newest first · new records appear every 15 s")}
                {olderLoaded && (
                  <Button variant="ghost" size="xs" onClick={load} disabled={loading}>
                    {t("Back to newest")}
                  </Button>
                )}
              </span>
              {nextBefore != null ? (
                <Button variant="outline" size="xs" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder && <Spinner data-icon="inline-start" className="size-3" />}
                  {loadingOlder ? t("Loading…") : t("Load older")}
                </Button>
              ) : (
                <span>{runId != null ? t("End of the run") : t("End of the last {range}", { range })}</span>
              )}
            </div>
          </Suspended>
        )}
        </CardContent>
      </Card>
    </div>
  );
};

export default SystemLogsPage;
