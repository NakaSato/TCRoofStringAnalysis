/**
 * Shared UI kit for the GenZ Monitoring System (dark control-room theme).
 * Built on the shadcn/ui primitives in `components/ui/*` (Card, Badge, Button, Input, Select,
 * Tabs, Table, Dialog, Tooltip), themed to the control-room palette in `index.css`.
 */
import React from "react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";

type Tone = "solar" | "energy" | "ok" | "warn" | "crit" | "info" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  solar: "text-solar-400",
  energy: "text-energy-400",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  crit: "text-red-400",
  info: "text-sky-400",
  neutral: "text-slate-300",
};

const TONE_ICON_BG: Record<Tone, string> = {
  solar: "bg-solar-500/10 text-solar-400 ring-solar-400/20",
  energy: "bg-energy-500/10 text-energy-400 ring-energy-400/20",
  ok: "bg-emerald-500/10 text-emerald-400 ring-emerald-400/20",
  warn: "bg-amber-500/10 text-amber-400 ring-amber-400/20",
  crit: "bg-red-500/10 text-red-400 ring-red-400/20",
  info: "bg-sky-500/10 text-sky-400 ring-sky-400/20",
  neutral: "bg-white/5 text-slate-300 ring-white/10",
};

const TONE_BAR: Record<Tone, string> = {
  solar: "bg-solar-400/60",
  energy: "bg-energy-400/60",
  ok: "bg-emerald-400/60",
  warn: "bg-amber-400/60",
  crit: "bg-red-400/60",
  info: "bg-sky-400/60",
  neutral: "bg-slate-400/30",
};

