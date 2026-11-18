"""SQLAlchemy database engine, session factory, and declarative base."""

from __future__ import annotations

from typing import Generator
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy ORM models."""


def build_engine(database_url: str | None = None):
    url = database_url or settings.database_url
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    eng = create_engine(url, connect_args=connect_args, future=True)
    if url.startswith("sqlite"):
        @event.listens_for(eng, "connect")
        def _set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    return eng


# Columns added to existing tables after release: (table, column, DDL type). `create_all` only
# creates missing tables, so these are added in place (SQLite and Postgres). The Alembic
# migrations add the same columns and skip them when already present.
# (table, column, DDL type, index DDL or None)
_ADDED_COLUMNS = [
    ("growatt_string_layouts", "azimuth_deg", "FLOAT", None),
    ("growatt_string_layouts", "tilt_deg", "FLOAT", None),
    ("growatt_string_daily", "lost_on_peak_kwh_est", "FLOAT", None),
    ("growatt_string_daily", "voltage_sensing", "VARCHAR(16)", None),
    ("growatt_inverter_daily", "dc_energy_kwh", "FLOAT", None),
    ("growatt_inverter_daily", "ya_kwh_kwp", "FLOAT", None),
    ("growatt_inverter_daily", "ya_minus_yf", "FLOAT", None),
    ("growatt_inverter_daily", "lost_down_on_peak_kwh_est", "FLOAT", None),
    ("growatt_inverter_daily", "lost_no_data_on_peak_kwh_est", "FLOAT", None),
    ("growatt_plants", "phase", "INTEGER", "CREATE INDEX IF NOT EXISTS ix_growatt_plants_phase ON growatt_plants (phase)"),
    ("users", "username", "VARCHAR(64)", "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)"),
    ("growatt_inverters", "alias", "VARCHAR(64)", None),
    ("growatt_inverters", "nominal_power_w", "FLOAT", None),
    ("growatt_inverters", "fw_version", "VARCHAR(32)", None),
    ("growatt_inverters", "inner_version", "VARCHAR(32)", None),
    ("growatt_inverters", "info_synced_at", "TIMESTAMP WITH TIME ZONE", None),
    ("growatt_inverters", "active_rate_pct", "FLOAT", None),
    ("growatt_inverters", "reactive_rate_pct", "FLOAT", None),
    ("growatt_inverters", "pf_setting", "FLOAT", None),
    ("growatt_inverters", "pf_model", "INTEGER", None),
    ("growatt_inverters", "export_limit", "INTEGER", None),
    ("growatt_inverters", "export_limit_rate_pct", "FLOAT", None),
    ("growatt_inverters", "on_off", "INTEGER", None),
    ("growatt_inverters", "power_limit_pct", "FLOAT", None),
    ("growatt_inverters", "power_limit_read_at", "TIMESTAMP WITH TIME ZONE", None),
    ("growatt_inverters", "device_model", "VARCHAR(64)", None),
    ("growatt_iv_sweeps", "temp_change_k_per_min", "FLOAT", None),
    ("growatt_plant_daily", "sensor_stale_slots", "INTEGER", None),
    ("growatt_plant_daily", "sensor_high_slots", "INTEGER", None),
    ("growatt_plant_daily", "sensor_midday_wm2", "FLOAT", None),
    ("growatt_plant_daily", "sensor_midday_slots", "INTEGER", None),
    ("growatt_plant_daily", "cloud_midday_pct", "FLOAT", None),
    ("growatt_plant_daily", "sensor_neighbour_ratio", "FLOAT", None),
    ("growatt_plant_daily", "sensor_neighbours", "INTEGER", None),
    ("growatt_iv_sweeps", "sweep_time_ms", "FLOAT", None),
    ("growatt_iv_sweeps", "cell_technology", "VARCHAR(16)", None),
    ("growatt_iv_sweeps", "irradiance_uncertainty_pct", "FLOAT", None),
    ("growatt_iv_sweeps", "reverse_pmax_w", "FLOAT", None),
    ("growatt_iv_sweeps", "sensor_misalignment_deg", "FLOAT", None),
    ("growatt_inverters", "datalogger_model", "VARCHAR(64)", None),
    ("growatt_inverters", "rated_power_w", "FLOAT", None),
    ("growatt_inverters", "param_synced_at", "TIMESTAMP WITH TIME ZONE", None),
    ("growatt_plants", "timezone", "VARCHAR(32)", None),
    ("growatt_plants", "address", "VARCHAR(255)", None),
    ("growatt_plants", "growatt_inverter_count", "INTEGER", None),
    ("growatt_plants", "growatt_datalogger_count", "INTEGER", None),
    ("growatt_plants", "details_synced_at", "TIMESTAMP WITH TIME ZONE", None),
    ("growatt_inverter_readings", "fault_code", "INTEGER", None),
    ("growatt_inverter_readings", "warn_code", "INTEGER", None),
    ("growatt_inverters", "growatt_created_at", "TIMESTAMP", None),
]


# Indexes added to tables that already existed (create_all only creates them with a new table).
_ADDED_INDEXES = [
    ("growatt_inverter_readings", "ix_growatt_inv_ts", "CREATE INDEX IF NOT EXISTS ix_growatt_inv_ts ON growatt_inverter_readings (timestamp)"),
]


def ensure_schema(bind) -> None:
    """create_all + add columns and indexes introduced after the table first shipped."""
    Base.metadata.create_all(bind=bind)
    insp = inspect(bind)
    for table, column, ddl, index in _ADDED_COLUMNS:
        if table in insp.get_table_names() and column not in {c["name"] for c in insp.get_columns(table)}:
            with bind.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                if index:
                    conn.execute(text(index))
    tables = set(insp.get_table_names())
    for table, name, ddl in _ADDED_INDEXES:
        if table in tables and name not in {i["name"] for i in insp.get_indexes(table)}:
            with bind.begin() as conn:
                conn.execute(text(ddl))


engine = build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_session_factory() -> sessionmaker:
    """FastAPI dependency: the session factory, for work that outlives the request's session
    (a streamed response opens its own sessions). Tests override it like `get_db`."""
    return SessionLocal


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a SQLAlchemy Session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
