/**
 * Typed REST API client for the TC Roof Solar PV String & O&M Engineering Backend.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const TOKEN_KEY = "tc_solar_jwt_token";
const USER_KEY = "tc_solar_user";

export interface UserProfile {
  id: number;
  username: string | null;
  email: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  /** Growatt plants this user may see: null = every plant (admin), else the ids an admin assigned. */
  plant_ids: number[] | null;
}

export type UserRole = "admin" | "engineer";

export interface UserCreate {
  username: string;
  email?: string | null;
  full_name: string;
  password: string;
  role: UserRole;
  plant_ids: number[];
}

export type UserUpdate = Partial<Pick<UserCreate, "email" | "full_name" | "password" | "role">> & { is_active?: boolean };

export interface StringSpec {
  id?: number;
  string_id: string;
  inverter_id: string;
  mppt_id: string;
  modules_per_string: number;
  module_wp: number;
  voc_stc: number;
  vmp_stc: number;
  isc_stc: number;
  imp_stc: number;
  temp_coeff_pmax: number;
  temp_coeff_voc: number;
  temp_coeff_isc: number;
}

export interface Plant {
  id: number;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  system_loss_factor: number;
  underperformance_threshold_pct: number;
  zero_current_threshold_a: number;
  min_irradiance_for_anomaly_wm2: number;
  target_pr_pct: number;
  tariff_thb_per_kwh: number;
  modules_per_string: number;
  module_wp: number;
  vmp_stc: number;
  imp_stc: number;
  string_specs: StringSpec[];
}

export interface DatasetInfo {
  id: number;
  plant_id: number;
  name: string;
  source_type: string;
  source_label: string;
  row_count: number;
  string_count: number;
  start_timestamp: string | null;
  end_timestamp: string | null;
  status: string;
  created_at: string;
  preview_rows?: Record<string, any>[];
  latest_analysis_run_id?: number | null;
}

export interface AnalysisRun {
  id: number;
  plant_id: number;
  dataset_id: number;
  target_pr_pct: number;
  tariff_thb_per_kwh: number;
  plant_kpis_json: Record<string, number | null>;
  string_summary_json: Record<string, any>[];
  daily_string_json: Record<string, any>[];
  anomalies_json: Record<string, any>[];
  daily_plant_json: Record<string, any>[];
  monthly_plant_json: Record<string, any>[];
  waterfall_json: Record<string, any>[];
  opportunities_json: Record<string, any>[];
  created_at: string;
}

export interface PMTask {
  id: number;
  plant_id: number;
  pm_id: string;
  asset_category: string;
  task_description: string;
  frequency: string;
  standard_ref: string;
  last_completed: string;
  next_due: string;
  assigned_subcontractor: string;
  compliance_status: string;
  estimated_pr_recovery_pct: number;
  updated_at: string;
}

export interface CMWorkOrder {
  id: number;
  plant_id: number;
  analysis_run_id: number | null;
  wo_number: string;
  created_date: string;
  asset_id: string;
  equipment_type: string;
  priority: string;
  fault_symptom: string;
  troubleshooting_checklist: string;
  ptw_required: string;
  status: string;
  updated_at: string;
}

export interface RCARecord {
  id: number;
  plant_id: number;
  rca_id: string;
  incident_date: string;
  equipment_category: string;
  asset_id: string;
  failure_mode: string;
  downtime_hours: number;
  energy_loss_kwh: number;
  why_1: string;
  why_2: string;
  why_3: string;
  why_4: string;
  why_5_root_cause: string;
  fishbone_category: string;
  capa_corrective_action: string;
  capa_preventive_action: string;
  rca_status: string;
  updated_at: string;
}

export interface SubcontractorAudit {
  id: number;
  plant_id: number;
  contractor_id: string;
  subcontractor_name: string;
  scope_of_work: string;
  active_work_orders: number;
  workmanship_score_pct: number;
  engineering_std_compliance_pct: number;
  safety_she_compliance_pct: number;
  on_time_sla_pct: number;
  open_ncrs: number;
  torque_seal_verified: string;
  calibrated_tools_cert: string;
  overall_rating: string;
  updated_at: string;
}

