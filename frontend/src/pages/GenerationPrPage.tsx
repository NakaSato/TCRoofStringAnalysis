import React, { useMemo } from "react";
import {
  TrendingUp,
  Zap,
  Gauge,
  Thermometer,
  Cpu,
  Coins,
  BarChart3,
  Activity,
  Table as TableIcon,
  Flame,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { PlotlyChart } from "../components/PlotlyChart";
import { Panel, KpiTile, StatusBadge, LoadingState, fmt, fmtInt, LOADING_STATUS } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";

export const GenerationPrPage: React.FC = () => {
  const { selectedPlantOverview, plantOverviewLoading } = useAppContext();

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;
  const inverters = selectedPlantOverview?.inverters || [];
  const timeseries = selectedPlantOverview?.timeseries || [];
  const waterfall = selectedPlantOverview?.loss_waterfall || [];

  // 1. Per-Inverter PR (%) & Specific Yield (kWh/kWp) Chart
  const inverterPrFig = useMemo(() => {
    if (inverters.length === 0) return null;
    const sns = inverters.map((i) => i.device_sn);
    const prs = inverters.map((i) => i.pr_pct);
    const specYields = inverters.map((i) => i.specific_yield);
    const target = kpis?.target_pr_pct ?? 85.0;

    return {
      data: [
        {
          x: sns,
          y: prs,
          name: "Inverter PR (%)",
          type: "bar",
          marker: {
            color: prs.map((v) =>
              v == null ? "#64748b" : v >= target ? "#10b981" : v >= target - 5 ? "#f59e0b" : "#ef4444"
            ),
          },
        },
        {
          x: sns,
          y: sns.map(() => target),
          name: `Target PR (${target.toFixed(1)}%)`,
          type: "scatter",
          mode: "lines",
          line: { color: "#38bdf8", width: 2, dash: "dash" },
        },
        {
          x: sns,
          y: specYields,
          name: "Specific Yield (kWh/kWp)",
          type: "scatter",
          mode: "lines+markers",
          yaxis: "y2",
          line: { color: "#fbbf24", width: 2 },
          marker: { size: 7, color: "#fbbf24" },
        },
      ],
      layout: {
        margin: { l: 50, r: 55, t: 28, b: 65 },
        xaxis: { title: "Inverter Serial Number (device_sn)", tickangle: -25 },
        yaxis: { title: "Performance Ratio (%)", range: [0, 105] },
        yaxis2: {
          title: "Specific Yield (kWh/kWp)",
          overlaying: "y",
          side: "right",
          showgrid: false,
          rangemode: "tozero",
        },
        legend: { orientation: "h", y: 1.14, x: 0 },
      },
    };
  }, [inverters, kpis]);

  // 2. 5-Minute Power Profile (AC vs DC vs Expected Reference)
  const powerProfileFig = useMemo(() => {
    if (timeseries.length === 0) return null;
    const x = timeseries.map((r) => r.timestamp);
    return {
      data: [
        {
          x,
          y: timeseries.map((r) => r.expected_kw),
          name: "Clear-Sky Reference (kW)",
          type: "scatter",
          mode: "lines",
          line: { color: "#64748b", width: 1.5, dash: "dot" },
        },
        {
          x,
          y: timeseries.map((r) => r.ppv_kw),
          name: "DC PV Input (kW)",
          type: "scatter",
          mode: "lines",
          line: { color: "#f59e0b", width: 2 },
        },
        {
          x,
          y: timeseries.map((r) => r.pac_kw),
          name: "AC Grid Output (kW)",
          type: "scatter",
          mode: "lines",
          fill: "tozeroy",
          fillcolor: "rgba(16, 185, 129, 0.12)",
          line: { color: "#10b981", width: 2.2 },
        },
      ],
      layout: {
        margin: { l: 55, r: 25, t: 28, b: 45 },
        xaxis: { title: "Timestamp (5-Min Intervals)" },
        yaxis: { title: "Power (kW)", rangemode: "tozero" },
        legend: { orientation: "h", y: 1.14, x: 0 },
      },
    };
  }, [timeseries]);

  // 3. Energy Loss Waterfall Chart
  const waterfallFig = useMemo(() => {
    if (waterfall.length === 0) return null;
    return {
      data: [
        {
          x: waterfall.map((w) => w.stage),
          y: waterfall.map((w) => Math.abs(w.kwh)),
          type: "bar",
          marker: {
            color: waterfall.map((w) =>
              w.type === "base" ? "#38bdf8" : w.type === "net" ? "#10b981" : "#f43f5e"
            ),
          },
          text: waterfall.map((w) => `${w.kwh > 0 && w.type === "loss" ? "-" : ""}${fmt(w.kwh, 1)} kWh`),
          textposition: "auto",
        },
      ],
      layout: {
        margin: { l: 55, r: 20, t: 24, b: 70 },
        xaxis: { title: "Loss Stage", tickangle: -20 },
        yaxis: { title: "Energy (kWh)", rangemode: "tozero" },
      },
    };
  }, [waterfall]);

  // 4. Thermal Derating & Efficiency Chart
  const thermalFig = useMemo(() => {
    if (inverters.length === 0) return null;
    return {
      data: [
        {
          x: inverters.map((i) => i.device_sn),
          y: inverters.map((i) => i.avg_temp_c),
          name: "Avg Operating Temp (°C)",
          type: "bar",
          marker: { color: "#f59e0b" },
        },
        {
          x: inverters.map((i) => i.device_sn),
          y: inverters.map((i) => i.max_temp_c),
          name: "Peak Temp (°C)",
          type: "bar",
          marker: { color: "#ef4444" },
        },
        {
          x: inverters.map((i) => i.device_sn),
          y: inverters.map((i) => i.efficiency_pct),
          name: "Conversion Efficiency (%)",
          type: "scatter",
          mode: "lines+markers",
          yaxis: "y2",
          line: { color: "#22d3ee", width: 2.2 },
          marker: { size: 7, color: "#22d3ee" },
        },
      ],
      layout: {
        barmode: "group",
        margin: { l: 50, r: 55, t: 28, b: 65 },
        xaxis: { title: "Inverter Serial Number", tickangle: -25 },
        yaxis: { title: "Temperature (°C)", range: [0, 85] },
        yaxis2: {
          title: "Efficiency (%)",
          overlaying: "y",
          side: "right",
          showgrid: false,
          range: [85, 100],
        },
        legend: { orientation: "h", y: 1.14, x: 0 },
      },
    };
  }, [inverters]);

  if (plantOverviewLoading && !selectedPlantOverview) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <LoadingState label="Computing selected plant Performance Ratio & inverter generation curves…" />
      </div>
    );
  }

  const pr = Number(kpis?.plant_pr_pct || 0);
  const targetPr = Number(kpis?.target_pr_pct || 85.0);
  const prDelta = pr - targetPr;
  const yieldToday = Number(kpis?.yield_today_kwh || 0);
  const totalYieldMwh = Number(kpis?.total_yield_kwh || 0) / 1000;
  const specYield = Number(kpis?.specific_yield_kwh_per_kwp || 0);
  const eff = kpis?.conversion_efficiency_pct ?? null;
  const tariff = Number(kpis?.tariff_thb_per_kwh || 4.2);

  return (
    <div className="space-y-6">
      <SelectedPlantBanner />

      {/* 6 Selected-Plant PR & Generation KPIs */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Plant Performance Ratio"
          value={fmt(pr, 1)}
          unit="%"
          icon={Gauge}
          tone={prDelta >= 0 ? "ok" : "warn"}
          hint={`${prDelta >= 0 ? "+" : ""}${prDelta.toFixed(1)}% vs ${targetPr.toFixed(1)}% target`}
          hintTone={prDelta >= 0 ? "ok" : "warn"}
        />
        <KpiTile
          label="Yield Today"
          value={fmt(yieldToday, 1)}
          unit="kWh"
          icon={Zap}
          tone="solar"
          hint={`Specific: ${fmt(specYield, 2)} kWh/kWp`}
          hintTone="ok"
        />
        <KpiTile
          label="Inverter Efficiency"
          value={fmt(eff, 2)}
          unit="%"
          icon={Cpu}
          tone="energy"
          hint={`${fmtInt(kpis?.online_inverters)}/${inverters.length} inverters active`}
        />
        <KpiTile
          label="Inverter Temp (Avg/Max)"
          value={`${fmt(kpis?.avg_temp_c, 1)} / ${fmt(kpis?.max_temp_c, 1)}`}
          unit="°C"
          icon={Thermometer}
          tone={Number(kpis?.max_temp_c || 0) > 65 ? "warn" : "ok"}
          hint={`Grid Freq ${fmt(kpis?.avg_freq_hz, 2)} Hz`}
        />
        <KpiTile
          label="Lifetime Generation"
          value={fmt(totalYieldMwh, 2)}
          unit="MWh"
          icon={TrendingUp}
          tone="info"
          hint={`Capacity ${fmt(kpis?.capacity_kwp, 1)} kWp`}
        />
        <KpiTile
          label="Revenue Today"
          value={`฿${fmt(yieldToday * tariff, 0)}`}
          icon={Coins}
          tone="ok"
          hint={`Tariff ฿${tariff.toFixed(2)}/kWh`}
        />
      </div>

      {/* Row 1 Charts: Per-Inverter PR Comparison + 5-Min Power Profile */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel
          className="xl:col-span-6"
          icon={BarChart3}
          title={`Per-Inverter Performance Ratio & Specific Yield (${inverters.length} Inverters)`}
          subtitle={`Comparison across all inverters at ${plant?.name || "selected plant"}`}
        >
          <PlotlyChart figure={inverterPrFig} height={360} bare />
        </Panel>

        <Panel
          className="xl:col-span-6"
          icon={Activity}
          title="5-Minute AC Output vs. DC Input & Reference Envelope"
          subtitle="Real-time power conversion tracking across 5-minute intervals"
        >
          <PlotlyChart figure={powerProfileFig} height={360} bare />
        </Panel>
      </div>

      {/* Row 2 Charts: Energy Loss Waterfall + Thermal Derating */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel
          className="xl:col-span-6"
          icon={TrendingUp}
          title="Plant Energy Loss Waterfall (IEC 61724)"
          subtitle="Breakdown from nominal DC reference to net AC grid export"
        >
          <PlotlyChart figure={waterfallFig} height={340} bare />
        </Panel>

        <Panel
          className="xl:col-span-6"
          icon={Flame}
          title="Inverter Thermal Operating Profile vs. Conversion Efficiency"
          subtitle="Operating temperature (°C) and DC→AC conversion efficiency (%) per inverter"
        >
          <PlotlyChart figure={thermalFig} height={340} bare />
        </Panel>
      </div>

      {/* Per-Inverter PR & Generation Ledger Table */}
      <Panel
        icon={TableIcon}
        title={`Inverter Performance Ratio & Generation Ledger — ${plant?.name || ""}`}
        subtitle={`${inverters.length} Growatt MAX inverters monitored at this plant`}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Inverter SN</th>
                <th>Model</th>
                <th className="text-right">Strings</th>
                <th className="text-right">Rated Cap (kWp)</th>
                <th className="text-right">Peak DC (kW)</th>
                <th className="text-right">Peak AC (kW)</th>
                <th className="text-right">Efficiency (%)</th>
                <th className="text-right">Yield Today (kWh)</th>
                <th className="text-right">Specific Yield (kWh/kWp)</th>
                <th className="text-right">PR (%)</th>
                <th className="text-right">Temp Avg / Max (°C)</th>
                <th className="text-right">Total Yield (MWh)</th>
              </tr>
            </thead>
            <tbody>
              {inverters.map((inv) => {
                const lvl =
                  inv.lost || inv.status === 0
                    ? "crit"
                    : inv.pr_pct == null || inv.pr_pct >= targetPr - 3
                    ? "ok"
                    : "warn";
                return (
                  <tr key={inv.device_sn}>
                    <td>
                      <StatusBadge
                        status={inv.status_label ?? LOADING_STATUS}
                        level={lvl}
                        loading={inv.status_label == null}
                        dot
                      />
                    </td>
                    <td className="num font-bold text-white">{inv.device_sn}</td>
                    <td className="num text-xs text-slate-400">{inv.model}</td>
                    <td className="num text-right text-sky-300">{inv.string_count}</td>
                    <td className="num text-right text-slate-300">{fmt(inv.capacity_kwp, 2)}</td>
                    <td className="num text-right text-amber-300">{fmt(inv.peak_dc_kw, 2)}</td>
                    <td className="num text-right text-energy-300">{fmt(inv.peak_ac_kw, 2)}</td>
                    <td className="num text-right text-emerald-300">{fmt(inv.efficiency_pct, 2)}%</td>
                    <td className="num text-right font-semibold text-solar-300">
                      {fmt(inv.yield_today_kwh, 2)}
                    </td>
                    <td className="num text-right text-slate-200">{fmt(inv.specific_yield, 2)}</td>
                    <td
                      className={`num text-right font-bold ${
                        inv.pr_pct == null
                          ? "text-slate-400"
                          : inv.pr_pct >= targetPr
                          ? "text-emerald-400"
                          : inv.pr_pct >= targetPr - 5
                          ? "text-amber-400"
                          : "text-red-400"
                      }`}
                    >
                      {fmt(inv.pr_pct, 1)}%
                    </td>
                    <td className="num text-right text-slate-300">
                      {fmt(inv.avg_temp_c, 1)} / {fmt(inv.max_temp_c, 1)}
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
    </div>
  );
};
