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
  - `charts.py` (Plotly) and `reporting.py` (PDF, Excel and HTML reports).
  - `growatt.py`: the Growatt OpenAPI client and `parse_max_records`.
  - `storage.py` is legacy and used only by `test_solar_core.py`.
- **`app/`**: FastAPI.
  - Routes are in `api/routes/*`, ORM models in `db/models.py`, request/response schemas in `schemas/api_schemas.py`.
  - Business logic lives in `services/*`. Keep route functions thin: they call a service and translate its exceptions into `HTTPException` (for example, `GrowattNotFound` becomes 404).
  - Every router is mounted twice, at `/api` and at `/`.
  - Auth is JWT (`app/auth.py`) with the roles `admin`, `engineer` and `viewer`. Mutating endpoints depend on `require_write_access`.

**Analysis pipeline** (`services/solar_service.py`):
1. ORM rows become a DataFrame, and `Plant` + `string_specs` become a `PlantConfig`.
2. `run_pv_string_analysis` runs.
3. Results are stored on `AnalysisRun` as JSON columns.
4. `reconstruct_analysis_results` rebuilds them for charts and reports.

**Ingestion**:
- Every source must end up as the long-format columns in `solar_core.models.CANONICAL_COLUMNS`. `normalize_dataframe()` also accepts wide SCADA input (`PV1_U` / `pv1_u` …).
- `POST /plants/{id}/datasets/{upload|fetch|simulate}` → `store_dataset_from_dataframe` → `execute_and_store_analysis`.

## Growatt data rules

**Live and persisted data never mix.**

| Path | Code | Rule |
|---|---|---|
| `/growatt/live/*` | `services/growatt_live.py` | Memory only (TTL `GROWATT_LIVE_TTL_S`, 120 s). On failure it serves the last value marked `stale`; on error 10012 it waits 60 s. **Never write live values to SQL or Firestore.** |
| `/growatt/plants*` | `services/growatt_overview.py` | DB only, `?day=`, `meta.source = "db"`. Never calls Growatt. |
| SQL history | `services/growatt_sync.py` | Idempotent upserts. Started by the worker or the CLI. |
| Firestore | `services/daily_summary.py` | Daily summaries and the static registry only, about 250 writes a day. |

- **Project phases = Growatt accounts.** Each of the 4 phases has its own token (`settings.growatt_accounts()` → `{phase: token}`).
  - `fleet` lists every account and tags each plant with `growatt_plants.phase`.
  - `history` / `backfill` sync each phase's inverters with that phase's token. Live calls look up the plant's phase in the DB, and `/growatt/live/plants` merges every account.
  - `phase IS NULL` means not yet tagged; those plants use the first configured account. The worker re-runs `fleet` every 6 h while any plant is untagged.
  - Jobs run the accounts in parallel, one thread and one DB session each (`_per_phase`; `WORKER_PARALLEL_ACCOUNTS=false` runs them one by one). A failing account makes the run `partial`, and the run fails only when every account fails. `detail.phases` holds each phase's result.
- **Don't invent values.** If a measurement is missing, return `None` / `null`, not a typical-looking default. The same goes for things with no data source at all (grid import, load, irradiance): leave them out instead of modelling them as if measured. Label modelled values as modelled: the clear-sky `expected_kw`, the I-V curves, and the peer-relative `pr_pct`, which is *not* IEC PR because there's no irradiance data.
- **Record interval is mixed** (mostly 5 min, some inverters every 1–4 min). Integrate energy with `_integrate_kwh`, never `sum × 5 min`. To build a plant curve, average each inverter within its 5-min slot first, then sum across inverters.
- **Daily yield = `eac_today` from the day's last record.** The counter keeps yesterday's total for a few minutes after midnight, so `MAX()` is wrong.
- **MAX inverters:**
  - String data comes from `device/max/max_data` (POST, ≤ 7 days, `perpage` ≤ 100, newest first).
  - String *n* is on MPPT ⌈n/2⌉. `vString` is the MPPT voltage, while `currentString` is per string.
  - String rows are kept only while `ppv > 0`, because PID recovery holds about 60 V at night.
  - `device/list` returns each MAX twice (type 1 and type 4); merge them by serial.
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
| `retention` | 03:00: deletes raw readings older than `HISTORY_RETENTION_DAYS` (90) |

- Daily jobs fire only within 3 h after their slot.
- `services/jobs.py` holds the job bodies and the run log / lock (`sync_runs`).
- `GET /growatt/sync/status` and `POST /growatt/sync/{job}` cover the API side. **The API only queues a run** (`status = queued`); the worker starts it on its next tick (≤ 1 min). Never run jobs inside the API: on Cloud Run the CPU is cut after the response. A job that's already queued or running returns 409; a queued run nobody picks up within 2 h is marked failed.
- **Run `publish_today` at most twice a day.** An open day changes on every run, so each run rewrites about 250 Firestore documents.

## Production (`APP_ENV=prod`)

- Startup refuses to run without `ADMIN_PASSWORD` (≥ 12 chars) or with the default / short `JWT_SECRET_KEY`.
- Only one admin is seeded, from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Changing the secret resets that admin's password. Demo accounts still on their demo password are disabled, and no demo plant data is created (`SEED_DEMO_DATA` overrides).
- Every data router requires a signed-in user (`main.py`); only `/auth/login` and `/health` are open. Files (reports, CSV templates) are downloaded by the UI with `fetch` + token, not plain links.

## DB and migrations

- `DATABASE_URL` defaults to SQLite at `data/solar_fullstack.db`; Docker uses `postgresql+psycopg`.
- Startup (API and worker) calls `ensure_schema` (`db/session.py`): `create_all` plus `_ADDED_COLUMNS`, which adds new columns to existing tables. New tables and listed columns appear without Alembic. Still add a hand-written migration under `alembic/versions/` (chain `down_revision`) for Postgres.

## Tests

- **API tests** build an isolated SQLite DB in `tmp_path`, call `ensure_seeded`, and override `get_db`.
  - Override `get_live_service` with a fake client; tests must never hit the network.
  - Override `get_session_factory` for background jobs.
- **Growatt fixtures:** reuse `_seed_growatt` from `tests/test_growatt_routes.py`, which covers 1-min and 5-min inverters, the midnight counter carry-over, and an inverter with no data.
- **Seeded logins:** usernames `admin` / `admin123`, `engineer` / `engineer123`, `viewer` / `viewer123`. `POST /auth/login` takes `{username, password}` (`email` still accepted; either field matches a username or an email). Users created before usernames get one from their email's local part at startup.
