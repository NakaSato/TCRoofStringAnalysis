# Master Plan: Port TC Roof Solar to Rust (Side-by-Side New Project)

Status: **In progress, not deployed** (written and reviewed 2026-11-27 against the repo and production measurements, §1.1 and §6; layout moved to `rust/` in this repository, §2). Phases 0–2 are done and every Phase 3 route is ported and at parity (progress notes under each phase in §5). `rust/` is on `main` as well as on branch `rust-port`; nothing deploys it. The §7 step 0 decision (Python freeze or same-week dual landing) is still open.
Constraint: **Do NOT delete the Python codebase.** The Rust code goes in a new `rust/` folder in this repository, next to `backend/`; Python keeps running in production until each part has passed parity and been cut over, and stays as the rollback afterwards. (An earlier draft used a sibling repository; §2 says why it changed.)

---

## 1. Executive Summary & Strategy

### Measured Baseline (Current Repo)
| Layer | Current Stack | Files | Lines |
|---|---|---:|---:|
| `backend/solar_core` | Python (NumPy/Pandas/math) | 19 | ~5,917 |
| `backend/app/db/models` | SQLAlchemy 2.0 (Postgres 16 / SQLite) | 20 | ~2,778 |
| `backend/app/services` | Python business logic & sync | 95 | ~35,780 |
| `backend/app/api/routes` | FastAPI (**267 endpoints**) | 39 | ~5,513 |
| `backend/tests` | Pytest (934 tests collected) | 80 | ~22,922 |
| `frontend/src` | React 19 + Vite + TypeScript + D3 | 360 | ~83,400 |

### Core Strategic Decisions
1. **Keep the React + TypeScript frontend unchanged:** one `frontend/`, served by whichever API is live; preserve the exact HTTP/JSON API contract (mounted at both `/api/*` and `/*`). Rewriting 83k lines of React/D3 UI in Rust/WASM adds high risk with little benefit; porting the ~50k-line Python backend + worker is where the gains would be. The measurements in §1.1 show the gain is **safety and maintainability** (compile-time checks, decision 4), not CPU, RAM or cost.
2. **Share the existing PostgreSQL 16 database schema directly:** Zero data migration. The Rust backend connects to the same Postgres 16 schema, which Python creates at startup (`ensure_schema`, §2), using `sqlx` compile-time checked queries.
3. **Keep Python as the behavioral oracle:** `backend/` stays deployed and is changed only for its own features and fixes, never removed during the port, so we can run a **Golden-Diff Parity Harness** comparing Python (`:8000`) vs Rust (`:8001`) against the same Postgres snapshot on every phase.
4. **Encode domain invariants in the Rust type system:** Prevent entire classes of bugs found in past audits (cross-plant IDORs, shadow-issue leaks, UTC vs Bangkok date mixups, missing `inverter_installed()` filters) via newtypes and typed query builders.

### 1.1 Measured Resource Use (Python, 2026-11-25 to 2026-11-27)

| Process | CPU | RAM | Source |
|---|---|---|---|
| Cloud Run API (1 vCPU / 1 GiB) | p50 1 %, p95 6 %, max 25 % | 51–53 % of 1 GiB (~530 MiB), steady | Cloud Monitoring, 2026-11-27 02:52–13:47 UTC, ~1,840 requests (the day production reopened, so a light day) |
| API imports (`import app.main`) | 2.3–3 s | 215 MB | local Mac |
| Worker (234 plants) | mean 4.9 % of a core, p95 11.7 % | median 207 MB, max 436 MB (`retention`); 1.2 GB on the first full pull | 24 h run, `data/exports/measure-2026-11-25` (SQLite) |
| `history` job | 6 min of each 10-min tick | | limited by Growatt's 10012 rate limit, not by Python |

