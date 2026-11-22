/**
 * Typed REST API client for the TC Roof Solar PV String & O&M Engineering Backend.
 */

export const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const TOKEN_KEY = "tc_solar_jwt_token";
const USER_KEY = "tc_solar_user";

// Response / request shapes live in ./types by area; re-exported so imports from client keep working.
export type * from "./types/auth";
export type * from "./types/legacy";
export type * from "./types/growatt";
export type * from "./types/weather";
export type * from "./types/sensors";
export type * from "./types/siteRegister";
export type * from "./types/systemLogs";
export type * from "./types/assistant";
export type * from "./types/push";
export type * from "./types/issues";
export type * from "./types/events";
export type * from "./types/tools";
export type * from "./types/claims";
export type * from "./types/calendar";
export type * from "./types/pwaMeter";
export type * from "./types/center";
export type * from "./types/tfrs16";
export type * from "./types/pvsyst";
export type * from "./types/kb";
export type * from "./types/kbDocs";
export type * from "./types/visitRoute";
import type { UserCreate, UserProfile, UserUpdate } from "./types/auth";
import type { AnalysisRun, CMWorkOrder, DatasetInfo, PMTask, Plant, RCARecord, StringSpec } from "./types/legacy";
import type { FleetAlarmDay, FleetModule, FleetModuleOut, GrowattInverter, GrowattInverterDaily, GrowattInverterSnapshot, GrowattInverterTimeseries, GrowattLive, GrowattLiveAlarms, GrowattLiveMeter, GrowattLivePlant, GrowattLivePlantLatest, GrowattLivePlantsToday, LiveStringOperating, GrowattPlant, GrowattPlantOverview, GrowattPlantPower, PlantKpiDaily, GrowattStringDetail, GrowattStringLayout, GrowattStringLayoutEntry, IvSiteCoefficients, PlantDocument, PlantDocumentKind, PlantDocumentRow, IvSweep, IvSweepCreate, IvSweepList, PublishResult } from "./types/growatt";
import type { GoogleWeatherDay, GoogleWeatherNow, GrowattLiveWeather, GrowattWeatherDay, FleetRadarRain, PlantRadarRain, RainRadar } from "./types/weather";
import type { SensorList, SensorLive, SensorLiveStatus, SensorToday } from "./types/sensors";
import type { SystemLogPage, SystemLogQuery, SystemLogSummary } from "./types/systemLogs";
import type { AssistantStatus, AssistantUsage } from "./types/assistant";
import type { PushStatus } from "./types/push";
import type { SiteEvent, SiteEventBody, SiteEventList, SiteEventQuery } from "./types/events";
import type { Checkout, CheckoutBody, DueBody, Instrument, InstrumentBody, InstrumentDetail, InstrumentList, ReturnBody } from "./types/tools";
import type {
  OmAssignees,
  OmDue,
  OmFeedLink,
  OmFeedStatus,
  OmPlanBody,
  OmPlanList,
  OmPlanSaved,
  OmPlantSettings,
  OmRoundPreview,
  OmRoundPreviewBody,
  OmRoundSaveBody,
  OmTask,
  OmTaskBody,
  OmTaskDetail,
  OmTaskDoneBody,
  OmTaskList,
  OmTaskPatch,
  OmTaskQuery,
  OmTeam,
  OmTeamBody,
} from "./types/calendar";
import type { Claim, ClaimBody, ClaimDetail, ClaimEvent, ClaimEventBody, ClaimEvidence, ClaimEvidenceBody, ClaimLink, ClaimLinkBody, ClaimList, ClaimStatusBody } from "./types/claims";
import type { OmCenter } from "./types/center";
import type { Tfrs16Rollout, Tfrs16Schedule, Tfrs16Summary } from "./types/tfrs16";
import type { PvsystDesign, PvsystVsMeter } from "./types/pvsyst";
import type {
  RouteCandidateQuery,
  RouteCandidates,
  RouteOffice,
  RouteOfficeDeleted,
  RouteOfficeIn,
  RouteOfficeList,
  RouteOfficePatch,
  RouteSolveRequest,
  RouteSolveResponse,
} from "./types/visitRoute";
import type { KbArticle, KbArticleBody, KbArticleList, KbArticlePatch, KbArticleQuery, KbDeleteResult, KbRevision, KbRevisionList } from "./types/kb";
import type { KbDocCatalog, KbDocContext, KbDocCreateMeta, KbDocDetail, KbDocFileLink, KbDocHome, KbDocLinkInput, KbDocList, KbDocPatch, KbDocQuery, KbPlantDocuments, KbSearchResult } from "./types/kbDocs";
import type { PlantSiteRegister, SiteRegisterImport, SiteRegisterRow } from "./types/siteRegister";
import type { PwaBilling, PwaImportResult, PwaMeterCoverage, PwaMeterCheck, PwaMeterCriteria, PwaMeterDaily, PwaPlantBaseline, PwaPlantDays, PwaMeterSite, PwaMeterSiteDays, PwaMeterSummary, PwaMeterWindow, PwaOutageEvent, PwaVsGrowatt } from "./types/pwaMeter";
import type { InverterRuleDay, Issue, IssueActionBody, IssueList, IssueQuery, PwaRatesResult, RuleDaily, StringRuleDay, Tariff, TariffOut, TariffRates } from "./types/issues";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): UserProfile | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Fired when the API rejects the stored token (401); AppContext listens and signs out. */
export const AUTH_EXPIRED_EVENT = "tcroof:auth-expired";

