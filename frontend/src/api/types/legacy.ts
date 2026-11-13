/** API types: Original analysis tools: plants, datasets, analysis runs, maintenance (PM / CM / RCA) and SH&E permits. */

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
