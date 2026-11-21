/**
 * Engineering O&M charts PanelChart cannot draw (its tooltip follows x only):
 * - YieldHeatmap: site × report day, coloured by specific yield, outage and missing readings marked,
 *   days with a curtailment remark ticked; a row opens the site's days on click.
 * - WeatherBoxPlot: specific yield of the sites' producing days by the report's weather word, per phase.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { PwaDayStatus, PwaMeterDaily, PwaWeather } from "../../api/client";
import { C, TICK_FONT, TipRow, Tooltip, textWidth, useWidth } from "../../components/chartKit";
import type { TipState } from "../../components/chartKit";
import { STATUS } from "../../components/chartTheme";
import { fmt, fmtInt } from "../../components/ui";
import { DAY_STATUS, WEATHER } from "../pwaMeter/format";
import { PHASE_COLOR } from "./chartSpecs";
import { fmtDay } from "./format";
import { dateLocale, useI18n } from "../../i18n";

export const Legend: React.FC<{ items: ReadonlyArray<{ label: string; color: string }>; note?: string }> = ({ items, note }) => {
  const { t } = useI18n();
  return (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {items.map((i) => (
      <span key={i.label} className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-full" style={{ background: i.color }} />
        {t(i.label)}
      </span>
    ))}
    {note && <span>{note}</span>}
  </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Site × day heatmap                                                         */
/* -------------------------------------------------------------------------- */
/** one hue, dark → blue (0 → high yield): a weak day reads as a dark cell */
const yieldInterp = d3.interpolateRgbBasis(["#0d131c", "#13294a", "#1d559c", "#2f80e8"]);
/** fixed top of the colour scale (kWh/kWp per day), so periods and phases compare at a glance */
export const HEAT_MAX = 6;
const GAP_COLOR = "#3c414b";
export const HEAT_LEGEND = [
  { label: "Low yield", color: yieldInterp(0.05) },
  { label: `High yield (${HEAT_MAX}+)`, color: yieldInterp(1) },
  { label: "Outage", color: STATUS.crit },
  { label: "Data missing", color: GAP_COLOR },
  { label: "Curtailment note (top tick)", color: STATUS.warn },
] as const;
const monthTick = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(dateLocale(), { month: "short" });