export function setAuthSession(token: string, user: UserProfile): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** A non-2xx API answer; `status` lets callers tell "not found / not assigned" (404) from outages. */
export class ApiError extends Error {
  /** `detail` of the error body as the API sent it (e.g. a 409's `{message, current}`); undefined when none */
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

/** Dev only: every request, so each route's data loading can be checked (`window.__apiLog`). */
const logRequest = (method: string, path: string) => {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __apiLog?: Array<{ at: string; route: string; method: string; path: string }> };
  (w.__apiLog ??= []).push({ at: new Date().toISOString(), route: window.location.pathname, method, path });
  console.debug(`[api] ${method} ${path}  (on ${window.location.pathname})`);
};

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  logRequest(options.method ?? "GET", path);
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401 && path !== "/auth/login") {
    // token missing/expired: drop the session and let AppContext show the login page
    clearAuthSession();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }

  if (!res.ok) {
    let errDetail = `${res.status} ${res.statusText}`;
    let detail: unknown;
    try {
      const body = await res.json();
      detail = body.detail;
      if (body.detail) errDetail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // ignore
    }
    throw new ApiError(errDetail, res.status, detail);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  // Without a backend, hosting answers /api/* with index.html; res.json() would then fail with a
  // cryptic browser message (Safari: "The string did not match the expected pattern.").
  if (!(res.headers.get("Content-Type") || "").includes("json")) {
    throw new Error("The API server is not reachable. Please try again later or contact your administrator.");
  }
  return res.json();
}

/** GET a file with the session token (plain <a href> / window.open cannot send it). */
export async function fetchFileBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    clearAuthSession();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return { blob: await res.blob(), filename: m ? decodeURIComponent(m[1]) : null };
}

