# backend/CLAUDE.md

Backend-specific guidance. Run all commands from the **repo root**, not from `backend/`.

## Commands

```bash
PYTHONPATH=backend uv run uvicorn app.main:app --reload --port 8000   # API, Swagger at /docs
uv run pytest -q                                                    # all tests (pythonpath: backend, .)
uv run pytest backend/tests/test_growatt_routes.py -v
pyright --pythonpath .venv/bin/python backend/app backend/solar_core # type check

uv run alembic -c backend/alembic.ini upgrade head
uv run alembic -c backend/alembic.ini revision --autogenerate -m "msg"

PYTHONPATH=backend uv run python -m app.worker --list                # schedule + last runs
PYTHONPATH=backend uv run python -m app.worker --once history        # run one job now
PYTHONPATH=backend uv run python -m app.services.growatt_sync --start 2026-11-05 --end 2026-11-11
PYTHONPATH=backend uv run python -m app.services.daily_summary --dry-run
```

**Two dependency files.** `pyproject.toml` at the repo root is for local `uv` and tests. `backend/pyproject.toml` is what the Docker image installs. Add each new dependency to both.

## Layers

- **`solar_core/`**: pure Pandas/NumPy engine with no FastAPI or SQLAlchemy imports.
  - `ingestion.py`: normalization and the inverter-cloud connectors.
  - `analysis.py`: IEC 61724 PR, string KPIs and faults, returning `AnalysisResults`.
  - `om_management.py`: CM work orders, PM schedule, RCA, PQ and SH&E.
  - `charts.py` (Plotly).
  - `growatt.py`: the Growatt OpenAPI client and `parse_max_records`.
  - `storage.py` is legacy and used only by `test_solar_core.py`.
- **`app/`**: FastAPI.
  - Routes are in `api/routes/*`, ORM models in `db/models.py`, request/response schemas in `schemas/api_schemas.py`.
  - Business logic lives in `services/*`. Keep route functions thin: they call a service and translate its exceptions into `HTTPException` (for example, `GrowattNotFound` becomes 404).
  - Every router is mounted twice, at `/api` and at `/`.
  - Auth is JWT (`app/auth.py`) with two roles. **admin**: everything. **engineer**: only the Growatt plants in `user_plant_assignments` (set by an admin via `/users/{id}/plants`).
    - Every `/growatt/…/plants/{plant_id}/…` route depends on `require_plant_read` / `require_plant_write`; an unassigned plant answers **404** (ids are not revealed). Lists (`/growatt/plants`, `/growatt/live/plants`) are filtered with `allowed_plant_ids` (None = admin = all); the live cache stays fleet-wide.
    - Admin only (`require_admin`): `/users`, fleet module PUT, `/growatt/sync/*`, and the legacy routers (`plants`, `datasets`, `analysis`, `maintenance`, `rca`, `she`), which use the local `plants` table with no link to Growatt plants.
    - Assignments are read from the DB per request, so changes apply without a new login. Any other stored role (the former `viewer`) becomes `engineer` at startup.

**Analysis pipeline** (`services/solar_service.py`):
1. ORM rows become a DataFrame, and `Plant` + `string_specs` become a `PlantConfig`.
2. `run_pv_string_analysis` runs.
3. Results are stored on `AnalysisRun` as JSON columns.
4. `reconstruct_analysis_results` rebuilds them for charts.

**Ingestion**:
- Every source must end up as the long-format columns in `solar_core.models.CANONICAL_COLUMNS`. `normalize_dataframe()` also accepts wide SCADA input (`PV1_U` / `pv1_u` …).
- `POST /plants/{id}/datasets/{upload|fetch|simulate}` → `store_dataset_from_dataframe` → `execute_and_store_analysis`.

## Growatt data rules

**Live and persisted data never mix.**

