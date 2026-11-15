/**
 * Inverters page, selected inverter: identity and live status, what needs a look (settings that
 * curtail it, live fault codes, string findings of the stored day), its numbers now and for the
 * stored day, and device details / settings folded away.
 */
import React, { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, OctagonAlert, Power, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { fmt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { dayLabel } from "@/lib/day";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { GroupLabel, HOT_C, KPI_ROW, LOW_PCT, LiveBadge, Row, Stat, Unit, hhmm, invName, isSwitchedOff, limitPct } from "./shared";
import type { Anomaly, LiveState, OverviewInverter } from "./shared";
import type { GrowattLiveDatalogger } from "../../api/types/growatt";

/** Growatt's live word on the inverter's datalogger: its `lost` flag and last upload (never stored). */
const dataloggerNow = (dl: GrowattLiveDatalogger | null | undefined): string | null => {
  if (!dl) return null;
  const state = dl.lost == null ? null : dl.lost ? "Offline" : "Online";
  const at = dl.last_update_time ? `last upload ${dl.last_update_time.slice(0, 16)}` : null;
  return [state, at].filter(Boolean).join(", ") || null;
};

/** Non-zero codes of the live record (0 = none, null = not reported). */
const activeCodes = (d: NonNullable<OverviewInverter["live_diagnostics"]> | undefined) => {
  if (!d) return { faults: [] as string[], warnings: [] as string[] };
  const faults = (
    [
      ["Fault type", d.fault_type],
      ["Fault code 1", d.fault_code1],
      ["Fault code 2", d.fault_code2],
      ["PID fault", d.pid_fault_code],
      ["String break", d.str_break],
    ] as const
  )
    .filter(([, v]) => v != null && v !== 0)
    .map(([k, v]) => `${k} ${v}`);
  const warnings = [d.warn_code, ...d.warning_values].filter((v) => v != null && v !== 0).map((v) => `Warning ${v}`);
  return { faults, warnings };
};

export const InverterCard: React.FC<{
  inv: OverviewInverter;
  state: LiveState;
  /** this inverter's datalogger in the live answer; null / undefined = not known now */
  datalogger?: GrowattLiveDatalogger | null;
  day: string | null;
  pct: number | null;
  anomalies: Anomaly[];
  inactiveCount: number;
  index: number;
  count: number;
  onStep: (delta: -1 | 1) => void;
  onTab: (tab: "strings" | "grid") => void;
}> = ({ inv, state, datalogger, day, pct, anomalies, inactiveCount, index, count, onStep, onTab }) => {
  const [open, setOpen] = useState(false);
  const rec = state.kind === "live" ? state.rec : null;
  const d = rec?.diagnostics;
  const codes = activeCodes(d);
  const lim = limitPct(inv);
  const off = isSwitchedOff(inv);
  const crit = anomalies.filter((a) => a.severity === "Critical").length;
  const st = inv.settings;
  const settingRows = (
    [
      [
        "Active power limit",
        st?.active_rate_pct == null
          ? null
          : `${fmt(st.active_rate_pct, 0)} %${
              st.active_rate_source === "read_power" && st.power_limit_read_at
                ? ` · read ${new Date(st.power_limit_read_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`
                : ""
            }`,
      ],
      ["On / Off", st?.on_off == null ? null : st.on_off === 0 ? "Off" : "On"],
      ["PF setting", st?.pf_setting == null ? null : `${fmt(st.pf_setting, 2)}${st.pf_model != null ? ` · mode ${st.pf_model}` : ""}`],
      ["Reactive power", st?.reactive_rate_pct == null ? null : `${fmt(st.reactive_rate_pct, 0)} %`],
      [
        "Export limit",
        st?.export_limit == null
          ? null
          : st.export_limit === 0
            ? "Off"
            : `On${st.export_limit_rate_pct != null ? ` · ${fmt(st.export_limit_rate_pct, 0)} %` : ""}`,
      ],
    ] as const
  ).filter(([, v]) => v != null);
  const settingsRead = st?.read_at ? new Date(st.read_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : null;

  return (
    <Card id="inverter-detail" className="scroll-mt-4 gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {invName(inv)}
          {inv.alias && <span className="num text-xs font-medium text-muted-foreground">{inv.device_sn}</span>}
          <LiveBadge s={state} />
        </CardTitle>
        <CardDescription className="num">
          {[
            inv.model || null,
            inv.nominal_power_kw != null ? `${fmt(inv.nominal_power_kw, 0)} kW rated` : null,
            inv.capacity_kwp != null ? `${fmt(inv.capacity_kwp, 1)} kWp DC` : null,
            `${inv.string_count} strings`,
            inv.datalogger_sn ? `datalogger ${inv.datalogger_sn}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </CardDescription>
        <CardAction>
          <ButtonGroup aria-label="Step through inverters">
            <Button variant="outline" size="icon-sm" onClick={() => onStep(-1)} disabled={count < 2} aria-label="Previous inverter">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="sm" className="num pointer-events-none min-w-14" tabIndex={-1}>
              {index + 1} / {count}
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => onStep(1)} disabled={count < 2} aria-label="Next inverter">
              <ChevronRight />
            </Button>
          </ButtonGroup>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {off && (
          <Alert variant="destructive">
            <Power />
            <AlertTitle>Switched off by setting</AlertTitle>
            <AlertDescription>On / Off is set to Off on the inverter{settingsRead ? ` (settings read ${settingsRead})` : ""}.</AlertDescription>
          </Alert>
        )}
        {!off && lim != null && (
          <Alert variant="warn">
            <SlidersHorizontal />
            <AlertTitle>Power limited to {fmt(lim, 0)} %</AlertTitle>
            <AlertDescription>
              An active power limit is set on the inverter, so a lower yield than its peers is expected and is not a fault.
            </AlertDescription>
          </Alert>
        )}
        {codes.faults.length + codes.warnings.length > 0 && (
          <Alert variant={codes.faults.length ? "destructive" : "warn"}>
            <OctagonAlert />
            <AlertTitle>Live record reports {[...codes.faults, ...codes.warnings].join(", ")}</AlertTitle>
            <AlertDescription>
              <span>
                Codes are Growatt's own, from the record of {hhmm(rec?.timestamp)}.{" "}
                <button type="button" className="underline underline-offset-2 hover:text-white" onClick={() => onTab("grid")}>
                  Grid & faults
                </button>
              </span>
            </AlertDescription>
          </Alert>
        )}
        {(anomalies.length > 0 || inactiveCount > 0) && (
          <Alert variant={crit ? "destructive" : "warn"}>
            <TriangleAlert />
            <AlertTitle>
              {[
                crit ? `${crit} critical` : null,
                anomalies.length - crit ? `${anomalies.length - crit} warning` : null,
                inactiveCount ? `${inactiveCount} inactive` : null,
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              string{anomalies.length + inactiveCount === 1 ? "" : "s"} on {day ? dayLabel(day) : "the stored day"}
            </AlertTitle>
            <AlertDescription>
              <span>
                {anomalies
                  .slice(0, 3)
                  .map((a) => `${a.string_id.split(" · ").pop()} ${a.category.toLowerCase()}`)
                  .join(" · ")}
                {anomalies.length > 3 ? ` · +${anomalies.length - 3} more` : ""}
                {anomalies.length ? ". " : ""}
                <button type="button" className="underline underline-offset-2 hover:text-white" onClick={() => onTab("strings")}>
                  Strings
                </button>
              </span>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="flex flex-col gap-2">
            <GroupLabel
              title="Now"
              note={rec ? `live · record ${rec.timestamp.slice(0, 16)}${rec.stale ? " · stale, Growatt refused the last request" : ""}` : state.kind === "waiting" ? "asking Growatt…" : "no live record for this inverter"}
            />
            <div className={KPI_ROW}>
              <Stat label="AC power" hint={inv.nominal_power_kw != null && rec?.pac_w != null ? `${fmt((rec.pac_w / 1000 / inv.nominal_power_kw) * 100, 0)} % of rated` : undefined}>
                {fmt(rec?.pac_w == null ? null : rec.pac_w / 1000, 1)} <Unit>kW</Unit>
              </Stat>
              <Stat label="DC input">
                {fmt(rec?.ppv_w == null ? null : rec.ppv_w / 1000, 1)} <Unit>kW</Unit>
              </Stat>
              <Stat label="Energy today" hint="Growatt's day counter">
                {fmt(rec?.eac_today_kwh, 1)} <Unit>kWh</Unit>
              </Stat>
              <Stat label="Temperature" hint={d ? `IPM ${fmt(d.ipm_temperature_c, 0)} · boost ${fmt(d.boost_temperature_c, 0)} °C` : undefined}>
                <span className={cn(rec?.temperature_c != null && rec.temperature_c >= HOT_C && "text-amber-300")}>{fmt(rec?.temperature_c, 1)}</span>{" "}
                <Unit>°C</Unit>
              </Stat>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <GroupLabel title="Stored day" note={day ? dayLabel(day) : "—"} />
            <div className={KPI_ROW}>
              <Stat label="Yield" hint={`${fmt(inv.specific_yield, 2)} kWh/kWp`}>
                {fmt(inv.yield_today_kwh, 1)} <Unit>kWh</Unit>
              </Stat>
              <Stat label={lim != null ? "vs plant avg (limited)" : "vs plant avg"}>
                <span className={cn(pct != null && pct < LOW_PCT && "text-amber-300")}>{fmt(pct, 0)}</span> <Unit>%</Unit>
              </Stat>
              <Stat label="Peak AC / DC">
                {fmt(inv.peak_ac_kw, 1)} <Unit>/</Unit> {fmt(inv.peak_dc_kw, 1)} <Unit>kW</Unit>
              </Stat>
              <Stat label="Efficiency" hint={`avg ${fmt(inv.avg_temp_c, 1)} · max ${fmt(inv.max_temp_c, 1)} °C`}>
                {fmt(inv.efficiency_pct, 2)} <Unit>%</Unit>
              </Stat>
            </div>
          </div>
        </div>

        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="self-start">
              <ChevronDown data-icon="inline-start" className={cn("transition-transform", open && "rotate-180")} />
              Device and settings
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 grid gap-x-8 rounded-lg border border-white/[0.06] px-4 py-2 md:grid-cols-2">
              <div>
                <Row label="Serial">{inv.device_sn}</Row>
                <Row label="Model">{inv.device_model || inv.model || "—"}</Row>
                <Row label="Rated AC">{fmt(inv.nominal_power_kw ?? inv.rated_power_kw, 0)} kW</Row>
                <Row label="DC capacity">{fmt(inv.capacity_kwp, 2)} kWp</Row>
                <Row label="Strings">{inv.string_count}</Row>
                <Row label="Firmware">
                  {inv.fw_version || "—"}
                  {inv.inner_version ? ` · ${inv.inner_version}` : ""}
                </Row>
                <Row label="Datalogger">
                  {inv.datalogger_sn || "—"}
                  {inv.datalogger_model ? ` · ${inv.datalogger_model}` : ""}
                </Row>
                <Row label="Datalogger now (live)" title="Growatt's own status of the datalogger. Offline here explains inverters with no live record.">
                  {dataloggerNow(datalogger) ?? "—"}
                </Row>
                <Row label="Added to Growatt" title="When Growatt registered the device, as Growatt reports it. Not a commissioning date.">
                  {inv.growatt_created_at ? inv.growatt_created_at.slice(0, 10) : "—"}
                </Row>
              </div>
              <div>
                <Row label="Lifetime energy">{fmt(inv.total_yield_kwh == null ? null : inv.total_yield_kwh / 1000, 1)} MWh</Row>
                <Row label="Run hours (live)">{d?.time_total_h == null ? "—" : `${fmt(d.time_total_h, 0)} h`}</Row>
                <Row label="Avg frequency (day)">{fmt(inv.avg_freq_hz, 2)} Hz</Row>
                {settingRows.map(([k, v]) => (
                  <Row key={k} label={k}>
                    {v}
                  </Row>
                ))}
                <Row label="Settings">
                  <span className="text-xs text-muted-foreground">
                    {!settingsRead ? "not read from Growatt yet" : settingRows.length ? `read ${settingsRead}` : `Growatt returned no values (read ${settingsRead})`}
                  </span>
                </Row>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
};
