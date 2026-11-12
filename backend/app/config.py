"""Application configuration using Pydantic Settings."""

from __future__ import annotations

import pathlib
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DATA_DIR = REPO_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_SQLITE_URL = f"sqlite:///{DATA_DIR / 'solar_fullstack.db'}"


class Settings(BaseSettings):
    """Runtime settings for the FastAPI backend."""

    app_name: str = "TC Roof Solar PV String & O&M Engineering API"
    app_version: str = "1.0.0"
    database_url: str = DEFAULT_SQLITE_URL
    jwt_secret_key: str = "tc-roof-solar-super-secret-jwt-key-2026-engineering"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 days
    cors_origins: list[str] = ["*"]
    growatt_api_token: str = ""
    growatt_base_url: str = "https://openapi.growatt.com/v1/"
    growatt_live_ttl_s: int = 120  # realtime cache TTL (memory only, never persisted)
    growatt_live_latest_ttl_s: int = 300  # per-inverter newest max_data record (~one upload period)
    # Firestore (daily summaries + registry only; realtime data is never written)
    firebase_credentials_file: str = ""  # service-account JSON path, backend only
    firebase_project_id: str = ""
    publish_daily_write_budget: int = 15000  # stop before the Spark plan's 20k writes/day
    publish_sink: str = "json"  # json (data/firestore_export) | firestore
    worker_history_interval_min: int = 30

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
