/** O&M site register (docs/plans/om-asset-network.md): station data and on-site devices, imported from the
 * O&M workbook. Values as written; null = empty cell. */

export type SiteDeviceKind = "datalogger" | "weather_station" | "revenue_meter" | "router" | "pqm" | "shinemaster";

export interface SiteRegisterSite {
  site_code: string;
  plant_id: number | null;
  /** how the station was matched to its Growatt plant */
  match_rule: "logger_sn" | "logger_sn_prefix" | "name_code" | "kept" | null;
  name: string;
  project_phase: number | null;
  province: string | null;
  kwp: number | null;
  inverter_ac_kw: number | null;
  export_limit: string | null;
  pea_meter_no: string | null;
  pea_account_no: string | null;
  pea_connection_status: string | null;
  pwa_branch: string | null;
  pwa_zone: string | null;
  pea_zone: string | null;
  billing_cut_days: string | null;
  revenue_meter_count: number | null;
  pea_contract_start: string | null;
  cod_baseline: string | null;
  cod_actual: string | null;
  dlp_contractor: string | null;
  engineers_text: string | null;
  technicians_text: string | null;
  missing_sn_count: number | null;
  logger_sn: string | null;
  imported_by: string | null;
  imported_at: string;
}

export interface SiteDevice {
  kind: SiteDeviceKind;
  seq: number;
  brand_model: string | null;
  serial: string | null;
  firmware: string | null;
  ip: string | null;
  network: string | null;
  sim: string | null;
  address: string | null;
  ct_setting: string | null;
  ct_site: string | null;
  billing_cut_days: string | null;
  sales_start: string | null;
  cod_clear_note: string | null;
  link_status: string | null;
  status: string | null;
  warranty_start: string | null;
  warranty_end: string | null;
  note: string | null;
}

/** One device as sent to `PUT …/site-register/devices` (empty text = null). */
export type SiteDeviceIn = SiteDevice;

export interface SiteRegisterCheck {
  key: "unmatched" | "kwp_differs" | "logger_sn_differs" | "meter_count_differs" | "ct_differs";
  text: string;
}

export interface PlantSiteRegister {
  plant_id: number;
  /** null when the plant has no station in the register */
  register: {
    site: SiteRegisterSite;
    devices: SiteDevice[];
    growatt: { plant_id: number; name: string; kwp: number | null; phase: number | null; logger_sns: string[] } | null;
    checks: SiteRegisterCheck[];
  } | null;
}

/** One row of Settings → Site register (`GET /growatt/site-register`). */
export interface SiteRegisterRow {
  site_code: string;
  plant_id: number | null;
  plant_name: string | null;
  match_rule: SiteRegisterSite["match_rule"];
  name: string;
  project_phase: number | null;
  province: string | null;
  kwp: number | null;
  cod_actual: string | null;
  revenue_meter_count: number | null;
  logger_sn: string | null;
  /** device count per kind */
  devices: Partial<Record<SiteDeviceKind, number>>;
  checks: SiteRegisterCheck[];
}

/** `POST /growatt/site-register/import`: a preview (`applied` false) or what was stored. */
export interface SiteRegisterImport {
  applied: boolean;
  sites: number;
  devices: number;
  matched: number;
  by_rule: Record<string, number>;
  new: number;
  /** stations in the app that the file no longer has (deleted on apply) */
  removed: string[];
  needs_review: SiteRegisterImportRow[];
  rows: SiteRegisterImportRow[];
  warnings: string[];
  meter_no_filled: number;
}

export interface SiteRegisterImportRow {
  site_code: string;
  name: string | null;
  plant_id: number | null;
  plant_name: string | null;
  rule: SiteRegisterSite["match_rule"];
  logger_sn: string | null;
  growatt_logger_sn: string | null;
  devices: number;
  checks: SiteRegisterCheck[];
}
