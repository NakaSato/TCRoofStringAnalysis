#!/usr/bin/env bash
# Golden-Diff parity run: a throwaway Postgres 16, its schema built by Python (rust/scripts/schema.sh)
# in a template database with the fixture rows below, one copy of it for the Python API and one for
# the Rust API (so cases that write change each side the same way, and both write their own
# app_logs), the same JWT_SECRET_KEY, then parity.py sends the same requests to both and reports
# differences. Everything is stopped on exit.
#
#   rust/tests/parity/run.sh                 # Python on :8000, Rust on :8001 (a free port if busy)
#   PY_PORT=8100 RUST_PORT=8101 rust/tests/parity/run.sh
#   TEST_PG_PORT=55434 rust/tests/parity/run.sh --cases my_cases.json   # extra args go to parity.py
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

PG_PORT="${TEST_PG_PORT:-55434}"
NAME="tcroof-parity-pg-$$"
PW="parity"
LOGS="${PARITY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tcroof-parity.XXXXXX")}"
PY_PID=""
RS_PID=""
STUB_PID=""
WX_PID=""

cleanup() {
  [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null || true
  [[ -n "$WX_PID" ]] && kill "$WX_PID" 2>/dev/null || true
  [[ -n "$PY_PID" ]] && kill "$PY_PID" 2>/dev/null || true
  [[ -n "$RS_PID" ]] && kill "$RS_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# a port that is free now: the wanted one, else the next free one above it
free_port() {
  python3 - "$1" <<'PY'
import socket, sys
p = int(sys.argv[1])
while True:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", p)); break
        except OSError:
            p += 1
print(p)
PY
}
PY_PORT="$(free_port "${PY_PORT:-8000}")"
RUST_PORT="$(free_port "${RUST_PORT:-8001}")"
[[ "$RUST_PORT" == "$PY_PORT" ]] && RUST_PORT="$(free_port $((PY_PORT + 1)))"

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:${PG_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data postgres:16-alpine -c fsync=off >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null

docker exec "$NAME" psql -U postgres -qc "CREATE DATABASE parity_seed" >/dev/null
SEED_URL="postgresql+psycopg://postgres:${PW}@127.0.0.1:${PG_PORT}/parity_seed"
rust/scripts/schema.sh "$SEED_URL"

# Data the cases look at: a finished `history` run 10 minutes ago (worker health 200, a timestamp
# with microseconds), some plants assigned to the engineer (plant_ids not empty, sorted), Growatt
# registry plants for /users/{id}/plants, and worker / cli log records for /system/logs (the APIs
# add their own records while the cases run).
docker exec -i "$NAME" psql -U postgres -d parity_seed -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
INSERT INTO sync_runs (job, trigger, status, started_at, finished_at)
VALUES ('history', 'schedule', 'ok', now() - interval '20 minutes', now() - interval '10 minutes'),
       ('history', 'schedule', 'failed', now() - interval '5 minutes', now() - interval '1 minute');
INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, p, 'parity', now() FROM users, unnest(ARRAY[42, 7, 1001]) AS p WHERE username = 'engineer';
INSERT INTO growatt_plants (plant_id, name, synced_at)
SELECT p, 'Parity plant ' || p, now() FROM unnest(ARRAY[10, 20, 30, 42, 7]) AS p;
INSERT INTO app_logs (ts, level, level_no, source, host, logger, message, exc_text, run_id, job, request_id, extra_json)
VALUES
  (date_trunc('second', now()) - interval '30 hours', 'ERROR', 40, 'worker', 'vm-1', 'app.services.growatt_sync',
   'history: phase 2 FAILED after 3 tries', 'Traceback (most recent call last): ...', 77, 'history', NULL, '{"phase": 2}'),
  (date_trunc('second', now()) - interval '3 hours', 'INFO', 20, 'worker', 'vm-1', 'app.services.jobs',
   'job history started', NULL, 77, 'history', NULL, NULL),
  (date_trunc('second', now()) - interval '2 hours', 'DEBUG', 10, 'worker', 'vm-1', 'app.services.growatt_sync',
   'page 3 of 9', NULL, 77, 'history', NULL, NULL),
  (date_trunc('second', now()) - interval '90 minutes', 'WARNING', 30, 'cli', 'laptop', 'app.cli.import_pwa',
   'row 12: 100%_done is not a number', NULL, NULL, NULL, NULL, '{"row": 12, "sheet": "Jan"}'),
  (date_trunc('second', now()) - interval '1 hour', 'CRITICAL', 50, 'worker', 'vm-1', 'app_services',
   'disk almost full', NULL, NULL, NULL, NULL, NULL),
  (date_trunc('second', now()) - interval '30 minutes', 'ERROR', 40, 'api', 'tcroof-api-00042', 'app.api.request',
   'GET /api/growatt/plants failed: unhandled exception', 'Traceback ...', NULL, NULL, '0123456789abcdef', NULL);
SQL
# one seed file per area (seed.d/*.sql, applied in name order), so parallel work never edits this script
for f in "$(dirname "$0")"/seed.d/*.sql; do
  [ -e "$f" ] || continue
  docker exec -i "$NAME" psql -U postgres -d parity_seed -v ON_ERROR_STOP=1 -q >/dev/null < "$f"
done
for db in parity_py parity_rs; do
  docker exec "$NAME" psql -U postgres -qc "CREATE DATABASE $db TEMPLATE parity_seed" >/dev/null
done
DB_URL="postgresql+psycopg://postgres:${PW}@127.0.0.1:${PG_PORT}/parity_py"
RS_DB_URL="postgresql+psycopg://postgres:${PW}@127.0.0.1:${PG_PORT}/parity_rs"

export DATABASE_URL="$DB_URL"
export JWT_SECRET_KEY="parity-$(date +%s)-shared-secret-for-both-backends"
export APP_ENV=dev SEED_DEMO_DATA=false
# never reach the real Firestore project: routes that save settings publish right away, and the
# repo .env may set PUBLISH_SINK=firestore with credentials (backend/tests/conftest.py guards the same)
export PUBLISH_SINK=json FIREBASE_CREDENTIALS_FILE= FIREBASE_PROJECT_ID=
# never the real Growatt cloud or a shared Redis (the repo .env may hold real tokens / REDIS_URL);
# the live cases (/growatt/live/*) get a stub Growatt (growatt_stub.py), started only when a case file
# asks for one; night TTL stretching off so refresh_in_s does not depend on the clock
export GROWATT_API_TOKEN= GROWATT_TOKEN_PHASE1= GROWATT_TOKEN_PHASE2= GROWATT_TOKEN_PHASE3= GROWATT_TOKEN_PHASE4=
export REDIS_URL= GROWATT_BLOCKED_PLANT_IDS=
if grep -qs '/growatt/live/' "$ROOT"/rust/tests/parity/cases.json "$ROOT"/rust/tests/parity/cases.d/*.json; then
  STUB_PORT="$(free_port "${GROWATT_STUB_PORT:-8090}")"
  python3 -I "$ROOT/rust/tests/parity/growatt_stub.py" "$STUB_PORT" >"$LOGS/growatt_stub.log" 2>&1 &
  STUB_PID=$!
  export GROWATT_BASE_URL="http://127.0.0.1:$STUB_PORT/v1/" GROWATT_TOKEN_PHASE1=parity-stub-token GROWATT_LIVE_NIGHT_TTL_S=0
  for _ in $(seq 1 40); do curl -sS "http://127.0.0.1:$STUB_PORT/v1/ping" >/dev/null 2>&1 && break; sleep 0.25; done
fi
# never the real Google Weather, Longdo or RainViewer (the repo .env may hold real keys): keys blank
# and RainViewer off, unless a case file asks for the live weather / rain routes; then a stub
# (weather_stub.py) answers all three. PARITY_WEATHER picks what the backends see:
#   stub (default)  Longdo, RainViewer and Google Weather configured, Google's daytime window as set
#   degraded        Longdo with a key the stub refuses (HTTP 403: RainViewer fallback, held-back
#                   rain), Google Weather all day (GOOGLE_WEATHER_DAY_START_H=0, _END_H=24)
#   off             no Longdo key, no Google key (only RainViewer)
# e.g. PARITY_WEATHER=degraded rust/tests/parity/run.sh --cases rust/tests/parity/weather_modes/degraded.json
# Blanked / pinned for both APIs (an empty variable is set, so the Rust API's .env lookup, which can
# climb out of a worktree to the main checkout's .env, never fills it in): no real key ever reaches
# either backend, and both see the same window and cell size.
export GOOGLE_WEATHER_API_KEY= LONGDO_API_KEY= RAINVIEWER_ENABLED=false \
  GOOGLE_WEATHER_BASE_URL=http://127.0.0.1:9/ LONGDO_BASE_URL=http://127.0.0.1:9/ RAINVIEWER_URL=http://127.0.0.1:9/ \
  GOOGLE_WEATHER_DAY_START_H=6 GOOGLE_WEATHER_DAY_END_H=18 GOOGLE_WEATHER_CELL_DEG=0.01
WEATHER_CASES=("$ROOT"/rust/tests/parity/cases.json "$ROOT"/rust/tests/parity/cases.d/*.json)
for a in "$@"; do [[ -f "$a" ]] && WEATHER_CASES+=("$a"); done
if grep -qsE '/growatt/live/(rain|plants/[^"]*/(rain|google-weather))' "${WEATHER_CASES[@]}"; then
  WX_PORT="$(free_port "${WEATHER_STUB_PORT:-8490}")"
  python3 -I "$ROOT/rust/tests/parity/weather_stub.py" "$WX_PORT" >"$LOGS/weather_stub.log" 2>&1 &
  WX_PID=$!
  WX="http://127.0.0.1:$WX_PORT"
  export LONGDO_BASE_URL="$WX/longdo/" RAINVIEWER_URL="$WX/rainviewer/weather-maps.json" RAINVIEWER_ENABLED=true \
    GOOGLE_WEATHER_BASE_URL="$WX/google/v1/"
  case "${PARITY_WEATHER:-stub}" in
    stub) export LONGDO_API_KEY=parity-stub-key GOOGLE_WEATHER_API_KEY=parity-stub-key ;;
    degraded) export LONGDO_API_KEY=parity-refused-key GOOGLE_WEATHER_API_KEY=parity-stub-key \
                GOOGLE_WEATHER_DAY_START_H=0 GOOGLE_WEATHER_DAY_END_H=24 ;;
    off) ;;
    *) echo "parity: PARITY_WEATHER must be stub, degraded or off" >&2; exit 2 ;;
  esac
  for _ in $(seq 1 40); do curl -sS "$WX/ping" >/dev/null 2>&1 && break; sleep 0.25; done