/* -------------------------------------------------------------------------- */
/* Page header                                                                */
/* -------------------------------------------------------------------------- */
export const PageHeader: React.FC<{
  icon?: LucideIcon;
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ icon: Icon, eyebrow, title, description, actions }) => (
  <div className="flex flex-wrap items-end justify-between gap-4">
    <div className="flex items-start gap-3 min-w-0">
      {Icon && (
        <div className="mt-0.5 rounded-xl bg-solar-500/10 p-2.5 text-solar-400 ring-1 ring-solar-400/20">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="text-xl font-bold tracking-tight text-white">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-xs text-slate-400">{description}</p>}
      </div>
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */
export const Panel: React.FC<{
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}> = ({ title, subtitle, icon: Icon, actions, className = "", bodyClassName = "panel-pad", children }) => (
  <Card className={cn("gap-0 py-0", className)}>
    {(title || actions) && (
      <CardHeader className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          {title && (
            <CardTitle>
              {Icon && <Icon className="h-4 w-4 text-solar-400" />}
              <span className="truncate">{title}</span>
            </CardTitle>
          )}
          {subtitle && <CardDescription className="mt-0.5">{subtitle}</CardDescription>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </CardHeader>
    )}
    <div className={bodyClassName}>{children}</div>
  </Card>
);

/* -------------------------------------------------------------------------- */
/* KPI tile                                                                   */
/* -------------------------------------------------------------------------- */
export const KpiTile: React.FC<{
  label: string;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  hintTone?: Tone;
  icon?: LucideIcon;
  tone?: Tone;
  /** coloured hairline along the top edge (default on) */
  accentBar?: boolean;
  /** smaller padding and value text (dense KPI strips) */
  compact?: boolean;
  className?: string;
}> = ({ label, value, unit, hint, hintTone = "neutral", icon: Icon, tone = "neutral", accentBar = true, compact = false, className = "" }) => (
  <Card className={cn("gap-0 overflow-hidden", compact ? "p-3" : "p-4", className)}>
    {accentBar && <div className={`absolute inset-x-0 top-0 h-px ${TONE_BAR[tone]}`} />}
    <div className="flex items-start justify-between gap-2">
      <div className="eyebrow">{label}</div>
      {Icon && (
        <div className={`rounded-lg ring-1 ${compact ? "p-1" : "p-1.5"} ${TONE_ICON_BG[tone]}`}>
          <Icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
        </div>
      )}
    </div>
    <div className={`${compact ? "mt-1" : "mt-2"} flex items-baseline gap-1.5`}>
      <span className={`num ${compact ? "text-lg" : "text-2xl"} font-bold tracking-tight ${tone === "neutral" ? "text-white" : TONE_TEXT[tone]}`}>
        {value}
      </span>
      {unit && <span className="text-xs font-medium text-slate-500">{unit}</span>}
    </div>
    {hint && <div className={`${compact ? "mt-1" : "mt-1.5"} text-[11px] font-medium ${hintTone === "neutral" ? "text-slate-500" : TONE_TEXT[hintTone]}`}>{hint}</div>}
  </Card>
);

/* -------------------------------------------------------------------------- */
/* Status helpers                                                             */
/* -------------------------------------------------------------------------- */
export type StatusLevel = "ok" | "warn" | "crit" | "info" | "neutral";

/** Map arbitrary backend status strings to a visual severity level. */
export function statusLevel(raw: unknown): StatusLevel {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return "neutral";
  if (/(critical|fail|non-?compliant|overdue|open circuit|danger|reject|poor|stop|❌)/.test(s)) return "crit";
  if (/(warn|monitor|high|medium|pending|due|in progress|progress|open|review|conditional|fair|⚠)/.test(s)) return "warn";
  if (/(healthy|pass|compliant|ok|complete|closed|done|good|excellent|approved|active|valid|yes|✅|low)/.test(s)) return "ok";
  return "info";
}

/** Label for a realtime status not received yet (first poll running, or live unavailable and
 *  still retrying every 60 s). There is no "Unknown" status: it always shows as loading. */
export const LOADING_STATUS = "Loading…" as const;

export const StatusBadge: React.FC<{
  status: unknown;
  level?: StatusLevel;
  className?: string;
  dot?: boolean;
  /** live request in flight: neutral badge with a pulsing dot */
  loading?: boolean;
}> = ({ status, level, className = "", dot = true, loading = false }) => {
  const lvl = loading ? "neutral" : level ?? statusLevel(status);
  const { t } = useI18n();
  return (
    <Badge variant={lvl} className={className} aria-busy={loading || undefined}>
      {loading && (
        <Spinner data-icon="inline-start" className="size-3" aria-hidden />
      )}
      {dot && !loading && <span className={`h-1.5 w-1.5 rounded-full ${lvl === "ok" ? "bg-emerald-400" : lvl === "warn" ? "bg-amber-400" : lvl === "crit" ? "bg-red-400" : lvl === "info" ? "bg-sky-400" : "bg-slate-500"}`} />}
      {t(String(status ?? "—"))}
    </Badge>
  );
};

export const Led: React.FC<{ level: StatusLevel | "off"; pulse?: boolean; className?: string }> = ({
  level,
  pulse = false,
  className = "",
}) => {
  const cls = level === "ok" ? "led-ok" : level === "warn" ? "led-warn" : level === "crit" ? "led-crit" : "led-off";
  return <span className={`led ${cls} ${pulse ? "animate-pulse-glow" : ""} ${className}`} />;
};

/* -------------------------------------------------------------------------- */
/* Progress / meter                                                           */
/* -------------------------------------------------------------------------- */
export const Meter: React.FC<{ value: number; max?: number; tone?: Tone; className?: string }> = ({
  value,
  max = 100,
  tone = "solar",
  className = "",
}) => {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const bar =
    tone === "ok"
      ? "bg-emerald-400"
      : tone === "warn"
      ? "bg-amber-400"
      : tone === "crit"
      ? "bg-red-400"
      : tone === "energy"
      ? "bg-energy-400"
      : tone === "info"
      ? "bg-sky-400"
      : "bg-solar-400";
  return <Progress value={pct} className={className} indicatorClassName={bar} />;
};

/* -------------------------------------------------------------------------- */
/* Empty / loading state                                                      */
/* -------------------------------------------------------------------------- */
export const EmptyState: React.FC<{ icon?: LucideIcon; title: string; description?: React.ReactNode; className?: string }> = ({
  icon: Icon,
  title,
  description,
  className = "",
}) => (
  <div className={`flex flex-col items-center justify-center gap-2 py-12 text-center ${className}`}>
    {Icon && (
      <div className="rounded-full bg-white/5 p-3 text-slate-500 ring-1 ring-white/10">
        <Icon className="h-5 w-5" />
      </div>
    )}
    <div className="text-sm font-medium text-slate-300">{title}</div>
    {description && <div className="max-w-sm text-xs text-slate-500">{description}</div>}
  </div>
);

/** Placeholder rows for a table or list while it loads. */
export const SkeletonRows: React.FC<{ rows?: number; className?: string }> = ({ rows = 6, className }) => (
  <div className={cn("flex flex-col gap-2", className)} aria-hidden>
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className="h-7 w-full" />
    ))}
  </div>
);

/** Placeholder for a row of KPI tiles. */
export const SkeletonKpis: React.FC<{ count?: number; className?: string }> = ({ count = 4, className }) => (
  <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-4", className)} aria-hidden>
    {Array.from({ length: count }, (_, i) => (
      <div key={i} className="flex flex-col gap-2 rounded-xl border border-white/[0.07] p-4">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-2.5 w-2/3" />
      </div>
    ))}
  </div>
);

/** Bar heights (% of the plot) of the chart placeholder: a day-shaped bell, like a PV curve. */
const SKELETON_BARS = Array.from({ length: 24 }, (_, i) => Math.round(16 + 74 * Math.sin((Math.PI * (i + 0.5)) / 24) ** 1.6));

/**
 * Placeholder for a chart area (fixed height, so the layout doesn't jump when it arrives): axis
 * stubs, gridlines and bars that rise and fall from the baseline (`.chart-skel-*` in index.css,
 * still under reduced motion), with a "Loading chart…" chip in the middle. `label={false}` drops
 * the chip (e.g. inside `LoadingState`, which already says what is loading).
 */
export const SkeletonChart: React.FC<{ height?: number | string; label?: React.ReactNode | false; className?: string }> = ({
  height = 220,
  label,
  className,
}) => {
  const { t } = useI18n();
  const text = label === false ? null : (label ?? t("Loading chart…"));
  return (
    <div className={cn("relative w-full overflow-hidden rounded-md bg-white/[0.02]", className)} style={{ height }} aria-busy>
      <div className="absolute inset-y-3 left-2 flex w-6 flex-col justify-between" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-1.5 w-full rounded-full bg-white/[0.06]" />
        ))}
      </div>
      <div className="absolute inset-y-3 left-10 right-3 flex flex-col justify-between" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("border-t border-white/[0.06]", i < 3 && "border-dashed")} />
        ))}
      </div>
      <div className="absolute inset-y-3 left-10 right-3 flex items-end gap-[3px] px-1" aria-hidden>
        {SKELETON_BARS.map((h, i) => (
          <span key={i} className="chart-skel-bar flex-1 rounded-t-sm bg-white/[0.07]" style={{ height: `${h}%`, animationDelay: `${i * 70}ms` }} />
        ))}
      </div>
      <div className="chart-skel-sheen pointer-events-none absolute inset-0 bg-linear-to-r from-transparent via-white/[0.05] to-transparent" aria-hidden />
      {text && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Badge variant="neutral" className="h-7 gap-2 bg-ink-900/80 px-3 backdrop-blur">
            <Spinner data-icon="inline-start" className="size-3" />
            {text}
          </Badge>
        </div>
      )}
    </div>
  );
};

