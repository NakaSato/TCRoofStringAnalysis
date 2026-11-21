/** Inverters page: helpers and small pieces shared by its cards. */
import React from "react";
import type { GrowattLiveInverterLatest, GrowattPlantOverview, LiveStringCheck } from "../../api/client";
import { INVERTER_STATUS_NAMES, OFFLINE_LABEL, inverterStatusLevel } from "../../context/PlantContext";
import { LOADING_STATUS, StatusBadge } from "../../components/ui";
import type { StatusLevel } from "../../components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export type OverviewInverter = GrowattPlantOverview["inverters"][number];
export type PlantKpis = GrowattPlantOverview["kpis"];
export type PlantString = GrowattPlantOverview["strings"][number];
export type InactiveString = NonNullable<GrowattPlantOverview["inactive_strings"]>[number];
export type Anomaly = GrowattPlantOverview["anomalies"][number];
export type LiveInverter = GrowattLiveInverterLatest;
export type LiveCheck = LiveStringCheck["inverters"][string];

/**
 * An inverter's state now, from its newest live record only (never from the stored day):
 * `waiting` while the first live answer is outstanding (not the inverter status Waiting),
 * `none` when the live answer has no record for it today (= Offline, unless the live call failed).
 */
export type LiveState =
  | { kind: "waiting" }
  | { kind: "none"; failed: boolean }
  | { kind: "live"; rec: LiveInverter; label: string; level: StatusLevel };

export const liveState = (rec: LiveInverter | undefined, loading: boolean, failed: boolean): LiveState => {
  if (rec) {
    const st = rec.status;
    const label = st == null ? "Unknown" : INVERTER_STATUS_NAMES[st] ?? `Status ${st}`;
    const level: StatusLevel = inverterStatusLevel(st);
    return { kind: "live", rec, label, level };
  }
  return loading ? { kind: "waiting" } : { kind: "none", failed };
};

/** Inverter label: its Growatt name when set, else the serial. */
export const invName = (i: OverviewInverter) => i.alias || i.device_sn;

export const sumOrNull = (vals: Array<number | null | undefined>): number | null => {
  const xs = vals.filter((v): v is number => v != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
};

/** Configured active-power limit below 100 % = curtailed by setting (not a fault). */
export const limitPct = (i: OverviewInverter): number | null => {
  const r = i.settings?.active_rate_pct;
  return r != null && r < 100 ? r : null;
};
export const isSwitchedOff = (i: OverviewInverter) => i.settings?.on_off === 0;

/** Below this share of the plant's average inverter yield an inverter is worth a look. */
export const LOW_PCT = 90;
/** Inverter temperature worth a look (°C). */
export const HOT_C = 70;

/** "2026-11-14 13:05:00" → "13:05" (plant-local record time). */
export const hhmm = (ts: string | null | undefined) => (ts && ts.length >= 16 ? ts.slice(11, 16) : ts ?? "—");

/** A cell of a divided figures grid: rules on its left and bottom (Sensors / Active Alarm style). */
export const KPI_CELL = "-mb-px -ml-px min-w-0 border-b border-l border-white/[0.06] px-4 py-3";

/**
 * Frame of a group of four figures: 2 × 2, or one row of 4 when there is room (full width, or
 * side by side on wide screens); cells on the outer edge are clipped under the frame.
 */
export const KPI_ROW = "grid grid-cols-2 overflow-hidden rounded-lg border border-white/[0.06] md:grid-cols-4 xl:grid-cols-2 min-[1500px]:grid-cols-4";

/** One labelled number in a divided row. */
export const Stat: React.FC<{ label: string; children: React.ReactNode; hint?: React.ReactNode; className?: string }> = ({
  label,
  children,
  hint,
  className,
}) => {
  const { t } = useI18n();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", KPI_CELL, className)}>
      <span className="eyebrow">{t(label)}</span>
      <span className="num truncate text-lg font-semibold tracking-tight text-foreground">{children}</span>
      {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
};

/** Unit after a number in a Stat. */
export const Unit: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-xs font-normal text-muted-foreground">{children}</span>
);

/** Label / value line of a definition list (label and title are translated here). */
export const Row: React.FC<{ label: string; children: React.ReactNode; title?: string }> = ({ label, children, title }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.04] py-1.5 last:border-0" title={title ? t(title) : undefined}>
      <span className="text-xs text-slate-400">{t(label)}</span>
      <span className="num text-right text-sm text-slate-100">{children}</span>
    </div>
  );
};

/** A fault / warning code: 0 = none, non-zero highlighted, null = not reported. */
export const Code: React.FC<{ v: number | null | undefined; tone?: "crit" | "warn" }> = ({ v, tone = "crit" }) =>
  v == null ? (
    <span className="text-muted-foreground">—</span>
  ) : v === 0 ? (
    <span className="text-slate-300">0</span>
  ) : (
    <span className={cn("font-semibold", tone === "crit" ? "text-red-300" : "text-amber-300")}>{v}</span>
  );

/** Status badge of the live state: spinner while waiting, Offline when it has no record today. */
export const LiveBadge: React.FC<{ s: LiveState }> = ({ s }) =>
  s.kind === "live" ? (
    // StatusBadge translates the text: "{label} (stale)" is a key of its own
    <StatusBadge status={s.rec.stale ? `${s.label} (stale)` : s.label} level={s.rec.stale ? "warn" : s.level} />
  ) : s.kind === "waiting" ? (
    <StatusBadge status={LOADING_STATUS} loading />
  ) : s.failed ? (
    <StatusBadge status="Live unavailable" level="neutral" dot={false} />
  ) : (
    <StatusBadge status={OFFLINE_LABEL} level="crit" />
  );

/** Small heading above a group of figures ("Now · live 13:05"); the title is translated here. */
export const GroupLabel: React.FC<{ title: string; note?: React.ReactNode }> = ({ title, note }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-slate-200 uppercase">{t(title)}</span>
      {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
    </div>
  );
};
