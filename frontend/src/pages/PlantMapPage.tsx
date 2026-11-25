import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AppWindow, CloudRain, ExternalLink, Layers, LocateFixed, MapPinOff, Maximize2, Route, Search, X } from "lucide-react";
import { useFleet } from "../context/FleetContext";
import { plantPath } from "../context/routes";
import { pick, useUrlState } from "../lib/useUrlState";
import type { GrowattPlant } from "../api/client";
import { Led, LoadingState, LOADING_STATUS, StatusBadge, fmt, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PlantRainRow, RainRadarBar, type RainingFrame, type RainingPlant, rainLook, useFleetRain, useRainRadar } from "./plantMap/rainRadar";
import { type FramePoint, RAIN_ALPHA, useFrameRain } from "./plantMap/frameRain";
import { useI18n } from "../i18n";
import { routeHref } from "./visitRoute/href";

/* Basemaps. With a Mapbox token (`VITE_MAPBOX_TOKEN`, a public `pk.` token: restrict it by URL at
   Mapbox) the map uses Mapbox raster style tiles; without one, Esri's free tiles. Attribution is required. */
const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN || "";
const mapbox = (style: string) =>
  `https://api.mapbox.com/styles/v1/mapbox/${style}/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`;
const MAPBOX_ATTRIBUTION = "© Mapbox © OpenStreetMap";
interface BasemapDef {
  label: string;
  url: string;
  attribution: string;
  /** a second layer of place names over the base; null when the base has its own */
  labels: string | null;
  /** deepest zoom with real tiles; stretched beyond */
  maxNativeZoom: number;
  /** Mapbox serves 512 px tiles */
  big: boolean;
}
const BASEMAPS: Record<"sat" | "dark", BasemapDef> = MAPBOX_TOKEN
  ? {
      sat: { label: "Satellite", url: mapbox("satellite-streets-v12"), attribution: `${MAPBOX_ATTRIBUTION} © Maxar`, labels: null, maxNativeZoom: 19, big: true },
      dark: { label: "Dark", url: mapbox("dark-v11"), attribution: MAPBOX_ATTRIBUTION, labels: null, maxNativeZoom: 19, big: true },
    }
  : {
      sat: {
        label: "Satellite",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        // place names over the imagery, so the overview stays readable
        labels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        maxNativeZoom: 19,
        big: false,
      },
      dark: {
        label: "Dark",
        // Esri Dark Gray Canvas (tiles to zoom 16); CARTO's dark tiles now demand an API key
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        attribution: "© Esri, HERE, Garmin, © OpenStreetMap contributors",
        labels: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        maxNativeZoom: 16,
        big: false,
      },
    };
type Basemap = keyof typeof BASEMAPS;

const STATUS_FILTERS = ["all", "normal", "faulty", "disconnected"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

type PlantStatus = "Normal" | "Faulty" | "Disconnected" | typeof LOADING_STATUS;

/** Same reading of the realtime plant status as the plant directory (null = not received yet). */
const plantStatus = (s: number | null): { label: PlantStatus; level: StatusLevel; color: string } => {
  if (s == null) return { label: LOADING_STATUS, level: "neutral", color: "#64748b" };
  if (s === 1) return { label: "Normal", level: "ok", color: "#34d399" };
  if (s === 0 || s === 4) return { label: "Disconnected", level: "info", color: "#94a3b8" };
  return { label: "Faulty", level: "crit", color: "#f87171" };
};

/** List order (URL `sort`): status = faulty, disconnected, loading, normal, then name. */
const SORTS = ["status", "name", "kwp", "rain"] as const;
const SORT_LABEL: Record<(typeof SORTS)[number], string> = { status: "Status", name: "Name", kwp: "Capacity", rain: "Rain" };
const STATUS_RANK: Record<PlantStatus, number> = { Faulty: 0, Disconnected: 1, [LOADING_STATUS]: 2, Normal: 3 };

/** Search words, lower case; a leading "#" (plant id) is dropped. */
const searchTokens = (q: string): string[] =>
  q.normalize("NFC").toLowerCase().split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);

