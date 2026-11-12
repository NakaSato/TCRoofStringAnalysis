"""Unequal module counts per string: registry endpoints and per-module peer comparison."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from sqlalchemy import select

from app.db.models import GrowattInverter, GrowattInverterReading, GrowattPlant, GrowattStringReading, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app

PLANT, OTHER = 222, 333
SN = "INVX"
DAY = datetime(2026, 11, 11)
# string_no -> modules; string 3 is short (16) but healthy: V and P scale with the count
MODULES = {1: 18, 2: 18, 3: 16}
V_PER_MODULE, I_A = 33.0, 9.0


def _seed(session) -> None:
    session.add_all([GrowattPlant(plant_id=PLANT, name="Mixed", peak_power_kwp=30.0), GrowattPlant(plant_id=OTHER, name="Other")])
    session.flush()
    session.add_all([GrowattInverter(device_sn=SN, plant_id=PLANT), GrowattInverter(device_sn="INVY", plant_id=OTHER)])
    session.flush()
    for m in range(0, 120, 5):
        ts = DAY + timedelta(hours=10, minutes=m)
        session.add(GrowattInverterReading(device_sn=SN, timestamp=ts, pac_w=15000, ppv_w=15500, eac_today_kwh=m / 10))
        for no, mods in MODULES.items():
            v = V_PER_MODULE * mods
            session.add(GrowattStringReading(device_sn=SN, timestamp=ts, string_no=no, mppt_no=no, voltage_v=v, current_a=I_A, power_w=v * I_A))
    # the demo engineer is assigned PLANT only (OTHER stays admin-only for them)
    eng = session.scalar(select(User).where(User.username == "engineer"))
    session.add(UserPlantAssignment(user_id=eng.id, plant_id=PLANT, assigned_by="admin"))
    session.commit()


@pytest.fixture()
def export_dir(tmp_path, monkeypatch):
    """Publishing after a save goes to a JSON sink in tmp_path, never the repo's data/ dir."""
    from app.services import daily_summary as ds

    out = tmp_path / "export"
    monkeypatch.setattr(ds, "make_sink", lambda kind, out_dir=None: ds.JsonFileSink(out))
    return out