export type LoadingShape = "none" | "lines" | "table" | "chart" | "kpis" | "page";

/**
 * Loading placeholder: a spinner with what is loading, and optionally a skeleton of the content
 * that will replace it (`shape`), so the page keeps its layout while it waits.
 */
const DefaultLoadingLabel = () => <>{useI18n().t("Connecting to plant telemetry…")}</>;

export const LoadingState: React.FC<{ label?: string; shape?: LoadingShape; rows?: number; className?: string }> = ({
  label,
  shape = "none",
  rows,
  className,
}) => (
  <Card className={cn("gap-4 p-6", className)} aria-busy>
    <div className="flex items-center gap-3 text-sm text-slate-400">
      <Spinner />
      {label ?? <DefaultLoadingLabel />}
    </div>
    {shape === "lines" && (
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    )}
    {shape === "table" && <SkeletonRows rows={rows ?? 6} />}
    {shape === "chart" && <SkeletonChart label={false} />}
    {shape === "kpis" && <SkeletonKpis />}
    {shape === "page" && (
      <>
        <SkeletonKpis />
        <SkeletonChart height={240} label={false} />
        <SkeletonRows rows={rows ?? 4} />
      </>
    )}
  </Card>
);

/** Indeterminate loading bar (`.loading-bar` in index.css); fades out when not `active`. */
export const LoadingBar: React.FC<{ active: boolean; label?: string; className?: string }> = ({ active, label, className }) => (
  <div
    className={cn("loading-bar transition-opacity", active ? "opacity-100" : "opacity-0", className)}
    role="progressbar"
    aria-hidden={!active}
    aria-label={label}
  >
    {active && <span />}
  </div>
);

const DefaultSuspendLabel = () => <>{useI18n().t("Loading…")}</>;

/**
 * Content suspended while it re-reads: what is on screen stays (so the layout doesn't jump) but is
 * dimmed and `inert` under an indeterminate loading bar and a sticky "Loading…" pill.
 * Use it only for a re-read with data already shown; the first load gets `LoadingState` / skeletons.
 */
export const Suspended: React.FC<{
  busy: boolean;
  /** pill text; default "Loading…" */
  label?: string;
  /** false = only the bar and the dimming, no pill (small cards); "center" = the pill in the
   * middle of the content instead of sticky at its top (a chart) */
  pill?: boolean | "center";
  className?: string;
  /** classes of the dimmed content box (e.g. its flex / gap layout) */
  contentClassName?: string;
  children: React.ReactNode;
}> = ({ busy, label, pill = true, className, contentClassName, children }) => (
  <div className={cn("relative", className)} aria-busy={busy}>
    <LoadingBar active={busy} label={label} className="pointer-events-none absolute inset-x-0 top-0 z-20" />
    {busy && pill && (
      <div
        className={cn(
          "pointer-events-none z-20 flex justify-center",
          pill === "center" ? "absolute inset-0 items-center" : "sticky top-3 h-0"
        )}
      >
        <Badge variant="neutral" className="h-7 gap-2 bg-ink-900/90 px-3 shadow-lg backdrop-blur animate-in fade-in-0 zoom-in-95">
          <Spinner data-icon="inline-start" className="size-3" />
          {label ?? <DefaultSuspendLabel />}
        </Badge>
      </div>
    )}
    <div
      className={cn("transition-[opacity,filter] duration-200", busy && "pointer-events-none select-none opacity-50 saturate-50", contentClassName)}
      inert={busy || undefined}
    >
      {children}
    </div>
  </div>
);

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */
export const fmt = (v: unknown, digits = 1): string => {
  if (v == null || v === "") return "—"; // Number(null) is 0: missing must not render as 0
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export const fmtInt = (v: unknown): string => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
};