| Path | Code | Rule |
|---|---|---|
| `/growatt/live/*` | `services/growatt_live.py` | Memory only (TTL `GROWATT_LIVE_TTL_S`, 120 s). On failure it serves the last value marked `stale`; on error 10012 it waits 60 s. Every envelope carries `refresh_in_s` (cache expiry or cooldown end, ≥ 15 s); the UI (`useLivePoll`) polls on that, not a fixed timer. `/live/plants/{id}/latest` caches each inverter until its next record is due (last record time + measured interval + 60 s grace; 60 s retries while late; `GROWATT_LIVE_LATEST_TTL_S` once silent > 2 intervals), but never sooner than `GROWATT_LIVE_DEVICE_GAP_S` (270 s) after that inverter's last successful call: `max_data` answers each inverter only about once per 4–4.5 min (refused calls don't restart the wait), so a dev server and prod sharing tokens use up each other's window. A cold `/latest` fetches its inverters in parallel (`LIVE_WORKERS` = 8) and `/live/plants` its accounts in parallel, so first load costs the slowest call, not their sum. Night mode: outside the plants' daylight window (NOAA sunrise/sunset from `growatt_plants` lat/lon, `solar_core/sun.py`, ±30 min) live caches last up to `GROWATT_LIVE_NIGHT_TTL_S` (1800 s, 0 = off), never past dawn. **Never write live values to SQL or Firestore.** |
| `/growatt/plants*` | `services/growatt_overview.py` | DB only, `?day=`, `meta.source = "db"`. Never calls Growatt. |
| `/growatt/plants/{id}/inverters/{sn}/timeseries` · `/daily?days=` | `services/growatt_overview.py` | DB only. Timeseries also carries `strings` (string current per 5-min slot, for the heatmap) and `nominal_power_kw`. `daily` = per-day yield (last `eac_today`), peak AC, max temp, plus the plant's average inverter yield and `vs_plant_pct`, ≤ 90 days. |
| `/growatt/plants/{id}/weather` | `services/growatt_weather.py` | DB only. Weather-sensor day: 5-min series + insolation/peaks. |
| `/growatt/plants/{id}/google-weather` · `/growatt/live/plants/{id}/google-weather` | `services/google_weather.py` | Google Maps Weather, **modelled** (see below). DB: stored hourly day + 09/12/17 rain slots + days since rain. Live: current conditions, memory only, 30 min per cell. |
| SQL history | `services/growatt_sync.py` | Idempotent upserts. Started by the worker or the CLI. |
| `/growatt/alarms?day=` | `services/growatt_alarms.py` | DB only: stored alarm log of every plant the user may see (Active Alarm page), plus per-plant `inverters` / `synced_inverters` / `synced_at`. |
| Firestore | `services/daily_summary.py` | Daily summaries and the static registry only, about 250 writes a day. |

- **Project phases = Growatt accounts.** Each of the 4 phases has its own token (`settings.growatt_accounts()` → `{phase: token}`).
  - `fleet` lists every account and tags each plant with `growatt_plants.phase`.
  - `history` / `backfill` sync each phase's inverters with that phase's token. Live calls look up the plant's phase in the DB, and `/growatt/live/plants` merges every account.
  - `phase IS NULL` means not yet tagged; those plants use the first configured account. The worker re-runs `fleet` every 6 h while any plant is untagged.
  - Jobs run the accounts in parallel, one thread and one DB session each (`_per_phase`; `WORKER_PARALLEL_ACCOUNTS=false` runs them one by one). A failing account makes the run `partial`, and the run fails only when every account fails. `detail.phases` holds each phase's result.
