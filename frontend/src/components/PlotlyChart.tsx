import React, { useEffect, useRef } from "react";
// @ts-ignore - plotly.js-dist-min provides prebuilt bundle
import Plotly from "plotly.js-dist-min";

interface PlotlyChartProps {
  figure?: {
    data: any[];
    layout?: Record<string, any>;
  } | null;
  loading?: boolean;
  height?: number;
  /** Render without the surrounding panel chrome (when already inside a Panel). */
  bare?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Dark control-room theming for backend-generated (plotly_white) figures     */
/* -------------------------------------------------------------------------- */
const GRID = "rgba(148,163,184,0.09)";
const AXIS_LINE = "rgba(148,163,184,0.18)";
const TEXT = "#94a3b8";
const TITLE = "#e2e8f0";

/** Light-theme colours used by the backend, remapped to high-contrast dark equivalents. */
const COLOR_REMAP: Record<string, string> = {
  "#1e3a8a": "#60a5fa",
  "#1e40af": "#60a5fa",
  "#0284c7": "#22d3ee",
  "#16a34a": "#34d399",
  "#15803d": "#34d399",
  "#f59e0b": "#fbbf24",
  "#dc2626": "#f87171",
  "#b91c1c": "#f87171",
  "#94a3b8": "#64748b",
  "#475569": "#94a3b8",
  "#334155": "#94a3b8",
  "#0f172a": "#e2e8f0",
  "#1e293b": "#cbd5e1",
  "#000000": "#e2e8f0",
  black: "#e2e8f0",
  white: "#0a101c",
  "#ffffff": "#0a101c",
  "#fff": "#0a101c",
};

function remapColors<T>(value: T): T {
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    return (COLOR_REMAP[key] ?? value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => remapColors(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      // Never touch data arrays / hover text
      if (["x", "y", "z", "text", "customdata", "hovertemplate", "ids", "labels", "values", "measure"].includes(k)) {
        out[k] = v;
      } else {
        out[k] = remapColors(v);
      }
    }
    return out as T;
  }
  return value;
}

function darkAxis(axis: Record<string, any> = {}) {
  return {
    ...axis,
    gridcolor: GRID,
    zerolinecolor: AXIS_LINE,
    linecolor: AXIS_LINE,
    tickcolor: AXIS_LINE,
    tickfont: { ...(axis.tickfont || {}), color: TEXT, size: 10 },
    title: axis.title
      ? typeof axis.title === "string"
        ? { text: axis.title, font: { color: TEXT, size: 11 } }
        : { ...axis.title, font: { ...(axis.title.font || {}), color: TEXT, size: 11 } }
      : axis.title,
  };
}

function themeLayout(layout: Record<string, any>, height: number) {
  const themed: Record<string, any> = {
    ...remapColors({ ...layout, template: undefined }),
    template: undefined,
    autosize: true,
    height: layout.height || height,
    margin: layout.margin || { l: 52, r: 36, t: 54, b: 48 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Noto Sans Thai, ui-sans-serif, sans-serif", color: TEXT, size: 11 },
    hoverlabel: {
      bgcolor: "#0d1524",
      bordercolor: "rgba(245,180,42,0.45)",
      font: { family: "Noto Sans Thai, sans-serif", color: "#e2e8f0", size: 11 },
    },
    legend: {
      ...(layout.legend || {}),
      bgcolor: "rgba(0,0,0,0)",
      bordercolor: "rgba(0,0,0,0)",
      font: { color: TEXT, size: 10 },
    },
    colorway: ["#fbbf24", "#22d3ee", "#34d399", "#a78bfa", "#f472b6", "#60a5fa", "#fb923c", "#f87171"],
  };

  if (layout.title) {
    const t = typeof layout.title === "string" ? { text: layout.title } : layout.title;
    themed.title = { ...t, font: { ...(t.font || {}), color: TITLE, size: 13, family: "Noto Sans Thai, sans-serif" } };
  }

  // Theme every axis key (xaxis, xaxis2, yaxis, yaxis2, ...)
  const axisKeys = Object.keys(layout).filter((k) => /^[xy]axis\d*$/.test(k));
  if (!axisKeys.includes("xaxis")) axisKeys.push("xaxis");
  if (!axisKeys.includes("yaxis")) axisKeys.push("yaxis");
  for (const k of axisKeys) themed[k] = darkAxis(remapColors(layout[k] || {}));

  if (Array.isArray(layout.annotations)) {
    themed.annotations = layout.annotations.map((a: any) => ({
      ...remapColors(a),
      font: { ...(a.font || {}), color: a.font?.color ? remapColors(a.font.color) : TEXT },
      bgcolor: a.bgcolor ? "rgba(13,21,36,0.85)" : a.bgcolor,
    }));
  }

  return themed;
}

function themeData(data: any[]) {
  return data.map((trace) => {
    const t = remapColors(trace);
    if (t.type === "heatmap" && t.colorbar) {
      t.colorbar = {
        ...t.colorbar,
        tickfont: { color: TEXT, size: 10 },
        outlinecolor: "rgba(0,0,0,0)",
        title: t.colorbar.title
          ? { ...(typeof t.colorbar.title === "string" ? { text: t.colorbar.title } : t.colorbar.title), font: { color: TEXT, size: 10 } }
          : t.colorbar.title,
      };
    }
    if (t.type === "waterfall") {
      t.connector = { ...(t.connector || {}), line: { ...(t.connector?.line || {}), color: "rgba(148,163,184,0.35)" } };
      t.textfont = { ...(t.textfont || {}), color: "#e2e8f0" };
    }
    return t;
  });
}

export const PlotlyChart: React.FC<PlotlyChartProps> = ({ figure, loading, height = 390, bare = false }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !figure || !figure.data) return;

    Plotly.react(el, themeData(figure.data), themeLayout(figure.layout || {}, height), {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    });

    const handleResize = () => {
      if (containerRef.current) {
        Plotly.Plots.resize(containerRef.current);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [figure, height]);

  const shell = bare ? "w-full" : "panel w-full overflow-hidden p-2";

  if (loading || !figure) {
    return (
      <div style={{ height }} className={`${shell} flex items-center justify-center`}>
        <div className="flex items-center gap-2.5 text-xs text-slate-500">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-solar-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-solar-400" />
          </span>
          Loading telemetry chart…
        </div>
      </div>
    );
  }

  return (
    <div className={shell}>
      <div ref={containerRef} className="w-full" style={{ minHeight: height }} />
    </div>
  );
};
