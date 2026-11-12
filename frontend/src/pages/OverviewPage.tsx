import React, { Suspense, useEffect, useState } from "react";
import {
  Zap,
  Gauge,
  HeartPulse,
  Coins,
  Leaf,
  Sun,
  Cpu,
  UtilityPole,
  Activity,
  Thermometer,
  ArrowDown,
  Building2,
  MapPin,
  Radio,
  Satellite,
  ExternalLink,
  CloudRain,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import type { GoogleWeatherDay } from "../api/client";
import { Panel, KpiTile, Led, EmptyState, LoadingState, fmt } from "../components/ui";
import { FleetPlantDirectoryPanel } from "../components/FleetPlantDirectoryPanel";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { OverviewTabSummaries } from "../components/OverviewTabSummaries";

// Leaflet (~40 KB gz) is fetched only when a plant map is shown.
const PlantSatelliteMap = React.lazy(() => import("../components/PlantSatelliteMap"));

/** Thailand grid emission factor (TGO), kg CO2e per kWh. */
const GRID_EF_KG_PER_KWH = 0.4999;

/* -------------------------------------------------------------------------- */
/* Power-flow pieces                                                          */
/* -------------------------------------------------------------------------- */
const FLOW_TONE = {
  solar: "border-solar-400/30 bg-solar-500/10 text-solar-400",
  ok: "border-emerald-400/30 bg-emerald-500/10 text-emerald-400",
  info: "border-cyan-400/30 bg-cyan-500/10 text-cyan-400",
  warn: "border-amber-400/30 bg-amber-500/10 text-amber-400",
  muted: "border-white/10 bg-white/[0.03] text-slate-500",
} as const;

const FlowNode: React.FC<{
  icon: LucideIcon;
  tone: keyof typeof FLOW_TONE;
  label: string;
  value: React.ReactNode;
  unit: string;
  sub?: React.ReactNode;
}> = ({ icon: Icon, tone, label, value, unit, sub }) => (
  <div className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-ink-950/70 p-2.5">
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${FLOW_TONE[tone]}`}>
      <Icon className="h-4.5 w-4.5" />
    </div>
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="num truncate text-base font-bold text-white">
        {value} <span className="text-xs font-normal text-slate-400">{unit}</span>
      </div>
    </div>
    {sub != null && <div className="num ml-auto shrink-0 text-right text-[11px] text-slate-400">{sub}</div>}
  </div>
);

const FlowArrow: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <div className="flex items-center justify-center gap-1.5">
    <ArrowDown className={`h-3 w-3 ${active ? "animate-pulse text-energy-400" : "text-slate-600"}`} />
    <span className="font-mono text-[10px] uppercase text-slate-500">{label}</span>
  </div>
);

const MiniStat: React.FC<{ icon: LucideIcon; label: string; value: React.ReactNode; unit: string }> = ({
  icon: Icon,
  label,
  value,
  unit,
}) => (
  <div className="rounded-lg border border-white/[0.05] bg-ink-950/50 p-2.5">
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
      <Icon className="h-3 w-3 text-slate-500" />
      {label}
    </div>
    <div className="num mt-1 text-sm font-bold text-white">
      {value} <span className="text-[11px] font-normal text-slate-400">{unit}</span>
    </div>
  </div>
);

/* -------------------------------------------------------------------------- */
/* Rain at 09 / 12 / 17 (Google Weather, modelled; stored hours only)          */
/* -------------------------------------------------------------------------- */
/** PR on a 0–100 % track with a tick at the target; no tick when the target is unknown. */
const PrTargetBar: React.FC<{ pr: number | null; target: number | null; note: string | null }> = ({ pr, target, note }) => {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const met = pr != null && target != null && pr >= target;
  const gap = pr != null && target != null ? pr - target : null;
  return (
    <div className="mt-1 space-y-1.5">
      <div className="relative h-1.5 w-full rounded-full bg-white/[0.06]">
        {pr != null && (
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              target == null ? "bg-sky-400" : met ? "bg-emerald-400" : "bg-amber-400"
            }`}
            style={{ width: `${clamp(pr)}%` }}
          />
        )}
        {target != null && (
          <div
            className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-white/80"
            style={{ left: `${clamp(target)}%` }}
            title={`Target ${fmt(target, 1)}%`}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-500">
        <span>Target {target == null ? "—" : `${fmt(target, 1)}%`}</span>
        {gap != null && (
          <span className={met ? "text-emerald-400" : "text-amber-400"}>
            {gap >= 0 ? "+" : ""}
            {fmt(gap, 1)} pts
          </span>
        )}
      </div>
      {note && <div className="text-[10px] text-slate-600">{note}</div>}
    </div>
  );
};

