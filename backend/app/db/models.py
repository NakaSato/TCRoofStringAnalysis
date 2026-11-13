"""SQLAlchemy 2.0 ORM models for the TC Roof Solar PV Full-Stack Application."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, List, Optional
from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    JSON,
    SmallInteger,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """User account for authentication and role-based access control."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Login name, stored lowercase. Nullable only for rows created before usernames existed;
    # `ensure_seeded` fills those in from the email's local part.
    username: Mapped[Optional[str]] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False, default="O&M Lead Engineer")
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="engineer")  # admin | engineer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class Plant(Base):
    """Solar PV plant configuration and default module/financial parameters."""

    __tablename__ = "plants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="TC Roof Solar PV Plant")
    location: Mapped[str] = mapped_column(String(255), nullable=False, default="Bangkok, Thailand")
    latitude: Mapped[float] = mapped_column(Float, nullable=False, default=13.7563)
    longitude: Mapped[float] = mapped_column(Float, nullable=False, default=100.5018)
    system_loss_factor: Mapped[float] = mapped_column(Float, nullable=False, default=0.04)
    underperformance_threshold_pct: Mapped[float] = mapped_column(Float, nullable=False, default=10.0)
    zero_current_threshold_a: Mapped[float] = mapped_column(Float, nullable=False, default=0.25)
    min_irradiance_for_anomaly_wm2: Mapped[float] = mapped_column(Float, nullable=False, default=150.0)
    target_pr_pct: Mapped[float] = mapped_column(Float, nullable=False, default=84.0)
    tariff_thb_per_kwh: Mapped[float] = mapped_column(Float, nullable=False, default=4.20)
    modules_per_string: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
    module_wp: Mapped[float] = mapped_column(Float, nullable=False, default=550.0)
    vmp_stc: Mapped[float] = mapped_column(Float, nullable=False, default=41.9)
    imp_stc: Mapped[float] = mapped_column(Float, nullable=False, default=13.13)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    string_specs: Mapped[List[StringSpecModel]] = relationship(
        "StringSpecModel", back_populates="plant", cascade="all, delete-orphan"
    )
    datasets: Mapped[List[Dataset]] = relationship(
        "Dataset", back_populates="plant", cascade="all, delete-orphan"
    )


class StringSpecModel(Base):
    """Per-string electrical specification within a Plant."""

    __tablename__ = "string_specs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    string_id: Mapped[str] = mapped_column(String(64), nullable=False)
    inverter_id: Mapped[str] = mapped_column(String(64), nullable=False, default="INV-01")
    mppt_id: Mapped[str] = mapped_column(String(64), nullable=False, default="MPPT-1")
    modules_per_string: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
    module_wp: Mapped[float] = mapped_column(Float, nullable=False, default=550.0)
    voc_stc: Mapped[float] = mapped_column(Float, nullable=False, default=49.8)
    vmp_stc: Mapped[float] = mapped_column(Float, nullable=False, default=41.9)
    isc_stc: Mapped[float] = mapped_column(Float, nullable=False, default=13.98)
    imp_stc: Mapped[float] = mapped_column(Float, nullable=False, default=13.13)
    temp_coeff_pmax: Mapped[float] = mapped_column(Float, nullable=False, default=-0.0035)
    temp_coeff_voc: Mapped[float] = mapped_column(Float, nullable=False, default=-0.0027)
    temp_coeff_isc: Mapped[float] = mapped_column(Float, nullable=False, default=0.00048)

    plant: Mapped[Plant] = relationship("Plant", back_populates="string_specs")


class Dataset(Base):
    """Ingested or simulated telemetry dataset for a plant."""

    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_type: Mapped[str] = mapped_column(String(64), nullable=False)  # simulated | upload | huawei_api | sungrow_api | generic_rest
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    string_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    start_timestamp: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    end_timestamp: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="ready")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    plant: Mapped[Plant] = relationship("Plant", back_populates="datasets")
    telemetry_rows: Mapped[List[TelemetryRow]] = relationship(
        "TelemetryRow", back_populates="dataset", cascade="all, delete-orphan"
    )
    analysis_runs: Mapped[List[AnalysisRun]] = relationship(
        "AnalysisRun", back_populates="dataset", cascade="all, delete-orphan"
    )