export interface PQTestResult {
  id: number;
  plant_id: number;
  voltage_thd_pct: number;
  current_thd_pct: number;
  power_factor: number;
  voltage_unbalance_pct: number;
  flicker_plt: number;
  grid_frequency_hz: number;
  dc_injection_pct: number;
  min_riso_mohm: number;
  pq_results_json: Record<string, any>[];
  commissioning_results_json: Record<string, any>[];
  overall_compliant: boolean;
  created_at: string;
}

export interface PTWPermit {
  id: number;
  plant_id: number;
  ptw_number: string;
  issue_date: string;
  work_activity: string;
  high_risk_permits: string;
  loto_padlock_id: string;
  arc_flash_ppe: string;
  gas_heat_index_check: string;
  safety_supervisor: string;
  status: string;
  updated_at: string;
}

export interface GrowattPlant {
  plant_id: number;
  /** project phase = the Growatt account listing this plant; null until the fleet sync tags it */
  phase?: number | null;
  name: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  peak_power_kwp: number | null;
  current_power_w: number | null;
  today_energy_kwh?: number | null;
  total_energy_kwh: number | null;
  inverter_count?: number;
  /** realtime: always null from the DB, filled by the live overlay */
  status: number | null;
  create_date: string | null;
  energy_date?: string | null;
  synced_at?: string | null;
}

export interface GrowattDbMeta {
  source: "db";
  day: string | null;
  data_until?: string | null;
  synced_at?: string | null;
}

/** Realtime envelope from /growatt/live/* (backend memory cache only, never persisted). */
export interface GrowattLive<T> {
  source: "live";
  fetched_at: string;
  stale: boolean;
  error: string | null;
  /** Seconds until polling again can return anything new (cache expiry / cooldown end). */
  refresh_in_s?: number;
  data: T;
}

export interface GrowattLivePlant {
  plant_id: number;
  phase: number;
  name: string | null;
  current_power_w: number | null;
  total_energy_kwh: number | null;
  peak_power_kwp: number | null;
  status: number | null;
}

export interface GrowattLiveInverterLatest {
  device_sn: string;
  timestamp: string; // plant-local
  status: number | null;
  pac_w: number | null;
  ppv_w: number | null;
  eac_today_kwh: number | null;
  temperature_c: number | null;
  fac_hz: number | null;
  mppt: Array<{ mppt: number; v: number; i: number; p: number }>;
  strings: Array<{ string_no: number; mppt_no: number; voltage_v: number; current_a: number; power_w: number }>;
  /** true = Growatt refused this inverter just now; this is its last good record */
  stale?: boolean;
  fetched_at?: string;
}

export interface GrowattLivePlantLatest {
  plant_id: number;
  day: string;
  inverters: GrowattLiveInverterLatest[];
  errors: Record<string, string>;
}

export type GrowattWeatherField =
  | "irradiance_wm2"
  | "ambient_temp_c"
  | "module_temp_c"
  | "humidity_pct"
  | "wind_speed_ms"
  | "wind_dir_deg";

export interface GrowattWeatherSensor {
  datalogger_sn: string;
  address: number;
  device_name: string | null;
  samples: number;
  first_reading: string | null;
  last_reading: string | null;
  /** fields the sensor actually reported that day (others read 0 all day = not fitted) */
  measured: GrowattWeatherField[];
}

export interface GrowattWeatherKpis {
  insolation_kwh_m2: number | null;
  peak_irradiance_wm2: number | null;
  avg_ambient_temp_c: number | null;
  max_ambient_temp_c: number | null;
  avg_module_temp_daylight_c: number | null;
  max_module_temp_c: number | null;
  avg_humidity_pct: number | null;
  avg_wind_speed_ms: number | null;
  max_wind_speed_ms: number | null;
}

export interface GrowattIecPr {
  pr_pct: number | null;
  reference_yield_h: number | null;
  final_yield_h: number | null;
  coverage_pct: number | null;
  /** why pr_pct is null */
  reason: string | null;
}

export type GrowattWeatherPoint = { timestamp: string } & Record<GrowattWeatherField, number | null>;

