# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TC Roof Solar: a PV string performance and O&M suite. It has a FastAPI backend (`backend/`) and a React frontend (`frontend/`), and monitors a fleet of 234 Growatt plants (629 MAX inverters, 231 weather sensors).

Folder-specific guidance lives in **`backend/CLAUDE.md`** and **`frontend/CLAUDE.md`**.

## Commands

Python is managed with `uv` (Python ≥ 3.13). Run backend commands from the repo root.

```bash
PYTHONPATH=backend uv run uvicorn app.main:app --reload --port 8000   # API (SQLite data/solar_fullstack.db), Swagger /docs
uv run pytest -q                                                    # backend tests
cd frontend && bun run dev                                          # UI on :5173, proxies /api → :8000 (Bun, not npm)
cd frontend && bun run lint && bun run build                        # type check + build
docker compose up --build                                           # Postgres + backend + growatt-worker + frontend
```

Seeded logins (username / password): `admin` / `admin123`, `engineer` / `engineer123`. Two roles: **admin** can do everything; **engineer** sees and works on only the Growatt plants an admin assigned (UI: Users & Access). Login takes a username; an email is still accepted. There is no auto-login: the UI shows a login page until a user signs in.

## How data flows (Growatt)

```
Growatt OpenAPI ─┬─ realtime ─► backend memory cache (120 s) ─► /growatt/live/* ─► UI polls when refresh_in_s says
                 │              (mirrored in Redis on the VM, no persistence, keys expire; never stored)
                 ├─ plant/data today energy ─► memory sweep (40 plants/request, 300 s) ─► /growatt/live/plants/today
                 │              (only while the plant directory is open; never stored)
                 ├─ env_list sensor status ─► memory sweep (12 dataloggers/request, 300 s) ─► /growatt/live/sensors/status
                 │              (only while Weather Sensors / Active Alarm is open; never stored)
                 ├─ max_data history ─► growatt-worker (every 30 min) ─► SQL ─► /growatt/plants* (DB only)
                 │                                                       └─► daily summaries ─► Firestore
                 ├─ env_data today (one sensor) ─► backend memory cache (300 s) ─► /growatt/live/sensors/{dl}/{addr}/today ─► sensor page chart (today only)
                 ├─ env_data sensor history ─► growatt-worker (every 30 min with history; also every 10 min, 05–20) ─► SQL
                 └─ alarm_data log ─► growatt-worker (10-min tick, 05–20, per inverter by tier: fault/open 10 min,
                                  alarms today 30 min, none 60 min; yesterday in full at 00:30) ─► SQL ─► /growatt/alarms (Active Alarm)
API + worker logging ─► app_logs (SQL, redacted, 14 days) ─► /system/logs (admin: System → Logs)
Google Maps Weather ─┬─ current ─► backend memory cache (30 min per cell) ─► /growatt/live/plants/{id}/google-weather
  (modelled)         └─ history/hours ─► growatt-worker (18:15 daily) ─► SQL ─► daily summaries (rain at 09/12/17) ─► Firestore
```

Rules for every layer:

1. **Never store realtime values.** Live data stays in memory only: the API process, mirrored in Redis on the VM (`REDIS_URL`; no persistence, every key expires, `services/live_store.py`) so a Cloud Run cold start stays warm. SQL gets only source-timestamped history (Growatt records, Google Weather hours).
2. **Firestore holds only daily summaries and the static registry** (`plants/`, `inverters/`, and global settings under `config/`, e.g. `config/fleet_module`). The project `tcroof-string-analysis` runs on the free Spark plan (20k writes/day). Each day costs about 1,250 writes (about 250 per publish of today: at 09:30, 13:30 and 17:30 for the PWA report checks and at 19:30, plus about 235 when `google_weather` re-publishes yesterday), capped at `PUBLISH_DAILY_WRITE_BUDGET`.
3. **Never invent numbers.** Missing measurements are `null` and show as "—". Don't add data with no source (grid import, load; irradiance only where a plant has a weather sensor), and label modelled values as modelled.
4. **The Growatt tokens and the Google Weather key stay on the backend.** Firebase service-account keys go in `secrets/`, which is gitignored.

## Deploy (GCP, test month at ≤ ฿3,000/month)

