/** Plant Overview: the energy meter at the grid point, live (`meter_last_data`, memory only, never stored). */
import React from "react";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Gauge, House, Sigma, Waves } from "lucide-react";
import type { useLiveMeter } from "./useLiveMeter";
import { Led, fmt } from "../../components/ui";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IconStat, IconStats } from "./IconStat";
import { useI18n } from "../../i18n";

const todayBkk = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });
/** "2026-11-15 22:28:45" → "22:28" today, else "2026-11-15 22:28" */
const when = (ts: string | null | undefined) => (!ts ? "—" : ts.slice(0, 10) === todayBkk() ? ts.slice(11, 16) : ts.slice(0, 16));
const kw = (w: number | null | undefined) => (w == null ? null : w / 1000);

/**
 * Grid import / export now (measured by the plant's energy meter) and the site load (PV AC + grid,
 * derived), from the page's `useLiveMeter` poll; hidden for plants without a meter.
 */
export const LiveMeterCard: React.FC<{ m: ReturnType<typeof useLiveMeter> }> = ({ m: { res, error, noMeter } }) => {
  const { t } = useI18n();
  if (noMeter) return null;

  const d = res?.data ?? null;
  const g = d?.grid ?? null;
  const load = d?.load ?? null;
  // a failed poll keeps the last answer on screen, but it is no longer live
  const stale = Boolean(res?.stale) || Boolean(d?.meters.some((m) => m.stale)) || error != null;
  const meters = d?.meters ?? [];
  const one = meters.length === 1 ? meters[0] : null;
  const exporting = g?.grid_power_kw != null && g.grid_power_kw < 0;

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t("Energy meter")}</CardTitle>
        <CardAction>
          <span className="num inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {g?.timestamp ? (
              <>
                <Led level={stale ? "warn" : "ok"} pulse={!stale} />
                {stale ? t("Stale") : t("Live")} · {when(g.timestamp)}
              </>
            ) : res ? (
              t("No record")
            ) : error ? (
              t("Unavailable")
            ) : null}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {!res && !error ? (
          <Skeleton className="h-20 w-full" aria-label={t("Loading the energy meter…")} />
        ) : !res ? (
          <p className="text-xs text-muted-foreground">{t("Live meter unavailable: {error}", { error })}</p>
        ) : (
          <>
            <IconStats cols="grid-cols-3">
              <IconStat
                icon={ArrowDownToLine}
                label={t("Grid import")}
                num={g?.grid_import_kw} digits={2}
                unit="kW"
                tone={g?.grid_import_kw ? "text-sky-300" : undefined}
                hint={t("Bought from the grid now, measured by the energy meter · {time}", { time: when(g?.timestamp) })}
              />
              <IconStat
                icon={ArrowUpFromLine}
                label={t("Grid export")}
                num={g?.grid_export_kw} digits={2}
                unit="kW"
                tone={exporting ? "text-energy-300" : undefined}
                hint={t("Sent to the grid now, measured by the energy meter · {time}", { time: when(g?.timestamp) })}
              />
              <IconStat
                icon={House}
                label={t("Load (derived)")}
                num={load?.load_kw} digits={2}
                unit="kW"
                hint={
                  load?.load_kw != null
                    ? t("PV AC {pv} kW + grid {grid} kW: derived, not measured", { pv: fmt(load.pv_kw, 2), grid: fmt(g?.grid_power_kw, 2) })
                    : (load?.reason ?? t("Load not available"))
                }
              />
            </IconStats>
            {/* one meter: its own phase split, counter and quality figures, as reported */}
            {one && (
              <IconStats cols="grid-cols-3">
                <IconStat icon={Activity} label={t("Phase L1 power")} num={kw(one.active_power_l1_w)} digits={2} unit="kW" hint={t("+ import / − export")} />
                <IconStat icon={Activity} label={t("Phase L2 power")} num={kw(one.active_power_l2_w)} digits={2} unit="kW" hint={t("+ import / − export")} />
                <IconStat icon={Activity} label={t("Phase L3 power")} num={kw(one.active_power_l3_w)} digits={2} unit="kW" hint={t("+ import / − export")} />
                <IconStat
                  icon={Sigma}
                  label={t("Import counter")}
                  num={one.import_counter_kwh} digits={0}
                  unit="kWh"
                  hint={t("Lifetime import register of the meter")}
                />
                <IconStat icon={Gauge} label={t("Power factor")} num={one.power_factor} digits={2} />
                <IconStat icon={Waves} label={t("Frequency")} num={one.frequency_hz} digits={2} unit="Hz" />
              </IconStats>
            )}
            {meters.length > 1 && (
              <p className="num text-[11px] text-muted-foreground">{t("Sum of {n} meters", { n: meters.length })}</p>
            )}
            {d && Object.keys(d.errors).length > 0 && (
              <p className="text-[11px] text-amber-300" title={Object.entries(d.errors).map(([k, v]) => `${k}: ${v}`).join("\n")}>
                {Object.keys(d.errors).length > 1 ? t("{n} meters not read", { n: Object.keys(d.errors).length }) : t("{n} meter not read", { n: 1 })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
