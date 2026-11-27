#!/usr/bin/env bash
# Build the database schema the way production does: by running Python's own startup code,
# `ensure_seeded` (backend/app/db/seed.py), which calls `ensure_schema` (backend/app/db/session.py:
# create_all + added columns / indexes) and seeds the users and the default plant. Rust never
# creates tables (docs/plans/rust-port-master-plan.md §2), so its tests and the parity harness
# start from a database this script made. Idempotent: run it again on the same database freely.
#
#   rust/scripts/schema.sh postgresql://postgres:pw@127.0.0.1:55433/postgres
#   DATABASE_URL=postgres://... rust/scripts/schema.sh
#
# Seeds the dev accounts (admin / admin123, engineer / engineer123) unless APP_ENV=prod.
# SEED_DEMO_DATA defaults to false here (no demo telemetry); export SEED_DEMO_DATA=true for it.
set -euo pipefail
cd "$(dirname "$0")/../.."

URL="${1:-${DATABASE_URL:-}}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <postgres-url>   (or set DATABASE_URL)" >&2
  exit 2
fi
case "$URL" in
  postgresql+psycopg://*) PY_URL="$URL" ;;
  postgresql://*) PY_URL="postgresql+psycopg://${URL#postgresql://}" ;;
  postgres://*) PY_URL="postgresql+psycopg://${URL#postgres://}" ;;
  *) echo "schema.sh: not a Postgres URL: ${URL%%://*}://..." >&2; exit 2 ;;
esac

# The repo .env publishes to the production Firestore (PUBLISH_SINK=firestore + key); never from here.
PYTHONPATH=backend DATABASE_URL="$PY_URL" APP_ENV="${APP_ENV:-dev}" SEED_DEMO_DATA="${SEED_DEMO_DATA:-false}" \
  PUBLISH_SINK=json FIREBASE_CREDENTIALS_FILE= FIREBASE_PROJECT_ID= \
  uv run --quiet --with "psycopg[binary]>=3.2" python -c '
from app.db.seed import ensure_seeded
from app.db.session import SessionLocal, engine

with SessionLocal() as db:
    ensure_seeded(db)  # ensure_schema(engine) first, then users and the default plant
engine.dispose()
print("schema.sh: schema and seed ready on", engine.url.render_as_string(hide_password=True))
'
