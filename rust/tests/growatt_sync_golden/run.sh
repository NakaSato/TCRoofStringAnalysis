#!/usr/bin/env bash
# Growatt sync golden comparison: the Python sync functions (backend/app/services/growatt_sync,
# growatt_energy, growatt_alarms) and their Rust ports (rust/crates/services: growatt_sync,
# growatt_energy_sync, alarm_sync) run the same steps (scenarios.json) against the same stub
# Growatt (sync_stub.py), each on its own copy of one seeded database; then the rows both wrote
# (golden.py dump) and every step's result are compared. Exit 1 on any difference.
#
#   rust/tests/growatt_sync_golden/run.sh                    # every scenario
#   rust/tests/growatt_sync_golden/run.sh history alarms     # some
#   TEST_PG_PORT=55481 GOLDEN_STUB_PORT=8690 rust/tests/growatt_sync_golden/run.sh
#
# Nothing reaches production: the stub is the only Growatt either side talks to (tokens tok-p1 /
# tok-p2), golden.py blanks every credential before Python's settings load, and the Rust example
# reads no .env at all. The Python dumps of each run (the golden fixtures) stay in $GOLDEN_LOG_DIR.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/rust/tests/growatt_sync_golden"
cd "$ROOT"

PG_PORT="${TEST_PG_PORT:-55481}"
NAME="tcroof-sync-golden-$$"
PW="golden"
LOGS="${GOLDEN_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tcroof-sync-golden.XXXXXX")}"
mkdir -p "$LOGS/py" "$LOGS/rs"
STUB_PID=""
cleanup() {
  [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
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

SCENARIOS=("$@")
if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
  while IFS= read -r s; do SCENARIOS+=("$s"); done < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["scenarios"]))' "$HERE/scenarios.json")
fi

# the plant-local day the stub answers for (Bangkok, UTC+7)
TODAY="$(python3 -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) + timedelta(hours=7)).date())')"

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:${PG_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data postgres:16-alpine -c fsync=off >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null
docker exec "$NAME" psql -U postgres -qc "CREATE DATABASE golden_seed" >/dev/null
rust/scripts/schema.sh "postgresql://postgres:${PW}@127.0.0.1:${PG_PORT}/golden_seed" >/dev/null
docker exec -i "$NAME" psql -U postgres -d golden_seed -v ON_ERROR_STOP=1 -v today="$TODAY" -q >/dev/null <"$HERE/seed.sql"

STUB_PORT="$(free_port "${GOLDEN_STUB_PORT:-8690}")"
python3 -I "$HERE/sync_stub.py" "$STUB_PORT" "$TODAY" >"$LOGS/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 40); do curl -sS "http://127.0.0.1:$STUB_PORT/v1/ping" >/dev/null 2>&1 && break; sleep 0.25; done
STUB="http://127.0.0.1:$STUB_PORT/v1/"

(cd rust && cargo build -q -p tcroof-services --example growatt_sync_golden)
RS_BIN="$ROOT/rust/target/debug/examples/growatt_sync_golden"
# not `python -I`: golden.py imports the backend from PYTHONPATH
PY=(env PYTHONPATH=backend uv run --quiet --with "psycopg[binary]>=3.2" python "$HERE/golden.py")

fail=0
for s in "${SCENARIOS[@]}"; do
  for side in py rs; do
    docker exec "$NAME" psql -U postgres -qc "DROP DATABASE IF EXISTS g_${side}" -c "CREATE DATABASE g_${side} TEMPLATE golden_seed" >/dev/null
  done
  URL_PY="postgresql+psycopg://postgres:${PW}@127.0.0.1:${PG_PORT}/g_py"
  URL_RS="postgres://postgres:${PW}@127.0.0.1:${PG_PORT}/g_rs"
  since="$(python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat())')"
  "${PY[@]}" run "$s" "$URL_PY" "$STUB" "$TODAY" >"$LOGS/py/$s.steps" 2>"$LOGS/py/$s.log" || { echo "python run of $s failed (see $LOGS/py/$s.log)"; fail=1; continue; }
  RUST_LOG=off "$RS_BIN" "$s" "$URL_RS" "$STUB" "$TODAY" >"$LOGS/rs/$s.steps" 2>"$LOGS/rs/$s.log" || { echo "rust run of $s failed (see $LOGS/rs/$s.log)"; fail=1; continue; }
  "${PY[@]}" dump "$URL_PY" "$since" >"$LOGS/py/$s.dump"
  "${PY[@]}" dump "${URL_RS/postgres:\/\//postgresql://}" "$since" >"$LOGS/rs/$s.dump"
  "${PY[@]}" compare "$LOGS/py" "$LOGS/rs" "$s" || fail=1
done
echo "growatt sync golden: ${#SCENARIOS[@]} scenario(s), $([[ $fail == 0 ]] && echo 'all equal' || echo 'DIFFERENCES') (logs: $LOGS)"
exit $fail
