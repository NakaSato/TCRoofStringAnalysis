/** API types: Site visit route (`/growatt/routes/*`, docs/plans/site-visit-route.md). Mirrors the
 * "site visit route" section of `backend/app/schemas/api_schemas.py`. Nothing is stored: drive
 * times are Geoapify road estimates (OpenStreetMap) or straight-line estimates, both modelled. */

// ---- GET /growatt/routes/candidates?day=&team_id=&user_id=

export type RouteReasonKind = "task" | "issue" | "alarm" | "claim" | "cleaning_due" | "pm_due";

export interface RouteReason {
  kind: RouteReasonKind;
  /** backend text (English), e.g. the task title or the issue's rule */
  label: string;
  detail: string | null;
  /** issue tier "P1" / "P2" … (null when the reason has none) */
  priority: string | null;
  /** estimated baht lost per day (issues); null = none estimated */
  thb_per_day: number | null;
  task_id: number | null;
  issue_id: number | null;
  claim_id: number | null;
  task_type: string | null;
  /** when the reason started (day or ISO time), null = unknown */
  since: string | null;
}

export type RouteServiceBasis = "task_type" | "cleaning_crew_days" | "default";

export interface RouteCandidate {
  plant_id: number;
  name: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
  /** false = Growatt has no usable coordinates: the plant can't be routed */
  has_location: boolean;
  reasons: RouteReason[];
  /** suggested time on site in minutes */
  default_service_min: number;
  service_basis: RouteServiceBasis;
  /** order of urgency, 1 = first */
  rank: number;
}

export interface RouteCandidates {
  day: string;
  team_id: number | null;
  user_id: number | null;
  candidates: RouteCandidate[];
  counts: Partial<Record<RouteReasonKind, number>>;
  labels: Record<string, string>;
}

export interface RouteCandidateQuery {
  day?: string | null;
  team_id?: number | null;
  user_id?: number | null;
}

// ---- /growatt/routes/offices: saved offices a route can start from (SQL `route_offices`, static
// config, not plant-scoped). Everyone lists them; only admins create / edit / delete (403 otherwise).
// 404 unknown id, 409 duplicate name (case-insensitive), 422 bad location (out of range, 0,0), empty
// name, name > 80, address > 200, or unsetting the default.

