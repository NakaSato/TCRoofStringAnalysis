/** Building blocks shared by every D3 chart: colours, sizing, tooltip. */
import React, { useLayoutEffect, useRef, useState } from "react";
import { SERIES } from "./chartTheme";

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */
export const C = {
  text: "#cbd5e1",
  muted: "#8391a7",
  grid: "rgba(148,163,184,0.14)",
  axis: "rgba(148,163,184,0.35)",
  amber: SERIES.dc,
  sky: "#38bdf8",
  rose: "#fb7185",
  ref: "#e2e8f0",
};
export const TICK_FONT = 12;

/** Width of the container, kept in sync with ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface TipState {
  x: number;
  y: number;
  content: React.ReactNode;
}

/** Tooltip inside the chart container: right of the cursor, or left of it when it would overflow. */
export const Tooltip: React.FC<{ tip: TipState | null; width: number }> = ({ tip, width }) => {
  const box = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(180);
  useLayoutEffect(() => {
    if (box.current && box.current.offsetWidth !== w) setW(box.current.offsetWidth);
  });
  if (!tip) return null;
  const right = tip.x + 14;
  const left = right + w <= width ? right : Math.max(0, tip.x - 14 - w);
  return (
    <div
      ref={box}
      className="pointer-events-none absolute z-10 w-max min-w-[150px] max-w-[340px] rounded-lg border border-solar-500/50 bg-ink-850/95 px-3 py-2 text-[13px] leading-snug text-slate-100 shadow-xl backdrop-blur"
      style={{ left, top: Math.max(0, tip.y - 12) }}
    >
      {tip.content}
    </div>
  );
};

export const TipRow: React.FC<{ color?: string; dash?: boolean; label: string; value: string }> = ({ color, dash, label, value }) => (
  <div className="flex items-center gap-2">
    {color && (
      <span
        className="inline-block h-0.5 w-3 shrink-0"
        style={dash ? { borderTop: `2px dotted ${color}` } : { background: color, height: 8, borderRadius: 2 }}
      />
    )}
    <span className="text-slate-400">{label}</span>
    <span className="num ml-auto whitespace-nowrap pl-3 font-semibold text-white">{value}</span>
  </div>
);

/** Approximate rendered width of a label at the tick font size (avoids measuring the DOM). */
export const textWidth = (s: string, size = TICK_FONT) => s.length * size * 0.6;

