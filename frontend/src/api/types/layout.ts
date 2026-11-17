/** API types: string layout, the fleet module and the publish result of saving them. */
import type { IvCellTechnology } from "./iv";

export interface GrowattStringLayoutEntry {
  device_sn: string;
  string_no: number;
  modules: number;
  module_wp?: number | null;
  azimuth_deg?: number | null;
  tilt_deg?: number | null;
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
  rs_ohm?: number | null;
  kappa_ohm_per_k?: number | null;
  first_year_lid_pct?: number | null;
  annual_degradation_pct?: number | null;
  /** I-V analysis: enables the sweep-time gate for every sweep; null = unknown */
  cell_technology?: IvCellTechnology | null;
  /** measured IEC 60891 Procedure 2 irradiance factors; null = the assumed typical ones are used */
  p2_b1?: number | null;
  p2_b2?: number | null;
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
      azimuth_deg?: number | null;
      tilt_deg?: number | null;
      /** carried current in the last 7 days of stored history */
      active: boolean;
    }>;
  }>;
}
