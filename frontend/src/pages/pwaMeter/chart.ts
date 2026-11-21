/** PWA Meter chart pieces shared by the site dialog and the Generation page's meter card. */
import type { ChartPanel, ChartSeries, XBand } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import type { PwaDayStatus } from "../../api/client";
import { DAY_STATUS } from "./format";
import { translate } from "../../i18n";

export const DAY_MS = 864e5;
export const RATIO_LO = 90;
export const RATIO_HI = 104;

/** A y range inside RATIO_LO–RATIO_HI that fits the in-range values and the reference lines with
 * half a point to spare (at least 3 points tall), so ratios that sit within a point of each other
 * are not drawn as one flat line on a 14-point axis. */
export const fitRatioRange = (ratio: Array<number | null>, refs: number[] = []): { lo: number; hi: number } => {
  const vals = [...ratio, ...refs].filter((v): v is number => v != null && Number.isFinite(v) && v >= RATIO_LO && v <= RATIO_HI);
  if (!vals.length) return { lo: RATIO_LO, hi: RATIO_HI };
  let lo = Math.max(RATIO_LO, Math.floor(Math.min(...vals) - 0.5));
  let hi = Math.min(RATIO_HI, Math.ceil(Math.max(...vals) + 0.5));
  while (hi - lo < 3) {
    if (lo > RATIO_LO) lo -= 1;
    if (hi - lo < 3 && hi < RATIO_HI) hi += 1;
  }
  return { lo, hi };
};

/** A ratio panel on RATIO_LO–RATIO_HI % (or a narrower `range` inside it). A day outside the range
 * (a broken meter reads a few %) is drawn on the edge in red with its real value in the tooltip, so
 * one day does not flatten the rest. */
export const ratioPanel = (
  title: string,
  name: string,
  ratio: Array<number | null>,
  refLine?: { y: number; label: string } | null,
  range: { lo: number; hi: number } = { lo: RATIO_LO, hi: RATIO_HI }
): ChartPanel => {
  const { lo, hi } = range;
  const inside = ratio.map((v) => (v != null && v >= lo && v <= hi ? v : null));
  const edge = ratio.map((v) => (v == null ? null : v < lo ? lo : v > hi ? hi : null));
  const notes = ratio.map((v) => (v != null && (v < lo || v > hi) ? translate("actual {v} %", { v: fmt(v, 1) }) : null));
  const series: ChartSeries[] = [{ key: "ratio", name, color: SERIES.secondary, type: "points", size: 5, y: inside, format: (v) => `${fmt(v, 2)} %` }];
  if (edge.some((v) => v != null))
    series.push({ key: "edge", name: translate("Outside {lo}–{hi} % (on the edge)", { lo: RATIO_LO, hi: RATIO_HI }), color: STATUS.crit, type: "points", size: 8, y: edge, tipNotes: notes, format: () => translate("off scale") });
  return { key: "ratio", title, zero: false, yMin: lo, yMax: hi, series, refLines: refLine ? [refLine] : [] };
};

/** Outage days shaded, days with a missing reading hatched; runs of the same status merged. */
export const statusBands = (days: Array<{ status: PwaDayStatus }>, x: number[]): XBand[] => {
  const bands: XBand[] = [];
  days.forEach((r, i) => {
    if (r.status === "ok") return;
    const label = translate(DAY_STATUS[r.status].label);
    const last = bands.at(-1);
    if (last && last.label === label && Number(last.to) === x[i]) last.to = x[i] + DAY_MS;
    else bands.push({ from: x[i], to: x[i] + DAY_MS, label, kind: r.status === "outage" ? "muted" : "gap" });
  });
  return bands;
};
