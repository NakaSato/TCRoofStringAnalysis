import React, { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { Scan } from "lucide-react";
import "leaflet/dist/leaflet.css";
import "./routeMap.css";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../../i18n";
import {
  REASON_COLOR,
  REASON_GROUP_LABEL,
  REASON_LABEL,
  ROUTE_BASEMAP,
  attributionHtml,
  escapeHtml,
  isValidLatLon,
  reasonGroup,
  sortReasons,
  topReason,
} from "./mapUtils";

export interface RouteMapPoint {
  plant_id: number | null;
  name: string;
  lat: number;
  lon: number;
}
export interface RouteMapStop extends RouteMapPoint {
  plant_id: number;
  /** visit number once solved; null = added but not solved yet */
  seq: number | null;
  /** after sunset / after the latest finish / window missed */
  late: boolean;
  /** "HH:MM" */
  eta: string | null;
}
export interface RouteMapCandidate {
  plant_id: number;
  name: string;
  lat: number;
  lon: number;
  /** "task" | "issue" | "alarm" | "claim" | "cleaning_due" | "pm_due" */
  reasonKinds: string[];
  inRoute: boolean;
}
export interface RouteMapProps {
  start: RouteMapPoint | null;
  stops: RouteMapStop[];
  /** [lon, lat] per point, one line per leg */
  geometry: { type: "MultiLineString"; coordinates: number[][][] } | null;
  geometrySource: "geoapify" | "straight_line" | null;
  candidates: RouteMapCandidate[];
  selectedPlantId: number | null;
  /** click on a stop or candidate marker */
  onSelect: (plantId: number) => void;
  /** "Add to route" / "Remove from route" in the marker popup */
  onToggleStop: (plantId: number) => void;
  /** when true, the cursor is a crosshair and a map click calls onPickStart */
  pickingStart: boolean;
  onPickStart?: (lat: number, lon: number) => void;
  /** e.g. ["Powered by Geoapify", "© OpenStreetMap contributors"] */
  attribution: string[];
  /** extra buttons in the top-right corner, after "Fit the route" (e.g. the phone's map size toggle) */
  controls?: React.ReactNode;
  className?: string;
}

/* Panes, bottom to top: tiles (200), route line, candidates, stops, start; Leaflet's tooltips (650) and
   popups (700) stay above them. */
const PANE_ROUTE = "rmRoute";
const PANE_CAND = "rmCandidates";
const PANE_STOP = "rmStops";
const PANE_START = "rmStart";
const PANES: [string, number][] = [
  [PANE_ROUTE, 390],
  [PANE_CAND, 610],
  [PANE_STOP, 620],
  [PANE_START, 630],
];

/** Route line: solid road route (Geoapify); a straight line is dashed and muted. */
const ROAD_LINE: L.PolylineOptions = { color: "#38bdf8", weight: 4, opacity: 0.95, lineCap: "round", lineJoin: "round" };
const ROAD_CASING: L.PolylineOptions = { color: "#05080f", weight: 7, opacity: 0.75, lineCap: "round", lineJoin: "round" };
const STRAIGHT_LINE: L.PolylineOptions = { color: "#94a3b8", weight: 2.5, opacity: 0.75, dashArray: "6 8", lineCap: "round" };

const STOP_R = 12;
const CAND_R = 5;
const START_R = 13;

/** Home glyph (static markup, no data in it). */
const HOME_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>';

/** Zero-size divIcon whose content centres itself on the point (as on the Plant Map). */
const centredIcon = (html: string): L.DivIcon =>
  L.divIcon({ html, className: "rm-icon", iconSize: [0, 0], iconAnchor: [0, 0] });

const stopIcon = (s: RouteMapStop, selected: boolean): L.DivIcon => {
  const cls = `rm rm-stop${s.seq == null ? " rm-unsolved" : ""}${s.late ? " rm-late" : ""}${selected ? " rm-sel" : ""}`;
  return centredIcon(`<span class="${cls}">${s.seq != null ? escapeHtml(String(s.seq)) : ""}</span>`);
};

const candidateIcon = (color: string, selected: boolean): L.DivIcon =>
  centredIcon(`<span class="rm rm-cand${selected ? " rm-sel" : ""}" style="--c:${color}"></span>`);

type T = (en: string, vars?: Record<string, string | number | null | undefined>) => string;

const reasonLabel = (kind: string, t: T) => (REASON_LABEL[kind] ? t(REASON_LABEL[kind]) : kind);

/** Popup content as a DOM element, so the button gets its handler directly. Every string is escaped. */
const popupContent = (
  o: { name: string; meta: string[]; late: string | null; reasons: string[]; inRoute: boolean },
  t: T,
  onToggle: () => void
): HTMLElement => {
  const el = document.createElement("div");
  el.className = "rm-pop";
  const reasons = sortReasons(o.reasons);
  el.innerHTML =
    `<div class="rm-pop-name">${escapeHtml(o.name)}</div>` +
    o.meta.map((m) => `<div class="rm-pop-meta">${escapeHtml(m)}</div>`).join("") +
    (o.late ? `<div class="rm-pop-meta rm-pop-late">${escapeHtml(o.late)}</div>` : "") +
    (reasons.length
      ? `<div class="rm-pop-reasons">${reasons
          .map((k) => `<span><i style="--c:${REASON_COLOR[reasonGroup(k)]}"></i>${escapeHtml(reasonLabel(k, t))}</span>`)
          .join("")}</div>`
      : "") +
    `<button type="button" class="rm-pop-btn${o.inRoute ? " rm-pop-remove" : ""}">${escapeHtml(
      o.inRoute ? t("Remove from route") : t("Add to route")
    )}</button>`;
  // clicks inside the popup never reach the map (start picking)
  L.DomEvent.disableClickPropagation(el);
  el.querySelector("button")?.addEventListener("click", (e) => {
    e.preventDefault();
    onToggle();
  });
  return el;
};

interface MarkerEntry {
  mk: L.Marker;
  icon: (selected: boolean) => L.DivIcon;
  open: () => void;
  z: number;
}

/** Cheap signature of the route geometry (it can hold thousands of points). */
const geometrySig = (g: RouteMapProps["geometry"], src: RouteMapProps["geometrySource"]): string => {
  if (!g || !Array.isArray(g.coordinates)) return `none|${src ?? ""}`;
  const lines = g.coordinates;
  const n = lines.reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0);
  const first = lines[0]?.[0];
  const lastLine = lines[lines.length - 1];
  const last = lastLine?.[lastLine.length - 1];
  return `${src ?? ""}|${lines.length}|${n}|${first?.join(",") ?? ""}|${last?.join(",") ?? ""}`;
};

