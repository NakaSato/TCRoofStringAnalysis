import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ExternalLink, Layers, MapPinOff, Maximize2, Search, X } from "lucide-react";
import { useFleet } from "../context/FleetContext";
import { plantPath } from "../context/routes";
import { pick, useUrlState } from "../lib/useUrlState";
import type { GrowattPlant } from "../api/client";
import { Led, LoadingState, LOADING_STATUS, PageHeader, StatusBadge, fmt, fmtInt } from "../components/ui";
import type { StatusLevel } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/* Basemaps: free tiles, no key; attribution is required. */
const BASEMAPS = {
  sat: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    // place names over the imagery, so the overview stays readable
    labels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  },
  dark: {
    label: "Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap contributors © CARTO",
    labels: null,
  },
} as const;
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
  o: { color: string; level: StatusLevel; size: number; kwp: number | null; name: string },
  tier: MarkerTier,
  selected: boolean
): L.DivIcon => {
  const cls = `pm pm-${LEVEL_CLASS[o.level]}${selected ? " pm-sel" : ""}`;
  const style = `--c:${o.color};--d:${Math.round(o.size)}px`;
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
  const { growattPlants, plantListLoaded } = useFleet();
  const [params, set] = useUrlState();
  const statusFilter = pick(params.get("status"), STATUS_FILTERS, "all");
  const basemap = pick(params.get("base"), ["sat", "dark"] as const, "sat");
  const q = params.get("q") ?? "";
  const selectedId = Number(params.get("plant")) || null;
  const phaseRaw = params.get("phase");
  const phaseFilter = phaseRaw && /^\d+$/.test(phaseRaw) ? Number(phaseRaw) : null;

  const plants = useMemo(
    () => growattPlants.map((p) => ({ plant: p, status: plantStatus(p.status), located: hasLocation(p) })),
    [growattPlants]
  );

  const counts = useMemo(() => {
    const c = { all: plants.length, normal: 0, faulty: 0, disconnected: 0, located: 0 };
    for (const p of plants) {
      const f = FILTER_OF[p.status.label];
      if (f) c[f] += 1;
      if (p.located) c.located += 1;
    }
    return c;
  }, [plants]);

  const options = useMemo(() => {
    const phases = new Map<number, number>();
    for (const { plant } of plants) {
      if (plant.phase != null) phases.set(plant.phase, (phases.get(plant.phase) ?? 0) + 1);
    }
    return {
      phases: [...phases.entries()].sort((a, b) => a[0] - b[0]),
    };
  }, [plants]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return plants.filter(({ plant, status }) => {
      if (statusFilter !== "all" && FILTER_OF[status.label] !== statusFilter) return false;
      if (phaseFilter != null && plant.phase !== phaseFilter) return false;
      if (!needle) return true;
      return [plant.name, plant.city, String(plant.plant_id)].some((v) => v?.toLowerCase().includes(needle));
    });
  }, [plants, statusFilter, q, phaseFilter]);

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

  // basemap
  useEffect(() => {
    const g = baseLayer.current;
    if (!g) return;
    g.clearLayers();
    const b = BASEMAPS[basemap];
    L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: basemap === "sat" ? 19 : 20, attribution: b.attribution }).addTo(g);
    if (b.labels) L.tileLayer(b.labels, { maxZoom: 19, opacity: 0.85 }).addTo(g);
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
      const look = { color: status.color, level: status.level, size, kwp: plant.peak_power_kwp, name: plant.name };
      const icon = (selected: boolean) => markerIcon(look, tier, selected);
      const mk = L.marker([plant.latitude!, plant.longitude!], {
        icon: icon(false),
        riseOnHover: true,
        zIndexOffset: order[status.level] * 1000,
        keyboard: false,
      });
      mk.bindTooltip(`${plant.name} · ${fmt(plant.peak_power_kwp, 1)} kWp · ${status.label}`, { direction: "top" });
      mk.on("click", () => selectRef.current(plant.plant_id));
      mk.addTo(g);
      markers.current.set(plant.plant_id, { mk, icon });
    }
  }, [filtered, maxKwp, tier]);

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
  }, [selectedId, filtered, tier]);

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

  const chips: { key: StatusFilter; label: string; level: StatusLevel; n: number }[] = [
    { key: "all", label: "All", level: "neutral", n: counts.all },
    { key: "normal", label: "Normal", level: "ok", n: counts.normal },
    { key: "faulty", label: "Faulty", level: "crit", n: counts.faulty },
    { key: "disconnected", label: "Disconnected", level: "info", n: counts.disconnected },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Plant Map"
      />

      {!plantListLoaded ? (
        <LoadingState label="Loading plants…" shape="chart" />
      ) : null}

      <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]", !plantListLoaded && "hidden")}>
        {/* Map */}
        <Card className="relative gap-0 overflow-hidden p-0">
          <div ref={el} className="plant-map h-[calc(100vh-13rem)] min-h-[460px] w-full" aria-label="Map of all plants" />

          {/* status filter */}
          <div className="absolute left-14 top-3 z-[400] flex flex-wrap gap-1 rounded-lg border border-white/[0.08] bg-ink-950/85 p-1 backdrop-blur">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => set({ status: c.key === "all" ? null : c.key })}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-300 transition",
                  statusFilter === c.key ? "bg-white/10 text-white ring-1 ring-white/15" : "hover:bg-white/5"
                )}
              >
                {c.key !== "all" && <Led level={c.level} />}
                {c.label}
                <span className="num text-slate-400">{c.n}</span>
              </button>
            ))}
          </div>

          {/* map tools */}
          <div className="absolute right-3 top-3 z-[400] flex flex-col gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="bg-ink-950/85"
                  onClick={fitAll}
                  aria-label="Fit all shown plants"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Fit all shown plants</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="bg-ink-950/85"
                  onClick={() => set({ base: basemap === "sat" ? "dark" : null })}
                  aria-label="Switch basemap"
                >
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                Basemap: {BASEMAPS[basemap].label} (switch to {BASEMAPS[basemap === "sat" ? "dark" : "sat"].label})
              </TooltipContent>
            </Tooltip>
          </div>

          {/* selected plant */}
          {selected && (
            <div className="absolute bottom-6 left-3 z-[400] w-[min(360px,calc(100%-1.5rem))] rounded-xl border border-white/[0.08] bg-ink-950/90 p-3 shadow-xl backdrop-blur">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-100">{selected.plant.name}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    #{selected.plant.plant_id}
                    {selected.plant.phase != null && ` · Phase ${selected.plant.phase}`}
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
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => set({ plant: null })} aria-label="Close">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2.5 text-[11px]">
                <div>
                  <div className="text-slate-500">DC capacity</div>
                  <div className="num font-semibold text-solar-400">{fmt(selected.plant.peak_power_kwp, 1)} kWp</div>
                </div>
                <div>
                  <div className="text-slate-500">Power now</div>
                  <div className="num font-semibold text-slate-200">
                    {fmt(selected.plant.current_power_w != null ? selected.plant.current_power_w / 1000 : null, 1)} kW
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Today</div>
                  <div className="num font-semibold text-slate-200">{fmt(selected.plant.today_energy_kwh, 1)} kWh</div>
                </div>
              </div>
              <div className="mt-1.5 text-[11px] text-slate-500">
                {selected.located
                  ? `${selected.plant.latitude!.toFixed(5)}, ${selected.plant.longitude!.toFixed(5)}`
                  : "No location set in Growatt"}
                {selected.plant.inverter_count != null && ` · ${selected.plant.inverter_count} inverters`}
              </div>
              <div className="mt-2.5 flex gap-2">
                <Button type="button" size="sm" onClick={() => navigate(plantPath(selected.plant.plant_id))}>
                  Open plant
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
        </Card>

        {/* Plant list */}
        <Card className="gap-0 overflow-hidden p-0 lg:h-[calc(100vh-13rem)] lg:min-h-[460px]">
          <div className="border-b border-white/[0.06] p-3">
            <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input
                value={q}
                onChange={(e) => set({ q: e.target.value })}
                placeholder="Search plant, city or ID"
                className="pl-8"
                aria-label="Search plants"
              />
            </div>
              <Select value={phaseFilter != null ? String(phaseFilter) : "all"} onValueChange={(v) => set({ phase: v === "all" ? null : v })}>
                <SelectTrigger className="w-28 shrink-0 text-[11px]" aria-label="Phase">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All phases</SelectItem>
                  {options.phases.map(([ph, n]) => (
                    <SelectItem key={ph} value={String(ph)}>
                      Phase {ph} ({n})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>
              {fmtInt(filtered.length)} plants shown
              {filtered.some((p) => !p.located) && ` · ${filtered.filter((p) => !p.located).length} without location`}
              </span>
              {(q || phaseFilter != null) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => set({ q: null, phase: null })}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </div>
          <div className="max-h-[420px] overflow-y-auto lg:max-h-none lg:flex-1">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">No plant matches.</div>
            ) : (
              <ul className="divide-y divide-white/[0.04]">
                {filtered.map(({ plant, status, located }) => (
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
                            <MapPinOff className="h-3 w-3" /> no location
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default PlantMapPage;