export interface RouteOffice {
  id: number;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  /** at most one; the first office is it, deleting it promotes the oldest remaining */
  is_default: boolean;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** default first, then by name */
export interface RouteOfficeList {
  offices: RouteOffice[];
}

export interface RouteOfficeIn {
  name: string;
  address?: string | null;
  lat: number;
  lon: number;
  /** true moves the default here */
  is_default?: boolean;
}

/** Partial edit; `address` null or "" clears it; `is_default: false` on the default = 422. */
export type RouteOfficePatch = Partial<RouteOfficeIn>;

export interface RouteOfficeDeleted {
  id: number;
  deleted: boolean;
  /** the default after the delete (null = no office left) */
  default_office_id: number | null;
}

// ---- POST /growatt/routes/solve (RouteSolveRequest)

/** Start (and, for a round trip, end) at a plant the user may see. */
export interface RouteStartPlant {
  kind: "plant";
  plant_id: number;
}

/** Start at a coordinate (the phone's location, a point on the map). 0,0 is refused. */
export interface RouteStartPoint {
  kind: "point";
  lat: number;
  lon: number;
  label?: string | null;
}

/** Start (and, for a round trip, end) at a saved office (`/growatt/routes/offices`); unknown id = 404. */
export interface RouteStartOffice {
  kind: "office";
  office_id: number;
}

export type RouteStart = RouteStartPlant | RouteStartPoint | RouteStartOffice;

/** Allowed arrival at the stop, plant-local "HH:MM"; close ≥ open. */
export interface RouteWindow {
  open: string;
  close: string;
}

export interface RouteStopIn {
  plant_id: number;
  /** time on site, 0–720 min (default 45) */
  service_min?: number;
  window?: RouteWindow | null;
}

export type RouteEndMode = "return" | "last";

export interface RouteSolveRequest {
  start: RouteStart;
  end_mode?: RouteEndMode;
  /** default today (Bangkok); used for sunset */
  day?: string | null;
  /** "HH:MM", default "08:00" */
  leave_at?: string;
  /** "HH:MM", default "18:00" */
  latest_finish?: string;
  keep_order?: boolean;
  /** 1–25 unique plants (more: 422 "split the day") */
  stops: RouteStopIn[];
}

// ---- RouteSolveResponse

export type RouteLegSource = "geoapify" | "straight_line";
export type RouteFallbackReason = "no_key" | "error" | "cooldown" | "budget";

/** One stop in visit order. Times are plant-local; `*_min` = minutes after midnight, and a clock
 * past midnight reads "HH:MM+1". Leg values are of the drive *to* this stop. */
export interface RouteStopOut {
  seq: number;
  plant_id: number;
  name: string;
  lat: number;
  lon: number;
  service_min: number;
  window: RouteWindow | null;
  eta: string;
  eta_min: number;
  /** waiting for the window to open */
  wait_min: number;
  etd: string;
  etd_min: number;
  /** arrival after the window closed (0 = on time or no window) */
  late_min: number;
  /** NOAA sunset at the plant (modelled), null if none that day */
  sunset: string | null;
  /** the work on site ends after sunset (null = no sunset known) */
  after_sunset: boolean | null;
  /** the work on site ends after `latest_finish` */
  after_latest: boolean;
  leg_km: number | null;
  leg_min: number | null;
  leg_source: RouteLegSource;
}

export interface RouteReturnLeg {
  leg_km: number | null;
  leg_min: number | null;
  eta: string | null;
  eta_min: number | null;
  after_latest: boolean;
  leg_source: RouteLegSource;
}

export interface RouteTotals {
  stops: number;
  drive_km: number | null;
  drive_min: number | null;
  wait_min: number | null;
  service_min: number | null;
  late_min: number | null;
  leave_at: string;
  finish: string | null;
  finish_min: number | null;
  after_latest: boolean;
}

export interface RouteStartOut {
  kind: "plant" | "point" | "office";
  plant_id: number | null;
  /** null unless kind = "office" */
  office_id: number | null;
  /** the plant's or office's name (backend text), or the point's label */
  name: string;
  lat: number;
  lon: number;
}

/** How straight-line pairs were estimated (modelled). */
export interface RouteEstimate {
  road_factor: number;
  speed_kmh: number;
  basis: string;
}

/** GeoJSON MultiLineString, one line ([lon, lat] points) per leg in visit order (return leg last). */
export interface RouteGeometry {
  type: "MultiLineString";
  coordinates: number[][][];
}

export type RouteMethod = "exact" | "heuristic" | "fixed" | "trivial";

export interface RouteSolveResponse {
  day: string;
  end_mode: RouteEndMode;
  keep_order: boolean;
  start: RouteStartOut;
  stops: RouteStopOut[];
  /** null when end_mode = "last" */
  return_leg: RouteReturnLeg | null;
  totals: RouteTotals;
  latest_finish: string;
  method: RouteMethod;
  /** the matrix the order was solved on */
  source: RouteLegSource;
  fallback_reason: RouteFallbackReason | null;
  fallback_detail: string | null;
  /** matrix pairs that are straight-line estimates */
  straight_line_pairs: number;
  /** set when any leg or pair is a straight-line estimate */
  estimate: RouteEstimate | null;
  geometry: RouteGeometry;
  geometry_source: RouteLegSource;
  geometry_fallback_reason: RouteFallbackReason | null;
  /** Geoapify credits this request spent (0 = cached / not asked) */
  credits_used: number;
  credits_today: number;
  credits_daily_cap: number;
  /** to show near the map whenever Geoapify data is used */
  attribution: string[];
  /** each ≤ 3 waypoints; each starts where the previous ended */
  google_maps_links: string[];
  labels: Record<string, string>;
}

/** 422 detail when a stop (or the start plant) has no usable location */
export interface RouteNoLocationDetail {
  message: string;
  plants: Array<{ plant_id: number; name?: string | null }>;
}
