/**
 * PanelChart: the one D3 chart every x/y figure in the app is drawn with.
 *
 * A chart is one or more stacked panels sharing one x axis (time, numeric or categories).
 * Each panel has exactly one y scale, so two measures of different units (kW and °C, A and V)
 * get two panels, never a second y axis. Series are lines, bars or points; missing values
 * (null) are left as gaps, never drawn as 0, and a time series also breaks where records stop
 * for more than three intervals.
 *
 * Hover: a crosshair through every panel and one tooltip listing each series at that x.
 * Time charts can also shade x ranges across every panel (`bands`, `gaps`) and draw labelled
 * vertical markers (`markers`, e.g. "now").
 *
 * Opt-in interaction: `legendToggle` makes legend items buttons that hide / show a series (a panel
 * with every series hidden is dropped; the last visible series cannot be hidden), and `onBrush`
 * (time / numeric axes) reports the x range dragged across with the mouse.
 */
import React, { useMemo, useState } from "react";
import * as d3 from "d3";
import { fmt } from "./ui";
import { C, TICK_FONT, TipRow, Tooltip, textWidth, useWidth } from "./chartKit";
import type { TipState } from "./chartKit";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { currentLanguage, useI18n } from "../i18n";

export type XValue = string | number;

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  type: "line" | "bar" | "points";
  y: Array<number | null>;
  /** The series' own x values (default: the chart's `x`). */
  x?: XValue[];
  /** Bar bottoms for floating bars (a waterfall); default 0. */
  y0?: Array<number | null>;
  dash?: "dash" | "dot";
  width?: number;
  /** Fill from the line down to 0. */
  area?: boolean;
  /** Per-point colours, e.g. bars coloured by status. */
  colors?: Array<string | null>;
  /** Text drawn above each bar. */
  labels?: Array<string | null>;
  size?: number;
  symbol?: "circle" | "diamond" | "ring";
  opacity?: number;
  /** Tooltip value; default 1 decimal + `unit`. */
  format?: (v: number) => string;
  unit?: string;
  noTip?: boolean;
  noLegend?: boolean;
  /** Per-point text added after the tooltip value (e.g. the record time of a scatter point). */
  tipNotes?: Array<string | null>;
}

export interface RefLine {
  y: number;
  label: string;
  color?: string;
}

export interface ChartPanel {
  key: string;
  /** Shown above the panel, with its unit: "Power (kW)". */
  title: string;
  series: ChartSeries[];
  /** Share of the plot height (default 1). */
  weight?: number;
  /** Category charts: the bar series share one bar per category instead of standing side by side.
   * The caller stacks them: each series' `y` is its top and `y0` its bottom. */
  stacked?: boolean;
  yMin?: number | null;
  yMax?: number | null;
  /** Include 0 in an automatic y range (default true). */
  zero?: boolean;
  tickSuffix?: string;
  /** Fixed y tick values (default: automatic). */
  ticks?: number[];
  /** Y tick text (default: number + `tickSuffix`). */
  tickFormat?: (t: number) => string;
  refLines?: RefLine[];
}

/** An x range shaded across every panel, named in the tooltip while hovered. */
export interface XBand {
  from: XValue;
  to: XValue;
  label: string;
  kind?: "gap" | "live" | "muted";
}

/** A labelled vertical line across every panel. */
export interface XMarker {
  x: XValue;
  label: string;
  color?: string;
}

export interface LegendItem {
  label: string;
  color: string;
  shape: "bar" | "line" | "dash" | "dot" | "point";
}

export interface PanelChartSpec {
  xKind: "time" | "linear" | "band";
  x: XValue[];
  panels: ChartPanel[];
  xLabel?: string;
  /** Start a numeric x axis at 0. */
  xZero?: boolean;
  /** Tick text for category labels. */
  xTickLabel?: (v: XValue) => string;
  /** Tooltip heading for an x value (time and category charts). */
  xTipLabel?: (v: XValue) => string;
  /** Tooltip heading for a numeric x position (linear charts). */
  xTipNumber?: (v: number) => string;
  /** Replaces the automatic legend (e.g. status colours). */
  legend?: LegendItem[];
  /** Added after the automatic legend. */
  legendExtra?: LegendItem[];
  /** Extra tooltip rows for the point at index i of `x`. */
  tipExtra?: (i: number) => Array<{ label: string; value: string }>;
  /** Time / numeric axes: the x range to show at least (data outside it still widens the axis). */
  xDomain?: [XValue, XValue];
  /** Time axes: the record interval in ms, when it is fixed (default: the median step of `x`, which a
   * sparse range overestimates). Lines break, and `gaps` shade, beyond 3.5 intervals. */
  xStep?: number;
  /** Time axes: shade every record gap the lines break at, with this tooltip label (e.g. "No data"). */
  gaps?: string;
  bands?: XBand[];
  markers?: XMarker[];
  /** With no value to draw, keep the axes (x from `xDomain`) and write `emptyLabel` over the plot,
   * so the chart does not jump between a period with data and one without. */
  frame?: boolean;
}

