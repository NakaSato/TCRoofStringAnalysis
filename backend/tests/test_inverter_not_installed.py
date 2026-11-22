"""Inverters listed in Growatt but not installed on site: an admin marks them, and they leave
every job, live call, count and analysis; their stored rows stay."""

from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient

from app.db.models import GrowattInverter, GrowattIssue
from app.db.session import get_db
from app.services.growatt_sync import _inverters_query
from tests.test_growatt_routes import PLANT, SN_A, client  # noqa: F401  (fixture)

GHOST = "INVC"  # seeded with no readings at all


def _db(client):  # noqa: F811
    return next(client.app_ref.dependency_overrides[get_db]())


def _mark(client, installed: bool, note=None):  # noqa: F811
    return client.put(f"/api/growatt/plants/{PLANT}/inverters/{GHOST}/installed", json={"installed": installed, "note": note})


def test_mark_hides_the_inverter_everywhere_and_clearing_brings_it_back(client):  # noqa: F811
    before = client.get(f"/api/growatt/plants/{PLANT}/overview").json()
    assert GHOST in {i["device_sn"] for i in before["inverters"]}
    n = before["kpis"]["inverter_count"]

    r = _mark(client, False, "  not on the roof  ")
    assert r.status_code == 200, r.text
    inv = r.json()["inverter"]
    assert inv["not_installed"]["by"] == "admin" and inv["not_installed"]["note"] == "not on the roof"

    ov = client.get(f"/api/growatt/plants/{PLANT}/overview").json()
    assert GHOST not in {i["device_sn"] for i in ov["inverters"]}
    assert ov["kpis"]["inverter_count"] == n - 1
    assert [i["device_sn"] for i in ov["not_installed_inverters"]] == [GHOST]
    listed = client.get(f"/api/growatt/plants/{PLANT}/inverters").json()
    assert GHOST not in {i["device_sn"] for i in listed}
    every = client.get(f"/api/growatt/plants/{PLANT}/inverters?include_not_installed=true").json()
    assert GHOST in {i["device_sn"] for i in every}
    plant = next(p for p in client.get("/api/growatt/plants").json() if p["plant_id"] == PLANT)
    assert plant["inverter_count"] == n - 1

    db = _db(client)
    # no job reads it (no Growatt calls), and the registry row stays
    assert GHOST not in {i.device_sn for i in db.scalars(_inverters_query(None, False))}
    assert db.get(GrowattInverter, GHOST) is not None

    assert _mark(client, True).status_code == 200
    db.expire_all()
    assert db.get(GrowattInverter, GHOST).not_installed_at is None  # type: ignore[union-attr]
    ov = client.get(f"/api/growatt/plants/{PLANT}/overview").json()
    assert GHOST in {i["device_sn"] for i in ov["inverters"]} and ov["not_installed_inverters"] == []


def test_mark_dismisses_the_inverters_active_issues(client):  # noqa: F811
    db = _db(client)
    d = date(2026, 11, 20)
    db.add_all(
        [
            GrowattIssue(plant_id=PLANT, device_sn=GHOST, rule="R8", tier="P1", opened_day=d, last_seen_day=d),
            GrowattIssue(plant_id=PLANT, device_sn=GHOST, string_no=1, rule="R2", tier="P2", opened_day=d, last_seen_day=d),
            GrowattIssue(plant_id=PLANT, device_sn=SN_A, rule="R8", tier="P1", opened_day=d, last_seen_day=d),
        ]
    )
    db.commit()
    r = _mark(client, False)
    assert r.json()["issues_closed"] == 2
    db.expire_all()
    by = {(i.device_sn, i.string_no): i for i in db.query(GrowattIssue)}
    assert by[(GHOST, None)].status == "dismissed" and by[(GHOST, None)].close_reason == "not_installed"
    assert by[(GHOST, 1)].status == "dismissed"
    assert by[(SN_A, None)].status == "open"


def test_only_admins_mark_and_unknown_inverters_are_404(client):  # noqa: F811
    assert client.put(f"/api/growatt/plants/{PLANT}/inverters/NOPE/installed", json={"installed": False}).status_code == 404
    eng = TestClient(client.app_ref)
    tok = eng.post("/api/auth/login", json={"username": "engineer@tcroofsolar.com", "password": "engineer123"}).json()["access_token"]
    r = eng.put(
        f"/api/growatt/plants/{PLANT}/inverters/{GHOST}/installed",
        json={"installed": False},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403