`deploy/gcp.sh setup | backend | frontend | all | upsize | ip | snapshots | costguard | monitoring | ai` (see header of the script). **Production settings live in `deploy/gcp.config`**; sizing, costs and the cost cap are in `docs/plans/gcp-production.md`.
- **Frontend:** Firebase Hosting. `firebase.json` rewrites `/api/**` to Cloud Run.
- **API:** Cloud Run service `tcroof-api` in us-central1. It runs min 0 / max 1 instance (scales to zero; a cold start of a few seconds after idle) and gets its secrets from Secret Manager.
- **Postgres + `growatt-worker` + Redis:** VM `tcroof-db` (`e2-standard-2`, 8 GB) running `deploy/vm/compose.yml` from `/opt/tcroof`. It has a static internal IP and a static external IP (`tcroof-db-ext`, the worker's outbound address); ports 5432 and 6379 are reachable only inside the VPC (firewall rules `tcroof-allow-postgres-internal` / `-redis-internal`), both with a password. Redis (256 MB, no persistence) mirrors the API's live cache at no extra cost; its password and URL are the secrets `tcroof-redis-password` / `tcroof-redis-url`. The disk is 100 GB `pd-balanced` to hold 90 days of raw readings for 629 inverters; the `retention` job deletes older readings. Postgres memory settings are written to the VM's `.env` by `deploy/gcp.sh backend` for the VM's machine type.
- **Backups:** weekly disk snapshots only (policy `tcroof-db-weekly`, Sunday 02:00 Bangkok, kept 28 days); restore steps are above `cmd_snapshots`.
- **Cost cap:** budget `tcroof-monthly` (฿3,000; planned spend ≈ ฿2,566) emails at 50/90/100 %; the `tcroof-cost-guard` function (`deploy/costguard/`) **disables billing on the project at 96 % (฿2,880)**, which stops everything until an admin re-links billing (disks and snapshots are kept).
- **Alerts:** email when `/api/health` or `/api/health/worker` (no finished `history` run in 2 h) fails, or the VM disk is over 85 % (Ops Agent).
- **AI Assistant:** `deploy/gcp.sh ai` puts `AI_API_KEY` from `.env` into secret `tcroof-ai-api-key` (run again after rotating the key), then `backend` passes it to Cloud Run with `AI_*` settings from `gcp.config` (model, enabled roles, $5 cap, 15/day, 55 s turn timeout because Firebase Hosting ends `/api` rewrites at 60 s). No secret = assistant off.
- **Production login:** `APP_ENV=prod` seeds only the admin from secret `tcroof-admin-password` (created by `setup`, or from `ADMIN_PASSWORD` in `.env`). There are no demo accounts.
- **Why not Cloud SQL:** a comparable instance (2 vCPU / 8 GB) costs well over the whole ฿3,000 budget, and history grows by about 0.5 GB/day (629 inverters), which rules out the free Postgres tiers.

## Config

`.env` is read by pydantic-settings in `backend/app/config.py`; `.env.example` lists the keys. The main ones:
- `DATABASE_URL`
- `GROWATT_TOKEN_PHASE1`..`4`: one Growatt account per project phase. The legacy `GROWATT_API_TOKEN` is used as phase 1 when `GROWATT_TOKEN_PHASE1` is empty.
- `GROWATT_LIVE_TTL_S`
- `REDIS_URL` (empty = memory only): Redis mirror of the live caches and Growatt / Google cooldowns
- `SENSOR_STATUS_TTL_S` (300), `SENSOR_SWEEP_PER_REQUEST` (12), `SENSOR_LATE_MIN` / `SENSOR_OFFLINE_MIN` (15 / 60): Weather Sensors live status (`env_list` per datalogger, memory only, swept only while the page is open); `SENSOR_ALARM_COVERAGE_PCT` (80): Active Alarm, past day: stored daylight coverage below this = data gap
- `PLANT_TODAY_TTL_S` (300), `PLANT_TODAY_SWEEP_PER_REQUEST` (40): plant directory Yield today (`plant/data` per plant, memory only, swept only while the directory is open)
- `LOG_DB_ENABLED` (true), `LOG_DB_LEVEL` (INFO), `LOG_RETENTION_DAYS` (14), `LOG_MAX_ROWS` (500000), `LOG_FLUSH_INTERVAL_S` (5), `LOG_BUFFER_MAX` (5000), `LOG_SLOW_REQUEST_MS` (5000): System → Logs (`app_logs`)
- `FIREBASE_PROJECT_ID` and `FIREBASE_CREDENTIALS_FILE`
- `PUBLISH_SINK` (`json` | `firestore`)
- `PUBLISH_DAILY_WRITE_BUDGET`
- `WORKER_HISTORY_INTERVAL_MIN`
- `HISTORY_RETENTION_DAYS` (90)
- `WORKER_ALARMS_TICK_MIN` (10), `WORKER_ALARMS_HOT_MIN` / `_WARM_MIN` / `_COLD_MIN` (10 / 30 / 60), `WORKER_ALARMS_START_H` / `_END_H` (5 / 20): alarm log sync. Each tick reads only the inverters due by tier (hot = open alarm or fault status, warm = alarms today, cold = none); skipped 09/13/17:20–:31 for the PWA checks
- `WORKER_ENV_INTERVAL_MIN` (10, 0 = off), `WORKER_ENV_START_H` / `_END_H` (5 / 20): `env_history`, weather-sensor history between `history` runs
- `APP_ENV` (`dev` | `prod`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`
- `GOOGLE_WEATHER_API_KEY` (Secret Manager `tcroof-google-weather-key`), `GOOGLE_WEATHER_MONTHLY_BUDGET` (10000): Google Maps Weather uses its whole free tier; each day gets what is left of the month ÷ days left. `GOOGLE_WEATHER_DAY_START_H` / `_END_H` (6 / 18): daytime-only hours stored and fetched live
- `AI_API_KEY` (Secret Manager `tcroof-ai-api-key`; empty = off), `AI_BASE_URL` (Qwen Cloud Singapore, Anthropic-compatible), `AI_MODEL` (`qwen3.7-plus`), `AI_THINKING` (false; Qwen thinks by default and takes 30–90 s), `AI_MONTHLY_BUDGET_USD` (5), `AI_USER_DAILY_QUESTIONS` (15), `AI_ENABLED_ROLES`, `AI_PRICE_*`: AI Assistant (`/assistant/*`, docs/plans/ai-assistant.md). Conversations stay in the browser; only token counts and cost go to SQL `ai_usage`

Firebase CLI config is in `firebase.json`, `.firebaserc` and `firestore.rules`. The rules deny all browser access; the backend writes through the Admin SDK. Use `bunx firebase-tools`.