interface Layout {
  ml: number;
  mr: number;
  iw: number;
  mb: number;
  geo: Array<{ panel: ChartPanel; y: d3.ScaleLinear<number, number>; top: number; bottom: number; titleY: number }>;
  plotBottom: number;
  xb: d3.ScaleBand<string> | null;
  xc: d3.ScaleLinear<number, number> | d3.ScaleTime<number, number> | null;
  xPos: (v: XValue) => number;
  xNum: (v: XValue) => number;
  seriesX: (s: ChartSeries) => XValue[];
  rotate: boolean;
  every: number;
  bandLabels: string[];
  gapLimit: number;
  tickFmt: (p: ChartPanel) => (t: number) => string;
  /** bands (given + record gaps) as numeric x ranges */
  bands: Array<{ lo: number; hi: number; label: string; kind: NonNullable<XBand["kind"]> }>;
}

const BAND_FILL: Record<NonNullable<XBand["kind"]>, string> = {
  gap: "url(#pc-hatch)",
  live: "rgba(56,189,248,0.07)",
  muted: "rgba(148,163,184,0.05)",
};

type Px = number;
const parseTs = d3.timeParse("%Y-%m-%d %H:%M:%S");
const parseTsT = d3.timeParse("%Y-%m-%dT%H:%M:%S");
const hhmm = d3.timeFormat("%H:%M");
/** d3 short month names in Thai, for date ticks / tooltips when the UI is Thai */
const TH_TIME = d3.timeFormatLocale({
  dateTime: "%a %e %b %Y %X",
  date: "%d/%m/%Y",
  time: "%H:%M:%S",
  periods: ["AM", "PM"],
  days: ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"],
  shortDays: ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."],
  months: ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"],
  shortMonths: ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."],
});
const byLang = (spec: string) => {
  const en = d3.timeFormat(spec);
  const th = TH_TIME.format(spec);
  return (d: Date) => (currentLanguage() === "th" ? th(d) : en(d));
};
const dayHhmm = byLang("%-d %b %H:%M");
const dayOnly = byLang("%-d %b");
/** a time x axis over more than a day: the tooltip names the day, ticks at midnight show the date */
const spansDays = (xc: Layout["xc"]) => {
  if (!xc) return false;
  const [a, b] = xc.domain();
  return +b - +a > 26 * 3_600_000;
};
const tipTime = (d: Date, multi: boolean) => (multi ? dayHhmm(d) : hhmm(d));
const tickTime = (d: Date, multi: boolean) => (multi && d.getHours() === 0 && d.getMinutes() === 0 ? dayOnly(d) : hhmm(d));
const toDate = (v: XValue): Date => {
  if (typeof v === "number") return new Date(v);
  const s = v.slice(0, 19);
  return parseTs(s) ?? parseTsT(s) ?? new Date(v);
};

