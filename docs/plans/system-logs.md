# Plan & Spec: System → Logs page

Status: **Built 2026-11-13** (deploy pending) · Created 2026-11-13 · Owner: Chanthawat

Collect the backend's log records (API and `growatt-worker`) in one place and show them to admins on a new **Logs** page in the sidebar's **System** group.

---

## 1. Why

- The backend runs as **two processes on two hosts**: the API on Cloud Run (`tcroof-api`) and `growatt-worker` on the `tcroof-db` VM. Their stdout goes to Cloud Logging and to `docker logs` respectively. To see why a job was `partial`, you need a GCP console or SSH.
- `sync_runs` shows a job's status and `error`, but not the per-inverter / per-phase warnings behind it (rate limits `10012`, `max_data_info` gaps, env-sensor failures, Google Weather 429s).
- Admins need one screen: what failed, when, in which process, linked to the job run.

## 2. Scope

**In**
- A logging handler that writes Python `logging` records from the API and the worker into a new SQL table `app_logs` (shared Postgres in prod, SQLite in dev).
- Redaction of secrets before anything is stored.
- Link each record to the job run (`sync_runs.id`) it came from.
- Admin-only API: list with filters + cursor paging, and summary counts.
- New admin-only page `/logs` under **System**, with filters, auto-refresh, and expandable tracebacks.
- Retention via the existing `retention` job.

**Out (not this version)**
- Reading Cloud Logging / `docker logs` directly (needs GCP credentials and costs API calls; the DB copy covers it).
- Live streaming (SSE/WebSocket): Cloud Run scales to zero, max 1 instance; polling is enough.
- Frontend (browser) errors.
- Full HTTP access logs for every request (volume). Only 5xx, slow requests and auth failures are logged (see §4.3).
- Engineer access. Logs carry serials and plant ids of the whole fleet, so engineers would see plants outside their assignment.

## 3. Constraints from the project rules

| Rule (CLAUDE.md) | What it means here |
|---|---|
| Never store realtime values | Log messages must not carry live measurements (kW, V, A from `/growatt/live/*`). Only the message text, error and counts. Review `growatt_live.py` before adding log lines there. |
| Tokens/keys stay on the backend | Redact before insert **and** never return unredacted text from the API. The Google key is a `?key=` query param and `requests` exceptions include the URL. `GoogleWeatherClient._get` already strips this (exception type only, `from None`, key → `***`; pinned by `test_client_errors_never_contain_the_api_key`), but redaction is still the backstop for third-party loggers (`urllib3` debug lines carry full URLs). |
| SQL runs on SQLite and Postgres | SQLAlchemy expressions only; time filters and grouping in Python or via plain comparisons. |
| Never run jobs inside the API | Log writing is not a job; the API flushes its own buffer inside the request. |
| Cloud Run cuts CPU after the response | A background flush thread in the API may stall. Flush synchronously at the end of each request (middleware) and on shutdown. |
| Firestore budget | Nothing goes to Firestore. |
| e2-micro VM, 100 GB disk | Bounded volume and retention (§4.5). |

## 4. Spec

### 4.1 Data model: `app_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | Integer PK, autoincrement | Cursor for paging (newest first). |
| `ts` | DateTime(tz) | **UTC**, from `record.created`. Read back with `jobs._aware`. |
| `level` | String(8) | `DEBUG` `INFO` `WARNING` `ERROR` `CRITICAL` |
| `level_no` | SmallInteger | For `level_no >= ?` filters. |
| `source` | String(16) | `api` \| `worker` \| `cli` (set once per process at startup). |
| `host` | String(64) | Hostname / Cloud Run revision (`K_REVISION`), optional. |
| `logger` | String(128) | `record.name`, e.g. `app.services.growatt_sync`. |
| `message` | Text | Formatted + redacted, truncated to 4 000 chars. |
| `exc_text` | Text, null | Formatted traceback, redacted, truncated to 16 000 chars. |
| `run_id` | Integer, null | `sync_runs.id` when logged inside a job run. No FK (runs may be pruned first). |
| `job` | String(32), null | Job name, denormalised for filtering. |
| `request_id` | String(32), null | Per API request (also returned as `X-Request-ID`). |
| `extra_json` | JSON, null | Small structured fields when given via `extra={"ctx": {...}}`. |

Indexes: `(ts)`, `(level_no, ts)`, `(run_id)`, `(source, ts)`.

