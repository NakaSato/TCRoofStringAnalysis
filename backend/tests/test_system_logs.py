"""System → Logs: DB log handler, redaction, job-run context, admin API, retention."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app import logging_db
from app.config import settings
from app.db.models import AppLog
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import jobs
from app.services import system_logs as sl

NOW = datetime(2026, 11, 13, 6, 0, tzinfo=timezone.utc)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite:///{tmp_path / 'logs.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    with f() as s:
        ensure_seeded(s)
    h = logging_db.DbLogHandler("worker", engine)
    monkeypatch.setattr(logging_db, "_handler", h)
    root = logging.getLogger()
    root.addHandler(h)
    old = root.level
    root.setLevel(logging.INFO)
    yield f, h
    root.removeHandler(h)
    root.setLevel(old)


def _rows(f):
    with f() as db:
        return list(db.scalars(select(AppLog).order_by(AppLog.id)))


def test_handler_stores_records_with_source_level_logger_and_traceback(env):
    f, h = env
    logging.getLogger("app.services.growatt_sync").warning("phase %s: %d failed", 2, 3)
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        logging.getLogger("app.x").exception("job failed")
    logging.getLogger("app.x").debug("not stored at INFO")
    assert h.pending() == 2
    h.flush()
    rows = _rows(f)
    assert [(r.level, r.level_no, r.source, r.logger, r.message) for r in rows] == [
        ("WARNING", 30, "worker", "app.services.growatt_sync", "phase 2: 3 failed"),
        ("ERROR", 40, "worker", "app.x", "job failed"),
    ]
    assert "RuntimeError: boom" in (rows[1].exc_text or "") and rows[0].exc_text is None
    assert rows[0].ts.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)


def test_noisy_loggers_are_not_stored(env):
    f, h = env
    logging.getLogger("sqlalchemy.engine").warning("SELECT 1")
    logging.getLogger("urllib3.connectionpool").info("GET https://x/?key=abc")
    logging.getLogger("urllib3.connectionpool").warning("retrying")
    h.flush()
    assert [r.logger for r in _rows(f)] == ["urllib3.connectionpool"]


def test_job_run_context_reaches_records_including_phase_threads(env, monkeypatch):
    f, h = env

    def fake_job(db):
        logging.getLogger("app.services.jobs").info("inside the job")
        status, detail = jobs._per_phase(db, lambda s, c, phase, first: (logging.getLogger("app.p").info("phase %s", phase), {})[1])
        return "ok", {}

    monkeypatch.setitem(jobs.JOBS, "history", fake_job)
    monkeypatch.setattr(jobs, "_clients", lambda: {1: object(), 2: object()})
    monkeypatch.setattr(settings, "worker_parallel_accounts", True)
    with f() as db:
        run_id = jobs.claim(db, "history", "cli")
    jobs.execute(f, run_id)
    h.flush()
    rows = _rows(f)
    assert {r.message for r in rows} >= {"inside the job", "phase 1", "phase 2", "job history finished: ok"}
    assert all(r.run_id == run_id and r.job == "history" for r in rows if r.logger in ("app.p", "app.services.jobs"))
    assert logging_db.run_id_var.get() is None  # reset after the run
    logging.getLogger("app.y").info("after")
    h.flush()
    assert _rows(f)[-1].run_id is None


def test_redaction_of_settings_secrets_and_patterns(monkeypatch):
    monkeypatch.setattr(settings, "growatt_token_phase2", "g7x9k2m4q8w1e5r3t6y0")
    monkeypatch.setattr(settings, "google_weather_api_key", "AIzaSyD-not-a-real-key-123456")
    monkeypatch.setattr(settings, "database_url", "postgresql+psycopg://tcroof:s3cretPassw0rd@10.0.0.2:5432/tcroof")
    samples = {
        # requests error string with the URL, as urllib3 / requests print it
        "HTTPSConnectionPool(host='weather.googleapis.com', port=443): Max retries exceeded with url: "
        "/v1/currentConditions:lookup?key=AIzaSyD-not-a-real-key-123456&location.latitude=13.7": "AIzaSyD",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl": "eyJhbGci",
        "token=g7x9k2m4q8w1e5r3t6y0 rejected": "g7x9k2m4",
        "growatt said 10012 for g7x9k2m4q8w1e5r3t6y0": "g7x9k2m4",
        "connect to postgresql+psycopg://tcroof:s3cretPassw0rd@10.0.0.2:5432/tcroof failed": "s3cret",
        "postgresql://other:pa55word99@db/x": "pa55word99",
        "{'token': 'abcdefghijklmnop1234'}": "abcdefghijklmnop",
    }
    for text, leak in samples.items():
        out = logging_db.redact(text) or ""
        assert leak not in out and "***" in out, out
    assert logging_db.redact("history ok: 629 inverters") == "history ok: 629 inverters"
    assert logging_db.redact(None) is None


def test_stored_record_is_redacted(env, monkeypatch):
    f, h = env
    monkeypatch.setattr(settings, "growatt_token_phase1", "tokenvalue123456789")
    logging.getLogger("app.z").error("call failed for tokenvalue123456789", extra={"ctx": {"url": "https://x/?token=tokenvalue123456789"}})
    h.flush()
    r = _rows(f)[0]
    assert "tokenvalue" not in r.message and "tokenvalue" not in str(r.extra_json)


def test_failed_insert_is_dropped_without_recursion(tmp_path, capsys):
    engine = build_engine(f"sqlite:///{tmp_path / 'empty.db'}")  # no app_logs table
    h = logging_db.DbLogHandler("api", engine)
    lg = logging.getLogger("app.recursion")
    lg.addHandler(h)
    try:
        lg.error("first")
        h.flush()  # insert fails: printed to stderr, nothing re-logged
        assert h.pending() == 0
        assert "app_logs insert failed, 1 records dropped" in capsys.readouterr().err
    finally:
        lg.removeHandler(h)


def test_buffer_overflow_keeps_newest_and_reports_drops(env):
    f, _ = env
    h = logging_db.DbLogHandler("cli", f.kw["bind"], buffer_max=3)
    lg = logging.getLogger("app.overflow")
    lg.propagate = False
    lg.addHandler(h)
    try:
        for i in range(5):
            lg.info("line %d", i)
        h.flush()
    finally:
        lg.removeHandler(h)
        lg.propagate = True
    msgs = [r.message for r in _rows(f)]
    assert msgs == ["line 2", "line 3", "line 4", "log buffer full: 2 older records dropped"]


# --- API ------------------------------------------------------------------------------------


def _client(f, username, with_boom=False):
    app = create_app()
    if with_boom:
        r = APIRouter()

        @r.get("/boom")
        def boom():
            raise RuntimeError("kaboom")

        app.include_router(r, prefix="/api")

    def _db():
        db = f()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app, raise_server_exceptions=False)
    pw = {"admin": "admin123", "engineer": "engineer123"}[username]
    tok = c.post("/api/auth/login", json={"username": username, "password": pw}).json()["access_token"]
    c.headers.update({"Authorization": f"Bearer {tok}"})
    return c


def test_engineer_403_admin_200(env):
    f, _ = env
    assert _client(f, "engineer").get("/api/system/logs").status_code == 403
    assert _client(f, "engineer").get("/api/system/logs/summary").status_code == 403
    r = _client(f, "admin").get("/api/system/logs")
    assert r.status_code == 200 and r.json()["meta"]["source"] == "db"


def test_unhandled_exception_is_logged_with_traceback_and_request_id(env):
    f, h = env
    c = _client(f, "admin", with_boom=True)
    assert c.get("/api/boom").status_code == 500
    # the middleware flushed before answering: no explicit flush here
    row = next(r for r in _rows(f) if r.logger == "app.api.request")
    assert row.level == "ERROR" and "GET /boom failed" in row.message
    assert "RuntimeError: kaboom" in (row.exc_text or "") and row.request_id


def test_slow_live_route_is_info_other_slow_route_is_warning(env, monkeypatch):
    f, _ = env
    app = create_app()
    r = APIRouter()

    @r.get("/growatt/live/slowpoke")
    def slow_live():
        return {}

    @r.get("/slowpoke")
    def slow_db():
        return {}

    app.include_router(r, prefix="/api")
    monkeypatch.setattr(settings, "log_slow_request_ms", -1)  # every request counts as slow
    c = TestClient(app)
    assert c.get("/api/growatt/live/slowpoke").status_code == 200
    assert c.get("/api/slowpoke").status_code == 200
    rows = {r.message.split(" slow:")[0]: r for r in _rows(f) if r.logger == "app.api.request"}
    live, db = rows["GET /growatt/live/slowpoke"], rows["GET /slowpoke"]
    assert live.level == "INFO" and "waited on Growatt / Google" in live.message
    assert db.level == "WARNING" and "waited on" not in db.message


def test_failed_login_and_admin_actions_are_audited(env):
    f, h = env
    app = create_app()
    app.dependency_overrides[get_db] = lambda: (yield from [f()])  # type: ignore[misc]
    TestClient(app).post("/api/auth/login", json={"username": "admin", "password": "wrong-password"})
    c = _client(f, "admin")
    c.post("/api/growatt/sync/retention")
    h.flush()
    msgs = [r.message for r in _rows(f) if r.logger == "app.audit"]
    assert msgs[0] == "failed login for 'admin'" and "wrong-password" not in " ".join(msgs)
    assert any(m.startswith("admin queued job retention (run ") for m in msgs)


def _seed(f, rows):
    with f() as db:
        db.add_all(rows)
        db.commit()


def _log(i, level="INFO", source="worker", minutes_ago=10, **kw):
    return AppLog(
        id=i, ts=NOW - timedelta(minutes=minutes_ago), level=level, level_no=logging.getLevelNamesMapping()[level],
        source=source, logger=kw.pop("logger", "app.services.growatt_sync"), message=kw.pop("message", f"msg {i}"), **kw,
    )


def test_filters_and_paging(env):
    f, _ = env
    _seed(
        f,
        [
            _log(1, "INFO", minutes_ago=60 * 30),  # outside the default 24 h
            _log(2, "INFO", run_id=7, job="history"),
            _log(3, "WARNING", run_id=7, job="history", message="Phase 2: 10012 rate limit"),
            _log(4, "ERROR", source="api", logger="app.api.request", message="GET /x answered 500"),
            _log(5, "DEBUG"),
            _log(6, "INFO", source="cli", message="100%_done"),
        ],
    )
    with f() as db:
        ids = lambda **kw: [x["id"] for x in sl.list_logs(db, now=NOW, **kw)["items"]]  # noqa: E731
        assert ids() == [6, 4, 3, 2]  # INFO+, last 24 h, newest first
        assert ids(level="WARNING") == [4, 3]
        assert ids(sources=["api", "cli"]) == [6, 4]
        assert ids(run_id=7) == [3, 2]
        assert ids(job="history", level="warning") == [3]
        assert ids(q="RATE LIMIT") == [3]
        assert ids(q="100%") == [6] and ids(q="%") == [6]  # % is literal
        assert ids(logger="app.api") == [4]
        assert ids(since=datetime(2026, 11, 12, 6, 0)) == [6, 4, 3, 2, 1]  # naive = Bangkok: 23:00 UTC the day before
        assert ids(level="DEBUG") == [6, 5, 4, 3, 2]
        page = sl.list_logs(db, now=NOW, limit=2)
        assert [x["id"] for x in page["items"]] == [6, 4] and page["next_before_id"] == 4
        assert ids(before_id=4, limit=2) == [3, 2]
        assert ids(after_id=3) == [6, 4]
        with pytest.raises(ValueError):
            sl.list_logs(db, level="LOUD")
        s = sl.summary(db, now=NOW)
    assert s["total"] == 5 and s["by_level"]["ERROR"] == 1 and s["by_source"] == {"api": 1, "worker": 3, "cli": 1}
    assert s["last_error"]["id"] == 4 and s["newest_id"] == 6


def test_api_filters_and_validation(env):
    f, _ = env
    _seed(f, [_log(1, "WARNING", minutes_ago=1, message="warn"), _log(2, "INFO", minutes_ago=1, source="api")])
    c = _client(f, "admin")
    body = c.get("/api/system/logs", params={"level": "WARNING", "since": "2026-11-13T05:00:00Z"}).json()  # seeded rows use the fixed NOW
    assert [x["message"] for x in body["items"]] == ["warn"] and body["items"][0]["ts"].endswith("Z")
    assert c.get("/api/system/logs", params={"level": "nope"}).status_code == 422
    assert c.get("/api/system/logs", params={"source": "browser"}).status_code == 422
    assert c.get("/api/system/logs", params={"limit": 5000}).status_code == 422


def test_retention_by_age_and_row_cap(env):
    f, _ = env
    _seed(f, [_log(i, minutes_ago=60 * 24 * 20) for i in range(1, 4)] + [_log(i, minutes_ago=5) for i in range(4, 10)])
    with f() as db:
        assert sl.prune_logs(db, NOW, retention_days=14, max_rows=4) == 3 + 2
        assert list(db.scalars(select(AppLog.id).order_by(AppLog.id))) == [6, 7, 8, 9]
        assert sl.prune_logs(db, NOW, 14, 4) == 0
        assert db.scalar(select(func.count()).select_from(AppLog)) == 4
