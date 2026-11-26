"""Pydantic request and response schemas for the FastAPI backend."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    # Spares: may receive, count and edit the catalogue / locations (admins always may)
    store_keeper: bool = False
    # Growatt plants this user may see: null = every plant (admin), else the assigned ids.
    plant_ids: Optional[List[int]] = None


Role = Literal["admin", "engineer"]


class UserCreate(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    email: Optional[str] = Field(None, max_length=255)
    full_name: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=8, max_length=128)
    role: Role = "engineer"
    store_keeper: bool = False
    plant_ids: List[int] = Field(default_factory=list)


class UserUpdate(BaseModel):
    """Fields left out are not changed."""

    email: Optional[str] = Field(None, max_length=255)
    full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    password: Optional[str] = Field(None, min_length=8, max_length=128)
    role: Optional[Role] = None
    is_active: Optional[bool] = None
    store_keeper: Optional[bool] = None


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
    """As-built module count of one Growatt string input (`string_no` as in `vString{n}`).

    `removed: true` marks the input as removed from the String Layout editor (layout only: its
    readings and every analysis stay as they are); `modules` is then not needed and the other
    fields are ignored. Otherwise `modules` is required.
    """

    device_sn: str = Field(min_length=1, max_length=64)
    string_no: int = Field(ge=1, le=64)
    removed: bool = False
    modules: Optional[int] = Field(default=None, ge=1, le=60)
    module_wp: Optional[float] = Field(default=None, ge=50, le=1500)
    azimuth_deg: Optional[float] = Field(default=None, ge=0, le=360)
    tilt_deg: Optional[float] = Field(default=None, ge=0, le=90)

    @model_validator(mode="after")
    def _modules_unless_removed(self) -> "GrowattStringLayoutEntry":
        if not self.removed and self.modules is None:
            raise ValueError("modules is required unless removed is true")
        return self


class InverterInstalled(BaseModel):
    """Mark an inverter listed in Growatt as not installed on site (`installed: false`), or clear the mark."""

    installed: bool
    note: Optional[str] = Field(default=None, max_length=255)


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


class OmSuggestionAccept(BaseModel):
    """Accept a cleaning suggestion: the cleaning task to plan (defaults: the suggested day, the
    plant's crew-days, the entered cost)."""

    start_day: Optional[date] = None
    end_day: Optional[date] = None
    title: Optional[str] = Field(default=None, max_length=160)
    team_id: Optional[int] = None
    assignee_ids: List[int] = Field(default_factory=list, max_length=20)
    note: Optional[str] = Field(default=None, max_length=1500)


class OmPlantSettingsBody(BaseModel):
    """Per-plant planning figures as entered; null = not entered (never assumed)."""

    cleaning_crew_days: Optional[float] = Field(default=None, gt=0, le=60)
    cleaning_cost_thb: Optional[float] = Field(default=None, ge=0, le=10_000_000)


class PlantDocumentBody(BaseModel):
    """An admin's document link for one plant (https only)."""

    url: str = Field(..., min_length=8, max_length=1000)
    title: Optional[str] = Field(default=None, max_length=300)


class PlantDocumentRow(BaseModel):
    plant_id: int
    kind: str = Field(..., max_length=32)
    url: str = Field(..., max_length=1000)
    drive_id: Optional[str] = Field(default=None, max_length=128)
    title: Optional[str] = Field(default=None, max_length=300)
    revision: Optional[str] = Field(default=None, max_length=16)
    match_score: Optional[float] = Field(default=None, ge=0, le=1)


class PlantDocumentImport(BaseModel):
    rows: List[PlantDocumentRow] = Field(..., max_length=2000)


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


InputMethodName = Literal["hid", "camera", "photo", "manual"]


class SerialInput(BaseModel):
    """How a serial got into its field (docs/plans/barcode-scanning.md §9): a keyboard scanner
    (`hid`), the live camera, a photo, or typed (`manual`); `raw` = the code as read, for scans."""

    method: InputMethodName
    raw: Optional[str] = Field(default=None, max_length=512)


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
    # how `device_sn` was entered; kept with the claim while the SN stays (a changed SN without it = not recorded)
    device_sn_input: Optional[SerialInput] = None

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
    new_sn_input: Optional[SerialInput] = None


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
    # the instrument was opened by scanning its asset tag (null = picked in the app)
    input_method: Optional[InputMethodName] = None
    raw_scan: Optional[str] = Field(default=None, max_length=512)


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


# --------------------------------------------------------------------------- knowledge base (docs/plans/knowledge-base.md)

KbCategoryName = Literal["sop", "troubleshooting", "alarm_code", "equipment", "safety", "other"]
KB_BODY_MAX = 200_000
KB_TAGS_MAX = 20


def _kb_title(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = v.strip()
    if not 1 <= len(v) <= 200:
        raise ValueError("the title is 1–200 characters")
    return v


def _kb_tags(v: Optional[List[str]]) -> Optional[List[str]]:
    """Trimmed, each 1–40 characters, de-duplicated case-insensitively (first spelling kept), ≤ 20."""
    if v is None:
        return None
    out: List[str] = []
    seen: set[str] = set()
    for t in v:
        t = t.strip()
        if not 1 <= len(t) <= 40:
            raise ValueError("a tag is 1–40 characters")
        if t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    if len(out) > KB_TAGS_MAX:
        raise ValueError(f"at most {KB_TAGS_MAX} tags")
    return out


def _kb_note(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    return v.strip() or None


class KbArticleCreate(BaseModel):
    """A new article (always a draft, revision 1)."""

    title: str
    category: KbCategoryName
    tags: List[str] = Field(default_factory=list, max_length=200)
    body_md: str = Field(default="", max_length=KB_BODY_MAX)
    note: Optional[str] = Field(default=None, max_length=500)

    @field_validator("title")
    @classmethod
    def _title(cls, v: Optional[str]) -> Optional[str]:
        return _kb_title(v)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return _kb_tags(v)

    @field_validator("note")
    @classmethod
    def _note(cls, v: Optional[str]) -> Optional[str]:
        return _kb_note(v)


class KbArticlePatch(BaseModel):
    """Change an article saved at `base_version` (409 when it is stale). Fields left out or null
    stay unchanged; `note` is the change note of the new revision."""

    base_version: int = Field(ge=1)
    title: Optional[str] = None
    category: Optional[KbCategoryName] = None
    tags: Optional[List[str]] = Field(default=None, max_length=200)
    body_md: Optional[str] = Field(default=None, max_length=KB_BODY_MAX)
    note: Optional[str] = Field(default=None, max_length=500)

    @field_validator("title")
    @classmethod
    def _title(cls, v: Optional[str]) -> Optional[str]:
        return _kb_title(v)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return _kb_tags(v)

    @field_validator("note")
    @classmethod
    def _note(cls, v: Optional[str]) -> Optional[str]:
        return _kb_note(v)


class KbRestoreBody(BaseModel):
    base_version: int = Field(ge=1)


# Knowledge Base library: PDF documents (docs/plans/kb-documents.md)

KbDocTypeName = Literal[
    "manual", "datasheet", "sop", "work_instruction", "method_statement", "checklist",
    "report", "drawing", "certificate", "technical_note", "other",
]
KbDisciplineName = Literal["OM", "ENG", "INV", "MOD", "ELE", "INS", "SAF", "GEN"]
KbLanguageName = Literal["en", "th", "both"]


class KbDocLinkBody(BaseModel):
    """`fault_code` "<type>:<code>" (Error:203), `equipment` a model name, `plant` a plant id;
    `page` = the page it concerns (optional)."""

    target_type: Literal["fault_code", "equipment", "plant"]
    target_id: str = Field(min_length=1, max_length=64)
    page: Optional[int] = Field(default=None, ge=1, le=100_000)
    label: Optional[str] = Field(default=None, max_length=120)


class KbDocCreate(BaseModel):
    """Metadata of an upload (the `meta` form field, JSON). `number` is used for admins only;
    otherwise the next free `{TYPE}-{DISCIPLINE}-{SEQ:3}`."""

    doc_type: KbDocTypeName
    discipline: KbDisciplineName
    title_en: str = Field(default="", max_length=200)
    title_th: str = Field(default="", max_length=200)
    language: KbLanguageName = "en"
    tags: List[str] = Field(default_factory=list, max_length=200)
    general: bool = True
    number: Optional[str] = Field(default=None, max_length=40)
    label: Optional[str] = Field(default=None, max_length=40)
    change_note: Optional[str] = Field(default=None, max_length=500)
    links: List[KbDocLinkBody] = Field(default_factory=list, max_length=200)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return _kb_tags(v)


class KbDocPatch(BaseModel):
    """Metadata changes; null / left out = unchanged."""

    doc_type: Optional[KbDocTypeName] = None
    discipline: Optional[KbDisciplineName] = None
    title_en: Optional[str] = Field(default=None, max_length=200)
    title_th: Optional[str] = Field(default=None, max_length=200)
    language: Optional[KbLanguageName] = None
    tags: Optional[List[str]] = Field(default=None, max_length=200)
    general: Optional[bool] = None
    number: Optional[str] = Field(default=None, max_length=40)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        return _kb_tags(v)


class KbDocLinks(BaseModel):
    links: List[KbDocLinkBody] = Field(default_factory=list, max_length=200)


class KbDocWithdraw(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class KbDocSupersede(BaseModel):
    by_doc_id: Optional[int] = None
    note: Optional[str] = Field(default=None, max_length=500)


class KbDocPinBody(BaseModel):
    pinned: bool


# --------------------------------------------------------------------------- site visit route (docs/plans/site-visit-route.md)

HHMM_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class RouteStartPlant(BaseModel):
    """Start (and, for a round trip, end) at a plant the user may see."""

    kind: Literal["plant"]
    plant_id: int


class RouteStartPoint(BaseModel):
    """Start at a coordinate (team base, the phone's location)."""

    kind: Literal["point"]
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    label: Optional[str] = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def _not_zero(self) -> "RouteStartPoint":
        if self.lat == 0 and self.lon == 0:
            raise ValueError("0,0 is not a location")
        return self


class RouteStartOffice(BaseModel):
    """Start at a saved office (`/growatt/routes/offices`); unknown id = 404."""

    kind: Literal["office"]
    office_id: int


class RouteWindow(BaseModel):
    """Allowed arrival at the stop, plant-local "HH:MM"."""

    open: str = Field(pattern=HHMM_PATTERN)
    close: str = Field(pattern=HHMM_PATTERN)

    @model_validator(mode="after")
    def _order(self) -> "RouteWindow":
        if self.close < self.open:
            raise ValueError("window close is before open")
        return self


class RouteStopIn(BaseModel):
    plant_id: int
    service_min: float = Field(default=45, ge=0, le=720)  # time on site
    window: Optional[RouteWindow] = None


class RouteSolveRequest(BaseModel):
    """`POST /growatt/routes/solve`. 1–25 unique plants (more: 422 "split the day")."""

    start: Union[RouteStartPlant, RouteStartPoint, RouteStartOffice] = Field(discriminator="kind")
    end_mode: Literal["return", "last"] = "return"
    day: Optional[date] = None  # default today (Bangkok); used for sunset
    leave_at: str = Field(default="08:00", pattern=HHMM_PATTERN)
    latest_finish: str = Field(default="18:00", pattern=HHMM_PATTERN)
    keep_order: bool = False
    stops: List[RouteStopIn] = Field(min_length=1, max_length=200)

    @field_validator("stops")
    @classmethod
    def _unique(cls, v: List[RouteStopIn]) -> List[RouteStopIn]:
        ids = [s.plant_id for s in v]
        if len(set(ids)) != len(ids):
            raise ValueError("each plant may be a stop only once")
        return v


RouteLegSource = Literal["geoapify", "straight_line"]


class RouteWindowOut(BaseModel):
    open: str
    close: str


class RouteStopOut(BaseModel):
    """One stop in visit order. Times are plant-local; `*_min` = minutes after midnight, and a
    clock past midnight reads "HH:MM+1". Leg values are of the drive *to* this stop."""

    seq: int
    plant_id: int
    name: str
    lat: float
    lon: float
    service_min: float
    window: Optional[RouteWindowOut] = None
    eta: str
    eta_min: float
    wait_min: float  # waiting for the window to open
    etd: str
    etd_min: float
    late_min: float  # arrival after the window closed (0 = on time or no window)
    sunset: Optional[str] = None  # NOAA sunset at the plant (modelled), null if none that day
    after_sunset: Optional[bool] = None  # the work on site ends after sunset
    after_latest: bool  # the work on site ends after `latest_finish`
    leg_km: Optional[float] = None
    leg_min: Optional[float] = None
    leg_source: RouteLegSource


class RouteReturnLeg(BaseModel):
    leg_km: Optional[float] = None
    leg_min: Optional[float] = None
    eta: Optional[str] = None
    eta_min: Optional[float] = None
    after_latest: bool
    leg_source: RouteLegSource


class RouteTotals(BaseModel):
    stops: int
    drive_km: Optional[float] = None
    drive_min: Optional[float] = None
    wait_min: Optional[float] = None
    service_min: Optional[float] = None
    late_min: Optional[float] = None
    leave_at: str
    finish: Optional[str] = None
    finish_min: Optional[float] = None
    after_latest: bool


class RouteStartOut(BaseModel):
    kind: Literal["plant", "point", "office"]
    plant_id: Optional[int] = None
    office_id: Optional[int] = None  # set when kind = "office"; `name` is then the office's name
    name: str
    lat: float
    lon: float


class RouteEstimate(BaseModel):
    """How straight-line pairs were estimated (modelled)."""

    road_factor: float
    speed_kmh: float
    basis: str


class RouteGeometry(BaseModel):
    """GeoJSON MultiLineString, one line ([lon, lat] points) per leg in visit order (return leg
    last). Geoapify's road line when `geometry_source` is "geoapify", else straight segments."""

    type: Literal["MultiLineString"]
    coordinates: List[List[List[float]]]


class RouteSolveResponse(BaseModel):
    day: date
    end_mode: Literal["return", "last"]
    keep_order: bool
    start: RouteStartOut
    stops: List[RouteStopOut]
    return_leg: Optional[RouteReturnLeg] = None  # null when end_mode = "last"
    totals: RouteTotals
    latest_finish: str
    method: Literal["exact", "heuristic", "fixed", "trivial"]
    source: RouteLegSource  # the matrix the order was solved on
    fallback_reason: Optional[Literal["no_key", "error", "cooldown", "budget"]] = None
    fallback_detail: Optional[str] = None
    straight_line_pairs: int  # matrix pairs that are straight-line estimates
    estimate: Optional[RouteEstimate] = None  # set when any leg or pair is a straight-line estimate
    geometry: RouteGeometry
    geometry_source: RouteLegSource
    geometry_fallback_reason: Optional[Literal["no_key", "error", "cooldown", "budget"]] = None
    credits_used: int  # Geoapify credits this request spent (0 = cached / not asked)
    credits_today: int
    credits_daily_cap: int
    attribution: List[str]  # to show near the map whenever Geoapify data is used
    google_maps_links: List[str]  # each ≤ 3 waypoints; each starts where the previous ended
    labels: Dict[str, str]


# --------------------------------------------------------------------------- site visit route: offices (start points)


def _strip_text(v: Any) -> Any:
    return v.strip() if isinstance(v, str) else v


def _blank_to_none(v: Any) -> Any:
    v = _strip_text(v)
    return v or None


class RouteOfficeIn(BaseModel):
    """`POST /growatt/routes/offices` (admin). The first office is the default whatever
    `is_default` says; `is_default: true` makes it the default and clears the others."""

    name: str = Field(min_length=1, max_length=80)  # trimmed; unique case-insensitively (409)
    address: Optional[str] = Field(default=None, max_length=200)  # trimmed; "" = none
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    is_default: bool = False

    _name = field_validator("name", mode="before")(_strip_text)
    _address = field_validator("address", mode="before")(_blank_to_none)

    @model_validator(mode="after")
    def _not_zero(self) -> "RouteOfficeIn":
        if self.lat == 0 and self.lon == 0:
            raise ValueError("0,0 is not a location")
        return self


class RouteOfficePatch(BaseModel):
    """`PATCH /growatt/routes/offices/{id}` (admin): only the fields sent change. `address`
    null / "" clears it; `name`, `lat`, `lon` can't be null. `is_default: true` moves the default
    here; `false` on the default is refused (422: make another office the default instead)."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    address: Optional[str] = Field(default=None, max_length=200)
    lat: Optional[float] = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    lon: Optional[float] = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    is_default: Optional[bool] = None

    _name = field_validator("name", mode="before")(_strip_text)
    _address = field_validator("address", mode="before")(_blank_to_none)

    @model_validator(mode="after")
    def _no_nulls(self) -> "RouteOfficePatch":
        for f in ("name", "lat", "lon", "is_default"):
            if f in self.model_fields_set and getattr(self, f) is None:
                raise ValueError(f"{f} can't be null")
        return self


class RouteOfficeOut(BaseModel):
    id: int
    name: str
    address: Optional[str] = None
    lat: float
    lon: float
    is_default: bool
    created_by: Optional[int] = None  # user id
    created_at: datetime
    updated_at: datetime


class RouteOfficeList(BaseModel):
    """`GET /growatt/routes/offices`: default first, then by name."""

    offices: List[RouteOfficeOut]


# --------------------------------------------------------------------------- site visit route: stop candidates (phase 2)


RouteReasonKind = Literal["task", "issue", "alarm", "claim", "cleaning_due", "pm_due"]


class RouteCandidateReason(BaseModel):
    """Why a plant is worth visiting. `label` is short English (the UI translates it)."""

    kind: RouteReasonKind
    label: str
    detail: Optional[str] = None
    priority: Optional[str] = None  # issue tier "P1" … "P4", else null
    thb_per_day: Optional[float] = None  # estimated, issues only
    task_id: Optional[int] = None
    issue_id: Optional[int] = None
    claim_id: Optional[int] = None
    task_type: Optional[str] = None
    since: Optional[str] = None  # YYYY-MM-DD


class RouteCandidate(BaseModel):
    plant_id: int
    name: str
    city: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    has_location: bool  # false: no coordinates, or Growatt's 0,0 "not set"
    reasons: List[RouteCandidateReason]
    default_service_min: float  # default time on site; edit per stop
    service_basis: Literal["task_type", "cleaning_crew_days", "default"]
    rank: int  # 1 = most worth visiting


class RouteCandidatesResponse(BaseModel):
    day: str
    team_id: Optional[int] = None
    user_id: Optional[int] = None
    candidates: List[RouteCandidate]
    counts: Dict[str, int]  # plants per reason kind
    labels: Dict[str, str]


# --------------------------------------------------------------------------- field faults (docs/plans/defects.md)
# Values are checked by services/faults.py (one list of kinds, statuses, …); these models bound sizes and types.


class FaultMeterRef(BaseModel):
    datalogger_sn: str = Field(min_length=1, max_length=64)
    address: int


class FaultLinkBody(BaseModel):
    kind: str = Field(max_length=16)
    ref_id: Optional[int] = Field(None, ge=1)
    ref_key: Optional[str] = Field(None, max_length=200)


class FaultCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plant_id: int
    kind: str = Field(max_length=20)
    sub_kind: Optional[str] = Field(None, max_length=12)
    severity: str = Field(max_length=2)
    how_found: str = Field(max_length=16)
    symptom: str = Field(max_length=4000)
    cause: Optional[str] = Field(None, max_length=24)
    found_at: Optional[datetime] = None
    found_by: Optional[str] = Field(None, max_length=64)
    inverter_sn: Optional[str] = Field(None, max_length=64)
    site_device_id: Optional[int] = None
    meter: Optional[FaultMeterRef] = None
    stock_unit_id: Optional[int] = None
    position: Optional[Dict[str, Any]] = None
    serial: Optional[str] = Field(None, max_length=64)
    serial_input: Optional[InputMethodName] = None
    serial_raw: Optional[str] = Field(None, max_length=512)
    owner_user_id: Optional[int] = None
    next_action_day: Optional[date] = None
    evidence_urls: List[str] = Field(default_factory=list, max_length=20)
    reference: Optional[str] = Field(None, max_length=120)
    links: List[FaultLinkBody] = Field(default_factory=list, max_length=20)
    allow_duplicate: bool = False


class FaultPatch(BaseModel):
    """Only the fields sent change; null clears an optional one."""

    model_config = ConfigDict(extra="forbid")

    symptom: Optional[str] = Field(None, max_length=4000)
    cause: Optional[str] = Field(None, max_length=24)
    severity: Optional[str] = Field(None, max_length=2)
    owner_user_id: Optional[int] = None
    next_action_day: Optional[date] = None
    evidence_urls: Optional[List[str]] = Field(None, max_length=20)
    reference: Optional[str] = Field(None, max_length=120)
    position: Optional[Dict[str, Any]] = None
    sub_kind: Optional[str] = Field(None, max_length=12)
    found_at: Optional[datetime] = None


class FaultStatusChange(BaseModel):
    status: str = Field(max_length=12)
    waiting_reason: Optional[str] = Field(None, max_length=12)
    restored_at: Optional[datetime] = None
    note: Optional[str] = Field(None, max_length=4000)


class FaultDecision(BaseModel):
    decision: str = Field(max_length=16)
    reason: str = Field(min_length=1, max_length=4000)


class FaultNote(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
