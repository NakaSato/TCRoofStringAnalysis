/**
 * Hand-built D3 charts (D3 does the maths: scales, ticks, shapes; React renders the SVG).
 * - ComparisonBars: horizontal bars vs an average line
 * - StringHeatmap: string current × time slot, with per-slot median comparison
 * - DailyTrendChart: daily bars + plant-average line, and % of average in its own panel
 * Missing values are never drawn as 0: a null cell / bar / point is left empty.
 */
import React, { useMemo, useState } from "react";
import * as d3 from "d3";
import { fmt } from "./ui";
import { C, TICK_FONT, TipRow, Tooltip, textWidth, useWidth } from "./chartKit";
import type { TipState } from "./chartKit";
import { PanelChart } from "./PanelChart";
import type { PanelChartSpec } from "./PanelChart";
import { SERIES } from "./chartTheme";

/* -------------------------------------------------------------------------- */
/* 1. Horizontal comparison bars                                              */
/* -------------------------------------------------------------------------- */
/** Horizontal bar: square at the baseline, rounded at the value end. */
function hBarPath(w: number, y: number, h: number, r: number) {
  if (w <= 0 || h <= 0) return "";
  const rr = Math.min(r, h / 2, w);
  return `M0,${y}H${w - rr}Q${w},${y} ${w},${y + rr}V${y + h - rr}Q${w},${y + h} ${w - rr},${y + h}H0Z`;
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** extra lines for the tooltip */
  detail?: Array<{ label: string; value: string }>;
}

export const ComparisonBars: React.FC<{
  rows: BarRow[];
  average: number;
  unit: string;
  selectedKey?: string | null;
  /** value / average below this share is flagged (rose) */
  lowShare?: number;
}> = ({ rows, average, unit, selectedKey, lowShare = 0.9 }) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const rowH = 26;
  const labelW = Math.min(150, Math.max(48, d3.max(rows, (r) => textWidth(r.label)) ?? 48) + 8);
  const m = { t: 22, r: 52, b: 28, l: labelW };
  const height = m.t + m.b + rows.length * rowH;
  const iw = Math.max(0, width - m.l - m.r);

  const x = useMemo(
    () => d3.scaleLinear().domain([0, (d3.max(rows, (r) => r.value) ?? 1) * 1.05]).nice().range([0, iw]),
    [rows, iw],
  );
  const y = useMemo(
    () => d3.scaleBand().domain(rows.map((r) => r.key)).range([0, rows.length * rowH]).padding(rows.length < 4 ? 0.5 : 0.28),
    [rows],
  );
  const ticks = x.ticks(Math.max(2, Math.floor(iw / 80)));

  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => (setTip(null), setHover(null))}>
      {width > 0 && (
        <svg width={width} height={height} className="block">
          <g transform={`translate(${m.l},${m.t})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(${x(t)},0)`}>
                <line y2={rows.length * rowH} stroke={C.grid} />
                <text y={rows.length * rowH + 18} textAnchor="middle" fill={C.muted} fontSize={TICK_FONT} className="num">
                  {d3.format("~s")(t)}
                </text>
              </g>
            ))}
            <text x={iw} y={rows.length * rowH + 18} dx={m.r - 4} textAnchor="end" fill={C.muted} fontSize={TICK_FONT}>
              {unit}
            </text>

            {rows.map((r) => {
              const share = r.value / average;
              const selected = r.key === selectedKey;
              const color = selected ? C.sky : share < lowShare ? C.rose : C.amber;
              const yy = y(r.key) ?? 0;
              const dim = hover != null && hover !== r.key;
              return (
                <g
                  key={r.key}
                  onMouseMove={(e) => {
                    const box = ref.current!.getBoundingClientRect();
                    setHover(r.key);
                    setTip({
                      x: e.clientX - box.left,
                      y: e.clientY - box.top,
                      content: (
                        <>
                          <div className="mb-1 font-semibold text-white">{r.label}</div>
                          <TipRow label="Yield" value={`${fmt(r.value, 1)} ${unit}`} />
                          <TipRow label="vs average" value={`${fmt(share * 100, 0)}%`} />
                          {r.detail?.map((d) => <TipRow key={d.label} label={d.label} value={d.value} />)}
                        </>
                      ),
                    });
                  }}
                >
                  {/* full-row hit area */}
                  <rect x={-m.l} y={yy - (rowH - y.bandwidth()) / 2} width={width} height={rowH} fill={hover === r.key ? "rgba(148,163,184,0.06)" : "transparent"} />
                  <text
                    x={-8}
                    y={yy + y.bandwidth() / 2}
                    dy="0.35em"
                    textAnchor="end"
                    fill={selected ? C.sky : C.text}
                    fontSize={TICK_FONT}
                    fontWeight={selected ? 700 : 500}
                  >
                    {r.label.length > 20 ? `${r.label.slice(0, 19)}…` : r.label}
                  </text>
                  <path
                    d={hBarPath(Math.max(0, x(r.value)), yy, y.bandwidth(), 3)}
                    fill={color}
                    fillOpacity={dim ? 0.35 : selected ? 1 : 0.8}
                  />
                  <text
                    x={x(r.value) + 6}
                    y={yy + y.bandwidth() / 2}
                    dy="0.35em"
                    fill={C.text}
                    fontSize={TICK_FONT}
                    fontWeight={600}
                    className="num"
                  >
                    {share < lowShare && <tspan fill={C.rose}>▼ </tspan>}
                    {fmt(share * 100, 0)}%
                  </text>
                </g>
              );
            })}

            {/* average marker */}
            <g transform={`translate(${x(average)},0)`} pointerEvents="none">
              <line y1={-6} y2={rows.length * rowH} stroke={C.ref} strokeWidth={1.5} strokeDasharray="4 3" />
              <text y={-10} textAnchor="middle" fill={C.ref} fontSize={TICK_FONT} fontWeight={600} className="num">
                avg {fmt(average, 0)}
              </text>
            </g>
          </g>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. String current heatmap                                                  */
