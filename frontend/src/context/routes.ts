/**
 * URL scheme and the data each route needs.
 *
 * The plant lives in the URL (`/plant/:plantId/<page>`), so a reload or a shared link opens the
 * same plant and page. `routeData()` is the single place that decides which data providers fetch
 * or poll for a route; leaving a route stops its fetching.
 */

/** Pages of one plant: "" is the plant overview. */
export const PLANT_PAGES = ["", "generation", "inverters", "sensors", "strings", "string", "string-layout", "maintenance", "documents", "billing"] as const;
export type PlantPage = (typeof PLANT_PAGES)[number];

/** Plant pages that poll `/live/plants/{id}/latest`: all of them, because the plant banner's string
 * status is judged on the live record. The backend caches each inverter for >= 270 s, so a page
 * switch adds no Growatt calls. */
const LIVE_PLANT_PAGES: ReadonlySet<PlantPage> = new Set<PlantPage>(PLANT_PAGES);

export const plantPath = (plantId: number, page: PlantPage = ""): string =>
  page ? `/plant/${plantId}/${page}` : `/plant/${plantId}`;

const PLANT_RE = /^\/plant\/([^/]+)(?:\/([^/]+))?\/?$/;

/** `{ plantId, page }` of a plant URL; plantId is NaN when the id is not a number. Null otherwise. */
export const parsePlantPath = (pathname: string): { plantId: number; page: PlantPage | null } | null => {
  const m = PLANT_RE.exec(pathname);
  if (!m) return null;
  const id = /^\d+$/.test(m[1]) ? Number(m[1]) : NaN;
  const page = (m[2] ?? "") as PlantPage;
  return { plantId: id, page: (PLANT_PAGES as readonly string[]).includes(page) ? page : null };
};

export interface RouteData {
  /** `/growatt/plants`: DB list of every plant the user may see */
  fleetList: boolean;
  /** `/growatt/live/plants` poll: live plant status / power (backend memory cache, shared) */
  fleetLive: boolean;
  /** plant whose DB overview is loaded (`/growatt/plants/{id}/overview`) */
  plantId: number | null;
  /** `/growatt/live/plants/{id}/latest` poll (Growatt-rate-limited per inverter) */
  plantLive: boolean;
  /** legacy analysis tables (`/plants`, datasets, latest analysis); admin only */
  legacy: boolean;
}

export const routeData = (pathname: string, admin: boolean): RouteData => {
  const plant = parsePlantPath(pathname);
  if (plant) {
    const ok = Number.isFinite(plant.plantId) && plant.page != null;
    return {
      // sidebar fleet card; the banner's plant status is the fleet poll's per-plant status too
      fleetList: true,
      fleetLive: true,
      plantId: ok ? plant.plantId : null,
      plantLive: ok && LIVE_PLANT_PAGES.has(plant.page!),
      legacy: admin && plant.page === "maintenance",
    };
  }
  return {
    // the sidebar's fleet card shows the fleet on every page (list once per session; the live poll
    // reads the backend's shared memory cache, so it adds no Growatt calls)
    fleetList: true,
    fleetLive: true,
    plantId: null,
    plantLive: false,
    legacy: false,
  };
};

/* Last plant opened: lets the sidebar and old URLs (`/inverters`, …) land on a plant. Per-browser
 * convenience only; storage may be unavailable, so every access is guarded. */
const LAST_PLANT_KEY = "tcroof.lastPlantId";

export const getLastPlantId = (): number | null => {
  try {
    const v = Number(localStorage.getItem(LAST_PLANT_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

export const setLastPlantId = (id: number | null): void => {
  try {
    if (id == null) localStorage.removeItem(LAST_PLANT_KEY);
    else localStorage.setItem(LAST_PLANT_KEY, String(id));
  } catch {
    // storage blocked: the sidebar just falls back to the directory
  }
};
