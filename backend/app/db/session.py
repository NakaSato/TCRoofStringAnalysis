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
    ("growatt_plants", "phase", "INTEGER", "CREATE INDEX IF NOT EXISTS ix_growatt_plants_phase ON growatt_plants (phase)"),
    ("users", "username", "VARCHAR(64)", "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)"),
]


def ensure_schema(bind) -> None:
    """create_all + add columns introduced after the table first shipped."""
    Base.metadata.create_all(bind=bind)
    insp = inspect(bind)
    for table, column, ddl, index in _ADDED_COLUMNS:
        if table in insp.get_table_names() and column not in {c["name"] for c in insp.get_columns(table)}:
            with bind.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                if index:
                    conn.execute(text(index))


engine = build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a SQLAlchemy Session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