- **Cold start:** the one cold start measured took 29.6 s from instance start to uvicorn ready; app startup was 0.5 s and the imports ~3 s. Most of the rest is Cloud Run pulling the 694 MB image for a new revision. One instance stayed up the whole window (UI polling and health checks keep it warm). Done in Python on 2026-11-27 (`e8af27b`, `ae90091`): heavy libraries load on first use (`import app.main` 2.1–3.4 s / 214 MB → ~1.0 s / 118 MB) and the API has its own image without tesseract, with `.pyc` compiled at build. Cold start after the next deploy is not measured yet.
- **What Rust would change (estimates, not measured):** API RAM to ~80–200 MiB (512 MiB limit becomes safe), worker RAM to ~30–80 MB, compute-heavy jobs (`rules_today` 16 s, daily rollups, I-V fits) several times faster.
- **What it would not change:** the VM (`e2-standard-2`, ฿1,663/month, the largest cost) is sized for the Postgres page cache (2 GB shared buffers, 5 GB effective cache), not for Python; Postgres and Redis load stay the same; `history` stays bound by Growatt. Expected saving: under ฿100/month (Cloud Run 1 GiB → 512 MiB).

---

## 2. Target Layout: a `rust/` folder in this repository

```text
TCRoofStringAnalysis/
├── backend/                    # Python: unchanged, still deployed; the only schema owner (ensure_schema + Alembic)
├── frontend/                   # one copy, served by whichever API is live
└── rust/
    ├── Cargo.toml              # workspace
    ├── crates/
    │   ├── solar-core/         # pure math, Growatt client/parsers, sun, I-V, TSP route, O&M dates (no DB/HTTP server)
    │   ├── db/                 # sqlx Postgres pool, models, typed PlantScope & InstalledOnly helpers
    │   ├── services/           # domain services (live cache, overview, rules, issues, stock, kb, assistant, etc.)
    │   ├── api/                # Axum HTTP server (Cloud Run binary)
    │   ├── worker/             # scheduled & queued background jobs binary (sync_runs locking)
    │   └── cli/                # admin CLI (backfills, Excel imports: pwa_meter, pvsyst, tfrs16, site_register)
    ├── .sqlx/                  # sqlx offline query data, regenerated from a DB built by rust/scripts/schema.sh
    └── tests/
        ├── integration/        # fresh-DB Postgres 16 tests (mirroring backend/tests/pg_plugin.py)
        └── parity/             # Golden-Diff harness: Python API (:8000) vs Rust API (:8001)
```

**Why in this repository, not a sibling one:**
- **Python keeps changing** (§6): a feature can land in `backend/` and `rust/` in the same commit, and the parity check runs on the same tree. Two repositories drift.
- **One frontend:** a copied `frontend/` would diverge from the first commit.
- **One schema owner:** Python. The API and worker build the schema at startup with `ensure_schema` (`backend/app/db/session.py`: `create_all` + `_ADDED_COLUMNS` etc.; backend/CLAUDE.md), and hand-written Alembic migrations are kept in step for Postgres. Rust never creates or alters tables; its test and parity databases are built by running `ensure_schema` (`rust/scripts/schema.sh`). After cutover a Rust replacement for `ensure_schema` is needed before Python can ever be removed.
- **Python is still untouched:** the port only adds `rust/`. Deleting the folder undoes it.
- **Costs:** a Rust toolchain for whoever builds it; the audit script (`.agents/skills/review-agent-changes/scripts/check.sh`) gets a third path scope (`rust/` → `cargo clippy` + `cargo test`), and `.dockerignore` / `deploy/cloudbuild.yaml` get a Rust image target.

---

## 3. Technology Mapping (Python → Rust)

| Python Component | Rust Replacement | Compatibility Notes |
|---|---|---|
| FastAPI + Pydantic | `axum` 0.8 + `serde` + `validator` + `tower-http` | Mount routers at `/api` and `/`; GZip + CORS + request logging |
| SQLAlchemy + psycopg + Alembic | `sqlx` (Postgres, async) + `sqlx-cli` | Compile-time SQL checks; use existing Postgres 16 schema |
| PyJWT + PBKDF2-HMAC-SHA256 | `jsonwebtoken` + `pbkdf2` + `hmac` + `sha2` | **Exact hash compatibility** with `pbkdf2_sha256$120000$<salt>$<hex>` — zero password resets |
| Redis `TieredDict` live cache | `moka` (in-process TTL) + `redis` crate | JSON-only mirroring, 30 s memory-only fallback on Redis error |
| `httpx` | `reqwest` (rustls-tls) | Growatt OpenAPI, Google Weather, Longdo, RainViewer, Geoapify, Telegram |
| `pandas` / `numpy` | Plain Rust iterators + `statrs` / `nalgebra` | Faster & lower memory for 5-min series, medians, regressions, I-V fits |
| `openpyxl` | `calamine` (read `.xlsx`) + `rust_xlsxwriter` (write `.xlsx`) | `site_register`, `pwa_meter`, `pvsyst`, `tfrs16` |
| `pypdfium2` + `tesseract` | `pdfium-render` (same PDFium library) or `lopdf` / `pdf-extract` + `tesseract` subprocess | KB PDF text layer + page rendering for the worker OCR job |
| `firebase-admin` (FCM + Firestore) | `gcp_auth` + `reqwest` (FCM HTTP v1 & Firestore REST) | Tiny binary, no heavy SDK |
| `anthropic` SDK (SSE) | `reqwest` + `eventsource-stream` | Streaming Messages API tool loop (`AI_BASE_URL`) |
| `uvicorn` + `app.worker` | Single static `api` + `worker` binaries (`tokio`) | Multi-stage `rust:1.85-slim` → `debian:bookworm-slim` / `distroless` |

