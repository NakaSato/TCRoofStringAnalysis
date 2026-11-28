# rust/CLAUDE.md

Guidance for the Rust port. Run cargo commands from **`rust/`**; run the scripts from the repo root.

`rust/` is a port of `backend/` (API and worker) to Rust, built side by side on `main` (not deployed). The plan, phases and exit gates are in **docs/plans/rust-port-master-plan.md**. Python in `backend/` stays deployed and is the oracle: when the two disagree, Python is right until the difference is understood. The port only adds `rust/`; it never changes `backend/` or `frontend/`.

Crates are added when their phase starts. Today: `crates/solar-core` (pure engine: sun, visit_route, om_planning, iv_analysis / iv_site_fit / iv_operating), `crates/clients` (Growatt OpenAPI client + parsers, Google Weather, Longdo, RainViewer, Google service-account tokens `google_auth`, the Firestore REST commit `firestore` and reads `firestore_read`, FCM HTTP v1 `fcm`, Sheets API v4 `google_sheets`; no caches or budgets, those live in `services`, except the token cache), `crates/db` (sqlx Postgres pool), `crates/services` (domain services: Growatt stored views; the live cache `live.rs` + `live_store.rs`, which has no database handle; live Google Weather, Longdo and RainViewer with their budgets; the worker's sync, `growatt_sync/`, `growatt_energy_sync`, `alarm_sync`; publish, `daily_summary`, `check_slots`, `publish`; `google_weather_history`, `pwa_report`, `pwa_sheet`, `push`, `fault_push`), `crates/worker` (`tcroof-worker`: backend/app/worker.py + the run log / lock of services/jobs.py; Phase 4 jobs are ported, the rest fail their run with the phase that ports them) and `crates/api` (Axum; `/health`, `/health/worker`, `/auth/*`, `/users*`, `/system/logs*`, `/growatt/*` of Phase 3, request logging into `app_logs`; auth dependencies as extractors in `extract.rs`).

## Commands

```bash
cargo build                                  # from rust/
cargo test
cargo clippy --all-targets -- -D warnings    # must be clean (check.sh fails otherwise)
cargo run -p tcroof-api                      # API on :8001 (RUST_API_PORT); reads the repo's .env

rust/scripts/schema.sh <postgres-url>        # build the schema by running Python's ensure_schema (+ seed users)
rust/scripts/test_pg.sh                      # cargo tests against a fresh Postgres 16
rust/tests/parity/run.sh                     # Golden-Diff: same requests to Python :8000 and Rust :8001, report diffs
PARITY_WEATHER=degraded rust/tests/parity/run.sh --cases rust/tests/parity/weather_modes/degraded.json   # also: off
# two runs at once: give each its own TEST_PG_PORT, PY_PORT, RUST_PORT, GROWATT_STUB_PORT, WEATHER_STUB_PORT
cargo run -p tcroof-worker -- --once retention  # one job now (also: --list; no args = the schedule loop)
rust/tests/worker_parity/run.sh [CASE ...]    # same job with Python's and Rust's worker on copies of one seeded DB, diff the rows (jobs.json, seed.d/)
# worker parity: two runs at once need their own TEST_PG_PORT, GROWATT_STUB_PORT, WEATHER_STUB_PORT, FCM_STUB_PORT, GOOGLE_STUB_PORT
```

Worker parity cases (`jobs.json`) can name `stubs` (`growatt`, `growatt_sync`, `weather`, `fcm` = FCM + OAuth token stub, `google` = OAuth token, Sheets and Firestore REST reads; each with a throwaway RSA key made per run), a per-case `seed` (SQL in `seed.job/`, applied after the shared `seed.d/`), `compare_sheets`, `detail_ignore` and `log_ignore`. Plant ids in seeds must not collide across files (`seed.d/` all load into one template). The Python worker runs through `py_worker.py` (FCM URL to the stub, refuses non-local endpoints) with `pyshim/sitecustomize.py` (Sheets URL, Firestore reads and the JSON sink folder to the stubs / temp folder); both workers send every HTTPS request to a dead proxy. Never run publish, push or sheet jobs with `tcroof-worker` outside the harness or `test_pg.sh`: a worktree's dotenv lookup finds the main `.env` (production Firebase, Sheets, paid Google Weather).

These three scripts are the entry points for database tests and parity; use them rather than hand-built databases. cargo needs network access the first time (crates.io).

## Rules

1. **Python owns the schema.** Tables, columns and indexes are created at API / worker start by `ensure_schema` in `backend/app/db/session.py` (`create_all` + `_ADDED_COLUMNS` etc.), with Alembic migrations kept in step for Postgres. Rust never creates or alters tables and has no migrations; its test and parity databases come from `rust/scripts/schema.sh`. A Rust replacement for `ensure_schema` is needed after cutover, before Python can ever be removed.
2. **Same configuration.** Read the same environment variables, with the same defaults, as `backend/app/config.py`. The only Rust-only settings are `RUST_API_PORT` (8001), so a shared `.env` cannot put Rust on Python's port, and three worker test hooks for endpoints Python hard-codes: `FCM_BASE_URL` (default `https://fcm.googleapis.com`), `PWA_SHEET_API_URL` (empty = Google's Sheets API) and `PUBLISH_JSON_DIR` (empty = `data/firestore_export`). Unset, each is the real endpoint, so a local worker run with the main `.env` pushes, fills the sheet and writes for real. Python's side of the same hooks lives in the harness (`py_worker.py`, `pyshim/sitecustomize.py`), never in `backend/`.
3. **Identical JSON contract.** Same paths, status codes, field names, types and null handling as the Python route, with every router mounted at both `/` and `/api`. The frontend is not changed for Rust.
4. **Name the source.** Every ported handler, service or query names the Python function it ports (file and function, in a comment), so the two can be compared and kept in step.
5. **Never invent numbers.** A missing measurement is `Option::None` and serializes as `null`; no `unwrap_or(0.0)` or plausible defaults. Modelled or derived values are labelled as in Python.
6. **Never store realtime values.** Live data stays in memory (and the Redis mirror), exactly as in the root CLAUDE.md data-flow rules; SQL gets only source-timestamped history.
7. **Parity before cutover.** A part replaces Python only after it passes `rust/tests/parity/run.sh` against the same database snapshot, for admin and engineer, and the phase's exit gate in the plan.
