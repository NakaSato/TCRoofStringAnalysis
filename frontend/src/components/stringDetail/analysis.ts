/**
 * Measured analysis of one string's stored records (string page): current vs. the peer mean per
 * 5-min slot and by hour of day, plus the profile with power. Nothing here is modelled; slots where
 * the peers carry too little current to judge are left out, never filled.
 */
import type { GrowattStringDetail } from "../../api/client";
import type { PanelChartSpec } from "../PanelChart";
import { SERIES, STATUS } from "../chartTheme";
import { fmt } from "../ui";
import { translate as tr } from "../../i18n";

/** below this peer current (A) a slot says little about mismatch (dawn, dusk, heavy cloud) */
export const MISMATCH_MIN_PEER_A = 1;
/** the live string check's thresholds (backend `live_string_check`): current vs. the peers */
export const DEV_WARN_PCT = -15;
export const DEV_CRIT_PCT = -40;

type Row = GrowattStringDetail["timeseries"][number];

/** current deviation from the peer mean, %, or null when the slot can't be judged */
export const currentDev = (r: Row): number | null =>
  r.peer_current_a != null && r.peer_current_a >= MISMATCH_MIN_PEER_A ? ((r.current_a - r.peer_current_a) / r.peer_current_a) * 100 : null;

export interface HourRow {
  hour: number;
  slots: number;
  current_a: number;
  peer_current_a: number;
  dev_pct: number;
}

/** mean string vs. peer current per hour of day (over every day of a range), judged slots only */
export function byHour(detail: GrowattStringDetail): HourRow[] {
  const acc = new Map<number, { n: number; i: number; p: number }>();
  for (const r of detail.timeseries) {
    if (currentDev(r) == null) continue;
    const h = Number(r.timestamp.slice(11, 13));
    const a = acc.get(h) ?? { n: 0, i: 0, p: 0 };
    a.n += 1;
    a.i += r.current_a;
    a.p += r.peer_current_a!;
    acc.set(h, a);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, a]) => ({ hour, slots: a.n, current_a: a.i / a.n, peer_current_a: a.p / a.n, dev_pct: ((a.i - a.p) / a.p) * 100 }));
}

export interface MismatchFacts {
  judged: number;
  belowWarn: number;
  belowCrit: number;
  /** longest run of consecutive judged slots at or below the warning threshold */
  longestRunSlots: number;
  longestRunFrom: string | null;
  longestRunTo: string | null;
  worstHour: HourRow | null;
  meanDevPct: number | null;
}

export function mismatchFacts(detail: GrowattStringDetail, hours: HourRow[]): MismatchFacts {
  let judged = 0;
  let belowWarn = 0;
  let belowCrit = 0;
  let run = 0;
  let runFrom: string | null = null;
  let best = { n: 0, from: null as string | null, to: null as string | null };
  let own = 0;
  let peer = 0;
  for (const r of detail.timeseries) {
    const d = currentDev(r);
    if (d == null) continue;
    judged += 1;
    own += r.current_a;
    peer += r.peer_current_a!;
    if (d <= DEV_CRIT_PCT) belowCrit += 1;
    if (d <= DEV_WARN_PCT) {
      belowWarn += 1;
      if (run === 0) runFrom = r.timestamp;
      run += 1;
      if (run > best.n) best = { n: run, from: runFrom, to: r.timestamp };
    } else {
      run = 0;
    }
  }
  const worstHour = hours.length ? hours.reduce((a, b) => (b.dev_pct < a.dev_pct ? b : a)) : null;
  return {
    judged,
    belowWarn,
    belowCrit,
    longestRunSlots: best.n,
    longestRunFrom: best.from,
    longestRunTo: best.to,
    worstHour,
    meanDevPct: peer > 0 ? ((own - peer) / peer) * 100 : null,
  };
}