fi

echo "parity: Python on :$PY_PORT, Rust on :$RUST_PORT, Postgres on :$PG_PORT, logs in $LOGS"
(cd rust && cargo build -q -p tcroof-api)
PYTHONPATH=backend uv run --quiet --with "psycopg[binary]>=3.2" \
  python -m uvicorn app.main:app --host 127.0.0.1 --port "$PY_PORT" >"$LOGS/python.log" 2>&1 &
PY_PID=$!
(cd rust && DATABASE_URL="$RS_DB_URL" RUST_API_PORT="$RUST_PORT" exec ./target/debug/tcroof-api) >"$LOGS/rust.log" 2>&1 &
RS_PID=$!

wait_up() {  # name url pid log
  for _ in $(seq 1 120); do
    curl -fsS "$2/health" >/dev/null 2>&1 && return 0
    if ! kill -0 "$3" 2>/dev/null; then
      echo "parity: $1 exited before /health answered; last log lines:" >&2
      tail -20 "$4" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "parity: $1 did not answer /health in 60 s; last log lines:" >&2
  tail -20 "$4" >&2
  return 1
}
wait_up python "http://127.0.0.1:$PY_PORT" "$PY_PID" "$LOGS/python.log"
wait_up rust "http://127.0.0.1:$RUST_PORT" "$RS_PID" "$LOGS/rust.log"

uv run --quiet python rust/tests/parity/parity.py \
  --python "http://127.0.0.1:$PY_PORT" --rust "http://127.0.0.1:$RUST_PORT" "$@"