Created by `ensure_schema` (`create_all`); add a hand-written Alembic migration chained on the current head.

### 4.2 Capture: `app/logging_db.py`

- `DbLogHandler(logging.Handler)`:
  - `emit()` formats, redacts and appends a dict to an in-memory buffer (`collections.deque(maxlen=LOG_BUFFER_MAX)`, default 5 000; the oldest records are dropped on overflow and the count of dropped records is logged once on the next flush).
  - `flush()` bulk-inserts the buffer with its **own** engine connection (not the request's session), in one transaction. A failed insert is printed to stderr and dropped, never re-logged (no recursion).
  - Worker / CLI: a daemon thread flushes every `LOG_FLUSH_INTERVAL_S` (default 5 s) and at exit (`atexit`), plus immediately for `ERROR`+.
  - API: a middleware flushes after each response is built, before it is returned; `lifespan` shutdown flushes too.
- Levels: handler level `LOG_DB_LEVEL` (default `INFO`). Always skip the loggers `sqlalchemy.*`, `app.logging_db`, and `urllib3`, `httpx`, `httpcore` below `WARNING` (they log full URLs, including `key=`).
- `setup_logging(source)` replaces the three separate `logging.basicConfig` calls (`worker.py:147`, `growatt_sync.py:547`, `daily_summary.py:444`): console handler as today, plus `DbLogHandler` when `LOG_DB_ENABLED`. Called from `main.py` (`source="api"`), `worker.py` (`"worker"`), and the CLI entry points (`"cli"`).
- Context: `contextvars` `run_id`, `job`, `request_id`. `jobs.execute()` (runs one `SyncRun`) sets `run_id`/`job` for the run's duration. Per-phase threads in `_per_phase` copy the context (`contextvars.copy_context().run`), so phase logs keep the run id.

### 4.3 What the API itself logs

Added by a small middleware (`app/api/request_log.py`):
- `WARNING` for 5xx responses and unhandled exceptions (with traceback).
- `WARNING` for requests slower than `LOG_SLOW_REQUEST_MS` (default 5 000 ms), with method, path template and duration.
- `INFO` for failed logins (username only, never the password) and admin actions: sync job queued, user created/changed, plant assignment changed, fleet module changed.
- No line for ordinary 2xx/4xx requests.

### 4.4 Redaction (`redact(text) -> str`)

Applied to `message`, `exc_text` and `extra_json` values before buffering:
- Exact secret values from settings: every `GROWATT_TOKEN_PHASE*`, `GROWATT_API_TOKEN`, `GOOGLE_WEATHER_API_KEY`, `JWT_SECRET_KEY`, `ADMIN_PASSWORD`, DB password parsed from `DATABASE_URL` → `***`.
- Patterns: `([?&](key|token|access_token)=)[^&\s"']+`, `(Authorization:\s*Bearer\s+)\S+`, `(token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}`, `postgresql(\+\w+)?://[^:]+:[^@]+@` → password masked.
- Unit-tested with real-shaped samples (a `requests.ConnectionError` string with `?key=`, a Postgres URL).

### 4.5 Volume and retention

- Estimate at `INFO`: `history` logs one line per inverter (`growatt_sync.py:448`) → 629 × 48 runs ≈ 30 k lines/day, plus about 5 k others. At ~300 B/row that is roughly 10 MB/day.
- Change the per-inverter success line at `growatt_sync.py:448` to `DEBUG`, keep the per-phase summary at `INFO`. Expected: < 5 k rows/day.
- `LOG_RETENTION_DAYS` (default 14). The `retention` job deletes older `app_logs` rows (batched `DELETE … WHERE ts < ?`) and reports `log_rows` in its `detail`.
- Safety cap: if `app_logs` exceeds `LOG_MAX_ROWS` (default 500 000), `retention` also deletes the oldest beyond the cap.

### 4.6 API (admin only, `require_admin`; new router `app/api/routes/system.py`, mounted at `/api` and `/` like the others)

`GET /system/logs`

| Param | Default | Meaning |
|---|---|---|
| `level` | `INFO` | Minimum level. |
| `source` | all | `api`, `worker`, `cli` (repeatable). |
| `logger` | — | Prefix match, e.g. `app.services.growatt_sync`. |
| `job` | — | Job name. |
| `run_id` | — | One job run. |
| `q` | — | Case-insensitive substring in `message` (`ilike`; on SQLite `lower() like`). Max 200 chars. |
| `since` / `until` | last 24 h | ISO-8601; naive values are Bangkok time. |
| `before_id` | — | Cursor: rows with `id < before_id`. |
| `after_id` | — | For polling: rows with `id > after_id` (newest first, capped by `limit`). |
| `limit` | 200 | 1–1 000. |

Response:
```json
{
  "items": [{"id": 1, "ts": "2026-11-13T02:00:04Z", "level": "WARNING", "source": "worker",
             "logger": "app.services.growatt_sync", "message": "…", "exc_text": null,
             "run_id": 812, "job": "history", "request_id": null}],
  "next_before_id": 1,
  "meta": {"source": "db", "retention_days": 14, "enabled": true}
}
```

`GET /system/logs/summary?since=` → counts per level and per source for the window, plus the newest `ERROR`+ record, for the page header and a sidebar badge.

Engineers get **403** (same as other admin-only routes).

### 4.7 Frontend: `/logs`

- **Nav:** add `{ to: "/logs", label: "Logs", icon: ScrollText, description: "Backend and worker logs, errors & job runs" }` to the **System** group in `components/Layout.tsx`. Add `"/logs"` to `ADMIN_ONLY_PATHS` (`auth/access.ts`), and wrap the route in `<AdminOnly>` in `App.tsx`. Optional: a small `crit` badge with the 24 h error count from `/system/logs/summary`.
- **API client:** `api.listSystemLogs(params)` and `api.getSystemLogSummary(since)` in `src/api/client.ts`, with types `SystemLogEntry`, `SystemLogPage`, `SystemLogSummary`. No `fetch` in components.
- **Page `pages/SystemLogsPage.tsx`:**
  - `PageHeader` "Logs" with KPI tiles from the summary: errors, warnings, total (last 24 h), and "Last error · hh:mm".
  - Filter bar (shadcn `Select`, `Input`, `Button`): level, source, time range (1 h / 24 h / 7 d / custom), job, text search (debounced 300 ms). Filters live in the URL query string so a view can be shared.
  - Table (`Table` with `containerClassName="table-wrap"`): time (Bangkok, `HH:mm:ss`, date on day change), level `Badge` (`crit` = ERROR/CRITICAL, `warn` = WARNING, `info` = INFO, `neutral` = DEBUG), source, logger (short name, full name in `Tooltip`), message (one line, `num` font for ids), run link.
  - Row click expands the full message and `exc_text` in a `<pre>` with a copy button.
  - Clicking a job/run chip filters by `run_id`.
  - "Load older" uses `next_before_id`.
  - **Auto-refresh** toggle (default on): polls `after_id` every 15 s, only while `document.hidden` is false and the newest page is shown, and prepends new rows. Same pattern as `alarmLogStore`; no react-query.
  - Empty / loading / error states with `EmptyState` / `LoadingState`. When `meta.enabled` is false, say that DB logging is switched off.
- `bun run lint` and `bun run build` pass.

### 4.8 Config (add to `config.py`, `.env.example`, `CLAUDE.md` Config list)

| Key | Default |
|---|---|
| `LOG_DB_ENABLED` | `true` |
| `LOG_DB_LEVEL` | `INFO` |
| `LOG_RETENTION_DAYS` | `14` |
| `LOG_MAX_ROWS` | `500000` |
| `LOG_FLUSH_INTERVAL_S` | `5` |
| `LOG_BUFFER_MAX` | `5000` |
| `LOG_SLOW_REQUEST_MS` | `5000` |

## 5. Plan (phases)

1. **Backend capture:** model + migration, `logging_db.py`, redaction, `setup_logging`, context vars in `jobs.execute()` / `_per_phase`, demote per-inverter line to DEBUG.
2. **Backend API:** `system.py` router, request-log middleware, retention, tests.
3. **Frontend:** client methods, page, nav, access rules.
4. **Docs & deploy:** CLAUDE.md files, `.env.example`, deploy, verify on prod.

## 6. Checklist

### Phase 1: capture
_Built 2026-11-13, phases 1–3 together. Decisions on §8: admins only, 14 days, no sidebar badge (header tiles only). Deviations: `jobs.execute` also logs "job X started (run N, trigger)" / "job X finished: status" so every run has at least two records; audit lines use logger `app.audit` (user changes record field names only, never values); `requests` is quieted below WARNING too; secrets shorter than 6 chars are not matched by value (they would mask ordinary words; the patterns still apply). The page has 1 h / 24 h / 7 d / 14 d instead of a custom range; "Load older" pauses polling until Refresh. Checked on dev: a failed login lands in `app_logs` with its request id, engineer → 403 through the proxy. pyright: no errors in new or changed files (28 remain elsewhere, 39 before)._
- [x] `AppLog` model in `db/models.py` with the indexes in §4.1
- [x] Alembic migration under `backend/alembic/versions/` chained on the current head
- [x] `app/logging_db.py`: `DbLogHandler`, buffer, own-connection bulk insert, no recursion
- [x] `redact()` with settings values + patterns (§4.4)
- [x] `setup_logging(source)` replaces the 3 `basicConfig` calls; called from `main.py`, `worker.py`, CLIs
- [x] Flush: worker thread every 5 s + on ERROR + `atexit`; API middleware per request + lifespan shutdown
- [x] `urllib3` / `httpx` / `httpcore` / `sqlalchemy` filtered as in §4.2
- [x] Context vars `run_id` / `job` set in `jobs.execute()`; copied into `_per_phase` threads
- [x] `growatt_sync.py:448` per-inverter success line → `DEBUG`
- [x] Settings keys from §4.8 added to `config.py`

### Phase 2: API
- [x] `app/api/routes/system.py`: `GET /system/logs`, `GET /system/logs/summary`, `require_admin`
- [x] Router included in `main.py` (mounted at `/api` and `/`)
- [x] Filters, `before_id` / `after_id` paging, `limit` bounds, naive time = Bangkok
- [x] Request-log middleware: 5xx, slow requests, failed logins, admin actions; `X-Request-ID` header
- [x] `job_retention` prunes `app_logs` by age and by `LOG_MAX_ROWS`; `detail.log_rows`
- [x] Tests (`backend/tests/test_system_logs.py`):
  - [x] handler stores records with source, level, logger, run_id
  - [x] redaction: `?key=` URL in a `requests` error, Bearer header, Postgres URL, raw token value
  - [x] no recursion when the insert fails
  - [x] engineer → 403, admin → 200
  - [x] filters (level, source, q, run_id, time) and paging
  - [x] retention by days and by row cap
  - [x] runs on SQLite (tests) with no raw `strftime`
- [x] `uv run pytest -q` and `pyright` pass

### Phase 3: frontend
- [x] Types + `api.listSystemLogs` / `api.getSystemLogSummary` in `src/api/client.ts`
- [x] `pages/SystemLogsPage.tsx` per §4.7 (KPI tiles, filters in URL, table, expand, load older, auto-refresh)
- [x] Route `logs` in `App.tsx` inside `<AdminOnly>`
- [x] `"/logs"` in `ADMIN_ONLY_PATHS`
- [x] Nav item "Logs" in the **System** group (`ScrollText` icon); hidden for engineers
- [x] Polling stops while `document.hidden`; cleared on logout
- [x] `bun run lint` and `bun run build` pass

### Phase 4: docs & deploy
- [x] `CLAUDE.md`: data-flow note (logs → SQL), Config keys
- [x] `backend/CLAUDE.md`: logging section (handler, redaction, context, retention), `/system/logs` row, `retention` job text
- [x] `frontend/CLAUDE.md`: routes list and Logs page notes
- [x] `.env.example`: new keys
- [ ] Deploy backend (`deploy/gcp.sh backend`) and worker on the VM; frontend (`deploy/gcp.sh frontend`)
- [ ] Verify on prod: worker run appears with its `run_id`; a forced 5xx shows with traceback; search for any token/key fragment in `app_logs` returns nothing
- [ ] After 1 week: check `app_logs` rows/day and table size against §4.5

## 7. Acceptance criteria

- An admin opens **System → Logs** and sees API and worker records from the last 24 h, newest first, within 20 s of them being logged.
- Filtering by `ERROR` and by a job run shows only that run's errors, with tracebacks.
- An engineer sees no Logs nav item, and `/system/logs` answers 403.
- No Growatt token, Google key, JWT secret or DB password appears in `app_logs` or in any API response.
- `app_logs` stays under `LOG_RETENTION_DAYS` and `LOG_MAX_ROWS` after `retention` runs.
- The API keeps scaling to zero; no background thread is needed in the API process.

## 8. Open questions

1. Should engineers see logs for their assigned plants only? (Needs `plant_id` on records; out of scope now.)
2. Keep 14 days, or match `HISTORY_RETENTION_DAYS` (90)?
3. Is a sidebar error badge wanted, or only the page header tiles?
