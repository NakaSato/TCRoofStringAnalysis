/**
 * Shared UI kit for the GenZ Monitoring System (dark control-room theme).
 * Pair these components with the utility classes defined in `index.css`
 * (`.panel`, `.btn-*`, `.input`, `.data-table`, `.badge-*`, `.led-*`, ...).
 */
import React from "react";
import type { LucideIcon } from "lucide-react";

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
  <section className={`panel ${className}`}>
    {(title || actions) && (
      <header className="panel-header">
        <div className="min-w-0">
          {title && (
            <h2 className="panel-title">
              {Icon && <Icon className="h-4 w-4 text-solar-400" />}
              <span className="truncate">{title}</span>
            </h2>
          )}
          {subtitle && <p className="panel-subtitle mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
    )}
    <div className={bodyClassName}>{children}</div>
  </section>
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
  className?: string;
}> = ({ label, value, unit, hint, hintTone = "neutral", icon: Icon, tone = "neutral", className = "" }) => (
  <div className={`panel overflow-hidden p-4 ${className}`}>
    <div className={`absolute inset-x-0 top-0 h-px ${TONE_BAR[tone]}`} />
    <div className="flex items-start justify-between gap-2">
      <div className="eyebrow">{label}</div>
      {Icon && (
        <div className={`rounded-lg p-1.5 ring-1 ${TONE_ICON_BG[tone]}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
      )}
    </div>
    <div className="mt-2 flex items-baseline gap-1.5">
      <span className={`num text-2xl font-bold tracking-tight ${tone === "neutral" ? "text-white" : TONE_TEXT[tone]}`}>
        {value}
      </span>
      {unit && <span className="text-xs font-medium text-slate-500">{unit}</span>}
    </div>
    {hint && <div className={`mt-1.5 text-[11px] font-medium ${hintTone === "neutral" ? "text-slate-500" : TONE_TEXT[hintTone]}`}>{hint}</div>}
  </div>
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

export const StatusBadge: React.FC<{ status: unknown; level?: StatusLevel; className?: string; dot?: boolean }> = ({
  status,
  level,
  className = "",
  dot = true,
}) => {
  const lvl = level ?? statusLevel(status);
  return (
    <span className={`badge badge-${lvl} ${className}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${lvl === "ok" ? "bg-emerald-400" : lvl === "warn" ? "bg-amber-400" : lvl === "crit" ? "bg-red-400" : lvl === "info" ? "bg-sky-400" : "bg-slate-500"}`} />}
      {String(status ?? "—")}
    </span>
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
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06] ${className}`}>
      <div className={`h-full rounded-full ${bar} transition-all duration-700`} style={{ width: `${pct}%` }} />
    </div>
  );
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

export const LoadingState: React.FC<{ label?: string }> = ({ label = "Connecting to plant telemetry…" }) => (
  <div className="panel flex items-center gap-3 p-6 text-sm text-slate-400">
    <span className="relative flex h-2.5 w-2.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-solar-400 opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-solar-400" />
    </span>
    {label}
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