const RAIN_SLOTS = ["09", "12", "17"] as const;

const WeatherSlotsTile: React.FC<{ plantId: number; day: string | null }> = ({ plantId, day }) => {
  const [wx, setWx] = useState<GoogleWeatherDay | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWx(null);
    setFailed(false);
    api
      .getGoogleWeatherDay(plantId, day ?? undefined)
      .then((r) => !cancelled && setWx(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [plantId, day]);

  const anyRain = wx ? RAIN_SLOTS.some((h) => wx.slots[h]?.raining) : false;
  const tone = anyRain ? "text-sky-400" : "text-emerald-400";
  const note = failed
    ? "unavailable"
    : !wx
    ? "loading…"
    : !wx.configured
    ? "not configured"
    : !wx.has_location
    ? "no location"
    : wx.rain.days_since_rain != null
    ? `${wx.rain.days_since_rain} d since rain`
    : "modelled";

  return (
    <div className="panel overflow-hidden p-4" title="Google Weather (modelled) — daytime rain status at 09:00, 12:00 and 17:00">
      <div className={`absolute inset-x-0 top-0 h-px ${anyRain ? "bg-sky-400/60" : "bg-emerald-400/60"}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="eyebrow">Weather 09·12·17</div>
        <div className={`rounded-lg p-1.5 ring-1 ${anyRain ? "bg-sky-500/10 ring-sky-400/20" : "bg-emerald-500/10 ring-emerald-400/20"} ${tone}`}>
          <CloudRain className="h-3.5 w-3.5" />
        </div>
      </div>
      <div className="mt-2 space-y-1">
        {RAIN_SLOTS.map((h) => {
          const slot = wx?.slots[h] ?? null;
          const cls = slot?.raining == null ? "text-slate-500" : slot.raining ? "text-sky-300" : "text-emerald-300";
          return (
            <div
              key={h}
              className="flex items-baseline gap-1.5 whitespace-nowrap text-[11px]"
              title={slot?.condition ?? "not stored yet"}
            >
              <span className="num text-slate-500">{h}:00</span>
              <span className={`font-semibold ${cls}`}>{slot?.status_th ?? "—"}</span>
              <span className="num ml-auto truncate text-[10px] text-slate-400">
                {slot ? `${fmt(slot.precip_mm, 1)} mm · ☁ ${fmt(slot.cloud_cover_pct, 0)}%` : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 text-[11px] font-medium text-slate-500">{note}</div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Overview page                                                              */
/* -------------------------------------------------------------------------- */
export const OverviewPage: React.FC = () => {
  const {
    selectedPlantOverview,
    plantOverviewLoading,
    dashboardMode,
    setDashboardMode,
    growattPlants,
  } = useAppContext();

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;

  const capacity = Number(kpis?.capacity_kwp || 0);
  const yieldTodayKwh = Number(kpis?.yield_today_kwh || 0);
  const totalYieldKwh = Number(kpis?.total_yield_kwh || 0);
  const targetPr = Number(kpis?.target_pr_pct || 85.0);
  // Measured IEC 61724-1 PR when the plant's weather sensor allows it; else the peer-relative index.
  const iecPr = kpis?.iec_pr_pct ?? null;
  const shownPr = iecPr ?? kpis?.plant_pr_pct ?? null;
  const tariff = Number(kpis?.tariff_thb_per_kwh || 4.2);
  const revenueToday = yieldTodayKwh * tariff;
  const co2TodayTonnes = (yieldTodayKwh * GRID_EF_KG_PER_KWH) / 1000;
  const warning = Number(kpis?.warning_strings || 0);
  const critical = Number(kpis?.critical_strings || 0);
  const plantLevel = critical > 0 ? "warn" : warning > 0 ? "warn" : "ok";

  // PV power: live inverter sum when available (AppContext overlay), else last synced value.
  // No grid / load meter data exists, so import & consumption are not shown.
  const pvPowerKw = kpis?.current_power_kw ?? null;

  // Realtime Generation panel: DC input and AC output of the newest record. Live overlay when
  // present (today only), else the last stored 5-min point of the day (DB).
  const live = selectedPlantOverview?.live ?? null;
  const series = selectedPlantOverview?.timeseries ?? [];
  const lastStored = series.length ? series[series.length - 1] : null;
  const acNowKw = pvPowerKw;
  const dcNowKw = live ? live.dc_kw ?? null : lastStored?.ppv_kw ?? null;
  const dataAt = live?.data_at ?? lastStored?.timestamp ?? null;
  const dataAtLabel = dataAt ? dataAt.slice(11, 16) : null;
  const convEffPct = acNowKw != null && dcNowKw != null && dcNowKw > 0.5 ? Math.min(100, (acNowKw / dcNowKw) * 100) : null;
  const onlineInv = kpis?.online_inverters ?? null;
  const invCount = kpis?.inverter_count ?? null;
  const invTone: keyof typeof FLOW_TONE = onlineInv == null || invCount == null ? "muted" : onlineInv >= invCount ? "ok" : "warn";
  const producing = acNowKw != null && acNowKw > 0;

  return (
    <div className="space-y-6">
      {/* ==================================================================== */}
      {/* MODE A: FLEET PLANT DIRECTORY (Default; clicking any plant switches) */}
      {/* ==================================================================== */}
      {dashboardMode === "directory" && (
        <FleetPlantDirectoryPanel
          onSwitchViewMode={(m) => {
            if (m === "overview") setDashboardMode("plant");
            else setDashboardMode("directory");
          }}
        />
      )}

      {/* ==================================================================== */}
      {/* MODE B: 1. SELECTED PLANT OVERVIEW (Only the selected plant)         */}
      {/* ==================================================================== */}
      {dashboardMode === "plant" && (
        <div className="space-y-6">
          <SelectedPlantBanner />

          {plantOverviewLoading && !selectedPlantOverview ? (
            <LoadingState label="Loading selected plant inverters, strings & 5-minute telemetry…" />
          ) : !selectedPlantOverview ? (
            <EmptyState
              icon={Building2}
              title="Select a plant from the directory"
              description="Click any plant in the Plant Directory to load its real-time overview."
            />
          ) : (
            <>
              {/* Row 1: KPI strip */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
                <KpiTile
                  label={iecPr != null ? "Plant PR (IEC)" : "PR Index (peer)"}
                  icon={Gauge}
                  tone={shownPr == null ? "neutral" : shownPr >= targetPr ? "ok" : "warn"}
                  value={fmt(shownPr, 1)}
                  unit="%"
                  hint={
                    <PrTargetBar
                      pr={shownPr}
                      target={kpis?.target_pr_pct ?? null}
                      note={iecPr != null ? "IEC 61724-1, measured irradiance" : null}
                    />
                  }
                />
                <KpiTile
                  label="PV Power"
                  icon={Sun}
                  tone="solar"
                  value={fmt(pvPowerKw, 1)}
                  unit="kW"
                  hint={
                    plant?.reported_peak_power_kwp != null && kpis?.capacity_kwp == null
                      ? `Capacity unknown: Growatt lists ${fmt(plant.reported_peak_power_kwp, 0)} kWp, impossible for its inverters`
                      : capacity > 0 && pvPowerKw != null
                      ? `${((pvPowerKw / capacity) * 100).toFixed(0)}% of ${fmt(capacity, 1)} kWp`
                      : `${fmt(kpis?.capacity_kwp, 1)} kWp installed`
                  }
                />
                <KpiTile
                  label="Yield Today"
                  icon={Zap}
                  tone="energy"
                  value={fmt(kpis?.yield_today_kwh, 1)}
                  unit="kWh"
                  hint={`${fmt(kpis?.specific_yield_kwh_per_kwp, 2)} kWh/kWp`}
                />
                <KpiTile
                  label="Revenue Today"
                  icon={Coins}
                  value={kpis?.yield_today_kwh == null ? "—" : `฿${fmt(revenueToday, 0)}`}
                  hint={`Tariff ฿${fmt(kpis?.tariff_thb_per_kwh, 2)}/kWh`}
                />
                <KpiTile
                  label="Inverters Online"
                  icon={Cpu}
                  tone="ok"
                  value={`${kpis?.online_inverters ?? "—"} / ${kpis?.inverter_count ?? "—"}`}
                  hint={`Avg temp ${fmt(kpis?.avg_temp_c, 1)}°C`}
                />
                <KpiTile
                  label="String Health"
                  icon={HeartPulse}
                  tone={critical > 0 ? "crit" : warning > 0 ? "warn" : "ok"}
                  value={fmt(kpis?.avg_health_score, 1)}
                  unit="/ 100"
                  hint={`${critical} critical · ${warning} warning`}
                  hintTone={critical > 0 ? "crit" : warning > 0 ? "warn" : "neutral"}
                />
                {plant && <WeatherSlotsTile plantId={plant.plant_id} day={selectedPlantOverview.meta.day ?? null} />}
              </div>

              {/* Row 2: compact realtime generation (1/4) | site map (3/4 of the width, 56 % of the window height) */}
              <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-4">
              <section className="panel flex flex-col overflow-hidden">
                  <header className="panel-header flex-wrap gap-2">
                    <div className="min-w-0">
                      <h2 className="panel-title">
                        <Activity className="h-4 w-4 text-solar-400" />
                        <span className="truncate">Realtime Generation</span>
                      </h2>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`badge ${plantLevel === "ok" ? "badge-ok" : "badge-warn"} px-2.5 py-1 text-[11px] font-semibold`}>
                        <Led level={plantLevel} pulse />
                        {plantLevel === "ok" ? "ALL NORMAL" : `${critical} CRIT · ${warning} WARN`}
                      </span>
                      {live ? (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold tracking-wider ${
                            live.stale
                              ? "border-amber-400/30 bg-amber-500/10 text-amber-300"
                              : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                          }`}
                          title={`Live telemetry fetched ${new Date(live.fetched_at).toLocaleTimeString()}${
                            live.stale ? " — Growatt refused the last call, showing the previous value" : ""
                          }`}
                        >
                          <Radio className={`h-2.5 w-2.5 ${live.stale ? "text-amber-400" : "animate-pulse text-emerald-400"}`} />
                          {live.stale ? "STALE" : "LIVE"}
                          {dataAtLabel && <span className="num font-medium opacity-80">{dataAtLabel}</span>}
                        </span>
                      ) : (
                        dataAtLabel && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] font-semibold text-slate-400"
                            title="Last stored 5-minute record (the worker syncs every 30 min)"
                          >
                            DB <span className="num">{dataAtLabel}</span>
                          </span>
                        )
                      )}
                    </div>
                  </header>

                  <div className="flex flex-1 flex-col gap-3 p-4">
                    {/* DC → Inverters → AC */}
                    <div className="grid grid-cols-1 gap-1 rounded-xl border border-white/[0.08] bg-gradient-to-b from-ink-900 via-[#101a33] to-ink-900 p-2 shadow-inner">
                      <FlowNode icon={Sun} tone={dcNowKw == null ? "muted" : "solar"} label="PV input (DC)" value={fmt(dcNowKw, 1)} unit="kW" />
                      <FlowArrow label="DC" active={producing} />
                      <FlowNode
                        icon={Cpu}
                        tone={invTone}
                        label="Inverters"
                        value={`${onlineInv ?? "—"} / ${invCount ?? "—"}`}
                        unit="online"
                        sub={convEffPct != null ? <span title="AC output ÷ DC input of the newest record">η {convEffPct.toFixed(1)}%</span> : undefined}
                      />
                      <FlowArrow label="AC" active={producing} />
                      <FlowNode
                        icon={UtilityPole}
                        tone={acNowKw == null ? "muted" : "info"}
                        label="Output (AC)"
                        value={fmt(acNowKw, 1)}
                        unit="kW"
                        sub={
                          <>
                            {fmt(kpis?.yield_today_kwh, 1)} kWh
                            <br />
                            <span className="text-slate-500">today</span>
                          </>
                        }
                      />
                    </div>

                    {/* secondary metrics */}
                    <div className="grid grid-cols-2 gap-2">
                      <MiniStat icon={Gauge} label="Peak today" value={fmt(kpis?.peak_power_kw, 1)} unit="kW" />
                      <MiniStat icon={Zap} label="Specific yield" value={fmt(kpis?.specific_yield_kwh_per_kwp, 2)} unit="kWh/kWp" />
                      <MiniStat icon={Activity} label="Lifetime" value={fmt(kpis?.total_yield_kwh == null ? null : totalYieldKwh / 1000, 2)} unit="MWh" />
                      <MiniStat icon={Thermometer} label="Max temp" value={fmt(kpis?.max_temp_c, 1)} unit="°C" />
                      <MiniStat
                        icon={Leaf}
                        label="CO₂ avoided"
                        value={fmt(kpis?.yield_today_kwh == null ? null : co2TodayTonnes, 2)}
                        unit="t today"
                      />
                      <MiniStat icon={Coins} label="Revenue" value={kpis?.yield_today_kwh == null ? "—" : `฿${fmt(revenueToday, 0)}`} unit="today" />
                    </div>
                  </div>
                </section>

                <Panel
                  className="xl:col-span-3"
                  icon={Satellite}
                  title="Site"
                  bodyClassName=""
                  actions={
                    plant?.latitude != null && plant?.longitude != null ? (
                      <a
                        className="btn-ghost btn-sm"
                        href={`https://www.google.com/maps?q=${plant.latitude},${plant.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open in Google Maps"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Maps
                      </a>
                    ) : undefined
                  }
                >
                  {plant?.latitude != null && plant?.longitude != null ? (
                    <Suspense fallback={<div className="flex h-[56vh] min-h-[240px] items-center justify-center text-xs text-slate-500">Loading map…</div>}>
                      <PlantSatelliteMap
                        lat={plant.latitude}
                        lon={plant.longitude}
                        name={plant.name}
                        capacityKwp={plant.peak_power_kwp}
                        heightClass="h-[56vh] min-h-[240px]"
                      />
                    </Suspense>
                  ) : (
                    <div className="flex h-60 items-center justify-center">
                      <EmptyState
                        icon={MapPin}
                        title="Location not set"
                        description="Growatt has no usable coordinates for this plant."
                      />
                    </div>
                  )}

                </Panel>
              </div>

              {/* High-level view of tabs 2–4, each linking to its tab */}
              {selectedPlantOverview && <OverviewTabSummaries overview={selectedPlantOverview} />}

              {/* Fault log reported by Growatt (string diagnostics are on String Diagnostics) */}
              {plant && (
                <GrowattAlarmLogPanel
                  plantId={plant.plant_id}
                  plantName={plant.name}
                  day={selectedPlantOverview?.meta.day ?? null}
                />
              )}

            </>
          )}
        </div>
      )}
    </div>
  );
};
