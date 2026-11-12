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

Seeded logins: `admin@tcroofsolar.com` / `admin123`, `engineer@…` / `engineer123`, `viewer@…` / `viewer123`.

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
4. **The Growatt token stays on the backend.** Firebase service-account keys go in `secrets/`, which is gitignored.

## Config

`.env` is read by pydantic-settings in `backend/app/config.py`; `.env.example` lists the keys. The main ones:
- `DATABASE_URL`
- `GROWATT_API_TOKEN`
- `GROWATT_LIVE_TTL_S`
- `FIREBASE_PROJECT_ID` and `FIREBASE_CREDENTIALS_FILE`
- `PUBLISH_SINK` (`json` | `firestore`)
- `PUBLISH_DAILY_WRITE_BUDGET`
- `WORKER_HISTORY_INTERVAL_MIN`

Firebase CLI config is in `firebase.json`, `.firebaserc` and `firestore.rules`. The rules deny all browser access; the backend writes through the Admin SDK. Use `bunx firebase-tools`.
