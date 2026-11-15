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
    # from `plant/details` (fleet job, every growatt_sync.DETAILS_REFRESH_DAYS)
    timezone: Mapped[Optional[str]] = mapped_column(String(32))  # e.g. "GMT+7"
    address: Mapped[Optional[str]] = mapped_column(String(255))
    growatt_inverter_count: Mapped[Optional[int]] = mapped_column(Integer)  # as entered in Growatt, not counted
    growatt_datalogger_count: Mapped[Optional[int]] = mapped_column(Integer)
    details_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
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
    # active power limit read from the inverter (`new-api/readPower`, daytime `power_limits` job);
    # max_data_info answers its activeRate as 0, so this is the one that counts when set
    power_limit_pct: Mapped[Optional[float]] = mapped_column(Float)
    power_limit_read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # from `new-api/queryDeviceInfoParam` (fleet job, every growatt_sync.PARAM_REFRESH_DAYS)
    device_model: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. "MAX 80KTL3 LV"
    datalogger_model: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. "ShineMaster"
    rated_power_w: Mapped[Optional[float]] = mapped_column(Float)  # nominal power as Growatt lists the model
    param_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    history_synced_until: Mapped[Optional[datetime]] = mapped_column(DateTime)  # latest reading stored
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    plant: Mapped[GrowattPlant] = relationship(back_populates="inverters")

    @property
    def active_limit_pct(self) -> Optional[float]:
        """Configured active power limit, % of rated: `readPower` when read, else `max_data_info`'s
        activeRate (usually unknown); None = unknown, never assumed 100."""
        return self.power_limit_pct if self.power_limit_pct is not None else self.active_rate_pct


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


