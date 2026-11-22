/**
 * Engineering O&M charts PanelChart cannot draw (its tooltip follows x only):
 * - YieldHeatmap: site × report day, coloured by specific yield, outage and missing readings marked,
 *   days with a curtailment remark ticked; a row opens the site's days on click.
 * - YieldBoxPlot: specific yield of the sites' producing days per category (the report's weather word,
 *   or the calendar month), one box per phase.
 * - RankBars: the sites lowest against the contract, a bar each; a row opens the site on click.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { PwaDayStatus, PwaMeterDaily, PwaMeterSiteDaily, PwaWeather } from "../../api/client";
import { C, TICK_FONT, TipRow, Tooltip, textWidth, useWidth } from "../../components/chartKit";
import type { TipState } from "../../components/chartKit";
import { STATUS } from "../../components/chartTheme";
import { fmt, fmtInt } from "../../components/ui";
import { DAY_STATUS, WEATHER } from "../pwaMeter/format";
import { PHASE_COLOR } from "./chartSpecs";
import { fmtDay } from "./format";
import { dateLocale, translate, useI18n } from "../../i18n";

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
/* Specific yield distribution: box plots by weather or by month               */
/* -------------------------------------------------------------------------- */
const WEATHER_ORDER: PwaWeather[] = ["clear", "cloudy", "rain"];

