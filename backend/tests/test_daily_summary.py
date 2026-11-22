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
    assert plant["weather"]["has_sensor"] is False and set(plant["weather"]["slots"]) == {"09", "13", "17"}

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


def test_registry_plant_doc_carries_its_drive_links_only_when_it_has_them(db):
    from app.db.models import PlantDocument

    before = dict(ds.build_registry_docs(db))[f"plants/{PLANT}"]
    assert "documents" not in before  # no link: the doc is unchanged, so nothing is rewritten
    db.add(PlantDocument(plant_id=PLANT, kind="asbuilt", drive_id="F1", url="https://drive.google.com/file/d/F1/view",
                         title="AS BUILT 1.pdf", revision="REV.1", source="matched", match_score=1.0, updated_by="admin"))
    db.add(PlantDocument(plant_id=PLANT, kind="site_photos", url="https://drive.google.com/drive/folders/D1",
                         title="1 Site / Picture", source="manual", updated_by="admin"))
    db.commit()
    doc = dict(ds.build_registry_docs(db))[f"plants/{PLANT}"]
    assert doc["documents"] == {
        "asbuilt": {"url": "https://drive.google.com/file/d/F1/view", "title": "AS BUILT 1.pdf", "revision": "REV.1"},
        "site_photos": {"url": "https://drive.google.com/drive/folders/D1", "title": "1 Site / Picture", "revision": None},
    }  # who set a link stays in SQL
    assert {k: v for k, v in doc.items() if k != "documents"} == before


def test_registry_plant_doc_carries_its_site_register_fields_only(db):
    from datetime import date as _date

    from app.db.models import SiteDevice, SiteRegister

    before = dict(ds.build_registry_docs(db))[f"plants/{PLANT}"]
    assert "site" not in before
    db.add(SiteRegister(site_code="P1-001", plant_id=PLANT, match_rule="logger_sn", name="Site 1", project_phase=1,
                        province="ชลบุรี", pea_account_no="020012345678", pea_meter_no="M1", cod_actual=_date(2024, 3, 1),
                        engineers_text="Somchai", imported_by="admin"))
    db.add(SiteRegister(site_code="P1-002", plant_id=None, name="Unmatched", province="ระยอง", imported_by="admin"))
    db.flush()
    db.add(SiteDevice(site_code="P1-001", kind="router", seq=1, ip="10.0.0.1", sim="0812345678"))
    db.commit()
    docs = dict(ds.build_registry_docs(db))
    doc = docs[f"plants/{PLANT}"]
    assert doc["site"] == {"site_code": "P1-001", "project_phase": 1, "province": "ชลบุรี", "cod_actual": "2024-03-01"}
    assert {k: v for k, v in doc.items() if k != "site"} == before
    text = json.dumps(docs, ensure_ascii=False)
    for secret in ("020012345678", "10.0.0.1", "0812345678", "Somchai", "ระยอง"):
        assert secret not in text  # network, account numbers, people and unmatched stations stay in SQL


def test_inverter_doc_carries_the_string_topology_only_when_entered(db):
    from app.db.models import GrowattInverter, GrowattStringLayout, GrowattStringRemoved

    before = dict(ds.build_inverter_docs(db, PLANT))
    assert not {"strings", "removed_strings", "inputs", "device_model"} & set(before[f"inverters/{SN_A}"])

    db.get(GrowattInverter, SN_A).device_model = "MAX 125KTL3-X LV"
    db.get(GrowattInverter, SN_B).device_model = "SOME UNKNOWN MODEL"
    db.add_all(
        [
            GrowattStringLayout(device_sn=SN_A, string_no=1, modules=18, module_wp=None, azimuth_deg=90.0, tilt_deg=10.0),
            GrowattStringLayout(device_sn=SN_A, string_no=4, modules=16, module_wp=550.0),
            GrowattStringRemoved(device_sn=SN_A, string_no=3),
            GrowattStringLayout(device_sn=SN_B, string_no=2, modules=20, module_wp=None),
        ]
    )
    db.commit()
    docs = dict(ds.build_inverter_docs(db, PLANT))

    a = docs[f"inverters/{SN_A}"]
    assert a["strings"] == [
        {"string_no": 1, "modules": 18, "module_wp": None, "mppt": 1, "azimuth_deg": 90.0, "tilt_deg": 10.0},
        {"string_no": 4, "modules": 16, "module_wp": 550.0, "mppt": 2},
    ]
    assert a["removed_strings"] == [3]
    assert a["device_model"] == "MAX 125KTL3-X LV"
    assert a["inputs"]["strings_per_mppt"] == 2 and a["inputs"]["mppt_count"] > 0

    # a model not in the catalog: no MPPT is guessed
    b = docs[f"inverters/{SN_B}"]
    assert b["strings"] == [{"string_no": 2, "modules": 20, "module_wp": None}]
    assert "inputs" not in b and "removed_strings" not in b

    # an inverter without a layout is unchanged
    assert docs["inverters/INVC"] == before["inverters/INVC"]