class GrowattPlantEnergyDay(Base):
    """Growatt's own daily energy of a plant (`plant/energy`), finished days only (today's value
    is realtime). A cross-check on the energy integrated from stored records, and a figure for
    days without records. Kept indefinitely (`retention` skips it)."""

    __tablename__ = "growatt_plant_energy_days"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattInverterEnergyDay(Base):
    """Growatt's own daily energy of one inverter (`device/inverter/day_energy`), finished days
    only. Kept indefinitely (`retention` skips it)."""

    __tablename__ = "growatt_inverter_energy_days"
    __table_args__ = (Index("ix_growatt_inv_energy_plant_day", "plant_id", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattPlantPower(Base):
    """Growatt's own 5-minute AC power curve of a plant (`plant/power`; timestamp plant-local),
    finished days only. Slots Growatt answers as null are not stored. Deleted with the raw
    readings after HISTORY_RETENTION_DAYS."""

    __tablename__ = "growatt_plant_power"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    power_w: Mapped[float] = mapped_column(Float, nullable=False)


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
    string of the inverter has one. Optional `azimuth_deg` and `tilt_deg` group peers by
    orientation and tilt so East and West strings are not compared against each other.
    No FK on device_sn: the registry outlives inverter re-syncs.
    """

    __tablename__ = "growatt_string_layouts"

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    modules: Mapped[int] = mapped_column(Integer, nullable=False)
    module_wp: Mapped[Optional[float]] = mapped_column(Float)  # null = not recorded
    azimuth_deg: Mapped[Optional[float]] = mapped_column(Float)  # 0..360; null = default/same group
    tilt_deg: Mapped[Optional[float]] = mapped_column(Float)  # 0..90; null = default/same group
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattStringDaily(Base):
    """One wired string's day, computed from stored 5-min readings by `services/growatt_daily.py`
    (decision rules, docs/plans/decision-rules.md §3.1). Kept indefinitely (`retention` skips it).

    Ratios compare the string with the median current of its matched peer group (same orientation,
    tilt and module count on the inverter) in the same 5-min slot, only in **gated** slots
    (inverter normal, median ≥ 3 A, not clipped or limited, irradiance ≥ 400 W/m² with low
    irradiance variability where the plant's sensor reads). Fewer than `MIN_GATED_SLOTS` gated
    slots = no verdict: the ratio columns stay null.
    """

    __tablename__ = "growatt_string_daily"
    __table_args__ = (Index("ix_growatt_str_daily_plant_day", "plant_id", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    gated_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ratio_median: Mapped[Optional[float]] = mapped_column(Float)
    low_min: Mapped[Optional[int]] = mapped_column(Integer)  # gated minutes with ratio < 0.80
    severe_min: Mapped[Optional[int]] = mapped_column(Integer)  # gated minutes with ratio < 0.60
    open_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # ≤ 0.3 A while median ≥ 2 A
    v_ratio_median: Mapped[Optional[float]] = mapped_column(Float)  # per module; null without a full layout
    voltage_sensing: Mapped[Optional[str]] = mapped_column(String(16))  # "per_string" | "shared_mppt"
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    lost_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # estimated, vs the peer median
    lost_on_peak_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # part of it in the tariff's on-peak hours
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattInverterDaily(Base):
    """One inverter's day: minutes per state over the plant's daylight, energy, specific yield
    vs the plant's other inverters, BOS/inverter loss (Ya − Yf) and estimated lost energy by cause
    (`services/growatt_daily.py`, docs/plans/decision-rules.md §3.2). Kept indefinitely
    (`retention` skips it).

    Lost kWh is **estimated** from the specific yield of the plant's producing inverters in the
    same slots; null where no other inverter of the plant produced (nothing to compare with).
    """

    __tablename__ = "growatt_inverter_daily"
    __table_args__ = (Index("ix_growatt_inv_daily_plant_day", "plant_id", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    daylight_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    producing_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    fault_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    off_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    standby_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # record, no power, no fault, peers produce
    limited_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    no_data_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)  # last eac_today of the day
    dc_energy_kwh: Mapped[Optional[float]] = mapped_column(Float)  # integrated ppv_w over filtered slots
    kwp: Mapped[Optional[float]] = mapped_column(Float)  # DC capacity used for the specific yield
    ya_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # array yield Ya = E_DC / P0
    yf_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # final yield Yf = E_AC / P0
    ya_minus_yf: Mapped[Optional[float]] = mapped_column(Float)  # BOS & inverter conversion loss (Ya − Yf)
    yf_vs_median_pct: Mapped[Optional[float]] = mapped_column(Float)  # vs median of the plant's other inverters
    plant_kwp_share_pct: Mapped[Optional[float]] = mapped_column(Float)  # this inverter's share of the plant kWp
    lost_fault_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_off_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_standby_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_no_data_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # only what eac_today did not recover
    # on-peak part (tariff on-peak hours at compute time) of fault + off + standby, and of no data
    lost_down_on_peak_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_no_data_on_peak_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattPlantDaily(Base):
    """One plant's daily time-series performance KPIs over quality-filtered 5-min slots
    (POA 200–1200 W/m², with stale-value, clipping and curtailment masks applied):
    raw PR, temperature-corrected PR', EPI (measured ÷ modelled energy), and Ya − Yf.
    Kept indefinitely (`retention` skips it).
    """

    __tablename__ = "growatt_plant_daily"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    capacity_kwp: Mapped[Optional[float]] = mapped_column(Float)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    dc_energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    modelled_energy_kwh: Mapped[Optional[float]] = mapped_column(Float)  # modelled from filtered POA & T_mod
    yr_h: Mapped[Optional[float]] = mapped_column(Float)  # reference yield Yr (kWh/m²)
    ya_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # array yield Ya = E_DC / P0
    yf_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # final yield Yf = E_AC / P0
    ya_minus_yf: Mapped[Optional[float]] = mapped_column(Float)  # Ya − Yf (inverter + BOS loss)
    pr_pct: Mapped[Optional[float]] = mapped_column(Float)  # raw IEC 61724-1 PR (reporting only)
    pr_temp_corrected_pct: Mapped[Optional[float]] = mapped_column(Float)  # PR' = PR / [1 + γ(T_mod − 25 °C)]
    epi: Mapped[Optional[float]] = mapped_column(Float)  # E_measured / E_modelled over filtered slots
    irradiance_weighted_tmod_c: Mapped[Optional[float]] = mapped_column(Float)
    filtered_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stale_masked_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clipped_masked_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    curtailed_masked_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattIvSweep(Base):
    """Measured I-V curve sweep (string or module level) from a field tracer or inverter smart scan,
    translated to STC via IEC 60891 Procedure 1 and classified against fault signatures.
    """

    __tablename__ = "growatt_iv_sweeps"
    __table_args__ = (Index("ix_growatt_iv_sweeps_plant_sn", "plant_id", "device_sn", "string_no"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    module_no: Mapped[Optional[int]] = mapped_column(Integer)
    level: Mapped[str] = mapped_column(String(16), nullable=False, default="string")  # "string" | "module"
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="upload")  # "upload" | "inverter_scan"
    swept_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # naive plant-local time
    irradiance_wm2: Mapped[float] = mapped_column(Float, nullable=False)
    module_temp_c: Mapped[float] = mapped_column(Float, nullable=False)
    irradiance_change_pct: Mapped[Optional[float]] = mapped_column(Float)
    reference_cell_tech: Mapped[Optional[str]] = mapped_column(String(64))
    # optional measurement conditions (null = not recorded with the sweep)
    temp_change_k_per_min: Mapped[Optional[float]] = mapped_column(Float)  # module T change, minute before
    sweep_time_ms: Mapped[Optional[float]] = mapped_column(Float)
    cell_technology: Mapped[Optional[str]] = mapped_column(String(16))  # perc | topcon | hjt | ibc
    irradiance_uncertainty_pct: Mapped[Optional[float]] = mapped_column(Float)  # sensor calibration, k = 2
    reverse_pmax_w: Mapped[Optional[float]] = mapped_column(Float)  # measured Pmax of the opposite-direction sweep
    sensor_misalignment_deg: Mapped[Optional[float]] = mapped_column(Float)  # irradiance sensor vs array plane
    modules: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    quality_gate_passed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    gate_reasons_json: Mapped[Optional[Any]] = mapped_column(JSON)
    iec60891_json: Mapped[Optional[Any]] = mapped_column(JSON)
    measured_json: Mapped[Optional[Any]] = mapped_column(JSON)
    stc_json: Mapped[Optional[Any]] = mapped_column(JSON)
    classification_json: Mapped[Optional[Any]] = mapped_column(JSON)
    p_max_stc_w: Mapped[float] = mapped_column(Float, nullable=False)
    expected_pmax_stc_w: Mapped[float] = mapped_column(Float, nullable=False)
    pmax_dev_pct: Mapped[float] = mapped_column(Float, nullable=False)
    signature: Mapped[str] = mapped_column(String(48), nullable=False)
    is_finding: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ticket_recommended: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ir_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    timeseries_trend_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    warranty_claim_ready: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class GrowattIssue(Base):
    """One problem found by a decision rule on one entity (plant inverter or string), from the day
    it first fired until it closes (docs/plans/decision-rules.md §4.2, `services/growatt_issues.py`).

    At most one open issue per (plant, inverter, string, rule): `status` open / acknowledged. It
    closes itself (`close_reason = auto`) when its rule has a verdict and does not fire for 2 days
    in a row; engineers resolve or dismiss it. `daily` holds each day it fired: {day: {kwh, thb}},
    estimated. `shadow` issues (rule still being calibrated) are shown to admins in Rule review only.
    """

    __tablename__ = "growatt_issues"
    __table_args__ = (
        Index("ix_growatt_issues_plant_status", "plant_id", "status"),
        Index("ix_growatt_issues_key", "plant_id", "device_sn", "string_no", "rule"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    rule: Mapped[str] = mapped_column(String(8), nullable=False)
    tier: Mapped[str] = mapped_column(String(8), nullable=False)
    safety: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    parent_id: Mapped[Optional[int]] = mapped_column(Integer)  # the inverter's open issue, for string issues
    opened_day: Mapped[date] = mapped_column(Date, nullable=False)
    last_seen_day: Mapped[date] = mapped_column(Date, nullable=False)
    days_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    lost_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # mean of the last 3 days it fired
    thb_per_day_est: Mapped[Optional[float]] = mapped_column(Float)  # mean of the last 3 days it fired
    lost_kwh_total_est: Mapped[Optional[float]] = mapped_column(Float)
    thb_total_est: Mapped[Optional[float]] = mapped_column(Float)
    evidence: Mapped[Optional[dict]] = mapped_column(JSON)  # the last day's finding evidence
    daily: Mapped[Optional[dict]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    ack_by: Mapped[Optional[str]] = mapped_column(String(64))
    ack_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    note: Mapped[Optional[str]] = mapped_column(Text)
    feedback: Mapped[Optional[str]] = mapped_column(String(16))  # confirmed / false_alarm
    shadow: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[Optional[str]] = mapped_column(String(64))
    close_reason: Mapped[Optional[str]] = mapped_column(String(16))  # auto / resolved / dismissed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class SiteEvent(Base):
    """Work done on a Growatt plant, entered by an engineer or admin (docs/plans/decision-rules.md
    §6, `services/site_events.py`): cleaning, repair, module or inverter replaced, IR flight,
    curtailment. Optional inverter / string. `day` (to `end_day` when it took several days) is
    the plant-local date of the work. `cost_thb` is what was paid, null when not entered.
    `issue_id` links the decision-rule issue the work answered. Kept indefinitely: the cleaning
    steps and the soiling rate are measured from these dates.
    """

    __tablename__ = "site_events"
    __table_args__ = (Index("ix_site_events_plant_day", "plant_id", "day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(24), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    end_day: Mapped[Optional[date]] = mapped_column(Date)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    cost_thb: Mapped[Optional[float]] = mapped_column(Float)
    issue_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
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


class PwaCheckSlot(Base):
    """One PWA report check slot of one plant, frozen when it was first fully built.

    Built from stored, source-timestamped history only (services/check_slots.py), never from
    realtime values. Later publishes reuse it, so a slot the sheet has already shown never
    changes, even when late uploads would change a recomputation. Pruned with the raw history.
    """

    __tablename__ = "pwa_check_slots"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    hour: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)  # 9 / 13 / 17
    slot_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    built_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


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


class AiUsage(Base):
    """Token use and cost of one AI Assistant turn (one user question), for the monthly budget and
    the per-user daily limit.

    Bookkeeping only: no prompt, answer or tool result is stored (the conversation lives in the
    browser), so no measurement ever lands here. `ts` is UTC.
    """

    __tablename__ = "ai_usage"
    __table_args__ = (Index("ix_ai_usage_ts", "ts"), Index("ix_ai_usage_user_ts", "user_id", "ts"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    rounds: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    tools: Mapped[Optional[Any]] = mapped_column(JSON)  # tool names only, in call order
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # ok | refused | error | timeout
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer)
