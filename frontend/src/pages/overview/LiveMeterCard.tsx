/** Plant Overview: the energy meter at the grid point, live (`meter_last_data`, memory only, never stored). */
import React from "react";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Gauge, House, Sigma, Waves } from "lucide-react";
import type { useLiveMeter } from "./useLiveMeter";
import { Led, fmt } from "../../components/ui";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IconStat, IconStats } from "./IconStat";

const todayBkk = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });
/** "2026-11-15 22:28:45" → "22:28" today, else "2026-11-15 22:28" */
const when = (ts: string | null | undefined) => (!ts ? "—" : ts.slice(0, 10) === todayBkk() ? ts.slice(11, 16) : ts.slice(0, 16));
const kw = (w: number | null | undefined) => (w == null ? null : w / 1000);

/**
 * Grid import / export now (measured by the plant's energy meter) and the site load (PV AC + grid,
 * derived), from the page's `useLiveMeter` poll; hidden for plants without a meter.
 */
export const LiveMeterCard: React.FC<{ m: ReturnType<typeof useLiveMeter> }> = ({ m: { res, error, noMeter } }) => {
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
        <CardTitle>Energy meter</CardTitle>
        <CardAction>
          <span className="num inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {g?.timestamp ? (
              <>
                <Led level={stale ? "warn" : "ok"} pulse={!stale} />
                {stale ? "Stale" : "Live"} · {when(g.timestamp)}
              </>
            ) : res ? (
              "No record"
            ) : error ? (
              "Unavailable"
            ) : null}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {!res && !error ? (
          <Skeleton className="h-20 w-full" aria-label="Loading the energy meter…" />
        ) : !res ? (
          <p className="text-xs text-muted-foreground">Live meter unavailable: {error}</p>
        ) : (
          <>
            <IconStats cols="grid-cols-3">
              <IconStat
                icon={ArrowDownToLine}
                label="Grid import"
                value={fmt(g?.grid_import_kw, 2)}
                unit="kW"
                tone={g?.grid_import_kw ? "text-sky-300" : undefined}
                hint={`Bought from the grid now, measured by the energy meter · ${when(g?.timestamp)}`}
              />
              <IconStat
                icon={ArrowUpFromLine}
                label="Grid export"
                value={fmt(g?.grid_export_kw, 2)}
                unit="kW"
                tone={exporting ? "text-energy-300" : undefined}
                hint={`Sent to the grid now, measured by the energy meter · ${when(g?.timestamp)}`}
              />
              <IconStat
                icon={House}
                label="Load (derived)"
                value={fmt(load?.load_kw, 2)}
                unit="kW"
                hint={
                  load?.load_kw != null
                    ? `PV AC ${fmt(load.pv_kw, 2)} kW + grid ${fmt(g?.grid_power_kw, 2)} kW: derived, not measured`
                    : (load?.reason ?? "Load not available")
                }
              />
            </IconStats>
            {/* one meter: its own phase split, counter and quality figures, as reported */}
            {one && (
              <IconStats cols="grid-cols-3">
                <IconStat icon={Activity} label="Phase L1 power" value={fmt(kw(one.active_power_l1_w), 2)} unit="kW" hint="+ import / − export" />
                <IconStat icon={Activity} label="Phase L2 power" value={fmt(kw(one.active_power_l2_w), 2)} unit="kW" hint="+ import / − export" />
                <IconStat icon={Activity} label="Phase L3 power" value={fmt(kw(one.active_power_l3_w), 2)} unit="kW" hint="+ import / − export" />
                <IconStat
                  icon={Sigma}
                  label="Import counter"
                  value={fmt(one.import_counter_kwh, 0)}
                  unit="kWh"
                  hint="Lifetime import register of the meter"
                />
                <IconStat icon={Gauge} label="Power factor" value={fmt(one.power_factor, 2)} />
                <IconStat icon={Waves} label="Frequency" value={fmt(one.frequency_hz, 2)} unit="Hz" />
              </IconStats>
            )}
            {meters.length > 1 && (
              <p className="num text-[11px] text-muted-foreground">Sum of {meters.length} meters</p>
            )}
            {d && Object.keys(d.errors).length > 0 && (
              <p className="text-[11px] text-amber-300" title={Object.entries(d.errors).map(([k, v]) => `${k}: ${v}`).join("\n")}>
                {Object.keys(d.errors).length} meter{Object.keys(d.errors).length > 1 ? "s" : ""} not read
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
