/**
 * Engineering O&M charts PanelChart cannot draw (its tooltip follows x only):
 * - YieldHeatmap: site × report day, coloured by specific yield, outage and missing readings marked;
 *   a row opens the site's days on click.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { PwaDayStatus, PwaMeterDaily } from "../../api/client";
import { C, TICK_FONT, TipRow, Tooltip, textWidth, useWidth } from "../../components/chartKit";
import type { TipState } from "../../components/chartKit";
import { STATUS } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { DAY_STATUS } from "../pwaMeter/format";
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
