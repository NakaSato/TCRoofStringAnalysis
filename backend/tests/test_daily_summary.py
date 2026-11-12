"""Daily summary publishing: document layout, change-only writes, write budget, sinks."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone

import pytest
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverterReading, PublishWriteCount
from app.db.session import Base, build_engine
from app.services import daily_summary as ds
from tests.test_growatt_routes import PLANT, SN_A, SN_B, _seed_growatt

DAY = date(2026, 11, 11)
NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)  # 04:00 Pacific → quota day 2026-11-12


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'daily.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as s:
        _seed_growatt(s)
        yield s


class MemorySink:
    name = "memory"

    def __init__(self):
        self.docs: dict = {}
        self.calls = 0

    def write(self, docs):
        self.calls += 1
        self.docs.update(dict(docs))


def test_day_docs_layout_and_no_realtime_fields(db):
    docs = dict(ds.build_day_docs(db, DAY))
    assert set(docs) == {
        f"daily/{DAY}",
        f"daily/{DAY}/plants/{PLANT}",
        f"daily/{DAY}/inverters/{SN_A}",
        f"daily/{DAY}/inverters/{SN_B}",  # INVC has no readings → no doc
    }
    fleet = docs[f"daily/{DAY}"]
    assert fleet["plants"][str(PLANT)]["yield_kwh"] == pytest.approx(9.9)
    assert fleet["plants_with_data"] == 1

    plant = docs[f"daily/{DAY}/plants/{PLANT}"]
    assert len(plant["hourly_kw"]) == 24 and plant["hourly_kw"][10] == pytest.approx(10.0)
    assert plant["hourly_kw"][3] is None

    inv = docs[f"daily/{DAY}/inverters/{SN_A}"]
    assert set(inv["strings"]) == {"1", "2"}
    assert inv["strings"]["1"]["kwh"] == pytest.approx(3.0, abs=0.2)

    registry = dict(ds.build_registry_docs(db))
    assert set(registry[f"plants/{PLANT}"]["inverters"]) == {SN_A, SN_B, "INVC"}

    realtime = {"current_power_w", "current_power_kw", "current_ac_kw", "status", "lost", "last_update_time"}
    for path, doc in {**docs, **registry}.items():
        flat = json.dumps(doc)
        for key in realtime:
            assert f'"{key}"' not in flat, (path, key)


def test_publish_writes_only_changed_docs(db):
    sink = MemorySink()
    docs = ds.build_day_docs(db, DAY)
    first = ds.publish(db, sink, docs, budget=1000, now=NOW)
    assert first.written == len(docs) and first.unchanged == 0
    assert all("published_at" in d for d in sink.docs.values())

    again = ds.publish(db, sink, ds.build_day_docs(db, DAY), budget=1000, now=NOW)
    assert again.written == 0 and again.unchanged == len(docs)
    assert sink.calls == 1  # nothing sent the second time

    # a late upload changes one inverter → its doc, the plant doc and the fleet doc change
    db.add(GrowattInverterReading(device_sn=SN_B, timestamp=datetime(2026, 11, 11, 11, 0, 20), pac_w=4000, ppv_w=4100, eac_today_kwh=4.3))
    db.commit()
    third = ds.publish(db, sink, ds.build_day_docs(db, DAY), budget=1000, now=NOW)
    assert third.written == 3
    assert db.get(PublishWriteCount, ("memory", "2026-11-12")).writes == len(docs) + 3


def test_publish_respects_budget_and_dry_run(db):
    sink = MemorySink()
    docs = ds.build_day_docs(db, DAY)

    dry = ds.publish(db, sink, docs, budget=1000, dry_run=True, now=NOW)
    assert dry.written == len(docs) and sink.calls == 0
    assert db.get(PublishWriteCount, ("memory", "2026-11-12")) is None

    capped = ds.publish(db, sink, docs, budget=2, now=NOW)
    assert capped.written == 2 and len(capped.over_budget) == len(docs) - 2
    rest = ds.publish(db, sink, docs, budget=2, now=NOW)
    assert rest.written == 0 and rest.unchanged == 2

    next_quota_day = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
    rest = ds.publish(db, sink, docs, budget=2, now=next_quota_day)
    assert rest.written == 2


def test_oversized_doc_is_rejected(db):
    sink = MemorySink()
    rep = ds.publish(db, sink, [("big/doc", {"x": "a" * (ds.MAX_DOC_BYTES + 1)})], budget=10, now=NOW)
    assert rep.written == 0 and rep.too_large and sink.calls == 0


def test_quota_day_uses_pacific_midnight():
    assert ds.quota_day(datetime(2026, 11, 12, 7, 59, tzinfo=timezone.utc)) == "2026-11-11"
    assert ds.quota_day(datetime(2026, 11, 12, 8, 1, tzinfo=timezone.utc)) == "2026-11-12"


def test_json_and_firestore_sinks(tmp_path):
    ds.JsonFileSink(tmp_path).write([("daily/2026-11-11/plants/1", {"a": 1})])
    assert json.loads((tmp_path / "daily/2026-11-11/plants/1.json").read_text()) == {"a": 1}

    class FakeBatch:
        def __init__(self, log):
            self.log, self.ops = log, []

        def set(self, ref, doc):
            self.ops.append((ref, doc))

        def commit(self):
            self.log.append(len(self.ops))

    class FakeClient:
        def __init__(self):
            self.commits: list = []

        def batch(self):
            return FakeBatch(self.commits)

        def document(self, path):
            return path

    sink = ds.FirestoreSink.__new__(ds.FirestoreSink)
    sink.client = FakeClient()
    sink.write([(f"d/{i}", {"i": i}) for i in range(850)])
    assert sink.client.commits == [400, 400, 50]

    with pytest.raises(RuntimeError, match="FIREBASE_CREDENTIALS_FILE"):
        ds.FirestoreSink("")