@pytest.fixture()
def client(tmp_path, export_dir):
    engine = build_engine(f"sqlite:///{tmp_path / 'layout.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed(s)
    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    return TestClient(app)


def _login(c: TestClient, user: str) -> dict:
    tok = c.post("/api/auth/login", json={"username": user, "password": f"{user}123"}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def _strings(c: TestClient, h: dict) -> tuple[dict, dict]:
    ov = c.get(f"/api/growatt/plants/{PLANT}/overview", headers=h).json()
    return {s["string_no"]: s for s in ov["strings"]}, ov["kpis"]


def test_short_string_is_flagged_without_layout_and_healthy_with_it(client):
    eng = _login(client, "engineer")

    s, kpis = _strings(client, eng)
    assert s[3]["peer_basis"] == "raw" and s[3]["modules"] is None
    assert s[3]["status"] != "Healthy"  # 16 vs 18 modules looks like an 11 % voltage drop
    assert kpis["strings_with_module_count"] == 0

    layout = client.get(f"/api/growatt/plants/{PLANT}/string-layout", headers=eng).json()
    inputs = layout["inverters"][0]["strings"]
    assert [x["string_no"] for x in inputs] == [1, 2, 3]
    assert all(x["modules"] is None and x["active"] for x in inputs)

    body = [{"device_sn": SN, "string_no": no, "modules": m, "module_wp": 550} for no, m in MODULES.items()]
    saved = client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=body, headers=eng)
    assert saved.status_code == 200
    assert [x["modules"] for x in saved.json()["inverters"][0]["strings"]] == [18, 18, 16]

    s, kpis = _strings(client, eng)
    assert all(x["status"] == "Healthy" for x in s.values())
    assert s[3]["peer_basis"] == "per_kwp" and s[3]["modules"] == 16
    assert s[3]["voltage_mismatch_pct"] == pytest.approx(0.0, abs=0.1)
    assert s[3]["underperf_pct"] == pytest.approx(0.0, abs=0.1)
    assert s[3]["capacity_kwp"] == pytest.approx(8.8)  # 16 x 550 Wp
    assert s[3]["expected_energy_kwh"] == pytest.approx(s[3]["actual_energy_kwh"], rel=0.01)
    assert kpis["strings_normalized"] == 3

    d = client.get(f"/api/growatt/plants/{PLANT}/strings/{SN}/3", headers=eng).json()
    assert d["peer_basis"] == "per_kwp" and d["modules"] == 16
    pt = d["timeseries"][0]
    assert pt["peer_voltage_v"] == pytest.approx(pt["voltage_v"])  # peers scaled 18 -> 16 modules
    assert pt["peer_current_a"] == pytest.approx(I_A)  # current is never scaled
    assert d["summary"]["peer_energy_kwh"] == pytest.approx(d["summary"]["energy_kwh"], rel=0.05)


def test_partial_layout_falls_back_to_raw_and_split_capacity(client):
    eng = _login(client, "engineer")
    body = [{"device_sn": SN, "string_no": 3, "modules": 16}]
    assert client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=body, headers=eng).status_code == 200
    s, _ = _strings(client, eng)
    assert all(x["peer_basis"] == "raw" for x in s.values())  # strings 1-2 have no count yet
    # no rating of its own: the fleet module (global setting, 570 Wp by default) applies
    assert s[3]["modules"] == 16 and s[3]["module_wp"] == 570
    assert s[3]["capacity_kwp"] == pytest.approx(9.12)
    raw = client.get(f"/api/growatt/plants/{PLANT}/string-layout", headers=eng).json()
    assert raw["fleet_module_wp"] == 570
    assert [x["module_wp"] for x in raw["inverters"][0]["strings"] if x["string_no"] == 3] == [None]

    # every count known, ratings from the fleet module: per kWp
    body = [{"device_sn": SN, "string_no": no, "modules": m} for no, m in MODULES.items()]
    client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=body, headers=eng)
    s, _ = _strings(client, eng)
    assert s[3]["peer_basis"] == "per_kwp" and s[3]["status"] == "Healthy"

    # an empty PUT clears the registry
    client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=[], headers=eng)
    s, _ = _strings(client, eng)
    assert all(x["modules"] is None for x in s.values())


def test_layout_put_validation_and_access(client):
    admin, eng = _login(client, "admin"), _login(client, "engineer")
    ok = [{"device_sn": SN, "string_no": 1, "modules": 18}]
    # a plant not assigned to the engineer looks like it does not exist
    other = [{"device_sn": "INVY", "string_no": 1, "modules": 18}]
    assert client.put(f"/api/growatt/plants/{OTHER}/string-layout", json=other, headers=eng).status_code == 404
    assert client.get(f"/api/growatt/plants/{OTHER}/string-layout", headers=eng).status_code == 404
    assert client.put(f"/api/growatt/plants/{OTHER}/string-layout", json=other, headers=admin).status_code == 200
    foreign = [{"device_sn": "INVY", "string_no": 1, "modules": 18}]
    assert client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=foreign, headers=eng).status_code == 422
    dup = ok + ok
    assert client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=dup, headers=eng).status_code == 422
    bad = [{"device_sn": SN, "string_no": 1, "modules": 0}]
    assert client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=bad, headers=eng).status_code == 422
    assert client.get("/api/growatt/plants/999/string-layout", headers=eng).status_code == 404


