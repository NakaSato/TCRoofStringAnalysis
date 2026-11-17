/** API types: I-V curve sweeps of a plant. */

export interface IvCurveParameters {
  i_sc_a: number;
  v_oc_v: number;
  i_mp_a: number;
  v_mp_v: number;
  p_max_w: number;
  fill_factor: number;
  slope_voc_ohm: number;
  slope_isc_ohm: number;
  steps_count: number;
}

export interface IvSingleDiodeFit {
  i_l_a: number;
  i_o_a: number;
  r_s_ohm: number;
  r_sh_ohm: number;
  n_ns_vth_v: number;
}

export interface IvSweep {
  id: number;
  plant_id: number;
  device_sn: string | null;
  string_no: number | null;
  module_no: number | null;
  level: "string" | "module";
  source: "upload" | "inverter_scan";
  swept_at: string;
  irradiance_wm2: number;
  module_temp_c: number;
  irradiance_change_pct: number | null;
  reference_cell_tech: string | null;
  /** optional conditions; null = not recorded, absent on older API responses */
  temp_change_k_per_min?: number | null;
  sweep_time_ms?: number | null;
  cell_technology?: IvCellTechnology | null;
  irradiance_uncertainty_pct?: number | null;
  reverse_pmax_w?: number | null;
  sensor_misalignment_deg?: number | null;
  modules: number;
  quality_gate_passed: boolean;
  gate_reasons: string[];
  iec60891: {
    procedure: number;
    g1_wm2: number;
    t1_c: number;
    g2_wm2: number;
    t2_c: number;
    alpha_a_per_k: number;
    beta_v_per_k: number;
    r_s_ohm: number;
    kappa_ohm_per_k: number;
    /** STC Pmax by IEC 60891 Procedure 2 (assumed B1/B2), as a cross-check; null = failed, absent on older sweeps */
    procedure_2?: { p_max_stc_w: number; diff_vs_procedure_1_pct: number; b1: number; b2: number; coefficients: string } | null;
    /** STC Pmax by IEC 60891 Procedure 4 (no Rs/κ/β coefficients, default ε), as a cross-check */
    procedure_4?: { p_max_stc_w: number; diff_vs_procedure_1_pct: number; epsilon_v: number; cells_in_series: number } | null;
    /** STC Pmax by the dynamic procedure (Procedure 2 without the curve's shunt current), for degraded curves */
    procedure_dynamic?: {
      p_max_stc_w: number;
      diff_vs_procedure_1_pct: number;
      diff_vs_procedure_2_pct: number | null;
      /** null when the shunt resistance is high enough to neglect */
      r_sh_ohm: number | null;
      shunt_neglected: boolean;
      coefficients: string;
    } | null;
    /** the curve's parameters at 1000 W/m², 55 °C (shorter temperature extrapolation, for trending) */
    site_reference?: {
      g_wm2: number;
      t_c: number;
      procedure: number;
      parameters: { p_max_w: number; i_sc_a: number; v_oc_v: number; fill_factor: number };
    } | null;
  };
  /** Computed on read from the other stored sweeps. Flag levels are proposed defaults, not from a standard. */
  comparison?: {
    peer: {
      window_min: number;
      peers: number;
      peer_strings: number[];
      /** this string / median of its peers (power and Voc per module); null = no verdict, see `reason` */
      ratios: { p_max: number | null; i_sc: number | null; v_oc: number | null; fill_factor: number | null } | null;
      flags: string[];
      setup_error_suspected: boolean;
      reason: string | null;
    };
    /** this sweep / the string's first valid sweep; null = no earlier sweep */
    baseline: {
      sweep_id: number;
      swept_at: string;
      ratios: { p_max: number | null; fill_factor: number | null; slope_voc: number | null; slope_isc: number | null };
      flags: string[];
    } | null;
    thresholds: Record<string, number | string>;
  };
  measured: {
    parameters: IvCurveParameters;
    single_diode_fit: IvSingleDiodeFit;
    points: Array<{ v: number; i: number; p: number }>;
  };
  stc: {
    parameters: IvCurveParameters;
    single_diode_fit: IvSingleDiodeFit;
    points: Array<{ v: number; i: number; p: number }>;
    reference_points: Array<{ v: number; i: number; p: number }>;
  };
  classification: {
    signature: string;
    observation: string;
    likely_cause: string;
    recommended_action: string;
    is_finding: boolean;
    in_dead_band: boolean;
    dead_band_pct: number;
    ticket_recommended: boolean;
    /** absent on sweeps stored before these fields existed */
    stc_comparison_valid?: boolean;
    /** signature `not_judged` only: what the STC values would have been read as; not a verdict */
    unjudged_signature?: string | null;
    shape_gate_passed?: boolean;
    gate_warnings?: string[];
    /** Pmax of this sweep vs the opposite-direction sweep; null = no second sweep given */
    forward_reverse?: { reverse_pmax_w: number; diff_pct: number; limit_pct: number; limit_status: string; capacitance_suspect: boolean } | null;
    /** Cell temperature worked out from Voc (valid only for a healthy Voc; never used to translate) */
    equivalent_cell_temp?: { t_c: number; diff_vs_measured_k: number; basis: string; coefficients: string } | null;
    /** low_G | unstable_G | unstable_T | capacitance_suspect | sensor_misaligned */
    quality_flags?: string[];
    /** Estimated expanded uncertainty (k = 2) of STC Pmax, a lower bound; null for inverter scans */
    uncertainty?: {
      expanded_pct: number;
      coverage_k: number;
      lower_bound: boolean;
      components: Array<{ name: string; pct: number; source: "input" | "assumed" | "procedure_spread" }>;
      not_included: string[];
    } | null;
    warranty: {
      below_warranted_power: boolean;
      ir_confirmed: boolean;
      timeseries_trend_confirmed: boolean;
      second_source: string | null;
      module_test_candidate?: boolean;
      nameplate_w: number;
      expected_pmax_stc_w: number;
      warranted_retention_pct: number;
      first_year_lid_pct: number;
      annual_degradation_pct: number;
      system_age_years: number;
    };
    deviations_pct: {
      p_max_vs_expected_pct: number;
      v_oc_vs_stc_pct: number;
      i_sc_vs_stc_pct: number;
      ff_vs_stc_pct: number;
    };
  };
  p_max_stc_w: number | null;
  expected_pmax_stc_w: number | null;
  pmax_dev_pct: number | null;
  signature: string | null;
  is_finding: boolean;
  ticket_recommended: boolean;
  ir_confirmed: boolean;
  timeseries_trend_confirmed: boolean;
  /** below warranted power + a second source: test the string's modules one by one */
  module_test_candidate: boolean;
  note: string | null;
  created_by: string | null;
  created_at: string | null;
}

