"""Pydantic request and response schemas for the FastAPI backend."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    # Growatt plants this user may see: null = every plant (admin), else the assigned ids.
    plant_ids: Optional[List[int]] = None


Role = Literal["admin", "engineer"]


class UserCreate(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    email: Optional[str] = Field(None, max_length=255)
    full_name: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=8, max_length=128)
    role: Role = "engineer"
    plant_ids: List[int] = Field(default_factory=list)


class UserUpdate(BaseModel):
    """Fields left out are not changed."""

    email: Optional[str] = Field(None, max_length=255)
    full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    password: Optional[str] = Field(None, min_length=8, max_length=128)
    role: Optional[Role] = None
    is_active: Optional[bool] = None


class PlantAssignment(BaseModel):
    plant_ids: List[int]


class PushTokenIn(BaseModel):
    """This browser's FCM registration token (`/push/tokens`)."""

    token: str = Field(min_length=20, max_length=512)
    label: Optional[str] = Field(default=None, max_length=120)


class PushTokenRemove(BaseModel):
    token: str = Field(min_length=20, max_length=512)


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
    # Off by default: an unreachable endpoint is an error unless the caller asks for the sandbox
    # simulator, whose data is then stored as source_type "simulated".
    simulate_if_unreachable: bool = False


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


class GrowattStringLayoutEntry(BaseModel):
    """As-built module count of one Growatt string input (`string_no` as in `vString{n}`)."""

    device_sn: str = Field(min_length=1, max_length=64)
    string_no: int = Field(ge=1, le=64)
    modules: int = Field(ge=1, le=60)
    module_wp: Optional[float] = Field(default=None, ge=50, le=1500)
    azimuth_deg: Optional[float] = Field(default=None, ge=0, le=360)
    tilt_deg: Optional[float] = Field(default=None, ge=0, le=90)


class FleetModule(BaseModel):
    """PV module used across the fleet (STC datasheet values). Unknown values stay null."""

    manufacturer: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=64)
    wp: float = Field(ge=50, le=1500)
    vmp_stc: Optional[float] = Field(default=None, gt=0, le=200)
    imp_stc: Optional[float] = Field(default=None, gt=0, le=50)
    voc_stc: Optional[float] = Field(default=None, gt=0, le=200)
    isc_stc: Optional[float] = Field(default=None, gt=0, le=50)
    efficiency_pct: Optional[float] = Field(default=None, gt=0, le=40)
    temp_coeff_pmax_pct: Optional[float] = Field(default=None, ge=-2, le=2)
    temp_coeff_voc_pct: Optional[float] = Field(default=None, ge=-2, le=2)
    temp_coeff_isc_pct: Optional[float] = Field(default=None, ge=-2, le=2)
    bifacial_factor_pct: Optional[float] = Field(default=None, ge=0, le=100)
    rs_ohm: Optional[float] = Field(default=0.22, gt=0, le=10)
    kappa_ohm_per_k: Optional[float] = Field(default=0.0012, ge=0, le=1)
    first_year_lid_pct: Optional[float] = Field(default=1.0, ge=0, le=10)
    annual_degradation_pct: Optional[float] = Field(default=0.45, ge=0, le=5)
    # I-V analysis: cell technology (sweep-time gate) and measured IEC 60891 Procedure 2 irradiance factors
    cell_technology: Optional[str] = Field(default=None, pattern="^(perc|topcon|hjt|ibc)$")
    p2_b1: Optional[float] = Field(default=None, ge=0, le=0.5)
    p2_b2: Optional[float] = Field(default=None, ge=-0.5, le=0.5)
    datasheet_url: Optional[str] = Field(default=None, max_length=500)


class IvPointIn(BaseModel):
    v: float = Field(ge=0, le=2000)
    i: float = Field(ge=0, le=100)