---

## 4. Type-Safe Domain Invariants (Compile-Time Guardrails)

Encode the rules from `CLAUDE.md` / `backend/CLAUDE.md` directly into Rust types so bugs fail to compile:

1. **`PlantScope` enum:** `PlantScope::All` (admin) vs `PlantScope::Assigned(HashSet<i64>)` (engineer). Every plant-scoped repository function requires `&PlantScope` and returns `AppError::NotFound` (404, never 403) when unassigned.
2. **`ShadowPolicy` enum:** `ShadowPolicy::Hidden` (always for engineers) vs `ShadowPolicy::Visible` (admin opt-in). Enforced on issues, site events, calendar tasks, claims, field faults, and O&M dashboard.
3. **Distinct time types:**
   - `BangkokDate(NaiveDate)` and `PlantLocalTime(NaiveDateTime)` for reading tables and plant-local day boundaries (`Asia/Bangkok`, UTC+7).
   - `UtcTime(DateTime<Utc>)` for `TIMESTAMPTZ` bookkeeping columns (`timezone=True` in the models). Postgres keeps the offset, so the SQLite workaround `jobs._aware` (naive values read back as UTC) is not ported.
   - Forbids naive `Utc::now().date_naive()` where `BangkokDate::today()` is required.
4. **Device ownership verification:** Any route accepting `(plant_id, device_sn)` must resolve a validated `PlantInverter { plant_id, device_sn }` before querying readings (eliminates cross-plant IDORs).
5. **No invented numbers / no `NaN`:** Missing measurements remain `Option<f64>::None` (`null` in JSON). `serde_json` naturally rejects `NaN`/`Inf`.
6. **Live vs Persisted separation:** `crates/services/src/live/` has **no `&PgPool` write access** — impossible to accidentally persist live Growatt data to SQL.

---

## 5. Phased Porting Roadmap

Each phase ends with: `cargo clippy -- -D warnings`, `cargo test` against Postgres 16, and **Golden-Diff Parity** against the Python API.

### Phase 0 — Workspace Bootstrap & Parity Harness (Week 1)
**Progress: done** (2026-11-27, `a743d09`, `e68b407`): Cargo workspace in `rust/`, `crates/db` + `crates/api` on `:8001`, `check.sh` has the `rust/` scope. `rust/scripts/schema.sh` (Python `ensure_schema` + seed), `rust/scripts/test_pg.sh` (fresh Postgres 16 per run, a template database copied per test) and `rust/tests/parity/run.sh` (one copy of a seeded template per backend, a stub Growatt server for live cases; it blanks `PUBLISH_SINK`, Firebase, the Growatt tokens, `REDIS_URL`, `GOOGLE_WEATHER_API_KEY` and `LONGDO_API_KEY`, disables RainViewer and points the weather base URLs at stubs, so a run cannot reach production or a paid API, even from a worktree, where Rust's dotenv lookup finds the main checkout's `.env`) are the entry points. Every port and stub is configurable (`TEST_PG_PORT`, `PY_PORT`, `RUST_PORT`, `GROWATT_STUB_PORT`, `WEATHER_STUB_PORT`; a busy one moves to the next free port), so two runs can share a machine.