export interface YieldBox {
  /** the weather word or the month (YYYY-MM) */
  cat: string;
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

/** A site-day counts when it has a reading and the report calls it producing normally (`ok`): outage
 * days, days with a missing reading and days whose remark says curtailed are left out, so a box shows
 * the weather or the season, not faults or zero export. A group needs `minDays` site-days. */
const yieldBoxes = (daily: PwaMeterDaily, siteIds: ReadonlySet<string>, catOf: (s: PwaMeterSiteDaily, j: number) => string | null, minDays: number): YieldBox[] => {
  const groups = new Map<string, { cat: string; phase: number; v: number[]; sites: Set<string> }>();
  for (const s of daily.sites) {
    if (!siteIds.has(s.site_id)) continue;
    s.yield_kwh_kwp.forEach((v, j) => {
      if (v == null || s.status[j] !== "ok" || s.curtailment?.[j]) return;
      const cat = catOf(s, j);
      if (cat == null) return;
      const key = `${cat}|${s.phase}`;
      const g = groups.get(key) ?? { cat, phase: s.phase, v: [], sites: new Set<string>() };
      g.v.push(v);
      g.sites.add(s.site_id);
      groups.set(key, g);
    });
  }
  const out: YieldBox[] = [];
  for (const g of groups.values()) {
    if (g.v.length < minDays) continue;
    const v = g.v.sort((a, b) => a - b);
    const q = (p: number) => d3.quantileSorted(v, p)!;
    out.push({ cat: g.cat, phase: g.phase, n: v.length, sites: g.sites.size, p05: q(0.05), q1: q(0.25), median: q(0.5), q3: q(0.75), p95: q(0.95) });
  }
  return out;
};

/** Specific yield (meter kWh ÷ kWp, measured) of the sites' producing days by the report's weather
 * word; days with no weather word are left out too. */
export const weatherBoxes = (daily: PwaMeterDaily, siteIds: ReadonlySet<string>, minDays = 5): YieldBox[] =>
  yieldBoxes(daily, siteIds, (s, j) => s.weather?.[j] ?? null, minDays).sort(
    (a, b) => WEATHER_ORDER.indexOf(a.cat as PwaWeather) - WEATHER_ORDER.indexOf(b.cat as PwaWeather) || a.phase - b.phase
  );

/** The same by calendar month of the report day (A4: normalised for site size, so seasons and drift show). */
export const monthBoxes = (daily: PwaMeterDaily, siteIds: ReadonlySet<string>, minDays = 5): YieldBox[] =>
  yieldBoxes(daily, siteIds, (_, j) => daily.days[j]?.slice(0, 7) ?? null, minDays).sort((a, b) => a.cat.localeCompare(b.cat) || a.phase - b.phase);

export const weatherLabel = (c: string) => translate(WEATHER[c as PwaWeather] ?? c);

export const YieldBoxPlot: React.FC<{ boxes: YieldBox[]; catLabel: (cat: string) => string; ariaLabel: string; height?: number }> = ({ boxes, catLabel, ariaLabel, height = 300 }) => {
  const { t } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const cats = [...new Set(boxes.map((b) => b.cat))];
  const phases = [...new Set(boxes.map((b) => b.phase))].sort();
  const m = { top: 24, right: 12, bottom: 46, left: 44 };
  const iw = Math.max(0, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const x = d3.scaleBand<string>().domain(cats).range([0, iw]).paddingInner(0.25).paddingOuter(0.15);
  const xi = d3.scaleBand<string>().domain(phases.map(String)).range([0, x.bandwidth()]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(boxes, (b) => b.p95) ?? 1]).nice().range([ih, 0]);
  const ticks = y.ticks(5);
  const fmtY = (v: number) => `${fmt(v, 2)} kWh/kWp`;
  // category labels: every one while they fit, else every k-th
  const every = Math.max(1, Math.ceil((d3.max(cats, (c) => textWidth(catLabel(c))) ?? 0) / Math.max(1, x.step() - 6)));

  const show = (b: YieldBox, e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    setTip({
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      content: (
        <>
          <div className="mb-1 font-semibold text-white">
            {catLabel(b.cat)} · {t("Phase {n}", { n: b.phase })}
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
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
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
            {cats.map((c, ci) => (
              <g key={c} transform={`translate(${x(c)},0)`}>
                {ci % every === 0 && (
                  <text x={x.bandwidth() / 2} y={ih + 32} textAnchor="middle" fontSize={TICK_FONT} fill={C.text}>
                    {catLabel(c)}
                  </text>
                )}
                {boxes
                  .filter((b) => b.cat === c)
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

/* -------------------------------------------------------------------------- */
/* Ranking: the sites lowest against the contract                              */
/* -------------------------------------------------------------------------- */
export interface RankRow {
  site_id: string;
  name: string;
  phase: number;
  region: string | null;
  /** billed ÷ contract on the days with a contract figure, % */
  pct: number;
  billed_kwh: number | null;
  /** modelled */
  contract_kwh: number | null;
  missing_days: number;
  outage_days: number;
}

/** The `n` lowest rows by `pct` (rows without a contract figure are not ranked). */
export const lowestRows = <T extends { vs_contract_pct: number | null }>(rows: T[], n: number): T[] =>
  rows
    .filter((r) => r.vs_contract_pct != null)
    .sort((a, b) => a.vs_contract_pct! - b.vs_contract_pct!)
    .slice(0, n);

/** One horizontal bar per site from 0 to billed ÷ contract, coloured by the criteria file's lines
 * (under `watch` red, under `good` amber); the contract (100 %) and the lines drawn across. */
export const RankBars: React.FC<{ rows: RankRow[]; bands: { good: number; watch: number } | null; onOpen: (siteId: string) => void }> = ({ rows, bands, onOpen }) => {
  const { t } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const rowH = 20;
  const m = { top: 18, right: 62, bottom: 22, left: Math.min(200, Math.max(110, width * 0.36)) };
  const height = m.top + m.bottom + rows.length * rowH;
  const iw = Math.max(0, width - m.left - m.right);
  const x = d3.scaleLinear().domain([0, Math.max(105, d3.max(rows, (r) => r.pct) ?? 100)]).nice().range([0, iw]);
  const lines = [{ v: 100, label: t("Contract"), color: C.ref }, ...(bands ? [{ v: bands.good, label: `${fmt(bands.good, 0)} %`, color: STATUS.warn }, { v: bands.watch, label: `${fmt(bands.watch, 0)} %`, color: STATUS.crit }] : [])];
  const tone = (p: number) => (!bands ? C.muted : p < bands.watch ? STATUS.crit : p < bands.good ? STATUS.warn : STATUS.good);
  const maxChars = Math.max(6, Math.floor((m.left - 10) / (TICK_FONT * 0.6)));
  const clip = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  const mwh = (v: number | null) => (v == null ? "—" : `${fmt(v / 1000, 2)} MWh`);

  const show = (r: RankRow, e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    setTip({
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      content: (
        <>
          <div className="mb-1 font-semibold text-white">{r.name}</div>
          <TipRow label={t("Phase")} value={String(r.phase)} />
          {r.region && <TipRow label={t("Region")} value={r.region} />}
          <TipRow label={t("Billed ÷ contract")} value={`${fmt(r.pct, 1)} %`} />
          <TipRow label={t("Billed")} value={mwh(r.billed_kwh)} />
          <TipRow label={t("Contract (modelled)")} value={mwh(r.contract_kwh)} />
          <TipRow label={t("Outage days")} value={fmtInt(r.outage_days)} />
          <TipRow label={t("Days without a reading")} value={fmtInt(r.missing_days)} />
          <div className="mt-1 text-slate-400">{t("Click to open the site")}</div>
        </>
      ),
    });
  };

  return (
    <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={t("Sites lowest against the contract")}>
          <g transform={`translate(${m.left},${m.top})`}>
            {x.ticks(5).map((v) => (
              <g key={v} transform={`translate(${x(v)},0)`}>
                <line y1={0} y2={rows.length * rowH} stroke={C.grid} />
                <text y={rows.length * rowH + 14} textAnchor="middle" fontSize={TICK_FONT - 1} fill={C.muted}>
                  {fmt(v, 0)} %
                </text>
              </g>
            ))}
            {rows.map((r, i) => (
              <g key={r.site_id} transform={`translate(0,${i * rowH})`} className="cursor-pointer" onMouseMove={(e) => show(r, e)} onClick={() => onOpen(r.site_id)}>
                <rect x={-m.left} y={0} width={width} height={rowH} fill="transparent" />
                <text x={-8} y={rowH / 2} dy="0.32em" textAnchor="end" fontSize={TICK_FONT} fill={C.text}>
                  {clip(r.name)}
                </text>
                <rect x={0} y={4} width={Math.max(1, x(Math.max(0, r.pct)))} height={rowH - 8} rx={2} fill={tone(r.pct)} fillOpacity={0.75} />
                {/* the value in a column right of the plot, clear of the reference lines; * = days without a reading */}
                <text x={iw + m.right - 4} y={rowH / 2} dy="0.32em" textAnchor="end" fontSize={TICK_FONT - 1} fill={r.missing_days > 0 ? C.muted : C.text}>
                  {fmt(r.pct, 1)} %{r.missing_days > 0 ? "*" : ""}
                </text>
              </g>
            ))}
            {lines.map((l, k) => (
              <g key={l.v} transform={`translate(${x(l.v)},0)`}>
                <line y1={-4} y2={rows.length * rowH} stroke={l.color} strokeDasharray="4 3" />
                {/* label above the plot, left out when it would print over the previous line's */}
                {(k === 0 || Math.abs(x(l.v) - x(lines[k - 1].v)) > textWidth(l.label, TICK_FONT - 2) + 4) && (
                  <text y={-8} textAnchor="middle" fontSize={TICK_FONT - 2} fill={l.color}>
                    {l.label}
                  </text>
                )}
              </g>
            ))}
          </g>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
};
