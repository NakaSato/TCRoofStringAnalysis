/* Helpers for the Visit Route map (RouteMap.tsx). Several are copies of the private helpers in
   `pages/PlantMapPage.tsx`, kept apart until the Leaflet setup is shared (plan: `plantMap/useLeafletMap.ts`,
   docs/plans/site-visit-route.md §6). Keep them in step with PlantMapPage until then. */

/** Copied from `escapeHtml` in pages/PlantMapPage.tsx. */
export const escapeHtml = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The coordinate test of `hasLocation` in pages/PlantMapPage.tsx, for a bare lat / lon: finite, in range,
 *  and not 0,0 (Growatt's "not set", not a plant in the Gulf of Guinea). */
export const isValidLatLon = (lat: unknown, lon: unknown): lat is number =>
  typeof lat === "number" &&
  typeof lon === "number" &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  !(lat === 0 && lon === 0) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

/* Basemap: the Plant Map's default "dark" basemap (BASEMAPS.dark in pages/PlantMapPage.tsx). With a Mapbox
   token (`VITE_MAPBOX_TOKEN`, public `pk.` token) Mapbox dark-v11 raster tiles; without one Esri Dark Gray
   Canvas + its reference labels. Attribution is required. */
const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN || "";
export interface RouteBasemap {
  url: string;
  attribution: string;
  /** a second layer of place names over the base; null when the base has its own */
  labels: string | null;
  /** deepest zoom with real tiles; stretched beyond */
  maxNativeZoom: number;
  /** Mapbox serves 512 px tiles */
  big: boolean;
}
export const ROUTE_BASEMAP: RouteBasemap = MAPBOX_TOKEN
  ? {
      url: `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      attribution: "© Mapbox © OpenStreetMap",
      labels: null,
      maxNativeZoom: 19,
      big: true,
    }
  : {
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      attribution: "© Esri, HERE, Garmin, © OpenStreetMap contributors",
      labels: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      maxNativeZoom: 16,
      big: false,
    };

/** Attribution text → HTML: escaped, with Geoapify (required by its free plan) and OpenStreetMap linked. */
export const attributionHtml = (text: string): string => {
  const safe = escapeHtml(text);
  const link = (href: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
  if (/geoapify/i.test(text)) return link("https://www.geoapify.com/");
  if (/openstreetmap/i.test(text)) return link("https://www.openstreetmap.org/copyright");
  return safe;
};

/* Candidate reasons, most urgent first: alarm / issue > task > claim > due. */
export type ReasonGroup = "fault" | "task" | "claim" | "due" | "other";
const GROUP_OF: Record<string, ReasonGroup> = {
  alarm: "fault",
  issue: "fault",
  task: "task",
  claim: "claim",
  cleaning_due: "due",
  pm_due: "due",
};
const GROUP_RANK: Record<ReasonGroup, number> = { fault: 0, task: 1, claim: 2, due: 3, other: 4 };
export const REASON_COLOR: Record<ReasonGroup, string> = {
  fault: "#f87171",
  task: "#38bdf8",
  claim: "#a78bfa",
  due: "#2dd4bf",
  other: "#94a3b8",
};
/** English labels (i18n keys) of the reason groups, for the map legend. */
export const REASON_GROUP_LABEL: Record<ReasonGroup, string> = {
  fault: "Alarm / issue",
  task: "Task",
  claim: "Claim",
  due: "Cleaning / PM due",
  other: "Other",
};
/** English labels (i18n keys) of the known reason kinds; an unknown kind is shown as sent. */
export const REASON_LABEL: Record<string, string> = {
  alarm: "Alarm",
  issue: "Issue",
  task: "Task",
  claim: "Claim",
  cleaning_due: "Cleaning due",
  pm_due: "PM due",
};
export const reasonGroup = (kind: string): ReasonGroup => GROUP_OF[kind] ?? "other";

/** The most urgent group among the kinds ("other" when there are none). */
export const topReason = (kinds: readonly string[]): ReasonGroup =>
  kinds.reduce<ReasonGroup>((best, k) => {
    const g = reasonGroup(k);
    return GROUP_RANK[g] < GROUP_RANK[best] ? g : best;
  }, "other");

/** Reason kinds sorted most urgent first, without duplicates. */
export const sortReasons = (kinds: readonly string[]): string[] =>
  [...new Set(kinds)].sort((a, b) => GROUP_RANK[reasonGroup(a)] - GROUP_RANK[reasonGroup(b)]);