class IvSweepCreate(BaseModel):
    """Upload or ingest one measured I-V curve sweep (string or module level) with its measurement conditions."""

    device_sn: Optional[str] = Field(default=None, max_length=64)
    string_no: Optional[int] = Field(default=None, ge=1, le=64)
    module_no: Optional[int] = Field(default=None, ge=1, le=60)
    level: str = Field(default="string", pattern="^(string|module)$")
    source: str = Field(default="upload", pattern="^(upload|inverter_scan)$")
    swept_at: str = Field(min_length=10, max_length=40, description="Plant-local timestamp YYYY-MM-DD HH:MM:SS or ISO")
    irradiance_wm2: float = Field(gt=0, le=1500, description="Measured POA irradiance G₁ (W/m²)")
    module_temp_c: float = Field(ge=-40, le=120, description="Measured back-of-module temperature T₁ (°C)")
    irradiance_change_pct: Optional[float] = Field(default=None, ge=0, le=100, description="Irradiance change during sweep (%)")
    reference_cell_tech: Optional[str] = Field(default=None, max_length=64)
    temp_change_k_per_min: Optional[float] = Field(
        default=None, ge=0, le=50, description="Module temperature change over the minute before the sweep (K)"
    )
    sweep_time_ms: Optional[float] = Field(default=None, gt=0, le=60000, description="Duration of the sweep (ms)")
    cell_technology: Optional[str] = Field(default=None, pattern="^(perc|topcon|hjt|ibc)$")
    irradiance_uncertainty_pct: Optional[float] = Field(
        default=None, gt=0, le=20, description="Calibration uncertainty of the irradiance sensor (%, k = 2)"
    )
    reverse_pmax_w: Optional[float] = Field(
        default=None, gt=0, le=100000, description="Measured Pmax of the opposite-direction sweep of the same string (W)"
    )
    sensor_misalignment_deg: Optional[float] = Field(
        default=None, ge=0, le=90, description="Angle between the irradiance sensor and the array plane (°)"
    )
    modules: Optional[int] = Field(default=None, ge=1, le=60)
    dead_band_pct: float = Field(default=5.0, ge=1.0, le=10.0)
    near_negative_pole: bool = False
    low_irradiance_worse: bool = False
    ir_confirmed: bool = False
    points: Optional[List[IvPointIn]] = None
    csv_text: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=1000)


class IvSweepPatch(BaseModel):
    """Confirm or clear IR agreement / note on a stored I-V sweep for the two-source module-test rule."""

    ir_confirmed: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=1000)


class PlantRate(BaseModel):
    """Flat price for one plant (e.g. its PPA), used instead of the TOU rates."""

    thb_per_kwh: float = Field(gt=0, le=50)
    basis: Optional[str] = Field(default=None, max_length=32)


class Tariff(BaseModel):
    """Electricity tariff that prices estimated lost energy (decision rules) and revenue."""

    on_peak_thb: float = Field(gt=0, le=50)
    off_peak_thb: float = Field(gt=0, le=50)
    ft_thb: float = Field(ge=-5, le=5)
    on_peak_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    on_peak_start: str = Field(default="09:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    on_peak_end: str = Field(default="22:00", pattern=r"^([01]\d|2[0-4]):[0-5]\d$")
    holidays: List[str] = Field(default_factory=list)
    valid_from: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    plant_rates: Dict[str, PlantRate] = Field(default_factory=dict)

    @field_validator("on_peak_days")
    @classmethod
    def _days(cls, v: List[int]) -> List[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("on_peak_days are 0 (Monday) … 6 (Sunday)")
        return sorted(set(v))

    @field_validator("holidays")
    @classmethod
    def _holidays(cls, v: List[str]) -> List[str]:
        from datetime import date as _date

        try:
            return sorted({_date.fromisoformat(d.strip()).isoformat() for d in v if d.strip()})
        except ValueError as exc:
            raise ValueError(f"holidays must be YYYY-MM-DD dates ({exc})") from exc

    @field_validator("plant_rates")
    @classmethod
    def _plant_ids(cls, v: Dict[str, "PlantRate"]) -> Dict[str, "PlantRate"]:
        if any(not k.isdigit() for k in v):
            raise ValueError("plant_rates keys are plant ids")
        return v


class IssueAction(BaseModel):
    """Acknowledge / resolve / dismiss / reopen an issue, or only update its note or feedback."""

    action: Literal["acknowledge", "resolve", "dismiss", "reopen", "note"]
    note: Optional[str] = Field(default=None, max_length=2000)
    feedback: Optional[Literal["confirmed", "false_alarm"]] = None


SiteEventType = Literal[
    "cleaning", "repair", "module_replaced", "inverter_replaced", "ir_flight",
    "pm_inspection", "inverter_service", "site_visit", "curtailment", "other",
]
# Calendar Team task types: the Site log types except curtailment (not planned work)
OmTaskType = Literal[
    "cleaning", "repair", "module_replaced", "inverter_replaced", "ir_flight",
    "pm_inspection", "inverter_service", "site_visit", "other",
]
OmTaskStatus = Literal["planned", "in_progress", "skipped", "cancelled"]


class OmTaskCreate(BaseModel):
    """Plan a task on a plant (plant-local dates, may be in the future)."""

    task_type: OmTaskType
    title: Optional[str] = Field(default=None, max_length=160)
    start_day: date
    end_day: Optional[date] = None
    device_sn: Optional[str] = Field(default=None, max_length=64)
    string_no: Optional[int] = Field(default=None, ge=1, le=64)
    team_id: Optional[int] = None
    assignee_ids: List[int] = Field(default_factory=list, max_length=20)
    issue_id: Optional[int] = None
    est_cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)
    note: Optional[str] = Field(default=None, max_length=2000)


class OmTaskPatch(BaseModel):
    """Change a task: only the fields sent; null clears an optional one. `done` has its own route."""

    task_type: Optional[OmTaskType] = None
    title: Optional[str] = Field(default=None, max_length=160)
    start_day: Optional[date] = None
    end_day: Optional[date] = None
    device_sn: Optional[str] = Field(default=None, max_length=64)
    string_no: Optional[int] = Field(default=None, ge=1, le=64)
    status: Optional[OmTaskStatus] = None
    team_id: Optional[int] = None
    assignee_ids: Optional[List[int]] = Field(default=None, max_length=20)
    issue_id: Optional[int] = None
    est_cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)
    note: Optional[str] = Field(default=None, max_length=2000)
    comment: Optional[str] = Field(default=None, max_length=2000)

    def changes(self) -> Dict[str, Any]:
        out = self.model_dump(exclude_unset=True)
        out.pop("comment", None)
        for k in ("task_type", "start_day", "status", "assignee_ids"):  # required: null = unchanged
            if out.get(k, 0) is None:
                out.pop(k)
        return out


