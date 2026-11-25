import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Pause, Play } from "lucide-react";
import { ApiError, api } from "../../api/client";
import type { FleetRadarRain, GrowattLive, PlantRadarRain, RadarAreaStats, RadarRain, RainRadar } from "../../api/client";
import { fmt, fmtInt } from "../../components/ui";
import { useLivePoll } from "../../context/useLivePoll";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dateLocale, translate, useI18n } from "../../i18n";

/** Newest snapshots kept on the map and played back. */
const MAX_FRAMES = 12;
const FRAME_MS = 600;
const LAST_FRAME_HOLD_MS = 1800;
const OPACITY = 0.85;
const PANE = "rain-radar";

const hhmm = (unix: number): string =>
  new Date(unix * 1000).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

type Legend = RainRadar["legend"];

/** Label and colour of a radar rain class; the colours are Longdo's legend, never our own. */
export const rainLook = (rain: RadarRain | null | undefined, legend: Legend): { label: string; color: string | null } => {
  if (!rain) return { label: "—", color: null };
  if (rain.intensity === 0) return { label: "ไม่มีฝน", color: null };
  const lv = legend.find((l) => l.intensity === rain.intensity);
  return { label: lv?.label || `ระดับ ${rain.intensity}/5`, color: lv?.color ?? null };
};

export interface RainRadarState {
  /** false = the backend has no Longdo key: hide every radar control */
  available: boolean;
  data: RainRadar | null;
  stale: boolean;
  error: string | null;
  frames: number[];
  /** Unix time of the snapshot on the map; null until the list is in */
  time: number | null;
  isLatest: boolean;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  /** show one snapshot (stops playback); null = follow the newest */
  setTime: (t: number | null) => void;
}

/**
 * Longdo rain radar on a Leaflet map. The list of snapshots is read once (to know whether the
 * radar is configured) and polled only while `on`. Each snapshot is its own tile layer, made
 * when first shown and switched by opacity, so playback does not reload tiles.
 */
export function useRainRadar(map: React.RefObject<L.Map | null>, on: boolean): RainRadarState {
  const [env, setEnv] = useState<GrowattLive<RainRadar> | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const layers = useRef(new Map<number, { layer: L.TileLayer; url: string }>());

  useLivePoll(
    available && (on || !env),
    "rain-radar",
    api.getRainRadar,
    (r) => {
      setEnv(r);
      setError(r.error);
    },
    (err) => {
      if (err instanceof ApiError && err.status === 404) setAvailable(false);
      else setError(err instanceof Error ? err.message : translate("Rain radar unavailable"));
    }
  );

  const data = env?.data ?? null;
  const frames = useMemo(() => (data?.frames ?? []).slice(-MAX_FRAMES), [data]);
  const latest = frames.length ? frames[frames.length - 1] : null;
  const time = picked != null && frames.includes(picked) ? picked : latest;

  // playback: step through the snapshots, holding the newest a little longer
  useEffect(() => {
    if (!on || !playing || frames.length < 2 || time == null) return;
    const i = frames.indexOf(time);
    const id = window.setTimeout(
      // null = the newest, so playback keeps following it when a new snapshot arrives
      () => setPicked(i + 1 >= frames.length - 1 && i !== frames.length - 1 ? null : frames[(i + 1) % frames.length]),
      i === frames.length - 1 ? LAST_FRAME_HOLD_MS : FRAME_MS
    );
    return () => window.clearTimeout(id);
  }, [on, playing, frames, time]);

  // layers
  useEffect(() => {
    const m = map.current;
    const drop = () => {
      layers.current.forEach((l) => l.layer.remove());
      layers.current.clear();
    };
    if (!m || !on || !data || time == null) {
      drop();
      return;
    }
    if (!m.getPane(PANE)) {
      const pane = m.createPane(PANE);
      pane.style.zIndex = "350"; // over the basemap and its labels, under the plant markers
      pane.style.pointerEvents = "none";
    }
    // Longdo: one template with {time}; RainViewer: each snapshot has its own URL
    const urlOf = (t: number) => data.frame_tiles?.[String(t)] ?? data.tile_url.replace("{time}", String(t));
    for (const [t, l] of layers.current) {
      if (!frames.includes(t) || l.url !== urlOf(t)) {
        l.layer.remove();
        layers.current.delete(t);
      }
    }
    if (!layers.current.has(time)) {
      const url = urlOf(time);
      const layer = L.tileLayer(url, {
        pane: PANE,
        opacity: 0,
        minNativeZoom: data.min_zoom,
        maxNativeZoom: data.max_zoom,
        maxZoom: 19,
        attribution: data.attribution,
      });
      layer.addTo(m);
      layers.current.set(time, { layer, url });
    }
    layers.current.forEach((l, t) => l.layer.setOpacity(t === time ? OPACITY : 0));
  }, [map, on, data, frames, time]);

  // the map is removed with the page: forget its layers
  useEffect(() => () => layers.current.clear(), []);

  return {
    available,
    data,
    stale: env?.stale ?? false,
    error,
    frames,
    time,
    isLatest: time != null && time === latest,
    playing,
    setPlaying,
    setTime: (t) => {
      setPlaying(false);
      setPicked(t);
    },
  };
}

