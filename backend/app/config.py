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
    # Growatt plant ids (comma separated) the app ignores: left out of every account's plant list
    # (registry and live), and their stored registry rows are removed by the worker.
    growatt_blocked_plant_ids: str = ""
    growatt_live_ttl_s: int = 120  # realtime cache TTL (memory only, never persisted)
    growatt_live_night_ttl_s: int = 1800  # max live cache life outside daylight (0 = off); ends at dawn
    growatt_live_device_gap_s: int = 270  # min s between max_data calls per inverter (Growatt refuses sooner)
    growatt_live_latest_ttl_s: int = 300  # per-inverter cap when no upload rhythm applies (no record today / silent)
    # Weather-sensor online state (`env_list`, one call per datalogger, memory only). The Sensors
    # page sweeps the fleet a few dataloggers per request, so it costs calls only while open.
    sensor_status_ttl_s: int = 300  # how long one datalogger's sensor list is reused
    sensor_sweep_per_request: int = 12  # max dataloggers refreshed per status request
    # Today's energy per plant for the plant directory (`plant/data`, one call per plant, memory only)
    plant_today_ttl_s: int = 300  # how long one plant's answer is reused
    plant_today_sweep_per_request: int = 40  # max plants refreshed per /live/plants/today request
    # fleet inverter snapshot (`maxs_data`, 50 inverters per call, memory only): Growatt allows an
    # account about 4 calls, then 10012 until ≈ 5 min after the first (measured 2026-11-15)
    inverter_snapshot_ttl_s: int = 300  # how long one 50-inverter chunk is reused
    inverter_snapshot_sweep_per_request: int = 4  # max chunks refreshed per /live/inverters/snapshot request
    sensor_late_min: int = 15  # last upload older than this = late
    sensor_offline_min: int = 60  # older than this (or Growatt says lost) = offline
    # last upload older than this = inactive: an entry Growatt still lists that stopped uploading long
    # ago (removed / re-addressed on site); not an alarm, kept apart from offline. 0 = off
    sensor_inactive_days: float = 30
    sensor_alarm_coverage_pct: float = 80.0
    # Optional Redis (on the tcroof-db VM, no persistence) mirroring the live memory caches so a
    # Cloud Run cold start / deploy keeps them warm; empty = process memory only
    redis_url: str = ""
    # System → Logs: Python log records of the API and worker in SQL `app_logs` (redacted)
    log_db_enabled: bool = True
    log_db_level: str = "INFO"
    log_retention_days: int = 14
    log_max_rows: int = 500_000
    log_flush_interval_s: float = 5.0
    log_buffer_max: int = 5000
    log_slow_request_ms: int = 5000  # Active Alarm, past day: stored daylight coverage below this = data gap
    # Firestore (daily summaries + registry only; realtime data is never written)
    firebase_credentials_file: str = ""  # service-account JSON path, backend only
    firebase_project_id: str = ""
    publish_daily_write_budget: int = 15000  # stop before the Spark plan's 20k writes/day
    publish_sink: str = "json"  # json (data/firestore_export) | firestore
    worker_history_interval_min: int = 10
    # `history`: read today's records of this many inverters per call
    # (`new-api/queryDevicesHistoricalData`) instead of one `max_data` call each. 0 = off. An
    # inverter the batch does not cover back to its last stored record is read with `max_data`.
    # Off by default: the endpoint's rate limit and largest serial list were not measured, and a
    # call returns each inverter's whole day so far (about 0.6 MB per inverter by midday).
    worker_history_batch_size: int = 0
    # Growatt alarm log (`alarm_data`, one call per inverter) → SQL, so the Active Alarm page
    # reads the whole fleet from the DB. The `alarms` job runs every WORKER_ALARMS_TICK_MIN between
    # WORKER_ALARMS_START_H and _END_H (plant-local) and reads only the inverters due by tier:
    # hot (open alarm today / fault status) every _HOT_MIN, warm (alarms today, all closed) every
    # _WARM_MIN, cold (no alarms today) every _COLD_MIN. `alarms_yesterday` closes the day at 00:30.
    worker_alarms_tick_min: int = 10
    worker_alarms_hot_min: int = 10
    worker_alarms_warm_min: int = 30
    worker_alarms_cold_min: int = 60
    worker_alarms_start_h: int = 5
    worker_alarms_end_h: int = 20
    # Weather-sensor history only (`env_history`), every WORKER_ENV_INTERVAL_MIN between
    # WORKER_ENV_START_H and _END_H (plant-local; irradiance is 0 at night, `history` still
    # covers env every 30 min). 0 disables the job.
    worker_env_interval_min: int = 10
    worker_env_start_h: int = 5
    worker_env_end_h: int = 20
    # Newest record of every inverter (`inverter_latest`, `maxs_data`) into the history tables
    # every WORKER_LATEST_INTERVAL_MIN between WORKER_LATEST_START_H and _END_H (plant-local).
    # 0 = off (default); 1–4 run every 5 min, since an account answers `maxs_data` again only
    # about 5 min after a sweep. It shares that window with `/growatt/live/inverters/snapshot`.
    worker_latest_interval_min: int = 0
    worker_latest_start_h: int = 5
    worker_latest_end_h: int = 20
    # Sync the Growatt accounts (one per phase) in parallel threads. Growatt rate-limits per
    # token, so this cuts a fleet pass ~3x; set false if Growatt starts limiting per IP.
    worker_parallel_accounts: bool = True
    # Energy-meter history (`device/ammeter/meter_data`, the grid-point meter on each datalogger):
    # synced with `history` / `backfill` into `growatt_meter_readings`; false skips it.
    meter_history_enabled: bool = True
    # Raw 1–5 min Growatt readings older than this are deleted daily (`retention` job). Daily
    # summaries in Firestore are kept. ~0.35–0.5 MB per inverter-day: 629 inverters x 90 days ≈ 30–45 GB.
    history_retention_days: int = 90
    # Keep the whole `max_data` record of every inverter reading (`growatt_inverter_raw`, every
    # field as Growatt reports it), not only the columns the app computes from. About 4 kB per
    # record uncompressed: 629 inverters ≈ 0.7 GB/day before Postgres compression, so it has its
    # own, shorter retention. false = store only the computed columns, as before.
    history_store_raw: bool = True
    history_raw_retention_days: int = 30
    # Google Maps Platform Weather API (modelled weather per plant; backend only, never sent to
    # the browser). 10,000 free calls/month, then $0.15 per 1,000. Plants within one grid cell
    # share a lookup. Every call (worker + API) is counted per billing day (US/Pacific) in SQL;
    # each day may use what is left of the month spread over the days left.
    google_weather_api_key: str = ""
    google_weather_base_url: str = "https://weather.googleapis.com/v1/"
    google_weather_cell_deg: float = 0.01  # ~1 km; 234 plants -> ~227 lookup points
    google_weather_monthly_budget: int = 30000  # PWA checks (687/day) + history (229/day) ≈ 28.4k; over the 10k free tier
    # Google's own per-day quota "History Hours Usage per day" counts hours returned, not calls: it
    # refused calls after 174 cells x 24 h = 4,176 h. Kept a little below it.
    google_weather_history_hours_per_day: int = 4000
    # Shared key for the PWA Report sheet (Apps Script) on GET /report/pwa/{day} (header X-Report-Key).
    # Empty = route disabled. Prod: Secret Manager `tcroof-report-key`.
    report_api_key: str = ""
    # Monitoring PWA Report Google Sheet, filled by the worker (services/pwa_sheet.py) through the
    # Sheets API. Empty = off. Share the sheet as Editor with the service account's client_email.
    pwa_sheet_id: str = ""  # from the sheet URL: /spreadsheets/d/<id>/edit
    pwa_sheet_credentials_file: str = ""  # service-account JSON; empty = FIREBASE_CREDENTIALS_FILE
    # PWA report checks 09 / 13 / 17 are snapshots taken this many minutes before hh:00 (08:50 /
    # 12:50 / 16:50), published then, so the sheet has them by hh:00 (services/check_slots.py).
    check_offset_min: int = 10
    # A check's DATA LOG lists only the alarm-log records from this many minutes before its
    # snapshot (07:50 for the 08:50 snapshot) up to it; `since` / `count` cover the same span.
    pwa_fault_lookback_min: int = 60
    # Warning codes of a reading (max_data `warnCode`, comma separated) the DATA LOG does not
    # report when the alarm log has nothing for the inverter: 1 stays set all day on inverters
    # that produce normally and Growatt's log never names it.
    pwa_ignore_warn_codes: str = "1"
    # `history` pull this many minutes before each check's snapshot / publish (08:47 at 10 + 3)
    pwa_history_lead_min: int = 3
    google_weather_live_ttl_s: int = 1800  # current conditions are cached 30 min per cell (memory only)
    # Daytime window (plant-local hours, end exclusive): only these hours are stored, and live
    # current conditions are only fetched inside it (night: last value, no Google call).
    google_weather_day_start_h: int = 6
    google_weather_day_end_h: int = 18
    # Longdo Map Weather Radar API (weather.longdo.com): rain radar tiles on the Plant Map and
    # radar rain over a plant now / +15 / +30 min. Empty key = off. The backend makes the JSON
    # calls (memory cache only); the radar tiles are loaded by the browser, so the key is sent
    # to signed-in users in the tile URL: restrict it by domain in the Longdo Map console.
    longdo_api_key: str = ""
    longdo_base_url: str = "https://weather.longdo.com/"
    # Longdo allows 100,000 calls a month and 60 a minute per key. The backend's own JSON calls
    # are counted per Bangkok day in SQL (`external_api_call_counts`, api `longdo`) and each day
    # may use what is left of this budget spread over the days left; the rest of the 100,000 is
    # left for the radar tiles the browsers load. Over it, the last values are served as stale.
    longdo_monthly_budget: int = 60000
    longdo_timeout_s: float = 6.0  # one Longdo call (they answer in 0.2–0.4 s)
    longdo_calls_per_min: int = 30  # backend calls per minute (the other half is for tiles)
    longdo_interactive_reserve_per_min: int = 8  # of those, kept from the fleet sweep for the selected plant + snapshot list
    longdo_radar_ttl_s: int = 300  # list of radar snapshots (they are 15 min apart)
    longdo_rain_ttl_s: int = 300  # rain over the selected plant's cell (point + area, now + forecast)
    longdo_area_radius_km: float = 10.0  # "rain nearby" circle around the selected plant
    # Rain now over every plant, swept only while the Plant Map's radar is on: one `area` call
    # per 1° region (47 for the fleet), then `location` only for plants in a region with rain.
    # At most this many calls per request; a region / plant is asked again after the TTL.
    longdo_fleet_rain_ttl_s: int = 1800
    longdo_rain_sweep_per_request: int = 20
    # RainViewer (api.rainviewer.com, no key): fallback radar tiles on the Plant Map when Longdo
    # has no key or its snapshot list cannot be read. Tiles only (zoom ≤ 7), no rain over a plant.
    # Free API for personal / educational / small community use, no SLA; credit is shown on the map.
    rainviewer_enabled: bool = True
    rainviewer_url: str = "https://api.rainviewer.com/public/weather-maps.json"
    rainviewer_ttl_s: int = 300  # snapshot list (10 min apart)
    rainviewer_timeout_s: float = 6.0
    # Site visit route (docs/plans/site-visit-route.md): Geoapify (hosted, OpenStreetMap data) for
    # the drive-time matrix (`routematrix`) and the route line (`routing`). Empty key = off:
    # `/growatt/routes/solve` answers straight-line estimates, labelled `source: "straight_line"`.
    # The key stays on the backend (never sent to the browser, masked in the logs). Matrix and
    # route line are cached in memory only (24 h); nothing of a solve is stored.
    geoapify_api_key: str = ""
    geoapify_base_url: str = "https://api.geoapify.com/"
    geoapify_timeout_s: float = 8.0  # one Geoapify call
    geoapify_cooldown_s: float = 60.0  # after a failed call, straight-line only for this long
    # Geoapify's free plan gives 3,000 credits a day (matrix = max(S,T) × min(S,T,10), routing =
    # waypoints − 1, +1 per 500 km over 500 km) and does not block past it, so the backend keeps
    # its own cap: credits are counted per Bangkok day in SQL (`external_api_call_counts`, api
    # `geoapify`, the `calls` column holds credits); a solve that would pass it uses straight lines.
    geoapify_daily_credits: int = 2800
    route_solve_per_min: int = 10  # `/growatt/routes/solve` calls per user per minute (429 over it)
    # Knowledge Base documents (docs/plans/kb-documents.md): uploaded PDFs (manuals, datasheets,
    # drawings, SOPs) kept unchanged, with a SHA-256 checksum. `KB_ASSETS_BUCKET` set = a private
    # GCS bucket (production; the API signs short GET URLs); empty = the local folder
    # `KB_FILES_DIR` (dev). In prod an upload without a bucket is refused (Cloud Run's disk is not
    # kept). Text per page is read at upload; pages without a text layer are OCR'd by the
    # worker's `kb_ocr` job with tesseract (`KB_OCR_LANGS`, only the installed ones are used).
    kb_assets_bucket: str = ""
    kb_files_dir: str = ""  # empty = data/kb_files
    kb_max_upload_mb: int = 30  # Cloud Run takes at most 32 MB per request
    kb_file_url_ttl_s: int = 3600  # signed file links (GCS or the API's own) last this long
    kb_ocr_langs: str = "tha+eng"
    kb_ocr_dpi: int = 300
    kb_ocr_pages_per_run: int = 150  # pages one `kb_ocr` run reads at most
    kb_ocr_timeout_s: float = 120.0  # one page
    worker_kb_ocr_interval_min: int = 30  # 0 = only when an upload queues it
    # AI Assistant (docs/plans/ai-assistant.md): Messages-API chat with read-only DB tools.
    # Qwen Cloud Model Studio (Singapore) through its Anthropic-compatible endpoint; an empty
    # base URL means Anthropic itself. Empty key = assistant off. Backend only (Secret Manager
    # `tcroof-ai-api-key` in prod). Nothing the assistant reads or writes is stored, only usage.
    ai_api_key: str = ""
    ai_base_url: str = "https://ap-southeast-1.maas.qwencloudapi.com/apps/anthropic"
    ai_model: str = "qwen3.7-plus"
    ai_thinking: bool = False  # Qwen thinks by default: answers take 30-90 s, so it is sent disabled
    ai_max_tokens: int = 4000
    ai_max_tool_rounds: int = 8
    ai_turn_timeout_s: float = 120.0
    ai_monthly_budget_usd: float = 5.0  # hard cap; 429 until the 1st once spent
    ai_user_daily_questions: int = 15  # per user per Bangkok day; admins exempt
    ai_enabled_roles: str = "admin,engineer"
    # USD per 1M tokens of AI_MODEL (qwen3.7-plus list price), for ai_usage.cost_usd
    ai_price_in_per_m: float = 0.40
    ai_price_cached_per_m: float = 0.08
    ai_price_out_per_m: float = 1.60
    # Alarm push notifications (Firebase Cloud Messaging, web push). The four web values are the
    # Firebase web app's public config (they ship to every browser by design, not secrets); the
    # API hands them to the UI, and push is off while any is empty. The worker sends with
    # FIREBASE_CREDENTIALS_FILE after each `alarms` run; the API never sends.
    firebase_web_api_key: str = ""
    firebase_web_app_id: str = ""
    firebase_messaging_sender_id: str = ""
    firebase_vapid_key: str = ""  # Web Push certificate key pair (public key)
    push_alarm_levels: str = "fault"  # comma list of fault, warning, info
    push_alarm_max_age_min: int = 90  # an event last reported longer ago is old news: no push
    push_alarm_repeat_min: int = 120  # the same inverter + code again: at most one push in this time
    push_max_plants_per_user: int = 5  # more plants with new alarms in one run = one summary push

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

    def pwa_ignored_warn_codes(self) -> frozenset[int]:
        return frozenset(int(p) for p in (x.strip() for x in self.pwa_ignore_warn_codes.split(",")) if p.isdigit())

    def blocked_plant_ids(self) -> frozenset[int]:
        """`GROWATT_BLOCKED_PLANT_IDS` as plant ids; anything that is not a number is ignored."""
        parts = self.growatt_blocked_plant_ids.replace(";", ",").split(",")
        return frozenset(int(p) for p in (x.strip() for x in parts) if p.isdigit())


settings = Settings()