/** Valid [lat, lon] points of the geometry, one array per leg (legs with fewer than 2 points dropped). */
const geometryLatLngs = (g: RouteMapProps["geometry"]): L.LatLngTuple[][] => {
  if (!g || g.type !== "MultiLineString" || !Array.isArray(g.coordinates)) return [];
  return g.coordinates
    .map((line) =>
      (Array.isArray(line) ? line : [])
        .filter((p) => Array.isArray(p) && isValidLatLon(p[1], p[0]))
        .map((p) => [p[1], p[0]] as L.LatLngTuple)
    )
    .filter((line) => line.length >= 2);
};

/** Visit Route map: start, numbered stops, the route line and the candidate plants. Draws only what the
 *  props hold; a point with an invalid lat / lon is skipped. */
export const RouteMap: React.FC<RouteMapProps> = (props) => {
  const { start, stops, geometry, geometrySource, candidates, selectedPlantId, pickingStart, attribution, controls, className } = props;
  const { t } = useI18n();

  // latest props for the Leaflet handlers, so the layers need not be rebuilt for new callbacks
  const latest = useRef(props);
  latest.current = props;

  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const candLayer = useRef<L.LayerGroup | null>(null);
  const stopLayer = useRef<L.LayerGroup | null>(null);
  const startLayer = useRef<L.LayerGroup | null>(null);
  const stopMarkers = useRef(new Map<number, MarkerEntry>());
  const candMarkers = useRef(new Map<number, MarkerEntry>());
  /** plant whose popup to open again after its marker is rebuilt (Add / Remove swaps candidate ↔ stop) */
  const reopen = useRef<number | null>(null);

  // signatures: the layers are rebuilt when what they show changes, not when an array is re-created
  const stopsKey = useMemo(
    () => JSON.stringify(stops.map((s) => [s.plant_id, s.seq, s.late, s.eta, s.name, s.lat, s.lon])),
    [stops]
  );
  const candKey = useMemo(
    () => JSON.stringify(candidates.map((c) => [c.plant_id, c.name, c.lat, c.lon, c.inRoute, c.reasonKinds])),
    [candidates]
  );
  const startKey = start ? JSON.stringify([start.plant_id, start.name, start.lat, start.lon]) : "";
  const geoKey = geometrySig(geometry, geometrySource);
  const attrKey = JSON.stringify(attribution);

  /* ---------------------------- map, once ---------------------------- */
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { maxZoom: 19, worldCopyJump: true, zoomControl: true });
    m.setView([13.7, 100.5], 6); // Thailand until there is something to show
    m.attributionControl.setPrefix(false);
    for (const [name, z] of PANES) m.createPane(name).style.zIndex = String(z);
    const b = ROUTE_BASEMAP;
    const size = b.big ? { tileSize: 512, zoomOffset: -1 } : {};
    // crossOrigin: CORS responses, so the service worker can cache them (see vite.config.ts)
    L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.maxNativeZoom, attribution: b.attribution, crossOrigin: true, ...size }).addTo(m);
    if (b.labels) L.tileLayer(b.labels, { maxZoom: 19, maxNativeZoom: b.maxNativeZoom, opacity: 0.85, crossOrigin: true }).addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    candLayer.current = L.layerGroup().addTo(m);
    stopLayer.current = L.layerGroup().addTo(m);
    startLayer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => {
      const p = latest.current;
      if (!p.pickingStart) return;
      L.DomEvent.stopPropagation(e.originalEvent);
      p.onPickStart?.(e.latlng.lat, e.latlng.lng);
    });
    map.current = m;
    // the page is split / stacked on a phone: keep Leaflet's size in step with the box
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      routeLayer.current = candLayer.current = stopLayer.current = startLayer.current = null;
      stopMarkers.current.clear();
      candMarkers.current.clear();
    };
  }, []);

  /** A marker click: pick the start there while picking, else select the plant and open its popup. */
  const onMarkerClick = (e: L.LeafletMouseEvent, plantId: number, open: () => void) => {
    L.DomEvent.stopPropagation(e.originalEvent);
    const p = latest.current;
    if (p.pickingStart) {
      p.onPickStart?.(e.latlng.lat, e.latlng.lng);
      return;
    }
    p.onSelect(plantId);
    open();
  };
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;

  const popupFor = (m: L.Map, ll: L.LatLng, offset: number, content: () => HTMLElement) => () =>
    L.popup({ offset: [0, -offset], maxWidth: 260, autoPanPadding: [16, 16], closeButton: true })
      .setLatLng(ll)
      .setContent(content())
      .openOn(m);

  const toggle = (plantId: number) => {
    reopen.current = plantId;
    latest.current.onToggleStop(plantId);
  };

  /* ---------------------------- attribution ---------------------------- */
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const tiles = ROUTE_BASEMAP.attribution;
    // skip what the basemap credit already says (e.g. "© OpenStreetMap contributors" with Esri)
    const items = [...new Set(attribution.map((a) => a.trim()).filter((a) => a && !tiles.includes(a)))].map(attributionHtml);
    items.forEach((a) => m.attributionControl.addAttribution(a));
    return () => {
      items.forEach((a) => m.attributionControl.removeAttribution(a));
    };
  }, [attrKey]);

  /* ---------------------------- route line ---------------------------- */
  useEffect(() => {
    const g = routeLayer.current;
    if (!g) return;
    g.clearLayers();
    const lines = geometryLatLngs(latest.current.geometry);
    if (!lines.length) return;
    if (latest.current.geometrySource === "straight_line") {
      L.polyline(lines, { ...STRAIGHT_LINE, pane: PANE_ROUTE, interactive: false }).addTo(g);
    } else {
      L.polyline(lines, { ...ROAD_CASING, pane: PANE_ROUTE, interactive: false }).addTo(g);
      L.polyline(lines, { ...ROAD_LINE, pane: PANE_ROUTE, interactive: false }).addTo(g);
    }
  }, [geoKey]);

  /* ---------------------------- candidates ---------------------------- */
  useEffect(() => {
    const g = candLayer.current;
    const m = map.current;
    if (!g || !m) return;
    g.clearLayers();
    candMarkers.current.clear();
    // the most urgent on top
    const rank = { fault: 4, task: 3, claim: 2, due: 1, other: 0 } as const;
    const shown = latest.current.candidates
      .filter((c) => !c.inRoute && isValidLatLon(c.lat, c.lon))
      .map((c) => ({ c, group: topReason(c.reasonKinds) }))
      .sort((a, b) => rank[a.group] - rank[b.group]);
    for (const { c, group } of shown) {
      const color = REASON_COLOR[group];
      const icon = (sel: boolean) => candidateIcon(color, sel);
      const z = rank[group] * 100;
      const mk = L.marker([c.lat, c.lon], { icon: icon(false), pane: PANE_CAND, riseOnHover: true, keyboard: false, zIndexOffset: z });
      const top = sortReasons(c.reasonKinds)[0];
      mk.bindTooltip(escapeHtml(top ? `${c.name} · ${reasonLabel(top, t)}` : c.name), { direction: "top", offset: [0, -CAND_R - 2] });
      const open = popupFor(m, mk.getLatLng(), CAND_R + 2, () =>
        popupContent({ name: c.name, meta: [], late: null, reasons: c.reasonKinds, inRoute: false }, t, () => toggle(c.plant_id))
      );
      mk.on("click", (e) => onMarkerClickRef.current(e, c.plant_id, open));
      mk.addTo(g);
      candMarkers.current.set(c.plant_id, { mk, icon, open, z });
    }
  }, [candKey, t]);

  /* ---------------------------- stops ---------------------------- */
  useEffect(() => {
    const g = stopLayer.current;
    const m = map.current;
    if (!g || !m) return;
    g.clearLayers();
    stopMarkers.current.clear();
    const reasonsOf = new Map(latest.current.candidates.map((c) => [c.plant_id, c.reasonKinds]));
    // later visits under earlier ones, so stop 1 stays readable where the numbers overlap
    const shown = latest.current.stops
      .filter((s) => isValidLatLon(s.lat, s.lon))
      .sort((a, b) => (b.seq ?? Infinity) - (a.seq ?? Infinity));
    shown.forEach((s, i) => {
      const icon = (sel: boolean) => stopIcon(s, sel);
      const z = i * 10;
      const mk = L.marker([s.lat, s.lon], { icon: icon(false), pane: PANE_STOP, riseOnHover: true, keyboard: false, zIndexOffset: z });
      const head = s.seq != null ? t("Stop {n}", { n: s.seq }) : t("Not solved yet");
      const eta = s.eta ? t("ETA {time}", { time: s.eta }) : null;
      const tip = [`${head} · ${s.name}`, eta, s.late ? t("Late") : null].filter(Boolean).join(" · ");
      mk.bindTooltip(escapeHtml(tip), { direction: "top", offset: [0, -STOP_R - 2] });
      const open = popupFor(m, mk.getLatLng(), STOP_R + 2, () =>
        popupContent(
          {
            name: s.name,
            meta: [eta ? `${head} · ${eta}` : head],
            late: s.late ? t("Late: after sunset, after the latest finish or outside the visit window") : null,
            reasons: reasonsOf.get(s.plant_id) ?? [],
            inRoute: true,
          },
          t,
          () => toggle(s.plant_id)
        )
      );
      mk.on("click", (e) => onMarkerClickRef.current(e, s.plant_id, open));
      mk.addTo(g);
      stopMarkers.current.set(s.plant_id, { mk, icon, open, z });
    });
  }, [stopsKey, candKey, t]);

  /* ---------------------------- start ---------------------------- */
  useEffect(() => {
    const g = startLayer.current;
    if (!g) return;
    g.clearLayers();
    const s = latest.current.start;
    if (!s || !isValidLatLon(s.lat, s.lon)) return;
    const mk = L.marker([s.lat, s.lon], {
      icon: centredIcon(`<span class="rm rm-start">${HOME_SVG}</span>`),
      pane: PANE_START,
      keyboard: false,
    });
    mk.bindTooltip(escapeHtml(s.name ? `${t("Start")} · ${s.name}` : t("Start")), { direction: "top", offset: [0, -START_R - 2] });
    // while picking, a click on the start picks that spot again; otherwise nothing happens on it
    mk.on("click", (e) => {
      L.DomEvent.stopPropagation(e.originalEvent);
      const p = latest.current;
      if (p.pickingStart) p.onPickStart?.(e.latlng.lat, e.latlng.lng);
    });
    mk.addTo(g);
  }, [startKey, t]);

  /* ---------------------------- reopen after Add / Remove ---------------------------- */
  useEffect(() => {
    const id = reopen.current;
    if (id == null) return;
    reopen.current = null;
    // the open popup shows the old Add / Remove state: replace it, or close it when the plant has no marker now
    map.current?.closePopup();
    (stopMarkers.current.get(id) ?? candMarkers.current.get(id))?.open();
  }, [stopsKey, candKey]);

  /* ---------------------------- selected plant ---------------------------- */
  useEffect(() => {
    if (selectedPlantId == null) return;
    const e = stopMarkers.current.get(selectedPlantId) ?? candMarkers.current.get(selectedPlantId);
    if (!e) return;
    e.mk.setIcon(e.icon(true));
    e.mk.setZIndexOffset(100000);
    return () => {
      e.mk.setIcon(e.icon(false));
      e.mk.setZIndexOffset(e.z);
    };
  }, [selectedPlantId, stopsKey, candKey, t]);

  /* ---------------------------- picking the start ---------------------------- */
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.getContainer().classList.toggle("rm-picking", pickingStart);
    if (pickingStart) m.closePopup();
  }, [pickingStart]);

  /* ---------------------------- fitting ---------------------------- */
  // refit when the set of stops, the start or the route changes (not on every render or re-solve order);
  // with no stops, fit the start and the candidates
  const stopSet = useMemo(
    () => stops.map((s) => s.plant_id).sort((a, b) => a - b).join(","),
    [stops]
  );
  const candSet = useMemo(
    () => (stops.length ? "" : candidates.map((c) => c.plant_id).sort((a, b) => a - b).join(",")),
    [stops.length, candidates]
  );
  const startPos = start && isValidLatLon(start.lat, start.lon) ? `${start.lat},${start.lon}` : "";
  const fitKey = `${stopSet}|${startPos}|${stops.length ? geoKey : candSet}`;
  /** fit the start, the stops and the route line; with no stops, the start and the candidates */
  const fit = () => {
    const m = map.current;
    if (!m) return;
    const p = latest.current;
    const pts: L.LatLngTuple[] = [];
    if (p.start && isValidLatLon(p.start.lat, p.start.lon)) pts.push([p.start.lat, p.start.lon]);
    const stopPts = p.stops.filter((s) => isValidLatLon(s.lat, s.lon)).map((s) => [s.lat, s.lon] as L.LatLngTuple);
    if (stopPts.length) {
      pts.push(...stopPts);
      for (const line of geometryLatLngs(p.geometry)) pts.push(...line);
    } else {
      pts.push(...p.candidates.filter((c) => isValidLatLon(c.lat, c.lon)).map((c) => [c.lat, c.lon] as L.LatLngTuple));
    }
    if (!pts.length) return;
    m.invalidateSize();
    if (pts.length === 1) {
      m.setView(pts[0], 13);
      return;
    }
    // a narrower pad on a phone, so the points are not squeezed into the middle
    const { x, y } = m.getSize();
    const pad = Math.round(Math.max(16, Math.min(48, Math.min(x, y) * 0.08)));
    m.fitBounds(L.latLngBounds(pts), { padding: [pad, pad], maxZoom: 15 });
  };
  useEffect(fit, [fitKey]);

  /* ---------------------------- legend ---------------------------- */
  // the reason colours of the candidates on the map (most urgent first), then stops and the start
  const legendGroups = useMemo(() => {
    const seen = new Set(candidates.filter((c) => !c.inRoute && isValidLatLon(c.lat, c.lon)).map((c) => topReason(c.reasonKinds)));
    return (["fault", "task", "claim", "due", "other"] as const).filter((g) => seen.has(g));
  }, [candidates]);

  const straight = geometrySource === "straight_line" && geometryLatLngs(geometry).length > 0;

  return (
    <div className={cn("relative isolate min-h-[320px] overflow-hidden", className)}>
      <div ref={el} className="plant-map route-map absolute inset-0" aria-label={t("Route map")} />
      {straight && (
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-[400] max-w-[calc(100%-7rem)] -translate-x-1/2 rounded-full border border-white/[0.08] bg-ink-950/85 px-2.5 py-1 text-center text-[11px] font-semibold text-slate-300 backdrop-blur"
          role="status"
        >
          <span className="mr-1.5 inline-block w-4 border-t-2 border-dashed border-slate-400 align-middle" aria-hidden="true" />
          {t("Straight line, not road")}
        </div>
      )}
      <div className="absolute top-3 right-3 z-[400] flex flex-col gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              className="border border-white/10 bg-ink-950/85 backdrop-blur"
              onClick={fit}
              aria-label={stops.length ? t("Fit the route") : t("Fit the plants")}
            >
              <Scan />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{stops.length ? t("Fit the route") : t("Fit the plants")}</TooltipContent>
        </Tooltip>
        {controls}
      </div>
      {(legendGroups.length > 0 || stops.length > 0 || start) && (
        <ul
          className="pointer-events-none absolute bottom-2 left-2 z-[400] hidden max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-white/[0.08] bg-ink-950/85 px-2 py-1 text-[10px] text-slate-300 backdrop-blur sm:flex sm:max-w-[60%]"
          aria-label={t("Map legend")}
        >
          {legendGroups.map((g) => (
            <li key={g} className="flex items-center gap-1">
              <span className="size-2 rounded-full ring-1 ring-black/40" style={{ background: REASON_COLOR[g] }} aria-hidden />
              {t(REASON_GROUP_LABEL[g])}
            </li>
          ))}
          {stops.length > 0 && (
            <li className="flex items-center gap-1">
              <span className="num flex size-3 items-center justify-center rounded-full bg-sky-500 text-[8px] font-bold text-white" aria-hidden>
                1
              </span>
              {t("Stop")}
            </li>
          )}
          {start && (
            <li className="flex items-center gap-1">
              <span className="size-2.5 rounded-sm bg-emerald-400" aria-hidden />
              {t("Start")}
            </li>
          )}
        </ul>
      )}
      {pickingStart && (
        <div
          className="pointer-events-none absolute bottom-10 left-1/2 z-[400] max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full border border-emerald-400/40 bg-ink-950/90 px-3 py-1 text-center text-[11px] font-semibold text-emerald-200 backdrop-blur"
          role="status"
        >
          {t("Click or tap the map to set the start")}
        </div>
      )}
    </div>
  );
};

export default RouteMap;
