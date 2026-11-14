/**
 * I-V curve above P-V curve on a shared voltage axis, for String Diagnostics and the string
 * drawer. The curves are modelled (single-diode fit to this string); the dots are measured.
 * A curve or MPP the backend could not model (nothing measured) is left out, never filled in;
 * with nothing to draw at all the spec is null (the chart shows its empty state).
 */
import type { GrowattStringDetail } from "../api/client";
import type { ChartSeries, PanelChartSpec } from "./PanelChart";
import { SERIES, STATUS } from "./chartTheme";
import { fmt } from "./ui";

export function ivPvSpecFrom(curve: GrowattStringDetail["iv_pv_curve"]): PanelChartSpec | null {
  const { nominal_points, actual_points, measured_scatter, mpp_nominal, mpp_actual } = curve;
  const base = actual_points.length > 0 ? actual_points : nominal_points.length > 0 ? nominal_points : measured_scatter;
  if (base.length === 0) return null;
  const amps = (v: number) => `${fmt(v, 2)} A`;
  const watts = (v: number) => `${fmt(v, 0)} W`;

  const current: ChartSeries[] = [];
  const power: ChartSeries[] = [];
  if (nominal_points.length > 0) {
    current.push({
      key: "ref-i",
      name: "Reference I-V (modelled)",
      type: "line",
      dash: "dash",
      width: 1.5,
      color: SERIES.reference,
      x: nominal_points.map((p) => p.v),
      y: nominal_points.map((p) => p.i),
      format: amps,
    });
  }
  if (actual_points.length > 0) {
    const x = actual_points.map((p) => p.v);
    current.push({ key: "act-i", name: "Actual I-V (modelled)", type: "line", color: SERIES.ac, x, y: actual_points.map((p) => p.i), format: amps });
    power.push({ key: "act-p", name: "Actual P-V (modelled)", type: "line", color: SERIES.dc, x, y: actual_points.map((p) => p.p), format: watts });
  }
  if (measured_scatter.length > 0) {
    current.push({
      key: "meas",
      name: "Measured operating points",
      type: "points",
      size: 6,
      opacity: 0.7,
      color: SERIES.ambient,
      x: measured_scatter.map((p) => p.v),
      y: measured_scatter.map((p) => p.i),
      noTip: true,
    });
  }
  if (mpp_nominal) {
    power.push({
      key: "mpp-ref",
      name: `Reference MPP ${fmt(mpp_nominal.p, 0)} W (modelled)`,
      type: "points",
      symbol: "ring",
      size: 10,
      color: SERIES.reference,
      x: [mpp_nominal.v],
      y: [mpp_nominal.p],
      noTip: true,
    });
  }
  if (mpp_actual) {
    power.push({
      key: "mpp",
      name: `Actual MPP ${fmt(mpp_actual.p, 0)} W @ ${fmt(mpp_actual.v, 0)} V`,
      type: "points",
      symbol: "diamond",
      size: 11,
      color: STATUS.good,
      x: [mpp_actual.v],
      y: [mpp_actual.p],
      noTip: true,
    });
  }

  return {
    xKind: "linear",
    xZero: true,
    x: base.map((p) => p.v),
    xLabel: "String DC voltage (V)",
    xTipNumber: (v) => `${fmt(v, 0)} V`,
    panels: [
      { key: "i", title: "Current (A)", series: current },
      ...(power.length > 0 ? [{ key: "p", title: "Power (W)", series: power }] : []),
    ],
  };
}

/** 5-minute string current (vs. the peer average) above MPPT voltage, all measured and stored. */
export function stringProfileSpecFrom(detail: GrowattStringDetail): PanelChartSpec | null {
  const ts = detail.timeseries;
  if (ts.length === 0) return null;
  return {
    xKind: "time",
    x: ts.map((r) => r.timestamp),
    panels: [
      {
        key: "i",
        title: "DC current (A)",
        weight: 1.3,
        series: [
          {
            key: "peer",
            name: "Peer average",
            type: "line",
            dash: "dot",
            width: 1.5,
            color: SERIES.reference,
            y: ts.map((r) => r.peer_current_a),
            format: (v) => `${fmt(v, 2)} A`,
          },
          { key: "i", name: "String current", type: "line", color: SERIES.ac, y: ts.map((r) => r.current_a), format: (v) => `${fmt(v, 2)} A` },
        ],
      },
      {
        key: "v",
        title: "MPPT voltage (V)",
        zero: false,
        series: [{ key: "v", name: "MPPT voltage", type: "line", color: SERIES.dc, y: ts.map((r) => r.voltage_v), format: (v) => `${fmt(v, 0)} V` }],
      },
    ],
  };
}