class OmTaskDone(BaseModel):
    """Mark a task done: writes the Site log event. Dates default to the planned ones, capped at today."""

    day: Optional[date] = None
    end_day: Optional[date] = None
    cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)
    note: Optional[str] = Field(default=None, max_length=2000)
    close_issue: bool = False


class OmTeamBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    active: bool = True
    member_ids: List[int] = Field(default_factory=list, max_length=50)


class OmTeamPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    active: Optional[bool] = None
    member_ids: Optional[List[int]] = Field(default=None, max_length=50)


class OmPlanBody(BaseModel):
    """A recurring plan: every `every_n` weeks / months from `starts_on`, optional season months
    (may wrap the year, e.g. 11 … 4) and weekday (0 = Monday; null = first working day)."""

    name: str = Field(min_length=1, max_length=120)
    task_type: OmTaskType
    every_n: int = Field(ge=1, le=104)
    unit: Literal["week", "month"]
    season_from_month: Optional[int] = Field(default=None, ge=1, le=12)
    season_to_month: Optional[int] = Field(default=None, ge=1, le=12)
    weekday: Optional[int] = Field(default=None, ge=0, le=6)
    duration_days: int = Field(default=1, ge=1, le=31)
    default_team_id: Optional[int] = None
    assignee_ids: List[int] = Field(default_factory=list, max_length=20)
    plant_ids: List[int] = Field(min_length=1, max_length=300)
    starts_on: date
    ends_on: Optional[date] = None
    active: bool = True
    note: Optional[str] = Field(default=None, max_length=2000)


