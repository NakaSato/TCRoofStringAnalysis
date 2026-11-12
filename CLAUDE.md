# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TC Roof Solar: a PV string performance and O&M suite. It has a FastAPI backend (`backend/`) and a React frontend (`frontend/`), and monitors a fleet of 43 Growatt plants (215 MAX inverters).

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

Seeded logins (username / password): `admin` / `admin123`, `engineer` / `engineer123`, `viewer` / `viewer123`. Login takes a username; an email is still accepted. There is no auto-login: the UI shows a login page until a user signs in.

## How data flows (Growatt)

```
Growatt OpenAPI ─┬─ realtime ─► backend memory cache (120 s) ─► /growatt/live/* ─► UI polls every 60 s
                 │              (never stored anywhere)
                 └─ max_data history ─► growatt-worker (every 30 min) ─► SQL ─► /growatt/plants* (DB only)
                                                                         └─► daily summaries ─► Firestore
```

Rules for every layer:

1. **Never store realtime values.** Live data stays in backend memory; SQL gets only Growatt-timestamped history.
2. **Firestore holds only daily summaries and the static registry.** The project `tcroof-string-analysis` runs on the free Spark plan (20k writes/day). Each day costs about 250 writes, capped at `PUBLISH_DAILY_WRITE_BUDGET`.
3. **Never invent numbers.** Missing measurements are `null` and show as "—". Don't add data with no source (grid import, load, irradiance), and label modelled values as modelled.
4. **The Growatt tokens stay on the backend.** Firebase service-account keys go in `secrets/`, which is gitignored.

## Deploy (GCP, sized for < $10/month)

`deploy/gcp.sh setup | backend | frontend | all` (see header of the script).
- **Frontend:** Firebase Hosting. `firebase.json` rewrites `/api/**` to Cloud Run.
- **API:** Cloud Run service `tcroof-api` in us-central1. It scales to zero, runs at most 1 instance, and gets its secrets from Secret Manager.
- **Postgres + `growatt-worker`:** free-tier e2-micro VM `tcroof-db` running `deploy/vm/compose.yml` from `/opt/tcroof`. It has a static internal IP, and port 5432 is reachable only inside the VPC. The disk is 100 GB (`DISK_GB`; 30 GB free, about $2.80/month for the rest) to hold 90 days of raw readings for 629 inverters; the `retention` job deletes older readings.
- **Production login:** `APP_ENV=prod` seeds only the admin from secret `tcroof-admin-password` (created by `setup`, or from `ADMIN_PASSWORD` in `.env`). There are no demo accounts.
- **Why not Cloud SQL:** it alone costs about $9+/month, and history grows by about 0.5 GB/day (629 inverters), which rules out the free Postgres tiers.

## Config

`.env` is read by pydantic-settings in `backend/app/config.py`; `.env.example` lists the keys. The main ones:
- `DATABASE_URL`
- `GROWATT_TOKEN_PHASE1`..`4`: one Growatt account per project phase. The legacy `GROWATT_API_TOKEN` is used as phase 1 when `GROWATT_TOKEN_PHASE1` is empty.
- `GROWATT_LIVE_TTL_S`
- `FIREBASE_PROJECT_ID` and `FIREBASE_CREDENTIALS_FILE`
- `PUBLISH_SINK` (`json` | `firestore`)
- `PUBLISH_DAILY_WRITE_BUDGET`
- `WORKER_HISTORY_INTERVAL_MIN`
- `HISTORY_RETENTION_DAYS` (90)
- `APP_ENV` (`dev` | `prod`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`

Firebase CLI config is in `firebase.json`, `.firebaserc` and `firestore.rules`. The rules deny all browser access; the backend writes through the Admin SDK. Use `bunx firebase-tools`.
