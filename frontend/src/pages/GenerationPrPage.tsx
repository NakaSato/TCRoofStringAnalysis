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
import { PanelChart } from "../components/PanelChart";
import type { PanelChartSpec } from "../components/PanelChart";
import { SERIES, STATUS } from "../components/chartTheme";
import { Panel, KpiTile, StatusBadge, LoadingState, fmt, fmtInt, LOADING_STATUS } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { WeatherStationPanel } from "../components/WeatherStationPanel";
import { GoogleWeatherPanel } from "../components/GoogleWeatherPanel";

export const GenerationPrPage: React.FC = () => {
  const { selectedPlantOverview, plantOverviewLoading } = useAppContext();

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;
  const inverters = selectedPlantOverview?.inverters || [];
  const timeseries = selectedPlantOverview?.timeseries || [];
  const waterfall = selectedPlantOverview?.loss_waterfall || [];

  // 1. Per-inverter PR (status-coloured bars vs target) above specific yield
  const inverterPrSpec = useMemo<PanelChartSpec | null>(() => {
    if (inverters.length === 0) return null;
    const target = kpis?.target_pr_pct ?? 85.0;
    const prs = inverters.map((i) => i.pr_pct);
    return {
      xKind: "band",
      x: inverters.map((i) => i.device_sn),
      xTipLabel: (sn) => {
        const inv = inverters.find((i) => i.device_sn === sn);
        return inv?.alias ? `${inv.alias} · ${sn}` : String(sn);
      },
      legend: [
        { label: `≥ target ${target.toFixed(0)}%`, color: STATUS.good, shape: "bar" },
        { label: "within 5 pts", color: STATUS.warn, shape: "bar" },
        { label: "below", color: STATUS.crit, shape: "bar" },
        { label: "Specific yield", color: SERIES.secondary, shape: "line" },
      ],
      panels: [
        {
          key: "pr",
          title: "Peer-relative PR (%) · modelled",
          weight: 1.5,
          yMin: 0,
          yMax: 105,
          tickSuffix: "%",
          refLines: [{ y: target, label: `Target ${target.toFixed(1)}%`, color: SERIES.ambient }],
          series: [
            {
              key: "pr",
              name: "PR",
              type: "bar",
              color: STATUS.none,
              y: prs,
              colors: prs.map((v) =>
                v == null ? STATUS.none : v >= target ? STATUS.good : v >= target - 5 ? STATUS.warn : STATUS.crit,
              ),
              format: (v) => `${fmt(v, 1)}%`,
            },
          ],
        },
        {
          key: "sy",
          title: "Specific yield (kWh/kWp)",
          series: [
            {
              key: "sy",
              name: "Specific yield",
              type: "line",
              color: SERIES.secondary,
              y: inverters.map((i) => i.specific_yield),
              format: (v) => `${fmt(v, 2)} kWh/kWp`,
            },
          ],
        },
      ],
    };
  }, [inverters, kpis]);

  // 2. 5-minute power profile: AC vs DC vs modelled clear-sky reference
  const powerProfileSpec = useMemo<PanelChartSpec | null>(() => {
    if (timeseries.length === 0) return null;
    return {
      xKind: "time",
      x: timeseries.map((r) => r.timestamp),
      panels: [
        {
          key: "p",
          title: "Power (kW)",
          series: [
            {
              key: "ref",
              name: "Clear-sky reference (modelled)",
              type: "line",
              dash: "dot",
              width: 1.5,
              color: SERIES.reference,
              y: timeseries.map((r) => r.expected_kw),
              unit: "kW",
            },
            { key: "dc", name: "DC input", type: "line", color: SERIES.dc, y: timeseries.map((r) => r.ppv_kw), unit: "kW" },
            { key: "ac", name: "AC output", type: "line", area: true, color: SERIES.ac, y: timeseries.map((r) => r.pac_kw), unit: "kW" },
          ],
        },
      ],
    };
  }, [timeseries]);

  // 3. Energy loss waterfall: each loss floats from the running total
  const waterfallSpec = useMemo<PanelChartSpec | null>(() => {
    if (waterfall.length === 0) return null;
    let running = 0;
    const y: number[] = [];
    const y0: number[] = [];
    for (const w of waterfall) {
      if (w.type === "loss") {
        y0.push(running + w.kwh);
        y.push(running);
        running += w.kwh;
      } else {
        y0.push(0);
        y.push(w.kwh);
        running = w.kwh;
      }
    }
    return {
      xKind: "band",
      x: waterfall.map((w) => w.stage),
      legend: [
        { label: "Reference energy", color: SERIES.ambient, shape: "bar" },
        { label: "Loss", color: STATUS.crit, shape: "bar" },
        { label: "Net AC export", color: STATUS.good, shape: "bar" },
      ],
      panels: [
        {
          key: "e",
          title: "Energy (kWh)",
          series: [
            {
              key: "e",
              name: "Energy",
              type: "bar",
              color: SERIES.ambient,
              y,
              y0,
              colors: waterfall.map((w) => (w.type === "base" ? SERIES.ambient : w.type === "net" ? STATUS.good : STATUS.crit)),
              labels: waterfall.map((w) => fmt(w.kwh, 1)),
              noTip: true,
            },
          ],
        },
      ],
      tipExtra: (i) => [{ label: waterfall[i].type === "loss" ? "Loss" : "Energy", value: `${fmt(waterfall[i].kwh, 1)} kWh` }],
    };
  }, [waterfall]);

  // 4. Inverter temperature (avg / peak) above conversion efficiency
  const thermalSpec = useMemo<PanelChartSpec | null>(() => {
    if (inverters.length === 0) return null;
    return {
      xKind: "band",
      x: inverters.map((i) => i.device_sn),
      panels: [
        {
          key: "t",
          title: "Inverter temperature (°C)",
          weight: 1.4,
          tickSuffix: "°",
          series: [
            { key: "avg", name: "Avg temp", type: "bar", color: SERIES.dc, y: inverters.map((i) => i.avg_temp_c), unit: "°C" },
            { key: "max", name: "Peak temp", type: "bar", color: SERIES.temp, y: inverters.map((i) => i.max_temp_c), unit: "°C" },
          ],
        },
        {
          key: "eff",
          title: "DC→AC efficiency (%)",
          zero: false,
          tickSuffix: "%",
          series: [
            {
              key: "eff",
              name: "Efficiency",
              type: "line",
              color: SERIES.ac,
              y: inverters.map((i) => i.efficiency_pct),
              format: (v) => `${fmt(v, 1)}%`,
            },
          ],
        },
      ],
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

      {/* Weather station: measured irradiance / temperatures behind the IEC PR (moved from Plant Overview) */}
      {plant && selectedPlantOverview && (
        <WeatherStationPanel
          plantId={plant.plant_id}
          day={selectedPlantOverview.meta.day ?? null}
          dataUntil={selectedPlantOverview.meta.data_until ?? null}
          iecPr={selectedPlantOverview.weather?.iec_pr ?? null}
        />
      )}

      {/* Google Maps Weather (modelled): rain at 09/12/17, cloud cover, days since rain */}
      {plant && selectedPlantOverview && (
        <GoogleWeatherPanel plantId={plant.plant_id} day={selectedPlantOverview.meta.day ?? null} />
      )}

      {/* Row 1 Charts: Per-Inverter PR Comparison + 5-Min Power Profile */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel
          className="xl:col-span-6"
          icon={BarChart3}
          title={`Per-Inverter Performance Ratio & Specific Yield (${inverters.length} Inverters)`}
          subtitle={`Comparison across all inverters at ${plant?.name || "selected plant"}`}
        >
          <PanelChart spec={inverterPrSpec} height={380} />
        </Panel>

        <Panel
          className="xl:col-span-6"
          icon={Activity}
          title="5-Minute AC Output vs. DC Input & Reference Envelope"
          subtitle="Real-time power conversion tracking across 5-minute intervals"
        >
          <PanelChart spec={powerProfileSpec} height={380} />
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
          <PanelChart spec={waterfallSpec} height={340} />
        </Panel>

        <Panel
          className="xl:col-span-6"
          icon={Flame}
          title="Inverter Thermal Operating Profile vs. Conversion Efficiency"
          subtitle="Operating temperature (°C) and DC→AC conversion efficiency (%) per inverter"
        >
          <PanelChart spec={thermalSpec} height={340} />
        </Panel>
      </div>

      {/* Per-Inverter PR & Generation Ledger Table */}
      <Panel
        icon={TableIcon}
        title={`Inverter Performance Ratio & Generation Ledger — ${plant?.name || ""}`}
        subtitle={`${inverters.length} Growatt MAX inverters monitored at this plant`}
        bodyClassName="p-0"
      >
        <div className="scroll-x-hint overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Inverter SN</th>
                <th>Model</th>
                <th>Datalogger</th>
                <th className="text-right">Strings</th>
                <th className="text-right">Rated Cap (kWp)</th>
                <th className="text-right">Current AC (kW)</th>
                <th className="text-right">Peak DC (kW)</th>
                <th className="text-right">Peak AC (kW)</th>
                <th className="text-right">Efficiency (%)</th>
                <th className="text-right">Yield Today (kWh)</th>
                <th className="text-right">Specific Yield (kWh/kWp)</th>
                <th className="text-right">PR (%)</th>
                <th className="text-right">Temp Avg / Max (°C)</th>
                <th className="text-right">Grid Freq (Hz)</th>
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
                    <td className="num text-xs text-slate-500">{inv.datalogger_sn}</td>
                    <td className="num text-right text-sky-300">{inv.string_count}</td>
                    <td className="num text-right text-slate-300">{fmt(inv.capacity_kwp, 2)}</td>
                    <td className="num text-right font-semibold text-energy-300">{fmt(inv.current_ac_kw, 2)}</td>
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
                    <td className="num text-right text-slate-300">{fmt(inv.avg_freq_hz, 2)}</td>
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