/** current, power and voltage of the string vs. the peer mean, per record */
export function fullProfileSpec(detail: GrowattStringDetail): PanelChartSpec | null {
  const ts = detail.timeseries;
  if (ts.length === 0) return null;
  const peerName = detail.peer_basis && detail.peer_basis !== "raw" ? tr("Peer average (scaled)") : tr("Peer average");
  return {
    xKind: "time",
    x: ts.map((r) => r.timestamp),
    gaps: tr("No records"),
    panels: [
      {
        key: "i",
        title: tr("DC current (A)"),
        series: [
          { key: "pi", name: tr("Peer average"), type: "line", dash: "dot", width: 1.5, color: SERIES.reference, y: ts.map((r) => r.peer_current_a), format: (v) => `${fmt(v, 2)} A` },
          { key: "i", name: tr("String current"), type: "line", color: SERIES.ac, y: ts.map((r) => r.current_a), format: (v) => `${fmt(v, 2)} A` },
        ],
      },
      {
        key: "p",
        title: tr("DC power (kW)"),
        series: [
          { key: "pp", name: peerName, type: "line", dash: "dot", width: 1.5, color: SERIES.reference, y: ts.map((r) => (r.peer_power_w == null ? null : r.peer_power_w / 1000)), format: (v) => `${fmt(v, 2)} kW`, noLegend: true },
          { key: "p", name: tr("String power"), type: "line", area: true, color: SERIES.dc, y: ts.map((r) => r.power_w / 1000), format: (v) => `${fmt(v, 2)} kW` },
        ],
      },
      {
        key: "v",
        title: tr("MPPT voltage (V)"),
        zero: false,
        series: [
          { key: "pv", name: peerName, type: "line", dash: "dot", width: 1.5, color: SERIES.reference, y: ts.map((r) => r.peer_voltage_v), format: (v) => `${fmt(v, 0)} V`, noLegend: true },
          { key: "v", name: tr("MPPT voltage"), type: "line", color: SERIES.secondary, y: ts.map((r) => r.voltage_v), format: (v) => `${fmt(v, 0)} V` },
        ],
      },
    ],
  };
}

/** current deviation from the peers per 5-min slot, with the live check's thresholds */
export function deviationSpec(detail: GrowattStringDetail): PanelChartSpec | null {
  const ts = detail.timeseries;
  const dev = ts.map(currentDev);
  if (!dev.some((d) => d != null)) return null;
  return {
    xKind: "time",
    x: ts.map((r) => r.timestamp),
    panels: [
      {
        key: "dev",
        title: tr("Current vs. peer average (%)"),
        tickSuffix: "%",
        refLines: [
          { y: DEV_WARN_PCT, label: tr("Warning {v} %", { v: DEV_WARN_PCT }), color: STATUS.warn },
          { y: DEV_CRIT_PCT, label: tr("Critical {v} %", { v: DEV_CRIT_PCT }), color: STATUS.crit },
        ],
        series: [
          {
            key: "dev",
            name: tr("Deviation"),
            type: "line",
            area: true,
            color: SERIES.ac,
            y: dev,
            format: (v) => `${v >= 0 ? "+" : ""}${fmt(v, 1)}%`,
          },
        ],
      },
    ],
  };
}

/** mean deviation per hour of day, bars coloured by the live check's thresholds */
export function hourSpec(hours: HourRow[]): PanelChartSpec | null {
  if (hours.length === 0) return null;
  const tone = (d: number) => (d <= DEV_CRIT_PCT ? STATUS.crit : d <= DEV_WARN_PCT ? STATUS.warn : STATUS.good);
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return {
    xKind: "band",
    x: hours.map((h) => hh(h.hour)),
    tipExtra: (i) => [
      { label: tr("String / peer"), value: `${fmt(hours[i].current_a, 2)} / ${fmt(hours[i].peer_current_a, 2)} A` },
      { label: tr("Slots judged"), value: String(hours[i].slots) },
    ],
    panels: [
      {
        key: "h",
        title: tr("Mean current vs. peers by hour (%)"),
        tickSuffix: "%",
        refLines: [{ y: DEV_WARN_PCT, label: `${DEV_WARN_PCT} %`, color: STATUS.warn }],
        series: [
          {
            key: "h",
            name: tr("Deviation"),
            type: "bar",
            color: STATUS.good,
            colors: hours.map((h) => tone(h.dev_pct)),
            y: hours.map((h) => h.dev_pct),
            format: (v) => `${v >= 0 ? "+" : ""}${fmt(v, 1)}%`,
          },
        ],
      },
    ],
  };
}

/** the stored records as CSV (plant-local times) */
export function detailCsv(detail: GrowattStringDetail): string {
  const head = "timestamp,voltage_v,current_a,power_w,peer_voltage_v,peer_current_a,peer_power_w,current_vs_peer_pct";
  const cell = (v: number | null) => (v == null ? "" : String(v));
  const lines = detail.timeseries.map((r) => {
    const d = currentDev(r);
    return [r.timestamp, r.voltage_v, r.current_a, r.power_w, cell(r.peer_voltage_v), cell(r.peer_current_a), cell(r.peer_power_w), d == null ? "" : d.toFixed(1)].join(",");
  });
  return [head, ...lines].join("\n");
}
