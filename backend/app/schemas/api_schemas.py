"""Pydantic request and response schemas for the FastAPI backend."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    """Sign in with `username` (preferred) or `email`; either field accepts a username or an email."""

    username: Optional[str] = None
    email: Optional[str] = None
    password: str

    @property
    def identifier(self) -> str:
        return (self.username or self.email or "").strip().lower()


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: Optional[str] = None
    email: str
    full_name: str
    role: str
    is_active: bool


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class StringSpecSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: Optional[int] = None
    string_id: str
    inverter_id: str = "INV-01"
    mppt_id: str = "MPPT-1"
    modules_per_string: int = 18
    module_wp: float = 550.0
    voc_stc: float = 49.8
    vmp_stc: float = 41.9
    isc_stc: float = 13.98
    imp_stc: float = 13.13
    temp_coeff_pmax: float = -0.0035
    temp_coeff_voc: float = -0.0027
    temp_coeff_isc: float = 0.00048


class PlantCreateUpdate(BaseModel):
    name: str = "TC Roof Solar PV Plant"
    location: str = "Bangkok, Thailand"
    latitude: float = 13.7563
    longitude: float = 100.5018
    system_loss_factor: float = 0.04
    underperformance_threshold_pct: float = 10.0
    zero_current_threshold_a: float = 0.25
    min_irradiance_for_anomaly_wm2: float = 150.0
    target_pr_pct: float = 84.0
    tariff_thb_per_kwh: float = 4.20
    modules_per_string: int = 18
    module_wp: float = 550.0
    vmp_stc: float = 41.9
    imp_stc: float = 13.13


class PlantOut(PlantCreateUpdate):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime
    string_specs: List[StringSpecSchema] = Field(default_factory=list)


class DatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plant_id: int
    name: str
    source_type: str
    source_label: str
    row_count: int
    string_count: int
    start_timestamp: Optional[str] = None
    end_timestamp: Optional[str] = None
    status: str
    created_at: datetime


class DatasetDetailOut(DatasetOut):
    preview_rows: List[Dict[str, Any]] = Field(default_factory=list)
    latest_analysis_run_id: Optional[int] = None


class SimulateDatasetRequest(BaseModel):
    days: int = Field(default=7, ge=1, le=60)
    num_strings: int = Field(default=8, ge=2, le=32)
    interval_minutes: int = Field(default=15, ge=5, le=60)
    modules_per_string: Optional[int] = None
    module_wp: Optional[float] = None
    seed: int = 42


class FetchAPIDatasetRequest(BaseModel):
    provider: str = Field(
        default="huawei",
        description="One of: huawei | sungrow | generic_rest",
    )
    base_url: str = "https://intl.fusionsolar.huawei.com"
    xsrf_token: str = "demo-token-xxxx"
    dev_id: str = "INV-HUAWEI-SUN2000-01"
    appkey: str = "sungrow-app-key"
    token: str = "demo-token"
    ps_key: str = "1029384_1_1_1"
    start_time_str: str = "20261105000000"
    end_time_str: str = "20261111235900"
    http_method: str = "GET"
    headers: Dict[str, str] = Field(default_factory=dict)
    records_key: Optional[str] = "data"
    simulate_if_unreachable: bool = True


class AnalyzeDatasetRequest(BaseModel):
    target_pr_pct: Optional[float] = None
    tariff_thb_per_kwh: Optional[float] = None
    sync_cm_orders: bool = True


class AnalysisRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plant_id: int
    dataset_id: int
    target_pr_pct: float
    tariff_thb_per_kwh: float
    plant_kpis_json: Dict[str, Any]
    string_summary_json: List[Dict[str, Any]]
    daily_string_json: List[Dict[str, Any]]
    anomalies_json: List[Dict[str, Any]]
    daily_plant_json: List[Dict[str, Any]]
    monthly_plant_json: List[Dict[str, Any]]
    waterfall_json: List[Dict[str, Any]]
    opportunities_json: List[Dict[str, Any]]
    created_at: datetime


class PMTaskIn(BaseModel):
    plant_id: int = 1
    pm_id: str
    asset_category: str
    task_description: str
    frequency: str
    standard_ref: str
    last_completed: str
    next_due: str
    assigned_subcontractor: str
    compliance_status: str
    estimated_pr_recovery_pct: float = 0.5


class PMTaskOut(PMTaskIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    updated_at: datetime


class CMWorkOrderIn(BaseModel):
    plant_id: int = 1
    analysis_run_id: Optional[int] = None
    wo_number: str
    created_date: str
    asset_id: str
    equipment_type: str
    priority: str
    fault_symptom: str
    troubleshooting_checklist: str
    ptw_required: str
    status: str = "Open - Dispatched"


class CMWorkOrderOut(CMWorkOrderIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    updated_at: datetime


class RCARecordIn(BaseModel):
    plant_id: int = 1
    rca_id: Optional[str] = None
    incident_date: Optional[str] = None
    equipment_category: str
    asset_id: str
    failure_mode: str
    downtime_hours: float = 2.5
    energy_loss_kwh: float = 120.0
    why_1: str
    why_2: str
    why_3: str
    why_4: str
    why_5_root_cause: str
    fishbone_category: str
    capa_corrective_action: str
    capa_preventive_action: str
    rca_status: str = "Open - CAPA Assigned"


class RCARecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plant_id: int
    rca_id: str
    incident_date: str
    equipment_category: str
    asset_id: str
    failure_mode: str
    downtime_hours: float
    energy_loss_kwh: float
    why_1: str
    why_2: str
    why_3: str
    why_4: str
    why_5_root_cause: str
    fishbone_category: str
    capa_corrective_action: str
    capa_preventive_action: str
    rca_status: str
    updated_at: datetime


class SubcontractorAuditIn(BaseModel):
    plant_id: int = 1
    contractor_id: str
    subcontractor_name: str
    scope_of_work: str
    active_work_orders: int = 1
    workmanship_score_pct: float = 92.0
    engineering_std_compliance_pct: float = 95.0
    safety_she_compliance_pct: float = 98.0
    on_time_sla_pct: float = 92.0
    open_ncrs: int = 0
    torque_seal_verified: str = "Pass"
    calibrated_tools_cert: str = "Valid"
    overall_rating: str = "Approved - Grade A"


class SubcontractorAuditOut(SubcontractorAuditIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    updated_at: datetime


class PQTestEvaluateRequest(BaseModel):
    plant_id: int = 1
    voltage_thd_pct: float = 2.10
    current_thd_pct: float = 3.40
    power_factor: float = 0.992
    voltage_unbalance_pct: float = 0.85
    flicker_plt: float = 0.42
    grid_frequency_hz: float = 50.02
    dc_injection_pct: float = 0.18
    min_riso_mohm: float = 42.5


class PQTestOut(PQTestEvaluateRequest):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pq_results_json: List[Dict[str, Any]]
    commissioning_results_json: List[Dict[str, Any]]
    overall_compliant: bool
    created_at: datetime


class PTWPermitIn(BaseModel):
    plant_id: int = 1
    ptw_number: str
    issue_date: str
    work_activity: str
    high_risk_permits: str
    loto_padlock_id: str
    arc_flash_ppe: str
    gas_heat_index_check: str
    safety_supervisor: str
    status: str = "Active - Approved"


class PTWPermitOut(PTWPermitIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    updated_at: datetime