class TelemetryRow(Base):
    """Canonical string telemetry record."""

    __tablename__ = "telemetry"
    __table_args__ = (
        Index("ix_telemetry_dataset_ts", "dataset_id", "timestamp"),
        Index("ix_telemetry_dataset_str", "dataset_id", "string_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dataset_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False
    )
    timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    inverter_id: Mapped[str] = mapped_column(String(64), nullable=False)
    mppt_id: Mapped[str] = mapped_column(String(64), nullable=False)
    string_id: Mapped[str] = mapped_column(String(64), nullable=False)
    voltage_v: Mapped[float] = mapped_column(Float, nullable=False)
    current_a: Mapped[float] = mapped_column(Float, nullable=False)
    power_w: Mapped[float] = mapped_column(Float, nullable=False)
    irradiance_wm2: Mapped[float] = mapped_column(Float, nullable=False)
    module_temp_c: Mapped[float] = mapped_column(Float, nullable=False)
    ambient_temp_c: Mapped[float] = mapped_column(Float, nullable=False)

    dataset: Mapped[Dataset] = relationship("Dataset", back_populates="telemetry_rows")


class AnalysisRun(Base):
    """Persisted PV string analysis and period generation evaluation run."""

    __tablename__ = "analysis_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    dataset_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_pr_pct: Mapped[float] = mapped_column(Float, nullable=False, default=84.0)
    tariff_thb_per_kwh: Mapped[float] = mapped_column(Float, nullable=False, default=4.20)
    plant_kpis_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    string_summary_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    daily_string_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    anomalies_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    daily_plant_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    monthly_plant_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    waterfall_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    opportunities_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    dataset: Mapped[Dataset] = relationship("Dataset", back_populates="analysis_runs")


class PMTask(Base):
    """Preventive Maintenance (PM) task row."""

    __tablename__ = "pm_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    pm_id: Mapped[str] = mapped_column(String(64), nullable=False)
    asset_category: Mapped[str] = mapped_column(String(128), nullable=False)
    task_description: Mapped[str] = mapped_column(Text, nullable=False)
    frequency: Mapped[str] = mapped_column(String(64), nullable=False)
    standard_ref: Mapped[str] = mapped_column(String(128), nullable=False)
    last_completed: Mapped[str] = mapped_column(String(32), nullable=False)
    next_due: Mapped[str] = mapped_column(String(32), nullable=False)
    assigned_subcontractor: Mapped[str] = mapped_column(String(255), nullable=False)
    compliance_status: Mapped[str] = mapped_column(String(64), nullable=False)
    estimated_pr_recovery_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class CMWorkOrder(Base):
    """Corrective Maintenance (CM) work order row."""

    __tablename__ = "cm_work_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    analysis_run_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("analysis_runs.id", ondelete="SET NULL"), nullable=True
    )
    wo_number: Mapped[str] = mapped_column(String(64), nullable=False)
    created_date: Mapped[str] = mapped_column(String(32), nullable=False)
    asset_id: Mapped[str] = mapped_column(String(128), nullable=False)
    equipment_type: Mapped[str] = mapped_column(String(128), nullable=False)
    priority: Mapped[str] = mapped_column(String(64), nullable=False)
    fault_symptom: Mapped[str] = mapped_column(Text, nullable=False)
    troubleshooting_checklist: Mapped[str] = mapped_column(Text, nullable=False)
    ptw_required: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="Open - Dispatched")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class RCARecord(Base):
    """Root Cause Analysis (RCA) 5-Why & Fishbone record."""

    __tablename__ = "rca_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rca_id: Mapped[str] = mapped_column(String(64), nullable=False)
    incident_date: Mapped[str] = mapped_column(String(32), nullable=False)
    equipment_category: Mapped[str] = mapped_column(String(128), nullable=False)
    asset_id: Mapped[str] = mapped_column(String(128), nullable=False)
    failure_mode: Mapped[str] = mapped_column(Text, nullable=False)
    downtime_hours: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    energy_loss_kwh: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    why_1: Mapped[str] = mapped_column(Text, nullable=False)
    why_2: Mapped[str] = mapped_column(Text, nullable=False)
    why_3: Mapped[str] = mapped_column(Text, nullable=False)
    why_4: Mapped[str] = mapped_column(Text, nullable=False)
    why_5_root_cause: Mapped[str] = mapped_column(Text, nullable=False)
    fishbone_category: Mapped[str] = mapped_column(String(128), nullable=False)
    capa_corrective_action: Mapped[str] = mapped_column(Text, nullable=False)
    capa_preventive_action: Mapped[str] = mapped_column(Text, nullable=False)
    rca_status: Mapped[str] = mapped_column(String(64), nullable=False, default="Open - CAPA Assigned")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class PTWPermit(Base):
    """Safety, Health & Environment (SH&E) Permit-to-Work (PTW) & LOTO register row."""

    __tablename__ = "ptw_permits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ptw_number: Mapped[str] = mapped_column(String(64), nullable=False)
    issue_date: Mapped[str] = mapped_column(String(32), nullable=False)
    work_activity: Mapped[str] = mapped_column(Text, nullable=False)
    high_risk_permits: Mapped[str] = mapped_column(String(255), nullable=False)
    loto_padlock_id: Mapped[str] = mapped_column(String(128), nullable=False)
    arc_flash_ppe: Mapped[str] = mapped_column(String(255), nullable=False)
    gas_heat_index_check: Mapped[str] = mapped_column(String(255), nullable=False)
    safety_supervisor: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="Active - Approved")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


