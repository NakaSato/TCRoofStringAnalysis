"""Storage trims: compact MPPT lists in inverter readings, clipped job-run text, job-run retention."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattInverterReading, GrowattPlant, SyncRun
from app.db.session import Base, build_engine
from app.services import jobs

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)
MPPTS = [{"mppt": 1, "v": 324.6, "i": 8.1, "p": 2629.3}, {"mppt": 3, "v": 316.8, "i": 0.0, "p": 0.0}]


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'compact.db'}")
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def _inverter(db) -> None:
    db.add(GrowattPlant(plant_id=1, name="P"))
    db.add(GrowattInverter(device_sn="SN1", plant_id=1))
    db.commit()


def test_mppt_list_is_stored_compact_and_read_back_as_dicts(factory):
    with factory() as db:
        _inverter(db)
        db.add(GrowattInverterReading(device_sn="SN1", timestamp=datetime(2026, 11, 23, 9, 0), mppt_json=MPPTS))
        db.commit()
        stored = db.execute(text("SELECT mppt_json FROM growatt_inverter_readings")).scalar_one()
        assert stored == "[[1,324.6,8.1,2629.3],[3,316.8,0.0,0.0]]"
        assert db.scalar(select(GrowattInverterReading.mppt_json)) == MPPTS


def test_mppt_rows_stored_in_the_old_dict_form_still_read(factory):
    with factory() as db:
        _inverter(db)
        db.execute(
            text("INSERT INTO growatt_inverter_readings (device_sn, timestamp, mppt_json) VALUES ('SN1', '2026-11-20 09:00:00.000000', :j)"),
            {"j": '[{"mppt": 1, "v": 324.6, "i": 8.1, "p": 2629.3}]'},
        )
        db.commit()
        assert db.scalar(select(GrowattInverterReading.mppt_json)) == MPPTS[:1]


def test_job_detail_and_error_text_is_clipped():
    long = "x" * 5000
    out = jobs._jsonable({"failed": [["SN1", long]], "n": 3})
    assert out["n"] == 3
    assert len(out["failed"][0][1]) < jobs.RUN_TEXT_MAX + 40
    assert out["failed"][0][1].startswith("x" * jobs.RUN_TEXT_MAX)
    assert out["failed"][0][1].endswith("(4500 more characters)")
    assert jobs._clip("short") == "short"


def test_prune_runs_keeps_recent_running_and_each_jobs_newest(factory):
    old = NOW - timedelta(days=120)
    with factory() as db:
        db.add_all(
            [
                SyncRun(job="history", status="ok", started_at=old),  # old: deleted
                SyncRun(job="history", status="ok", started_at=NOW - timedelta(days=1)),  # recent: kept
                SyncRun(job="backfill", status="partial", started_at=old),  # old but backfill's newest: kept
                SyncRun(job="fleet", status="running", started_at=old - timedelta(days=1)),  # running: kept
                SyncRun(job="fleet", status="ok", started_at=old),  # old, fleet's newest: kept
            ]
        )
        db.commit()
        assert jobs.prune_runs(db, NOW, 90) == 1
        left = sorted((r.job, r.status) for r in db.scalars(select(SyncRun)))
        assert left == [("backfill", "partial"), ("fleet", "ok"), ("fleet", "running"), ("history", "ok")]