/** Every word must appear in the plant's name, city, id or "phase N" (any order). */
const matchesSearch = (p: GrowattPlant, tokens: string[]): boolean => {
  if (!tokens.length) return true;
  const hay = [p.name, p.city, String(p.plant_id), p.phase != null ? `phase ${p.phase} p${p.phase}` : ""]
    .join(" ")
    .normalize("NFC")
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
};

const FILTER_OF: Record<PlantStatus, StatusFilter | null> = {
  Normal: "normal",
  Faulty: "faulty",
  Disconnected: "disconnected",
  [LOADING_STATUS]: null,
};

const hasLocation = (p: GrowattPlant): boolean =>
  p.latitude != null &&
  p.longitude != null &&
  Number.isFinite(p.latitude) &&
  Number.isFinite(p.longitude) &&
  // 0,0 is Growatt's "not set", not a plant in the Gulf of Guinea
  !(p.latitude === 0 && p.longitude === 0) &&
  Math.abs(p.latitude) <= 90 &&
  Math.abs(p.longitude) <= 180;

/** Zoom when a plant is focused: roof level, like the Plant Overview satellite map. */
const PLANT_ZOOM = 18;

/** Marker style by zoom: status dots for the fleet view, kWp tags closer in, plant names at street level. */
type MarkerTier = "dot" | "tag" | "name";
const tierOf = (zoom: number): MarkerTier => (zoom >= 14 ? "name" : zoom >= 11 ? "tag" : "dot");

/** Disconnected and loading plants are drawn as hollow rings, so they read apart from colour alone. */
const LEVEL_CLASS: Record<StatusLevel, string> = { ok: "ok", crit: "crit", info: "off", neutral: "wait", warn: "warn" };

const escapeHtml = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Zero-size divIcon whose content centres itself on the point (dot) or stands on it (tag), so the
 *  label can be any width. */
const markerIcon = (
  o: { color: string; level: StatusLevel; size: number; kwp: number | null; name: string; rain: string | null },
  tier: MarkerTier,
  selected: boolean
): L.DivIcon => {
  // `rain` = Longdo's legend colour of the radar rain class over the plant: an outer ring
  const cls = `pm pm-${LEVEL_CLASS[o.level]}${selected ? " pm-sel" : ""}${o.rain ? " pm-rain" : ""}`;
  const style = `--c:${o.color};--d:${Math.round(o.size)}px${o.rain ? `;--rain:${o.rain}` : ""}`;
  const html =
    tier === "dot"
      ? `<span class="${cls} pm-dot" style="${style}"></span>`
      : `<span class="${cls} pm-tag" style="${style}"><i></i><b>${escapeHtml(fmt(o.kwp, 0))}</b><small>kWp</small>${
          tier === "name" ? `<em>${escapeHtml(o.name)}</em>` : ""
        }</span>`;
  return L.divIcon({
    html,
    className: "pm-icon",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    tooltipAnchor: tier === "dot" ? [0, -o.size / 2 - 2] : [0, -30],
  });
};


