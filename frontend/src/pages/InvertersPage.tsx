import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  Cpu,
  Gauge,
  History,
  ShieldAlert,
  PlugZap,
  Sun,
  Table2,
  Thermometer,
  Zap,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { InverterProfilePanel } from "../components/InverterProfilePanel";
import { InverterComparisonPanel, InverterTrendPanel, StringHeatmapPanel } from "../components/InverterCharts";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { api } from "../api/client";
import type { GrowattInverterTimeseries } from "../api/client";
import { EmptyState, KpiTile, Led, LoadingState, Meter, Panel, StatusBadge, LOADING_STATUS, fmt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type OverviewInverter = NonNullable<ReturnType<typeof useAppContext>["selectedPlantOverview"]>["inverters"][number];

/** Realtime status → badge colour (status is null until the first live poll answers). */
const invLevel = (inv: OverviewInverter): StatusLevel =>
  inv.lost || inv.status === 0 ? "crit" : inv.status === 1 ? "ok" : inv.status == null ? "neutral" : "warn";

/** Inverter label: its Growatt name when set, else the serial. */
const invName = (i: OverviewInverter) => i.alias || i.device_sn;

const sumOrNull = (vals: Array<number | null | undefined>): number | null => {
  const xs = vals.filter((v): v is number => v != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
    <div className="num mt-0.5 text-sm font-semibold text-white">{children}</div>
  </div>
);

/** A fault / warning code: 0 = none (ok), non-zero highlighted, null = not reported. */
const Code: React.FC<{ v: number | null | undefined; tone?: "crit" | "warn" }> = ({ v, tone = "crit" }) =>
  v == null ? (
    <span className="text-slate-500">—</span>
  ) : v === 0 ? (
    <span className="text-emerald-300">0</span>
  ) : (
    <span className={tone === "crit" ? "text-red-300" : "text-amber-300"}>{v}</span>
  );

/** Identity / setting chip in the selected-inverter header (`tone` flags a setting worth a look). */
const Chip: React.FC<{ label: string; children: React.ReactNode; tone?: "warn" | "crit"; title?: string }> = ({
  label,
  children,
  tone,
  title,
}) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ring-1 ${
      tone === "crit"
        ? "bg-red-500/10 ring-red-400/30"
        : tone === "warn"
        ? "bg-amber-500/10 ring-amber-400/30"
        : "bg-white/[0.04] ring-white/[0.06]"
    }`}
  >
    <span className="uppercase tracking-wider text-slate-500">{label}</span>
    <span
      className={`num font-medium ${tone === "crit" ? "text-red-300" : tone === "warn" ? "text-amber-300" : "text-slate-200"}`}
    >
      {children}
    </span>
  </span>
);

/** Configured active-power limit below 100 % = curtailed by setting (not a fault). */
const limitPct = (i: OverviewInverter): number | null => {
  const r = i.settings?.active_rate_pct;
  return r != null && r < 100 ? r : null;
};
const isSwitchedOff = (i: OverviewInverter) => i.settings?.on_off === 0;

/** Headline number in the selected-inverter header. */
const Stat: React.FC<{ label: string; value: string; unit?: string; tone?: string }> = ({
  label,
  value,
  unit,
  tone = "text-white",
}) => (
  <div className="min-w-0">
    <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
    <div className="mt-0.5 flex items-baseline gap-1">
      <span className={`num text-lg font-bold ${tone}`}>{value}</span>
      {unit && <span className="text-[11px] text-slate-500">{unit}</span>}
    </div>
  </div>
);

type DetailTab = "performance" | "strings" | "grid" | "history";
const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "performance", label: "Performance", icon: Activity },
  { id: "strings", label: "Strings", icon: Gauge },
  { id: "grid", label: "Grid & Faults", icon: PlugZap },
  { id: "history", label: "History", icon: History },
];

/**
 * The selected plant's inverters as master / detail: a sticky inverter list on the right,
 * the selected inverter on the right (header + Performance / Strings / Grid & Faults /
 * History tabs) on the left with the yield comparison under the list, and the full table below.
 */
export const InvertersPage: React.FC = () => {
  const { selectedGrowattPlantId, selectedPlantOverview, plantOverviewLoading } = useAppContext();
  const [selectedSn, setSelectedSn] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("performance");

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;
  const inverters = selectedPlantOverview?.inverters ?? [];
  const strings = selectedPlantOverview?.strings ?? [];
  const day = selectedPlantOverview?.meta.day ?? null;

  useEffect(() => setSelectedSn(null), [selectedGrowattPlantId]);
  const inv = useMemo(
    () => inverters.find((i) => i.device_sn === selectedSn) ?? inverters[0] ?? null,
    [inverters, selectedSn]
  );
  const invStrings = useMemo(
    () => strings.filter((s) => s.device_sn === inv?.device_sn).sort((a, b) => a.string_no - b.string_no),
    [strings, inv?.device_sn]
  );

  // one inverter-day of stored 5-min history, shared by the profile chart and the string heatmap
  const [series, setSeries] = useState<GrowattInverterTimeseries | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const invSn = inv?.device_sn ?? null;
  useEffect(() => {
    if (selectedGrowattPlantId == null || !invSn) {
      setSeries(null);
      return;
    }
    let cancelled = false;
    setSeriesLoading(true);
    api
      .getGrowattInverterTimeseries(selectedGrowattPlantId, invSn, day ?? undefined)
      .then((r) => !cancelled && setSeries(r))
      .catch(() => !cancelled && setSeries(null))
      .finally(() => !cancelled && setSeriesLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedGrowattPlantId, invSn, day]);

  if (plantOverviewLoading && !selectedPlantOverview) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <LoadingState label="Loading the plant's inverters…" />
      </div>
    );
  }
  if (!selectedPlantOverview || !plant || selectedGrowattPlantId == null) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <EmptyState
          icon={Building2}
          title="Select a plant from the directory"
          description="Pick a plant on Plant Overview to see its inverters."
        />
      </div>
    );
  }

  const online = kpis?.online_inverters;
  const acNow = sumOrNull(inverters.map((i) => i.current_ac_kw));
  const yieldToday = sumOrNull(inverters.map((i) => i.yield_today_kwh));
  const hottest = inverters.reduce<OverviewInverter | null>(
    (m, i) => (i.max_temp_c != null && (m?.max_temp_c == null || i.max_temp_c > m.max_temp_c) ? i : m),
    null
  );
  const yields = inverters.map((i) => i.yield_today_kwh).filter((v): v is number => v != null);
  const avgYield = yields.length ? yields.reduce((a, b) => a + b, 0) / yields.length : null;
  const maxYield = yields.length ? Math.max(...yields) : null;
  const pctOfAvg = (i: OverviewInverter) =>
    i.yield_today_kwh != null && avgYield ? (i.yield_today_kwh / avgYield) * 100 : null;

  const g = inv?.live_grid ?? null;
  const d = inv?.live_diagnostics ?? null;
  const invPct = inv ? pctOfAvg(inv) : null;

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Inverters"
          icon={Cpu}
          tone={online == null ? "neutral" : online === inverters.length ? "ok" : "warn"}
          value={online == null ? `${inverters.length}` : `${online}/${inverters.length}`}
          hint={online == null ? "Live status loading…" : "online now (live)"}
        />
        <KpiTile label="AC Power Now" icon={Zap} tone="energy" value={fmt(acNow, 1)} unit="kW" hint="sum of inverters" />
        <KpiTile label="Yield (day)" icon={Sun} tone="solar" value={fmt(yieldToday, 1)} unit="kWh" hint={day ?? undefined} />
        <KpiTile label="Peak AC (plant)" icon={Activity} tone="info" value={fmt(kpis?.peak_power_kw, 1)} unit="kW" />
        <KpiTile
          label="DC→AC Efficiency"
          icon={Gauge}
          tone="ok"
          value={fmt(kpis?.conversion_efficiency_pct, 2)}
          unit="%"
          hint="energy-weighted, measured"
        />
        <KpiTile
          label="Max Inverter Temp"
          icon={Thermometer}
          tone={hottest?.max_temp_c != null && hottest.max_temp_c >= 70 ? "warn" : "neutral"}
          value={fmt(hottest?.max_temp_c, 1)}
          unit="°C"
          hint={hottest ? invName(hottest) : undefined}
        />
      </div>

      {inverters.length === 0 ? (
        <EmptyState icon={Cpu} title="No inverters" description="This plant has no inverters in the registry yet." />
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          {/* ---------------------------------------------------------------- master: inverter list (right on desktop, first on mobile) */}
          <aside className="space-y-4 xl:order-2 xl:col-span-3">
            <Panel
              icon={Cpu}
              title={`Inverters (${inverters.length})`}
              subtitle={`Yield vs plant average${day ? ` · ${day}` : ""}`}
              bodyClassName="p-2"
            >
              <ul className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
                {inverters.map((i) => {
                  const active = i.device_sn === inv?.device_sn;
                  const pct = pctOfAvg(i);
                  return (
                    <li key={i.device_sn}>
                      <button
                        type="button"
                        onClick={() => setSelectedSn(i.device_sn)}
                        className={`w-full rounded-lg px-3 py-2 text-left transition ${
                          active ? "bg-sky-500/10 ring-1 ring-sky-400/40" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Led level={i.status_label == null ? "off" : invLevel(i)} />
                          <span className={`truncate text-sm font-semibold ${active ? "text-sky-200" : "text-white"}`}>
                            {invName(i)}
                          </span>
                          {isSwitchedOff(i) ? (
                            <Badge variant="crit" className="shrink-0 text-[10px]">OFF</Badge>
                          ) : limitPct(i) != null ? (
                            <Badge variant="warn" className="shrink-0 text-[10px]" title="Active power limit set on the inverter">
                              LIMIT {fmt(limitPct(i), 0)}%
                            </Badge>
                          ) : null}
                          <span className="num ml-auto shrink-0 text-xs font-semibold text-energy-300">
                            {fmt(i.current_ac_kw, 1)} <span className="text-[11px] font-normal text-slate-500">kW</span>
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="num truncate">{i.alias ? i.device_sn : i.model || "—"}</span>
                          <span className="num ml-auto shrink-0">
                            {fmt(i.yield_today_kwh, 0)} kWh
                            {pct != null && (
                              <span className={pct < 90 ? " text-amber-300" : " text-slate-400"}> · {fmt(pct, 0)}%</span>
                            )}
                          </span>
                        </div>
                        <Meter
                          className="mt-1.5"
                          value={i.yield_today_kwh ?? 0}
                          max={maxYield ?? 1}
                          tone={active ? "info" : "solar"}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>
            <InverterComparisonPanel inverters={inverters} selectedSn={inv?.device_sn ?? null} day={day} />
          </aside>

          {/* ---------------------------------------------------------------- detail: selected inverter */}
          {inv && (
            <section className="min-w-0 space-y-4 xl:order-1 xl:col-span-9">
              {/* Header */}
              <Card className="gap-0 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="eyebrow">Inverter</div>
                    <h2 className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-lg font-bold text-white">
                      {invName(inv)}
                      {inv.alias && <span className="num text-sm font-medium text-slate-400">{inv.device_sn}</span>}
                    </h2>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {inv.live_at ? `Live record ${inv.live_at}` : `Last update ${inv.last_update_time ?? "—"}`}
                    </div>
                  </div>
                  <StatusBadge
                    status={inv.status_label ?? LOADING_STATUS}
                    level={invLevel(inv)}
                    loading={inv.status_label == null}
                    dot
                  />
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Chip label="Model">{inv.model || "—"}</Chip>
                  <Chip label="Rated">{fmt(inv.nominal_power_kw, 0)} kW</Chip>
                  <Chip label="DC">{fmt(inv.capacity_kwp, 1)} kWp</Chip>
                  <Chip label="Strings">{inv.string_count}</Chip>
                  <Chip label="Firmware">
                    {inv.fw_version || "—"}
                    {inv.inner_version ? ` · ${inv.inner_version}` : ""}
                  </Chip>
                  <Chip label="Datalogger">{inv.datalogger_sn || "—"}</Chip>
                  {d?.time_total_h != null && <Chip label="Run hours">{fmt(d.time_total_h, 0)} h</Chip>}
                </div>

                {/* Settings as configured on the inverter (read daily), not measurements */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Chip
                    label="Power limit"
                    tone={limitPct(inv) != null ? "warn" : undefined}
                    title="Active power limit set on the inverter; below 100 % the inverter is curtailed by setting"
                  >
                    {inv.settings?.active_rate_pct == null ? "—" : `${fmt(inv.settings.active_rate_pct, 0)} %`}
                  </Chip>
                  <Chip label="On/Off" tone={isSwitchedOff(inv) ? "crit" : undefined}>
                    {inv.settings?.on_off == null ? "—" : inv.settings.on_off === 0 ? "Off" : "On"}
                  </Chip>
                  <Chip label="PF set">
                    {fmt(inv.settings?.pf_setting, 2)}
                    {inv.settings?.pf_model != null ? ` · mode ${inv.settings.pf_model}` : ""}
                  </Chip>
                  <Chip label="Reactive set">
                    {inv.settings?.reactive_rate_pct == null ? "—" : `${fmt(inv.settings.reactive_rate_pct, 0)} %`}
                  </Chip>
                  <Chip label="Export limit" tone={inv.settings?.export_limit ? "warn" : undefined}>
                    {inv.settings?.export_limit == null
                      ? "—"
                      : inv.settings.export_limit === 0
                      ? "Off"
                      : `On${inv.settings.export_limit_rate_pct != null ? ` · ${fmt(inv.settings.export_limit_rate_pct, 0)} %` : ""}`}
                  </Chip>
                  <span className="text-[11px] text-slate-500">
                    {inv.settings?.read_at
                      ? `settings read ${new Date(inv.settings.read_at).toLocaleString()}`
                      : "settings not read from Growatt yet"}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-4 border-t border-white/[0.06] pt-3 sm:grid-cols-6">
                  <Stat label="AC now" value={fmt(inv.current_ac_kw, 1)} unit="kW" tone="text-energy-300" />
                  <Stat label="Yield (day)" value={fmt(inv.yield_today_kwh, 1)} unit="kWh" tone="text-solar-300" />
                  <Stat
                    label={limitPct(inv) != null ? "vs avg (limited)" : "vs plant avg"}
                    value={invPct == null ? "—" : `${fmt(invPct, 0)}%`}
                    tone={invPct != null && invPct < 90 ? "text-amber-300" : "text-white"}
                  />
                  <Stat label="kWh/kWp" value={fmt(inv.specific_yield, 2)} />
                  <Stat label="Efficiency" value={fmt(inv.efficiency_pct, 2)} unit="%" tone="text-emerald-300" />
                  <Stat
                    label="Max temp"
                    value={fmt(inv.max_temp_c, 1)}
                    unit="°C"
                    tone={inv.max_temp_c != null && inv.max_temp_c >= 70 ? "text-amber-300" : "text-rose-300"}
                  />
                </div>
              </Card>

              {/* Tabs */}
              <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
                <TabsList>
                  {DETAIL_TABS.map(({ id, label, icon: Icon }) => (
                    <TabsTrigger key={id} value={id}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              {tab === "performance" && (
                <div className="space-y-4">
                  <InverterProfilePanel
                    deviceSn={inv.device_sn}
                    label={invName(inv)}
                    series={series}
                    loading={seriesLoading}
                  />
                  <Panel
                    icon={Zap}
                    title={`MPPT ${inv.live_at ? "(live)" : "(latest stored)"}`}
                    subtitle="Voltage, current and power now; today's and lifetime DC energy per input (live record)"
                    bodyClassName="p-0"
                  >
                    {inv.mppt_latest.length === 0 ? (
                      <div className="p-4 text-xs text-slate-500">No MPPT record yet.</div>
                    ) : (
                      <Table containerClassName="scroll-x-hint">
                          <TableHeader>
                            <TableRow>
                              <TableHead>MPPT</TableHead>
                              <TableHead className="text-right">V</TableHead>
                              <TableHead className="text-right">A</TableHead>
                              <TableHead className="text-right">kW</TableHead>
                              <TableHead className="text-right">Today (kWh)</TableHead>
                              <TableHead className="text-right">Lifetime (MWh)</TableHead>
                              <TableHead className="w-1/4">Share of today's DC energy</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(() => {
                              const energy = new Map((inv.live_mppt_energy ?? []).map((e) => [e.mppt, e]));
                              const nos = [
                                ...new Set([...inv.mppt_latest.map((m) => m.mppt), ...energy.keys()]),
                              ].sort((a, b) => a - b);
                              const power = new Map(inv.mppt_latest.map((m) => [m.mppt, m]));
                              const totalToday = [...energy.values()].reduce((a, e) => a + (e.today_kwh || 0), 0);
                              return nos.map((n) => {
                                const m = power.get(n);
                                const e = energy.get(n);
                                return (
                                  <TableRow key={n}>
                                    <TableCell className="num whitespace-nowrap text-slate-300">MPPT-{n}</TableCell>
                                    <TableCell className="num whitespace-nowrap text-right text-sky-300">{fmt(m?.v, 1)}</TableCell>
                                    <TableCell className="num whitespace-nowrap text-right text-energy-300">{fmt(m?.i, 2)}</TableCell>
                                    <TableCell className="num whitespace-nowrap text-right text-solar-300">{fmt(m == null ? null : m.p / 1000, 2)}</TableCell>
                                    <TableCell className="num whitespace-nowrap text-right text-solar-300">{fmt(e?.today_kwh, 1)}</TableCell>
                                    <TableCell className="num whitespace-nowrap text-right text-slate-300">
                                      {fmt(e?.total_kwh == null ? null : e.total_kwh / 1000, 1)}
                                    </TableCell>
                                    <TableCell>
                                      {e?.today_kwh != null && totalToday > 0 ? (
                                        <Meter value={e.today_kwh} max={totalToday} tone="solar" />
                                      ) : (
                                        <span className="text-slate-500">—</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              });
                            })()}
                          </TableBody>
                        </Table>
                    )}
                  </Panel>
                </div>
              )}

              {tab === "strings" && (
                <div className="space-y-4">
                  <StringHeatmapPanel label={invName(inv)} series={series} loading={seriesLoading} />
                  <Panel
                    icon={Activity}
                    title={`Strings on ${invName(inv)} (${invStrings.length})`}
                    subtitle="Day totals from stored history; V / A now from live data where available"
                    bodyClassName="p-0"
                    actions={
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/strings">
                          String diagnostics <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    }
                  >
                    {invStrings.length === 0 ? (
                      <EmptyState icon={Activity} title="No producing strings" description="No string carried current on this day." />
                    ) : (
                      <Table containerClassName="scroll-x-hint">
                          <TableHeader>
                            <TableRow>
                              <TableHead>String</TableHead>
                              <TableHead>MPPT</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Modules</TableHead>
                              <TableHead className="text-right">Energy (kWh)</TableHead>
                              <TableHead className="text-right">V now</TableHead>
                              <TableHead className="text-right">A now</TableHead>
                              <TableHead className="text-right">I max (A)</TableHead>
                              <TableHead className="text-right">Health</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {invStrings.map((s) => (
                              <TableRow key={s.string_id}>
                                <TableCell className="num whitespace-nowrap font-bold text-white">{s.short_label}</TableCell>
                                <TableCell className="num whitespace-nowrap text-slate-400">{s.mppt_id}</TableCell>
                                <TableCell>
                                  <StatusBadge status={s.status} dot />
                                </TableCell>
                                <TableCell className="num whitespace-nowrap text-right text-slate-300">{s.modules ?? "—"}</TableCell>
                                <TableCell className="num whitespace-nowrap text-right text-solar-300">{fmt(s.actual_energy_kwh, 2)}</TableCell>
                                <TableCell className="num whitespace-nowrap text-right text-sky-300">{fmt(s.live_voltage_v, 1)}</TableCell>
                                <TableCell className="num whitespace-nowrap text-right text-energy-300">{fmt(s.live_current_a, 2)}</TableCell>
                                <TableCell className="num whitespace-nowrap text-right text-slate-300">{fmt(s.i_max, 2)}</TableCell>
                                <TableCell className="num whitespace-nowrap text-right text-slate-200">{fmt(s.health_score, 0)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                    )}
                  </Panel>
                </div>
              )}

              {tab === "grid" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <Panel icon={PlugZap} title={`Grid (AC)${g ? " · live" : ""}`} subtitle="Per-phase voltage and current of the newest record">
                      {!g ? (
                        <div className="text-xs text-slate-500">Waiting for a live record.</div>
                      ) : (
                        <>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Phase</TableHead>
                                <TableHead className="text-right">V (L-N)</TableHead>
                                <TableHead className="text-right">V (L-L)</TableHead>
                                <TableHead className="text-right">A</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {(
                                [
                                  ["R", g.v_r, "R-S", g.v_rs, g.i_r],
                                  ["S", g.v_s, "S-T", g.v_st, g.i_s],
                                  ["T", g.v_t, "T-R", g.v_tr, g.i_t],
                                ] as const
                              ).map(([ph, vln, ll, vll, a]) => (
                                <TableRow key={ph}>
                                  <TableCell className="num whitespace-nowrap text-slate-300">{ph}</TableCell>
                                  <TableCell className="num whitespace-nowrap text-right text-sky-300">{fmt(vln, 1)}</TableCell>
                                  <TableCell className="num whitespace-nowrap text-right text-slate-300" title={ll}>
                                    {fmt(vll, 1)}
                                  </TableCell>
                                  <TableCell className="num whitespace-nowrap text-right text-energy-300">{fmt(a, 2)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          <div className="mt-3 grid grid-cols-3 gap-x-4">
                            <Field label="Power factor">{fmt(g.pf, 3)}</Field>
                            <Field label="Reactive">{fmt(g.reactive_var == null ? null : g.reactive_var / 1000, 2)} kvar</Field>
                            <Field label="Frequency">{fmt(g.fac_hz, 2)} Hz</Field>
                          </div>
                        </>
                      )}
                    </Panel>

                    <Panel
                      icon={AlertTriangle}
                      title={`Fault / warning${d ? " · live" : ""}`}
                      subtitle="Codes of the newest record: 0 = none, — = not reported"
                    >
                      {!d ? (
                        <div className="text-xs text-slate-500">Waiting for a live record.</div>
                      ) : (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                          <Field label="Fault type">
                            <Code v={d.fault_type} />
                          </Field>
                          <Field label="Fault codes">
                            <Code v={d.fault_code1} /> / <Code v={d.fault_code2} />
                          </Field>
                          <Field label="Warning code">
                            <Code v={d.warn_code} tone="warn" />
                          </Field>
                          <Field label="Warning values">
                            {d.warning_values.map((w, k) => (
                              <React.Fragment key={k}>
                                {k > 0 && " / "}
                                <Code v={w} tone="warn" />
                              </React.Fragment>
                            ))}
                          </Field>
                          <Field label="PID fault">
                            <Code v={d.pid_fault_code} />
                          </Field>
                          <Field label="String break">
                            <Code v={d.str_break} />
                          </Field>
                          <Field label="PV insulation">{d.pv_iso_kohm == null ? "—" : `${fmt(d.pv_iso_kohm, 0)} kΩ`}</Field>
                          <Field label="Temp inv / IPM / boost">
                            {fmt(d.temperature_c, 1)} / {fmt(d.ipm_temperature_c, 1)} / {fmt(d.boost_temperature_c, 1)} °C
                          </Field>
                        </div>
                      )}
                    </Panel>
                  </div>
                  <Panel
                    icon={ShieldAlert}
                    title={`Safety · AFCI / leakage / DC injection${d ? " · live" : ""}`}
                    subtitle="Values as reported by Growatt in the newest record (codes and levels are Growatt's own; — = not reported)"
                  >
                    {!d ? (
                      <div className="text-xs text-slate-500">Waiting for a live record.</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                        <Field label="AFCI status">{d.afci_status ?? "—"}</Field>
                        <Field label="AFCI level PV1 / PV2">
                          {(d.afci_pv ?? []).map((v, k) => (
                            <React.Fragment key={k}>
                              {k > 0 && " / "}
                              {v ?? "—"}
                            </React.Fragment>
                          ))}
                        </Field>
                        <Field label="GFCI (leakage)">{fmt(d.gfci, 1)}</Field>
                        <Field label="DCI R / S / T">
                          {(d.dci ?? []).map((v, k) => (
                            <React.Fragment key={k}>
                              {k > 0 && " / "}
                              {fmt(v, 1)}
                            </React.Fragment>
                          ))}
                        </Field>
                      </div>
                    )}
                  </Panel>
                  <GrowattAlarmLogPanel plantId={plant.plant_id} plantName={plant.name} day={day} deviceSn={inv.device_sn} />
                </div>
              )}

              {tab === "history" && (
                <InverterTrendPanel plantId={plant.plant_id} deviceSn={inv.device_sn} label={invName(inv)} day={day} />
              )}
            </section>
          )}
        </div>
      )}

      {/* -------------------------------------------------------------------- whole plant */}
      {inverters.length > 0 && (
        <section>
            <Panel
              icon={Table2}
              title={`All inverters (${inverters.length})`}
              subtitle={`Click a row to open it above · stored history for ${day ?? "—"}, status & power now from live data`}
              bodyClassName="p-0"
            >
              <Table containerClassName="scroll-x-hint">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Inverter SN</TableHead>
                      <TableHead className="text-right">Rated (kW)</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Datalogger</TableHead>
                      <TableHead className="text-right">Strings</TableHead>
                      <TableHead className="text-right">kWp</TableHead>
                      <TableHead className="text-right">AC Now (kW)</TableHead>
                      <TableHead className="text-right">Peak DC (kW)</TableHead>
                      <TableHead className="text-right">Peak AC (kW)</TableHead>
                      <TableHead className="text-right">Yield (kWh)</TableHead>
                      <TableHead className="text-right">kWh/kWp</TableHead>
                      <TableHead className="text-right">Eff. (%)</TableHead>
                      <TableHead className="text-right" title="Peer-relative index, not IEC 61724 PR">
                        PR idx (%)
                      </TableHead>
                      <TableHead className="text-right">Avg / Max °C</TableHead>
                      <TableHead className="text-right">Freq (Hz)</TableHead>
                      <TableHead className="text-right">Lifetime (MWh)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inverters.map((i) => {
                      const active = i.device_sn === inv?.device_sn;
                      return (
                        <TableRow
                          key={i.device_sn}
                          onClick={() => {
                            setSelectedSn(i.device_sn);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                          className={`cursor-pointer ${active ? "bg-sky-500/10" : ""}`}
                        >
                          <TableCell>
                            <StatusBadge
                              status={i.status_label ?? LOADING_STATUS}
                              level={invLevel(i)}
                              loading={i.status_label == null}
                              dot
                            />
                          </TableCell>
                          <TableCell className={`font-bold ${active ? "text-sky-300" : "text-white"}`}>{i.alias || "—"}</TableCell>
                          <TableCell className={`num whitespace-nowrap ${active ? "text-sky-300" : "text-slate-300"}`}>{i.device_sn}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-slate-300">{fmt(i.nominal_power_kw, 0)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-xs text-slate-400">{i.model || "—"}</TableCell>
                          <TableCell className="num whitespace-nowrap text-xs text-slate-500">{i.datalogger_sn || "—"}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-sky-300">{i.string_count}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-slate-300">{fmt(i.capacity_kwp, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right font-semibold text-energy-300">{fmt(i.current_ac_kw, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-amber-300">{fmt(i.peak_dc_kw, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-energy-300">{fmt(i.peak_ac_kw, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right font-semibold text-solar-300">{fmt(i.yield_today_kwh, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-slate-200">{fmt(i.specific_yield, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-emerald-300">{fmt(i.efficiency_pct, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-slate-300">{fmt(i.pr_pct, 1)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-rose-300">
                            {fmt(i.avg_temp_c, 1)} / {fmt(i.max_temp_c, 1)}
                          </TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-slate-400">{fmt(i.avg_freq_hz, 2)}</TableCell>
                          <TableCell className="num whitespace-nowrap text-right text-slate-300">
                            {fmt(i.total_yield_kwh == null ? null : i.total_yield_kwh / 1000, 2)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
            </Panel>
        </section>
      )}
    </div>
  );
};
