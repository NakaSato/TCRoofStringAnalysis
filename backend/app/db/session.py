"""SQLAlchemy database engine, session factory, and declarative base."""

from __future__ import annotations

import json
from typing import Generator
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy ORM models."""


class ViewBase(DeclarativeBase):
    """Models mapped onto SQL views (created by DDL, never by `create_all`)."""


def _compact_json(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))


SQLITE_BUSY_TIMEOUT_S = 30


def build_engine(database_url: str | None = None):
    url = database_url or settings.database_url
    # SQLite (local only; production is Postgres): wait up to 30 s for a lock instead of the
    # driver's 5 s, so the log flusher and a meter upsert outlast a long `rules_today` / `history`
    # write instead of failing with "database is locked"
    connect_args = {"check_same_thread": False, "timeout": SQLITE_BUSY_TIMEOUT_S} if url.startswith("sqlite") else {}
    # JSON columns without the spaces after "," and ":" (json.dumps' default): a few % of every
    # JSON value, which adds up over the readings tables
    eng = create_engine(url, connect_args=connect_args, future=True, json_serializer=_compact_json)
    if url.startswith("sqlite"):
        @event.listens_for(eng, "connect")
        def _set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_S * 1000}")
            # WAL: readers no longer block the writer nor the writer the readers (the default
            # rollback journal locks the whole file for every write). It is stored in the file, so
            # this is a no-op after the first connection; an in-memory DB stays "memory". A file
            # another process holds locked keeps its mode until the next connection succeeds.
            try:
                cursor.execute("PRAGMA journal_mode=WAL")
            except Exception:  # noqa: BLE001 - the mode is an optimisation, never a reason to fail
                pass
            cursor.close()
    return eng


# Columns added to existing tables after release: (table, column, DDL type). `create_all` only
# creates missing tables, so these are added in place (SQLite and Postgres). The Alembic
# migrations add the same columns and skip them when already present.
# (table, column, DDL type, index DDL or None)
_ADDED_COLUMNS = [
    ("pwa_meter_sites", "meter_no", "VARCHAR(16)", "CREATE INDEX IF NOT EXISTS ix_pwa_meter_sites_meter_no ON pwa_meter_sites (meter_no)"),
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
    ("growatt_plant_daily", "system_factor", "FLOAT", None),
    ("growatt_plant_daily", "curtailed_kwh", "FLOAT", None),
    ("growatt_plant_daily", "curtailed_slots", "INTEGER", None),
    ("growatt_plant_daily", "curtail_judged_slots", "INTEGER", None),
    ("growatt_plant_daily", "curtailed_export_kwh", "FLOAT", None),
    ("growatt_plant_daily", "curtailed_limit_kwh", "FLOAT", None),
    ("growatt_plant_daily", "curtail_ratio", "FLOAT", None),
    ("growatt_plant_daily", "curtail_ratio_slots", "INTEGER", None),
    ("growatt_plant_daily", "curtail_ratio_source", "VARCHAR(8)", None),
    ("growatt_plant_daily", "free_ratio", "FLOAT", None),
    ("growatt_plant_daily", "free_slots", "INTEGER", None),
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
    ("growatt_inverters", "not_installed_at", "TIMESTAMP WITH TIME ZONE", None),
    ("growatt_inverters", "not_installed_by", "VARCHAR(64)", None),
    ("growatt_inverters", "not_installed_note", "VARCHAR(255)", None),
]


# Indexes added to tables that already existed (create_all only creates them with a new table).
_ADDED_INDEXES = [
    ("growatt_inverter_readings", "ix_growatt_inv_ts", "CREATE INDEX IF NOT EXISTS ix_growatt_inv_ts ON growatt_inverter_readings (timestamp)"),
]

# Columns no longer in the models, dropped from databases that still have them. (The string
# table's `power_w` and `ix_growatt_str_ts` went with the table itself:
# `_convert_string_readings`.)
_DROPPED_COLUMNS: list = []

# Indexes no longer in the models, dropped from databases that still have them.
_DROPPED_INDEXES: list = []


def _convert_string_readings(bind) -> None:
    """One-off (Nov 2026): the per-string table `growatt_string_readings` → one row per inverter
    record in `growatt_string_records`, then the view of the same name. Idempotent; on Postgres
    an advisory lock keeps the API and the worker from both converting."""
    from app.db.models.growatt import STRING_VIEW, create_string_view

    if STRING_VIEW not in inspect(bind).get_table_names():
        return
    pg = bind.dialect.name == "postgresql"
    with bind.begin() as conn:
        if pg:
            conn.execute(text("SELECT pg_advisory_xact_lock(7461902)"))
            if STRING_VIEW not in inspect(conn).get_table_names():
                return
            agg = "json_agg(json_build_array(string_no, mppt_no, voltage_v, current_a) ORDER BY string_no)"
            src = "growatt_string_readings"
        else:
            agg = "json_group_array(json_array(string_no, mppt_no, voltage_v, current_a))"
            src = "(SELECT * FROM growatt_string_readings ORDER BY device_sn, timestamp, string_no)"
        conn.execute(text(
            "INSERT INTO growatt_string_records (device_sn, timestamp, strings) "
            f"SELECT device_sn, timestamp, {agg} FROM {src} AS s GROUP BY device_sn, timestamp"
        ))
        conn.execute(text("DROP TABLE growatt_string_readings"))
        create_string_view(conn)


def ensure_schema(bind) -> None:
    """create_all + add columns and indexes introduced after the table first shipped, drop retired
    indexes and columns, convert the per-string readings table to records + view."""
    Base.metadata.create_all(bind=bind)
    _convert_string_readings(bind)
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
    for table, name in _DROPPED_INDEXES:
        if table in tables and name in {i["name"] for i in insp.get_indexes(table)}:
            with bind.begin() as conn:
                conn.execute(text(f"DROP INDEX IF EXISTS {name}"))
    for table, column in _DROPPED_COLUMNS:
        if table in tables and column in {c["name"] for c in insp.get_columns(table)}:
            # IF EXISTS on Postgres: the API and the worker may both start and both see the
            # column; SQLite has no IF EXISTS here (one local process)
            guard = "IF EXISTS " if bind.dialect.name == "postgresql" else ""
            with bind.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {guard}{column}"))


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