/** /growatt/plants/{id}/weather — stored 5-minute weather-sensor history (DB only). */
export interface GrowattWeatherDay {
  meta: { source: "db"; day: string | null; data_until: string | null };
  has_sensor: boolean;
  sensors: GrowattWeatherSensor[];
  kpis: GrowattWeatherKpis;
  series: GrowattWeatherPoint[];
}

/** /growatt/live/plants/{id}/weather — newest reading per sensor (memory only, never stored). */
export interface GrowattLiveWeather {
  plant_id: number;
  sensors: Array<
    { datalogger_sn: string; address: number; timestamp: string; stale?: boolean; fetched_at?: string } & Record<
      GrowattWeatherField,
      number | null
    >
  >;
  errors: Record<string, string>;
}

export interface GrowattPlantOverview {
  meta: GrowattDbMeta;
  /** set by AppContext when live values are overlaid */
  live?: { fetched_at: string; stale: boolean } | null;
  plant: GrowattPlant;
  kpis: {
    capacity_kwp: number | null;
    current_power_kw: number | null;
    peak_power_kw: number | null;
    yield_today_kwh: number | null;
    total_yield_kwh: number | null;
    specific_yield_kwh_per_kwp: number | null;
    /** peer-relative string index (strings compared with each other), not IEC */
    plant_pr_pct: number | null;
    /** IEC 61724-1 PR from the plant's weather sensor; null without one or with poor coverage */
    iec_pr_pct?: number | null;
    insolation_kwh_m2?: number | null;
    peak_irradiance_wm2?: number | null;
    avg_module_temp_c?: number | null;
    avg_ambient_temp_c?: number | null;
    target_pr_pct: number;
    conversion_efficiency_pct: number | null;
    avg_temp_c: number | null;
    max_temp_c: number | null;
    avg_freq_hz: number | null;
    inverter_count: number;
    /** realtime: null from the DB, counted from live inverter status by AppContext */
    online_inverters: number | null;
    string_count: number;
    healthy_strings: number;
    warning_strings: number;
    critical_strings: number;
    /** string inputs with no current today (not in `strings`) */
    inactive_strings?: number;
    /** strings with a module count in the layout registry / compared per module with peers */
    strings_with_module_count?: number;
    strings_normalized?: number;
    avg_health_score: number | null;
    tariff_thb_per_kwh: number;
  };
  inverters: Array<{
    device_sn: string;
    model: string;
    datalogger_sn: string;
    status: number | null;
    status_label: string | null;
    lost: boolean | null;
    last_update_time: string | null;
    capacity_kwp: number | null;
    current_ac_kw: number | null;
    peak_ac_kw: number | null;
    peak_dc_kw: number | null;
    yield_today_kwh: number | null;
    period_energy_kwh: number | null;
    total_yield_kwh: number | null;
    specific_yield: number | null;
    efficiency_pct: number | null;
    pr_pct: number | null;
    avg_temp_c: number | null;
    max_temp_c: number | null;
    avg_freq_hz: number | null;
    string_count: number;
    mppt_latest: Array<{ mppt: number; v: number; i: number; p: number }>;
    /** plant-local time of the live record overlaid on current_ac_kw / mppt_latest (frontend only) */
    live_at?: string | null;
  }>;
  timeseries: Array<{
    timestamp: string;
    pac_kw: number;
    ppv_kw: number;
    expected_kw: number | null;
    temp_c: number | null;
    freq_hz: number | null;
    /** measured by the weather sensor (null without one) */
    irradiance_wm2?: number | null;
    module_temp_c?: number | null;
    ambient_temp_c?: number | null;
  }>;
  weather?: {
    has_sensor: boolean;
    sensors: GrowattWeatherSensor[];
    data_until: string | null;
    kpis: GrowattWeatherKpis;
    iec_pr: GrowattIecPr;
  };
  loss_waterfall: Array<{
    stage: string;
    kwh: number;
    type: "base" | "loss" | "net";
  }>;
  strings: Array<{
    string_id: string;
    short_label: string;
    inverter_id: string;
    device_sn: string;
    string_no: number;
    mppt_id: string;
    mppt_no: number;
    capacity_kwp: number | null;
    /** as-built module count from the string layout registry (null = not entered) */
    modules?: number | null;
    module_wp?: number | null;
    peer_basis?: GrowattPeerBasis;
    actual_energy_kwh: number;
    expected_energy_kwh: number | null;
    energy_loss_kwh: number | null;
    pr_pct: number | null;
    v_avg: number | null;
    v_max: number;
    i_avg: number | null;
    i_max: number;
    p_max_w: number;
    current_mismatch_pct: number | null;
    voltage_mismatch_pct: number | null;
    underperf_pct: number | null;
    availability_pct: number;
    health_score: number | null;
    status: "Healthy" | "Warning" | "Critical";
    diagnosis: string;
    /** realtime overlay from /growatt/live/plants/{id}/latest (frontend only, never stored) */
    live_voltage_v?: number | null;
    live_current_a?: number | null;
    live_power_w?: number | null;
    live_at?: string | null;
  }>;
  /** String inputs with no current today, one per input slot (2 per MPPT). Not in `strings`. */
  inactive_strings?: Array<{
    string_id: string;
    short_label: string;
    device_sn: string;
    string_no: number;
    mppt_no: number;
    mppt_id: string;
    status: "Not Active";
    /** no_current: MPPT has voltage, string carries no current; no_data: input not reported */
    reason: "no_current" | "no_data";
    v_max: number | null;
  }>;
  anomalies: Array<{
    string_id: string;
    inverter_id: string;
    device_sn: string;
    string_no: number;
    severity: "Critical" | "Warning";
    category: string;
    description: string;
    pr_pct: number | null;
    energy_loss_kwh: number | null;
    recommended_action: string;
  }>;
}

