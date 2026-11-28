#!/usr/bin/env bash
# Worker parity: run the same job with the Python worker and the Rust worker, each on its own copy
# of one seeded database, then compare what each wrote (compare.py; tables per job in jobs.json,
# plus sync_runs and app_logs). A throwaway Postgres 16, schema built by Python
# (rust/scripts/schema.sh), seed rows from seed.d/*.sql (name order). Everything stops on exit.
#
#   rust/tests/worker_parity/run.sh                    # every job in jobs.json
#   rust/tests/worker_parity/run.sh retention fleet    # these jobs only (each must be in jobs.json)
#   TEST_PG_PORT=55436 GROWATT_STUB_PORT=8190 WEATHER_STUB_PORT=8191 rust/tests/worker_parity/run.sh
#
# Each job runs as `python -m app.worker --once JOB` and `tcroof-worker --once JOB`, one after the
# other (never at the same time: the stubs keep per-token rate-limit state like Growatt). A job
# with `"stubs": ["growatt"]` / `["weather"]` in jobs.json gets the stub servers of the API parity
# harness (rust/tests/parity/growatt_stub.py, weather_stub.py) and their keys; every other external
# service is blanked for BOTH workers below.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
HERE="$ROOT/rust/tests/worker_parity"

PG_PORT="${TEST_PG_PORT:-55436}"
NAME="tcroof-worker-parity-$$"
PW="workerparity"
LOGS="${PARITY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tcroof-worker-parity.XXXXXX")}"
mkdir -p "$LOGS"  # a PARITY_LOG_DIR that does not exist yet would otherwise run no worker and report "equal"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/tcroof-worker-parity-data.XXXXXX")"
STUB_PID=""
WX_PID=""

