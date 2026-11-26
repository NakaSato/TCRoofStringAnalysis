#!/usr/bin/env bash
# Run the backend test suite against a throwaway Postgres 16 (the production engine) instead of
# SQLite. Starts postgres:16-alpine in Docker on 127.0.0.1:${TEST_PG_PORT:-55432}, runs pytest with
# tests/pg_plugin.py (a fresh database per test engine), then removes the container.
# Extra arguments go to pytest:  backend/scripts/test_postgres.sh -x backend/tests/test_stock.py
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${TEST_PG_PORT:-55432}"
NAME="tcroof-pgtest-$$"
PW="pgtest"

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:${PORT}:5432" \
  --tmpfs /var/lib/postgresql/data postgres:16-alpine -c fsync=off -c max_connections=300 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null

TEST_PG_ADMIN_URL="postgresql+psycopg://postgres:${PW}@127.0.0.1:${PORT}/postgres" \
  uv run --with "psycopg[binary]>=3.2" python -m pytest -q -p tests.pg_plugin "$@"
