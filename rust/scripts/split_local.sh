#!/usr/bin/env bash
# Local split API: Python on :8010, Rust on :8001, rust/scripts/split_api.py on :8000 routing the
# paths Rust serves to Rust and the rest to Python. The frontend is unchanged: `cd frontend && bun
# run dev` proxies /api to :8000 as always. Ctrl-C stops all three.
#
#   rust/scripts/split_local.sh                      # LOCAL_PG_URL default below
#   LOCAL_PG_URL=postgresql://... rust/scripts/split_local.sh
#
# Database: a local Postgres 16 (Rust speaks Postgres only), e.g. the `tcroof-local-pg` container
# filled from data/solar_fullstack.db by rust/scripts/sqlite_to_pg.py (a snapshot: copy again to
# refresh). Both APIs read the repo .env for everything else (JWT secret, Growatt tokens), with
# DATABASE_URL replaced, and PUBLISH_SINK=json so a save never publishes to the production
# Firestore from here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PG="${LOCAL_PG_URL:-postgresql://postgres:localsplit@127.0.0.1:55440/tcroof}"
PY_PORT="${SPLIT_PY_PORT:-8010}"
RUST_PORT="${SPLIT_RUST_PORT:-8001}"
PORT="${SPLIT_PORT:-8000}"
LOGS="${SPLIT_LOG_DIR:-${TMPDIR:-/tmp}/tcroof-split}"
mkdir -p "$LOGS"

for p in "$PY_PORT" "$RUST_PORT" "$PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "split_local: port $p is in use (stop the API running there first)" >&2
    exit 1
  fi
done

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

export PUBLISH_SINK=json
DATABASE_URL="postgresql+psycopg://${PG#postgresql://}" PYTHONPATH=backend \
  uv run --quiet --with "psycopg[binary]>=3.2" python -m uvicorn app.main:app --port "$PY_PORT" >"$LOGS/python.log" 2>&1 &
PIDS+=($!)
(cd rust && cargo build -q -p tcroof-api && DATABASE_URL="$PG" RUST_API_PORT="$RUST_PORT" exec ./target/debug/tcroof-api) >"$LOGS/rust.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$PY_PORT/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$RUST_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PY_PORT/health" >/dev/null || { echo "split_local: Python API did not start (see $LOGS/python.log)" >&2; exit 1; }
curl -fsS "http://127.0.0.1:$RUST_PORT/health" >/dev/null || { echo "split_local: Rust API did not start (see $LOGS/rust.log)" >&2; exit 1; }
echo "split_local: Python :$PY_PORT, Rust :$RUST_PORT (logs in $LOGS); split on :$PORT"
python3 -I rust/scripts/split_api.py --port "$PORT" --python "http://127.0.0.1:$PY_PORT" --rust "http://127.0.0.1:$RUST_PORT" | tee "$LOGS/split.log"
