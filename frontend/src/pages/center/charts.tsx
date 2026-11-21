/**
 * Engineering O&M charts PanelChart cannot draw (its tooltip follows x only):
 * - StrategyMatrix: one dot per meter-report site, estimated loss against its share of PVsyst
 * - YieldHeatmap: site × report day, coloured by specific yield, outage and missing readings marked
 * Both open the site's days on click. Loss is estimated, PVsyst modelled; the cards say so.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { PwaDayStatus, PwaMeterDaily, PwaMeterSiteSummary } from "../../api/client";
import { C, TICK_FONT, TipRow, Tooltip, textWidth, useWidth } from "../../components/chartKit";
import type { TipState } from "../../components/chartKit";
import { CATEGORICAL, STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { DAY_STATUS } from "../pwaMeter/format";
import { fmtDay, thb } from "./format";
import { dateLocale, useI18n } from "../../i18n";

/** who is to act on a site's issues: curtailment is a PM matter, the rest O&M */
export const OWNERS = [
  { key: "O&M", label: "O&M to act", color: CATEGORICAL[1] },
  { key: "PM", label: "PM (curtailment)", color: CATEGORICAL[4] },
  { key: "PM + O&M", label: "PM + O&M", color: CATEGORICAL[2] },
  { key: "", label: "No issue flagged", color: STATUS.none },
] as const;
const ownerColor = (o: string | null) => OWNERS.find((x) => x.key === (o ?? ""))?.color ?? STATUS.none;

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
/* Strategy matrix                                                            */
/* -------------------------------------------------------------------------- */
export const StrategyMatrix: React.FC<{ sites: PwaMeterSiteSummary[]; onOpen: (siteId: string) => void; height?: number }> = ({ sites, onOpen, height = 340 }) => {
  const { t } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const pts = useMemo(() => sites.filter((s) => s.loss_thb != null && s.vs_pvsyst_pct != null), [sites]);
  const g = useMemo(() => {
    if (width <= 0 || !pts.length) return null;
    const yLo = Math.min(0, d3.min(pts, (s) => s.vs_pvsyst_pct as number) ?? 0);
    const yHi = Math.max(100, d3.max(pts, (s) => s.vs_pvsyst_pct as number) ?? 100);
    const y0 = d3.scaleLinear().domain([yLo, yHi]).nice();
    const yTicks = y0.ticks(5);
    const m = { t: 12, r: 16, b: 40, l: Math.max(40, (d3.max(yTicks, (t) => textWidth(`${t} %`)) ?? 30) + 12) };
    const iw = Math.max(40, width - m.l - m.r);
    const ih = height - m.t - m.b;
    // square-root x: most sites lose little, a few lose a lot
    const x = d3.scaleSqrt().domain([0, (d3.max(pts, (s) => s.loss_thb as number) || 1) * 1.05]).range([0, iw]);
    const y = y0.range([ih, 0]);
    const r = d3.scaleSqrt().domain([0, d3.max(pts, (s) => s.kwp ?? 0) || 1]).range([3, 11]);
    const xTicks = x.ticks(Math.max(3, Math.floor(iw / 90))).filter((t, i, a) => i === 0 || x(t) - x(a[i - 1]) > 44);
    return { m, iw, ih, x, y, r, xTicks, yTicks };
  }, [pts, width, height]);

  const nearest = (e: React.MouseEvent) => {
    if (!g) return null;
    const box = ref.current!.getBoundingClientRect();
    const px = e.clientX - box.left - g.m.l;
    const py = e.clientY - box.top - g.m.t;
    let best: PwaMeterSiteSummary | null = null;
    let bd = 22;
    for (const s of pts) {
      const d = Math.hypot(g.x(s.loss_thb as number) - px, g.y(s.vs_pvsyst_pct as number) - py);
      if (d < bd) (bd = d), (best = s);
    }
    return { best, x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const onMove = (e: React.MouseEvent) => {
    const n = nearest(e);
    if (!n?.best) return (setTip(null), setHover(null));
    const s = n.best;
    setHover(s.site_id);
    setTip({
      x: n.x,
      y: n.y,
      content: (
        <>
          <div className="mb-1 font-semibold text-white">{s.name}</div>
          <div className="mb-1 text-xs text-slate-400">
            {t("Phase {n}", { n: s.phase })}
            {s.region ? ` · ${s.region}` : ""} · {fmt(s.kwp, 0)} kWp
          </div>
          <TipRow label={t("Loss (est.)")} value={thb(s.loss_thb)} />
          <TipRow label={t("vs PVsyst (mod.)")} value={`${fmt(s.vs_pvsyst_pct, 1)} %`} />
          <TipRow label={t("vs contract (mod.)")} value={s.vs_contract_pct == null ? "—" : `${fmt(s.vs_contract_pct, 1)} %`} />
          <TipRow color={ownerColor(s.owner)} label={t("Owner")} value={s.owner ?? "—"} />
          {s.issues.length > 0 && <div className="mt-1 text-xs text-slate-300">{s.issues.join(" · ")}</div>}
        </>
      ),
    });
  };

  return (
    <div
      ref={ref}
      className={`relative w-full ${hover ? "cursor-pointer" : ""}`}
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => (setTip(null), setHover(null))}
      onClick={(e) => {
        const n = nearest(e);
        if (n?.best) onOpen(n.best.site_id);
      }}
    >
      {g && (
        <svg width={width} height={height} className="block" role="img" aria-label={t("Meter report sites: estimated loss in baht against energy as a share of PVsyst")}>
          <g transform={`translate(${g.m.l},${g.m.t})`}>
            {g.yTicks.map((t) => (
              <g key={t} transform={`translate(0,${g.y(t)})`}>
                <line x2={g.iw} stroke={t === 100 ? C.axis : C.grid} strokeDasharray={t === 100 ? "4 3" : undefined} />
                <text x={-8} dy="0.32em" textAnchor="end" fontSize={TICK_FONT} fill={C.muted}>
                  {t} %
                </text>
              </g>
            ))}
            {g.xTicks.map((t) => (
              <g key={t} transform={`translate(${g.x(t)},${g.ih})`}>
                <line y2={5} stroke={C.axis} />
                <text y={18} textAnchor="middle" fontSize={TICK_FONT} fill={C.muted}>
                  {t >= 1000 ? `฿${d3.format("~s")(t)}` : `฿${t}`}
                </text>
              </g>
            ))}
            <line y1={g.ih} y2={g.ih} x2={g.iw} stroke={C.axis} />
            <text x={g.iw} y={g.ih + 34} textAnchor="end" fontSize={11} fill={C.muted}>
              {t("Estimated loss in the period (฿, square-root scale)")}
            </text>
            {pts.map((s) => (
              <circle
                key={s.site_id}
                cx={g.x(s.loss_thb as number)}
                cy={g.y(s.vs_pvsyst_pct as number)}
                r={g.r(s.kwp ?? 0)}
                fill={ownerColor(s.owner)}
                fillOpacity={hover == null || hover === s.site_id ? 0.8 : 0.35}
                stroke={hover === s.site_id ? "#ffffff" : "#0a101c"}
                strokeWidth={hover === s.site_id ? 1.5 : 1}
              />
            ))}
          </g>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
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
        ctx.fillRect(j * cw, y, Math.max(1, cw - (cw > 4 ? 1 : 0)), rowH - gap);
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
