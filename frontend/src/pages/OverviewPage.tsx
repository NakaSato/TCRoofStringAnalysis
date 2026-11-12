import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Zap,
  Gauge,
  HeartPulse,
  Coins,
  Leaf,
  Sun,
  Cpu,
  UtilityPole,
  Bell,
  Grid3x3,
  Activity,
  Thermometer,
  ArrowRight,
  CheckCircle2,
  Building2,
  Eye,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { PlotlyChart } from "../components/PlotlyChart";
import { Panel, KpiTile, StatusBadge, Led, Meter, EmptyState, LoadingState, statusLevel, fmt } from "../components/ui";
import { FleetPlantDirectoryPanel } from "../components/FleetPlantDirectoryPanel";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";

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
/* Overview page                                                              */
/* -------------------------------------------------------------------------- */
export const OverviewPage: React.FC = () => {
  const {
    selectedPlantOverview,
    plantOverviewLoading,
    dashboardMode,
    setDashboardMode,
    setInspectedStringId,
    growattPlants,
  } = useAppContext();

  const [selectedInverterSn, setSelectedInverterSn] = useState<string>("ALL");

  // Build 5-minute Plotly figure from selectedPlantOverview.timeseries
  const powerCurveFig = useMemo(() => {
    const ts = selectedPlantOverview?.timeseries || [];
    if (ts.length === 0) return null;
    const x = ts.map((r) => r.timestamp);
    return {
      data: [
        {
          x,
          y: ts.map((r) => r.expected_kw),
          name: "Expected Reference (kW)",
          type: "scatter",
          mode: "lines",
          line: { color: "#64748b", width: 1.5, dash: "dot" },
        },
        {
          x,
          y: ts.map((r) => r.ppv_kw),
          name: "DC Input Power (kW)",
          type: "scatter",
          mode: "lines",
          line: { color: "#f59e0b", width: 2 },
        },
        {
          x,
          y: ts.map((r) => r.pac_kw),
          name: "AC Grid Power (kW)",
          type: "scatter",
          mode: "lines",
          fill: "tozeroy",
          fillcolor: "rgba(34, 211, 238, 0.10)",
          line: { color: "#22d3ee", width: 2.2 },
        },
        {
          x,
          y: ts.map((r) => r.temp_c),
          name: "Inverter Temp (°C)",
          type: "scatter",
          mode: "lines",
          yaxis: "y2",
          line: { color: "#f43f5e", width: 1.5 },
        },
      ],
      layout: {
        margin: { l: 50, r: 50, t: 24, b: 40 },
        xaxis: { title: "Timestamp (5-Min Intervals)" },
        yaxis: { title: "Power (kW)", rangemode: "tozero" },
        yaxis2: {
          title: "Temp (°C)",
          overlaying: "y",
          side: "right",
          showgrid: false,
          range: [20, 80],
        },
        legend: { orientation: "h", y: 1.12, x: 0 },
      },
    };
  }, [selectedPlantOverview]);

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;
  const inverters = selectedPlantOverview?.inverters || [];
  const strings = selectedPlantOverview?.strings || [];
  const anomalies = selectedPlantOverview?.anomalies || [];

  const filteredStrings = useMemo(() => {
    if (selectedInverterSn === "ALL") return strings;
    return strings.filter((s) => s.device_sn === selectedInverterSn);
  }, [strings, selectedInverterSn]);

  const capacity = Number(kpis?.capacity_kwp || 0);
  const currentKw = Number(kpis?.current_power_kw || 0);
  const peakKw = Number(kpis?.peak_power_kw || 0);
  const yieldTodayKwh = Number(kpis?.yield_today_kwh || 0);
  const totalYieldKwh = Number(kpis?.total_yield_kwh || 0);
  const specificYield = Number(kpis?.specific_yield_kwh_per_kwp || 0);
  const plantPr = Number(kpis?.plant_pr_pct || 85.0);
  const targetPr = Number(kpis?.target_pr_pct || 85.0);
  const tariff = Number(kpis?.tariff_thb_per_kwh || 4.2);
  const revenueToday = yieldTodayKwh * tariff;
  const co2TodayTonnes = (yieldTodayKwh * GRID_EF_KG_PER_KWH) / 1000;
  const healthy = Number(kpis?.healthy_strings || 0);
  const warning = Number(kpis?.warning_strings || 0);
  const critical = Number(kpis?.critical_strings || 0);
  const totalStrings = Number(kpis?.string_count || strings.length || 0);
  const availability = totalStrings > 0 ? ((totalStrings - critical) / totalStrings) * 100 : 100;
  const plantLevel = critical > 0 ? "warn" : warning > 0 ? "warn" : "ok";

  // PV power: live inverter sum when available (AppContext overlay), else last synced value.
  // No grid / load meter data exists, so import & consumption are not shown.
  const pvPowerKw = kpis?.current_power_kw ?? null;

  return (
    <div className="space-y-6">
      {/* Top Mode Switcher Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="tabs">
          <button
            onClick={() => setDashboardMode("directory")}
            className={`tab ${dashboardMode === "directory" ? "tab-active" : ""}`}
          >
            <Building2 className="h-3.5 w-3.5" />
            Plant Directory ({growattPlants.length || 43} Plants)
          </button>
          <button
            onClick={() => setDashboardMode("plant")}
            className={`tab ${dashboardMode === "plant" ? "tab-active" : ""}`}
          >
            <Eye className="h-3.5 w-3.5" />
            1. Selected Plant Overview ({plant?.name ? plant.name.slice(0, 28) : "Active Plant"})
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/generation" className="btn btn-sm">
            2. Performance Ratio
          </Link>
          <Link to="/strings" className="btn btn-sm">
            3. String Diagnostics & I-V
          </Link>
          <Link to="/reports" className="btn btn-sm">
            Export Report
          </Link>
        </div>
      </div>

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
              {/* Hero: Selected Plant PR Gauge + Energy Flow + String Health */}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
                <section className="panel overflow-hidden xl:col-span-8">
                  <div className="relative grid grid-cols-1 items-center gap-6 p-6 md:grid-cols-[auto_1fr]">
                    <div className="flex justify-center">
                      <RingGauge value={plantPr} target={targetPr} />
                    </div>
                    <div className="space-y-6">
                      <div className="flex flex-wrap items-center gap-3">
                        <span
                          className={`badge ${
                            plantLevel === "ok" ? "badge-ok" : "badge-warn"
                          } px-2.5 py-1 text-[11px]`}
                        >
                          <Led level={plantLevel} pulse />
                          {plantLevel === "ok"
                            ? "ALL INVERTERS & STRINGS NORMAL"
                            : `${critical} CRITICAL · ${warning} WARNING STRINGS`}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Plant <span className="font-semibold text-white">{plant?.name}</span> ·{" "}
                          <span className="num text-slate-300">#{plant?.plant_id}</span>
                        </span>
                      </div>

                      {/* Redesigned Realtime Status Flow (4-Node SCADA Topology) */}
                      <div className="relative overflow-hidden rounded-xl border border-sky-400/20 bg-[#161f44] p-3.5 shadow-inner">
                        {/* Top Node: Solar PV Module */}
                        <div className="flex flex-col items-center">
                          <div className="mb-1 text-xs font-medium text-[#9bb0db]">
                            PV Power:&nbsp;&nbsp;
                            <span className="font-bold text-white tracking-tight">{fmt(pvPowerKw, 1)}kW</span>
                          </div>
                          <div className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-[#1e254e] shadow-[0_6px_16px_rgba(10,14,35,0.6)]">
                            <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full bg-gradient-to-b from-[#343e70] to-[#1f264c] shadow-inner">
                              <svg viewBox="0 0 64 64" className="h-7 w-7 sm:h-8 sm:w-8 drop-shadow">
                                <defs>
                                  <linearGradient id="scadaSolarFrame" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#94a3b8" />
                                    <stop offset="100%" stopColor="#475569" />
                                  </linearGradient>
                                  <linearGradient id="scadaSolarWafer" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#38bdf8" />
                                    <stop offset="100%" stopColor="#1d4ed8" />
                                  </linearGradient>
                                </defs>
                                <polygon points="6,44 18,18 46,18 58,44" fill="url(#scadaSolarFrame)" stroke="#cbd5e1" strokeWidth="1.2" strokeLinejoin="round" />
                                <polygon points="19.5,20 25.5,20 24,30 17,30" fill="url(#scadaSolarWafer)" />
                                <polygon points="26.5,20 32.5,20 32,30 25,30" fill="url(#scadaSolarWafer)" />
                                <polygon points="33.5,20 39.5,20 40,30 33,30" fill="url(#scadaSolarWafer)" />
                                <polygon points="40.5,20 44.5,20 47,30 41,30" fill="url(#scadaSolarWafer)" />
                                <polygon points="16,32 23.5,32 21.5,42 13,42" fill="url(#scadaSolarWafer)" />
                                <polygon points="24.5,32 31.5,32 30.5,42 22.5,42" fill="url(#scadaSolarWafer)" />
                                <polygon points="32.5,32 39.5,32 39.5,42 31.5,42" fill="url(#scadaSolarWafer)" />
                                <polygon points="40.5,32 48,32 51,42 40.5,42" fill="url(#scadaSolarWafer)" />
                                <polygon points="20,20 44,20 36,42 14,42" fill="#ffffff" fillOpacity="0.10" />
                              </svg>
                            </div>
                          </div>
                          {/* Down Triangle Arrow */}
                          <div className="my-1.5 flex items-center justify-center">
                            <svg className="h-2 w-3 drop-shadow animate-pulse" viewBox="0 0 16 10">
                              <polygon points="0,0 16,0 8,10" fill="#ffffff" />
                            </svg>
                          </div>
                        </div>

                        {/* Bottom: Inverters (no grid / load meter data available) */}
                        <div className="flex items-center justify-center gap-1 sm:gap-2">
                          {/* Inverter Node */}
                          <div className="flex flex-1 flex-col items-center text-center">
                            <div className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-[#1e254e] shadow-[0_6px_16px_rgba(10,14,35,0.6)]">
                              <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full bg-gradient-to-b from-[#343e70] to-[#1f264c] shadow-inner">
                                <div className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-xl bg-gradient-to-b from-white via-[#f8fafc] to-[#e2e8f0] shadow-md">
                                  <div className="flex h-4 w-4 sm:h-4.5 sm:w-4.5 items-center justify-center rounded-md bg-[#0f172a] shadow-inner">
                                    <svg className="h-3 w-3 text-[#10b981]" viewBox="0 0 24 24" fill="currentColor">
                                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5c0 .28-.22.5-.5.5s-.5-.22-.5-.5V14c-2.21 0-4-1.79-4-4 0-1.66 1.34-3 3-3 .28 0 .5.22.5.5s-.22.5-.5.5c-1.1 0-2 .9-2 2 0 1.66 1.34 3 3 3v-2.5c0-.28.22-.5.5-.5s.5.22.5.5v5.5zm2.5-4c-.28 0-.5-.22-.5-.5 0-1.66-1.34-3-3-3-.28 0-.5-.22-.5-.5s.22-.5.5-.5c2.21 0 4 1.79 4 4 0 .28-.22.5-.5.5z" />
                                    </svg>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="mt-1.5 text-[11px] sm:text-xs font-medium text-slate-400 whitespace-nowrap">
                              Inverters online:&nbsp;
                              <span className="font-bold text-white">
                                {kpis?.online_inverters ?? "—"}/{kpis?.inverter_count ?? "—"}
                              </span>
                            </div>
                          </div>

                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <Panel
                  className="xl:col-span-4"
                  icon={HeartPulse}
                  title="Plant String Health"
                  subtitle={`Status across ${totalStrings} wired strings (${inverters.length} inverters)`}
                >
                  <div className="space-y-4">
                    <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.05]">
                      {totalStrings > 0 && (
                        <>
                          <div
                            style={{ width: `${(healthy / totalStrings) * 100}%` }}
                            className="bg-emerald-400"
                          />
                          <div
                            style={{ width: `${(warning / totalStrings) * 100}%` }}
                            className="bg-amber-400"
                          />
                          <div
                            style={{ width: `${(critical / totalStrings) * 100}%` }}
                            className="bg-red-500"
                          />
                        </>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-lg border border-white/[0.05] bg-ink-850 p-2.5">
                        <div className="flex items-center justify-center gap-1.5 text-[10px] text-emerald-400">
                          <Led level="ok" /> Healthy
                        </div>
                        <div className="num mt-1 text-xl font-bold text-white">{healthy}</div>
                      </div>
                      <div className="rounded-lg border border-white/[0.05] bg-ink-850 p-2.5">
                        <div className="flex items-center justify-center gap-1.5 text-[10px] text-amber-400">
                          <Led level="warn" /> Warning
                        </div>
                        <div className="num mt-1 text-xl font-bold text-white">{warning}</div>
                      </div>
                      <div className="rounded-lg border border-white/[0.05] bg-ink-850 p-2.5">
                        <div className="flex items-center justify-center gap-1.5 text-[10px] text-red-400">
                          <Led level="crit" /> Critical
                        </div>
                        <div className="num mt-1 text-xl font-bold text-white">{critical}</div>
                      </div>
                    </div>
                    <div className="space-y-2 pt-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Average health score</span>
                        <span className="num font-semibold text-white">
                          {fmt(kpis?.avg_health_score, 1)} / 100
                        </span>
                      </div>
                      <Meter
                        value={Number(kpis?.avg_health_score || 0)}
                        tone={
                          Number(kpis?.avg_health_score || 0) >= 85
                            ? "ok"
                            : Number(kpis?.avg_health_score || 0) >= 70
                            ? "warn"
                            : "crit"
                        }
                      />
                      <div className="flex justify-between pt-1">
                        <span className="text-slate-400">String availability</span>
                        <span className="num font-semibold text-emerald-400">
                          {availability.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                </Panel>
              </div>

              {/* 6 Selected-Plant KPI Strip */}
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
                <KpiTile
                  label="Yield Today"
                  value={fmt(yieldTodayKwh, 1)}
                  unit="kWh"
                  icon={Zap}
                  tone="solar"
                  hint={`Specific: ${fmt(specificYield, 2)} kWh/kWp`}
                  hintTone="ok"
                />
                <KpiTile
                  label="Current / Peak Power"
                  value={fmt(currentKw > 0 ? currentKw : peakKw, 1)}
                  unit="kW"
                  icon={Gauge}
                  tone="energy"
                  hint={`Peak ${fmt(peakKw, 1)} kW (${capacity > 0 ? ((peakKw / capacity) * 100).toFixed(0) : 0}% cap)`}
                />
                <KpiTile
                  label="Lifetime Yield"
                  value={fmt(totalYieldKwh / 1000, 2)}
                  unit="MWh"
                  icon={Activity}
                  tone="info"
                  hint={`${fmt(totalYieldKwh, 0)} kWh total`}
                />
                <KpiTile
                  label="Inverter Temp & Grid"
                  value={fmt(kpis?.avg_temp_c, 1)}
                  unit="°C"
                  icon={Thermometer}
                  tone={Number(kpis?.max_temp_c || 0) > 65 ? "warn" : "ok"}
                  hint={`Max ${fmt(kpis?.max_temp_c, 1)}°C · ${fmt(kpis?.avg_freq_hz, 2)} Hz`}
                />
                <KpiTile
                  label="Revenue Today"
                  value={`฿${fmt(revenueToday, 0)}`}
                  icon={Coins}
                  tone="ok"
                  hint={`Tariff ฿${tariff.toFixed(2)}/kWh`}
                />
                <KpiTile
                  label="CO₂ Avoided Today"
                  value={co2TodayTonnes.toFixed(2)}
                  unit="tCO₂e"
                  icon={Leaf}
                  tone="ok"
                  hint={`TGO EF ${GRID_EF_KG_PER_KWH} kg/kWh`}
                />
              </div>

              {/* 5-Minute Power & Thermal Profile + Active Alarms */}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
                <Panel
                  className="xl:col-span-8"
                  icon={Activity}
                  title="5-Minute Plant Generation & Thermal Profile"
                  subtitle={`AC power, DC input power, modelled clear-sky reference & inverter temperature for ${plant?.name}`}
                  actions={
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to="/generation" className="btn-ghost btn-sm">
                        PR Details <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  }
                >
                  <PlotlyChart
                    figure={powerCurveFig}
                    height={330}
                    bare
                  />
                </Panel>

                <Panel
                  className="xl:col-span-4"
                  icon={Bell}
                  title="Plant String Faults & Alarms"
                  subtitle={`${anomalies.length} anomalies detected on ${plant?.name}`}
                  bodyClassName="p-0"
                  actions={
                    <Link to="/strings" className="btn-ghost btn-sm">
                      3. String I-V Curves <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  }
                >
                  {anomalies.length === 0 ? (
                    <EmptyState
                      icon={CheckCircle2}
                      title="No active string faults"
                      description="All strings on this plant are operating within peer tolerance."
                    />
                  ) : (
                    <ul className="max-h-[340px] divide-y divide-white/[0.05] overflow-y-auto">
                      {anomalies.slice(0, 15).map((a, i) => {
                        const lvl = statusLevel(a.severity);
                        return (
                          <li
                            key={i}
                            onClick={() => setInspectedStringId(a.string_id)}
                            className="flex cursor-pointer items-start gap-3 px-4 py-3 transition hover:bg-white/[0.03]"
                          >
                            <Led level={lvl} pulse={lvl === "crit"} className="mt-1.5" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="num text-xs font-bold text-white hover:text-sky-300">
                                  {a.string_id}
                                </span>
                                <StatusBadge status={a.severity} dot={false} />
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-400">
                                {a.description}
                              </p>
                              <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500">
                                <span className="num text-solar-300">PR {fmt(a.pr_pct, 1)}%</span>
                                <span>·</span>
                                <span className="num">Loss {fmt(a.energy_loss_kwh, 2)} kWh</span>
                                <span className="ml-auto text-sky-400">Inspect I-V →</span>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Panel>
              </div>

              {/* Plant Inverters Table / Topology */}
              <Panel
                icon={Cpu}
                title={`Monitored Growatt MAX Inverters (${inverters.length})`}
                subtitle={`Click any inverter serial to filter the String Matrix below, or click '3. String Diagnostics' for full I-V / P-V analysis`}
                bodyClassName="p-0"
                actions={
                  selectedInverterSn !== "ALL" ? (
                    <button
                      onClick={() => setSelectedInverterSn("ALL")}
                      className="btn-ghost btn-sm text-sky-400"
                    >
                      Show All Inverters ({inverters.length})
                    </button>
                  ) : null
                }
              >
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Inverter SN</th>
                        <th>Model</th>
                        <th>Datalogger</th>
                        <th className="text-right">Strings</th>
                        <th className="text-right">Current AC (kW)</th>
                        <th className="text-right">Peak AC (kW)</th>
                        <th className="text-right">Efficiency (%)</th>
                        <th className="text-right">PR (%)</th>
                        <th className="text-right">Temp Avg/Max (°C)</th>
                        <th className="text-right">Grid Freq (Hz)</th>
                        <th className="text-right">Yield Today (kWh)</th>
                        <th className="text-right">Total Yield (MWh)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inverters.map((inv) => {
                        const isSelected = selectedInverterSn === inv.device_sn;
                        const lvl = inv.lost || inv.status === 0 ? "crit" : inv.status === 1 ? "ok" : "warn";
                        return (
                          <tr
                            key={inv.device_sn}
                            onClick={() =>
                              setSelectedInverterSn(
                                selectedInverterSn === inv.device_sn ? "ALL" : inv.device_sn
                              )
                            }
                            className={`cursor-pointer transition ${
                              isSelected ? "bg-sky-500/10" : "hover:bg-white/[0.03]"
                            }`}
                          >
                            <td>
                              <StatusBadge status={inv.status_label} level={lvl} dot />
                            </td>
                            <td className="num font-bold text-white hover:text-sky-300">
                              {inv.device_sn}
                            </td>
                            <td className="num text-xs text-slate-400">{inv.model}</td>
                            <td className="num text-xs text-slate-500">{inv.datalogger_sn}</td>
                            <td className="num text-right font-semibold text-sky-300">
                              {inv.string_count}
                            </td>
                            <td className="num text-right font-semibold text-energy-300">
                              {fmt(inv.current_ac_kw, 2)}
                            </td>
                            <td className="num text-right text-slate-200">
                              {fmt(inv.peak_ac_kw, 2)}
                            </td>
                            <td className="num text-right text-emerald-300">
                              {fmt(inv.efficiency_pct, 1)}%
                            </td>
                            <td className="num text-right font-semibold text-solar-300">
                              {fmt(inv.pr_pct, 1)}%
                            </td>
                            <td className="num text-right text-slate-300">
                              {fmt(inv.avg_temp_c, 1)} / {fmt(inv.max_temp_c, 1)}
                            </td>
                            <td className="num text-right text-slate-300">
                              {fmt(inv.avg_freq_hz, 2)}
                            </td>
                            <td className="num text-right font-semibold text-solar-300">
                              {fmt(inv.yield_today_kwh, 1)}
                            </td>
                            <td className="num text-right font-bold text-emerald-300">
                              {fmt(inv.total_yield_kwh == null ? null : inv.total_yield_kwh / 1000, 2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>

              {/* Selected Plant String Status Matrix */}
              <Panel
                icon={Grid3x3}
                title={`String Status Matrix (${filteredStrings.length} Strings${
                  selectedInverterSn !== "ALL" ? ` on ${selectedInverterSn}` : ""
                })`}
                subtitle={
                  selectedPlantOverview?.live
                    ? `Now = newest Growatt record per string (live, refreshes every 60 s; fetched ${new Date(
                        selectedPlantOverview.live.fetched_at
                      ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}). PR & Peak = today from the database. Click a tile for its I-V curve.`
                    : "Live values unavailable — showing today's averages from the database. Click a tile for its I-V curve."
                }
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={selectedInverterSn}
                      onChange={(e) => setSelectedInverterSn(e.target.value)}
                      className="select input-sm w-44"
                    >
                      <option value="ALL">All Inverters ({strings.length} strings)</option>
                      {inverters.map((inv) => (
                        <option key={inv.device_sn} value={inv.device_sn}>
                          {inv.device_sn} ({inv.string_count} strings)
                        </option>
                      ))}
                    </select>
                    <Link to="/strings" className="btn-ghost btn-sm">
                      Full String Diagnostics <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                }
              >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                  {filteredStrings.slice(0, 64).map((s) => {
                    const lvl = statusLevel(s.status);
                    const pr = s.pr_pct;
                    const isLive = s.live_current_a != null;
                    const border =
                      lvl === "crit"
                        ? "border-red-500/40 bg-red-500/[0.04] hover:border-red-400/70"
                        : lvl === "warn"
                        ? "border-amber-400/35 bg-amber-400/[0.03] hover:border-amber-400/60"
                        : "border-white/[0.07] bg-ink-850/90 hover:border-emerald-400/40";
                    return (
                      <div
                        key={s.string_id}
                        onClick={() => setInspectedStringId(s.string_id)}
                        title={`Click to inspect ${s.string_id} I-V & P-V curves`}
                        className={`group relative cursor-pointer rounded-xl border p-3 transition-all hover:-translate-y-0.5 hover:shadow-lg ${border}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="num text-xs font-bold text-white group-hover:text-solar-300">
                            {s.short_label}
                          </span>
                          <Led level={lvl} pulse={lvl === "crit"} />
                        </div>
                        <div className="num mt-0.5 truncate text-[10px] text-slate-500">
                          {s.device_sn} · {s.mppt_id}
                        </div>

                        <div className="mt-2 flex items-baseline justify-between">
                          <div>
                            <div className="text-[9px] uppercase text-slate-500">PR</div>
                            <div className="num text-base font-bold text-white">{pr == null ? "—" : `${fmt(pr, 1)}%`}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-[9px] uppercase text-slate-500">Peak</div>
                            <div className="num text-xs font-semibold text-slate-200">
                              {fmt(s.p_max_w / 1000, 2)} kW
                            </div>
                          </div>
                        </div>

                        <div className="mt-2">
                          <Meter value={pr ?? 0} tone={lvl === "crit" ? "crit" : lvl === "warn" ? "warn" : "ok"} />
                        </div>

                        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                          {isLive ? (
                            <span className="num text-sky-300" title={`Live record ${s.live_at ?? ""}`}>
                              Now {fmt(s.live_voltage_v, 0)}V · {fmt(s.live_current_a, 1)}A ·{" "}
                              {fmt((s.live_power_w ?? 0) / 1000, 2)}kW
                            </span>
                          ) : (
                            <span className="num" title="Today's average from the database (no live value)">
                              Avg {fmt(s.v_avg, 0)}V · {fmt(s.i_avg, 1)}A
                            </span>
                          )}
                          <span className="text-solar-400 opacity-0 transition group-hover:opacity-100">
                            I-V →
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            </>
          )}
        </div>
      )}
    </div>
  );
};
