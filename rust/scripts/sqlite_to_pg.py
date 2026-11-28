"""Copy the local SQLite database into a Postgres database whose schema Python already built
(rust/scripts/schema.sh), so the Rust API (Postgres only) and the Python API can run on the same
data locally (rust/scripts/split_api.py). Read-only on SQLite; replaces every row in Postgres.

    rust/scripts/schema.sh postgresql://postgres:pw@127.0.0.1:55440/tcroof
    PYTHONPATH=backend uv run --with "psycopg[binary]>=3.2" python rust/scripts/sqlite_to_pg.py \\
        --sqlite data/solar_fullstack.db --pg postgresql://postgres:pw@127.0.0.1:55440/tcroof

- Tables = Python's models (`app.db.models` Base.metadata); SQLite tables the models do not know
  and columns missing on either side are listed and skipped. Views are not copied (Postgres has
  its own, from ensure_schema).
- One SQLite read transaction for the whole copy: a consistent snapshot while the local
  history job keeps writing (WAL).
- Values go over COPY as SQLite holds them: JSON columns keep their stored (compact) text,
  naive datetimes are read as UTC for `timestamptz` columns (SQLite stores those as UTC) and as
  they are for the naive plant-local reading times.
- Foreign keys are not checked during the copy (`session_replication_role = replica`): SQLite
  may hold rows whose parent is gone. Each table is its own transaction; a table that fails is
  reported and the rest go on. Serial sequences are moved past the copied ids at the end.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time

import psycopg
from psycopg import sql

from app.db.models import Base  # noqa: F401  (registers every table)

BATCH = 50_000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", required=True)
    ap.add_argument("--pg", required=True, help="postgresql://… (schema built by schema.sh)")
    args = ap.parse_args()

    src = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
    src.isolation_level = None
    src.execute("BEGIN")  # one snapshot for every table
    sqlite_tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    tables = [t for t in Base.metadata.sorted_tables]
    known = {t.name for t in tables}
    skipped = sorted(t for t in sqlite_tables if t not in known and not t.startswith("sqlite_") and t != "alembic_version")
    if skipped:
        print(f"SQLite tables not in the models (skipped): {', '.join(skipped)}")

    pg_url = args.pg.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(pg_url, autocommit=True) as pg:
        pg.execute("SET TIME ZONE 'UTC'")
        pg.execute("SET session_replication_role = replica")
        names = [t.name for t in tables]
        pg.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY CASCADE").format(sql.SQL(", ").join(map(sql.Identifier, names))))
        total = 0
        failed = []
        for t in tables:
            if t.name not in sqlite_tables:
                print(f"  {t.name}: not in SQLite (left empty)")
                continue
            src_cols = [r[1] for r in src.execute(f'PRAGMA table_info("{t.name}")')]
            cols = [c.name for c in t.columns if c.name in src_cols]
            missing = [c.name for c in t.columns if c.name not in src_cols]
            extra = [c for c in src_cols if c not in {x.name for x in t.columns}]
            t0 = time.monotonic()
            n = 0
            try:
                with pg.transaction():
                    copy_sql = sql.SQL("COPY {} ({}) FROM STDIN").format(
                        sql.Identifier(t.name), sql.SQL(", ").join(map(sql.Identifier, cols))
                    )
                    with pg.cursor().copy(copy_sql) as cp:
                        cur = src.execute(f'SELECT {", ".join(chr(34) + c + chr(34) for c in cols)} FROM "{t.name}"')
                        while rows := cur.fetchmany(BATCH):
                            for r in rows:
                                cp.write_row(r)
                            n += len(rows)
            except Exception as exc:  # report and go on with the next table
                failed.append(t.name)
                print(f"  {t.name}: FAILED after {n} rows: {exc}")
                continue
            total += n
            note = (f", left at default: {missing}" if missing else "") + (f", not copied: {extra}" if extra else "")
            print(f"  {t.name}: {n} rows ({time.monotonic() - t0:.1f} s){note}", flush=True)

        # serial ids continue after the copied ones
        seqs = pg.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'"
        ).fetchall()
        for table, col in seqs:
            pg.execute(
                sql.SQL("SELECT setval(pg_get_serial_sequence(%s, %s), coalesce(max({c}), 1), max({c}) IS NOT NULL) FROM {t}").format(
                    c=sql.Identifier(col), t=sql.Identifier(table)
                ),
                (table, col),
            )
        pg.execute("ANALYZE")
    src.execute("ROLLBACK")
    print(f"copied {total} rows into {len(tables) - len(failed)} tables" + (f"; FAILED: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