/* -------------------------------------------------------------------------- */
const parseTs = d3.timeParse("%Y-%m-%d %H:%M:%S");
const hhmm = d3.timeFormat("%H:%M");

/** One hue, dark → light (0 A → max A): near the panel surface at 0 A, so an open string reads as a dark gap. */
const heatInterp = d3.interpolateRgbBasis(["#141c2b", "#4a3410", "#9a6a06", "#e0a313", "#fde68a"]);

export const StringHeatmap: React.FC<{
  stringNos: number[];
  timestamps: string[];
  /** current_a[string][slot]; null = no record */
  currentA: Array<Array<number | null>>;
}> = ({ stringNos, timestamps, currentA }) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [cell, setCell] = useState<{ s: number; t: number } | null>(null);

  const times = useMemo(() => timestamps.map((t) => parseTs(t) ?? new Date(t)), [timestamps]);
  const zMax = useMemo(() => d3.max(currentA.flat(), (v) => v ?? 0) || 1, [currentA]);
  /** median current of every slot across strings: the "normal" a string is compared against */
  const slotMedian = useMemo(
    () => times.map((_, j) => d3.median(currentA, (row) => (row[j] == null ? undefined : (row[j] as number))) ?? null),
    [times, currentA],
  );
  const color = useMemo(() => d3.scaleSequential(heatInterp).domain([0, zMax]), [zMax]);

  const rowH = stringNos.length > 16 ? 16 : 20;
  const m = { t: 34, r: 12, b: 28, l: 40 };
  const ih = stringNos.length * rowH;
  const height = m.t + ih + m.b;
  const iw = Math.max(0, width - m.l - m.r);

  // slot width = median gap between records (5 min normally)
  const step = useMemo(() => {
    const gaps = d3.pairs(times, (a, b) => b.getTime() - a.getTime()).filter((g) => g > 0);
    return d3.median(gaps) ?? 5 * 60_000;
  }, [times]);
  const x = useMemo(() => {
    const lo = times[0] ?? new Date();
    const hi = new Date((times[times.length - 1] ?? lo).getTime() + step);
    return d3.scaleTime().domain([lo, hi]).range([0, iw]);
  }, [times, step, iw]);
  const y = useMemo(() => d3.scaleBand<number>().domain(stringNos).range([0, ih]).paddingInner(0.12), [stringNos, ih]);
  const t0 = times[0] ?? new Date();
  const cellW = Math.max(1, x(new Date(t0.getTime() + step)) - x(t0) - 1);
  const xTicks = x.ticks(Math.max(2, Math.floor(iw / 70)));

  const legendW = Math.min(180, iw * 0.4);
  const legendScale = d3.scaleLinear().domain([0, zMax]).range([0, legendW]);
  const gradId = "heat-grad";

  const onMove = (e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const px = e.clientX - box.left - m.l;
    const py = e.clientY - box.top - m.t;
    if (px < 0 || py < 0 || px > iw || py > ih) return (setTip(null), setCell(null));
    const s = Math.min(stringNos.length - 1, Math.floor(py / (ih / stringNos.length)));
    const t = d3.bisectRight(times, x.invert(px)) - 1;
    if (t < 0) return;
    const v = currentA[s]?.[t] ?? null;
    const med = slotMedian[t];
    setCell({ s, t });
    setTip({
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      content: (
        <>
          <div className="mb-1 font-semibold text-white">
            S{stringNos[s]} · {hhmm(times[t])}
          </div>
          <TipRow label="Current" value={v == null ? "—" : `${fmt(v, 2)} A`} />
          <TipRow label="Slot median" value={med == null ? "—" : `${fmt(med, 2)} A`} />
          <TipRow label="vs median" value={v == null || !med ? "—" : `${fmt((v / med) * 100, 0)}%`} />
        </>
      ),
    });
  };

  return (
    <div ref={ref} className="relative w-full" onMouseMove={onMove} onMouseLeave={() => (setTip(null), setCell(null))}>
      {width > 0 && times.length > 0 && (
        <svg width={width} height={height} className="block">
          <defs>
            <linearGradient id={gradId}>
              {d3.range(0, 1.01, 0.1).map((t) => (
                <stop key={t} offset={`${t * 100}%`} stopColor={heatInterp(t)} />
              ))}
            </linearGradient>
          </defs>

          {/* colour legend, top right */}
          <g transform={`translate(${m.l + iw - legendW},6)`}>
            <rect width={legendW} height={8} rx={2} fill={`url(#${gradId})`} />
            {legendScale.ticks(4).map((t) => (
              <text key={t} x={legendScale(t)} y={22} textAnchor="middle" fill={C.muted} fontSize={11} className="num">
                {t}
              </text>
            ))}
            <text x={-6} y={8} textAnchor="end" fill={C.muted} fontSize={12}>
              Current (A)
            </text>
          </g>

          <g transform={`translate(${m.l},${m.t})`}>
            {stringNos.map((n, i) => (
              <g key={n}>
                <text
                  x={-8}
                  y={(y(n) ?? 0) + y.bandwidth() / 2}
                  dy="0.35em"
                  textAnchor="end"
                  fill={cell?.s === i ? C.sky : C.text}
                  fontSize={TICK_FONT}
                  fontWeight={cell?.s === i ? 700 : 500}
                >
                  S{n}
                </text>
                {currentA[i]?.map((v, j) =>
                  v == null ? null : (
                    <rect key={j} x={x(times[j])} y={y(n)} width={cellW} height={y.bandwidth()} fill={color(v)} />
                  ),
                )}
              </g>
            ))}

            {/* hover crosshair */}
            {cell && (
              <g pointerEvents="none">
                <rect x={0} y={y(stringNos[cell.s])} width={iw} height={y.bandwidth()} fill="none" stroke="rgba(226,232,240,0.5)" />
                <rect x={x(times[cell.t])} y={0} width={cellW} height={ih} fill="none" stroke="rgba(226,232,240,0.5)" />
              </g>
            )}

            {xTicks.map((t) => (
              <g key={+t} transform={`translate(${x(t)},${ih})`}>
                <line y2={5} stroke={C.axis} />
                <text y={19} textAnchor="middle" fill={C.muted} fontSize={TICK_FONT} className="num">
                  {hhmm(t)}
                </text>
              </g>
            ))}
          </g>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. Daily trend: bars + average line + % line (right axis)                  */
/* -------------------------------------------------------------------------- */
export interface TrendRow {
  day: string;
  value: number | null;
  average: number | null;
  pct: number | null;
  peakKw: number | null;
  maxTempC: number | null;
}

const parseDay = d3.timeParse("%Y-%m-%d");
const dayShort = d3.timeFormat("%d %b");
const dayLong = d3.timeFormat("%a %d %b %Y");

/** Daily yield vs the plant's average inverter (top) and the same as % of that average (bottom). */
export const DailyTrendChart: React.FC<{ rows: TrendRow[]; height?: number }> = ({ rows, height = 300 }) => {
  const spec = useMemo<PanelChartSpec>(
    () => ({
      xKind: "band",
      x: rows.map((r) => r.day),
      xTickLabel: (d) => dayShort(parseDay(String(d)) ?? new Date(String(d))),
      xTipLabel: (d) => dayLong(parseDay(String(d)) ?? new Date(String(d))),
      tipExtra: (i) => [
        { label: "Peak AC", value: rows[i].peakKw == null ? "—" : `${fmt(rows[i].peakKw, 1)} kW` },
        { label: "Max temp", value: rows[i].maxTempC == null ? "—" : `${fmt(rows[i].maxTempC, 1)} °C` },
      ],
      panels: [
        {
          key: "kwh",
          title: "Day yield (kWh)",
          weight: 1.6,
          series: [
            { key: "y", name: "Yield", type: "bar", color: SERIES.dc, y: rows.map((r) => r.value), unit: "kWh" },
            { key: "avg", name: "Plant avg per inverter", type: "line", dash: "dash", color: C.ref, width: 1.5, y: rows.map((r) => r.average), unit: "kWh" },
          ],
        },
        {
          key: "pct",
          title: "% of plant average",
          zero: false,
          tickSuffix: "%",
          refLines: [{ y: 100, label: "100 % = on par", color: SERIES.reference }],
          series: [{ key: "pct", name: "% of plant avg", type: "line", color: SERIES.ac, y: rows.map((r) => r.pct), format: (v) => `${fmt(v, 1)}%` }],
        },
      ],
    }),
    [rows],
  );
  return <PanelChart spec={spec} height={height} />;
};