- Create `rust/` with the Cargo workspace (`solar-core`, `db`, `services`, `api`, `worker`, `cli`); add `rust/target/` to `.gitignore`.
- Check the frontend against the Rust API with the Vite proxy pointed at `:8001` (`frontend/vite.config.ts`); no copy of `frontend/`.
- Schema: `rust/scripts/schema.sh` runs Python's `ensure_schema` (and the user seed) on a fresh Postgres 16, then `cargo sqlx prepare` in `rust/`. No `pg_dump` baseline and no Rust migrations.
- Audit script: add the `rust/` path scope to `check.sh`.
- Build a Postgres 16 test fixture harness (fresh DB per test, mirroring `backend/tests/pg_plugin.py`).
- Build `tests/parity/` CLI: replays a suite of admin + engineer requests against Python (`:8000`) and Rust (`:8001`) on the same DB snapshot and reports any status, key, or numeric diffs.

### Phase 1 — Core Foundation, Auth & System Ops (Week 2)
**Progress: done** (2026-11-27, `da1fc83`): auth dependencies as Axum extractors (`extract.rs`: `CurrentUser`, `WriteUser`, `AdminUser`, `StoreKeeper`, `PlantScope`; rejection order 401 → 403 → 422 → 404 as in FastAPI), `/users*`, `/system/logs*`, request logging into `app_logs`. PBKDF2 hashes and JWTs are interchangeable with Python's. Parity 131/131. Known differences: 422 bodies (`{"detail"}` instead of FastAPI's field list, same status), a 500 is JSON, no 307 trailing-slash redirect, a signed token without `exp` is rejected.

- Config (`envy` / `dotenvy` reading the exact same `.env` variables as `backend/app/config.py`).
- Auth: PBKDF2-SHA256 verification + JWT sign/verify, `get_current_user`, `require_admin`, `require_plant_read/write`, `allowed_plant_ids`, `can_manage_stock`.
- Routes: `/health`, `/health/worker`, `/auth/*`, `/users/*`, `/system/logs*`, request logging middleware (`app_logs` + `app.audit`).
- **Exit gate:** Existing users log in with existing passwords; frontend loads shell & Settings → Users cleanly.

### Phase 2 — Pure Engine (`crates/solar-core`) (Weeks 3–4)
**Progress: done** (2026-11-27, `a743d09`, `da1fc83`). `crates/solar-core`: `sun`, `visit_route` (with CPython's random stream for the heuristic starts), `om_planning`, `iv_analysis`, `iv_site_fit`, `iv_operating` (numpy's polyfit / lstsq / interp / gradient re-implemented; one known rounding tie, `KNOWN_ROUNDING_TIES`). `crates/clients`: all 30 `GrowattClient` endpoints and the 8 parsers (746 fixture cases equal), Google Weather, Longdo, RainViewer (3,049 fixture cases equal); their caches and budgets belong to the services (Phase 3). Not ported, because only the legacy modules use them (Phase 7): `analysis`, `charts`, `ingestion`, `models`, `om_management`, `storage`. Python bugs found: `parse_max_records` stores missing values as 0; the Growatt client cache never evicts; an all-zero I-V curve crashes the analysis (`LinAlgError`); a user id above int4 is a 500.

Port all 19 files (~5.9k lines) with zero DB/HTTP server dependencies:
- `growatt/client.py` + `growatt/parsers.py` (all Growatt OpenAPI endpoints + `max_data`, `env_data`, `meter_data`, `alarm_data` parsers).
- `sun.py` (NOAA sunrise/sunset + Haurwitz clear-sky GHI).
- `iv_analysis.py` + `iv_site_fit.py` (IEC 60891 Procedures 1–4, STC translation, fault classification).
- `om_planning.py` (recurring schedule & working-day date math).
- `visit_route.py` (Held-Karp exact ≤ 10 stops, NN + Or-opt + 2-opt).
- External read clients: Google Weather, Longdo radar, RainViewer.
- **Exit gate:** 100% of pure unit tests from `backend/tests/` ported and matching Python outputs to `1e-6`.