export type IvCellTechnology = "perc" | "topcon" | "hjt" | "ibc";

export interface IvSweepCreate {
  device_sn?: string | null;
  string_no?: number | null;
  module_no?: number | null;
  level?: "string" | "module";
  source?: "upload" | "inverter_scan";
  swept_at: string;
  irradiance_wm2: number;
  module_temp_c: number;
  irradiance_change_pct?: number | null;
  reference_cell_tech?: string | null;
  temp_change_k_per_min?: number | null;
  sweep_time_ms?: number | null;
  cell_technology?: IvCellTechnology | null;
  irradiance_uncertainty_pct?: number | null;
  reverse_pmax_w?: number | null;
  sensor_misalignment_deg?: number | null;
  modules?: number | null;
  points?: Array<{ v: number; i: number }>;
  csv_text?: string | null;
  dead_band_pct?: number;
  near_negative_pole?: boolean;
  low_irradiance_worse?: boolean;
  ir_confirmed?: boolean;
  note?: string | null;
}

/** Coefficients fitted on read from one string's stored handheld sweeps. Estimates; null = not determined (see `reasons`). */
export interface IvSiteCoefficients {
  plant_id: number;
  device_sn: string;
  string_no: number;
  modules: number | null;
  stored_sweeps: number;
  used_sweep_ids: number[];
  status: "estimate";
  sweeps: number;
  irradiance_span_wm2: number | null;
  temp_span_k: number | null;
  voc: {
    voc_stc_per_module_v: number;
    datasheet_voc_stc_v: number;
    beta_rel_pct_per_k: number | null;
    datasheet_beta_rel_pct_per_k: number;
    b1: number | null;
    b2: number | null;
    fit_rms_pct: number;
  } | null;
  resistance: {
    rs_ohm_per_module: number | null;
    kappa_ohm_per_k_per_module: number | null;
    pmax_spread_before_pct: number;
    pmax_spread_after_pct: number;
  } | null;
  /** IEC 60891 Procedure 3 between the lowest- and highest-irradiance sweeps; T follows from the interpolation */
  procedure_3: { g_wm2: number; t_c: number; extrapolated: boolean; p_max_w: number; from_irradiance_wm2: [number, number] } | null;
  reasons: string[];
  limits: { min_sweeps: number; min_irradiance_span_wm2: number; min_temp_span_k: number };
}

export interface IvSweepList {
  plant_id: number;
  sweeps: IvSweep[];
  meta: { source: "db" };
}