class OmPlanPatch(BaseModel):
    """Only the fields sent; null clears an optional one (season, weekday, team, end, note)."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    task_type: Optional[OmTaskType] = None
    every_n: Optional[int] = Field(default=None, ge=1, le=104)
    unit: Optional[Literal["week", "month"]] = None
    season_from_month: Optional[int] = Field(default=None, ge=1, le=12)
    season_to_month: Optional[int] = Field(default=None, ge=1, le=12)
    weekday: Optional[int] = Field(default=None, ge=0, le=6)
    duration_days: Optional[int] = Field(default=None, ge=1, le=31)
    default_team_id: Optional[int] = None
    assignee_ids: Optional[List[int]] = Field(default=None, max_length=20)
    plant_ids: Optional[List[int]] = Field(default=None, min_length=1, max_length=300)
    starts_on: Optional[date] = None
    ends_on: Optional[date] = None
    active: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=2000)


class OmPlantSettingsBody(BaseModel):
    """Per-plant planning figures as entered; null = not entered (never assumed)."""

    cleaning_crew_days: Optional[float] = Field(default=None, gt=0, le=60)
    cleaning_cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)


class OmRoundPreview(BaseModel):
    plant_ids: List[int] = Field(min_length=1, max_length=300)
    start_day: date
    crews: int = Field(default=1, ge=1, le=20)
    include_saturday: bool = False
    group_by: Literal["city", "phase", "none"] = "city"


class OmRoundItem(BaseModel):
    plant_id: int
    start_day: date
    end_day: Optional[date] = None
    crew: Optional[int] = Field(default=None, ge=1, le=20)


class OmRoundSave(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)
    team_id: Optional[int] = None
    assignee_ids: List[int] = Field(default_factory=list, max_length=20)
    note: Optional[str] = Field(default=None, max_length=2000)
    items: List[OmRoundItem] = Field(min_length=1, max_length=300)


class SiteEventCreate(BaseModel):
    """Record work done on a plant (plant-local dates). `close_issue` resolves `issue_id` as confirmed."""

    event_type: SiteEventType
    day: date
    end_day: Optional[date] = None
    device_sn: Optional[str] = Field(default=None, max_length=64)
    string_no: Optional[int] = Field(default=None, ge=1, le=64)
    cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)
    issue_id: Optional[int] = None
    close_issue: bool = False
    note: Optional[str] = Field(default=None, max_length=2000)


class SiteEventPatch(BaseModel):
    """Change an event: only the fields sent are changed; null clears an optional one."""

    event_type: Optional[SiteEventType] = None
    day: Optional[date] = None
    end_day: Optional[date] = None
    device_sn: Optional[str] = Field(default=None, max_length=64)
    string_no: Optional[int] = Field(default=None, ge=1, le=64)
    cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)
    issue_id: Optional[int] = None
    close_issue: bool = False
    note: Optional[str] = Field(default=None, max_length=2000)

    def changes(self) -> Dict[str, Any]:
        out = self.model_dump(exclude_unset=True)
        for k in ("event_type", "day"):  # required on the event: null means "unchanged"
            if out.get(k, 0) is None:
                out.pop(k)
        return out


# --------------------------------------------------------------------------- claims (docs/plans/claims.md)

ClaimType = Literal["inverter_warranty", "module_warranty", "equipment_warranty", "insurance", "workmanship"]
ClaimCause = Literal[
    "lightning", "storm_wind", "flood", "fire", "theft", "animal",
    "manufacturing_defect", "degradation", "installation", "unknown", "other",
]
ClaimStatusName = Literal[
    "draft", "submitted", "under_review", "info_requested", "approved", "rejected", "fulfilled", "closed", "withdrawn",
]
ClaimLinkKind = Literal["issue", "iv_sweep", "site_log"]


class ClaimLinkBody(BaseModel):
    kind: ClaimLinkKind
    ref_id: int = Field(ge=1)


class ClaimPatch(BaseModel):
    """Change a claim: only the fields sent change; null clears an optional one (type, cause,
    plant and counterparty are required on the claim, so null there means "unchanged")."""

    type: Optional[ClaimType] = None
    cause: Optional[ClaimCause] = None
    plant_id: Optional[int] = None
    device_sn: Optional[str] = Field(default=None, max_length=64)
    string_nos: Optional[List[int]] = Field(default=None, max_length=64)
    module_serials: Optional[List[str]] = Field(default=None, max_length=200)
    device_label: Optional[str] = Field(default=None, max_length=120)
    counterparty: Optional[str] = Field(default=None, max_length=120)
    counterparty_ref: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=4000)
    incident_day: Optional[date] = None
    discovered_day: Optional[date] = None
    warranty_end_day: Optional[date] = None

    @field_validator("string_nos")
    @classmethod
    def _string_nos(cls, v: Optional[List[int]]) -> Optional[List[int]]:
        if v is not None and any(n < 1 or n > 64 for n in v):
            raise ValueError("string numbers are 1–64")
        return v

    @field_validator("module_serials")
    @classmethod
    def _serials(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is not None and any(len(s) > 64 for s in v):
            raise ValueError("a module serial is at most 64 characters")
        return v

    def changes(self) -> Dict[str, Any]:
        """The fields sent, under the service's names (`type` → `claim_type`); lists null → empty."""
        out = self.model_dump(exclude_unset=True)
        if "type" in out:
            out["claim_type"] = out.pop("type")
        for k in ("string_nos", "module_serials"):
            if k in out and out[k] is None:
                out[k] = []
        return out