### Phase 3 — Growatt Stored Views & Live Services (Weeks 5–7)
**Progress: all 45 routes ported** (2026-11-27, `db4c694`, `7950f13`, `bc67e58`, merged in `57b592d`): new crate `crates/services`. Stored routes: plants, inverters, overview, power, sync, inverter timeseries / raw / daily, string detail (with the `PlantInverter` ownership check), weather, stored Google Weather, curtailment, sensors, alarms, devices, fleet module, string layout, installed flag, tariff, documents. Live routes: `/live/plants`, `/live/plants/today`, `/live/inverters/snapshot`, `/live/plants/{id}/latest`, `/live/plants/{id}/alarms`, `weather`, `meter`, `strings/operating` (thresholds read at compile time from `backend/app/services/string_live_criteria.json`), `sensors/status`, `sensors/{dl}/{addr}`, `sensors/{dl}/{addr}/today`, `google-weather` (live, with the monthly budget), `rain-radar` (Longdo, RainViewer fallback), `rain`, `plants/{id}/rain` (Longdo budget, per-minute limit, interactive reserve). `live_store` uses the same Redis keys and JSON as `TieredDict`, so the two APIs can share a Redis at cutover. Parity 555/555 (plus weather modes `PARITY_WEATHER=degraded` 14/14 and `off` 10/10, against `weather_stub.py`), 243 tests on Postgres 16, clippy clean. The exit gate is met route by route; the page-level check (the frontend against `:8001`) is not done yet. Deviations: the Google billing day (US/Pacific) is computed from the US daylight-saving rule instead of a time-zone database; Rust cache ages use the wall clock where Python without Redis uses `monotonic`. Python bugs found: string detail did not check the inverter belongs to the plant (fixed in Python, `6c893e1`); saving a string layout does not clear the wired-inputs cache; a tariff plant key like `"²"` passes validation and then makes `GET /tariff` a 500 for engineers; plants on a phase with no token make the live pages poll every 15 s forever.

- Stored DB-only services (also `daily_checks`, `drive_match`, `inverter_install`, `system_logs`, `users`): `growatt_overview`, `growatt_strings`, `growatt_layout` (with cache invalidation), `growatt_inverter_history`, `growatt_weather`, `growatt_meter`, `growatt_curtailment`, `growatt_sensors`, `growatt_alarms`, `devices`, `device_checks`, `fleet_settings`, `tariff`, `inverter_models`, `plant_documents`.
- Live memory/Redis services (`growatt_live`): `TieredCache` (`moka` + `redis`), single-flight coalescing, per-key cooldowns (10012 = 60 s), `device_gap_s` (270 s), night TTL stretching, parallel inverter/account fetching, `live_string_check`, `string_operating`, `google_weather` live, `longdo_weather` + `rainviewer`.
- **Exit gate:** Fleet Directory, Plant Map, Plant Overview, Inverters, String Detail, Weather Sensors, Active Alarm, and Devices pages pass full Golden-Diff parity against Python.

### Phase 4 — Background Worker & Sync Engine (`crates/worker`) (Weeks 8–9)
**Progress:** started 2026-11-27, in three waves:
- **4.1 Worker and harness: done** (`33a8381`, merged in `75537ee`). `crates/worker` (`tcroof-worker`: `--once JOB`, `--list`, or the loop) with `sync_runs` locking, the queue, `fail_abandoned`, the scheduler and the per-account runner `phases::per_phase`. All 25 job names exist; a job not ported yet fails its run with `not_ported` in the detail, never `ok`. `retention` is ported (`services/retention.rs`). Worker parity harness `rust/tests/worker_parity/run.sh [job]` (jobs and compared tables in `jobs.json`, seeds in `seed.d/`): the same job in Python and in Rust on two copies of one seeded database against the stub servers, then the rows each wrote, `sync_runs` and `app_logs` are diffed. `retention` equal, 258 tests on Postgres 16. Differences: the Rust worker never calls `ensure_schema`; `remove_blocked_plants` at worker start waits for 4.2 (a warning is logged when `GROWATT_BLOCKED_PLANT_IDS` is set); a database error is named `DatabaseError`, and a failed run keeps only the error text, not a traceback. Open for 4.3: Python's JSON publish sink writes under the fixed `config.DATA_DIR`, so the harness cannot yet point it at a temporary folder.
- **4.2 Growatt sync:** `history`, `env_history`, `inverter_latest`, `backfill`, `power_limits`, `growatt_energy`, `energy_backfill`, `alarms`, `alarms_yesterday` (`services/growatt_sync/`, `growatt_energy`, the alarm log sync).
- **4.3 Publish and push:** `publish_today`, `publish_yesterday` (`daily_summary`, `check_slots`; Firestore REST sink and JSON sink), `pwa_sheet`, `google_weather`, `push_test`, `faults_push`, the alarm push after `alarms`.