# ---------------------------------------------------------------------------
# Growatt OpenAPI mirror (synced by app.services.growatt_sync)
# ---------------------------------------------------------------------------


class GrowattPlant(Base):
    """Plant as listed by Growatt `plant/list` (keyed by Growatt plant_id).

    Static registry fields only. Current power, lifetime energy and status are realtime
    and come from `/growatt/live/*` (memory only); they are never stored.
    """

    __tablename__ = "growatt_plants"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    # Project phase = the Growatt account (token) that lists this plant. NULL until the
    # fleet job has seen it under a phase token; treated as the first configured phase.
    phase: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    city: Mapped[Optional[str]] = mapped_column(String(255))
    country: Mapped[Optional[str]] = mapped_column(String(100))
    latitude: Mapped[Optional[float]] = mapped_column(Float)
    longitude: Mapped[Optional[float]] = mapped_column(Float)
    peak_power_kwp: Mapped[Optional[float]] = mapped_column(Float)
    create_date: Mapped[Optional[str]] = mapped_column(String(32))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    inverters: Mapped[List["GrowattInverter"]] = relationship(back_populates="plant", cascade="all, delete-orphan")


class GrowattInverter(Base):
    """Inverter from Growatt `device/list` (MAX type 1/4 entries merged by serial).

    Static registry fields only; status / lost / last upload time are realtime (`/growatt/live/*`).
    """

    __tablename__ = "growatt_inverters"

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), index=True, nullable=False)
    datalogger_sn: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[Optional[str]] = mapped_column(String(64))
    device_types: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. "inverter,max"
    # from `device/max/max_data_info` (refreshed by the fleet job, see growatt_sync.INFO_REFRESH_DAYS)
    alias: Mapped[Optional[str]] = mapped_column(String(64))  # name set in Growatt, e.g. "INVERTER 7"
    nominal_power_w: Mapped[Optional[float]] = mapped_column(Float)  # rated AC power (`normalPower`)
    fw_version: Mapped[Optional[str]] = mapped_column(String(32))
    inner_version: Mapped[Optional[str]] = mapped_column(String(32))
    # inverter settings from the same call (configured values, not measurements)
    active_rate_pct: Mapped[Optional[float]] = mapped_column(Float)  # active power limit; < 100 = curtailed
    reactive_rate_pct: Mapped[Optional[float]] = mapped_column(Float)
    pf_setting: Mapped[Optional[float]] = mapped_column(Float)
    pf_model: Mapped[Optional[int]] = mapped_column(Integer)
    export_limit: Mapped[Optional[int]] = mapped_column(Integer)
    export_limit_rate_pct: Mapped[Optional[float]] = mapped_column(Float)
    on_off: Mapped[Optional[int]] = mapped_column(Integer)  # 1 = on, 0 = switched off
    info_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    history_synced_until: Mapped[Optional[datetime]] = mapped_column(DateTime)  # latest reading stored
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    plant: Mapped[GrowattPlant] = relationship(back_populates="inverters")


