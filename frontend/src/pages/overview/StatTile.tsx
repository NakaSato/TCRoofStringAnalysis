/** Plant Overview KPI strip tile: label + tag (day / Live), big value, a thin meter, footer lines.
 * Every tile has the same rows, so values, meters and footers line up across the strip. */
import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Skeleton } from "@/components/ui/skeleton";

export type MeterSegment = { pct: number; className: string; title?: string };

/** Thin bar: stacked segments (0–100 each), optional tick (e.g. a target). Empty track when none. */
export const Meter: React.FC<{ segments?: MeterSegment[]; mark?: number | null; title?: string }> = ({ segments = [], mark, title }) => {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return (
    <div className="relative h-1 rounded-full bg-white/[0.06]" title={title} role={title ? "img" : undefined} aria-label={title}>
      <div className="flex h-full gap-px overflow-hidden rounded-full">
        {segments.map((s, i) => (
          <div key={i} className={s.className} style={{ width: `${clamp(s.pct)}%` }} title={s.title} />
        ))}
      </div>
      {mark != null && <div className="absolute -top-0.5 h-2 w-0.5 rounded-full bg-slate-200" style={{ left: `calc(${clamp(mark)}% - 1px)` }} />}
    </div>
  );
};

export const StatTile: React.FC<{
  label: string;
  /** short context on the right of the label: "Live 19:31", "11 Nov" */
  tag?: string;
  /** amber tag: the figure is of an older day than today */
  tagWarn?: boolean;
  /** formatted value; or pass `num` instead for a live reading that eases between polls */
  value?: string;
  num?: number | null;
  /** decimals of `num` */
  digits?: number;
  /** `num` counts up from 0 when it first arrives */
  countUp?: boolean;
  /** still loading: skeletons in place of the value and footer (same height, so nothing jumps) */
  loading?: boolean;
  unit?: string;
  /** text colour of the value */
  tone?: string;
  /** the thin bar under the value; omitted = an empty row, so footers still line up */
  meter?: React.ReactNode;
  footer?: React.ReactNode;
  /** whole tile links here */
  href?: string;
  linkLabel?: string;
}> = ({ label, tag, tagWarn, value, num, digits = 1, countUp, loading, unit, tone, meter, footer, href, linkLabel }) => {
  const empty = num !== undefined ? num == null || !Number.isFinite(num) : (value ?? "—") === "—";
  const body = (
    <Card className="h-full gap-0 px-3.5 py-3 transition-colors group-hover:border-white/[0.14]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-0.5 truncate text-xs font-medium text-slate-400">
          {label}
          {href && <ChevronRight className="size-3.5 shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-slate-300" aria-hidden />}
        </span>
        {tag && (
          <span
            className={cn(
              "num shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
              tagWarn ? "bg-amber-400/10 text-amber-300" : "bg-white/[0.05] text-slate-400"
            )}
          >
            {tag}
          </span>
        )}
      </div>
      {loading ? (
        <div className="mt-1.5 flex h-8 items-center" aria-busy>
          <Skeleton className="h-5 w-14" />
        </div>
      ) : (
      <div className="num mt-1.5 truncate leading-none animate-in fade-in-0">
        <span className={cn("text-2xl font-semibold tracking-tight", empty ? "text-slate-500" : (tone ?? "text-foreground"))}>
          {num !== undefined ? <AnimatedNumber value={num} digits={digits} countUp={countUp} flash={!countUp} /> : (value ?? "—")}
        </span>
        {!empty && unit && <span className="ml-1 text-xs text-muted-foreground">{unit}</span>}
      </div>
      )}
      <div className="mt-2 h-2">{meter}</div>
      {loading ? (
        // two lines: footers often wrap (Thai), so the tile is as tall as when it loads
        <div className="mt-1 flex h-[2.4rem] flex-col justify-center gap-1.5">
          <Skeleton className="h-2.5 w-2/3" />
          <Skeleton className="h-2.5 w-1/3" />
        </div>
      ) : footer && <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">{footer}</div>}
    </Card>
  );
  return href ? (
    <Link to={href} aria-label={linkLabel} title={linkLabel} className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
};