The jobs that need services from later phases are ported with those phases: `rules_*`, `epi_refit` (Phase 5), `om_*` (Phase 6), `kb_ocr` (Phase 7). So the Python worker stays the only production worker until Phase 7, and the Phase 4 exit gate is checked locally with the harness.

- `sync_runs` job locking, queue polling, and scheduler (`app.worker` equivalent).
All 25 jobs of `JOBS` in `backend/app/services/jobs.py`:
- Growatt sync (parallel per phase): `fleet`, `history`, `env_history`, `inverter_latest`, `backfill`, `power_limits`, `growatt_energy`, `energy_backfill`, `alarms`, `alarms_yesterday`.
- Publishing and reports: `publish_today`, `publish_yesterday` (Firestore daily summaries via `services/daily_summary.py`, check slots frozen via `services/check_slots.py`), `pwa_sheet`, `google_weather`, `retention`.
- Rules and fits: `rules_today`, `rules_yesterday`, `rules_backfill`, `epi_refit`.
- O&M and KB: `om_plans`, `om_reminders`, `om_weekly`, `kb_ocr`.
- Push: `push_test`, `faults_push`, and the alarm push after each `alarms` run (FCM HTTP v1).
- Telegram group alerts are only a plan (`docs/plans/telegram-alerts.md`, not built in Python); port them only if they are built first.
- **Exit gate:** Worker runs a full local sync cycle + `alarms` + `push` (fake sender) cleanly against Postgres 16.

### Phase 5 — Decision Rules, Issues, Soiling & O&M Dashboard (Weeks 10–11)
- `growatt_daily` (`growatt_string_daily`, `growatt_inverter_daily`, `growatt_plant_daily`), `epi_fit`.
- `growatt_rules` (R1–R13 and R16–R18; there is no R14 or R15; ensuring `not_installed_sns` exclusion everywhere).
- `growatt_issues` (sync, auto-close, shadow isolation, parent linking).
- `soiling` (cleaning steps, R12 wallet, R13 rain recovery), `site_events`, `om_center` (O&M Dashboard loss attribution, work, response, claims).
- **Exit gate:** Running `growatt_daily` + `growatt_rules` + `om_center` on a real DB snapshot produces identical findings, issues, and dashboard KPIs as Python.

### Phase 6 — O&M Operations, Scanning & Spares Inventory (Weeks 12–14)
- Calendar Team: `om_calendar`, `om_plans`, `om_ics` (RFC 5545 feed), `om_reminders`, `om_suggestions`.
- Visit Route: `visit_route` (Geoapify + credit cap + straight-line fallback), `visit_route_candidates`, `route_offices`.
- Operational Registers: `claims`, `tools`, `site_register` (`.xlsx` import/export via `calamine` + `rust_xlsxwriter`), `faults` (field faults).
- Scanning & Spares: `scan` (resolver + `did_you_mean`), `scan_hints`, `scan_labels`, `scan_serials`, `stock`, `stock_failed`, `stock_replace`, `stock_count`, `stock_installed`, `stock_lookup`.
- **Exit gate:** All operational pages pass Golden-Diff parity + role scoping tests (admin, engineer, store keeper).

### Phase 7 — Knowledge Base, Finance/Reports & AI Assistant (Weeks 15–16)
- Knowledge Base: `kb` (Markdown articles + optimistic-lock revisions) and `kb_docs` / `kb_pdf` / `kb_storage` (PDF upload, text extraction, worker OCR, GCS/local HMAC signed URLs, page search).
- Reports & Finance: `pwa_report` + `pwa_sheet` (Google Sheet endpoint `X-Report-Key`), `pwa_meter` + `pwa_meter_model` + `pwa_meter_report`, `pvsyst`, `tfrs16`, `growatt_iv`.
- AI Assistant: `assistant` SSE streaming loop (`reqwest` + `eventsource-stream`) + all 10 read-only DB tools + `ai_usage` budget tracking.
- **Legacy admin-only modules (`plants`, `datasets`, `analysis`, `maintenance`, `rca`; `users` and `system` share their admin-only mount in `main.py` but are not legacy and are ported in Phase 1):** Recommended **not to port** unless still actively used — either retire them or keep them routed to Python until retired.