/** `/map`: every plant the user can see on one map, coloured by live status, sized by kWp. */
export const PlantMapPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { growattPlants, plantListLoaded } = useFleet();
  const [params, set] = useUrlState();
  const statusFilter = pick(params.get("status"), STATUS_FILTERS, "all");
  const basemap = pick(params.get("base"), ["sat", "dark"] as const, "dark"); // dark by default; `base=sat` = satellite
  const q = params.get("q") ?? "";
  // `full=1` = map only, over the whole window (opened in a new window by the map button)
  const full = params.get("full") === "1";
  const radarOn = params.get("radar") !== "0"; // on by default; `radar=0` turns it off
  const rainOnly = radarOn && params.get("rain") === "1";
  const selectedId = Number(params.get("plant")) || null;
  const phaseRaw = params.get("phase");
  const phaseFilter = phaseRaw && /^\d+$/.test(phaseRaw) ? Number(phaseRaw) : null;

  const plants = useMemo(
    () => growattPlants.map((p) => ({ plant: p, status: plantStatus(p.status), located: hasLocation(p) })),
    [growattPlants]
  );

  const options = useMemo(() => {
    const phases = new Map<number, number>();
    for (const { plant } of plants) {
      if (plant.phase != null) phases.set(plant.phase, (phases.get(plant.phase) ?? 0) + 1);
    }
    return {
      phases: [...phases.entries()].sort((a, b) => a[0] - b[0]),
    };
  }, [plants]);

  // radar rain now over each plant (polled only while the radar is on)
  const fleetRain = useFleetRain(radarOn);
  const rainOf = fleetRain.byId;

  // every filter but status: the status chips count within it, so their numbers say what a click shows
  const scoped = useMemo(() => {
    const tokens = searchTokens(q);
    return plants.filter(({ plant }) => {
      if (rainOnly && !((rainOf.get(plant.plant_id)?.rain?.intensity ?? 0) > 0)) return false;
      if (phaseFilter != null && plant.phase !== phaseFilter) return false;
      return matchesSearch(plant, tokens);
    });
  }, [plants, q, phaseFilter, rainOnly, rainOf]);

  const counts = useMemo(() => {
    const c = { all: scoped.length, normal: 0, faulty: 0, disconnected: 0 };
    for (const p of scoped) {
      const f = FILTER_OF[p.status.label];
      if (f) c[f] += 1;
    }
    return c;
  }, [scoped]);

  const sortBy = ((s) => (s === "rain" && !radarOn ? "status" : s))(pick(params.get("sort"), SORTS, "status"));
  const filtered = useMemo(() => {
    const out = statusFilter === "all" ? [...scoped] : scoped.filter(({ status }) => FILTER_OF[status.label] === statusFilter);
    const byName = (a: (typeof out)[number], b: (typeof out)[number]) => a.plant.name.localeCompare(b.plant.name);
    const rainOfPlant = (p: (typeof out)[number]) => rainOf.get(p.plant.plant_id)?.rain?.intensity ?? -1; // not checked last
    out.sort((a, b) => {
      if (sortBy === "kwp") return (b.plant.peak_power_kwp ?? -1) - (a.plant.peak_power_kwp ?? -1) || byName(a, b);
      if (sortBy === "rain") return rainOfPlant(b) - rainOfPlant(a) || byName(a, b);
      if (sortBy === "status") return STATUS_RANK[a.status.label] - STATUS_RANK[b.status.label] || byName(a, b);
      return byName(a, b);
    });
    return out;
  }, [scoped, statusFilter, sortBy, rainOf]);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search, as on most list pages
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = plants.find((p) => p.plant.plant_id === selectedId) ?? null;

  const maxKwp = useMemo(
    () => Math.max(1, ...plants.map((p) => p.plant.peak_power_kwp ?? 0)),
    [plants]
  );

  /* ------------------------------ Leaflet ------------------------------ */
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const baseLayer = useRef<L.LayerGroup | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<number, { mk: L.Marker; icon: (selected: boolean) => L.DivIcon }>());
  const [tier, setTier] = useState<MarkerTier>("dot");
  const fitted = useRef(false);
  const selectRef = useRef<(id: number) => void>(() => undefined);
  selectRef.current = (id: number) => set({ plant: id });

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { preferCanvas: true, maxZoom: 19, worldCopyJump: true, zoomControl: true });
    m.setView([13.7, 100.5], 6); // Thailand until the plants are loaded
    m.attributionControl.setPrefix(false);
    baseLayer.current = L.layerGroup().addTo(m);
    markerLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    m.on("zoomend", () => setTier(tierOf(m.getZoom())));
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      baseLayer.current = null;
      markerLayer.current = null;
      markers.current.clear();
    };
  }, []);

  // Longdo rain radar (on unless URL `radar=0`); hidden when the backend has no Longdo key
  const radar = useRainRadar(map, radarOn);
  const showRadar = radarOn && radar.available;
  const legend = useMemo(() => radar.data?.legend ?? [], [radar.data]);
  // an older snapshot on the map: rain over each plant read from that snapshot's tile image
  const framePoints = useMemo<FramePoint[]>(
    () => plants.filter((p) => p.located).map(({ plant }) => ({ id: plant.plant_id, lat: plant.latitude as number, lon: plant.longitude as number })),
    [plants]
  );
  const frameRain = useFrameRain(showRadar ? radar.data : null, radar.time, radar.isLatest, framePoints);
  const frameMode = showRadar && !radar.isLatest && radar.time != null && radar.data?.point_rain !== false && !radar.data?.frame_tiles;
  // where it rains in the snapshot on the map: the newest = Longdo's class per plant, strongest first;
  // an older one = plants under rain on its radar image, strongest echo first (no class: see frameRain.ts)
  const rainingPlants = useMemo<RainingPlant[]>(() => {
    if (frameMode) {
      if (!frameRain) return [];
      return plants
        .map(({ plant }) => ({ plant, s: frameRain.samples.get(plant.plant_id) }))
        .filter((r) => (r.s?.alpha ?? 0) >= RAIN_ALPHA)
        .sort((a, b) => (b.s?.alpha ?? 0) - (a.s?.alpha ?? 0) || a.plant.name.localeCompare(b.plant.name))
        .map(({ plant, s }) => ({ plantId: plant.plant_id, name: plant.name, city: plant.city ?? null, label: t("Rain"), color: s?.color ?? null }));
    }
    return plants
      .map(({ plant }) => ({ plant, rain: rainOf.get(plant.plant_id)?.rain }))
      .filter((r) => (r.rain?.intensity ?? 0) > 0)
      .sort((a, b) => (b.rain?.intensity ?? 0) - (a.rain?.intensity ?? 0) || a.plant.name.localeCompare(b.plant.name))
      .map(({ plant, rain }) => ({ plantId: plant.plant_id, name: plant.name, city: plant.city ?? null, ...rainLook(rain, legend) }));
  }, [frameMode, frameRain, plants, rainOf, legend, t]);
  const rainingFrame: RainingFrame | null =
    showRadar && radar.time != null
      ? frameMode
        ? { time: radar.time, source: "image", loading: !frameRain, unread: frameRain?.unread ?? 0, located: framePoints.length }
        : { time: radar.time, source: "longdo", loading: false, unread: 0, located: framePoints.length }
      : null;

  // basemap
  useEffect(() => {
    const g = baseLayer.current;
    if (!g) return;
    g.clearLayers();
    const b = BASEMAPS[basemap];
    const size = b.big ? { tileSize: 512, zoomOffset: -1 } : {};
    // crossOrigin: CORS responses, so the service worker can cache them (see vite.config.ts)
    L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.maxNativeZoom, attribution: b.attribution, crossOrigin: true, ...size }).addTo(g);
    if (b.labels) L.tileLayer(b.labels, { maxZoom: 19, maxNativeZoom: b.maxNativeZoom, opacity: 0.85, crossOrigin: true }).addTo(g);
  }, [basemap]);

  // markers: rebuilt when the list, the live status or the filter changes
  useEffect(() => {
    const g = markerLayer.current;
    if (!g) return;
    g.clearLayers();
    markers.current.clear();
    // the many normal plants at the bottom, so disconnected and faulty ones stay visible
    const order: Record<StatusLevel, number> = { ok: 0, neutral: 1, info: 2, warn: 3, crit: 4 };
    const shown = filtered.filter((p) => p.located).sort((a, b) => order[a.status.level] - order[b.status.level]);
    for (const { plant, status } of shown) {
      const kwp = plant.peak_power_kwp ?? 0;
      const size = 9 + 9 * Math.sqrt(Math.max(0, kwp) / maxKwp);
      const rain = rainOf.get(plant.plant_id)?.rain;
      const raining = rain && rain.intensity > 0 ? rainLook(rain, legend) : null;
      const look = { color: status.color, level: status.level, size, kwp: plant.peak_power_kwp, name: plant.name, rain: raining?.color ?? null };
      const icon = (selected: boolean) => markerIcon(look, tier, selected);
      const mk = L.marker([plant.latitude!, plant.longitude!], {
        icon: icon(false),
        riseOnHover: true,
        zIndexOffset: order[status.level] * 1000,
        keyboard: false,
      });
      mk.bindTooltip(
        `${plant.name} · ${fmt(plant.peak_power_kwp, 1)} kWp · ${t(status.label)}${raining ? ` · ${t("{rain} (radar)", { rain: raining.label })}` : ""}`,
        { direction: "top" }
      );
      mk.on("click", () => selectRef.current(plant.plant_id));
      mk.addTo(g);
      markers.current.set(plant.plant_id, { mk, icon });
    }
  }, [filtered, maxKwp, tier, rainOf, legend, t]);

  // highlight the selected plant
  useEffect(() => {
    const m = selectedId != null ? markers.current.get(selectedId) : undefined;
    if (!m) return;
    const z = (m.mk.options.zIndexOffset ?? 0);
    m.mk.setIcon(m.icon(true));
    m.mk.setZIndexOffset(100000);
    return () => {
      m.mk.setIcon(m.icon(false));
      m.mk.setZIndexOffset(z);
    };
  }, [selectedId, filtered, tier, rainOf, legend]);

  const fitAll = useCallback(() => {
    const m = map.current;
    const pts = filtered.filter((p) => p.located).map((p) => [p.plant.latitude!, p.plant.longitude!] as L.LatLngTuple);
    if (!m || pts.length === 0) return;
    if (pts.length === 1) m.setView(pts[0], 12);
    else m.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 12 });
  }, [filtered]);

  // first view: the whole fleet (or the plant from the URL)
  useEffect(() => {
    if (fitted.current || !plantListLoaded || !map.current) return;
    fitted.current = true;
    if (selected?.located) map.current.setView([selected.plant.latitude!, selected.plant.longitude!], PLANT_ZOOM);
    else fitAll();
  }, [plantListLoaded, fitAll, selected]);

  const focusPlant = (p: GrowattPlant) => {
    set({ plant: p.plant_id });
    if (hasLocation(p)) map.current?.flyTo([p.latitude!, p.longitude!], PLANT_ZOOM, { duration: 1.2 });
  };

  // what narrows the list now; each chip removes its own filter
  const statusLabel: Record<StatusFilter, string> = { all: t("All"), normal: t("Normal"), faulty: t("Faulty"), disconnected: t("Disconnected") };
  const activeFilters: { key: string; label: string; clear: () => void }[] = [
    ...(q.trim() ? [{ key: "q", label: `“${q.trim()}”`, clear: () => set({ q: null }) }] : []),
    ...(statusFilter !== "all" ? [{ key: "status", label: statusLabel[statusFilter], clear: () => set({ status: null }) }] : []),
    ...(phaseFilter != null ? [{ key: "phase", label: t("Phase {n}", { n: phaseFilter }), clear: () => set({ phase: null }) }] : []),
    ...(rainOnly ? [{ key: "rain", label: t("Rain now (radar)"), clear: () => set({ rain: null }) }] : []),
  ];
  const clearFilters = () => set({ q: null, status: null, phase: null, rain: null });

  const chips: { key: StatusFilter; label: string; level: StatusLevel; n: number }[] = [
    { key: "all", label: t("All"), level: "neutral", n: counts.all },
    { key: "normal", label: t("Normal"), level: "ok", n: counts.normal },
    { key: "faulty", label: t("Faulty"), level: "crit", n: counts.faulty },
    { key: "disconnected", label: t("Disconnected"), level: "info", n: counts.disconnected },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col">
        <h1 className="text-lg font-semibold">{t("Plant Map")}</h1>
        <p className="text-xs text-muted-foreground">{t("Every plant on one map, coloured by live status")}</p>
      </div>

      {!plantListLoaded ? (
        <LoadingState label={t("Loading plants…")} shape="chart" />
      ) : null}

      <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]", !plantListLoaded && "hidden")}>
        {/* Map */}
        <Card className={cn("relative gap-0 overflow-hidden p-0", full && "fixed inset-0 z-[45] rounded-none border-0")}>
          <div
            ref={el}
            className={cn("plant-map w-full", full ? "h-dvh" : "h-[calc(100vh-13rem)] min-h-[460px]")}
            aria-label={t("Map of all plants")}
          />

          {/* status filter */}
          <ToggleGroup
            type="single"
            className="absolute left-14 top-3 z-[400] flex-wrap gap-1 rounded-lg border border-white/[0.08] bg-ink-950/85 p-1 backdrop-blur"
            value={statusFilter}
            onValueChange={(v) => v && set({ status: v === "all" ? null : v })}
          >
            {chips.map((c) => (
              <ToggleGroupItem
                key={c.key}
                value={c.key}
                className="h-auto gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5 hover:text-slate-300 data-[state=on]:border-transparent data-[state=on]:bg-white/10 data-[state=on]:text-white data-[state=on]:ring-1 data-[state=on]:ring-white/15"
              >
                {c.key !== "all" && <Led level={c.level} />}
                {c.label}
                <span className="num text-slate-400">{c.n}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {/* map tools */}
          <div className="absolute right-3 top-3 z-[400] flex flex-col gap-1.5">
            {!full && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="bg-ink-950/85"
                    onClick={() => {
                      // same filters, basemap, radar and selected plant, map only
                      const next = new URLSearchParams(params);
                      next.set("full", "1");
                      const w = window.screen.availWidth;
                      const h = window.screen.availHeight;
                      window.open(`/map?${next}`, "plant-map-full", `popup,left=0,top=0,width=${w},height=${h}`);
                    }}
                    aria-label={t("Open the map in a new window")}
                  >
                    <AppWindow className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{t("Open full-screen map in a new window")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="bg-ink-950/85"
                  onClick={fitAll}
                  aria-label={t("Fit all shown plants")}
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{t("Fit all shown plants")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="bg-ink-950/85"
                  onClick={() => set({ base: basemap === "dark" ? "sat" : null })}
                  aria-label={t("Switch basemap")}
                >
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {t("Basemap: {current} (switch to {other})", { current: t(BASEMAPS[basemap].label), other: t(BASEMAPS[basemap === "sat" ? "dark" : "sat"].label) })}
              </TooltipContent>
            </Tooltip>
            {radar.available && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("bg-ink-950/85", radarOn && "text-sky-300 ring-1 ring-sky-400/50")}
                    onClick={() => set(radarOn ? { radar: "0", rain: null } : { radar: null })}
                    aria-label={t("Rain radar")}
                    aria-pressed={radarOn}
                  >
                    <CloudRain className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {radarOn
                    ? t("Rain radar ({source}): on", { source: radar.data?.fallback_reason ? "RainViewer" : "Longdo" })
                    : t("Rain radar ({source}): off", { source: radar.data?.fallback_reason ? "RainViewer" : "Longdo" })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* selected plant */}
          {selected && (
            <div className={cn("absolute left-3 z-[400] w-[min(360px,calc(100%-1.5rem))] rounded-xl", // the radar panel sits bottom right; the card goes above it where the map is too narrow for both
              showRadar ? (rainingPlants.length ? "bottom-[16.5rem] 2xl:bottom-6" : "bottom-[7.75rem] 2xl:bottom-6") : "bottom-6", " border border-white/[0.08] bg-ink-950/90 p-3 shadow-xl backdrop-blur")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-100">{selected.plant.name}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    #{selected.plant.plant_id}
                    {selected.plant.phase != null && ` · ${t("Phase {n}", { n: selected.plant.phase })}`}
                    {selected.plant.city && ` · ${selected.plant.city}`}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <StatusBadge
                    status={selected.status.label}
                    level={selected.status.level}
                    loading={selected.status.label === LOADING_STATUS}
                    dot
                  />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => set({ plant: null })} aria-label={t("Close")}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2.5 text-[11px]">
                <div>
                  <div className="text-slate-500">{t("DC capacity")}</div>
                  <div className="num font-semibold text-solar-400">{fmt(selected.plant.peak_power_kwp, 1)} kWp</div>
                </div>
                <div>
                  <div className="text-slate-500">{t("Power now")}</div>
                  <div className="num font-semibold text-slate-200">
                    {fmt(selected.plant.current_power_w != null ? selected.plant.current_power_w / 1000 : null, 1)} kW
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">{t("Today")}</div>
                  <div className="num font-semibold text-slate-200">{fmt(selected.plant.today_energy_kwh, 1)} kWh</div>
                </div>
              </div>
              <div className="mt-1.5 text-[11px] text-slate-500">
                {selected.located
                  ? `${selected.plant.latitude!.toFixed(5)}, ${selected.plant.longitude!.toFixed(5)}`
                  : t("No location set in Growatt")}
                {selected.plant.inverter_count != null && ` · ${t("{n} inverters", { n: selected.plant.inverter_count })}`}
              </div>
              {radar.available && radar.data && radar.data.point_rain !== false && selected.located && (
                <PlantRainRow plantId={selected.plant.plant_id} legend={radar.data.legend} />
              )}
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => navigate(plantPath(selected.plant.plant_id))}>
                  {t("Open plant")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => navigate(routeHref({ plantIds: [selected.plant.plant_id] }))}>
                  <Route data-icon="inline-start" />
                  {t("Add to route")}
                </Button>
                {selected.located && (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${selected.plant.latitude},${selected.plant.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google Maps <ExternalLink className="h-3 w-3" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
          )}
          {showRadar && (
            <RainRadarBar
              radar={radar}
              fleet={fleetRain}
              rainOnly={rainOnly}
              onRainOnly={(v) => set({ rain: v ? "1" : null })}
              raining={rainingPlants}
              rainingFrame={rainingFrame}
              onPick={(id) => set({ plant: id })}
            />
          )}
        </Card>

        {/* Plant list */}
        <Card className={cn("gap-0 overflow-hidden p-0 lg:h-[calc(100vh-13rem)] lg:min-h-[460px]", full && "hidden")}>
          <div className="border-b border-white/[0.06] p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input
                ref={searchRef}
                value={q}
                onChange={(e) => set({ q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (q) set({ q: null });
                    else e.currentTarget.blur();
                  } else if (e.key === "Enter" && filtered.length > 0) {
                    focusPlant(filtered[0].plant); // the first result, as listed
                  }
                }}
                placeholder={t("Search name, city, ID or phase")}
                className="pr-14 pl-8"
                aria-label={t("Search plants")}
                aria-describedby="plant-search-hint"
              />
              {q ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => {
                    set({ q: null });
                    searchRef.current?.focus();
                  }}
                  aria-label={t("Clear search")}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Kbd className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent text-slate-500">/</Kbd>
              )}
              <span id="plant-search-hint" className="sr-only">
                {t("Every word must match. Enter opens the first result, Escape clears.")}
              </span>
            </div>
            <div className="mt-2 flex gap-2">
              <Select value={phaseFilter != null ? String(phaseFilter) : "all"} onValueChange={(v) => set({ phase: v === "all" ? null : v })}>
                <SelectTrigger className="min-w-0 flex-1 text-[11px]" aria-label={t("Phase")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All phases")}</SelectItem>
                  {options.phases.map(([ph, n]) => (
                    <SelectItem key={ph} value={String(ph)}>
                      {t("Phase {n}", { n: ph })} ({n})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => set({ sort: v === "status" ? null : v })}>
                <SelectTrigger className="min-w-0 flex-1 text-[11px]" aria-label={t("Sort plants")}>
                  <span className="text-slate-500">{t("Sort:")}</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORTS.filter((s) => s !== "rain" || radarOn).map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(SORT_LABEL[s])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0"
                    disabled={!filtered.some((p) => p.located)}
                    onClick={fitAll}
                    aria-label={t("Zoom the map to the plants listed")}
                  >
                    <LocateFixed className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{t("Zoom the map to the {n} plants listed", { n: fmtInt(filtered.filter((p) => p.located).length) })}</TooltipContent>
              </Tooltip>
            </div>
            {activeFilters.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1" aria-label={t("Active filters")}>
                {activeFilters.map((f) => (
                  <Button
                    key={f.key}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={f.clear}
                    className="h-auto max-w-full gap-1 rounded-full bg-white/[0.04] py-0.5 pr-1.5 pl-2 text-[11px] font-normal text-slate-300 hover:border-white/10 hover:bg-white/10"
                    aria-label={t("Remove filter {label}", { label: f.label })}
                  >
                    <span className="truncate">{f.label}</span>
                    <X className="h-3 w-3 shrink-0 text-slate-500" />
                  </Button>
                ))}
                {activeFilters.length > 1 && (
                  <Button type="button" variant="ghost" size="xs" onClick={clearFilters}>
                    {t("Clear all")}
                  </Button>
                )}
              </div>
            )}
            <div className="mt-2 text-[11px] text-slate-500" aria-live="polite">
              {activeFilters.length
                ? t("{n} of {total} plants", { n: fmtInt(filtered.length), total: fmtInt(plants.length) })
                : t("{n} plants", { n: fmtInt(plants.length) })}
              {filtered.some((p) => !p.located) && ` · ${t("{n} without location", { n: fmtInt(filtered.filter((p) => !p.located).length) })}`}
            </div>
          </div>
          <div className="max-h-[420px] overflow-y-auto lg:max-h-none lg:flex-1">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-slate-500">
                <span>{t("No plant matches {filters}.", { filters: activeFilters.map((f) => f.label).join(" · ") })}</span>
                <Button type="button" variant="outline" size="xs" onClick={clearFilters}>
                  {t("Clear filters")}
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-white/[0.04]">
                {filtered.map(({ plant, status, located }) => {
                  const rain = rainOf.get(plant.plant_id)?.rain;
                  const raining = rain && rain.intensity > 0 ? rainLook(rain, legend) : null;
                  return (
                  <li key={plant.plant_id}>
                    <button
                      type="button"
                      onClick={() => focusPlant(plant)}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-white/[0.04]",
                        plant.plant_id === selectedId && "bg-solar-500/10"
                      )}
                    >
                      <Led level={status.level} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-slate-200">{plant.name}</div>
                        <div className="truncate text-[11px] text-slate-500">{plant.city ?? "—"}</div>
                      </div>
                      <div className="text-right">
                        <div className="num text-[11px] font-semibold text-solar-400">{fmt(plant.peak_power_kwp, 1)} kWp</div>
                        {!located && (
                          <div className="flex items-center justify-end gap-1 text-[10px] text-slate-500">
                            <MapPinOff className="h-3 w-3" /> {t("no location")}
                          </div>
                        )}
                        {raining && (
                          <div className="flex items-center justify-end gap-1 text-[10px] text-sky-300" title={t("Longdo weather radar, not measured")}>
                            {raining.color && <i className="h-1.5 w-1.5 rounded-full" style={{ background: raining.color }} />}
                            {raining.label}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default PlantMapPage;