export const YieldHeatmap: React.FC<{
  daily: PwaMeterDaily;
  /** site ids in the order to draw, top first (the sites list's loss rank); others are left out */
  order: string[];
  onOpen: (siteId: string) => void;
}> = ({ daily, order, onOpen }) => {
  const { t } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const rows = useMemo(() => {
    const by = new Map(daily.sites.map((s) => [s.site_id, s]));
    return order.map((id) => by.get(id)).filter((s): s is NonNullable<typeof s> => s != null);
  }, [daily, order]);
  const days = daily.days;
  const top = 20;
  const rowH = Math.max(4, Math.min(16, Math.floor(560 / Math.max(1, rows.length))));
  const height = top + rows.length * rowH;
  const cw = days.length ? width / days.length : 0;

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || width <= 0 || !days.length) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const color = d3.scaleSequential(yieldInterp).domain([0, HEAT_MAX]).clamp(true);
    const gap = rowH >= 6 ? 1 : 0;
    rows.forEach((s, i) => {
      const y = top + i * rowH;
      days.forEach((_, j) => {
        const st = s.status[j];
        if (st == null) return;
        const v = s.yield_kwh_kwp[j];
        ctx.fillStyle = st === "outage" ? STATUS.crit : st !== "ok" || v == null ? GAP_COLOR : color(v);
        const w = Math.max(1, cw - (cw > 4 ? 1 : 0));
        ctx.fillRect(j * cw, y, w, rowH - gap);
        // the report's remark says curtailed (หรี่): a tick along the cell's top edge
        if (s.curtailment?.[j]) {
          ctx.fillStyle = STATUS.warn;
          ctx.fillRect(j * cw, y, w, Math.max(1, Math.round((rowH - gap) * 0.3)));
        }
      });
    });
    ctx.fillStyle = C.muted;
    ctx.font = `11px ${getComputedStyle(cv).fontFamily}`;
    ctx.textBaseline = "top";
    // a long period gets a label per month (at its first report day), a short one per few days
    let last = -Infinity;
    const byMonth = days.length > 45;
    days.forEach((d, j) => {
      const x = j * cw;
      if (byMonth ? j > 0 && d.slice(0, 7) === days[j - 1].slice(0, 7) : x - last < 52) return;
      if (x - last < 30 || x + 30 > width) return;
      last = x;
      ctx.fillText(byMonth ? monthTick(d) : fmtDay(d), x + 1, 3);
    });
  }, [rows, days, width, height, cw, rowH]);

  const hit = (e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const i = Math.floor((e.clientY - box.top - top) / rowH);
    const j = Math.floor((e.clientX - box.left) / (cw || 1));
    if (i < 0 || i >= rows.length || j < 0 || j >= days.length) return null;
    return { s: rows[i], j, x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const onMove = (e: React.MouseEvent) => {
    const h = hit(e);
    if (!h) return setTip(null);
    const st = h.s.status[h.j] as PwaDayStatus | null;
    const v = h.s.yield_kwh_kwp[h.j];
    setTip({
      x: h.x,
      y: h.y,
      content: (
        <>
          <div className="mb-1 font-semibold text-white">{h.s.name}</div>
          <div className="mb-1 text-xs text-slate-400">
            {t("Phase {n}", { n: h.s.phase })}
            {h.s.region ? ` · ${h.s.region}` : ""} · {fmtDay(days[h.j])}
          </div>
          <TipRow label={t("Yield")} value={v == null ? "—" : `${fmt(v, 2)} kWh/kWp`} />
          <TipRow label={t("Day")} value={st == null ? t("No report row") : t(DAY_STATUS[st].label)} />
          {h.s.weather?.[h.j] && <TipRow label={t("Weather")} value={t(WEATHER[h.s.weather[h.j]!] ?? h.s.weather[h.j]!)} />}
          {h.s.curtailment?.[h.j] && <TipRow color={STATUS.warn} label={t("Curtailment note")} value={t("Yes")} />}
        </>
      ),
    });
  };

  return (
    <div
      ref={ref}
      className="relative w-full cursor-pointer"
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setTip(null)}
      onClick={(e) => {
        const h = hit(e);
        if (h) onOpen(h.s.site_id);
      }}
    >
      <canvas ref={canvas} className="block" style={{ width: "100%", height }} role="img" aria-label={t("Specific yield per site and report day, {n} sites over {d} days", { n: rows.length, d: days.length })} />
      <Tooltip tip={tip} width={width} />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Weather impact: box plot of specific yield by the report's weather          */
/* -------------------------------------------------------------------------- */
const WEATHER_ORDER: PwaWeather[] = ["clear", "cloudy", "rain"];

export interface WeatherBox {
  weather: PwaWeather;
  phase: number;
  /** site-days in the box */
  n: number;
  sites: number;
  p05: number;
  q1: number;
  median: number;
  q3: number;
  p95: number;
}

/** Specific yield (meter kWh ÷ kWp, measured) of the given sites' producing days, grouped by the
 * report's weather word and phase. Left out: days that are not `ok` (outage, a missing reading), days
 * with no weather word and days whose remark says curtailed, so the boxes show the weather, not
 * faults or zero export. A group needs `minDays` site-days. */
export const weatherBoxes = (daily: PwaMeterDaily, siteIds: ReadonlySet<string>, minDays = 5): WeatherBox[] => {
  const groups = new Map<string, { weather: PwaWeather; phase: number; v: number[]; sites: Set<string> }>();
  for (const s of daily.sites) {
    if (!siteIds.has(s.site_id)) continue;
    s.yield_kwh_kwp.forEach((v, j) => {
      const w = s.weather?.[j];
      if (v == null || w == null || s.status[j] !== "ok" || s.curtailment?.[j]) return;
      const key = `${w}|${s.phase}`;
      const g = groups.get(key) ?? { weather: w, phase: s.phase, v: [], sites: new Set<string>() };
      g.v.push(v);
      g.sites.add(s.site_id);
      groups.set(key, g);
    });
  }
  const out: WeatherBox[] = [];
  for (const g of groups.values()) {
    if (g.v.length < minDays) continue;
    const v = g.v.sort((a, b) => a - b);
    const q = (p: number) => d3.quantileSorted(v, p)!;
    out.push({ weather: g.weather, phase: g.phase, n: v.length, sites: g.sites.size, p05: q(0.05), q1: q(0.25), median: q(0.5), q3: q(0.75), p95: q(0.95) });
  }
  return out.sort((a, b) => WEATHER_ORDER.indexOf(a.weather) - WEATHER_ORDER.indexOf(b.weather) || a.phase - b.phase);
};

export const WeatherBoxPlot: React.FC<{ boxes: WeatherBox[]; height?: number }> = ({ boxes, height = 300 }) => {
  const { t } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const weathers = WEATHER_ORDER.filter((w) => boxes.some((b) => b.weather === w));
  const phases = [...new Set(boxes.map((b) => b.phase))].sort();
  const m = { top: 24, right: 12, bottom: 46, left: 44 };
  const iw = Math.max(0, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const x = d3.scaleBand<string>().domain(weathers).range([0, iw]).paddingInner(0.25).paddingOuter(0.15);
  const xi = d3.scaleBand<string>().domain(phases.map(String)).range([0, x.bandwidth()]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(boxes, (b) => b.p95) ?? 1]).nice().range([ih, 0]);
  const ticks = y.ticks(5);
  const fmtY = (v: number) => `${fmt(v, 2)} kWh/kWp`;

  const show = (b: WeatherBox, e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    setTip({
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      content: (
        <>
          <div className="mb-1 font-semibold text-white">
            {t(WEATHER[b.weather] ?? b.weather)} · {t("Phase {n}", { n: b.phase })}
          </div>
          <TipRow label={t("Median")} value={fmtY(b.median)} />
          <TipRow label={t("Middle half (P25–P75)")} value={`${fmt(b.q1, 2)} – ${fmt(b.q3, 2)}`} />
          <TipRow label={t("P5–P95")} value={`${fmt(b.p05, 2)} – ${fmt(b.p95, 2)}`} />
          <TipRow label={t("Site-days")} value={fmtInt(b.n)} />
          <TipRow label={t("Sites")} value={fmtInt(b.sites)} />
        </>
      ),
    });
  };

  return (
    <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={t("Specific yield of producing days by weather, per phase")}>
          <g transform={`translate(${m.left},${m.top})`}>
            {ticks.map((v) => (
              <g key={v} transform={`translate(0,${y(v)})`}>
                <line x1={0} x2={iw} stroke={C.grid} />
                <text x={-6} dy="0.32em" textAnchor="end" fontSize={TICK_FONT - 1} fill={C.muted}>
                  {fmt(v, v % 1 ? 1 : 0)}
                </text>
              </g>
            ))}
            <text x={-m.left + 2} y={-10} fontSize={TICK_FONT - 1} fill={C.muted}>
              kWh/kWp
            </text>
            {weathers.map((w) => (
              <g key={w} transform={`translate(${x(w)},0)`}>
                <text x={x.bandwidth() / 2} y={ih + 32} textAnchor="middle" fontSize={TICK_FONT} fill={C.text}>
                  {t(WEATHER[w] ?? w)}
                </text>
                {boxes
                  .filter((b) => b.weather === w)
                  .map((b) => {
                    const bx = xi(String(b.phase)) ?? 0;
                    const bw = xi.bandwidth();
                    const cx = bx + bw / 2;
                    const color = PHASE_COLOR[b.phase] ?? C.muted;
                    return (
                      <g key={b.phase} onMouseMove={(e) => show(b, e)}>
                        <rect x={bx} y={0} width={bw} height={ih} fill="transparent" />
                        <line x1={cx} x2={cx} y1={y(b.p95)} y2={y(b.q3)} stroke={color} />
                        <line x1={cx} x2={cx} y1={y(b.q1)} y2={y(b.p05)} stroke={color} />
                        {[b.p05, b.p95].map((v, k) => (
                          <line key={k} x1={cx - bw / 4} x2={cx + bw / 4} y1={y(v)} y2={y(v)} stroke={color} />
                        ))}
                        <rect x={bx} y={y(b.q3)} width={bw} height={Math.max(1, y(b.q1) - y(b.q3))} fill={color} fillOpacity={0.28} stroke={color} rx={2} />
                        <line x1={bx} x2={bx + bw} y1={y(b.median)} y2={y(b.median)} stroke={C.ref} strokeWidth={2} />
                        {bw >= textWidth("n = 9,999", TICK_FONT - 2) && (
                          <text x={cx} y={ih + 14} textAnchor="middle" fontSize={TICK_FONT - 2} fill={C.muted}>
                            n = {fmtInt(b.n)}
                          </text>
                        )}
                      </g>
                    );
                  })}
              </g>
            ))}
            <line x1={0} x2={iw} y1={ih} y2={ih} stroke={C.axis} />
          </g>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
};
