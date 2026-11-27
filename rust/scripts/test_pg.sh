#!/usr/bin/env bash
# Run the Rust workspace tests against a throwaway Postgres 16 (the production engine), like
# backend/scripts/test_postgres.sh does for Python. Starts postgres:16-alpine in Docker on
# 127.0.0.1:${TEST_PG_PORT:-55433}, builds the schema with Python (rust/scripts/schema.sh), then
# runs `cargo test` with TEST_DATABASE_URL set. The container is removed on exit.
# Extra arguments go to cargo test:  rust/scripts/test_pg.sh -p tcroof-api --test auth_health
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PORT="${TEST_PG_PORT:-55433}"
NAME="tcroof-rust-pgtest-$$"
PW="pgtest"

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:${PORT}:5432" \
  --tmpfs /var/lib/postgresql/data postgres:16-alpine -c fsync=off -c max_connections=300 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null

# The seeded database is a template: each integration test copies it into a fresh database
# (CREATE DATABASE ... TEMPLATE), so nothing may stay connected to it while tests run.
docker exec "$NAME" psql -U postgres -qc "CREATE DATABASE tcroof_seed" >/dev/null
URL="postgres://postgres:${PW}@127.0.0.1:${PORT}/tcroof_seed"
"$ROOT/rust/scripts/schema.sh" "$URL"

cd "$ROOT/rust"
TEST_DATABASE_URL="$URL" cargo test "$@"
