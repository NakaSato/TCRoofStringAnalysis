import { useEffect, useState } from "react";
import type { RainRadar } from "../../api/client";

/**
 * Rain over each plant in one radar snapshot, read from the snapshot's own tile image in the
 * browser (no Longdo API call; tiles are CORS-open and cached by the browser for a day).
 *
 * Longdo's `location` answers only for the newest snapshot, so an older one can be judged only
 * from its image. The tiles are a continuous colour ramp, not the 5 legend colours, so a pixel
 * gives rain / no rain and the colour the map shows, never a 0–5 class. Checked against
 * `location` on 18 Nov 2026 (26 points, same snapshot): alpha 4 = no rain, every pixel from
 * alpha 40 up = class ≥ 1; classes overlap by alpha / hue at their edges (e.g. 159–170 = 1 or 2).
 */
export const RAIN_ALPHA = 32;
/** 14 tiles cover the fleet at zoom 7 (~0.6 km a pixel on Longdo's 512 px tiles). */
const ZOOM = 7;
const MAX_CACHED_FRAMES = 30;

export interface FramePoint {
  id: number;
  lat: number;
  lon: number;
}

export interface FrameSample {
  /** 0–255; ≥ RAIN_ALPHA = rain on the radar image */
  alpha: number;
  /** the pixel's colour as the map draws it */
  color: string;
}

export interface FrameRain {
  time: number;
  /** plant id → sample; a plant missing here could not be read (tile failed), which is not "dry" */
  samples: Map<number, FrameSample>;
  /** plants whose tile could not be read */
  unread: number;
}

const tileOf = (lat: number, lon: number) => {
  const n = 2 ** ZOOM;
  const fx = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  return { x, y, u: fx - x, v: fy - y };
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tile not loaded"));
    img.src = url;
  });

async function readFrame(template: string, time: number, points: FramePoint[]): Promise<FrameRain> {
  const byTile = new Map<string, { x: number; y: number; items: { id: number; u: number; v: number }[] }>();
  for (const p of points) {
    const t = tileOf(p.lat, p.lon);
    const key = `${t.x}/${t.y}`;
    const g = byTile.get(key) ?? { x: t.x, y: t.y, items: [] };
    g.items.push({ id: p.id, u: t.u, v: t.v });
    byTile.set(key, g);
  }
  const samples = new Map<number, FrameSample>();
  let unread = 0;
  await Promise.all(
    [...byTile.values()].map(async (g) => {
      const url = template
        .replace("{time}", String(time))
        .replace("{z}", String(ZOOM))
        .replace("{x}", String(g.x))
        .replace("{y}", String(g.y));
      try {
        const img = await loadImage(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no canvas");
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data;
        for (const it of g.items) {
          const i = (Math.min(h - 1, Math.floor(it.v * h)) * w + Math.min(w - 1, Math.floor(it.u * w))) * 4;
          samples.set(it.id, { alpha: px[i + 3], color: `rgb(${px[i]}, ${px[i + 1]}, ${px[i + 2]})` });
        }
      } catch {
        unread += g.items.length; // left out: unknown, never dry
      }
    })
  );
  return { time, samples, unread };
}

// one entry per snapshot URL template + time; a new plant list reads the frames again
const cache = new Map<string, { points: FramePoint[]; result: Promise<FrameRain> }>();

/**
 * Rain over `points` in the snapshot `time`, or null while it loads, for the newest snapshot
 * (Longdo's own per-plant class is used there) and when the radar has no Longdo tiles
 * (RainViewer's colours are another scale).
 */
export function useFrameRain(data: RainRadar | null, time: number | null, isLatest: boolean, points: FramePoint[]): FrameRain | null {
  const [result, setResult] = useState<{ key: string; value: FrameRain } | null>(null);
  const usable = !!data && data.point_rain !== false && !data.frame_tiles && time != null && !isLatest && points.length > 0;
  const key = usable ? `${data.tile_url}|${time}` : null;

  useEffect(() => {
    if (!key || !data || time == null) return;
    let hit = cache.get(key);
    if (!hit || hit.points !== points) {
      hit = { points, result: readFrame(data.tile_url, time, points) };
      cache.set(key, hit);
      while (cache.size > MAX_CACHED_FRAMES) cache.delete(cache.keys().next().value as string);
    }
    let live = true;
    hit.result.then((value) => live && setResult({ key, value }));
    return () => {
      live = false;
    };
  }, [key, data, time, points]);

  return key && result?.key === key ? result.value : null;
}
