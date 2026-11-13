import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Clock,
  Copy,
  Search,
  ServerCrash,
  X,
} from "lucide-react";
import { api } from "../api/client";
import type { SystemLogEntry, SystemLogLevel, SystemLogPage, SystemLogSource, SystemLogSummary } from "../api/client";
import { EmptyState, LoadingState, PageHeader, Panel, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { cn } from "@/lib/utils";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

const SOURCE_VIEW: { key: SystemLogSource; label: string; bar: string; dot: string }[] = [
  { key: "api", label: "API", bar: "bg-sky-400/70", dot: "bg-sky-400" },
  { key: "worker", label: "Worker", bar: "bg-violet-400/70", dot: "bg-violet-400" },
  { key: "cli", label: "CLI", bar: "bg-slate-400/60", dot: "bg-slate-400" },
];

const LevelCount: React.FC<{ label: string; value: number | null; active: boolean; hot: string; onClick: () => void; hint: string }> = ({
  label,
  value,
  active,
  hot,
  onClick,
  hint,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={hint}
    className={cn(
      "group flex min-w-0 flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.04]",
      active && "bg-white/[0.05] ring-1 ring-white/10",
    )}
  >
    <span className="eyebrow">{label}</span>
    <span className={cn("num mt-0.5 text-2xl font-bold tracking-tight", value ? hot : "text-slate-500")}>{fmtInt(value)}</span>
    <span className="text-[11px] text-slate-500 group-hover:text-slate-400">{active ? "Filtered" : "Show only these"}</span>
  </button>
);

/** Last-24 h health: one strip with a verdict, clickable level counts, records by source and the
 *  newest error. Counts are "—" until the summary arrives (never a made-up 0). */
const LogHealthStrip: React.FC<{
  summary: SystemLogSummary | null;
  level: string;
  source: string;
  onLevel: (level: "ERROR" | "WARNING" | "INFO") => void;
  onSource: (source: SystemLogSource | "all") => void;
}> = ({ summary, level, source, onLevel, onSource }) => {
  const errors = summary ? summary.by_level.ERROR + summary.by_level.CRITICAL : null;
  const warnings = summary ? summary.by_level.WARNING : null;
  const total = summary?.total ?? null;
  const lastError = summary?.last_error ?? null;
  const tone: StatusLevel = summary == null ? "neutral" : errors ? "crit" : warnings ? "warn" : "ok";
  const verdict =
    summary == null
      ? "Loading…"
      : errors
        ? `${fmtInt(errors)} error${errors === 1 ? "" : "s"}`
        : warnings
          ? `${fmtInt(warnings)} warning${warnings === 1 ? "" : "s"}`
          : "All clear";
  const toneText = { ok: "text-emerald-300", warn: "text-amber-300", crit: "text-red-300", info: "text-sky-300", neutral: "text-slate-300" }[tone];
  const toneBar = { ok: "bg-emerald-400", warn: "bg-amber-400", crit: "bg-red-400", info: "bg-sky-400", neutral: "bg-slate-600" }[tone];

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="grid grid-cols-1 divide-y divide-white/[0.06] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] lg:divide-x lg:divide-y-0">
        {/* Verdict */}
        <div className="flex items-center gap-3 px-4 py-4">
          <span className={cn("h-10 w-1 shrink-0 rounded-full", toneBar)} aria-hidden />
          <div className="min-w-0">
            <div className="eyebrow">Last 24 h</div>
            <div className={cn("text-lg font-bold tracking-tight", toneText)}>{verdict}</div>
            <div className="text-[11px] text-slate-500">
              {summary == null
                ? "Reading the summary"
                : errors
                  ? "ERROR or CRITICAL records need a look"
                  : warnings
                    ? "No errors · e.g. rate limits, partial runs"
                    : "No errors or warnings"}
            </div>
          </div>
        </div>

        {/* Level counts */}
        <div className="grid grid-cols-2 gap-1 px-2 py-2">
          <LevelCount
            label="Errors"
            value={errors}
            hot="text-red-300"
            active={level === "ERROR"}
            hint="ERROR and CRITICAL"
            onClick={() => onLevel(level === "ERROR" ? "INFO" : "ERROR")}
          />
          <LevelCount
            label="Warnings"
            value={warnings}
            hot="text-amber-300"
            active={level === "WARNING"}
            hint="WARNING and above"
            onClick={() => onLevel(level === "WARNING" ? "INFO" : "WARNING")}
          />
        </div>

        {/* Records by source */}
        <div className="flex flex-col justify-center gap-2 px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="eyebrow">Records</span>
            <span className="num text-sm font-semibold text-white">{fmtInt(total)}</span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/[0.05]" aria-hidden>
            {summary && total
              ? SOURCE_VIEW.map((s) =>
                  summary.by_source[s.key] ? (
                    <div key={s.key} className={cn("h-full", s.bar)} style={{ width: `${(summary.by_source[s.key] / total) * 100}%` }} />
                  ) : null,
                )
              : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {SOURCE_VIEW.map((s) => {
              const active = source === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSource(active ? "all" : s.key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-slate-200",
                    active && "bg-white/[0.06] text-slate-100 ring-1 ring-white/10",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                  {s.label}
                  <span className="num font-semibold text-slate-200">{fmtInt(summary ? summary.by_source[s.key] : null)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Newest error */}
      <div
        className={cn(
          "flex items-center gap-2 border-t px-4 py-2 text-[11px]",
          lastError ? "border-red-400/15 bg-red-400/[0.05]" : "border-white/[0.06]",
        )}
      >
        <span className="eyebrow shrink-0">Last error</span>
        {lastError ? (
          <button
            type="button"
            className="flex min-w-0 items-baseline gap-2 text-left text-slate-300 hover:text-white"
            title={lastError.message}
            onClick={() => onLevel("ERROR")}
          >
            <span className="num shrink-0 text-red-300">{bkk(lastError.ts).time.slice(0, 5)}</span>
            <span className="shrink-0 font-medium text-slate-400">{shortLogger(lastError.logger)}</span>
            <span className="truncate">{lastError.message}</span>
          </button>
        ) : (
          <span className="text-slate-500">{summary == null ? "—" : "None in 24 h"}</span>
        )}
      </div>
    </Card>
  );
};

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

const LEVEL_EDGE: Record<SystemLogLevel, string> = {
  DEBUG: "bg-slate-600",
  INFO: "bg-sky-400/60",
  WARNING: "bg-amber-400",
  ERROR: "bg-red-400",
  CRITICAL: "bg-red-500",
};
const LEVEL_ROW: Partial<Record<SystemLogLevel, string>> = {
  WARNING: "bg-amber-400/[0.025]",
  ERROR: "bg-red-500/[0.05]",
  CRITICAL: "bg-red-500/[0.08]",
};

/** "Today" / "Yesterday" / "Thu 13 Nov" for a Bangkok day key. */
const dayLabel = (day: string) => {
  const today = bkk(new Date().toISOString()).day;
  const yesterday = bkk(new Date(Date.now() - 86_400_000).toISOString()).day;
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Date(`${day}T12:00:00+07:00`).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short" });
};

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
  return `${Math.floor(s / 86_400)} d ago`;
};

const DetailBlock: React.FC<{ label: string; tone?: "crit"; children: React.ReactNode }> = ({ label, tone, children }) => (
  <div>
    <div className={cn("eyebrow mb-1", tone === "crit" && "text-red-300/80")}>{label}</div>
    <pre
      className={cn(
        "max-h-[360px] overflow-auto rounded-lg border bg-ink-950/80 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-slate-200",
        tone === "crit" ? "border-red-400/20" : "border-white/[0.06]",
      )}
    >
      {children}
    </pre>
  </div>
);

/** The log list: grouped by Bangkok day, a level edge per row, logger above the message, and a
 *  keyboard-accessible expander with message, traceback and extra fields. */
const LogTable: React.FC<{
  items: SystemLogEntry[];
  open: Set<number>;
  onToggle: (id: number) => void;
  onRun: (r: SystemLogEntry) => void;
  onSource: (source: SystemLogSource) => void;
}> = ({ items, open, onToggle, onRun, onSource }) => (
  <Table containerClassName="table-wrap max-h-[720px] overflow-auto" className="min-w-[760px] table-fixed">
    <colgroup>
      <col className="w-9" />
      <col className="w-[92px]" />
      <col className="w-[96px]" />
      <col className="w-[92px]" />
      <col />
      <col className="w-[170px]" />
    </colgroup>
    <TableHeader className="sticky top-0 z-20 shadow-[0_1px_0_rgba(255,255,255,0.06)]">
      <TableRow>
        <TableHead className="pr-0">
          <span className="sr-only">Expand</span>
        </TableHead>
        <TableHead>Time</TableHead>
        <TableHead>Level</TableHead>
        <TableHead>Source</TableHead>
        <TableHead>Logger · message</TableHead>
        <TableHead className="text-right">Job run</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {items.map((r, i) => {
        const t = bkk(r.ts);
        const newDay = i === 0 || bkk(items[i - 1].ts).day !== t.day;
        const isOpen = open.has(r.id);
        const detailId = `log-${r.id}-detail`;
        return (
          <React.Fragment key={r.id}>
            {newDay && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="bg-ink-900/70 py-1.5">
                  <span className="text-[11px] font-semibold text-slate-300">{dayLabel(t.day)}</span>
                  <span className="num ml-2 text-[11px] text-slate-500">{t.day}</span>
                </TableCell>
              </TableRow>
            )}
            <TableRow
              tabIndex={0}
              aria-expanded={isOpen}
              aria-controls={isOpen ? detailId : undefined}
              className={cn(
                "group cursor-pointer outline-none focus-visible:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-solar-400/40",
                LEVEL_ROW[r.level],
                isOpen && "bg-white/[0.035]",
              )}
              onClick={() => onToggle(r.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(r.id);
                }
              }}
            >
              <TableCell className="relative pr-0 text-slate-500">
                <span className={cn("absolute inset-y-0 left-0 w-[3px]", LEVEL_EDGE[r.level])} aria-hidden />
                <ChevronRight className={cn("size-3.5 transition-transform group-hover:text-slate-300", isOpen && "rotate-90 text-slate-300")} />
              </TableCell>
              <TableCell className="num whitespace-nowrap text-slate-300">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">{t.time}</span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t.day} {t.time} Bangkok · {ago(r.ts)}
                  </TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Badge variant={LEVEL_VIEW[r.level]} className="px-1.5 py-0 text-[10px] font-semibold tracking-wide">
                  {r.level === "CRITICAL" ? "CRIT" : r.level === "WARNING" ? "WARN" : r.level}
                </Badge>
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  title={`Show only ${r.source}${r.host ? ` · host ${r.host}` : ""}`}
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSource(r.source);
                  }}
                >
                  {r.source === "api" ? "API" : r.source === "cli" ? "CLI" : "Worker"}
                </button>
              </TableCell>
              <TableCell className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500">
                  <span className="truncate font-mono" title={r.logger}>
                    {shortLogger(r.logger)}
                  </span>
                  {r.exc_text && (
                    <span className="shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-medium text-red-300 ring-1 ring-red-400/20">
                      traceback
                    </span>
                  )}
                  {r.request_id && (
                    <span className="num hidden shrink-0 text-slate-600 xl:inline" title="Request id">
                      req {r.request_id.slice(0, 8)}
                    </span>
                  )}
                </div>
                <div className={cn("mt-0.5 text-slate-200", isOpen ? "break-words whitespace-pre-wrap" : "truncate")}>{r.message}</div>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {r.run_id != null ? (
                  <button
                    type="button"
                    className="num inline-flex max-w-full items-center gap-1 truncate rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-slate-300 transition-colors hover:border-solar-400/40 hover:bg-solar-500/10 hover:text-solar-200"
                    title="Show only this job run"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRun(r);
                    }}
                  >
                    <span className="truncate">{r.job ?? "run"}</span>
                    <span className="text-slate-500">#{r.run_id}</span>
                  </button>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </TableCell>
            </TableRow>
            {isOpen && (
              <TableRow id={detailId} className="bg-ink-900/40 hover:bg-ink-900/40">
                <TableCell className="relative p-0">
                  <span className={cn("absolute inset-y-0 left-0 w-[3px] opacity-50", LEVEL_EDGE[r.level])} aria-hidden />
                </TableCell>
                <TableCell colSpan={5} className="pt-1 pb-4">
                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {[
                      ["Record", `#${r.id}`],
                      ["Logger", r.logger],
                      ["Host", r.host],
                      ["Request", r.request_id],
                      ["UTC", r.ts],
                    ]
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <span key={k} className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5">
                          <span className="text-slate-500">{k}</span>
                          <span className="num text-slate-200">{v}</span>
                        </span>
                      ))}
                    <span className="ml-auto">
                      <CopyButton text={[r.message, r.exc_text, r.extra ? JSON.stringify(r.extra, null, 2) : null].filter(Boolean).join("\n\n")} />
                    </span>
                  </div>
                  <div className="space-y-3">
                    <DetailBlock label="Message">{r.message}</DetailBlock>
                    {r.exc_text && (
                      <DetailBlock label="Traceback" tone="crit">
                        {r.exc_text}
                      </DetailBlock>
                    )}
                    {r.extra && <DetailBlock label="Extra">{JSON.stringify(r.extra, null, 2)}</DetailBlock>}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </React.Fragment>
        );
      })}
    </TableBody>
  </Table>
);

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
    ...(runId != null ? [{ label: `Run #${runId}`, clear: () => setUrl({ run: null }) }] : []),
    ...(q ? [{ label: `“${q}”`, clear: () => setUrl({ q: null }) }] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System"
        title="Logs"
      />

      {meta && !meta.enabled && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-200">
          Database logging is switched off (<span className="num">LOG_DB_ENABLED=false</span>): no new records are stored. Older ones are shown until retention removes them.
        </div>
      )}

      <LogHealthStrip
        summary={summary}
        level={level}
        source={source}
        onLevel={(l) => setUrl({ level: l === "INFO" ? null : l, run: null, q: null })}
        onSource={(src) => setUrl({ source: src === "all" ? null : src })}
      />

      <Panel
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
            <LogTable
              items={items}
              open={open}
              onToggle={toggle}
              onRun={(r) => setUrl({ run: r.run_id, job: null, range: null })}
              onSource={(src) => setUrl({ source: src })}
            />
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2.5 text-[11px] text-slate-500">
              <span className="flex items-center gap-2">
                <Clock className="size-3" />
                {olderLoaded ? "Older rows loaded: new records are not added" : "Newest first · new records appear every 15 s"}
                {olderLoaded && (
                  <Button variant="ghost" size="xs" onClick={load} disabled={loading}>
                    Back to newest
                  </Button>
                )}
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