/** Download an authenticated API file to the user's disk. */
export async function downloadApiFile(path: string, fallbackName: string): Promise<void> {
  const { blob, filename } = await fetchFileBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


/** `?start=&end=` for the PWA meter routes (empty = the whole report) */
const pwaWindow = (w: PwaMeterWindow): string => {
  const q = new URLSearchParams();
  if (w.start) q.set("start", w.start);
  if (w.end) q.set("end", w.end);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
};

export const api = {
  // Auth
  login: async (username: string, password: string) => {
    const data = await apiFetch<{ access_token: string; user: UserProfile }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), password }),
    });
    setAuthSession(data.access_token, data.user);
    return data;
  },
  me: () => apiFetch<UserProfile>("/auth/me"),

  // Users & plant assignments (admin only)
  listUsers: () => apiFetch<UserProfile[]>("/users"),
  createUser: (payload: UserCreate) =>
    apiFetch<UserProfile>("/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (userId: number, payload: UserUpdate) =>
    apiFetch<UserProfile>(`/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  setUserPlants: (userId: number, plantIds: number[]) =>
    apiFetch<UserProfile>(`/users/${userId}/plants`, { method: "PUT", body: JSON.stringify({ plant_ids: plantIds }) }),

  // Growatt — persisted (DB) data
  listGrowattPlants: () => apiFetch<GrowattPlant[]>("/growatt/plants"),
  listGrowattInverters: (plantId: number) => apiFetch<GrowattInverter[]>(`/growatt/plants/${plantId}/inverters`),
  getGrowattPlantOverview: (plantId: number, day?: string) =>
    apiFetch<GrowattPlantOverview>(`/growatt/plants/${plantId}/overview${day ? `?day=${day}` : ""}`),
  /** the plant's O&M site register: station data, on-site devices and checks (DB only) */
  getPlantSiteRegister: (plantId: number) => apiFetch<PlantSiteRegister>(`/growatt/plants/${plantId}/site-register`),
  /** every station of the site register the user may see, with device counts and checks */
  listSiteRegister: () => apiFetch<{ sites: SiteRegisterRow[]; kinds: string[] }>("/growatt/site-register"),
  /** the register as .xlsx in the O&M workbook's layout (engineers: their plants' stations); imports again */
  exportSiteRegister: () => downloadApiFile("/growatt/site-register/export", "OM-Asset-Network-export.xlsx"),
  /** admin: the register workbook (.xlsx) or its JSON → preview (apply false) or replace the register (all or nothing) */
  importSiteRegister: (file: File, apply: boolean) => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch<SiteRegisterImport>(`/growatt/site-register/import?apply=${apply ? "true" : "false"}`, { method: "POST", body: form });
  },
  /** {plant_id: province} from the site register (plant directory filter) */
  getSiteRegisterProvinces: () => apiFetch<{ provinces: Record<string, string> }>("/growatt/site-register/provinces"),
  /** every visible plant's as-built / site photo links (Settings → Plant documents) */
  listPlantDocuments: () => apiFetch<{ plants: PlantDocumentRow[]; kinds: PlantDocumentKind[] }>("/growatt/documents"),
  /** admin: set a link by hand (source manual; a Drive re-import keeps it) */
  putPlantDocument: (plantId: number, kind: PlantDocumentKind, body: { url: string; title?: string | null }) =>
    apiFetch<PlantDocument>(`/growatt/plants/${plantId}/documents/${kind}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePlantDocument: (plantId: number, kind: PlantDocumentKind) =>
    apiFetch<{ removed: boolean }>(`/growatt/plants/${plantId}/documents/${kind}`, { method: "DELETE" }),
  /** `records: "false"`: only Growatt's own figures (curve, daily kWh), no stored records read */
  getGrowattPlantPower: (plantId: number, q: { day: string; end_day?: string | null; start?: string; end?: string; records?: "false" }) =>
    apiFetch<GrowattPlantPower>(
      `/growatt/plants/${plantId}/power?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`
    ),
  getGrowattInverterTimeseries: (plantId: number, deviceSn: string, day?: string) =>
    apiFetch<GrowattInverterTimeseries>(
      `/growatt/plants/${plantId}/inverters/${encodeURIComponent(deviceSn)}/timeseries${day ? `?day=${day}` : ""}`
    ),
  /** Every Growatt field of one inverter's stored records for a day (as reported; kept HISTORY_RAW_RETENTION_DAYS, 7). */
  getGrowattInverterRaw: (plantId: number, deviceSn: string, day?: string) =>
    apiFetch<{
      meta: { plant_id: number; device_sn: string; day: string | null; source: string; records: number };
      fields: string[];
      records: Array<Record<string, unknown>>;
    }>(`/growatt/plants/${plantId}/inverters/${encodeURIComponent(deviceSn)}/raw${day ? `?day=${day}` : ""}`),
  /** Stored plant-day KPIs (PR, PR', Yf, EPI…) of the `days` days up to `day` (default today); days 1–365. */
  getPlantKpiDaily: (plantId: number, days: number, day?: string | null) =>
    apiFetch<PlantKpiDaily>(`/growatt/plants/${plantId}/kpi-daily?days=${days}${day ? `&day=${day}` : ""}`),
  getGrowattInverterDaily: (plantId: number, deviceSn: string, days = 30, day?: string) =>
    apiFetch<GrowattInverterDaily>(
      `/growatt/plants/${plantId}/inverters/${encodeURIComponent(deviceSn)}/daily?days=${days}${day ? `&day=${day}` : ""}`
    ),
  getGrowattStringDetail: (
    plantId: number,
    deviceSn: string,
    stringNo: number,
    /** `day` (default: newest stored), `endDay` = last day of a range (≤ 31 days), `start`/`end` =
     * plant-local time-of-day window "HH:MM", both inclusive */
    opts: { day?: string; endDay?: string; start?: string; end?: string } = {}
  ) => {
    const q = new URLSearchParams();
    if (opts.day) q.set("day", opts.day);
    if (opts.day && opts.endDay && opts.endDay !== opts.day) q.set("end_day", opts.endDay);
    if (opts.start) q.set("start", opts.start);
    if (opts.end) q.set("end", opts.end);
    const qs = q.toString();
    return apiFetch<GrowattStringDetail>(`/growatt/plants/${plantId}/strings/${encodeURIComponent(deviceSn)}/${stringNo}${qs ? `?${qs}` : ""}`);
  },

  getFleetModule: () => apiFetch<FleetModuleOut>("/growatt/fleet-module"),
  putFleetModule: (m: FleetModule) =>
    apiFetch<FleetModuleOut>("/growatt/fleet-module", { method: "PUT", body: JSON.stringify(m) }),
  getGrowattStringLayout: (plantId: number) =>
    apiFetch<GrowattStringLayout>(`/growatt/plants/${plantId}/string-layout`),
  /** admin: mark an inverter Growatt lists as not installed on site (`installed: false`), or clear the mark */
  setInverterInstalled: (plantId: number, deviceSn: string, installed: boolean, note?: string | null) =>
    apiFetch<{ inverter: GrowattInverter; issues_closed: number; published?: PublishResult }>(
      `/growatt/plants/${plantId}/inverters/${encodeURIComponent(deviceSn)}/installed`,
      { method: "PUT", body: JSON.stringify({ installed, note: note ?? null }) }
    ),
  putGrowattStringLayout: (plantId: number, entries: GrowattStringLayoutEntry[]) =>
    apiFetch<GrowattStringLayout & { published?: PublishResult }>(`/growatt/plants/${plantId}/string-layout`, {
      method: "PUT",
      body: JSON.stringify(entries),
    }),

  listIvSweeps: (plantId: number, opts: { sn?: string; stringNo?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.sn) q.set("sn", opts.sn);
    if (opts.stringNo != null) q.set("string_no", String(opts.stringNo));
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return apiFetch<IvSweepList>(`/growatt/plants/${plantId}/iv-sweeps${qs ? `?${qs}` : ""}`);
  },
  getIvSiteCoefficients: (plantId: number, sn: string, stringNo: number) =>
    apiFetch<IvSiteCoefficients>(
      `/growatt/plants/${plantId}/iv-sweeps/site-coefficients?sn=${encodeURIComponent(sn)}&string_no=${stringNo}`
    ),
  createIvSweep: (plantId: number, payload: IvSweepCreate) =>
    apiFetch<IvSweep>(`/growatt/plants/${plantId}/iv-sweeps`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchIvSweep: (plantId: number, sweepId: number, payload: { ir_confirmed?: boolean; note?: string | null }) =>
    apiFetch<IvSweep>(`/growatt/plants/${plantId}/iv-sweeps/${sweepId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  getFleetAlarms: (day?: string) => apiFetch<FleetAlarmDay>(`/growatt/alarms${day ? `?day=${day}` : ""}`),
  /** `plantId`: only that plant's sensors (the plant Sensors tab); omitted = every visible plant */
  /** `day` (YYYY-MM-DD): judge coverage and the stored-data flags on that day (default today) */
  listSensors: (plantId?: number, day?: string) => {
    const q = new URLSearchParams();
    if (plantId != null) q.set("plant_id", String(plantId));
    if (day) q.set("day", day);
    const qs = q.toString();
    return apiFetch<SensorList>(`/growatt/sensors${qs ? `?${qs}` : ""}`);
  },
  getLiveSensorStatus: (plantId?: number) =>
    apiFetch<GrowattLive<SensorLiveStatus>>(`/growatt/live/sensors/status${plantId != null ? `?plant_id=${plantId}` : ""}`),
  getLiveSensor: (dataloggerSn: string, address: number) =>
    apiFetch<GrowattLive<SensorLive>>(`/growatt/live/sensors/${encodeURIComponent(dataloggerSn)}/${address}`),
  /** today's 5-min records of one sensor from Growatt (memory only; today only) */
  getLiveSensorToday: (dataloggerSn: string, address: number) =>
    apiFetch<GrowattLive<SensorToday>>(`/growatt/live/sensors/${encodeURIComponent(dataloggerSn)}/${address}/today`),

  // Growatt — realtime (backend memory only; poll, never stored)
  getGrowattLivePlants: () => apiFetch<GrowattLive<GrowattLivePlant[]>>("/growatt/live/plants"),
  /** today's energy per plant (`plant/data`, swept a batch per request; poll on refresh_in_s) */
  getGrowattLivePlantsToday: () => apiFetch<GrowattLive<GrowattLivePlantsToday>>("/growatt/live/plants/today"),
  /** newest record per inverter (`maxs_data`, memory only); poll on `refresh_in_s` until `sweep.checked == sweep.total` */
  getGrowattInverterSnapshot: (plantId?: number) =>
    apiFetch<GrowattLive<GrowattInverterSnapshot>>(
      `/growatt/live/inverters/snapshot${plantId != null ? `?plant_id=${plantId}` : ""}`,
    ),
  getGrowattLiveInverters: (plantId: number) =>
    apiFetch<GrowattLive<GrowattInverter[]>>(`/growatt/live/plants/${plantId}/inverters`),
  getGrowattLivePlantLatest: (plantId: number) =>
    apiFetch<GrowattLive<GrowattLivePlantLatest>>(`/growatt/live/plants/${plantId}/latest`),
  getGrowattLiveAlarms: (plantId: number, day?: string, days = 7) =>
    apiFetch<GrowattLive<GrowattLiveAlarms>>(
      `/growatt/live/plants/${plantId}/alarms?days=${days}${day ? `&day=${day}` : ""}`
    ),
  /** grid import / export now (energy meter) and the derived load; `load: false` skips the inverter records */
  getGrowattLiveMeter: (plantId: number, load = true) =>
    apiFetch<GrowattLive<GrowattLiveMeter>>(`/growatt/live/plants/${plantId}/meter${load ? "" : "?load=false"}`),
  /** each string's live operating point on the modelled curve at the sensor's conditions (memory only) */
  getLiveStringOperating: (plantId: number) =>
    apiFetch<GrowattLive<LiveStringOperating>>(`/growatt/live/plants/${plantId}/strings/operating`),
  getGrowattLiveWeather: (plantId: number) =>
    apiFetch<GrowattLive<GrowattLiveWeather>>(`/growatt/live/plants/${plantId}/weather`),
  getGrowattPlantWeather: (
    plantId: number,
    day?: string,
    window?: { start?: string; end?: string },
    /** one sensor, "DATALOGGER_SN:ADDRESS"; omitted = average of all sensors */
    sensor?: string
  ) => {
    const q = new URLSearchParams();
    if (day) q.set("day", day);
    if (sensor) q.set("sensor", sensor);
    if (window?.start) q.set("start", window.start);
    if (window?.end) q.set("end", window.end);
    const qs = q.toString();
    return apiFetch<GrowattWeatherDay>(`/growatt/plants/${plantId}/weather${qs ? `?${qs}` : ""}`);
  },
  getGoogleWeatherDay: (plantId: number, day?: string) =>
    apiFetch<GoogleWeatherDay>(`/growatt/plants/${plantId}/google-weather${day ? `?day=${day}` : ""}`),
  getGoogleWeatherLive: (plantId: number) =>
    apiFetch<GrowattLive<GoogleWeatherNow>>(`/growatt/live/plants/${plantId}/google-weather`),
  // Longdo rain radar (Plant Map): radar-derived, memory only; 404 = not configured
  getRainRadar: () => apiFetch<GrowattLive<RainRadar>>("/growatt/live/rain-radar"),
  getLiveFleetRain: () => apiFetch<GrowattLive<FleetRadarRain>>("/growatt/live/rain"),
  getLivePlantRain: (plantId: number) => apiFetch<GrowattLive<PlantRadarRain>>(`/growatt/live/plants/${plantId}/rain`),

  // Plants
  listPlants: () => apiFetch<Plant[]>("/plants"),
  getPlant: (plantId: number) => apiFetch<Plant>(`/plants/${plantId}`),
  updatePlant: (plantId: number, payload: Partial<Plant>) =>
    apiFetch<Plant>(`/plants/${plantId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  updatePlantStrings: (plantId: number, specs: StringSpec[]) =>
    apiFetch<StringSpec[]>(`/plants/${plantId}/strings`, {
      method: "PUT",
      body: JSON.stringify(specs),
    }),

  // Datasets & Ingestion
  listDatasets: (plantId: number) => apiFetch<DatasetInfo[]>(`/plants/${plantId}/datasets`),
  getDataset: (datasetId: number) => apiFetch<DatasetInfo>(`/datasets/${datasetId}`),
  uploadDataset: (plantId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch<DatasetInfo>(`/plants/${plantId}/datasets/upload`, {
      method: "POST",
      body: form,
    });
  },
  fetchDatasetFromApi: (plantId: number, payload: Record<string, any>) =>
    apiFetch<DatasetInfo>(`/plants/${plantId}/datasets/fetch`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  simulateDataset: (plantId: number, payload: { days: number; num_strings: number; interval_minutes: number }) =>
    apiFetch<DatasetInfo>(`/plants/${plantId}/datasets/simulate`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // Analysis & Charts
  getLatestAnalysis: (plantId: number) => apiFetch<AnalysisRun>(`/plants/${plantId}/analysis/latest`),
  getAnalysisRun: (runId: number) => apiFetch<AnalysisRun>(`/analysis/${runId}`),
  analyzeDataset: (datasetId: number, payload?: { target_pr_pct?: number; tariff_thb_per_kwh?: number }) =>
    apiFetch<AnalysisRun>(`/datasets/${datasetId}/analyze`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }),
  getChart: (runId: number, chartName: string, params?: Record<string, string | number>) => {
    const qs = params
      ? "?" +
        Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return apiFetch<{ data: any[]; layout: Record<string, any> }>(`/analysis/${runId}/charts/${chartName}${qs}`);
  },

  // Maintenance & RCA
  listPmTasks: (plantId: number) => apiFetch<PMTask[]>(`/pm-tasks?plant_id=${plantId}`),
  createPmTask: (payload: Partial<PMTask>) =>
    apiFetch<PMTask>("/pm-tasks", { method: "POST", body: JSON.stringify(payload) }),
  updatePmTask: (taskId: number, payload: Partial<PMTask>) =>
    apiFetch<PMTask>(`/pm-tasks/${taskId}`, { method: "PUT", body: JSON.stringify(payload) }),
  deletePmTask: (taskId: number) => apiFetch<void>(`/pm-tasks/${taskId}`, { method: "DELETE" }),

  listCmWorkOrders: (plantId: number) => apiFetch<CMWorkOrder[]>(`/cm-work-orders?plant_id=${plantId}`),
  updateCmWorkOrder: (woId: number, payload: Partial<CMWorkOrder>) =>
    apiFetch<CMWorkOrder>(`/cm-work-orders/${woId}`, { method: "PUT", body: JSON.stringify(payload) }),
  regenerateCmWorkOrders: (runId: number) =>
    apiFetch<CMWorkOrder[]>(`/analysis/${runId}/cm-work-orders/generate`, { method: "POST" }),

  listRcaRecords: (plantId: number) => apiFetch<RCARecord[]>(`/rca?plant_id=${plantId}`),
  createRcaRecord: (payload: Partial<RCARecord>) =>
    apiFetch<RCARecord>("/rca", { method: "POST", body: JSON.stringify(payload) }),
  updateRcaRecord: (id: number, payload: Partial<RCARecord>) =>
    apiFetch<RCARecord>(`/rca/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteRcaRecord: (id: number) => apiFetch<void>(`/rca/${id}`, { method: "DELETE" }),

  // System → Logs (admin only)
  listSystemLogs: (params: SystemLogQuery = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)));
      else q.set(k, String(v));
    }
    const qs = q.toString();
    return apiFetch<SystemLogPage>(`/system/logs${qs ? `?${qs}` : ""}`);
  },
  getSystemLogSummary: (since?: string) =>
    apiFetch<SystemLogSummary>(`/system/logs/summary${since ? `?since=${encodeURIComponent(since)}` : ""}`),

  // AI Assistant (the chat itself streams: see api/assistant.ts)
  getAssistantStatus: () => apiFetch<AssistantStatus>("/assistant/status"),
  getAssistantUsage: () => apiFetch<AssistantUsage>("/assistant/usage"),

  // Alarm push notifications (FCM): this user's devices; the worker sends
  getPushStatus: () => apiFetch<PushStatus>("/push/status"),
  registerPushToken: (token: string, label?: string) =>
    apiFetch<{ devices: number }>("/push/tokens", { method: "POST", body: JSON.stringify({ token, label }) }),
  removePushToken: (token: string) =>
    apiFetch<{ devices: number }>("/push/tokens/remove", { method: "POST", body: JSON.stringify({ token }) }),
  sendPushTest: () => apiFetch<{ queued: boolean; devices: number }>("/push/test", { method: "POST" }),

  // ---- decision rules / Issues queue (DB only; kWh and baht are estimates)
  listIssues: (q: IssueQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return apiFetch<IssueList>(`/growatt/issues${qs ? `?${qs}` : ""}`);
  },
  patchIssue: (id: number, body: IssueActionBody) =>
    apiFetch<Issue>(`/growatt/issues/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  // ---- site events (work done on a plant: cleanings, repairs, …; DB only)
  listSiteEvents: (plantId: number, q: SiteEventQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return apiFetch<SiteEventList>(`/growatt/plants/${plantId}/events${qs ? `?${qs}` : ""}`);
  },
  createSiteEvent: (plantId: number, body: SiteEventBody) =>
    apiFetch<SiteEvent>(`/growatt/plants/${plantId}/events`, { method: "POST", body: JSON.stringify(body) }),
  patchSiteEvent: (plantId: number, id: number, body: Partial<SiteEventBody>) =>
    apiFetch<SiteEvent>(`/growatt/plants/${plantId}/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSiteEvent: (plantId: number, id: number) =>
    apiFetch<void>(`/growatt/plants/${plantId}/events/${id}`, { method: "DELETE" }),
  // ---- Calendar Team (planned O&M tasks and crews; DB only)
  listOmTasks: (q: OmTaskQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== "" && v !== false) p.set(k, String(v));
    return apiFetch<OmTaskList>(`/growatt/calendar/tasks?${p.toString()}`);
  },
  getOmTask: (plantId: number, id: number) => apiFetch<OmTaskDetail>(`/growatt/plants/${plantId}/tasks/${id}`),
  createOmTask: (plantId: number, body: OmTaskBody) =>
    apiFetch<OmTask>(`/growatt/plants/${plantId}/tasks`, { method: "POST", body: JSON.stringify(body) }),
  patchOmTask: (plantId: number, id: number, body: OmTaskPatch) =>
    apiFetch<OmTask>(`/growatt/plants/${plantId}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  finishOmTask: (plantId: number, id: number, body: OmTaskDoneBody) =>
    apiFetch<OmTask>(`/growatt/plants/${plantId}/tasks/${id}/done`, { method: "POST", body: JSON.stringify(body) }),
  deleteOmTask: (plantId: number, id: number) => apiFetch<void>(`/growatt/plants/${plantId}/tasks/${id}`, { method: "DELETE" }),
  listOmAssignees: (plantId?: number) =>
    apiFetch<OmAssignees>(`/growatt/calendar/assignees${plantId != null ? `?plant_id=${plantId}` : ""}`),
  listOmTeams: (includeInactive = false) =>
    apiFetch<OmTeam[]>(`/growatt/calendar/teams${includeInactive ? "?include_inactive=true" : ""}`),
  createOmTeam: (body: OmTeamBody) => apiFetch<OmTeam>("/growatt/calendar/teams", { method: "POST", body: JSON.stringify(body) }),
  patchOmTeam: (id: number, body: Partial<OmTeamBody>) =>
    apiFetch<OmTeam>(`/growatt/calendar/teams/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteOmTeam: (id: number) => apiFetch<void>(`/growatt/calendar/teams/${id}`, { method: "DELETE" }),
  getOmFeed: () => apiFetch<OmFeedStatus>("/growatt/calendar/feed"),
  newOmFeedLink: () => apiFetch<OmFeedLink>("/growatt/calendar/feed", { method: "POST" }),
  deleteOmFeed: () => apiFetch<void>("/growatt/calendar/feed", { method: "DELETE" }),
  listOmPlans: () => apiFetch<OmPlanList>("/growatt/calendar/plans"),
  createOmPlan: (body: OmPlanBody) => apiFetch<OmPlanSaved>("/growatt/calendar/plans", { method: "POST", body: JSON.stringify(body) }),
  patchOmPlan: (id: number, body: Partial<OmPlanBody>) =>
    apiFetch<OmPlanSaved>(`/growatt/calendar/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteOmPlan: (id: number) => apiFetch<{ deleted: number; kept: number }>(`/growatt/calendar/plans/${id}`, { method: "DELETE" }),
  getOmDue: (month: string) => apiFetch<OmDue>(`/growatt/calendar/due?month=${month}`),
  putOmPlantSettings: (plantId: number, body: { cleaning_crew_days: number | null; cleaning_cost_thb: number | null }) =>
    apiFetch<OmPlantSettings & { plant_id: number }>(`/growatt/plants/${plantId}/om-settings`, { method: "PUT", body: JSON.stringify(body) }),
  previewOmRound: (body: OmRoundPreviewBody) =>
    apiFetch<OmRoundPreview>("/growatt/calendar/rounds/preview", { method: "POST", body: JSON.stringify(body) }),
  saveOmRound: (body: OmRoundSaveBody) =>
    apiFetch<{ created: number; task_ids: number[]; dropped_assignees: Record<string, number[]> }>("/growatt/calendar/rounds", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getTariff: () => apiFetch<TariffOut>("/growatt/tariff"),
  putTariff: (t: Tariff) => apiFetch<TariffOut>("/growatt/tariff", { method: "PUT", body: JSON.stringify(t) }),
  applyPwaRates: () => apiFetch<PwaRatesResult>("/growatt/tariff/pwa-rates", { method: "POST" }),
  getTariffRates: (day?: string) => apiFetch<TariffRates>(`/growatt/tariff/rates${day ? `?day=${day}` : ""}`),
  getInverterRuleDaily: (plantId: number, sn: string, days = 30, day?: string) =>
    apiFetch<RuleDaily<InverterRuleDay>>(
      `/growatt/plants/${plantId}/rules/daily?sn=${encodeURIComponent(sn)}&days=${days}${day ? `&day=${day}` : ""}`
    ),
  getStringRuleDaily: (plantId: number, sn: string, stringNo: number, days = 30, day?: string) =>
    apiFetch<RuleDaily<StringRuleDay>>(
      `/growatt/plants/${plantId}/rules/daily?sn=${encodeURIComponent(sn)}&string_no=${stringNo}&days=${days}${day ? `&day=${day}` : ""}`
    ),

  // ---- measuring tools (instruments, check-outs, calibration / document due dates; DB only)
  listInstruments: (includeRetired = false) =>
    apiFetch<InstrumentList>(`/tools${includeRetired ? "?include_retired=true" : ""}`),
  getInstrument: (id: number) => apiFetch<InstrumentDetail>(`/tools/${id}`),
  createInstrument: (body: InstrumentBody) =>
    apiFetch<Instrument>("/tools", { method: "POST", body: JSON.stringify(body) }),
  patchInstrument: (id: number, body: Partial<InstrumentBody>) =>
    apiFetch<Instrument>(`/tools/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteInstrument: (id: number) => apiFetch<void>(`/tools/${id}`, { method: "DELETE" }),
  checkoutInstrument: (id: number, body: CheckoutBody) =>
    apiFetch<Checkout>(`/tools/${id}/checkout`, { method: "POST", body: JSON.stringify(body) }),
  returnInstrument: (id: number, body: ReturnBody) =>
    apiFetch<Checkout>(`/tools/${id}/return`, { method: "POST", body: JSON.stringify(body) }),
  recordInstrumentDue: (id: number, body: DueBody) =>
    apiFetch<Instrument>(`/tools/${id}/due`, { method: "POST", body: JSON.stringify(body) }),
  // ---- Engineering O&M (loss by cause, issues to fix first, one row per plant; DB only, estimates labelled)
  getOmCenter: (q: { start?: string | null; end?: string | null; includeShadow?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.start) p.set("start", q.start);
    if (q.end) p.set("end", q.end);
    if (q.includeShadow) p.set("include_shadow", "true");
    const qs = p.toString();
    return apiFetch<OmCenter>(`/growatt/center${qs ? `?${qs}` : ""}`);
  },
  // ---- PWA daily meter report (Cewe meter kWh per site and day, phases 1–2; DB only, read-only)
  getPwaMeterCriteria: () => apiFetch<PwaMeterCriteria>("/pwa/meter/criteria"),
  getPwaMeterCoverage: () => apiFetch<PwaMeterCoverage>("/pwa/meter/coverage"),
  getPwaMeterSites: () => apiFetch<PwaMeterSite[]>("/pwa/meter/sites"),
  getPwaMeterSiteDays: (siteId: string, w: PwaMeterWindow = {}) =>
    apiFetch<PwaMeterSiteDays>(`/pwa/meter/sites/${encodeURIComponent(siteId)}/days${pwaWindow(w)}`),
  getPwaMeterSummary: (w: PwaMeterWindow = {}) => apiFetch<PwaMeterSummary>(`/pwa/meter/summary${pwaWindow(w)}`),
  getPwaMeterDaily: (w: PwaMeterWindow = {}) => apiFetch<PwaMeterDaily>(`/pwa/meter/daily${pwaWindow(w)}`),
  getPwaMeterBilling: (w: PwaMeterWindow = {}) => apiFetch<PwaBilling>(`/pwa/meter/billing${pwaWindow(w)}`),
  getPwaMeterOutages: (w: PwaMeterWindow = {}) => apiFetch<PwaOutageEvent[]>(`/pwa/meter/outages${pwaWindow(w)}`),
  /** the plant's report days with Growatt's day energy beside the meter; 404 = the plant is not in the report */
  getPwaMeterPlant: (plantId: number, w: PwaMeterWindow = {}) => apiFetch<PwaPlantDays>(`/pwa/meter/plants/${plantId}${pwaWindow(w)}`),
  getPwaMeterPlantBaseline: (plantId: number, start: string, end: string) =>
    apiFetch<PwaPlantBaseline>(`/pwa/meter/plants/${plantId}/baseline${pwaWindow({ start, end })}`),
  /** admin: daily report workbooks → preview (commit false) or store (commit true); `days` = {"file::sheet": "YYYY-MM-DD" | "skip"} */
  importPwaReport: (files: File[], commit: boolean, days: Record<string, string>) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("commit", commit ? "true" : "false");
    form.append("days", JSON.stringify(days));
    return apiFetch<PwaImportResult>("/pwa/meter/import", { method: "POST", body: form });
  },
  getPwaMeterCheck: (w: PwaMeterWindow = {}) => apiFetch<PwaMeterCheck[]>(`/pwa/meter/meter-check${pwaWindow(w)}`),
  /** every report site's Cewe meter days against Growatt's own day energy (both measured) */
  getPwaMeterVsGrowatt: (w: PwaMeterWindow = {}) => apiFetch<PwaVsGrowatt>(`/pwa/meter/vs-growatt${pwaWindow(w)}`),
  // ---- PVsyst design data (modelled; stations scoped like the meter sites; import is the CLI)
  getPvsystDesign: () => apiFetch<PvsystDesign>("/pvsyst/design"),
  getPvsystVsMeter: (w: PwaMeterWindow = {}) => apiFetch<PvsystVsMeter>(`/pvsyst/vs-meter${pwaWindow(w)}`),
  // ---- TFRS 16 lease model (admin only; the model's accounting, never measured; import is the CLI)
  getTfrs16Summary: () => apiFetch<Tfrs16Summary>("/tfrs16/summary"),
  getTfrs16Schedule: () => apiFetch<Tfrs16Schedule>("/tfrs16/schedule"),
  getTfrs16Rollout: () => apiFetch<Tfrs16Rollout>("/tfrs16/rollout"),
  // ---- claims (warranty / insurance claims for plant equipment; DB only)
  listClaims: () => apiFetch<ClaimList>("/claims"),
  getClaim: (id: number) => apiFetch<ClaimDetail>(`/claims/${id}`),
  createClaim: (body: ClaimBody) => apiFetch<Claim>("/claims", { method: "POST", body: JSON.stringify(body) }),
  patchClaim: (id: number, body: Partial<ClaimBody>) =>
    apiFetch<Claim>(`/claims/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteClaim: (id: number) => apiFetch<void>(`/claims/${id}`, { method: "DELETE" }),
  setClaimStatus: (id: number, body: ClaimStatusBody) =>
    apiFetch<Claim>(`/claims/${id}/status`, { method: "POST", body: JSON.stringify(body) }),
  addClaimEvent: (id: number, body: ClaimEventBody) =>
    apiFetch<ClaimEvent>(`/claims/${id}/events`, { method: "POST", body: JSON.stringify(body) }),
  setClaimEvidence: (id: number, key: string, body: ClaimEvidenceBody) =>
    apiFetch<ClaimEvidence>(`/claims/${id}/evidence/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(body) }),
  addClaimLink: (id: number, body: ClaimLinkBody) =>
    apiFetch<ClaimLink>(`/claims/${id}/links`, { method: "POST", body: JSON.stringify(body) }),
  deleteClaimLink: (id: number, linkId: number) => apiFetch<void>(`/claims/${id}/links/${linkId}`, { method: "DELETE" }),

  // ---- knowledge base (O&M manuals as Markdown, with revisions; DB only). PATCH / restore with a
  // stale base_version throw ApiError 409 whose `detail` is `{message, current}` (KbConflictDetail)
  listKbArticles: (q: KbArticleQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return apiFetch<KbArticleList>(`/kb/articles${qs ? `?${qs}` : ""}`);
  },
  getKbArticle: (slug: string) => apiFetch<KbArticle>(`/kb/articles/${encodeURIComponent(slug)}`),
  createKbArticle: (body: KbArticleBody) => apiFetch<KbArticle>("/kb/articles", { method: "POST", body: JSON.stringify(body) }),
  patchKbArticle: (id: number, body: KbArticlePatch) =>
    apiFetch<KbArticle>(`/kb/articles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  publishKbArticle: (id: number) => apiFetch<KbArticle>(`/kb/articles/${id}/publish`, { method: "POST" }),
  archiveKbArticle: (id: number) => apiFetch<KbArticle>(`/kb/articles/${id}/archive`, { method: "POST" }),
  deleteKbArticle: (id: number) => apiFetch<KbDeleteResult>(`/kb/articles/${id}`, { method: "DELETE" }),
  listKbRevisions: (id: number) => apiFetch<KbRevisionList>(`/kb/articles/${id}/revisions`),
  getKbRevision: (id: number, revNo: number) => apiFetch<KbRevision>(`/kb/articles/${id}/revisions/${revNo}`),
  restoreKbRevision: (id: number, revNo: number, baseVersion: number) =>
    apiFetch<KbArticle>(`/kb/articles/${id}/restore/${revNo}`, { method: "POST", body: JSON.stringify({ base_version: baseVersion }) }),

  // ---- knowledge base library: PDF documents (file never changed, text per page; DB + object
  // storage). Uploads are multipart (`file` + `meta` JSON). `getKbDocFile` answers a short-lived
  // signed link: `api` = an API path to prefix with API_BASE (no Authorization header needed)
  listKbDocs: (q: KbDocQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return apiFetch<KbDocList>(`/kb/docs${qs ? `?${qs}` : ""}`);
  },
  getKbDocHome: () => apiFetch<KbDocHome>("/kb/docs/home"),
  getKbDocContext: () => apiFetch<KbDocContext>("/kb/docs/context"),
  getKbDocCatalog: () => apiFetch<KbDocCatalog>("/kb/docs/catalog"),
  getKbNextNumber: (type: string, discipline: string) =>
    apiFetch<{ number: string }>(`/kb/docs/next-number?type=${encodeURIComponent(type)}&discipline=${encodeURIComponent(discipline)}`),
  searchKb: (q: string, limit = 20) => apiFetch<KbSearchResult>(`/kb/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  getKbDoc: (id: number) => apiFetch<KbDocDetail>(`/kb/docs/${id}`),
  getKbDocFile: (id: number, opts: { rev?: number | null; download?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.rev != null) p.set("rev", String(opts.rev));
    if (opts.download) p.set("download", "true");
    const qs = p.toString();
    return apiFetch<KbDocFileLink>(`/kb/docs/${id}/file${qs ? `?${qs}` : ""}`);
  },
  uploadKbDoc: (file: File, meta: KbDocCreateMeta) => {
    const form = new FormData();
    form.append("file", file);
    form.append("meta", JSON.stringify(meta));
    return apiFetch<KbDocDetail>("/kb/docs", { method: "POST", body: form });
  },
  uploadKbDocRevision: (id: number, file: File, label: string, changeNote: string) => {
    const form = new FormData();
    form.append("file", file);
    if (label.trim()) form.append("label", label.trim());
    if (changeNote.trim()) form.append("change_note", changeNote.trim());
    return apiFetch<KbDocDetail>(`/kb/docs/${id}/revisions`, { method: "POST", body: form });
  },
  patchKbDoc: (id: number, body: KbDocPatch) => apiFetch<KbDocDetail>(`/kb/docs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  putKbDocLinks: (id: number, links: KbDocLinkInput[]) =>
    apiFetch<KbDocDetail>(`/kb/docs/${id}/links`, { method: "PUT", body: JSON.stringify({ links }) }),
  pinKbDoc: (id: number, pinned: boolean) => apiFetch<{ pinned: boolean }>(`/kb/docs/${id}/pin`, { method: "PUT", body: JSON.stringify({ pinned }) }),
  releaseKbDoc: (id: number) => apiFetch<KbDocDetail>(`/kb/docs/${id}/release`, { method: "POST" }),
  withdrawKbDoc: (id: number, reason: string) =>
    apiFetch<KbDocDetail>(`/kb/docs/${id}/withdraw`, { method: "POST", body: JSON.stringify({ reason }) }),
  supersedeKbDoc: (id: number, byDocId: number | null, note: string) =>
    apiFetch<KbDocDetail>(`/kb/docs/${id}/supersede`, { method: "POST", body: JSON.stringify({ by_doc_id: byDocId, note: note || null }) }),
  ocrKbDocAgain: (id: number, revNo: number) =>
    apiFetch<{ pages: number; text_status: string }>(`/kb/docs/${id}/revisions/${revNo}/ocr`, { method: "POST" }),
  deleteKbDoc: (id: number) => apiFetch<{ result: "deleted" | "withdrawn" }>(`/kb/docs/${id}`, { method: "DELETE" }),
  getPlantKbDocuments: (plantId: number) => apiFetch<KbPlantDocuments>(`/kb/plants/${plantId}/documents`),

  // ---- site visit route (nothing stored; drive times are Geoapify road estimates or straight-line
  // estimates, both modelled). `solveRoute` is rate limited per user (429); 422 = no location /
  // split the day (`ApiError.detail`)
  getRouteCandidates: (q: RouteCandidateQuery = {}) => {
    const qs = new URLSearchParams();
    if (q.day) qs.set("day", q.day);
    if (q.team_id != null) qs.set("team_id", String(q.team_id));
    if (q.user_id != null) qs.set("user_id", String(q.user_id));
    const s = qs.toString();
    return apiFetch<RouteCandidates>(`/growatt/routes/candidates${s ? `?${s}` : ""}`);
  },
  solveRoute: (body: RouteSolveRequest) =>
    apiFetch<RouteSolveResponse>("/growatt/routes/solve", { method: "POST", body: JSON.stringify(body) }),
  // saved offices a route can start from: everyone lists, admins write (403 otherwise; 404 / 409 / 422
  // with the reason in `ApiError.detail`)
  listRouteOffices: () => apiFetch<RouteOfficeList>("/growatt/routes/offices"),
  createRouteOffice: (body: RouteOfficeIn) =>
    apiFetch<RouteOffice>("/growatt/routes/offices", { method: "POST", body: JSON.stringify(body) }),
  updateRouteOffice: (id: number, body: RouteOfficePatch) =>
    apiFetch<RouteOffice>(`/growatt/routes/offices/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRouteOffice: (id: number) => apiFetch<RouteOfficeDeleted>(`/growatt/routes/offices/${id}`, { method: "DELETE" }),

  // File URLs (need the session token: download with downloadApiFile)
  sampleCsvPath: (datasetId: number) => `/datasets/${datasetId}/sample-csv`,
};