export interface FleetRainState {
  /** plant id → its row; a plant missing here or with `checked: false` is unknown, not dry */
  byId: Map<number, FleetRadarRain["plants"][number]>;
  data: FleetRadarRain | null;
  /** the rate limit or the monthly budget held calls back */
  held: string | null;
  error: string | null;
}

/** Radar rain now over every plant, polled only while the radar is on (the backend sweeps). */
export function useFleetRain(on: boolean): FleetRainState {
  const [env, setEnv] = useState<GrowattLive<FleetRadarRain> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  useLivePoll(
    on && available,
    "fleet-rain",
    api.getLiveFleetRain,
    (r) => {
      setEnv(r);
      setError(null);
    },
    (err) => {
      if (err instanceof ApiError && err.status === 404) setAvailable(false); // no Longdo key
      else setError(err instanceof Error ? err.message : translate("unavailable"));
    }
  );
  const data = on ? (env?.data ?? null) : null;
  const byId = useMemo(() => new Map((data?.plants ?? []).map((p) => [p.plant_id, p])), [data]);
  return { byId, data, held: on ? (env?.error ?? null) : null, error: on ? error : null };
}

export interface RainingPlant {
  plantId: number;
  name: string;
  city: string | null;
  label: string;
  color: string | null;
}

/** Which snapshot `raining` is for: the newest (Longdo's class per plant) or an older one (its radar image). */
export interface RainingFrame {
  time: number;
  source: "longdo" | "image";
  /** the older snapshot's tiles are still being read */
  loading: boolean;
  /** plants whose tile could not be read (unknown, not dry) */
  unread: number;
  located: number;
}

