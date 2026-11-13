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
    # dev: demo users (admin/admin123 …) + demo plant data are seeded.
    # prod: only one admin from ADMIN_USERNAME / ADMIN_PASSWORD, no demo data, and startup
    #       refuses the default JWT secret or a missing admin password.
    app_env: str = "dev"
    admin_username: str = "admin"
    admin_email: str = "admin@tcroofsolar.com"
    admin_password: str = ""  # prod: required (Secret Manager); also resets the admin's password
    seed_demo_data: bool | None = None  # default: True in dev, False in prod
    app_version: str = "1.0.0"
    database_url: str = DEFAULT_SQLITE_URL
    jwt_secret_key: str = "tc-roof-solar-super-secret-jwt-key-2026-engineering"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 days
    cors_origins: list[str] = ["*"]
    # One Growatt account per project phase (1-4), each with its own OpenAPI token.
    # Plants are tagged with the phase whose account lists them. `GROWATT_API_TOKEN` is the
    # pre-phase single-account setting and is used as phase 1 when no phase-1 token is set.
    growatt_api_token: str = ""
    growatt_token_phase1: str = ""
    growatt_token_phase2: str = ""
    growatt_token_phase3: str = ""
    growatt_token_phase4: str = ""
    growatt_base_url: str = "https://openapi.growatt.com/v1/"
    growatt_live_ttl_s: int = 120  # realtime cache TTL (memory only, never persisted)
    growatt_live_night_ttl_s: int = 1800  # max live cache life outside daylight (0 = off); ends at dawn
    growatt_live_device_gap_s: int = 270  # min s between max_data calls per inverter (Growatt refuses sooner)
    growatt_live_latest_ttl_s: int = 300  # per-inverter cap when no upload rhythm applies (no record today / silent)
    # Firestore (daily summaries + registry only; realtime data is never written)
    firebase_credentials_file: str = ""  # service-account JSON path, backend only
    firebase_project_id: str = ""
    publish_daily_write_budget: int = 15000  # stop before the Spark plan's 20k writes/day
    publish_sink: str = "json"  # json (data/firestore_export) | firestore
    worker_history_interval_min: int = 30
    # Growatt alarm log (`alarm_data`, one call per inverter) → SQL, so the Active Alarm page
    # reads the whole fleet from the DB. Today is re-read on this interval between
    # WORKER_ALARMS_START_H and _END_H (plant-local); `alarms_yesterday` closes the day at 00:30.
    worker_alarms_interval_min: int = 30
    worker_alarms_start_h: int = 5
    worker_alarms_end_h: int = 21
    # Sync the Growatt accounts (one per phase) in parallel threads. Growatt rate-limits per
    # token, so this cuts a fleet pass ~3x; set false if Growatt starts limiting per IP.
    worker_parallel_accounts: bool = True
    # Raw 1–5 min Growatt readings older than this are deleted daily (`retention` job). Daily
    # summaries in Firestore are kept. ~0.35–0.5 MB per inverter-day: 629 inverters x 90 days ≈ 30–45 GB.
    history_retention_days: int = 90
    # Google Maps Platform Weather API (modelled weather per plant; backend only, never sent to
    # the browser). 10,000 free calls/month, then $0.15 per 1,000. Plants within one grid cell
    # share a lookup. Every call (worker + API) is counted per billing day (US/Pacific) in SQL;
    # each day may use what is left of the month spread over the days left.
    google_weather_api_key: str = ""
    google_weather_base_url: str = "https://weather.googleapis.com/v1/"
    google_weather_cell_deg: float = 0.01  # ~1 km; 234 plants -> ~227 lookup points
    google_weather_monthly_budget: int = 10000  # = the free tier; lower it if the key is used elsewhere too
    google_weather_live_ttl_s: int = 1800  # current conditions are cached 30 min per cell (memory only)
    # Daytime window (plant-local hours, end exclusive): only these hours are stored, and live
    # current conditions are only fetched inside it (night: last value, no Google call).
    google_weather_day_start_h: int = 6
    google_weather_day_end_h: int = 18

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def is_prod(self) -> bool:
        return self.app_env.strip().lower() in ("prod", "production")

    @property
    def demo_data(self) -> bool:
        return (not self.is_prod) if self.seed_demo_data is None else self.seed_demo_data

    def growatt_accounts(self) -> dict[int, str]:
        """Configured Growatt accounts as {phase: token}, ascending, empty tokens skipped."""
        tokens = {
            1: self.growatt_token_phase1 or self.growatt_api_token,
            2: self.growatt_token_phase2,
            3: self.growatt_token_phase3,
            4: self.growatt_token_phase4,
        }
        return {phase: t.strip() for phase, t in tokens.items() if t and t.strip()}


settings = Settings()
