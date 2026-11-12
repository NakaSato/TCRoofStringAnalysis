import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  Search,
  Zap,
  SlidersHorizontal,
  ArrowUpRight,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattStringDetail } from "../api/client";
import { PlotlyChart } from "../components/PlotlyChart";
import {
  Panel,
  KpiTile,
  StatusBadge,
  Led,
  Meter,
  EmptyState,
  LoadingState,
  statusLevel,
  fmt,
} from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";

export const StringAnalysisPage: React.FC = () => {
  const {
    selectedGrowattPlantId,
    selectedPlantOverview,
    plantOverviewLoading,
    setInspectedStringId,
  } = useAppContext();

  const [selectedInverterSn, setSelectedInverterSn] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "Healthy" | "Warning" | "Critical">("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeStringKey, setActiveStringKey] = useState<string | null>(null);
  const [stringDetail, setStringDetail] = useState<GrowattStringDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;
  const inverters = selectedPlantOverview?.inverters || [];
  const strings = selectedPlantOverview?.strings || [];
  const anomalies = selectedPlantOverview?.anomalies || [];

  // Reset inverter filter when switching plant
  useEffect(() => {
    setSelectedInverterSn("ALL");
    setActiveStringKey(null);
  }, [selectedGrowattPlantId]);

  const filteredStrings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return strings.filter((s) => {
      if (selectedInverterSn !== "ALL" && s.device_sn !== selectedInverterSn) return false;
      if (statusFilter !== "ALL" && s.status !== statusFilter) return false;
      if (q && !`${s.string_id} ${s.mppt_id} ${s.diagnosis}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [strings, selectedInverterSn, statusFilter, searchQuery]);

  // Default active string for the I-V / P-V Curve Analyzer (pick an anomaly or first string)
  const activeString = useMemo(() => {
    if (activeStringKey) {
      const found = strings.find((s) => s.string_id === activeStringKey);
      if (found) return found;
    }
    const pool = filteredStrings.length > 0 ? filteredStrings : strings;
    return (
      pool.find((s) => s.status === "Warning" || s.status === "Critical") ||
      pool[0] ||
      null
    );
  }, [activeStringKey, filteredStrings, strings]);

  // Fetch real I-V / P-V curve and 5-minute string telemetry when activeString changes
  useEffect(() => {
    if (!selectedGrowattPlantId || !activeString) {
      setStringDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .getGrowattStringDetail(
        selectedGrowattPlantId,
        activeString.device_sn,
        activeString.string_no
      )
      .then((res) => {
        if (!cancelled) setStringDetail(res);
      })
      .catch(() => {
        if (!cancelled) setStringDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGrowattPlantId, activeString?.device_sn, activeString?.string_no]);

  // 1. I-V & P-V Curve Figure from stringDetail
  const ivPvFig = useMemo(() => {
    if (!stringDetail) return null;
    const { nominal_points, actual_points, measured_scatter, mpp_nominal, mpp_actual } =
      stringDetail.iv_pv_curve;

    return {
      data: [
        {
          x: nominal_points.map((p) => p.v),
          y: nominal_points.map((p) => p.i),
          name: "Reference I-V Curve (A)",
          type: "scatter",
          mode: "lines",
          line: { color: "#64748b", width: 2, dash: "dash" },
        },
        {
          x: actual_points.map((p) => p.v),
          y: actual_points.map((p) => p.i),
          name: "Actual String I-V Curve (A)",
          type: "scatter",
          mode: "lines",
          line: { color: "#22d3ee", width: 3 },
        },
        {
          x: measured_scatter.map((p) => p.v),
          y: measured_scatter.map((p) => p.i),
          name: "Measured Operating Points (V, I)",
          type: "scatter",
          mode: "markers",
          marker: { color: "#38bdf8", size: 6, opacity: 0.65 },
        },
        {
          x: actual_points.map((p) => p.v),
          y: actual_points.map((p) => p.p),
          name: "Actual P-V Power Curve (W)",
          type: "scatter",
          mode: "lines",
          yaxis: "y2",
          line: { color: "#f59e0b", width: 2.5 },
        },
        {
          x: [mpp_actual.v],
          y: [mpp_actual.p],
          name: `Actual MPP (${fmt(mpp_actual.p, 0)} W @ ${fmt(mpp_actual.v, 0)} V)`,
          type: "scatter",
          mode: "markers",
          yaxis: "y2",
          marker: { color: "#10b981", size: 11, symbol: "diamond", line: { color: "#ffffff", width: 1.5 } },
        },
        {
          x: [mpp_nominal.v],
          y: [mpp_nominal.p],
          name: `Reference MPP (${fmt(mpp_nominal.p, 0)} W)`,
          type: "scatter",
          mode: "markers",
          yaxis: "y2",
          marker: { color: "#94a3b8", size: 9, symbol: "circle-open", line: { width: 2 } },
        },
      ],
      layout: {
        margin: { l: 52, r: 58, t: 28, b: 48 },
        xaxis: { title: "String DC Voltage (V)", rangemode: "tozero" },
        yaxis: { title: "String DC Current (A)", rangemode: "tozero" },
        yaxis2: {
          title: "String Power (W)",
          overlaying: "y",
          side: "right",
          showgrid: false,
          rangemode: "tozero",
        },
        legend: { orientation: "h", y: 1.16, x: 0 },
      },
    };
  }, [stringDetail]);

  // 2. 5-Minute String Telemetry vs. Peer Median Figure
  const stringTimeseriesFig = useMemo(() => {
    if (!stringDetail || stringDetail.timeseries.length === 0) return null;
    const ts = stringDetail.timeseries;
    const x = ts.map((r) => r.timestamp);
    return {
      data: [
        {
          x,
          y: ts.map((r) => r.peer_current_a),
          name: "Peer Avg Current (A)",
          type: "scatter",
          mode: "lines",
          line: { color: "#64748b", width: 1.5, dash: "dot" },
        },
        {
          x,
          y: ts.map((r) => r.current_a),
          name: "String Current (A)",
          type: "scatter",
          mode: "lines",
          line: { color: "#22d3ee", width: 2.2 },
        },
        {
          x,
          y: ts.map((r) => r.voltage_v),
          name: "MPPT Voltage (V)",
          type: "scatter",
          mode: "lines",
          yaxis: "y2",
          line: { color: "#f59e0b", width: 1.8 },
        },
      ],
      layout: {
        margin: { l: 50, r: 55, t: 28, b: 48 },
        xaxis: { title: "Timestamp (5-Min Intervals)" },
        yaxis: { title: "DC Current (A)", rangemode: "tozero" },
        yaxis2: {
          title: "DC Voltage (V)",
          overlaying: "y",
          side: "right",
          showgrid: false,
          rangemode: "tozero",
        },
        legend: { orientation: "h", y: 1.16, x: 0 },
      },
    };
  }, [stringDetail]);

  // 3. Peer String PR (%) & Current Mismatch Bar Chart
  const peerBarFig = useMemo(() => {
    const sub = filteredStrings.slice(0, 40);
    if (sub.length === 0) return null;
    return {
      data: [
        {
          x: sub.map((s) => s.string_id),
          y: sub.map((s) => s.pr_pct),
          name: "String PR (%)",
          type: "bar",
          marker: {
            color: sub.map((s) =>
              s.status === "Critical"
                ? "#ef4444"
                : s.status === "Warning"
                ? "#f59e0b"
                : "#10b981"
            ),
          },
        },
        {
          x: sub.map((s) => s.string_id),
          y: sub.map((s) => s.i_max),
          name: "Peak Current I_max (A)",
          type: "scatter",
          mode: "lines+markers",
          yaxis: "y2",
          line: { color: "#38bdf8", width: 2 },
          marker: { size: 6, color: "#38bdf8" },
        },
      ],
      layout: {
        margin: { l: 50, r: 52, t: 26, b: 85 },
        xaxis: { title: "String ID (Click any string below to inspect I-V)", tickangle: -35 },
        yaxis: { title: "String PR (%)", range: [0, 105] },
        yaxis2: {
          title: "Peak Current (A)",
          overlaying: "y",
          side: "right",
          showgrid: false,
          rangemode: "tozero",
        },
        legend: { orientation: "h", y: 1.14, x: 0 },
      },
    };
  }, [filteredStrings]);

  if (plantOverviewLoading && !selectedPlantOverview) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <LoadingState label="Analyzing string voltage, current & I-V / P-V curves for selected plant…" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {/* String Health Summary KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile
          label="Monitored Strings"
          value={String(kpis?.string_count || strings.length)}
          unit="strings"
          icon={Cpu}
          tone="info"
          hint={`Across ${inverters.length} Growatt MAX inverters`}
        />
        <KpiTile
          label="Healthy Strings"
          value={String(kpis?.healthy_strings || 0)}
          unit={`/ ${kpis?.string_count || strings.length}`}
          icon={CheckCircle2}
          tone="ok"
          hint="Operating within nominal MPPT peer envelope"
          hintTone="ok"
        />
        <KpiTile
          label="Warning / Mismatch"
          value={String(kpis?.warning_strings || 0)}
          unit="strings"
          icon={AlertTriangle}
          tone="warn"
          hint="Current or voltage deviation vs. MPPT peer"
          hintTone={Number(kpis?.warning_strings || 0) > 0 ? "warn" : "ok"}
        />
        <KpiTile
          label="Critical String Faults"
          value={String(kpis?.critical_strings || 0)}
          unit="strings"
          icon={Zap}
          tone="crit"
          hint={`Avg String Health ${fmt(kpis?.avg_health_score, 1)} / 100`}
          hintTone={Number(kpis?.critical_strings || 0) > 0 ? "crit" : "ok"}
        />
      </div>

      {/* Inverter & Status Filter Bar */}
      <section className="panel px-5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-300">
              <SlidersHorizontal className="h-3.5 w-3.5 text-sky-400" />
              Inverter:
            </span>
            <button
              onClick={() => setSelectedInverterSn("ALL")}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                selectedInverterSn === "ALL"
                  ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40"
                  : "bg-white/[0.04] text-slate-400 hover:text-white"
              }`}
            >
              All ({inverters.length})
            </button>
            {inverters.map((inv) => (
              <button
                key={inv.device_sn}
                onClick={() => setSelectedInverterSn(inv.device_sn)}
                className={`num rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  selectedInverterSn === inv.device_sn
                    ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40"
                    : "bg-white/[0.04] text-slate-400 hover:text-white"
                }`}
              >
                {inv.device_sn} ({inv.string_count})
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["ALL", "Healthy", "Warning", "Critical"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  statusFilter === st
                    ? "bg-solar-400/20 text-solar-300 ring-1 ring-solar-400/40"
                    : "bg-white/[0.04] text-slate-400 hover:text-white"
                }`}
              >
                {st}
              </button>
            ))}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search STR / MPPT…"
                className="input input-sm w-40 pl-8"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ==================================================================== */}
      {/* INTERACTIVE I-V / P-V CURVE ANALYZER & 5-MINUTE TELEMETRY            */}
      {/* ==================================================================== */}
      {activeString && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          <Panel
            className="xl:col-span-6"
            icon={Gauge}
            title={`I-V & P-V Curve — ${activeString.string_id}`}
            subtitle={`5-minute Growatt telemetry (${activeString.mppt_id} · ${activeString.status})`}
            actions={
              <div className="flex items-center gap-1.5">
                <select
                  value={activeString.string_id}
                  onChange={(e) => setActiveStringKey(e.target.value)}
                  className="select input-sm w-44"
                >
                  {filteredStrings.map((s) => (
                    <option key={s.string_id} value={s.string_id}>
                      {s.string_id} ({fmt(s.pr_pct, 1)}%)
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setInspectedStringId(activeString.string_id)}
                  className="btn-ghost btn-sm text-sky-400"
                >
                  Drawer <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </div>
            }
          >
            {detailLoading ? (
              <LoadingState label={`Synthesizing I-V & P-V curves for ${activeString.string_id}…`} />
            ) : (
              <div className="space-y-3">
                <PlotlyChart figure={ivPvFig} height={330} bare />
                {stringDetail && (
                  <div className="grid grid-cols-4 gap-2 rounded-lg border border-white/[0.06] bg-ink-950/60 p-3 text-center text-xs">
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">V_mpp / V_oc</div>
                      <div className="num font-bold text-amber-300">
                        {fmt(stringDetail.summary.v_mpp, 1)} / {fmt(stringDetail.summary.v_oc_est, 1)} V
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">I_mpp / I_sc</div>
                      <div className="num font-bold text-energy-300">
                        {fmt(stringDetail.summary.i_mpp, 2)} / {fmt(stringDetail.summary.i_sc_est, 2)} A
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">Peak Power (MPP)</div>
                      <div className="num font-bold text-emerald-300">
                        {fmt(stringDetail.summary.p_max_w, 0)} W
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">String PR</div>
                      <div className="num font-bold text-white">
                        {fmt(stringDetail.summary.pr_pct, 1)}%
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel
            className="xl:col-span-6"
            icon={Activity}
            title={`5-Minute String Current & Voltage Profile — ${activeString.string_id}`}
            subtitle={`Comparison against peer strings on inverter ${activeString.device_sn}`}
          >
            {detailLoading ? (
              <LoadingState label="Loading 5-minute string time series…" />
            ) : (
              <div className="space-y-3">
                <PlotlyChart figure={stringTimeseriesFig} height={330} bare />
                <div className="rounded-lg border border-white/[0.06] bg-ink-950/60 px-3.5 py-2.5 text-xs text-slate-300">
                  <span className="font-semibold text-white">Automated Diagnosis: </span>
                  <span>{activeString.diagnosis}</span>
                </div>
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* Peer String Comparison Bar Chart */}
      <Panel
        icon={Activity}
        title={`Peer String Performance Ratio & Peak Current Comparison (${filteredStrings.length} Strings)`}
        subtitle={`Showing strings for ${
          selectedInverterSn === "ALL" ? plant?.name || "All Inverters" : `Inverter ${selectedInverterSn}`
        }`}
      >
        <PlotlyChart figure={peerBarFig} height={350} bare />
      </Panel>

      {/* Full String Diagnostics Table */}
      <Panel
        icon={Cpu}
        title={`String-Level Telemetry & Diagnostics Matrix (${filteredStrings.length} Strings)`}
        subtitle="Click any string row to load its I-V / P-V curves in the analyzer above, or click 'Inspect Drawer' for slide-over details"
        bodyClassName="p-0"
      >
        <div className="scroll-x-hint overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>String ID</th>
                <th>Inverter SN</th>
                <th>MPPT</th>
                <th className="text-right" title="Newest Growatt record (live, not stored)">Now V / I</th>
                <th className="text-right">Avg V (V)</th>
                <th className="text-right">Max V (V)</th>
                <th className="text-right">Avg I (A)</th>
                <th className="text-right">Peak I (A)</th>
                <th className="text-right">Peak P (kW)</th>
                <th className="text-right">Energy (kWh)</th>
                <th className="text-right">I Mismatch (%)</th>
                <th className="text-right">PR (%)</th>
                <th>Automated Diagnosis</th>
                <th className="text-right">I-V Curve</th>
              </tr>
            </thead>
            <tbody>
              {filteredStrings.slice(0, 120).map((s) => {
                const isSelected = activeString?.string_id === s.string_id;
                const lvl = statusLevel(s.status);
                return (
                  <tr
                    key={s.string_id}
                    onClick={() => setActiveStringKey(s.string_id)}
                    className={`cursor-pointer transition ${
                      isSelected ? "bg-sky-500/15" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <td>
                      <StatusBadge status={s.status} level={lvl} dot />
                    </td>
                    <td className="num font-bold text-white hover:text-sky-300">
                      {s.short_label}
                    </td>
                    <td className="num text-xs text-slate-300">{s.device_sn}</td>
                    <td className="num text-xs text-slate-400">{s.mppt_id}</td>
                    <td
                      className="num whitespace-nowrap text-right text-sky-300"
                      title={s.live_at ? `Live record ${s.live_at}` : "No live value"}
                    >
                      {s.live_current_a == null ? "—" : `${fmt(s.live_voltage_v, 0)} / ${fmt(s.live_current_a, 2)}`}
                    </td>
                    <td className="num text-right text-amber-300">{fmt(s.v_avg, 1)}</td>
                    <td className="num text-right text-slate-300">{fmt(s.v_max, 1)}</td>
                    <td className="num text-right text-energy-300">{fmt(s.i_avg, 2)}</td>
                    <td className="num text-right font-semibold text-energy-300">
                      {fmt(s.i_max, 2)}
                    </td>
                    <td className="num text-right text-slate-200">{fmt(s.p_max_w / 1000, 2)}</td>
                    <td className="num text-right font-semibold text-solar-300">
                      {fmt(s.actual_energy_kwh, 2)}
                    </td>
                    <td
                      className={`num text-right font-semibold ${
                        s.current_mismatch_pct == null
                          ? "text-slate-400"
                          : s.current_mismatch_pct < -12
                          ? "text-red-400"
                          : s.current_mismatch_pct < -6
                          ? "text-amber-400"
                          : "text-emerald-400"
                      }`}
                    >
                      {s.current_mismatch_pct != null && s.current_mismatch_pct >= 0 ? "+" : ""}
                      {fmt(s.current_mismatch_pct, 1)}%
                    </td>
                    <td className="num text-right font-bold text-white">{fmt(s.pr_pct, 1)}%</td>
                    <td className="max-w-xs truncate text-xs text-slate-400" title={s.diagnosis}>
                      {s.diagnosis}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInspectedStringId(s.string_id);
                        }}
                        className="rounded border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-sky-500/20"
                      >
                        Inspect Drawer
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
};