class GrowattInverterReading(Base):
    """Inverter-level 5-minute record from `device/max/max_data` (timestamp is plant-local time)."""

    __tablename__ = "growatt_inverter_readings"
    # fleet-wide time filters (newest record, one day's energy) would otherwise scan the table
    __table_args__ = (Index("ix_growatt_inv_ts", "timestamp"),)

    device_sn: Mapped[str] = mapped_column(String(64), ForeignKey("growatt_inverters.device_sn", ondelete="CASCADE"), primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    status: Mapped[Optional[int]] = mapped_column(Integer)
    pac_w: Mapped[Optional[float]] = mapped_column(Float)
    ppv_w: Mapped[Optional[float]] = mapped_column(Float)
    eac_today_kwh: Mapped[Optional[float]] = mapped_column(Float)
    eac_total_kwh: Mapped[Optional[float]] = mapped_column(Float)
    temperature_c: Mapped[Optional[float]] = mapped_column(Float)
    fac_hz: Mapped[Optional[float]] = mapped_column(Float)
    mppt_json: Mapped[Optional[Any]] = mapped_column(JSON)  # [{"mppt": n, "v": .., "i": .., "p": ..}]


class GrowattStringReading(Base):
    """Per-string 5-minute record (`vString{n}` / `currentString{n}`), stored only while the inverter produces."""

    __tablename__ = "growatt_string_readings"
    __table_args__ = (Index("ix_growatt_str_ts", "timestamp"),)

    device_sn: Mapped[str] = mapped_column(String(64), ForeignKey("growatt_inverters.device_sn", ondelete="CASCADE"), primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    mppt_no: Mapped[int] = mapped_column(Integer, nullable=False)
    voltage_v: Mapped[float] = mapped_column(Float, nullable=False)
    current_a: Mapped[float] = mapped_column(Float, nullable=False)
    power_w: Mapped[float] = mapped_column(Float, nullable=False)


class GrowattEnvSensor(Base):
    """Weather (environmental) sensor on a plant's datalogger, from `device/env/env_list`.

    Keyed by (datalogger SN, bus address): Growatt lists every such sensor with `device_sn`
    "env", so the serial is useless as a key. Online state / last upload are realtime and
    are not stored.
    """

    __tablename__ = "growatt_env_sensors"

    datalogger_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    address: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), index=True, nullable=False)
    device_name: Mapped[Optional[str]] = mapped_column(String(64))
    history_synced_until: Mapped[Optional[datetime]] = mapped_column(DateTime)  # latest reading stored
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattEnvReading(Base):
    """5-minute weather-sensor record from `device/env/env_data` (timestamp is plant-local time).

    Values as reported; a probe the sensor is not fitted with reads 0 (nulled per day when read).
    """

    __tablename__ = "growatt_env_readings"
    __table_args__ = (
        ForeignKeyConstraint(
            ["datalogger_sn", "address"],
            ["growatt_env_sensors.datalogger_sn", "growatt_env_sensors.address"],
            ondelete="CASCADE",
        ),
        Index("ix_growatt_env_ts", "timestamp"),
    )

    datalogger_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    address: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    irradiance_wm2: Mapped[Optional[float]] = mapped_column(Float)
    ambient_temp_c: Mapped[Optional[float]] = mapped_column(Float)
    module_temp_c: Mapped[Optional[float]] = mapped_column(Float)
    humidity_pct: Mapped[Optional[float]] = mapped_column(Float)
    wind_speed_ms: Mapped[Optional[float]] = mapped_column(Float)
    wind_dir_deg: Mapped[Optional[float]] = mapped_column(Float)