cleanup() {
  [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null || true
  [[ -n "$WX_PID" ]] && kill "$WX_PID" 2>/dev/null || true
  [[ -n "${SYNC_STUB_PID:-}" ]] && kill "$SYNC_STUB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

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

JOBS=("$@")
if [[ ${#JOBS[@]} -eq 0 ]]; then
  while IFS= read -r j; do JOBS+=("$j"); done < <(python3 -c 'import json,sys; print("\n".join(k for k in json.load(open(sys.argv[1])) if not k.startswith("_")))' "$HERE/jobs.json")
fi
for j in "${JOBS[@]}"; do
  python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)' "$HERE/jobs.json" "$j" \
    || { echo "worker parity: $j is not in jobs.json" >&2; exit 2; }
done

# ---------------------------------------------------------------- never reach anything real
# PUBLISH_SINK=json for every job (set below, never firestore); each side's JSON sink folder is
# PUBLISH_JSON_DIR under the run's temp folder, never data/firestore_export.
# The repo .env may hold real Growatt tokens, Firebase / Sheets credentials, a Redis URL and API
# keys, and the Rust worker's .env lookup can climb out of a worktree to the main checkout's .env:
# every one of these is SET (empty or local) here, for both workers, so no .env value fills it in.
export APP_ENV=dev SEED_DEMO_DATA=false
# PUBLISH_DAILY_WRITE_BUDGET: the default, so a .env value cannot reach only the Rust worker
export PUBLISH_SINK=json PUBLISH_DAILY_WRITE_BUDGET=15000 FIREBASE_CREDENTIALS_FILE= FIREBASE_PROJECT_ID= \
  FIREBASE_WEB_API_KEY= FIREBASE_WEB_APP_ID= FIREBASE_MESSAGING_SENDER_ID= FIREBASE_VAPID_KEY= \
  PWA_SHEET_ID= PWA_SHEET_CREDENTIALS_FILE= KB_ASSETS_BUCKET= KB_FILES_DIR="$DATA/kb_files" \
  GOOGLE_APPLICATION_CREDENTIALS= FIRESTORE_EMULATOR_HOST= PUBLISH_JSON_DIR="$DATA/json/unset"
export GROWATT_API_TOKEN= GROWATT_TOKEN_PHASE1= GROWATT_TOKEN_PHASE2= GROWATT_TOKEN_PHASE3= GROWATT_TOKEN_PHASE4= \
  GROWATT_BASE_URL=http://127.0.0.1:9/v1/ GROWATT_BLOCKED_PLANT_IDS= REDIS_URL=
export GOOGLE_WEATHER_API_KEY= LONGDO_API_KEY= RAINVIEWER_ENABLED=false GEOAPIFY_API_KEY= AI_API_KEY= REPORT_API_KEY= \
  GOOGLE_WEATHER_BASE_URL=http://127.0.0.1:9/ LONGDO_BASE_URL=http://127.0.0.1:9/ RAINVIEWER_URL=http://127.0.0.1:9/ \
  GEOAPIFY_BASE_URL=http://127.0.0.1:9/ AI_BASE_URL=http://127.0.0.1:9/
# app_logs: no timed flush during a job (both flush at exit and at once after an ERROR), so a
# prune never races its own log records
export LOG_DB_ENABLED=true LOG_DB_LEVEL=INFO LOG_FLUSH_INTERVAL_S=3600
export JWT_SECRET_KEY="worker-parity-$(date +%s)"

# ---------------------------------------------------------------- database
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:${PG_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data postgres:16-alpine -c fsync=off >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null
psql_() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_ -c "CREATE DATABASE worker_seed" >/dev/null
url() { echo "postgresql+psycopg://postgres:${PW}@127.0.0.1:${PG_PORT}/$1"; }
rust/scripts/schema.sh "$(url worker_seed)" >/dev/null
for f in "$HERE"/seed.d/*.sql; do
  [ -e "$f" ] || continue
  psql_ -d worker_seed >/dev/null < "$f"
done
SEED_RUNS="$(psql_ -d worker_seed -Atc 'SELECT coalesce(max(id), 0) FROM sync_runs')"
SEED_LOGS="$(psql_ -d worker_seed -Atc 'SELECT coalesce(max(id), 0) FROM app_logs')"

(cd rust && cargo build -q -p tcroof-worker)
echo "worker parity: Postgres on :$PG_PORT, logs in $LOGS"

# ---------------------------------------------------------------- jobs
FAILED=0
for job in "${JOBS[@]}"; do
  stubs="$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))[sys.argv[2]].get("stubs", [])))' "$HERE/jobs.json" "$job")"
  # "job": the worker job a variant entry runs (default: the entry's own name)
  run_job="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]].get("job", sys.argv[2]))' "$HERE/jobs.json" "$job")"
  jobenv=()
  while IFS= read -r kv; do [[ -n "$kv" ]] && jobenv+=("$kv"); done < <(python3 -c '
import json, sys
for k, v in json.load(open(sys.argv[1]))[sys.argv[2]].get("env", {}).items():
    print(f"{k}={v}")' "$HERE/jobs.json" "$job")
  if [[ " $stubs " == *" growatt "* && -z "$STUB_PID" ]]; then
    STUB_PORT="$(free_port "${GROWATT_STUB_PORT:-8190}")"
    python3 -I "$ROOT/rust/tests/parity/growatt_stub.py" "$STUB_PORT" >"$LOGS/growatt_stub.log" 2>&1 &
    STUB_PID=$!
    for _ in $(seq 1 40); do curl -sS "http://127.0.0.1:$STUB_PORT/v1/ping" >/dev/null 2>&1 && break; sleep 0.25; done
  fi
  if [[ " $stubs " == *" weather "* && -z "$WX_PID" ]]; then
    WX_PORT="$(free_port "${WEATHER_STUB_PORT:-8191}")"
    python3 -I "$ROOT/rust/tests/parity/weather_stub.py" "$WX_PORT" >"$LOGS/weather_stub.log" 2>&1 &
    WX_PID=$!
    for _ in $(seq 1 40); do curl -sS "http://127.0.0.1:$WX_PORT/ping" >/dev/null 2>&1 && break; sleep 0.25; done
  fi
  # the Growatt sync stub of rust/tests/growatt_sync_golden (history endpoints, two accounts:
  # tokens tok-p1 / tok-p2), answering for today's plant-local day
  if [[ " $stubs " == *" growatt_sync "* && -z "${SYNC_STUB_PID:-}" ]]; then
    SYNC_STUB_PORT="$(free_port "${GROWATT_SYNC_STUB_PORT:-8192}")"
    python3 -I "$ROOT/rust/tests/growatt_sync_golden/sync_stub.py" "$SYNC_STUB_PORT" "$(TZ=Asia/Bangkok date +%F)" \
      >"$LOGS/growatt_sync_stub.log" 2>&1 &
    SYNC_STUB_PID=$!
    for _ in $(seq 1 40); do curl -sS "http://127.0.0.1:$SYNC_STUB_PORT/v1/ping" >/dev/null 2>&1 && break; sleep 0.25; done
  fi
  stubenv=()
  if [[ " $stubs " == *" growatt "* ]]; then
    stubenv+=("GROWATT_BASE_URL=http://127.0.0.1:$STUB_PORT/v1/" "GROWATT_TOKEN_PHASE1=parity-stub-token")
  fi
  if [[ " $stubs " == *" growatt_sync "* ]]; then
    stubenv+=("GROWATT_BASE_URL=http://127.0.0.1:$SYNC_STUB_PORT/v1/" "GROWATT_TOKEN_PHASE1=tok-p1" "GROWATT_TOKEN_PHASE2=tok-p2")
  fi
  if [[ " $stubs " == *" weather "* ]]; then
    WX="http://127.0.0.1:$WX_PORT"
    stubenv+=("GOOGLE_WEATHER_BASE_URL=$WX/google/v1/" "GOOGLE_WEATHER_API_KEY=parity-stub-key"
              "LONGDO_BASE_URL=$WX/longdo/" "LONGDO_API_KEY=parity-stub-key")
  fi
  for side in py rs; do
    psql_ -c "CREATE DATABASE ${side}_${job} TEMPLATE worker_seed" >/dev/null
  done
  set +e
  # the JSON publish sink of each side writes into its own folder (compared by compare.py)
  env ${jobenv[@]+"${jobenv[@]}"} ${stubenv[@]+"${stubenv[@]}"} DATABASE_URL="$(url "py_$job")" PYTHONPATH=backend \
    PUBLISH_JSON_DIR="$DATA/json/py_$job" \
    uv run --quiet --with "psycopg[binary]>=3.2" python -m app.worker --once "$run_job" >"$LOGS/$job.python.out" 2>"$LOGS/$job.python.err"
  py_code=$?
  (cd rust && exec env ${jobenv[@]+"${jobenv[@]}"} ${stubenv[@]+"${stubenv[@]}"} DATABASE_URL="$(url "rs_$job")" \
    PUBLISH_JSON_DIR="$DATA/json/rs_$job" \
    ./target/debug/tcroof-worker --once "$run_job") >"$LOGS/$job.rust.out" 2>"$LOGS/$job.rust.err"
  rs_code=$?
  set -e
  if [[ $py_code -ne $rs_code ]]; then
    echo "DIFF $job: exit code python $py_code, rust $rs_code (logs in $LOGS/$job.*)"
    FAILED=1
  fi
  uv run --quiet --with "psycopg[binary]>=3.2" python "$HERE/compare.py" --job "$job" --spec "$HERE/jobs.json" \
    --py "postgresql://postgres:${PW}@127.0.0.1:${PG_PORT}/py_$job" \
    --rs "postgresql://postgres:${PW}@127.0.0.1:${PG_PORT}/rs_$job" \
    --py-json "$DATA/json/py_$job" --rs-json "$DATA/json/rs_$job" \
    --seed-runs "$SEED_RUNS" --seed-logs "$SEED_LOGS" || FAILED=1
  # keep each side's JSON sink output with the logs
  for side in py rs; do
    [[ -d "$DATA/json/${side}_$job" ]] && cp -R "$DATA/json/${side}_$job" "$LOGS/$job.$side.json"
  done
done
exit $FAILED