/** Bar with a rounded data end (top for a rising bar) and a square base. */
function barPath(x: Px, w: Px, yTop: Px, yBot: Px, r: number) {
  const h = yBot - yTop;
  if (h <= 0 || w <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${yBot}V${yTop + rr}Q${x},${yTop} ${x + rr},${yTop}H${x + w - rr}Q${x + w},${yTop} ${x + w},${yTop + rr}V${yBot}Z`;
}

const LegendSwatch: React.FC<{ item: LegendItem }> = ({ item }) => {
  const { color, shape } = item;
  if (shape === "bar") return <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />;
  if (shape === "point") return <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />;
  if (shape === "dash" || shape === "dot")
    return <span className="inline-block w-4" style={{ borderTop: `2px ${shape === "dash" ? "dashed" : "dotted"} ${color}` }} />;
  return <span className="inline-block h-0.5 w-4 rounded" style={{ background: color }} />;
};

const autoLegend = (panels: ChartPanel[]): LegendItem[] => {
  const seen = new Set<string>();
  const out: LegendItem[] = [];
  for (const p of panels)
    for (const s of p.series) {
      if (s.noLegend || seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({
        label: s.name,
        color: s.color,
        shape: s.type === "bar" ? "bar" : s.type === "points" ? "point" : s.dash ?? "line",
      });
    }
  return out;
};

export const PanelChart: React.FC<{
  spec: PanelChartSpec | null;
  height?: number;
  emptyLabel?: string;
  /** Legend items hide / show their series (by series name). */
  legendToggle?: boolean;
  /** Where the legend sits (default top). */
  legendPosition?: "top" | "bottom";
  /** Time / numeric axes: called with the x range dragged across (ms since epoch on a time axis). */
  onBrush?: (lo: number, hi: number) => void;
}> = ({ spec: fullSpec, height = 320, emptyLabel: emptyLabelIn = "No data for this chart.", legendToggle = false, legendPosition = "top", onBrush }) => {
  const { t } = useI18n();
  // a caller's English label is translated too when the dictionary has it
  const emptyLabel = t(emptyLabelIn);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hoverX, setHoverX] = useState<{ px: number; i: number | null } | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  // hidden series (and panels left empty) are dropped before layout, so y ranges fit what is shown
  const spec = useMemo<PanelChartSpec | null>(() => {
    if (!fullSpec || !hidden.size) return fullSpec;
    const panels = fullSpec.panels
      .map((p) => ({ ...p, series: p.series.filter((s) => s.noLegend || !hidden.has(s.name)) }))
      .filter((p) => p.series.some((s) => !s.noLegend));
    return panels.length ? { ...fullSpec, panels } : fullSpec;
  }, [fullSpec, hidden]);

  const hasData = !!spec && spec.panels.some((p) => p.series.some((s) => s.y.some((v) => v != null)));

  const layout = useMemo<Layout | null>(() => {
    if (!spec || (!hasData && !spec.frame) || width <= 0) return null;
    const { xKind, panels } = spec;

    /* ---- x values ---- */
    const xNum = (v: XValue): number => (xKind === "time" ? +toDate(v) : Number(v));
    const sharedX = spec.x;
    const seriesX = (s: ChartSeries) => s.x ?? sharedX;

    /* ---- y domains (independent of width) ---- */
    const yDomains = panels.map((p) => {
      const vals: number[] = [];
      for (const s of p.series) {
        s.y.forEach((v) => v != null && Number.isFinite(v) && vals.push(v));
        s.y0?.forEach((v) => v != null && Number.isFinite(v) && vals.push(v));
      }
      p.refLines?.forEach((r) => vals.push(r.y));
      const hasBars = p.series.some((s) => s.type === "bar" || s.area);
      let lo = d3.min(vals) ?? 0;
      let hi = d3.max(vals) ?? 1;
      if (p.zero !== false || hasBars) lo = Math.min(0, lo);
      if (p.yMin != null) lo = p.yMin;
      if (p.yMax != null) hi = p.yMax;
      if (hi === lo) hi = lo + 1;
      const pad = (hi - lo) * 0.06;
      return [p.yMin != null ? lo : lo < 0 || p.zero === false ? lo - pad : lo, p.yMax != null ? hi : hi + pad] as [number, number];
    });

    /* ---- left margin from the widest y tick ---- */
    // one format per panel, so ticks never mix "5000" and "10k"
    const tickFmt = (p: ChartPanel) => {
      if (p.tickFormat) return p.tickFormat;
      const k = panels.indexOf(p);
      const [lo, hi] = yDomains[k] ?? [0, 1];
      const short = Math.max(Math.abs(lo), Math.abs(hi)) >= 10000;
      return (t: number) => `${short ? d3.format("~s")(t) : d3.format("~r")(+t.toPrecision(4))}${p.tickSuffix ?? ""}`;
    };
    const roughTicks = yDomains.map((d, k) => (panels[k].ticks ?? d3.scaleLinear().domain(d).nice().ticks(4)).map(tickFmt(panels[k])));
    const ml = Math.max(36, (d3.max(roughTicks.flat(), (s) => textWidth(s)) ?? 20) + 14);
    const mr = 14;
    const iw = Math.max(40, width - ml - mr);

    /* ---- x scale ---- */
    let bandLabels: string[] = [];
    let rotate = false;
    let every = 1;
    let xb: d3.ScaleBand<string> | null = null;
    let xc: d3.ScaleLinear<number, number> | d3.ScaleTime<number, number> | null = null;
    if (xKind === "band") {
      const keys = sharedX.map(String);
      xb = d3.scaleBand<string>().domain(keys).range([0, iw]).paddingInner(0.22).paddingOuter(0.12);
      bandLabels = sharedX.map((v) => (spec.xTickLabel ? spec.xTickLabel(v) : String(v)));
      const maxW = d3.max(bandLabels, (s) => textWidth(s)) ?? 0;
      rotate = maxW + 8 > xb.step();
      every = Math.max(1, Math.ceil(14 / xb.step()));
    } else {
      const all: number[] = [];
      for (const p of panels) for (const s of p.series) seriesX(s).forEach((v) => all.push(xNum(v)));
      spec.xDomain?.forEach((v) => all.push(xNum(v)));
      let [lo, hi] = d3.extent(all.filter(Number.isFinite)) as [number, number];
      if (spec.xZero) lo = Math.min(0, lo);
      if (lo === hi) hi = lo + 1;
      xc = xKind === "time" ? d3.scaleTime().domain([lo, hi]).range([0, iw]) : d3.scaleLinear().domain([lo, hi]).nice().range([0, iw]);
    }
    const maxLabel = rotate ? Math.min(120, d3.max(bandLabels, (s) => textWidth(s.length > 18 ? s.slice(0, 17) + "…" : s, 11)) ?? 0) : 0;

    /* ---- vertical layout ---- */
    const titleH = 26;
    const gap = 14;
    const mt = 4;
    const mb = (rotate ? maxLabel * 0.66 + 14 : 24) + (spec.xLabel ? 18 : 0);
    const avail = Math.max(60, height - mt - mb - panels.length * titleH - (panels.length - 1) * gap);
    const wsum = d3.sum(panels, (p) => p.weight ?? 1);
    let top = mt;
    const geo = panels.map((p, k) => {
      const ph = (avail * (p.weight ?? 1)) / wsum;
      const y0 = top + titleH;
      const y = d3.scaleLinear().domain(yDomains[k]).range([y0 + ph, y0]);
      if (p.yMin == null || p.yMax == null) y.nice(Math.max(3, Math.round(ph / 42)));
      top = y0 + ph + gap;
      return { panel: p, y, top: y0, bottom: y0 + ph, titleY: y0 - 12 };
    });
    const plotBottom = geo[geo.length - 1].bottom;

    const xPos = (v: XValue): number => (xb ? (xb(String(v)) ?? 0) + xb.bandwidth() / 2 : xc!(xNum(v)));

    /* median record step, to break lines across data gaps */
    let gapLimit = Infinity;
    const bands: Layout["bands"] = [];
    if (xKind === "time" && sharedX.length > 2) {
      const xs = sharedX.map(xNum);
      const step = spec.xStep ?? d3.median(d3.pairs(xs, (a, b) => b - a).filter((g) => g > 0)) ?? 0;
      if (step > 0) gapLimit = step * 3.5;
      // a gap is shaded between the last record before it and the first after, as the line breaks
      if (spec.gaps && step > 0)
        d3.pairs(xs).forEach(([a, b]) => {
          if (b - a > gapLimit) bands.push({ lo: a, hi: b, label: spec.gaps!, kind: "gap" });
        });
    }
    if (!xb) spec.bands?.forEach((b) => bands.push({ lo: xNum(b.from), hi: xNum(b.to), label: b.label, kind: b.kind ?? "muted" }));

    return { ml, mr, iw, geo, plotBottom, xb, xc, xPos, xNum, seriesX, rotate, every, bandLabels, gapLimit, tickFmt, mb, bands };
  }, [spec, hasData, width, height]);

  if (!spec || (!hasData && !spec.frame)) {
    return (
      <div ref={ref} style={{ height }} className="flex w-full items-center justify-center text-xs text-slate-500">
        {spec ? emptyLabel : <Skeleton className="h-full w-full" aria-label={t("Loading chart…")} />}
      </div>
    );
  }

  const legend = fullSpec!.legend ?? [...autoLegend(fullSpec!.panels), ...(fullSpec!.legendExtra ?? [])];
  // only the automatic legend names series; a custom legend (status colours) is not a toggle
  const canToggle = legendToggle && !fullSpec!.legend;
  const seriesNames = new Set(autoLegend(fullSpec!.panels).map((l) => l.label));
  const visibleCount = [...seriesNames].filter((n) => !hidden.has(n)).length;
  const toggle = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else if (visibleCount > 1) next.add(name);
      return next;
    });

  /* ---- drag to pick an x range ---- */
  const brushable = Boolean(onBrush && layout?.xc);
  const plotPx = (e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return { px: e.clientX - box.left - layout!.ml, py: e.clientY - box.top };
  };
  const onDown = (e: React.MouseEvent) => {
    if (!brushable || e.button !== 0) return;
    const { px, py } = plotPx(e);
    if (px < 0 || px > layout!.iw || py < layout!.geo[0].top || py > layout!.plotBottom) return;
    e.preventDefault();
    setDrag({ x0: px, x1: px });
  };
  const onUp = () => {
    if (!drag || !layout?.xc) return;
    const a = Math.max(0, Math.min(drag.x0, drag.x1));
    const b = Math.min(layout.iw, Math.max(drag.x0, drag.x1));
    setDrag(null);
    if (b - a >= 8) {
      setTip(null);
      setHoverX(null);
      onBrush!(+layout.xc.invert(a), +layout.xc.invert(b));
    }
  };

  /* ---- hover ---- */
  const onMove = (e: React.MouseEvent) => {
    if (!layout) return;
    if (drag) {
      const { px } = plotPx(e);
      setTip(null);
      return setDrag({ ...drag, x1: Math.max(0, Math.min(layout.iw, px)) });
    }
    const box = ref.current!.getBoundingClientRect();
    const px = e.clientX - box.left - layout.ml;
    const py = e.clientY - box.top;
    if (px < 0 || px > layout.iw || py > layout.plotBottom + 4) return (setTip(null), setHoverX(null));
    const { xb, xc, xNum, xPos, seriesX } = layout;

    let i: number | null = null;
    let snapPx = px;
    let heading: string;
    if (xb) {
      i = Math.max(0, Math.min(spec.x.length - 1, Math.floor((px - xb.step() * xb.paddingOuter()) / xb.step())));
      snapPx = xPos(spec.x[i]);
      const v = spec.x[i];
      heading = spec.xTipLabel ? spec.xTipLabel(v) : String(v);
    } else {
      const xv = +xc!.invert(px);
      // nearest shared x index
      const xs = spec.x.map(xNum);
      if (xs.length) {
        const j = d3.leastIndex(xs, (a, b) => Math.abs(a - xv) - Math.abs(b - xv)) ?? 0;
        if (Math.abs(xPos(spec.x[j]) - px) < 40) i = j;
      }
      if (spec.xKind === "time" && i != null) {
        snapPx = xPos(spec.x[i]);
        heading = spec.xTipLabel ? spec.xTipLabel(spec.x[i]) : tipTime(toDate(spec.x[i]), spansDays(xc));
      } else if (spec.xKind === "time") {
        // no shared x near the cursor (e.g. only series with their own x): name the cursor's time
        heading = tipTime(new Date(xv), spansDays(xc));
      } else {
        heading = spec.xTipNumber ? spec.xTipNumber(xv) : fmt(xv, 0);
      }
    }

    const rows: React.ReactNode[] = [];
    for (const g of layout.geo) {
      for (const s of g.panel.series) {
        if (s.noTip) continue;
        const sx = seriesX(s);
        let k: number | null = null;
        if (xb || (spec.xKind === "time" && !s.x)) k = i;
        else {
          const target = +xc!.invert(snapPx);
          let best = Infinity;
          sx.forEach((v, idx) => {
            if (s.y[idx] == null) return;
            const d = Math.abs(xNum(v) - target);
            if (d < best) (best = d), (k = idx);
          });
          if (k != null && Math.abs(xPos(sx[k]) - snapPx) > 30) k = null;
        }
        const v = k == null ? null : s.y[k];
        if (v == null && s.type === "points") continue;
        const color = (k != null && s.colors?.[k]) || s.color;
        rows.push(
          <TipRow
            key={s.key}
            color={color}
            dash={s.type === "line" && !!s.dash}
            label={s.name}
            value={
              v == null
                ? "—"
                : `${s.format ? s.format(v) : `${fmt(v, 1)}${s.unit ? ` ${s.unit}` : ""}`}${k != null && s.tipNotes?.[k] ? ` · ${s.tipNotes[k]}` : ""}`
            }
          />,
        );
      }
    }
    const extra = i != null && spec.tipExtra ? spec.tipExtra(i) : [];
    const xAt = xc ? +xc.invert(px) : null;
    const inBands = xAt == null ? [] : layout.bands.filter((b) => xAt > b.lo && xAt < b.hi);
    const bandFmt = (v: number) => (spec.xKind === "time" ? tipTime(new Date(v), spansDays(xc)) : fmt(v, 0));
    setHoverX({ px: snapPx, i });
    setTip({
      x: e.clientX - box.left,
      y: Math.min(py, layout.plotBottom - 40),
      content: (
        <>
          <div className="mb-1 font-semibold text-white">{heading}</div>
          {inBands.map((b) => (
            <div key={`${b.lo}-${b.label}`} className="mb-1 text-[11px] text-slate-400">
              {b.label} · {bandFmt(b.lo)}–{bandFmt(b.hi)}
            </div>
          ))}
          {rows}
          {extra.length > 0 && <div className="my-1 border-t border-white/10" />}
          {extra.map((r) => (
            <TipRow key={r.label} label={r.label} value={r.value} />
          ))}
        </>
      ),
    });
  };

  const legendBox =
    legend.length > 1 ? (
        <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300", legendPosition === "bottom" ? "mt-2" : "mb-1.5")}>
          {legend.map((l) =>
            canToggle && seriesNames.has(l.label) ? (
              <button
                key={l.label}
                type="button"
                onClick={() => toggle(l.label)}
                aria-pressed={!hidden.has(l.label)}
                title={hidden.has(l.label) ? t("Show {name}", { name: l.label }) : visibleCount > 1 ? t("Hide {name}", { name: l.label }) : undefined}
                className={cn("flex items-center gap-1.5 rounded transition hover:text-white", hidden.has(l.label) && "opacity-40 line-through")}
              >
                <LegendSwatch item={l} />
                {l.label}
              </button>
            ) : (
              <span key={l.label} className="flex items-center gap-1.5">
                <LegendSwatch item={l} />
                {l.label}
              </span>
            ),
          )}
        </div>
      ) : null;

  return (
    <div className="w-full">
      {legendPosition === "top" && legendBox}
      <div
        ref={ref}
        className={cn("relative w-full", brushable && "cursor-crosshair select-none")}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onMouseLeave={() => (setTip(null), setHoverX(null), setDrag(null))}
      >
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-slate-400">
            {emptyLabel}
          </div>
        )}
        {layout && (
          <svg width={width} height={height} className="block" role="img" aria-label={spec.panels.map((p) => p.title).join(", ")}>
            <defs>
              <pattern id="pc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="rgba(148,163,184,0.04)" />
                <line y2="6" stroke="rgba(148,163,184,0.16)" strokeWidth="2" />
              </pattern>
            </defs>
            <g transform={`translate(${layout.ml},0)`}>
              {/* shaded x ranges, under the series */}
              {layout.xc &&
                layout.bands.map((b) => {
                  const x0 = Math.max(0, layout.xc!(b.lo));
                  const x1 = Math.min(layout.iw, layout.xc!(b.hi));
                  if (x1 - x0 < 0.5) return null;
                  return layout.geo.map((g) => (
                    <rect key={`${b.lo}-${b.label}-${g.panel.key}`} x={x0} width={x1 - x0} y={g.top} height={g.bottom - g.top} fill={BAND_FILL[b.kind]} pointerEvents="none" />
                  ));
                })}
              {layout.geo.map((g) => (
                <PanelBody key={g.panel.key} g={g} layout={layout} spec={spec} hoverI={hoverX?.i ?? null} />
              ))}

              {/* hover crosshair */}
              {hoverX &&
                (layout.xb ? (
                  layout.geo.map((g) => (
                    <rect
                      key={g.panel.key}
                      x={hoverX.px - layout.xb!.step() / 2}
                      width={layout.xb!.step()}
                      y={g.top}
                      height={g.bottom - g.top}
                      fill="rgba(148,163,184,0.08)"
                      pointerEvents="none"
                    />
                  ))
                ) : (
                  <line
                    x1={hoverX.px}
                    x2={hoverX.px}
                    y1={layout.geo[0].top}
                    y2={layout.plotBottom}
                    stroke="rgba(203,213,225,0.45)"
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                ))}

              {/* range being dragged */}
              {drag && Math.abs(drag.x1 - drag.x0) > 1 && (
                <rect
                  x={Math.min(drag.x0, drag.x1)}
                  width={Math.abs(drag.x1 - drag.x0)}
                  y={layout.geo[0].top}
                  height={layout.plotBottom - layout.geo[0].top}
                  fill="rgba(56,189,248,0.12)"
                  stroke="rgba(56,189,248,0.6)"
                  pointerEvents="none"
                />
              )}

              {/* vertical markers */}
              {layout.xc &&
                spec.markers?.map((m) => {
                  const x = layout.xPos(m.x);
                  if (!(x >= 0 && x <= layout.iw)) return null;
                  const color = m.color ?? C.ref;
                  return (
                    <g key={m.label} pointerEvents="none">
                      <line x1={x} x2={x} y1={layout.geo[0].top} y2={layout.plotBottom} stroke={color} strokeOpacity={0.55} strokeWidth={1} />
                      <text
                        x={x + (x > layout.iw - 40 ? -4 : 4)}
                        y={layout.geo[0].top + 10}
                        textAnchor={x > layout.iw - 40 ? "end" : "start"}
                        fill={color}
                        fontSize={11}
                        fontWeight={600}
                        paintOrder="stroke"
                        stroke="#0a101c"
                        strokeWidth={3}
                      >
                        {m.label}
                      </text>
                    </g>
                  );
                })}

              <XAxis layout={layout} spec={spec} />
            </g>
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
      {legendPosition === "bottom" && legendBox}
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const PanelBody: React.FC<{ g: Layout["geo"][number]; layout: Layout; spec: PanelChartSpec; hoverI: number | null }> = ({
  g,
  layout,
  spec,
  hoverI,
}) => {
  const { panel, y, top, bottom } = g;
  const { iw, xb, xPos, xNum, seriesX, gapLimit, tickFmt } = layout;
  const ticks = panel.ticks ?? y.ticks(Math.max(2, Math.round((bottom - top) / 42)));
  const f = tickFmt(panel);
  const base = y(Math.max(y.domain()[0], Math.min(0, y.domain()[1])));
  const bars = panel.series.filter((s) => s.type === "bar");
  const inner = xb
    ? d3
        .scaleBand<string>()
        .domain(panel.stacked ? ["all"] : bars.map((s) => s.key))
        .range([0, xb.bandwidth()])
        .padding(bars.length > 1 && !panel.stacked ? 0.08 : 0)
    : null;

  /** split a line into segments at nulls and (time charts) at record gaps */
  const segments = (s: ChartSeries): Array<Array<[number, number]>> => {
    const xs = seriesX(s);
    const out: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    let prevX: number | null = null;
    xs.forEach((xv, idx) => {
      const v = s.y[idx];
      const n = xNum(xv);
      if (v == null || !Number.isFinite(v) || (prevX != null && n - prevX > gapLimit)) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      if (v != null && Number.isFinite(v)) cur.push([xPos(xv), y(v)]);
      prevX = n;
    });
    if (cur.length) out.push(cur);
    return out;
  };

  // smooth only along a continuous x; between categories a straight segment claims nothing in between
  const curve = xb ? d3.curveLinear : d3.curveMonotoneX;
  const line = d3.line().curve(curve);
  const area = d3.area().curve(curve);

  return (
    <g>
      <text x={-layout.ml + 4} y={g.titleY} fill={C.text} fontSize={12} fontWeight={600}>
        {panel.title}
      </text>
      {ticks.map((t) => (
        <g key={t} transform={`translate(0,${y(t)})`}>
          <line x2={iw} stroke={t === 0 ? C.axis : C.grid} />
          <text x={-8} dy="0.35em" textAnchor="end" fill={C.muted} fontSize={TICK_FONT} className="num">
            {f(t)}
          </text>
        </g>
      ))}

      {/* bars */}
      {xb &&
        bars.map((s) =>
          spec.x.map((xv, idx) => {
            const v = s.y[idx];
            if (v == null) return null;
            const b0 = s.y0?.[idx] ?? 0;
            const x0 = (xb(String(xv)) ?? 0) + (inner!(panel.stacked ? "all" : s.key) ?? 0);
            const w = inner!.bandwidth();
            const yTop = y(Math.max(v, b0));
            const yBot = y(Math.min(v, b0));
            const color = s.colors?.[idx] ?? s.color;
            const label = s.labels?.[idx];
            return (
              <g key={`${s.key}-${idx}`}>
                <path
                  d={barPath(x0, w, yTop, yBot, 3)}
                  fill={color}
                  fillOpacity={hoverI == null || hoverI === idx ? (s.opacity ?? 0.9) : 0.55}
                />
                {label && (
                  <text x={x0 + w / 2} y={yTop - 5} textAnchor="middle" fill={C.text} fontSize={11} fontWeight={600} className="num">
                    {label}
                  </text>
                )}
              </g>
            );
          }),
        )}

      {/* lines and areas */}
      {panel.series
        .filter((s) => s.type === "line")
        .map((s) => (
          <g key={s.key} pointerEvents="none">
            {segments(s).map((seg, k) => (
              <g key={k}>
                {s.area && (
                  <path d={area.y0(base).y1((d) => d[1])(seg) ?? ""} fill={s.color} fillOpacity={0.12} />
                )}
                <path
                  d={line(seg) ?? ""}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.width ?? 2}
                  strokeDasharray={s.dash === "dash" ? "6 4" : s.dash === "dot" ? "1.5 3.5" : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={s.opacity ?? 1}
                />
                {seg.length === 1 && <circle cx={seg[0][0]} cy={seg[0][1]} r={2.5} fill={s.color} />}
              </g>
            ))}
            {/* markers on a category axis, so each value is visible */}
            {xb &&
              s.y.map((v, idx) =>
                v == null ? null : (
                  <circle
                    key={idx}
                    cx={xPos(spec.x[idx])}
                    cy={y(v)}
                    r={hoverI === idx ? 5 : spec.x.length > 40 ? 0 : 3.5}
                    fill={s.color}
                    stroke="#0a101c"
                    strokeWidth={1.5}
                  />
                ),
              )}
            {/* hovered point on a time axis */}
            {!xb && !s.x && hoverI != null && s.y[hoverI] != null && (
              <circle cx={xPos(spec.x[hoverI])} cy={y(s.y[hoverI] as number)} r={4} fill={s.color} stroke="#0a101c" strokeWidth={1.5} />
            )}
          </g>
        ))}

      {/* points */}
      {panel.series
        .filter((s) => s.type === "points")
        .map((s) => {
          const xs = seriesX(s);
          const size = s.size ?? 8;
          return (
            <g key={s.key} pointerEvents="none">
              {xs.map((xv, idx) => {
                const v = s.y[idx];
                if (v == null) return null;
                const cx = xPos(xv);
                const cy = y(v);
                const color = s.colors?.[idx] ?? s.color;
                if (s.symbol === "diamond")
                  return (
                    <path
                      key={idx}
                      transform={`translate(${cx},${cy})`}
                      d={d3.symbol(d3.symbolDiamond, size * size * 0.9)() ?? ""}
                      fill={color}
                      stroke="#0a101c"
                      strokeWidth={1.5}
                    />
                  );
                if (s.symbol === "ring")
                  return <circle key={idx} cx={cx} cy={cy} r={size / 2} fill="none" stroke={color} strokeWidth={2} />;
                return (
                  <circle key={idx} cx={cx} cy={cy} r={size / 2} fill={color} fillOpacity={s.opacity ?? 1} stroke="#0a101c" strokeWidth={1} />
                );
              })}
            </g>
          );
        })}

      {/* reference lines */}
      {panel.refLines?.map((r) => (
        <g key={r.label} transform={`translate(0,${y(r.y)})`} pointerEvents="none">
          <line x2={iw} stroke={r.color ?? C.ref} strokeOpacity={0.8} strokeWidth={1.5} strokeDasharray="6 4" />
          <text x={iw - 4} y={-5} textAnchor="end" fill={C.text} fontSize={11} fontWeight={600} className="num" paintOrder="stroke" stroke="#0a101c" strokeWidth={3}>
            {r.label}
          </text>
        </g>
      ))}
    </g>
  );
};

const XAxis: React.FC<{ layout: Layout; spec: PanelChartSpec }> = ({ layout, spec }) => {
  const { xb, xc, iw, plotBottom, rotate, every, bandLabels } = layout;
  const yTick = plotBottom + 17;
  return (
    <g pointerEvents="none">
      <line x2={iw} y1={plotBottom} y2={plotBottom} stroke={C.axis} />
      {xb
        ? spec.x.map((v, idx) => {
            if (idx % every !== 0) return null;
            const raw = bandLabels[idx];
            const s = rotate && raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
            const x = (xb(String(v)) ?? 0) + xb.bandwidth() / 2;
            return rotate ? (
              <text
                key={idx}
                transform={`translate(${x},${plotBottom + 10}) rotate(-40)`}
                textAnchor="end"
                fill={C.muted}
                fontSize={11}
                className="num"
              >
                {s}
              </text>
            ) : (
              <text key={idx} x={x} y={yTick} textAnchor="middle" fill={C.muted} fontSize={TICK_FONT} className="num">
                {s}
              </text>
            );
          })
        : (xc as d3.ScaleLinear<number, number>).ticks(Math.max(2, Math.floor(iw / 80))).map((t) => {
            const x = (xc as d3.ScaleLinear<number, number>)(t);
            const label = spec.xKind === "time" ? tickTime(new Date(+t), spansDays(xc)) : d3.format("~s")(+t);
            return (
              <g key={+t} transform={`translate(${x},${plotBottom})`}>
                <line y2={5} stroke={C.axis} />
                <text y={17} textAnchor="middle" fill={C.muted} fontSize={TICK_FONT} className="num">
                  {label}
                </text>
              </g>
            );
          })}
      {spec.xLabel && (
        <text x={iw / 2} y={plotBottom + layout.mb - 4} textAnchor="middle" fill={C.muted} fontSize={12}>
          {spec.xLabel}
        </text>
      )}
    </g>
  );
};
