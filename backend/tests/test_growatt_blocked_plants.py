"""Blocked plants (`GROWATT_BLOCKED_PLANT_IDS`): never listed, and removed from the registry."""

from datetime import datetime, timezone

from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.db.models import GrowattInverter, GrowattInverterReading, GrowattIssue, GrowattPlant
from app.db.session import Base, build_engine
from app.services import growatt_sync
from solar_core.growatt import GrowattClient


def test_setting_parses_ids():
    assert Settings(growatt_blocked_plant_ids=" 10838528, 7 ,x,").blocked_plant_ids() == {10838528, 7}
    assert Settings(growatt_blocked_plant_ids="").blocked_plant_ids() == frozenset()


def test_client_leaves_blocked_plants_out_of_the_list(monkeypatch):
    client = GrowattClient(token="t", blocked_plant_ids=[2])
    answer = {"count": 3, "plants": [{"plant_id": 1}, {"plant_id": "2"}, {"plant_id": 3}]}
    monkeypatch.setattr(client, "_request", lambda method, path, params: answer)
    assert [p["plant_id"] for p in client.list_plants(refresh=True)] == [1, 3]


def test_remove_blocked_plants_drops_the_plant_and_what_hangs_on_it(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'b.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    ts = datetime(2026, 11, 17, 5, 0, tzinfo=timezone.utc)
    with Session() as db:
        db.add_all([GrowattPlant(plant_id=1, name="keep"), GrowattPlant(plant_id=2, name="blocked")])
        db.add_all([GrowattInverter(device_sn="A", plant_id=1), GrowattInverter(device_sn="B", plant_id=2)])
        db.flush()
        db.add_all([GrowattInverterReading(device_sn=sn, timestamp=ts) for sn in ("A", "B")])
        db.add_all([GrowattIssue(plant_id=pid, rule="R1", tier="P2", opened_day=ts.date(), last_seen_day=ts.date()) for pid in (1, 2)])
        db.commit()

        assert growatt_sync.remove_blocked_plants(db, {2, 99}) == [2]
        assert [p.plant_id for p in db.query(GrowattPlant)] == [1]
        assert [i.device_sn for i in db.query(GrowattInverter)] == ["A"]
        assert [r.device_sn for r in db.query(GrowattInverterReading)] == ["A"]
        assert [i.plant_id for i in db.query(GrowattIssue)] == [1]
        assert growatt_sync.remove_blocked_plants(db, {2}) == []
