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
                 ├─ maxs_data newest record (50 inverters/call) ─► memory sweep (300 s) ─► /growatt/live/inverters/snapshot
                 │              (only while a page polls it; never stored)
                 ├─ maxs_data newest record ─► growatt-worker (`inverter_latest`, off by default, every ≥ 5 min, 05–20) ─► SQL
                 │              (the record under Growatt's own timestamp, same rows `history` writes)
                 ├─ max_data history ─► growatt-worker (every 10 min) ─► SQL ─► /growatt/plants* (DB only)
                 │                                                       └─► daily summaries ─► Firestore
                 ├─ plant/energy, plant/power, inverter day_energy (finished days) ─► growatt-worker (00:50) ─► SQL
                 ├─ plant/details, queryDeviceInfoParam, device/all/create_date ─► growatt-worker (fleet 05:30; weekly / monthly / once) ─► registry
                 ├─ env_data today (one sensor) ─► backend memory cache (300 s) ─► /growatt/live/sensors/{dl}/{addr}/today ─► sensor page chart (today only)
                 ├─ env_data sensor history ─► growatt-worker (every 10 min with history; `env_history` only fills gaps, 05–20) ─► SQL
                 ├─ ammeter meter_last_data (one plant's meter) ─► backend memory cache (per meter, ≥ 270 s) ─► /growatt/live/plants/{id}/meter
                 │              (grid import / export now; load = PV + grid derived from the /latest cache; never stored)
                 ├─ ammeter meter_data (grid-point meter, every plant) ─► growatt-worker (with history) ─► SQL
                 │              ─► overview / power curve: grid import / export (measured), load = PV + grid (derived)
                 └─ alarm_data log ─► growatt-worker (10-min tick, 05–20, per inverter by tier: fault/open 10 min,
                                  alarms today 30 min, none 60 min; yesterday in full at 00:30) ─► SQL ─► /growatt/alarms (Active Alarm)
                                  └─► new alarm events ─► FCM web push (worker, after each `alarms` run) ─► devices of the users who may see the plant
API + worker logging ─► app_logs (SQL, redacted, 14 days) ─► /system/logs (admin: System → Logs)
Longdo weather radar ─┬─ layer/list snapshots + legend ─► backend memory cache (120 s) ─► /growatt/live/rain-radar ─► Plant Map radar
  (radar-derived)     │              (the browser loads the radar tiles from Longdo itself, with the Longdo Map key; never stored)
                      ├─ location + forecast/location + area + forecast/area (one ~1 km cell, 10 km circle) ─► backend memory cache (300 s)
                      │              ─► /growatt/live/plants/{id}/rain (rain class 0–5 now, +15 / +30 min, rain nearby; only for the plant selected on the map; never stored)
                      └─ area per 1° region, then location per plant cell where the region has rain ─► memory sweep (20 calls/request, 30 min)
                                     ─► /growatt/live/rain (rain class now over every plant; only while the map's radar is on; never stored)
RainViewer (fallback) ─── weather-maps.json snapshot list ─► backend memory cache (300 s) ─► /growatt/live/rain-radar
  (radar tiles only)               (only when Longdo has no key or nothing to serve; browser loads the tiles, zoom ≤ 7; no plant rain; never stored)
Geoapify (modelled) ─── routematrix + routing (drive, OpenStreetMap, free-flow) ─► backend memory cache (24 h, per point set / waypoints)
                                 ─► POST /growatt/routes/solve (Visit Route; credits capped per day, straight-line fallback; never stored)
Google Maps Weather ─┬─ current ─► backend memory cache (30 min per cell) ─► /growatt/live/plants/{id}/google-weather
  (modelled)         ├─ current at each PWA check (08:50/12:50/16:50, every cell) ─► growatt-worker ─► frozen check slot ─► sheet สภาพอากาศ
                     └─ history/hours ─► growatt-worker (18:15 daily) ─► SQL ─► daily summaries (rain at 09/12/17) ─► Firestore
```

Rules for every layer:

1. **Never store realtime values.** Live data stays in memory only: the API process, mirrored in Redis on the VM (`REDIS_URL`; no persistence, every key expires, `services/live_store.py`) so a Cloud Run cold start stays warm. SQL gets only source-timestamped history (Growatt records, Google Weather hours).
2. **Firestore holds only daily summaries and the static registry** (`plants/`, `inverters/`, and global settings under `config/`, e.g. `config/fleet_module`). The project `tcroof-string-analysis` runs on the free Spark plan (20k writes/day). Each day costs about 1,250 writes (about 250 per publish of today: at 08:50, 12:50 and 16:50 for the PWA report checks and at 19:30, plus about 235 when `google_weather` re-publishes yesterday), capped at `PUBLISH_DAILY_WRITE_BUDGET`.
3. **Never invent numbers.** Missing measurements are `null` and show as "—". Don't add data with no source (irradiance only where a plant has a weather sensor; grid import / export only from the plant's energy meter), and label modelled or derived values as such (load = PV + grid is derived, never measured).
4. **The Growatt tokens and the Google Weather key stay on the backend.** Firebase service-account keys go in `secrets/`, which is gitignored. The Firebase web app config and Web Push key (`FIREBASE_WEB_*`, `FIREBASE_VAPID_KEY`) are public by design and reach the browser through `/push/status`. The Longdo Map key (`LONGDO_API_KEY`) is a browser key too: radar tiles are loaded by the browser, so signed-in users get it in the tile URL from `/growatt/live/rain-radar`; restrict it by domain in the Longdo Map console.

## Deploy (GCP, budget ฿1,000/month)

`deploy/gcp.sh setup | backend | frontend | all | upsize | ip | snapshots | costguard | monitoring | ai` (see header of the script). **Production settings live in `deploy/gcp.config`**; sizing, costs and the cost cap are in `docs/plans/gcp-production.md`.
- **Frontend:** Firebase Hosting. `firebase.json` rewrites `/api/**` to Cloud Run.
- **API:** Cloud Run service `tcroof-api` in us-central1. It runs min 0 / max 1 instance (scales to zero; a cold start of a few seconds after idle) and gets its secrets from Secret Manager.
- **Postgres + `growatt-worker` + Redis:** VM `tcroof-db` (`e2-standard-2`, 8 GB) running `deploy/vm/compose.yml` from `/opt/tcroof`. It has a static internal IP and a static external IP (`tcroof-db-ext`, the worker's outbound address); ports 5432 and 6379 are reachable only inside the VPC (firewall rules `tcroof-allow-postgres-internal` / `-redis-internal`), both with a password. Redis (256 MB, no persistence) mirrors the API's live cache at no extra cost; its password and URL are the secrets `tcroof-redis-password` / `tcroof-redis-url`. The disk is 100 GB `pd-balanced` to hold 90 days of raw readings for 629 inverters; the `retention` job deletes older readings. Postgres memory settings are written to the VM's `.env` by `deploy/gcp.sh backend` for the VM's machine type.
- **Backups:** weekly disk snapshots only (policy `tcroof-db-weekly`, Sunday 02:00 Bangkok, kept 28 days); restore steps are above `cmd_snapshots`.
- **Cost cap:** budget `tcroof-monthly` (฿1,000 since 2026-11-21; planned spend ≈ ฿2,566, so the guard trips partway through each month) emails at 50/90/100 %; the `tcroof-cost-guard` function (`deploy/costguard/`) **disables billing on the project at 96 % (฿960)**, which stops everything until an admin re-links billing (disks and snapshots are kept).
- **Alerts:** email when `/api/health` or `/api/health/worker` (no finished `history` run in 2 h) fails, or the VM disk is over 85 % (Ops Agent).
- **AI Assistant:** `deploy/gcp.sh ai` puts `AI_API_KEY` from `.env` into secret `tcroof-ai-api-key` (run again after rotating the key), then `backend` passes it to Cloud Run with `AI_*` settings from `gcp.config` (model, enabled roles, $5 cap, 15/day, 110 s turn timeout). No secret = assistant off. `frontend` builds the chat to call the Cloud Run URL directly (`VITE_ASSISTANT_API_BASE_URL`), because Hosting's `/api` rewrite buffers the SSE stream and cuts requests at 60 s; every other call still goes through `/api` on Hosting.
- **Alarm push notifications:** off until the four `FIREBASE_WEB_*` / `FIREBASE_VAPID_KEY` values in `deploy/gcp.config` are filled (Firebase web app config + Web Push certificate key, both public); then `backend` passes them to Cloud Run and enables the FCM API. The worker on the VM sends with the Firebase service account it already has; FCM is free and writes nothing to Firestore.
- **Production login:** `APP_ENV=prod` seeds only the admin from secret `tcroof-admin-password` (created by `setup`, or from `ADMIN_PASSWORD` in `.env`). There are no demo accounts.
- **Why not Cloud SQL:** a comparable instance (2 vCPU / 8 GB) costs well over ฿3,000/month, and history grows by about 0.5 GB/day (629 inverters), which rules out the free Postgres tiers.

## Config

`.env` is read by pydantic-settings in `backend/app/config.py`; `.env.example` lists the keys. The main ones:
- `DATABASE_URL`
- `GROWATT_TOKEN_PHASE1`..`4`: one Growatt account per project phase. The legacy `GROWATT_API_TOKEN` is used as phase 1 when `GROWATT_TOKEN_PHASE1` is empty.
- `GROWATT_BLOCKED_PLANT_IDS` (comma separated; production: `BLOCKED_PLANT_IDS` in `deploy/gcp.config`): Growatt plants the app ignores. They are left out of every `plant/list` answer (registry and live), and the worker removes their registry rows (with inverters, readings, alarms, issues) at start and on each `fleet` run. A single inverter Growatt lists but that is not on site is marked "not installed" by an admin instead (kept in the registry, left out of every job, live call, count and analysis; backend/CLAUDE.md)
- `GROWATT_LIVE_TTL_S`
- `REDIS_URL` (empty = memory only): Redis mirror of the live caches and Growatt / Google cooldowns
- `SENSOR_STATUS_TTL_S` (300), `SENSOR_SWEEP_PER_REQUEST` (12), `SENSOR_LATE_MIN` / `SENSOR_OFFLINE_MIN` (15 / 60), `SENSOR_INACTIVE_DAYS` (30; last upload older = Inactive: an entry Growatt still lists that stopped uploading, not an alarm; 0 = off): Weather Sensors live status (`env_list` per datalogger, memory only, swept only while the page is open); `SENSOR_ALARM_COVERAGE_PCT` (80): Active Alarm, past day: stored daylight coverage below this = data gap
- `PLANT_TODAY_TTL_S` (300), `PLANT_TODAY_SWEEP_PER_REQUEST` (40): plant directory Yield today (`plant/data` per plant, memory only, swept only while the directory is open)
- `INVERTER_SNAPSHOT_TTL_S` (300), `INVERTER_SNAPSHOT_SWEEP_PER_REQUEST` (4): fleet inverter snapshot (`maxs_data`, 50 inverters per call, memory only)
- `KB_ASSETS_BUCKET` (empty = local folder `KB_FILES_DIR`, default `data/kb_files`; prod refuses uploads without a bucket), `KB_MAX_UPLOAD_MB` (30), `KB_FILE_URL_TTL_S` (3600), `KB_OCR_LANGS` (`tha+eng`), `KB_OCR_DPI` (300), `KB_OCR_PAGES_PER_RUN` (150), `WORKER_KB_OCR_INTERVAL_MIN` (30): Knowledge Base PDF library (docs/plans/kb-documents.md). Files are stored unchanged (SHA-256 kept) in object storage, never in SQL or Firestore; SQL keeps metadata, page text and links. Scanned pages are OCR'd by the worker's `kb_ocr` job (tesseract, installed in the backend image)
- `LOG_DB_ENABLED` (true), `LOG_DB_LEVEL` (INFO), `LOG_RETENTION_DAYS` (14), `LOG_MAX_ROWS` (500000), `LOG_FLUSH_INTERVAL_S` (5), `LOG_BUFFER_MAX` (5000), `LOG_SLOW_REQUEST_MS` (5000): System → Logs (`app_logs`)
- `FIREBASE_PROJECT_ID` and `FIREBASE_CREDENTIALS_FILE`
- `PUBLISH_SINK` (`json` | `firestore`)
- `PUBLISH_DAILY_WRITE_BUDGET`
- `WORKER_HISTORY_INTERVAL_MIN` (10; production: `HISTORY_INTERVAL_MIN` in `deploy/gcp.config`)
- `METER_HISTORY_ENABLED` (true): `history` / `backfill` also sync each plant's energy-meter records (`meter_data`) into `growatt_meter_readings`; false skips it
- `WORKER_HISTORY_BATCH_SIZE` (0 = off): `history` reads today's records of this many inverters per call (`queryDevicesHistoricalData`), falling back to `max_data` per inverter; off by default (a call returns each inverter's whole day so far)
- `HISTORY_RETENTION_DAYS` (90), `HISTORY_STRING_RETENTION_DAYS` (30): per-string 5-min readings (`growatt_string_readings`, the largest computed table) are kept the shorter time; daily string rows and everything computed from them stay 90 days
- `HISTORY_STORE_RAW` (true), `HISTORY_RAW_RETENTION_DAYS` (7): `history` also keeps every field of each `max_data` record as Growatt reports it (`growatt_inverter_raw`, about 4 kB a record; `/growatt/plants/{id}/inverters/{sn}/raw`)
- `WORKER_ALARMS_TICK_MIN` (10), `WORKER_ALARMS_HOT_MIN` / `_WARM_MIN` / `_COLD_MIN` (10 / 30 / 60), `WORKER_ALARMS_START_H` / `_END_H` (5 / 20): alarm log sync. Each tick reads only the inverters due by tier (hot = open alarm or fault status, warm = alarms today, cold = none); skipped 08/12/16:42–:51 for the PWA checks
- `WORKER_ENV_INTERVAL_MIN` (10, 0 = off), `WORKER_ENV_START_H` / `_END_H` (5 / 20): `env_history`, weather-sensor history between `history` runs
- `WORKER_LATEST_INTERVAL_MIN` (0 = off, at least 5), `WORKER_LATEST_START_H` / `_END_H` (5 / 20): `inverter_latest`, each inverter's newest record (`maxs_data`) into the history tables between `history` runs. It uses the same per-account `maxs_data` window as the fleet inverter snapshot
- `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_VAPID_KEY` (any empty = off): alarm push notifications (FCM web push; `/push/*`, `services/push.py`). `PUSH_ALARM_LEVELS` (`fault`), `PUSH_ALARM_MAX_AGE_MIN` (90), `PUSH_ALARM_REPEAT_MIN` (120), `PUSH_MAX_PLANTS_PER_USER` (5): which alarm events are pushed. SQL keeps only device tokens (`push_tokens`) and what was pushed (`alarm_push_marks`)
- `CHECK_OFFSET_MIN` (10), `PWA_HISTORY_LEAD_MIN` (3), `PWA_FAULT_LOOKBACK_MIN` (60), `PWA_IGNORE_WARN_CODES` (`1`; a reading's own warning codes the DATA LOG does not report, also in check slots frozen before the setting existed; alarm-log records of the code still show): PWA report checks 09 / 13 / 17. Snapshot at hh:00 − offset (08:50), `history` pulled just before; the DATA LOG lists only the alarm messages from snapshot − look-back (07:50) to the snapshot (08:50)
- `APP_ENV` (`dev` | `prod`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`
- `GOOGLE_WEATHER_API_KEY` (Secret Manager `tcroof-google-weather-key`), `GOOGLE_WEATHER_MONTHLY_BUDGET` (30000; PWA checks 687 + history 229 calls/day ≈ 28.4k/month, over the 10k free tier); each day gets what is left of the month ÷ days left. `GOOGLE_WEATHER_DAY_START_H` / `_END_H` (6 / 18): daytime-only hours stored and fetched live
- `LONGDO_API_KEY` (Secret Manager `tcroof-longdo-key`, created by `deploy/gcp.sh setup` from `.env`; empty = off), `LONGDO_RADAR_TTL_S` (300), `LONGDO_RAIN_TTL_S` (300), `LONGDO_AREA_RADIUS_KM` (10), `LONGDO_TIMEOUT_S` (6), `LONGDO_FLEET_RAIN_TTL_S` (1800), `LONGDO_RAIN_SWEEP_PER_REQUEST` (20): Longdo weather radar on the Plant Map (https://weather.longdo.com/docs): radar tiles with playback, radar rain over every plant now, and for the selected plant now / +15 / +30 min plus rain within 10 km. Radar-derived, memory only. Longdo allows 100,000 calls/month and 60/min per key: `LONGDO_MONTHLY_BUDGET` (60000) and `LONGDO_CALLS_PER_MIN` (30) cap the backend's own calls (each day gets what is left of the month ÷ days left; over it, the last values are served as stale); `LONGDO_INTERACTIVE_RESERVE_PER_MIN` (8) of those per-minute calls are kept from the fleet sweep for the selected plant and the snapshot list; the rest is left for the tiles the browsers load, which the backend cannot count
- `RAINVIEWER_ENABLED` (true), `RAINVIEWER_TTL_S` (300), `RAINVIEWER_TIMEOUT_S` (6): RainViewer radar tiles (no key) on the Plant Map when Longdo is not configured or its snapshot list fails with nothing cached (`fallback_reason`, `point_rain: false`, credit on the map). Tiles only, zoom ≤ 7; the free API is for personal / educational / small community use with no SLA
- `GEOAPIFY_API_KEY` (empty = straight-line estimates only; production: Secret Manager `tcroof-geoapify-key`, not set up yet), `GEOAPIFY_DAILY_CREDITS` (2800; the free plan gives 3,000 a day), `GEOAPIFY_TIMEOUT_S` (8), `GEOAPIFY_COOLDOWN_S` (60), `ROUTE_SOLVE_PER_MIN` (10 per user): Visit Route drive times (docs/plans/site-visit-route.md). A backend key; the browser never sees it. The map must show "Powered by Geoapify" and "© OpenStreetMap contributors"
- `AI_API_KEY` (Secret Manager `tcroof-ai-api-key`; empty = off), `AI_BASE_URL` (Qwen Cloud Singapore, Anthropic-compatible), `AI_MODEL` (`qwen3.7-plus`), `AI_THINKING` (false; Qwen thinks by default and takes 30–90 s), `AI_MONTHLY_BUDGET_USD` (5), `AI_USER_DAILY_QUESTIONS` (15), `AI_ENABLED_ROLES`, `AI_PRICE_*`: AI Assistant (`/assistant/*`, docs/plans/ai-assistant.md). Conversations stay in the browser; only token counts and cost go to SQL `ai_usage`

Firebase CLI config is in `firebase.json`, `.firebaserc` and `firestore.rules`. The rules deny all browser access; the backend writes through the Admin SDK. Use `bunx firebase-tools`.
