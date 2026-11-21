/** Small pieces of the plant directory: status / alarm donut, pager window, row thumbnail. */
import React from "react";
import { Cloud, Server } from "lucide-react";
import type { StatusLevel } from "../ui";

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export const MultiSegmentDonut: React.FC<{
  segments: DonutSegment[];
  totalValue: number | string;
  centerLabel: string;
  size?: number;
  strokeWidth?: number;
}> = ({ segments, totalValue, centerLabel, size = 142, strokeWidth = 13 }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const sum = segments.reduce((acc, s) => acc + s.value, 0);

  let accumulatedAngle = 0;

  return (
    <div className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(148, 163, 184, 0.16)"
          strokeWidth={strokeWidth}
        />
        {sum > 0 ? (
          segments
            .filter((s) => s.value > 0)
            .map((seg, idx) => {
              const fraction = seg.value / sum;
              const dashLength = Math.max(0, fraction * circumference - (segments.filter((x) => x.value > 0).length > 1 ? 3 : 0));
              const offset = -accumulatedAngle * circumference;
              accumulatedAngle += fraction;
              return (
                <circle
                  key={idx}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${dashLength} ${circumference}`}
                  strokeDashoffset={offset}
                  strokeLinecap="butt"
                  style={{
                    filter: `drop-shadow(0 0 6px ${seg.color}55)`,
                    transition: "stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease",
                  }}
                />
              );
            })
        ) : null /* nothing (or no data): only the grey track, never a decorative ring */}
      </svg>
      <div className="
        pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center
      ">
        <span className="num text-2xl font-bold leading-none text-white">{totalValue}</span>
        <span className="mt-1 text-[11px] font-medium text-slate-300/90">{centerLabel}</span>
      </div>
    </div>
  );
};


/* Mini Rooftop PV Plant Thumbnail                                            */

/** Page numbers to show: first, last and current ±1, with null marking a gap ("…"). */
export const pageWindow = (page: number, total: number): (number | null)[] => {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (page >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
};

/** Esri World Imagery (same imagery as the Plant Map and the Overview Site card), one image per plant. */
const ESRI_EXPORT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export";
/** Ground area shown by the thumbnail: about one roof (metres). */
const VIEW_W_M = 120;
const VIEW_H_M = 75;

const satelliteUrl = (lat: number, lon: number): string => {
  const dLat = VIEW_H_M / 2 / 110_574;
  const dLon = VIEW_W_M / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(6)).join(",");
  // 2x the 64x40 box for sharp HiDPI rendering
  return `${ESRI_EXPORT}?bbox=${bbox}&bboxSR=4326&imageSR=3857&size=128,80&format=jpg&f=image`;
};

/** Row thumbnail: satellite view of the plant's roof; the drawn panel when it has no coordinates or the image fails. */
export const PlantThumbnail: React.FC<{
  statusLevel: StatusLevel;
  source: "local" | "growatt";
  lat: number | null;
  lon: number | null;
  name: string;
}> = ({ statusLevel, source, lat, lon, name }) => {
  const [failed, setFailed] = React.useState(false);
  const borderTone =
    statusLevel === "ok"
      ? "border-emerald-400/30"
      : statusLevel === "crit"
      ? "border-red-400/35"
      : "border-amber-400/30";
  const showPhoto = lat != null && lon != null && !failed;

  return (
    <div
      className={`relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border ${borderTone} bg-ink-900`}
    >
      {showPhoto ? (
        <img
          src={satelliteUrl(lat, lon)}
          crossOrigin="anonymous" // CORS response, so the service worker can cache it
          alt={`Satellite view of ${name}`}
          title="Satellite imagery: Esri World Imagery"
          loading="lazy"
          decoding="async"
          width={64}
          height={40}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <>
          {/* Sun glow */}
          <div className="absolute right-1.5 top-1 h-2.5 w-2.5 rounded-full bg-amber-300/80 blur-[1px]" />
          {/* Solar module grid */}
          <svg viewBox="0 0 64 40" className="h-full w-full opacity-85" aria-label="No plant location">
            <polygon points="8,36 18,16 46,16 56,36" fill="#0ea5e9" fillOpacity="0.22" stroke="#38bdf8" strokeWidth="1" />
            <line x1="25" y1="16" x2="20" y2="36" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
            <line x1="32" y1="16" x2="32" y2="36" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
            <line x1="39" y1="16" x2="44" y2="36" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
            <line x1="14" y1="24" x2="50" y2="24" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
            <line x1="11" y1="30" x2="53" y2="30" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
          </svg>
        </>
      )}
      <span
        className="absolute bottom-0.5 right-0.5 rounded bg-ink-950/80 p-0.5 text-sky-300"
        title={source === "local" ? "SCADA" : "Growatt cloud"}
        aria-label={source === "local" ? "SCADA" : "Growatt cloud"}
      >
        {source === "local" ? <Server className="h-2.5 w-2.5" /> : <Cloud className="h-2.5 w-2.5" />}
      </span>
    </div>
  );
};


/* Main Component: FusionSolar-style Fleet KPI Banner + Plant Directory Table */