- **Don't invent values.** If a measurement is missing, return `None` / `null`, not a typical-looking default. The same goes for things with no data source at all (grid import, load): leave them out instead of modelling them as if measured. Label modelled values as modelled: the clear-sky `expected_kw`, the I-V curves, and the peer-relative `pr_pct` / `plant_pr_pct` (strings vs. peers, *not* IEC PR). The measured IEC 61724-1 PR is `kpis.iec_pr_pct` (below).
- **Weather sensors** (`device/env/*`, `services/growatt_weather.py`):
  - device/list shows each as a type-3 device with `device_sn` literally `"env"`; the real key is (datalogger SN, bus address) from `env_list`. `fleet` registers them in `growatt_env_sensors`; `history` / `backfill` sync `env_data` (GET, ≤ 7 days, `perpage` ≤ 100, newest first) into `growatt_env_readings`; `retention` prunes them. Rate limits apply per datalogger.
  - Kept fields: `radiant` (POA W/m²), `envTemp`, `panelTemp`, `envHumidity`, `windSpeed`, `windAngle`. The ~20 others (rain, pressure, …) are always 0 here and are dropped. `timeText` is plant-local; ignore the `calendar` millis (labelled Asia/Shanghai, an hour off).
  - Readings are stored as reported. An unfitted probe reads 0, so a field that is 0 for a sensor all day is returned as null for that day (live: 0 all of the last 7 days).
  - `iec_pr_pct = (E_AC / kWp) / (H_POA / 1 kW/m²)`, null (with `weather.iec_pr.reason`) without a sensor or when irradiance covers < 90 % of the plant's producing 5-min slots. With it, the loss waterfall starts from measured `kWp × H` and uses measured module temperature.
  - Live: `/growatt/live/plants/{id}/weather` (`env_last_data`), cached per sensor like `/latest`.
