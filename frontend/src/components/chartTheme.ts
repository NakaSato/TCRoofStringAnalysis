/**
 * Chart colours, by role. Every chart takes its colours from here so the same
 * quantity has the same colour on every page (AC output is always cyan, DC input always amber…).
 *
 * CATEGORICAL is stepped for the dark chart surface (ink-900 #0a101c) and validated with the
 * dataviz palette checks in this order: lightness band, chroma, adjacent CVD separation
 * (worst ΔE 15.9), normal-vision separation (worst ΔE 25.0) and ≥ 3:1 contrast all pass.
 * Keep the order when adding series; a 7th series needs a different chart, not a new hue.
 */
export const CATEGORICAL = ["#0b9ec0", "#c98500", "#9085e9", "#d95926", "#3987e5", "#d55181"] as const;

/** Fixed role → colour. Roles reuse CATEGORICAL slots so any mix of them stays distinguishable. */
export const SERIES = {
  ac: CATEGORICAL[0], // AC output power
  dc: CATEGORICAL[1], // DC input power / string energy
  irradiance: CATEGORICAL[1], // POA irradiance (never shares a chart with DC power)
  irradianceWithDc: CATEGORICAL[5], // POA irradiance in a chart that also draws DC power
  load: CATEGORICAL[3], // site load, derived from PV + grid (power charts have no temperature series)
  grid: CATEGORICAL[4], // grid power at the meter: + import / − export
  secondary: CATEGORICAL[2], // a second measure: specific yield, efficiency, peak current, rated AC
  temp: CATEGORICAL[3], // inverter / module temperature
  ambient: CATEGORICAL[4], // ambient temperature, measured operating points
  /** Modelled or reference values (clear-sky, reference I-V, peer median): neutral, always dashed/dotted. */
  reference: "#7c8aa0",
} as const;

/** Reserved for state (good / warning / critical); never used as a plain series colour. */
export const STATUS = {
  good: "#10b981",
  warn: "#f59e0b",
  crit: "#ef4444",
  none: "#64748b",
} as const;

/** Fill under a line: the line's colour at low opacity. */
export const areaFill = (hex: string, alpha = 0.12) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