/** Panel on the map (bottom right): play / pause, the snapshot slider and time, rain over the plants, Longdo's legend. */
export const RainRadarBar: React.FC<{
  radar: RainRadarState;
  fleet: FleetRainState;
  rainOnly: boolean;
  onRainOnly: (v: boolean) => void;
  /** plants the snapshot on the map shows rain over, strongest first */
  raining: RainingPlant[];
  rainingFrame: RainingFrame | null;
  onPick: (plantId: number) => void;
}> = ({ radar, fleet, rainOnly, onRainOnly, raining, rainingFrame, onPick }) => {
  const { frames, time, data } = radar;
  const index = time != null ? frames.indexOf(time) : -1;
  const { t } = useI18n();
  return (
    <div className="absolute bottom-6 right-3 z-[400] flex w-[min(340px,calc(100%-1.5rem))] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-white/[0.08] bg-ink-950/90 px-3 py-2 text-[11px] text-slate-400 shadow-xl backdrop-blur">
      {frames.length === 0 || time == null ? (
        <span className={cn(radar.error && "text-amber-400")}>
          {radar.error
            ? t("Rain radar unavailable: {error}", { error: radar.error })
            : data
              ? t("No radar snapshot available")
              : t("Loading rain radar…")}
        </span>
      ) : (
        <>
          <div className="flex w-full items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={frames.length < 2}
                onClick={() => radar.setPlaying(!radar.playing)}
                aria-label={radar.playing ? t("Pause radar playback") : t("Play radar snapshots")}
              >
                {radar.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {radar.playing ? t("Pause") : t("Play the last {n} snapshots (from {time})", { n: frames.length, time: hhmm(frames[0]) })}
            </TooltipContent>
          </Tooltip>
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={index}
            onChange={(e) => {
              const i = Number(e.target.value);
              radar.setTime(i === frames.length - 1 ? null : frames[i]);
            }}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-sky-400"
            aria-label={t("Radar snapshot")}
            aria-valuetext={hhmm(time)}
          />
          <span className="num shrink-0 font-semibold text-slate-200">
            {t("Radar {time}", { time: hhmm(time) })}
            {radar.isLatest && <span className="font-normal text-slate-500"> · {t("latest")}</span>}
          </span>
          </div>
          {(radar.stale || radar.error) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 text-amber-400">{t("List not updated")}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{radar.error ?? t("The radar provider did not answer; showing the last list")}</TooltipContent>
            </Tooltip>
          )}
          {data?.fallback_reason && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 text-amber-400">{t("RainViewer (fallback)")}</span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72">
                {t(
                  "Showing RainViewer radar tiles because {reason}. RainViewer gives no rain value per plant, no forecast and no detail past zoom {zoom}.",
                  { reason: data.fallback_reason, zoom: data.max_zoom }
                )}
              </TooltipContent>
            </Tooltip>
          )}
          {fleet.data && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={cn("-ml-1.5 shrink-0", rainOnly && "bg-white/10 text-sky-300 ring-1 ring-sky-400/50")}
                  onClick={() => onRainOnly(!rainOnly)}
                  aria-pressed={rainOnly}
                >
                  {t("Rain over")} <span className="num">{fmtInt(fleet.data.raining)}</span>
                  <span className={cn("font-normal", fleet.held ? "text-amber-400" : "text-slate-500")}>
                    {fleet.data.checked < fleet.data.located
                      ? `· ${t("checked {n}/{total}", { n: fmtInt(fleet.data.checked), total: fmtInt(fleet.data.located) })}`
                      : t("of {n} plants", { n: fmtInt(fleet.data.located) })}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72">
                {rainOnly
                  ? t("Plants the newest radar snapshot shows rain over (not the snapshot being played). Click to show every plant.")
                  : t("Plants the newest radar snapshot shows rain over (not the snapshot being played). Click to show only these.")}
                {fleet.held ? ` ${fleet.held}.` : ""}{" "}
                {t("Longdo calls today: {used} of {allowance}; this month {month} of {budget}.", {
                  used: fmtInt(fleet.data.usage.used_today),
                  allowance: fmtInt(fleet.data.usage.allowance_today),
                  month: fmtInt(fleet.data.usage.used_this_month),
                  budget: fmtInt(fleet.data.usage.monthly_budget),
                })}
              </TooltipContent>
            </Tooltip>
          )}
          {!fleet.data && fleet.error && <span className="shrink-0 text-amber-400">{t("Plant rain unavailable")}</span>}
          {rainingFrame?.source === "image" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="w-full text-slate-500">
                  {rainingFrame.loading
                    ? t("Reading the {time} radar image…", { time: hhmm(rainingFrame.time) })
                    : raining.length
                      ? t("Rain over {n} plants at {time} · radar image", { n: fmtInt(raining.length), time: hhmm(rainingFrame.time) })
                      : t("No rain over the plants at {time} · radar image", { time: hhmm(rainingFrame.time) })}
                  {rainingFrame.unread > 0 && <span className="text-amber-400"> · {t("{n} not read", { n: fmtInt(rainingFrame.unread) })}</span>}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72">
                {t(
                  "Plants under rain in the snapshot on the map, read from its radar image at each plant (no Longdo call). The image gives rain or no rain, not Longdo's class; the dot is the image's colour there. Pick the newest snapshot for Longdo's class per plant."
                )}
                {rainingFrame.unread > 0 &&
                  ` ${t("{n} of {total} plants: the image could not be read (unknown, not dry).", { n: fmtInt(rainingFrame.unread), total: fmtInt(rainingFrame.located) })}`}
              </TooltipContent>
            </Tooltip>
          )}
          {raining.length > 0 && (
            <ul className="max-h-32 w-full overflow-y-auto border-y border-white/[0.06] py-1" aria-label={t("Plants with rain in the snapshot on the map (weather radar)")}>
              {raining.map((r) => (
                <li key={r.plantId}>
                  <button
                    type="button"
                    onClick={() => onPick(r.plantId)}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/[0.06]"
                  >
                    <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color ?? undefined }} />
                    <span className="min-w-0 flex-1 truncate text-slate-200">
                      {r.name}
                      {r.city && <span className="text-slate-500"> · {r.city}</span>}
                    </span>
                    <span className="shrink-0 text-sky-300">{r.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data && data.legend.length > 0 && (
            <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1" aria-label={t("Rain intensity legend")}>
              {data.legend.map((l) => (
                <span key={l.intensity} className="flex items-center gap-1">
                  <i className="h-2 w-3 rounded-sm" style={{ background: l.color }} />
                  {l.label}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

/** Radar rain over one plant: now and the +15 / +30 min nowcast. Not a measurement. */
export const PlantRainRow: React.FC<{ plantId: number; legend: Legend; /** no top border / margin (inside a card of its own) */ bare?: boolean }> = ({ plantId, legend, bare }) => {
  const [state, setState] = useState<{ id: number; env: GrowattLive<PlantRadarRain> | null; error: string | null }>({
    id: plantId,
    env: null,
    error: null,
  });
  useLivePoll(
    true,
    plantId,
    () => api.getLivePlantRain(plantId),
    (env) => setState({ id: plantId, env, error: null }),
    (err) => setState((s) => ({ id: plantId, env: s.id === plantId ? s.env : null, error: err instanceof Error ? err.message : translate("unavailable") }))
  );
  const { t } = useI18n();
  const cur = state.id === plantId ? state : { id: plantId, env: null, error: null };
  const d = cur.env?.data ?? null;
  const cells: { label: string; rain: RadarRain | null | undefined }[] = [
    { label: t("Now"), rain: d?.now },
    ...(d?.forecast ?? [])
      .filter((f) => f.lead_min != null)
      .map((f) => ({ label: t("+{n} min", { n: f.lead_min }), rain: f.rain })),
  ];
  return (
    <div className={cn("text-[11px]", !bare && "mt-2.5 border-t border-white/[0.06] pt-2.5")}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-slate-500">
            {cells.length > 1 ? t("Rain · weather radar, forecast") : t("Rain · weather radar")}
            {cur.env?.stale && <span className="text-amber-400"> · {d?.now ? t("not updated") : t("waiting for Longdo")}</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64">
          {t("What the Longdo weather radar shows over the plant (~1 km), not a measurement at the site. +15 / +30 min is Longdo's radar forecast.")}
          {cur.env?.error ? ` ${cur.env.error}` : ""}
          {d?.forecast_error ? ` ${t("Forecast: {error}", { error: d.forecast_error })}` : ""}
        </TooltipContent>
      </Tooltip>
      {!d ? (
        <div className="mt-0.5 text-slate-400">{cur.error ? cur.error.replace(/^Longdo rain radar unavailable: /, t("Not available yet: ")) : t("Loading…")}</div>
      ) : (
        <>
        <div className="mt-0.5 grid grid-cols-3 gap-2">
          {cells.map((c) => {
            const look = rainLook(c.rain, legend);
            return (
              <div key={c.label} title={c.rain?.description ?? undefined}>
                <div className="text-slate-500">{c.label}</div>
                <div className="flex items-center gap-1 font-semibold text-slate-200">
                  {look.color && <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: look.color }} />}
                  <span className="truncate">{look.label}</span>
                </div>
              </div>
            );
          })}
        </div>
        {d.area && (d.area.now || d.area.error) && (
          <div className="mt-1.5 text-slate-500" title={d.area.error ?? undefined}>
            {t("Within {n} km:", { n: fmt(d.area.radius_km, 0) })}{" "}
            {d.area.now ? (
              <>
                <span className="text-slate-300">{areaText(d.area.now, legend)}</span>
                {d.area.forecast
                  .filter((f) => f.lead_min != null)
                  .map((f) => (
                    <span key={f.lead_min}>
                      {" "}
                      · {t("+{n} min", { n: f.lead_min })} <span className="text-slate-300">{areaText(f.stats, legend)}</span>
                    </span>
                  ))}
              </>
            ) : (
              "—"
            )}
          </div>
        )}
        </>
      )}
    </div>
  );
};

/** "rain over 20 % (max Heavy)"; "—" when Longdo gave no statistics. */
const areaText = (s: RadarAreaStats | null, legend: Legend): string => {
  if (!s || s.coverage_pct == null) return "—";
  if (s.coverage_pct === 0 && !s.max_intensity) return translate("no rain");
  const top = s.max_intensity ? rainLook({ intensity: s.max_intensity, description: null }, legend).label : null;
  const pct = fmt(s.coverage_pct, s.coverage_pct < 10 ? 1 : 0);
  return top ? translate("rain over {pct} % (max {top})", { pct, top }) : translate("rain over {pct} %", { pct });
};