- **Google Maps Weather** (`solar_core/google_weather.py` client, `services/google_weather.py`):
  - Modelled by Google for the plant's coordinates, never measured: every response has `modelled: true`, and the UI titles it "Google Weather (modelled)". The Growatt sensor stays the only source of irradiance and IEC PR; Google adds cloud cover, rain, condition, UV, dew point, pressure and visibility.
  - **Daytime only:** `GOOGLE_WEATHER_DAY_START_H`–`_END_H` (06:00–18:00, end exclusive). Only those hours are stored and read, so rain totals and `days_since_rain` count daytime rain only. Live current conditions are fetched only inside the window; at night the last value is served as stale (`refresh_in_s` = until 06:00), or 503 without one. Google bills per call, not per hour, so this saves night-time live calls and storage, not history calls.
  - Plants share a lookup when their lat/lon round to the same `GOOGLE_WEATHER_CELL_DEG` (0.01°) point: 234 plants → ~229 cells.
  - `google_weather` job (18:15): one `history/hours` call per cell stores the past 24 h in `google_weather_hourly` (naive plant-local `hour`, idempotent). Google returns only finished hours, so 18:15 is the first run holding 17:00; consecutive runs cover 18:00 → 17:00 with no gap. The job then re-publishes yesterday's daily docs (its 18:00–23:00 hours), about +235 Firestore writes/day. The first HTTP 429 (Google's own per-day quota) stops the run's remaining calls.
  - Firestore `daily/{day}/plants/{id}.google_weather`: rain mm, daytime cloud %, min/max temp, UV, condition, `rained`, `days_since_rain`, and `slots` `09`/`12`/`17` = `{raining, status_th ("ฝนตก"/"ไม่มีฝน"), condition, precip_mm, precip_prob_pct, cloud_cover_pct, temp_c}` (null = hour not stored yet). `publish_today` (19:30) has today's slots.
  - Budget = the whole free tier, `GOOGLE_WEATHER_MONTHLY_BUDGET` (10,000/month). Every call is counted per billing day (US/Pacific, when Google's month and daily quotas reset) in `external_api_call_counts`. Today's allowance = what is left of the month ÷ days left (today included), so unused calls roll over. Until `google_weather` has run today, live calls leave one call per cell for it. Over the allowance, live serves the last value as stale or answers 503. The job's `detail.usage` shows month used / today's allowance.
  - `days_since_rain` counts back to the last complete day with ≥ 1 mm; it is null when a day without complete data lies in between.
- **Alarm log in SQL** (`services/growatt_alarms.py`): alarms carry Growatt's own start/end times, so they are history, not realtime values. The `alarms` jobs read one inverter-day per call and **replace** that inverter-day's rows in `growatt_alarms` on success (an open alarm gets its `end_time` in place) and stamp `growatt_alarm_syncs` (device_sn, day, synced_at UTC); a failed read keeps the old rows. Inverters are swept never-read / oldest-read first; 3 consecutive 10012s end that account's sweep. No sync row = not read yet, which the API and UI report as such (never as zero alarms). `retention` prunes both tables with the readings.
- **Fault log:** `/growatt/live/plants/{id}/alarms?day=&days=7` reads `device/max/alarm_data` (POST, one inverter-day per call, `page`/`perpage`, run in a small thread pool) for the `days` ending at `day`. It is memory-only like every live value: each inverter-day is cached, today's for `GROWATT_LIVE_TTL_S` and a past day's for 6 h. The UI shows it in the "Growatt Fault Log" panel (Plant Overview, and per inverter on Inverters).
- **Strings differ in length.** Growatt doesn't report modules per string; engineers enter them in `growatt_string_layouts` (`GET/PUT /growatt/plants/{id}/string-layout`, UI: String Layout tab). `_classify_strings` compares energy per module (per kWp when every `module_wp` is set) and voltage per module only when *every* string of the inverter has a count; otherwise it compares raw values. Each string carries `peer_basis` (`raw` / `per_module` / `per_kwp`); current is never scaled (series string). A string with `module_wp` null uses the **fleet module** Wp (`services/fleet_settings.py`, global setting in SQL `app_settings`, `GET/PUT /growatt/fleet-module`, UI: Global Settings; default ZNShine ZXM7-UHLDD144 570 W). Saving it publishes Firestore `config/fleet_module` right away (1 write, within the budget); the publish jobs also carry it with the registry. Saving a plant's layout likewise publishes that plant's `inverters/{sn}` docs, which carry `strings: [{string_no, modules, module_wp}]` (key absent while an inverter has no layout).
- **Record interval is mixed** (mostly 5 min, some inverters every 1–4 min). Integrate energy with `_integrate_kwh`, never `sum × 5 min`. To build a plant curve, average each inverter within its 5-min slot first, then sum across inverters.
- **Daily yield = `eac_today` from the day's last record.** The counter keeps yesterday's total for a few minutes after midnight, so `MAX()` is wrong.
- **MAX inverters:**
  - String data comes from `device/max/max_data` (POST, ≤ 7 days, `perpage` ≤ 100, newest first).
  - String *n* is on MPPT ⌈n/2⌉. `vString` is the MPPT voltage, while `currentString` is per string.
  - String rows are kept only while `ppv > 0`, because PID recovery holds about 60 V at night.
  - `device/list` returns each MAX twice (type 1 and type 4); merge them by serial.
  - Name / rated power / firmware (`alias`, `normalPower`, `fwVersion`, `innerVersion`) and the inverter **settings** (`activeRate` power limit %, `reactiveRate`, `pf`, `pfModel`, `exportLimit`, `exportLimitPowerRate`, `onOff`) come from `device/max/max_data_info` and are stored on `growatt_inverters`. Settings are configured values, not measurements; the UI flags `active_rate_pct < 100` as curtailed and `on_off = 0` as switched off. The `fleet` job sweeps each account once per run, never-read then oldest first, for entries older than `INFO_REFRESH_HOURS` (20). `max_data_info` is tightly rate limited (about one call per account every few minutes): the first 10012 ends the sweep, and the rest wait for the next run. An answer without data is not stamped as read.
  - `/live/plants/{id}/latest` also returns, from the newest `max_data` record:
    - `grid`: phase/line V, A, `pf`, `reactPower`.
    - `diagnostics`: `faultType`, `faultCode1/2`, `warnCode1`, `warningValue1-3`, `pidFaultCode` and `StrBreak`; `pvIso`, where 65530 = no reading → null; `temperature2/3`, assumed to be IPM/boost; `afciStatus` and `afciPv1/2`; `gfci`; `r/s/tDci`; `timeTotal` in seconds → `time_total_h`.
    - `mppt_energy`: `epv{n}Today/Total`, kWh.
    These are live only and never stored. Units of GFCI/DCI/AFCI are Growatt's own and are shown as reported.
- **Timestamps:**
  - Growatt reading tables are naive plant-local (Bangkok) time.
  - App bookkeeping columns (`sync_runs`, `published_docs`, `synced_at`) are UTC. SQLite drops tzinfo, so store UTC and read naive values back as UTC (`jobs._aware`).
- **SQL must run on SQLite and Postgres.** Use SQLAlchemy expressions; no `strftime` / `date()` in raw `text()`. Time bucketing happens in Python.

## Worker and jobs

`app/worker.py` runs as one process (docker service `growatt-worker`); never start it inside uvicorn.

| Job | Schedule (Bangkok time) |
|---|---|
| `history` | every 30 min |
| `backfill` | 02:00 |
| `fleet` | 05:30 |
| `publish_yesterday` | 06:00 |
| `publish_today` | 19:30 |
| `retention` | 03:00: deletes raw inverter, string and weather readings (Growatt and Google) older than `HISTORY_RETENTION_DAYS` (90) |
| `google_weather` | 18:15: Google Maps Weather, past 24 h per plant cell, then re-publishes yesterday |
| `alarms` | every `WORKER_ALARMS_INTERVAL_MIN` (30) min, 05:00–21:00 (`WORKER_ALARMS_START_H`/`_END_H`): today's `alarm_data` per inverter → SQL |
| `alarms_yesterday` | 00:30: yesterday's alarm log once more (evening alarms, late closings) |

- Daily jobs fire only within 3 h after their slot.
- `services/jobs.py` holds the job bodies and the run log / lock (`sync_runs`).
- `GET /growatt/sync/status` and `POST /growatt/sync/{job}` cover the API side. **The API only queues a run** (`status = queued`); the worker starts it on its next tick (≤ 1 min). Never run jobs inside the API: on Cloud Run the CPU is cut after the response. A job that's already queued or running returns 409; a queued run nobody picks up within 2 h is marked failed.
- **Run `publish_today` at most twice a day.** An open day changes on every run, so each run rewrites about 250 Firestore documents.

## Production (`APP_ENV=prod`)

- Startup refuses to run without `ADMIN_PASSWORD` (≥ 12 chars) or with the default / short `JWT_SECRET_KEY`.
- Only one admin is seeded, from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Changing the secret resets that admin's password. Demo accounts still on their demo password are disabled, and no demo plant data is created (`SEED_DEMO_DATA` overrides).
- Every data router requires a signed-in user (`main.py`); only `/auth/login` and `/health` are open. Files (CSV templates) are downloaded by the UI with `fetch` + token, not plain links.

## DB and migrations

- `DATABASE_URL` defaults to SQLite at `data/solar_fullstack.db`; Docker uses `postgresql+psycopg`.
- Startup (API and worker) calls `ensure_schema` (`db/session.py`): `create_all` plus `_ADDED_COLUMNS`, which adds new columns to existing tables. New tables and listed columns appear without Alembic. Still add a hand-written migration under `alembic/versions/` (chain `down_revision`) for Postgres.

## Tests

- **API tests** build an isolated SQLite DB in `tmp_path`, call `ensure_seeded`, and override `get_db`.
  - Override `get_live_service` with a fake client; tests must never hit the network.
  - Override `get_session_factory` for background jobs.
- **Growatt fixtures:** reuse `_seed_growatt` from `tests/test_growatt_routes.py`, which covers 1-min and 5-min inverters, the midnight counter carry-over, and an inverter with no data.
- **Seeded logins:** usernames `admin` / `admin123`, `engineer` / `engineer123` (no plants assigned; tests assign them with `UserPlantAssignment`). `POST /auth/login` takes `{username, password}` (`email` still accepted; either field matches a username or an email). Users created before usernames get one from their email's local part at startup.
