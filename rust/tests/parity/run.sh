#!/usr/bin/env bash
# Golden-Diff parity run: a throwaway Postgres 16, its schema built by Python (rust/scripts/schema.sh),
# the Python API and the Rust API both on it with the same JWT_SECRET_KEY, then parity.py sends the
# same requests to both and reports differences. Everything is stopped on exit.
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

cleanup() {
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

DB_URL="postgresql+psycopg://postgres:${PW}@127.0.0.1:${PG_PORT}/postgres"
rust/scripts/schema.sh "$DB_URL"

# Data the cases look at: a finished `history` run 10 minutes ago (worker health 200, a timestamp
# with microseconds) and some plants assigned to the engineer (plant_ids not empty, sorted).
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
INSERT INTO sync_runs (job, trigger, status, started_at, finished_at)
VALUES ('history', 'schedule', 'ok', now() - interval '20 minutes', now() - interval '10 minutes'),
       ('history', 'schedule', 'failed', now() - interval '5 minutes', now() - interval '1 minute');
INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, p, 'parity', now() FROM users, unnest(ARRAY[42, 7, 1001]) AS p WHERE username = 'engineer';
SQL

export DATABASE_URL="$DB_URL"
export JWT_SECRET_KEY="parity-$(date +%s)-shared-secret-for-both-backends"
export APP_ENV=dev SEED_DEMO_DATA=false

echo "parity: Python on :$PY_PORT, Rust on :$RUST_PORT, Postgres on :$PG_PORT, logs in $LOGS"
(cd rust && cargo build -q -p tcroof-api)
PYTHONPATH=backend uv run --quiet --with "psycopg[binary]>=3.2" \
  python -m uvicorn app.main:app --host 127.0.0.1 --port "$PY_PORT" >"$LOGS/python.log" 2>&1 &
PY_PID=$!
(cd rust && RUST_API_PORT="$RUST_PORT" exec ./target/debug/tcroof-api) >"$LOGS/rust.log" 2>&1 &
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
