/** Plant Overview KPI strip: the Inverters Online and String Health tiles, each linking to its tab. */
import React, { useMemo } from "react";
import type { GrowattPlantOverview } from "../../api/client";
import { Led, fmt } from "../../components/ui";
import { Meter, StatTile } from "./StatTile";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { HOT_C, LOW_PCT, invName, isSwitchedOff, limitPct } from "../inverters/shared";
import type { LiveInverter } from "../inverters/shared";

const Count: React.FC<{ level: "ok" | "warn" | "crit" | "off"; n: number; label: string }> = ({ level, n, label }) => (
  <span className="inline-flex items-center gap-1" title={label || undefined}>
    <Led level={level} />
    <span className="num font-semibold text-foreground">{n}</span>
    {label && <span className="text-muted-foreground">{label}</span>}
  </span>
);

/** A small figure in a tile's footer: value + unit, the full label as tooltip. */
const Mini: React.FC<{ label: string; value: string; unit: string; tone?: string }> = ({ label, value, unit, tone }) => (
  <span className="inline-flex items-center gap-1" title={label} aria-label={`${label}: ${value} ${unit}`}>
    <span className={cn("num font-semibold", tone ?? "text-foreground")}>{value}</span>
    <span className="text-muted-foreground">{unit}</span>
  </span>
);

/**
 * KPI strip tile "Inverters Online" (links to Inverters): online now of the plant's inverters, the
 * live states (newest record each), the stored day's efficiency / temperatures and outliers.
 */
export const InvertersOnlineTile: React.FC<{
  ov: GrowattPlantOverview;
  href: string;
  /** newest live record per inverter (empty while waiting / when live failed) */
  recs: LiveInverter[];
  liveLoading: boolean;
  /** reporting with status ≠ 0; null before the live answer */
  online: number | null;
}> = ({ ov, href, recs, liveLoading, online }) => {
  const { inverters, kpis } = ov;
  const s = useMemo(() => {
    const withYield = inverters.filter((i) => i.yield_today_kwh != null);
    const avg = withYield.length ? withYield.reduce((a, i) => a + (i.yield_today_kwh as number), 0) / withYield.length : null;
    const lowest = withYield.reduce<(typeof inverters)[number] | null>(
      (m, i) => (m == null || (i.yield_today_kwh as number) < (m.yield_today_kwh as number) ? i : m),
      null
    );
    const hottest = inverters.reduce<(typeof inverters)[number] | null>(
      (m, i) => (i.max_temp_c != null && (m?.max_temp_c == null || i.max_temp_c > m.max_temp_c) ? i : m),
      null
    );
    return {
      lowest,
      lowestPct: lowest && avg ? ((lowest.yield_today_kwh as number) / avg) * 100 : null,
      hottest,
      limited: inverters.filter((i) => limitPct(i) != null).length,
      off: inverters.filter(isSwitchedOff).length,
    };
  }, [inverters]);

  // Growatt status: 1 Normal, 0 Offline, 3 Fault (INVERTER_STATUS_NAMES); anything else = other
  const normal = recs.filter((r) => r.status === 1).length;
  const offline = recs.filter((r) => r.status === 0).length;
  const fault = recs.filter((r) => r.status === 3).length;
  const other = recs.length - normal - offline - fault;
  const noRecord = Math.max(0, inverters.length - recs.length);
  const total = normal + offline + fault + other + noRecord;
  const lowWarn = s.lowestPct != null && s.lowestPct < LOW_PCT;
  const hot = kpis.max_temp_c != null && kpis.max_temp_c >= HOT_C;

  return (
    <StatTile
      label="Inverters online"
      href={href}
      linkLabel="Open Inverters"
      tag={liveLoading && !recs.length ? "Live…" : recs.length ? "Live" : undefined}
      value={`${online ?? "—"} / ${kpis.inverter_count ?? "—"}`}
      tone={fault > 0 ? "text-red-300" : online != null && kpis.inverter_count && online < kpis.inverter_count ? "text-amber-300" : "text-emerald-300"}
      meter={
        total > 0 ? (
          <Meter
            segments={[
              { pct: (normal / total) * 100, className: "bg-emerald-400", title: `${normal} normal` },
              { pct: (other / total) * 100, className: "bg-amber-400", title: `${other} other` },
              { pct: (fault / total) * 100, className: "bg-red-500", title: `${fault} fault` },
              { pct: ((offline + noRecord) / total) * 100, className: "bg-slate-500", title: `${offline + noRecord} offline / no record` },
            ]}
          />
        ) : undefined
      }
      footer={
        liveLoading && !recs.length ? (
          <Spinner className="size-3" />
        ) : (
          <>
            {fault > 0 && <Count level="crit" n={fault} label="fault" />}
            {offline + noRecord > 0 && <Count level="off" n={offline + noRecord} label="offline" />}
            {other > 0 && <Count level="warn" n={other} label="other" />}
            {fault + offline + noRecord + other === 0 && normal > 0 && <span>all normal</span>}
            {lowWarn && s.lowest && (
              <span className="num text-amber-300" title={`${fmt(s.lowest.yield_today_kwh, 1)} kWh, ${fmt(s.lowestPct, 0)}% of the plant average (stored day)`}>
                low {invName(s.lowest)} {fmt(s.lowestPct, 0)}%
              </span>
            )}
            {s.limited > 0 && <span className="num text-amber-300" title="Active power rate below 100 %">{s.limited} limited</span>}
            {s.off > 0 && <span className="num text-red-300" title="Switched off in the inverter settings">{s.off} off</span>}
            {hot && <Mini label={`Hottest inverter (stored day)${s.hottest ? ` · ${invName(s.hottest)}` : ""}`} value={fmt(kpis.max_temp_c, 0)} unit="°C" tone="text-amber-300" />}
          </>
        )
      }
    />
  );
};

/**
 * KPI strip tile "String Health" (links to String Diagnostics): the stored day's average string
 * health, string count / idle inputs, modelled loss vs peers and the healthy / warning / critical split.
 */
export const StringHealthTile: React.FC<{ ov: GrowattPlantOverview; href: string }> = ({ ov, href }) => {
  const { kpis, strings } = ov;
  const loss = strings.reduce((a, s) => a + (s.energy_loss_kwh ?? 0), 0);
  const total = kpis.string_count || 0;
  const critical = kpis.critical_strings ?? 0;
  const warning = kpis.warning_strings ?? 0;

  return (
    <StatTile
      label="String health"
      href={href}
      linkLabel="Open String Diagnostics"
      tag={ov.meta.day ? new Date(`${ov.meta.day}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : undefined}
      value={fmt(kpis.avg_health_score, 1)}
      unit="/ 100"
      tone={critical > 0 ? "text-red-300" : warning > 0 ? "text-amber-300" : "text-emerald-300"}
      meter={
        total > 0 ? (
          <Meter
            segments={[
              { pct: (kpis.healthy_strings / total) * 100, className: "bg-emerald-400", title: `${kpis.healthy_strings} healthy` },
              { pct: (warning / total) * 100, className: "bg-amber-400", title: `${warning} warning` },
              { pct: (critical / total) * 100, className: "bg-red-500", title: `${critical} critical` },
            ]}
          />
        ) : undefined
      }
      footer={
        <>
          <Count level="ok" n={kpis.healthy_strings} label="" />
          <Count level="warn" n={warning} label="" />
          <Count level="crit" n={critical} label="" />
          <Mini label="Estimated loss vs peers (modelled, stored day)" value={strings.length ? fmt(loss, 1) : "—"} unit="kWh loss" />
        </>
      }
    />
  );
};
