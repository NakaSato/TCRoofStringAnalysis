import React, { Suspense } from "react";
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppContext } from "../context/AppContext";
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
/* PR ring gauge                                                              */
/* -------------------------------------------------------------------------- */
const RingGauge: React.FC<{ value: number; target: number; size?: number }> = ({ value, target, size = 176 }) => {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = 0.75; // 270° gauge
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const targetPct = Math.max(0, Math.min(100, target)) / 100;
  const ok = value >= target;
  const color = ok ? "#34d399" : value >= target - 5 ? "#fbbf24" : "#f87171";
  const targetAngle = 135 + targetPct * 270;
  const tx = size / 2 + r * Math.cos((targetAngle * Math.PI) / 180);
  const ty = size / 2 + r * Math.sin((targetAngle * Math.PI) / 180);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(135deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(148,163,184,0.12)"
          strokeWidth={stroke}
          strokeDasharray={`${c * arc} ${c}`}
          strokeLinecap="round"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${c * arc * pct} ${c}`}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${color}88)`, transition: "stroke-dasharray 1s ease" }}
        />
      </svg>
      <svg width={size} height={size} className="absolute inset-0">
        <circle cx={tx} cy={ty} r={4} fill="#0a101c" stroke="#e2e8f0" strokeWidth={2} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="eyebrow">Plant PR</div>
        <div className="num text-4xl font-bold tracking-tight text-white">
          {value.toFixed(1)}
          <span className="text-lg text-slate-500">%</span>
        </div>
        <div className={`num text-[11px] font-semibold ${ok ? "text-emerald-400" : "text-amber-400"}`}>
          {ok ? "▲" : "▼"} {(value - target).toFixed(1)} vs {target.toFixed(1)}%
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Power-flow pieces                                                          */
/* -------------------------------------------------------------------------- */
const FLOW_TONE = {
  solar: "border-solar-400/30 bg-solar-500/10 text-solar-400",
  ok: "border-emerald-400/30 bg-emerald-500/10 text-emerald-400",
  info: "border-cyan-400/30 bg-cyan-500/10 text-cyan-400",
} as const;

const FlowNode: React.FC<{
  icon: LucideIcon;
  tone: keyof typeof FLOW_TONE;
  label: string;
  value: React.ReactNode;
  unit: string;
}> = ({ icon: Icon, tone, label, value, unit }) => (
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
  </div>
);

const FlowArrow: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center justify-center gap-1.5">
    <ArrowDown className="h-3 w-3 animate-pulse text-energy-400" />
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <KpiTile
                  label={iecPr != null ? "Plant PR (IEC)" : "PR Index (peer)"}
                  icon={Gauge}
                  tone={shownPr == null ? "neutral" : shownPr >= targetPr ? "ok" : "warn"}
                  value={fmt(shownPr, 1)}
                  unit="%"
                  hint={
                    iecPr != null
                      ? `Target ${fmt(kpis?.target_pr_pct, 1)}% · IEC 61724-1, measured irradiance`
                      : `Strings vs. peers · not IEC (${selectedPlantOverview.weather?.iec_pr.reason ?? "no irradiance"})`
                  }
                />
                <KpiTile
                  label="PV Power"
                  icon={Sun}
                  tone="solar"
                  value={fmt(pvPowerKw, 1)}
                  unit="kW"
                  hint={
                    capacity > 0 && pvPowerKw != null
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
                      <p className="panel-subtitle mt-0.5">DC → inverters → AC</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`badge ${plantLevel === "ok" ? "badge-ok" : "badge-warn"} px-2.5 py-1 text-[11px] font-semibold`}>
                        <Led level={plantLevel} pulse />
                        {plantLevel === "ok" ? "ALL NORMAL" : `${critical} CRIT · ${warning} WARN`}
                      </span>
                      {selectedPlantOverview?.live && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold tracking-wider text-emerald-300"
                          title={`Live telemetry fetched ${new Date(selectedPlantOverview.live.fetched_at).toLocaleTimeString()}`}
                        >
                          <Radio className="h-2.5 w-2.5 animate-pulse text-emerald-400" />
                          LIVE
                        </span>
                      )}
                    </div>
                  </header>

                  <div className="flex flex-1 flex-col gap-3 p-4">
                    <div className="flex justify-center">
                      {shownPr != null ? (
                        <RingGauge value={shownPr} target={targetPr} size={120} />
                      ) : (
                        <div className="flex h-[120px] w-[120px] flex-col items-center justify-center rounded-full border border-white/[0.08]">
                          <div className="eyebrow">Plant PR</div>
                          <div className="num text-3xl font-bold text-slate-500">—</div>
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 space-y-3">
                      {/* DC → Inverters → AC */}
                      <div className="grid grid-cols-1 gap-1 rounded-xl border border-white/[0.08] bg-gradient-to-b from-ink-900 via-[#101a33] to-ink-900 p-2 shadow-inner">
                        <FlowNode icon={Sun} tone="solar" label="PV (DC)" value={fmt(pvPowerKw, 1)} unit="kW" />
                        <FlowArrow label="DC" />
                        <FlowNode
                          icon={Cpu}
                          tone="ok"
                          label="Inverters"
                          value={`${kpis?.online_inverters ?? "—"} / ${kpis?.inverter_count ?? "—"}`}
                          unit="online"
                        />
                        <FlowArrow label="AC" />
                        <FlowNode icon={UtilityPole} tone="info" label="Yield (AC)" value={fmt(kpis?.yield_today_kwh, 1)} unit="kWh" />
                      </div>

                      {/* secondary metrics */}
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat icon={Gauge} label="Peak today" value={fmt(kpis?.peak_power_kw, 1)} unit="kW" />
                        <MiniStat icon={Activity} label="Lifetime" value={fmt(kpis?.total_yield_kwh == null ? null : totalYieldKwh / 1000, 2)} unit="MWh" />
                        <MiniStat icon={Thermometer} label="Max temp" value={fmt(kpis?.max_temp_c, 1)} unit="°C" />
                        <MiniStat
                          icon={Leaf}
                          label="CO₂ avoided"
                          value={fmt(kpis?.yield_today_kwh == null ? null : co2TodayTonnes, 2)}
                          unit="t today"
                        />
                      </div>
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
