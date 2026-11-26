"""Run the test suite against Postgres instead of SQLite (production is Postgres 16).

Opt-in pytest plugin: every SQLite engine a test builds through `app.db.session.build_engine`
becomes a fresh, empty Postgres database on the server named by `TEST_PG_ADMIN_URL` (a superuser
URL to its `postgres` database); the databases are dropped when the run ends. Nothing changes for
a plain `uv run pytest`.

    backend/scripts/test_postgres.sh            # throwaway postgres:16-alpine container, whole suite
    backend/scripts/test_postgres.sh -x backend/tests/test_stock.py

or by hand against a server you already have (never production):

    TEST_PG_ADMIN_URL=postgresql+psycopg://postgres:pw@127.0.0.1:55432/postgres \\
        uv run --with "psycopg[binary]" python -m pytest -q -p tests.pg_plugin
"""

from __future__ import annotations

import os
import uuid
from typing import Dict, List

import pytest
import sqlalchemy as sa

# databases to drop when the current test ends (made by the test or a function-scoped fixture)
_per_test: List[str] = []
# databases made by a module / class / session fixture: kept until the run ends
_per_run: List[str] = []
# depth of wider-scoped fixture setups running now
_wide = [0]
_admin_engine: List[sa.Engine] = []
# a SQLite file URL opened again (a second engine on the same file) gets the same database
_by_url: Dict[str, str] = {}


def _admin_url() -> str:
    url = os.environ.get("TEST_PG_ADMIN_URL", "").strip()
    if not url.startswith("postgresql"):
        raise RuntimeError("tests.pg_plugin needs TEST_PG_ADMIN_URL=postgresql+psycopg://user:pw@host:port/postgres")
    return url


def _admin() -> sa.Engine:
    if not _admin_engine:
        _admin_engine.append(sa.create_engine(_admin_url(), isolation_level="AUTOCOMMIT", pool_size=1))
    return _admin_engine[0]


def _drop(names: List[str]) -> None:
    if not names:
        return
    with _admin().connect() as c:
        for name in names:
            c.execute(sa.text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    gone = set(names)
    for url in [u for u, n in _by_url.items() if n in gone]:
        del _by_url[url]
    names.clear()


def pytest_configure(config):
    import app.db.session as sess

    admin_url = _admin_url()
    orig = sess.build_engine

    def pg_build(database_url: str | None = None):
        if database_url and database_url.startswith("sqlite"):
            in_memory = database_url.rstrip("/") in ("sqlite:", "sqlite:/", "sqlite://") or ":memory:" in database_url
            name = None if in_memory else _by_url.get(database_url)
            if name is None:
                name = "t_" + uuid.uuid4().hex[:12]
                with _admin().connect() as c:
                    c.execute(sa.text(f'CREATE DATABASE "{name}"'))
                (_per_run if _wide[0] else _per_test).append(name)
                if not in_memory:
                    _by_url[database_url] = name
            return orig(admin_url.rsplit("/", 1)[0] + "/" + name)
        return orig(database_url)

    # patched before the test modules are imported, so their `from app.db.session import build_engine` gets it
    sess.build_engine = pg_build


def pytest_collection_modifyitems(config, items):
    skip = pytest.mark.skip(reason="SQLite-only (PRAGMA, sqlite_master, JSON as text): not run on Postgres")
    for item in items:
        if item.get_closest_marker("sqlite_only"):
            item.add_marker(skip)


@pytest.hookimpl(hookwrapper=True)
def pytest_fixture_setup(fixturedef, request):
    wide = fixturedef.scope != "function"
    _wide[0] += wide
    try:
        yield
    finally:
        _wide[0] -= wide


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item, nextitem):
    yield
    # the test's fixtures are torn down: its databases go now (thousands would fill the server's disk)
    _drop(_per_test)


def pytest_report_header(config):
    url = sa.engine.make_url(_admin_url())
    return f"database: Postgres at {url.host}:{url.port} (tests.pg_plugin, a fresh database per engine)"


def pytest_unconfigure(config):
    _drop(_per_test)
    _drop(_per_run)
    for eng in _admin_engine:
        eng.dispose()
    _admin_engine.clear()