/**
 * How a string is compared with its inverter peers. "raw": measured values (some string of the
 * inverter has no module count); "per_module": energy and voltage per module; "per_kwp": energy
 * per kWp (module ratings known too) and voltage per module.
 */
export type GrowattPeerBasis = "raw" | "per_module" | "per_kwp";

export interface GrowattStringLayoutEntry {
  device_sn: string;
  string_no: number;
  modules: number;
  module_wp?: number | null;
}

/** Result of mirroring a saved registry change to the summary sink (Firestore or JSON files). */
export interface PublishResult {
  sink: string | null;
  written: number;
  deferred?: boolean;
  error?: string;
}

/** PV module used across the fleet (global setting; SQL, mirrored to Firestore config/fleet_module). */
export interface FleetModule {
  manufacturer: string;
  model: string;
  wp: number;
  vmp_stc: number | null;
  imp_stc: number | null;
  voc_stc: number | null;
  isc_stc: number | null;
  efficiency_pct: number | null;
  temp_coeff_pmax_pct: number | null;
  temp_coeff_voc_pct: number | null;
  temp_coeff_isc_pct: number | null;
  bifacial_factor_pct: number | null;
  datasheet_url: string | null;
}

export interface FleetModuleOut extends FleetModule {
  /** "default" = operator-stated module, not yet saved by anyone */
  source: "default" | "saved";
  updated_by: string | null;
  updated_at: string | null;
  /** result of mirroring to the summary sink (PUT only) */
  published?: PublishResult;
}

export interface GrowattStringLayout {
  plant_id: number;
  plant_name: string;
  /** rating applied to strings whose module_wp is null */
  fleet_module_wp: number | null;
  inverters: Array<{
    device_sn: string;
    model: string;
    strings: Array<{
      string_no: number;
      mppt_no: number;
      modules: number | null;
      module_wp: number | null;
      /** carried current in the last 7 days of stored history */
      active: boolean;
    }>;
  }>;
}

