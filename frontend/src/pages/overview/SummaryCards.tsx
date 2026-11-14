/** Plant Overview KPI strip: the Inverters Online and String Health tiles, each linking to its tab. */
import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Activity, Cable, Cpu, Flame, HeartPulse, Thermometer, TrendingDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { GrowattPlantOverview } from "../../api/client";
import { KpiTile, Led, fmt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { HOT_C, LOW_PCT, invName, isSwitchedOff, limitPct } from "../inverters/shared";
import type { LiveInverter } from "../inverters/shared";

const Count: React.FC<{ level: "ok" | "warn" | "crit" | "off"; n: number; label: string }> = ({ level, n, label }) => (
  <span className="inline-flex items-center gap-1.5">
    <Led level={level} />
    <span className="num font-semibold text-foreground">{n}</span>
    <span className="text-muted-foreground">{label}</span>
  </span>
);

/** A small figure of the Inverters Online tile: icon + value + unit, the label as tooltip. */
const Mini: React.FC<{ icon: LucideIcon; label: string; value: string; unit: string; tone?: string }> = ({ icon: Icon, label, value, unit, tone }) => (
  <span className="inline-flex items-center gap-1" title={label} aria-label={`${label}: ${value} ${unit}`}>
    <Icon className="size-3 text-muted-foreground" />
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
  const lowWarn = s.lowestPct != null && s.lowestPct < LOW_PCT;
  const hot = kpis.max_temp_c != null && kpis.max_temp_c >= HOT_C;

  return (
    <Link to={href} aria-label="Open Inverters" title="Open Inverters" className="block rounded-xl outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring">
      <KpiTile
        label="Inverters Online"
        icon={Cpu}
        tone="ok"
        accentBar={false}
        className="h-full"
        value={`${online ?? "—"} / ${kpis.inverter_count ?? "—"}`}
        hint={
          <div className="flex flex-col gap-1.5">
            <div className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1">
              {liveLoading && !recs.length ? (
                <Spinner className="size-3" />
              ) : (
                <>
                  <Count level="ok" n={normal} label="normal" />
                  {offline > 0 && <Count level="off" n={offline} label="offline" />}
                  {fault > 0 && <Count level="crit" n={fault} label="fault" />}
                  {other > 0 && <Count level="warn" n={other} label="other" />}
                  {noRecord > 0 && <Count level="off" n={noRecord} label="no record" />}
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Mini icon={Activity} label="DC→AC efficiency (stored day)" value={fmt(kpis.conversion_efficiency_pct, 1)} unit="%" />
              <Mini icon={Thermometer} label="Average inverter temperature (stored day)" value={fmt(kpis.avg_temp_c, 1)} unit="°C" />
              <Mini
                icon={Flame}
                label={`Hottest inverter (stored day)${s.hottest ? ` · ${invName(s.hottest)}` : ""}`}
                value={fmt(kpis.max_temp_c, 1)}
                unit="°C"
                tone={hot ? "text-amber-300" : undefined}
              />
            </div>
            {(lowWarn || s.limited > 0 || s.off > 0) && (
              <div className="flex flex-wrap gap-1">
                {lowWarn && s.lowest && (
                  <Badge variant="warn" className="num" title={`${fmt(s.lowest.yield_today_kwh, 1)} kWh, ${fmt(s.lowestPct, 0)}% of the plant average`}>
                    Low · {invName(s.lowest)} {fmt(s.lowestPct, 0)}%
                  </Badge>
                )}
                {s.limited > 0 && (
                  <Badge variant="warn" className="num" title="Active power rate below 100 %">
                    Power-limited · {s.limited}
                  </Badge>
                )}
                {s.off > 0 && (
                  <Badge variant="crit" className="num" title="Switched off in the inverter settings">
                    Off · {s.off}
                  </Badge>
                )}
              </div>
            )}
          </div>
        }
      />
    </Link>
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
  const pct = (n: number) => `${(n / total) * 100}%`;
  const critical = kpis.critical_strings ?? 0;
  const warning = kpis.warning_strings ?? 0;

  return (
    <Link
      to={href}
      aria-label="Open String Diagnostics"
      title="Open String Diagnostics"
      className="block rounded-xl outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <KpiTile
        label="String Health"
        icon={HeartPulse}
        tone={critical > 0 ? "crit" : warning > 0 ? "warn" : "ok"}
        accentBar={false}
        className="h-full"
        value={fmt(kpis.avg_health_score, 1)}
        unit="/ 100"
        hint={
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Mini icon={Cable} label={`Strings${kpis.inactive_strings ? ` · ${kpis.inactive_strings} inputs idle` : ""}`} value={String(total)} unit="strings" />
              <Mini icon={TrendingDown} label="Estimated loss vs peers (modelled, stored day)" value={strings.length ? fmt(loss, 1) : "—"} unit="kWh" />
            </div>
            <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-white/[0.05]">
              {total > 0 && (
                <>
                  <div style={{ width: pct(kpis.healthy_strings) }} className="bg-emerald-400" />
                  <div style={{ width: pct(warning) }} className="bg-amber-400" />
                  <div style={{ width: pct(critical) }} className="bg-red-500" />
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Count level="ok" n={kpis.healthy_strings} label="healthy" />
              <Count level="warn" n={warning} label="warning" />
              <Count level="crit" n={critical} label="critical" />
            </div>
          </div>
        }
      />
    </Link>
  );
};