class ClaimCreate(ClaimPatch):
    """A new claim (always a draft). `links` are linked at once (records of the same plant)."""

    type: ClaimType  # type: ignore[assignment]
    cause: ClaimCause  # type: ignore[assignment]
    plant_id: int  # type: ignore[assignment]
    counterparty: str = Field(min_length=1, max_length=120)  # type: ignore[assignment]
    links: List[ClaimLinkBody] = Field(default_factory=list, max_length=50)


class ClaimStatusChange(BaseModel):
    status: ClaimStatusName
    note: str = Field(min_length=1, max_length=2000)
    next_action_day: Optional[date] = None
    new_sn: Optional[str] = Field(default=None, max_length=64)


class ClaimEventCreate(BaseModel):
    kind: Literal["note", "message", "shipment"]
    day: Optional[date] = None
    direction: Optional[Literal["out", "in"]] = None
    summary: str = Field(min_length=1, max_length=2000)
    carrier: Optional[str] = Field(default=None, max_length=64)
    tracking_no: Optional[str] = Field(default=None, max_length=64)
    sn: Optional[str] = Field(default=None, max_length=64)


class ClaimEvidenceSet(BaseModel):
    done: bool
    url: Optional[str] = Field(default=None, max_length=1000)
    note: Optional[str] = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------- measuring tools (docs/plans/measuring-tools.md)

InstrumentCategoryName = Literal[
    "drone", "thermal_camera", "iv_tracer", "insulation_tester", "clamp_meter",
    "multimeter", "irradiance_meter", "earth_tester", "power_analyser", "other",
]
InstrumentStatusName = Literal["available", "checked_out", "at_calibration", "repair", "retired"]
InstrumentDueKind = Literal["calibration", "caat", "nbtc", "insurance", "pilot_licence", "other"]
SpecValue = Union[int, float, str, None]


class InstrumentPatch(BaseModel):
    """Change an instrument: only the fields sent change; null clears an optional one (asset tag,
    name and category are required, so null there means "unchanged"). `specs` replaces the whole
    object. `status` may not be `checked_out` (that is the check-out call)."""

    asset_tag: Optional[str] = Field(default=None, max_length=32)
    name: Optional[str] = Field(default=None, max_length=120)
    category: Optional[InstrumentCategoryName] = None
    make: Optional[str] = Field(default=None, max_length=64)
    model: Optional[str] = Field(default=None, max_length=64)
    serial_no: Optional[str] = Field(default=None, max_length=64)
    specs: Optional[Dict[str, SpecValue]] = Field(default=None, max_length=30)
    calibration_interval_months: Optional[int] = Field(default=None, ge=1, le=120)
    purchase_day: Optional[date] = None
    cost_thb: Optional[float] = Field(default=None, ge=0)
    note: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[InstrumentStatusName] = None

    @field_validator("specs")
    @classmethod
    def _specs(cls, v: Optional[Dict[str, SpecValue]]) -> Optional[Dict[str, SpecValue]]:
        if v is None:
            return v
        for k, val in v.items():
            if not k.strip() or len(k) > 32:
                raise ValueError("a spec key is 1–32 characters")
            if isinstance(val, str) and len(val) > 120:
                raise ValueError("a spec value is at most 120 characters")
        return v


class InstrumentCreate(InstrumentPatch):
    asset_tag: str = Field(min_length=1, max_length=32)  # type: ignore[assignment]
    name: str = Field(min_length=1, max_length=120)  # type: ignore[assignment]
    category: InstrumentCategoryName  # type: ignore[assignment]


class InstrumentCheckoutBody(BaseModel):
    holder_user_id: Optional[int] = None
    plant_id: Optional[int] = None
    due_back: date
    note: Optional[str] = Field(default=None, max_length=2000)
    ack_warnings: List[str] = Field(default_factory=list, max_length=10)


class InstrumentReturnBody(BaseModel):
    condition: Literal["ok", "damaged", "lost"]
    note: Optional[str] = Field(default=None, max_length=2000)


class InstrumentDueBody(BaseModel):
    kind: InstrumentDueKind
    day: date
    next_due: Optional[date] = None
    number: Optional[str] = Field(default=None, max_length=64)
    issuer: Optional[str] = Field(default=None, max_length=120)
    cost_thb: Optional[float] = Field(default=None, ge=0)
    url: Optional[str] = Field(default=None, max_length=1000)
    note: Optional[str] = Field(default=None, max_length=2000)