def test_plant_default_update_keeps_strings_set_individually(client):
    """Quick Plant Parameters (PUT /plants/{id}) must not flatten per-string module counts."""
    eng = _login(client, "admin")  # legacy plant config is admin only
    plant = client.get("/api/plants", headers=eng).json()[0]
    specs = client.get(f"/api/plants/{plant['id']}/strings", headers=eng).json()
    if len(specs) < 2:
        pytest.skip("seeded plant has fewer than two strings")
    default = plant["modules_per_string"]
    specs[0]["modules_per_string"] = default - 2
    assert client.put(f"/api/plants/{plant['id']}/strings", json=specs, headers=eng).status_code == 200

    payload = {k: v for k, v in plant.items() if k not in ("id", "string_specs")}
    payload["modules_per_string"] = default + 2
    assert client.put(f"/api/plants/{plant['id']}", json=payload, headers=eng).status_code == 200

    after = {s["string_id"]: s["modules_per_string"] for s in client.get(f"/api/plants/{plant['id']}/strings", headers=eng).json()}
    assert after[specs[0]["string_id"]] == default - 2  # set individually: kept
    assert all(after[s["string_id"]] == default + 2 for s in specs[1:])  # on the default: follows it


def test_fleet_module_default_save_and_publish(client, export_dir):
    import json

    from app.services import daily_summary as ds

    out = export_dir
    eng, admin = _login(client, "engineer"), _login(client, "admin")

    m = client.get("/api/growatt/fleet-module", headers=eng).json()  # engineers read it
    assert m["source"] == "default" and m["wp"] == 570 and m["vmp_stc"] == pytest.approx(42.4)

    body = {k: v for k, v in m.items() if k not in ("source", "updated_by", "updated_at")}
    assert client.put("/api/growatt/fleet-module", json=body, headers=eng).status_code == 403  # fleet-wide: admin only
    assert client.put("/api/growatt/fleet-module", json={**body, "wp": 0}, headers=admin).status_code == 422

    saved = client.put("/api/growatt/fleet-module", json={**body, "wp": 575, "vmp_stc": 42.6}, headers=admin).json()
    assert saved["source"] == "saved" and saved["wp"] == 575 and saved["updated_by"] == "admin"
    assert saved["published"] == {"sink": "json", "written": 1, "deferred": False}
    doc = json.loads((out / "config" / "fleet_module.json").read_text())
    assert doc["wp"] == 575 and doc["schema"] == ds.SCHEMA_VERSION and "updated_at" not in doc

    # unchanged content is not written again; the registry carries the same doc
    again = client.put("/api/growatt/fleet-module", json={**body, "wp": 575, "vmp_stc": 42.6}, headers=admin).json()
    assert again["published"]["written"] == 0
    assert client.get("/api/growatt/fleet-module", headers=eng).json()["wp"] == 575


def test_layout_save_publishes_plant_inverter_docs(client, export_dir):
    import json

    from app.services import daily_summary as ds

    eng = _login(client, "engineer")
    body = [{"device_sn": SN, "string_no": 1, "modules": 18, "module_wp": 575}, {"device_sn": SN, "string_no": 3, "modules": 16}]
    r = client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=body, headers=eng).json()
    assert r["published"] == {"sink": "json", "written": 1, "deferred": False}  # this plant's one inverter
    doc = json.loads((export_dir / "inverters" / f"{SN}.json").read_text())
    assert doc["strings"] == [
        {"string_no": 1, "modules": 18, "module_wp": 575},
        {"string_no": 3, "modules": 16, "module_wp": None},  # null = fleet module (config/fleet_module)
    ]
    assert not (export_dir / "inverters" / "INVY.json").exists()  # other plants untouched

    # saving the same layout again writes nothing; inverters without a layout have no `strings` key
    again = client.put(f"/api/growatt/plants/{PLANT}/string-layout", json=body, headers=eng).json()
    assert again["published"]["written"] == 0
    sessions = client.app.dependency_overrides  # registry built by the publish job matches
    db = next(iter(sessions.values()))()
    registry = dict(ds.build_registry_docs(next(db)))
    assert "strings" not in registry["inverters/INVY"] and len(registry[f"inverters/{SN}"]["strings"]) == 2
