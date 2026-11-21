import React, { useMemo } from "react";
import { Activity, Cpu } from "lucide-react";
import type { GrowattInverterTimeseries } from "../api/client";
import { PanelChart } from "./PanelChart";
import type { PanelChartSpec } from "./PanelChart";
import { SERIES } from "./chartTheme";
import { EmptyState, LoadingState, Panel, fmt } from "./ui";
import { useI18n } from "../i18n";

/**
 * 5-minute AC / DC power and temperature of one inverter for one day (stored history),
 * with the modelled clear-sky reference labelled as modelled and the rated AC power
 * (from Growatt) as a line: AC flat on that line = clipping.
 */
export const InverterProfilePanel: React.FC<{
  deviceSn: string;
  label?: string;
  series: GrowattInverterTimeseries | null;
  loading: boolean;
  className?: string;
}> = ({ deviceSn, label, series, loading, className = "" }) => {
  const { t } = useI18n();
  const rated = series?.nominal_power_kw ?? null;

  const spec = useMemo<PanelChartSpec | null>(() => {
    const ts = series?.timeseries || [];
    if (ts.length === 0) return null;
    return {
      xKind: "time",
      x: ts.map((r) => r.timestamp),
      panels: [
        {
          key: "p",
          title: t("Power (kW)"),
          weight: 1.7,
          refLines: rated != null ? [{ y: rated, label: t("Rated AC {v} kW", { v: fmt(rated, 0) }), color: SERIES.secondary }] : [],
          series: [
            {
              key: "ref",
              name: t("Clear-sky reference (modelled)"),
              type: "line",
              dash: "dot",
              width: 1.5,
              color: SERIES.reference,
              y: ts.map((r) => r.expected_kw),
              unit: "kW",
            },
            { key: "dc", name: t("DC input"), type: "line", color: SERIES.dc, y: ts.map((r) => r.ppv_kw), unit: "kW" },
            { key: "ac", name: t("AC output"), type: "line", area: true, color: SERIES.ac, y: ts.map((r) => r.pac_kw), unit: "kW" },
          ],
        },
        {
          key: "t",
          title: t("Inverter temperature (°C)"),
          zero: false,
          series: [{ key: "t", name: t("Inverter temp"), type: "line", color: SERIES.temp, width: 1.5, y: ts.map((r) => r.temp_c), unit: "°C" }],
        },
      ],
      legendExtra: rated != null ? [{ label: t("Rated AC (flat AC on it = clipping)"), color: SERIES.secondary, shape: "dash" }] : [],
    };
  }, [series, rated, t]);

  return (
    <Panel
      className={className}
      icon={Activity}
      title={t("5-Minute Inverter Generation & Thermal Profile — {name}", { name: label ?? deviceSn })}
      subtitle={`${t("AC power, DC input power, modelled clear-sky reference")}${
        series?.capacity_kwp != null
          ? ` (${fmt(series.capacity_kwp, 2)} kWp${
              series.capacity_basis === "plant_share" ? `, ${t("plant kWp ÷ inverters")}` : `, ${t("from string layout")}`
            })`
          : ""
      }${rated != null ? `, ${t("rated AC (AC flat on it = clipping)")}` : ""} ${t("& inverter temperature")}${
        series?.meta.day ? ` · ${series.meta.day}` : ""
      }`}
    >
      {loading ? (
        <LoadingState label={t("Loading 5-minute inverter time series…")} shape="chart" />
      ) : spec ? (
        <PanelChart spec={spec} height={380} />
      ) : (
        <EmptyState icon={Cpu} title={t("No stored history")} description={t("No 5-minute records for {sn} on this day.", { sn: deviceSn })} />
      )}
    </Panel>
  );
};
