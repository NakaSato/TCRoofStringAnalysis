import React, { useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import type { SystemLogEntry, SystemLogLevel, SystemLogSource } from "../../api/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LEVEL_VIEW, bkk, shortLogger } from "./shared";

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
export const LogTable: React.FC<{
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