class GrowattAlarm(Base):
    """Alarm / fault record from `device/max/alarm_data` (one inverter-day per call), synced by the
    worker's `alarms` jobs.

    Source-timestamped history (Growatt's own start/end times, plant-local, naive), not a
    realtime value. The rows of one inverter-day are replaced as a whole on each successful read,
    so an alarm's `end_time` appears once Growatt closes it. `day` is the plant-local day queried.
    """

    __tablename__ = "growatt_alarms"
    __table_args__ = (Index("ix_growatt_alarms_day_plant", "day", "plant_id"), Index("ix_growatt_alarms_sn_day", "device_sn", "day"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_sn: Mapped[str] = mapped_column(String(64), nullable=False)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[Optional[datetime]] = mapped_column(DateTime)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime)  # null = still open (as Growatt reports it)
    alarm_code: Mapped[Optional[str]] = mapped_column(String(32))
    alarm_message: Mapped[Optional[str]] = mapped_column(String(255))
    fault_type: Mapped[Optional[str]] = mapped_column(String(32))  # "Warning" / "Fault" …
    status: Mapped[Optional[int]] = mapped_column(Integer)


class GrowattAlarmSync(Base):
    """When each inverter's alarm log for a plant-local day was last read successfully (UTC).

    No row = never read: the UI shows that inverter-day as not synced, never as "no alarms".
    """

    __tablename__ = "growatt_alarm_syncs"
    __table_args__ = (Index("ix_growatt_alarm_syncs_day", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    alarm_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class GrowattStringLayout(Base):
    """As-built module count per Growatt string input, entered by an engineer.

    Growatt does not report how many modules each string has. Strings on one inverter can
    differ (e.g. 16 vs 18 modules), so peer comparisons normalize by this count when every
    string of the inverter has one. No FK on device_sn: the registry outlives inverter re-syncs.
    """

    __tablename__ = "growatt_string_layouts"

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    modules: Mapped[int] = mapped_column(Integer, nullable=False)
    module_wp: Mapped[Optional[float]] = mapped_column(Float)  # null = not recorded
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class UserPlantAssignment(Base):
    """Growatt plants an admin assigned to an engineer.

    Admins see every plant and have no rows here. Engineers see and work on only the
    plants listed for them. No FK on plant_id: an assignment survives a plant briefly
    missing from the registry, and a plant that never comes back is simply not listed.
    """

    __tablename__ = "user_plant_assignments"

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False, index=True)
    assigned_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class AppSetting(Base):
    """Fleet-wide settings as JSON, one row per key (e.g. `fleet_module`).

    Source of truth for global data the operator enters; mirrored to Firestore `config/{key}`
    by the publish job (and right after an edit).
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=False)
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class PublishedDoc(Base):
    """Last version of each summary document published to a sink (`json` / `firestore`).

    Lets the daily job skip documents whose content has not changed, so re-runs cost no
    Firestore writes. Realtime data is never published — only daily summaries and registry.
    """

    __tablename__ = "published_docs"

    sink: Mapped[str] = mapped_column(String(32), primary_key=True)
    path: Mapped[str] = mapped_column(String(255), primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    written_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class PublishWriteCount(Base):
    """Document writes per sink per quota day (Firestore quotas reset at midnight US/Pacific)."""

    __tablename__ = "publish_write_counts"

    sink: Mapped[str] = mapped_column(String(32), primary_key=True)
    quota_day: Mapped[str] = mapped_column(String(10), primary_key=True)  # YYYY-MM-DD, Pacific
    writes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class GoogleWeatherHourly(Base):
    """Hourly weather from the Google Maps Weather API (`history/hours`), per grid cell.

    Modelled by Google for the cell's coordinates, not measured at the plant. Plants share a
    cell when their coordinates round to the same `GOOGLE_WEATHER_CELL_DEG` grid point (see
    `services/google_weather.cell_of`). `hour` is the plant-local (Bangkok) start of the hour,
    naive like the Growatt reading tables. Only history is stored; current conditions stay in memory.
    """

    __tablename__ = "google_weather_hourly"
    __table_args__ = (Index("ix_google_weather_hour", "hour"),)

    cell_key: Mapped[str] = mapped_column(String(32), primary_key=True)  # "13.75,100.50"
    hour: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    condition: Mapped[Optional[str]] = mapped_column(String(48))
    is_daytime: Mapped[Optional[bool]] = mapped_column(Boolean)
    temp_c: Mapped[Optional[float]] = mapped_column(Float)
    feels_like_c: Mapped[Optional[float]] = mapped_column(Float)
    dew_point_c: Mapped[Optional[float]] = mapped_column(Float)
    humidity_pct: Mapped[Optional[float]] = mapped_column(Float)
    cloud_cover_pct: Mapped[Optional[float]] = mapped_column(Float)
    uv_index: Mapped[Optional[float]] = mapped_column(Float)
    precip_mm: Mapped[Optional[float]] = mapped_column(Float)
    precip_prob_pct: Mapped[Optional[float]] = mapped_column(Float)
    thunder_prob_pct: Mapped[Optional[float]] = mapped_column(Float)
    wind_speed_ms: Mapped[Optional[float]] = mapped_column(Float)
    wind_gust_ms: Mapped[Optional[float]] = mapped_column(Float)
    wind_dir_deg: Mapped[Optional[float]] = mapped_column(Float)
    pressure_hpa: Mapped[Optional[float]] = mapped_column(Float)
    visibility_km: Mapped[Optional[float]] = mapped_column(Float)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class ExternalApiCallCount(Base):
    """Billable calls to an external API per plant-local day (worker and API share the count)."""

    __tablename__ = "external_api_call_counts"

    api: Mapped[str] = mapped_column(String(32), primary_key=True)  # google_weather_history | google_weather_current
    day: Mapped[str] = mapped_column(String(10), primary_key=True)  # YYYY-MM-DD, plant-local
    calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class SyncRun(Base):
    """One run of a background job (Growatt sync / daily publish), written by the worker or the API.

    Also serves as the job lock: a `running` row younger than the stale timeout blocks a
    second run of the same job.
    """

    __tablename__ = "sync_runs"
    __table_args__ = (Index("ix_sync_runs_job_started", "job", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job: Mapped[str] = mapped_column(String(32), nullable=False)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default="schedule")  # schedule | api | cli
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")  # running | ok | partial | failed
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    detail_json: Mapped[Optional[Any]] = mapped_column(JSON)
    error: Mapped[Optional[str]] = mapped_column(Text)


class AppLog(Base):
    """One Python log record of the API or the worker (System → Logs), redacted before insert.

    Bookkeeping, not measurements: no live values go in messages. `ts` is UTC. `run_id` links a
    job run (`sync_runs.id`) without a foreign key, because runs and logs are pruned separately.
    """

    __tablename__ = "app_logs"
    __table_args__ = (
        Index("ix_app_logs_ts", "ts"),
        Index("ix_app_logs_level_ts", "level_no", "ts"),
        Index("ix_app_logs_run_id", "run_id"),
        Index("ix_app_logs_source_ts", "source", "ts"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    level: Mapped[str] = mapped_column(String(8), nullable=False)
    level_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # api | worker | cli
    host: Mapped[Optional[str]] = mapped_column(String(64))
    logger: Mapped[str] = mapped_column(String(128), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    exc_text: Mapped[Optional[str]] = mapped_column(Text)
    run_id: Mapped[Optional[int]] = mapped_column(Integer)
    job: Mapped[Optional[str]] = mapped_column(String(32))
    request_id: Mapped[Optional[str]] = mapped_column(String(32))
    extra_json: Mapped[Optional[Any]] = mapped_column(JSON)