export interface GrowattStringDetail {
  meta: GrowattDbMeta;
  plant_id: number;
  plant_name: string;
  device_sn: string;
  string_no: number;
  mppt_no: number;
  string_id: string;
  modules?: number | null;
  module_wp?: number | null;
  /** peer series scaled to this string's module count (per_module) or kWp (per_kwp); raw = as measured */
  peer_basis?: GrowattPeerBasis;
  summary: {
    v_avg: number | null;
    v_max: number;
    v_mpp: number;
    v_oc_est: number;
    i_avg: number | null;
    i_max: number;
    i_mpp: number;
    i_sc_est: number;
    p_max_w: number;
    energy_kwh: number;
    peer_energy_kwh: number | null;
    pr_pct: number | null;
  };
  timeseries: Array<{
    timestamp: string;
    voltage_v: number;
    current_a: number;
    power_w: number;
    peer_voltage_v: number | null;
    peer_current_a: number | null;
    peer_power_w: number | null;
  }>;
  iv_pv_curve: {
    nominal_points: Array<{ v: number; i: number; p: number }>;
    actual_points: Array<{ v: number; i: number; p: number }>;
    measured_scatter: Array<{ v: number; i: number; p: number; timestamp: string }>;
    mpp_nominal: { v: number; i: number; p: number };
    mpp_actual: { v: number; i: number; p: number };
  };
}

export interface GrowattInverter {
  device_sn: string;
  model: string;
  datalogger_sn: string;
  manufacturer: string;
  status: number | null;
  status_label: string | null;
  lost: boolean | null;
  last_update_time: string | null;
  device_types: string[];
  synced_at?: string | null;
}

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

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    throw new Error(errDetail);
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

/** Open an authenticated API file in a new tab. The tab is opened before the fetch so popup
 * blockers allow it (call from a click handler). */
export async function openApiFileInTab(path: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const { blob } = await fetchFileBlob(path);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (err) {
    tab?.close();
    throw err;
  }
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
  getGrowattStringDetail: (plantId: number, deviceSn: string, stringNo: number, day?: string) =>
    apiFetch<GrowattStringDetail>(
      `/growatt/plants/${plantId}/strings/${encodeURIComponent(deviceSn)}/${stringNo}${day ? `?day=${day}` : ""}`
    ),

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

  // Growatt — realtime (backend memory only; poll, never stored)
  getGrowattLivePlants: () => apiFetch<GrowattLive<GrowattLivePlant[]>>("/growatt/live/plants"),
  getGrowattLiveInverters: (plantId: number) =>
    apiFetch<GrowattLive<GrowattInverter[]>>(`/growatt/live/plants/${plantId}/inverters`),
  getGrowattLivePlantLatest: (plantId: number) =>
    apiFetch<GrowattLive<GrowattLivePlantLatest>>(`/growatt/live/plants/${plantId}/latest`),
  getGrowattLiveWeather: (plantId: number) =>
    apiFetch<GrowattLive<GrowattLiveWeather>>(`/growatt/live/plants/${plantId}/weather`),
  getGrowattPlantWeather: (plantId: number, day?: string) =>
    apiFetch<GrowattWeatherDay>(`/growatt/plants/${plantId}/weather${day ? `?day=${day}` : ""}`),

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

  // Subcontractors, QA/QC, Power Quality
  listSubcontractors: (plantId: number) =>
    apiFetch<SubcontractorAudit[]>(`/subcontractor-audits?plant_id=${plantId}`),
  createSubcontractor: (payload: Partial<SubcontractorAudit>) =>
    apiFetch<SubcontractorAudit>("/subcontractor-audits", { method: "POST", body: JSON.stringify(payload) }),
  updateSubcontractor: (id: number, payload: Partial<SubcontractorAudit>) =>
    apiFetch<SubcontractorAudit>(`/subcontractor-audits/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  getQaqcChecklist: () => apiFetch<Record<string, any>[]>("/qaqc-checklist"),
  getLatestPqTest: (plantId: number) => apiFetch<PQTestResult>(`/pq-tests/latest?plant_id=${plantId}`),
  evaluatePqTest: (payload: Record<string, any>) =>
    apiFetch<PQTestResult>("/pq-tests/evaluate", { method: "POST", body: JSON.stringify(payload) }),

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

  // Report URLs
  // Files need the session token: use downloadApiFile / openApiFileInTab / fetchFileBlob with these paths.
  reportPath: (runId: number, format: "pdf" | "xlsx" | "html" | "csv") => `/analysis/${runId}/reports/${format}`,
  sampleCsvPath: (datasetId: number) => `/datasets/${datasetId}/sample-csv`,
};
