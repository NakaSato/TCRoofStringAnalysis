"""The local `plants` tables of the upload / analysis / maintenance pages (admin only, no link to
Growatt plants)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.db.models.base import _utcnow


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
