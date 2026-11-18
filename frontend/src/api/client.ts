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
export type * from "./types/systemLogs";
export type * from "./types/assistant";
export type * from "./types/push";
export type * from "./types/issues";
export type * from "./types/events";
import type { UserCreate, UserProfile, UserUpdate } from "./types/auth";
import type { AnalysisRun, CMWorkOrder, DatasetInfo, PMTask, PTWPermit, Plant, RCARecord, StringSpec } from "./types/legacy";
import type { FleetAlarmDay, FleetModule, FleetModuleOut, GrowattInverter, GrowattInverterDaily, GrowattInverterSnapshot, GrowattInverterTimeseries, GrowattLive, GrowattLiveAlarms, GrowattLiveMeter, GrowattLivePlant, GrowattLivePlantLatest, GrowattLivePlantsToday, GrowattPlant, GrowattPlantOverview, GrowattPlantPower, GrowattStringDetail, GrowattStringLayout, GrowattStringLayoutEntry, IvSiteCoefficients, IvSweep, IvSweepCreate, IvSweepList, PublishResult } from "./types/growatt";
import type { GoogleWeatherDay, GoogleWeatherNow, GrowattLiveWeather, GrowattWeatherDay, FleetRadarRain, PlantRadarRain, RainRadar } from "./types/weather";
import type { SensorList, SensorLive, SensorLiveStatus, SensorToday } from "./types/sensors";
import type { SystemLogPage, SystemLogQuery, SystemLogSummary } from "./types/systemLogs";
import type { AssistantStatus, AssistantUsage } from "./types/assistant";
import type { PushStatus } from "./types/push";
import type { SiteEvent, SiteEventBody, SiteEventList, SiteEventQuery } from "./types/events";
import type { InverterRuleDay, Issue, IssueActionBody, IssueList, IssueQuery, RuleDaily, RuleSettings, RulesOut, RulesPatch, StringRuleDay, Tariff, TariffOut, TariffRates } from "./types/issues";

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
  constructor(message: string, readonly status: number) {
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
    try {
      const body = await res.json();
      if (body.detail) errDetail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // ignore
    }
    throw new ApiError(errDetail, res.status);
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
  /** `records: "false"`: only Growatt's own figures (curve, daily kWh), no stored records read */
  getGrowattPlantPower: (plantId: number, q: { day: string; end_day?: string | null; start?: string; end?: string; records?: "false" }) =>
    apiFetch<GrowattPlantPower>(
      `/growatt/plants/${plantId}/power?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`
    ),
  getGrowattInverterTimeseries: (plantId: number, deviceSn: string, day?: string) =>
    apiFetch<GrowattInverterTimeseries>(
      `/growatt/plants/${plantId}/inverters/${encodeURIComponent(deviceSn)}/timeseries${day ? `?day=${day}` : ""}`
    ),
  /** Every Growatt field of one inverter's stored records for a day (as reported; kept 30 days). */
  getGrowattInverterRaw: (plantId: number, deviceSn: string, day?: string) =>
    apiFetch<{
      meta: { plant_id: number; device_sn: string; day: string | null; source: string; records: number };
      fields: string[];
      records: Array<Record<string, unknown>>;
    }>(`/growatt/plants/${plantId}/inverters/${encodeURIComponent(deviceSn)}/raw${day ? `?day=${day}` : ""}`),
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

  // SH&E & PTW
  getSheDashboard: (plantId: number) =>
    apiFetch<{ kpis: Record<string, number>; ptw_permits: PTWPermit[]; checklist: Record<string, any>[] }>(
      `/she/dashboard?plant_id=${plantId}`
    ),
  createPtwPermit: (payload: Partial<PTWPermit>) =>
    apiFetch<PTWPermit>("/ptw", { method: "POST", body: JSON.stringify(payload) }),
  updatePtwPermit: (id: number, payload: Partial<PTWPermit>) =>
    apiFetch<PTWPermit>(`/ptw/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deletePtwPermit: (id: number) => apiFetch<void>(`/ptw/${id}`, { method: "DELETE" }),

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
  getRules: (sinceDays = 90) => apiFetch<RulesOut>(`/growatt/rules?since_days=${sinceDays}`),
  putRules: (patch: RulesPatch) =>
    apiFetch<{ settings: RuleSettings }>("/growatt/rules", { method: "PUT", body: JSON.stringify(patch) }),
  getTariff: () => apiFetch<TariffOut>("/growatt/tariff"),
  getTariffRates: (day?: string) => apiFetch<TariffRates>(`/growatt/tariff/rates${day ? `?day=${day}` : ""}`),
  putTariff: (t: Tariff) => apiFetch<TariffOut>("/growatt/tariff", { method: "PUT", body: JSON.stringify(t) }),
  getInverterRuleDaily: (plantId: number, sn: string, days = 30, day?: string) =>
    apiFetch<RuleDaily<InverterRuleDay>>(
      `/growatt/plants/${plantId}/rules/daily?sn=${encodeURIComponent(sn)}&days=${days}${day ? `&day=${day}` : ""}`
    ),
  getStringRuleDaily: (plantId: number, sn: string, stringNo: number, days = 30, day?: string) =>
    apiFetch<RuleDaily<StringRuleDay>>(
      `/growatt/plants/${plantId}/rules/daily?sn=${encodeURIComponent(sn)}&string_no=${stringNo}&days=${days}${day ? `&day=${day}` : ""}`
    ),

  // File URLs (need the session token: download with downloadApiFile)
  sampleCsvPath: (datasetId: number) => `/datasets/${datasetId}/sample-csv`,
};
