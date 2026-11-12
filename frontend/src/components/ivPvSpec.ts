/**
 * I-V curve above P-V curve on a shared voltage axis, for String Diagnostics and the string
 * drawer. The curves are modelled (single-diode fit to this string); the dots are measured.
 */
import type { GrowattStringDetail } from "../api/client";
import type { PanelChartSpec } from "./PanelChart";
import { SERIES, STATUS } from "./chartTheme";
import { fmt } from "./ui";

export function ivPvSpecFrom(curve: GrowattStringDetail["iv_pv_curve"]): PanelChartSpec {
  const { nominal_points, actual_points, measured_scatter, mpp_nominal, mpp_actual } = curve;
  const amps = (v: number) => `${fmt(v, 2)} A`;
  const watts = (v: number) => `${fmt(v, 0)} W`;
  return {
    xKind: "linear",
    xZero: true,
    x: actual_points.map((p) => p.v),
    xLabel: "String DC voltage (V)",
    xTipNumber: (v) => `${fmt(v, 0)} V`,
    panels: [
      {
        key: "i",
        title: "Current (A)",
        series: [
          {
            key: "ref-i",
            name: "Reference I-V (modelled)",
            type: "line",
            dash: "dash",
            width: 1.5,
            color: SERIES.reference,
            x: nominal_points.map((p) => p.v),
            y: nominal_points.map((p) => p.i),
            format: amps,
          },
          {
            key: "act-i",
            name: "Actual I-V (modelled)",
            type: "line",
            color: SERIES.ac,
            y: actual_points.map((p) => p.i),
            format: amps,
          },
          {
            key: "meas",
            name: "Measured operating points",
            type: "points",
            size: 6,
            opacity: 0.7,
            color: SERIES.ambient,
            x: measured_scatter.map((p) => p.v),
            y: measured_scatter.map((p) => p.i),
            noTip: true,
          },
        ],
      },
      {
        key: "p",
        title: "Power (W)",
        series: [
          {
            key: "act-p",
            name: "Actual P-V (modelled)",
            type: "line",
            color: SERIES.dc,
            y: actual_points.map((p) => p.p),
            format: watts,
          },
          {
            key: "mpp-ref",
            name: `Reference MPP ${fmt(mpp_nominal.p, 0)} W`,
            type: "points",
            symbol: "ring",
            size: 10,
            color: SERIES.reference,
            x: [mpp_nominal.v],
            y: [mpp_nominal.p],
            noTip: true,
          },
          {
            key: "mpp",
            name: `Actual MPP ${fmt(mpp_actual.p, 0)} W @ ${fmt(mpp_actual.v, 0)} V`,
            type: "points",
            symbol: "diamond",
            size: 11,
            color: STATUS.good,
            x: [mpp_actual.v],
            y: [mpp_actual.p],
            noTip: true,
          },
        ],
      },
    ],
  };
}