### Phase 8 — Shadow Deployment & Cutover (Week 17)
1. Deploy Rust `api` to a staging Cloud Run service pointing at a read-only replica / staging DB; run automated parity checks.
2. Run Rust `api` in production behind a traffic split (or read-only shadow mirror) while Python `worker` continues syncing.
3. Cut over `api` traffic to Rust; monitor latency, memory, error rates, and `app_logs`.
4. Stop Python `worker`, start Rust `worker` (only one worker runs at a time to avoid Growatt 10012 rate-limit contention).
5. Keep `backend/` and its images deployable as the rollback for 2+ weeks (switch Cloud Run back to `backend-api:<tag>`, the VM back to `backend:<tag>`). Remove Python only in a later, separate decision.

---

## 6. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Subtle floating-point / rounding drift in KPIs, rules, or curtailment | Dashboard numbers differ from Python | Golden-Diff parity tests on real DB snapshots per phase (`±1e-6` float tolerance, exact rounding rules) |
| Two workers running simultaneously (Python + Rust) | Growatt `10012` rate-limit collisions & duplicate pushes | Never run both workers against the same Growatt tokens; use `sync_runs` lock and strict cutover checklist |
| Excel/PDF edge cases (`openpyxl` vs `calamine`, Thai text in PDFs) | Import errors or broken Thai search | Test `calamine` / `pdf-extract` against real production `.xlsx` workbooks and Thai PDFs in Phase 0/7 |
| Scope creep (porting legacy unused modules or rewriting frontend) | Doubles timeline | Freeze legacy modules; keep React frontend untouched |
| Python keeps changing during the port (370 commits and 49 Alembic migrations in the 30 days before 2026-11-27) | The port chases a moving target; parity checks keep breaking | Decide before Phase 0: a feature freeze on the Python side, or a rule that every Python change lands in Rust in the same week. Without one, port only `solar-core` first (pure code, few changes) |
| Two schema owners while both backends share one database | sqlx compile-time checks fail whenever Python adds a table or column; drift between the two | Python (`ensure_schema`, with Alembic kept in step) stays the only schema owner; Rust rebuilds its test DB with `rust/scripts/schema.sh`, regenerates `.sqlx` from it and adds no migrations. After cutover, port `ensure_schema` to Rust before Python can be removed |
| Local development moves from SQLite to Postgres only | Every developer needs a Postgres 16 container; `data/solar_fullstack.db` workflows stop | Use the existing `docker compose` Postgres for Rust development and add a `rust/CLAUDE.md`; Python keeps SQLite meanwhile |
| Port justified by resources it does not save (§1.1) | Months of work for under ฿100/month | Treat the port as a safety / maintainability decision; the Python cold-start work is merged (§1.1); measure the next deploy's cold start before claiming any Rust gain |
| 17 weeks for ~50k lines of backend plus ~23k lines of tests | Schedule slips | Plan by exit gates, not weeks; Phase 2 (`solar-core`) is the go / no-go checkpoint |
| Missing security/scoping checks on 267 endpoints | Cross-plant data leaks | Enforce `PlantScope` & `ShadowPolicy` types + automated engineer-vs-admin 404 test suite |

---

## 7. Immediate Next Steps (Day 1)

0. Decide the freeze / dual-landing rule and the schema owner (§6). If neither is settled, the first step is only Phase 2 (`solar-core`) under the parity harness.
1. Confirm whether the legacy routes (`plants`, `datasets`, `analysis`, `maintenance`, `rca`) are retired rather than ported.
2. Scaffold `rust/` (workspace, `.gitignore`, `check.sh` scope) on a branch; nothing under `backend/` or `frontend/` changes.
3. Build a fresh local Postgres 16 with `rust/scripts/schema.sh` (Python `ensure_schema`), run `cargo sqlx prepare`, and get `sqlx` + `axum` `/health` and `/auth/login` (existing PBKDF2 hashes) answering on `:8001`.
4. Measure the cold start after the next `deploy/gcp.sh backend` (two images) and add it to §1.1.
