/** Plant Overview: one summary card per detail tab (Inverters, String Diagnostics), each linking to it. */
import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowRight, Cable, Flame, HeartPulse, Thermometer, TrendingDown } from "lucide-react";
import type { GrowattPlantOverview } from "../../api/client";
import { Led, fmt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { HOT_C, LOW_PCT, invName, isSwitchedOff, limitPct } from "../inverters/shared";
import type { LiveInverter } from "../inverters/shared";
import { IconStat, IconStats } from "./IconStat";

const OpenLink: React.FC<{ to: string; label: string }> = ({ to, label }) => (
  <CardAction>
    <Button asChild variant="ghost" size="icon-sm" aria-label={`Open ${label}`} title={`Open ${label}`}>
      <Link to={to}>
        <ArrowRight />
      </Link>
    </Button>
  </CardAction>
);

const Count: React.FC<{ level: "ok" | "warn" | "crit" | "off"; n: number; label: string }> = ({ level, n, label }) => (
  <span className="inline-flex items-center gap-1.5">
    <Led level={level} />
    <span className="num font-semibold text-foreground">{n}</span>
    <span className="text-muted-foreground">{label}</span>
  </span>
);

/** Inverter states now (newest live record each) and the stored day's outliers. */
export const InvertersSummary: React.FC<{
  ov: GrowattPlantOverview;
  href: string;
  /** newest live record per inverter (empty while waiting / when live failed) */
  recs: LiveInverter[];
  liveLoading: boolean;
}> = ({ ov, href, recs, liveLoading }) => {
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
      avg,
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

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Inverters <span className="num text-xs font-normal text-muted-foreground">{inverters.length}</span>
        </CardTitle>
        <OpenLink to={href} label="Inverters" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
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
        <IconStats cols="grid-cols-3">
          <IconStat icon={Activity} label="DC→AC efficiency" value={fmt(kpis.conversion_efficiency_pct, 1)} unit="%" hint="Stored day" />
          <IconStat icon={Thermometer} label="Average inverter temperature" value={fmt(kpis.avg_temp_c, 1)} unit="°C" hint="Stored day" />
          <IconStat
            icon={Flame}
            label="Hottest inverter"
            value={fmt(kpis.max_temp_c, 1)}
            unit="°C"
            hint={s.hottest ? invName(s.hottest) : undefined}
            tone={kpis.max_temp_c != null && kpis.max_temp_c >= HOT_C ? "text-amber-300" : undefined}
          />
        </IconStats>
        {(lowWarn || s.limited > 0 || s.off > 0) && (
          <div className="flex flex-wrap gap-1.5">
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
      </CardContent>
    </Card>
  );
};

/** The stored day's string analysis: health split. */
export const StringsSummary: React.FC<{ ov: GrowattPlantOverview; href: string }> = ({ ov, href }) => {
  const { kpis, strings } = ov;
  const loss = strings.reduce((a, s) => a + (s.energy_loss_kwh ?? 0), 0);
  const total = kpis.string_count || 0;
  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>String Diagnostics</CardTitle>
        <OpenLink to={href} label="Strings" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <IconStats cols="grid-cols-3">
          <IconStat icon={HeartPulse} label="Average string health" value={fmt(kpis.avg_health_score, 1)} unit="/100" hint="Stored day" />
          <IconStat
            icon={Cable}
            label="Strings"
            value={String(total)}
            hint={kpis.inactive_strings ? `${kpis.inactive_strings} inputs idle` : undefined}
          />
          <IconStat icon={TrendingDown} label="Estimated loss" value={strings.length ? fmt(loss, 1) : "—"} unit="kWh" hint="vs peers, modelled" />
        </IconStats>
        <div className="flex flex-col gap-1.5">
          <div className="flex h-2 gap-px overflow-hidden rounded-full bg-white/[0.05]">
            {total > 0 && (
              <>
                <div style={{ width: pct(kpis.healthy_strings) }} className="bg-emerald-400" />
                <div style={{ width: pct(kpis.warning_strings) }} className="bg-amber-400" />
                <div style={{ width: pct(kpis.critical_strings) }} className="bg-red-500" />
              </>
            )}
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 text-xs">
            <Count level="ok" n={kpis.healthy_strings} label="healthy" />
            <Count level="warn" n={kpis.warning_strings} label="warning" />
            <Count level="crit" n={kpis.critical_strings} label="critical" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
