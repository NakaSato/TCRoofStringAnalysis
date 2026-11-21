/** PWA Meter chart pieces shared by the site dialog and the Generation page's meter card. */
import type { ChartPanel, ChartSeries, XBand } from "../../components/PanelChart";
import { SERIES, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import type { PwaDayStatus } from "../../api/client";
import { DAY_STATUS } from "./format";

export const DAY_MS = 864e5;
export const RATIO_LO = 90;
export const RATIO_HI = 104;

/** A ratio panel on RATIO_LO–RATIO_HI %. A day outside it (a broken meter reads a few %) is drawn
 * on the edge in red with its real value in the tooltip, so one day does not flatten the rest. */
export const ratioPanel = (title: string, name: string, ratio: Array<number | null>, refLine?: { y: number; label: string } | null): ChartPanel => {
  const inside = ratio.map((v) => (v != null && v >= RATIO_LO && v <= RATIO_HI ? v : null));
  const edge = ratio.map((v) => (v == null ? null : v < RATIO_LO ? RATIO_LO : v > RATIO_HI ? RATIO_HI : null));
  const notes = ratio.map((v) => (v != null && (v < RATIO_LO || v > RATIO_HI) ? `actual ${fmt(v, 1)} %` : null));
  const series: ChartSeries[] = [{ key: "ratio", name, color: SERIES.secondary, type: "points", size: 2.5, y: inside, format: (v) => `${fmt(v, 2)} %` }];
  if (edge.some((v) => v != null))
    series.push({ key: "edge", name: `Outside ${RATIO_LO}–${RATIO_HI} % (on the edge)`, color: STATUS.crit, type: "points", size: 3, y: edge, tipNotes: notes, format: () => "off scale" });
  return { key: "ratio", title, zero: false, yMin: RATIO_LO, yMax: RATIO_HI, series, refLines: refLine ? [refLine] : [] };
};

/** Outage days shaded, days with a missing reading hatched; runs of the same status merged. */
export const statusBands = (days: Array<{ status: PwaDayStatus }>, x: number[]): XBand[] => {
  const bands: XBand[] = [];
  days.forEach((r, i) => {
    if (r.status === "ok") return;
    const label = DAY_STATUS[r.status].label;
    const last = bands.at(-1);
    if (last && last.label === label && Number(last.to) === x[i]) last.to = x[i] + DAY_MS;
    else bands.push({ from: x[i], to: x[i] + DAY_MS, label, kind: r.status === "outage" ? "muted" : "gap" });
  });
  return bands;
};
