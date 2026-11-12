"""SQLite persistence layer for Solar O&M Management tables (PM, CM, RCA, SH&E PTW)."""

from __future__ import annotations

import pathlib
import sqlite3
from typing import Optional
import pandas as pd

from solar_core.om_management import (
    get_default_pm_schedule,
    get_default_rca_records,
    get_she_dashboard_data,
)

DEFAULT_DB_PATH = pathlib.Path(__file__).resolve().parent.parent / "data" / "solar_om.db"


class OMDatabase:
    """Lightweight SQLite persistence manager for O&M engineering registers."""

    def __init__(self, db_path: Optional[pathlib.Path] = None):
        self.db_path = db_path or DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_tables()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path))

    def _init_tables(self) -> None:
        with self._connect() as conn:
            # Seed default tables if they do not exist yet
            if not self._table_exists(conn, "pm_schedule"):
                get_default_pm_schedule().to_sql("pm_schedule", conn, index=False, if_exists="replace")
            if not self._table_exists(conn, "rca_register"):
                get_default_rca_records().to_sql("rca_register", conn, index=False, if_exists="replace")
            if not self._table_exists(conn, "she_ptw_register"):
                _, ptw_df, _ = get_she_dashboard_data()
                ptw_df.to_sql("she_ptw_register", conn, index=False, if_exists="replace")

    @staticmethod
    def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?;", (table_name,)
        )
        return cur.fetchone() is not None

    def load_table(self, table_name: str) -> pd.DataFrame:
        with self._connect() as conn:
            return pd.read_sql(f"SELECT * FROM {table_name}", conn)

    def save_table(self, table_name: str, df: pd.DataFrame) -> None:
        with self._connect() as conn:
            df.to_sql(table_name, conn, index=False, if_exists="replace")

    def reset_to_defaults(self) -> None:
        with self._connect() as conn:
            get_default_pm_schedule().to_sql("pm_schedule", conn, index=False, if_exists="replace")
            get_default_rca_records().to_sql("rca_register", conn, index=False, if_exists="replace")
            _, ptw_df, _ = get_she_dashboard_data()
            ptw_df.to_sql("she_ptw_register", conn, index=False, if_exists="replace")
