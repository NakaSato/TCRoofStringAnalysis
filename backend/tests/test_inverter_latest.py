"""`inverter_latest`: each inverter's newest `maxs_data` record stored between `history` runs."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattInverterRaw, GrowattInverterReading, GrowattPlant, GrowattStringReading
from app.db.session import Base, build_engine
from app.services import growatt_sync
from solar_core.growatt import GrowattAPIError

TODAY = date(2026, 11, 15)


def _db(tmp_path, n: int = 3) -> Any:
    engine = build_engine(f"sqlite:///{tmp_path / 'l.db'}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    db.add_all([GrowattPlant(plant_id=1, name="P1", phase=1), GrowattPlant(plant_id=2, name="P2", phase=2)])
    db.add_all([GrowattInverter(device_sn=f"A{i:03}", plant_id=1) for i in range(n)])
    db.add(GrowattInverter(device_sn="Z", plant_id=2))
    db.commit()
    return db


def _rec(t: str, pac: float = 1000.0) -> dict:
    return {"time": t, "pac": pac, "ppv": pac + 50, "status": 1, "eacToday": 12.5, "vString1": 600.0,
            "currentString1": 5.0, "dataloggerSn": "DL1"}


class _Acct:
    def __init__(self, records, fail_from: int = 0, error: Any = None):
        self.records = records
        self.calls: list = []
        self.fail_from = fail_from  # 1-based call number that starts failing (0 = never)
        self.error = error or GrowattAPIError("error_frequently_access", 10012)

    def maxs_latest(self, sns):
        self.calls.append(list(sns))
        if self.fail_from and len(self.calls) >= self.fail_from:
            raise self.error
        return {sn: self.records[sn] for sn in sns if sn in self.records}


def _sync(db, acct, **kw):
    return growatt_sync.sync_latest_records(db, acct, TODAY, phase=1, pause_s=0, **kw)  # type: ignore[arg-type]


def test_newest_record_is_stored_under_its_own_time_and_history_marker_is_untouched(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "history_store_raw", True)  # raw copies are off by default
    db = _db(tmp_path)
    stored = datetime(2026, 11, 15, 11, 30)
    db.get(GrowattInverter, "A000").history_synced_until = stored
    db.commit()
    acct = _Acct({
        "A000": _rec("2026-11-15 11:36:02"),
        "A001": _rec("2025-06-24 14:38:12"),  # silent since June 2025: its old record is not written
        "Z": _rec("2026-11-15 11:36:00"),  # another account's inverter: never asked for
    })
    out = _sync(db, acct)
    assert acct.calls == [["A000", "A001", "A002"]]
    assert (out["inverters"], out["chunks"], out["chunks_read"]) == (3, 1, 1)
    assert (out["answered"], out["not_today"], out["inverter_rows"], out["string_rows"]) == (2, 1, 1, 1)
    assert out["failed"] == []

    row = db.get(GrowattInverterReading, ("A000", datetime(2026, 11, 15, 11, 36, 2)))
    assert row.pac_w == 1000.0 and row.eac_today_kwh == 12.5
    assert db.scalar(select(func.count()).select_from(GrowattInverterReading)) == 1
    assert db.scalar(select(func.count()).select_from(GrowattStringReading)) == 1
    raw = db.get(GrowattInverterRaw, ("A000", datetime(2026, 11, 15, 11, 36, 2)))
    assert raw.data["pac"] == 1000.0 and "dataloggerSn" not in raw.data  # the record as max_data gives it
    # `history` still reads from its own last run, so nothing this job missed is skipped
    assert db.get(GrowattInverter, "A000").history_synced_until == stored

    _sync(db, acct)  # same record again: upsert, no duplicate
    assert db.scalar(select(func.count()).select_from(GrowattInverterReading)) == 1


def test_history_rewrites_the_same_row(tmp_path):
    db = _db(tmp_path)
    _sync(db, _Acct({"A000": _rec("2026-11-15 11:36:02", pac=1000.0)}))

    class Hist:
        def max_history(self, sn, a, b, stop_before=None):
            return [_rec("2026-11-15 11:36:02", pac=1000.0), _rec("2026-11-15 11:31:01", pac=900.0)] if sn == "A000" else []

    growatt_sync.sync_incremental(db, Hist(), TODAY, pause_s=0, phase=1)  # type: ignore[arg-type]
    times = list(db.scalars(select(GrowattInverterReading.timestamp).order_by(GrowattInverterReading.timestamp)))
    assert times == [datetime(2026, 11, 15, 11, 31, 1), datetime(2026, 11, 15, 11, 36, 2)]


def test_rate_limit_ends_the_sweep_and_the_next_run_starts_elsewhere(tmp_path):
    db = _db(tmp_path, n=120)  # 3 chunks of 50 / 50 / 20
    records = {f"A{i:03}": _rec("2026-11-15 11:36:02") for i in range(120)}
    acct = _Acct(records, fail_from=2)
    out = _sync(db, acct)
    assert len(acct.calls) == 2  # stopped at the first 10012, no third call
    assert (out["chunks"], out["chunks_read"], out["inverter_rows"]) == (3, 1, 50)
    assert [name for name, _ in out["failed"]] == ["chunk 2/3", "chunk 3/3"]

    acct = _Acct(records)
    out = _sync(db, acct, first_chunk=1)  # rotated start: the chunks missed above go first
    assert [c[0] for c in acct.calls] == ["A050", "A100", "A000"]
    assert out["failed"] == [] and db.scalar(select(func.count()).select_from(GrowattInverterReading)) == 120


def test_other_error_skips_only_that_chunk(tmp_path):
    db = _db(tmp_path, n=60)
    records = {f"A{i:03}": _rec("2026-11-15 11:36:02") for i in range(60)}

    class Flaky(_Acct):
        def maxs_latest(self, sns):
            self.calls.append(list(sns))
            if len(self.calls) == 1:
                raise GrowattAPIError("server busy", 500)
            return {sn: self.records[sn] for sn in sns}

    out = _sync(db, Flaky(records))
    assert (out["chunks_read"], out["inverter_rows"]) == (1, 10)
    assert [name for name, _ in out["failed"]] == ["chunk 1/2"]


def test_job_is_registered_and_scheduled_only_when_enabled(monkeypatch):
    from app import worker
    from app.services import jobs

    assert "inverter_latest" in jobs.JOBS
    find = lambda: [s for s in worker.default_schedule() if s.job == "inverter_latest"]  # noqa: E731
    monkeypatch.setattr(worker.settings, "worker_latest_interval_min", 0)
    assert find() == []
    monkeypatch.setattr(worker.settings, "worker_latest_interval_min", 2)  # below Growatt's window
    (s,) = find()
    assert s.every == timedelta(minutes=5) and s.between == (5, 20)
    bkk = jobs.PLANT_TZ
    assert s.is_due(datetime(2026, 11, 15, 12, 0, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 15, 21, 0, tzinfo=bkk), None)
    monkeypatch.setattr(worker.settings, "worker_latest_interval_min", 10)
    assert find()[0].every == timedelta(minutes=10)
