"""Spares register, phase 1 (docs/plans/spares-failed-units.md): catalogue, locations, units,
the movement ledger, permissions (admin / store keeper / engineer) and plant scoping."""

from __future__ import annotations

from collections import defaultdict

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, SpareUnit, StockMovement, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app

P1, P2 = 9501, 9502


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'stock.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    c = TestClient(app)

    def login(u, p):
        return {"Authorization": "Bearer " + c.post("/auth/login", json={"username": u, "password": p}).json()["access_token"]}

    adm = login("admin", "admin123")
    # a store keeper is still scoped to the plants assigned (P1 here)
    r = c.post("/users", json={"username": "keeper", "full_name": "Store Keeper", "password": "keeper12345", "role": "engineer", "store_keeper": True, "plant_ids": [P1]}, headers=adm)
    assert r.status_code == 201, r.text
    return c, adm, login("engineer", "engineer123"), login("keeper", "keeper12345"), f


def _setup(c, keeper):
    store = c.post("/stock/locations", json={"code": "store", "name": "Main store", "kind": "store"}, headers=keeper).json()
    bin_ = c.post("/stock/locations", json={"code": "STORE-A-01", "name": "Shelf A1", "kind": "bin", "parent_id": store["id"]}, headers=keeper).json()
    van = c.post("/stock/locations", json={"code": "VAN-CREW1", "name": "Crew 1 van", "kind": "van"}, headers=keeper).json()
    part = c.post("/stock/parts", json={"code": "p-router-rut241", "name": "Teltonika RUT241", "category": "router", "min_qty": 3}, headers=keeper).json()
    return store, bin_, van, part


def _batch(c, h, rows, status=201):
    r = c.post("/stock/movements/batch", json={"rows": rows}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


def test_store_keeper_flag_and_permissions(api):
    c, adm, eng, keeper, _ = api
    me = c.get("/auth/me", headers=keeper).json()
    assert me["store_keeper"] is True and me["role"] == "engineer"
    assert c.get("/auth/me", headers=eng).json()["store_keeper"] is False
    # engineers read but cannot change the catalogue or locations
    assert c.post("/stock/parts", json={"code": "X1", "name": "x", "category": "other"}, headers=eng).status_code == 403
    assert c.post("/stock/locations", json={"code": "S", "name": "s", "kind": "store"}, headers=eng).status_code == 403
    assert c.get("/stock/parts", headers=eng).status_code == 200
    # an admin can grant and take the flag
    uid = me["id"]
    assert c.patch(f"/users/{uid}", json={"store_keeper": False}, headers=adm).json()["store_keeper"] is False
    assert c.post("/stock/parts", json={"code": "X1", "name": "x", "category": "other"}, headers=keeper).status_code == 403


def test_catalogue_and_location_rules(api):
    c, adm, eng, keeper, _ = api
    store, bin_, van, part = _setup(c, keeper)
    assert part["code"] == "P-ROUTER-RUT241" and part["serialised"] is True and part["on_hand"] == 0 and part["below_min"] is True
    assert store["code"] == "STORE" and bin_["parent_id"] == store["id"]
    bad = [
        ({"code": "P-ROUTER-RUT241", "name": "dup", "category": "router"}, 409),
        ({"code": "C1", "name": "fuse", "category": "other", "serialised": False}, 422),
        ({"code": "C2", "name": "x", "category": "toaster"}, 422),
        ({"code": "bad code!", "name": "x", "category": "other"}, 422),
    ]
    for body, code in bad:
        assert c.post("/stock/parts", json=body, headers=keeper).status_code == code, body
    assert c.post("/stock/locations", json={"code": "B2", "name": "x", "kind": "bin"}, headers=keeper).status_code == 422  # no store
    assert c.post("/stock/locations", json={"code": "B3", "name": "x", "kind": "bin", "parent_id": van["id"]}, headers=keeper).status_code == 422
    eng_id = c.get("/auth/me", headers=eng).json()["id"]
    assert c.post("/stock/locations", json={"code": "S2", "name": "x", "kind": "store", "holder_user_id": eng_id}, headers=keeper).status_code == 422
    r = c.patch(f"/stock/locations/{van['id']}", json={"holder_user_id": eng_id}, headers=keeper).json()
    assert r["holder_name"] and r["holder_user_id"] == eng_id
    assert any(p["id"] == eng_id for p in c.get("/stock/people", headers=eng).json())


def test_receive_moves_and_on_hand(api):
    c, adm, eng, keeper, _ = api
    store, bin_, van, part = _setup(c, keeper)
    rows = [{"kind": "receive", "part_id": part["id"], "serial": s, "to_location_id": bin_["id"], "input_method": "hid", "raw_scan": s} for s in ("1100000001", "1100000002", "1100000003")]
    _batch(c, eng, rows[:1], 403)  # receiving needs a store keeper
    out = _batch(c, keeper, rows)
    assert len(out["movements"]) == 3 and len({m["batch_id"] for m in out["movements"]}) == 1
    assert out["movements"][0]["to_location_code"] == "STORE-A-01" and out["movements"][0]["input_method"] == "hid"
    p = next(x for x in c.get("/stock/parts", headers=eng).json() if x["id"] == part["id"])
    assert p["on_hand"] == 3 and p["below_min"] is False and p["on_hand_by_location"] == [{"location_id": bin_["id"], "qty": 3}]
    # the same serial again (any case / spaces), or twice in one batch: refused, nothing written
    r = _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": " 1100000001 ", "to_location_id": store["id"]}], 409)
    assert "already in the register" in r["detail"]["errors"][0]["error"]
    r = _batch(c, keeper, [dict(rows[0], serial="1100000009"), dict(rows[0], serial="1100000009")], 409)
    assert r["detail"]["errors"][0]["row"] == 1
    # field moves by an engineer: store → van → installed at P1 → back to the store
    _batch(c, eng, [{"kind": "transfer", "part_id": part["id"], "serial": "1100000001", "to_location_id": van["id"]}])
    _batch(c, eng, [{"kind": "issue", "part_id": part["id"], "serial": "1100000001", "plant_id": P1}])
    units = {u["serial"]: u for u in c.get("/stock/units", headers=eng).json()}
    assert units["1100000001"]["state"] == "installed" and units["1100000001"]["plant_name"] == f"Plant {P1}"
    # a plant the engineer may not see; a unit not in stock; all-or-nothing
    r = _batch(c, eng, [
        {"kind": "transfer", "part_id": part["id"], "serial": "1100000002", "to_location_id": van["id"]},
        {"kind": "issue", "part_id": part["id"], "serial": "1100000003", "plant_id": P2},
        {"kind": "issue", "part_id": part["id"], "serial": "1100000001", "plant_id": P1},
    ], 409)
    assert [e["row"] for e in r["detail"]["errors"]] == [1, 2]
    assert units["1100000002"]["location_code"] == "STORE-A-01"  # row 0 was not applied
    assert next(u for u in c.get("/stock/units", headers=eng).json() if u["serial"] == "1100000002")["location_code"] == "STORE-A-01"
    _batch(c, eng, [{"kind": "return", "part_id": part["id"], "serial": "1100000001", "to_location_id": store["id"]}])
    assert next(x for x in c.get("/stock/parts", headers=eng).json() if x["id"] == part["id"])["on_hand"] == 3
    # a location with units cannot be switched off
    assert c.patch(f"/stock/locations/{bin_['id']}", json={"active": False}, headers=keeper).status_code == 409


def test_corrections_and_ledger_replay(api):
    c, adm, eng, keeper, f = api
    store, bin_, van, part = _setup(c, keeper)
    _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": s, "to_location_id": bin_["id"]} for s in ("A1", "A2")])
    issue = _batch(c, eng, [{"kind": "issue", "part_id": part["id"], "serial": "A1", "plant_id": P1}])["movements"][0]
    recv_a2 = c.get("/stock/movements", params={"serial": "A2"}, headers=eng).json()["movements"][0]
    assert c.post(f"/stock/movements/{issue['id']}/correct", json={"note": "wrong unit"}, headers=eng).status_code == 403
    corr = c.post(f"/stock/movements/{issue['id']}/correct", json={"note": "wrong unit"}, headers=keeper)
    assert corr.status_code == 201, corr.text
    assert corr.json()["corrects_id"] == issue["id"] and corr.json()["to_state"] == "in_stock" and corr.json()["to_location_code"] == "STORE-A-01"
    assert c.post(f"/stock/movements/{issue['id']}/correct", json={"note": "again"}, headers=keeper).status_code == 409
    assert c.post(f"/stock/movements/{corr.json()['id']}/correct", json={"note": "undo"}, headers=keeper).status_code == 409
    # correcting a receive voids the unit; its serial can be received again
    assert c.post(f"/stock/movements/{recv_a2['id']}/correct", json={"note": "typo"}, headers=keeper).status_code == 201
    assert [u["serial"] for u in c.get("/stock/units", headers=eng).json()] == ["A1"]
    _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": "A2", "to_location_id": van["id"]}])
    # only a unit's latest movement can be corrected
    _batch(c, eng, [{"kind": "transfer", "part_id": part["id"], "serial": "A1", "to_location_id": van["id"]}])
    first_a1 = c.get("/stock/movements", params={"serial": "A1", "kind": "receive"}, headers=eng).json()["movements"][0]
    assert c.post(f"/stock/movements/{first_a1['id']}/correct", json={"note": "x"}, headers=keeper).status_code == 409
    # replaying the ledger gives every unit's current state and place
    with f() as db:
        state = defaultdict(lambda: ("void", None, None))
        for m in db.scalars(select(StockMovement).order_by(StockMovement.id)):
            assert m.from_state == state[m.unit_id][0] or (m.from_state is None and state[m.unit_id][0] == "void")
            state[m.unit_id] = (m.to_state, m.to_location_id if m.to_state == "in_stock" else None, m.plant_id if m.to_state == "installed" else None)
        for u in db.scalars(select(SpareUnit)):
            assert state[u.id] == (u.state, u.location_id, u.plant_id), u.serial


def test_plant_scoping(api):
    c, adm, eng, keeper, _ = api
    store, bin_, van, part = _setup(c, keeper)
    _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": s, "to_location_id": bin_["id"]} for s in ("Z1", "Z2")])
    _batch(c, adm, [{"kind": "issue", "part_id": part["id"], "serial": "Z1", "plant_id": P2}])
    assert [u["serial"] for u in c.get("/stock/units", headers=eng).json()] == ["Z2"]
    assert len(c.get("/stock/units", headers=adm).json()) == 2
    mv = c.get("/stock/movements", headers=eng).json()
    assert mv["total"] == 2 and all(m["plant_id"] is None for m in mv["movements"])
    assert c.get("/stock/movements", headers=adm).json()["total"] == 3
    # the engineer cannot move a unit installed on a hidden plant
    r = _batch(c, eng, [{"kind": "return", "part_id": part["id"], "serial": "Z1", "to_location_id": van["id"]}], 409)
    assert "not in the register" in r["detail"]["errors"][0]["error"]
    hidden = c.get("/stock/movements", params={"plant_id": P2}, headers=adm).json()["movements"][0]
    assert c.post(f"/stock/movements/{hidden['id']}/correct", json={"note": "x"}, headers=keeper).status_code == 404
    # the summary counts installed units only on the user's plants (#136)
    assert c.get("/stock/summary", headers=adm).json()["installed"] == 1
    assert c.get("/stock/summary", headers=eng).json()["installed"] == 0
    # a hidden unit by id is "not found", with no part code or serial (#136)
    z1 = next(u for u in c.get("/stock/units", headers=adm).json() if u["serial"] == "Z1")
    r = _batch(c, eng, [{"kind": "return", "unit_id": z1["id"], "to_location_id": van["id"]}], 409)
    assert r["detail"]["errors"][0]["error"] == f"Unit {z1['id']} not found"
    # receiving a serial installed on a hidden plant does not name the plant (#136)
    r = _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": "Z1", "to_location_id": bin_["id"]}], 409)
    err = r["detail"]["errors"][0]["error"]
    assert "another plant" in err and str(P2) not in err


def test_units_list_is_scoped_before_the_limit(api, monkeypatch):
    """An engineer's units are not cut off by other plants' units filling the list limit (#136)."""
    from app.services import stock as svc

    c, adm, eng, keeper, _ = api
    store, bin_, van, part = _setup(c, keeper)
    _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": s, "to_location_id": bin_["id"]} for s in ("A1", "A2", "Z9")])
    _batch(c, adm, [{"kind": "issue", "part_id": part["id"], "serial": s, "plant_id": P2} for s in ("A1", "A2")])
    monkeypatch.setattr(svc, "MAX_LIST", 2)
    assert [u["serial"] for u in c.get("/stock/units", headers=eng).json()] == ["Z9"]


def test_batch_day_is_the_bangkok_day(api, monkeypatch):
    """At 06:30 Bangkok (23:30 UTC the day before) a move is stamped with the Bangkok day (#136)."""
    from datetime import datetime as real_dt
    from app.services import stock as svc

    class FakeDT(real_dt):
        @classmethod
        def now(cls, tz=None):
            return real_dt(2026, 11, 25, 23, 30, tzinfo=svc.timezone.utc).astimezone(tz) if tz else real_dt(2026, 11, 26, 6, 30)

    c, adm, eng, keeper, _ = api
    store, bin_, van, part = _setup(c, keeper)
    monkeypatch.setattr(svc, "datetime", FakeDT)
    out = _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": "D1", "to_location_id": bin_["id"]}])
    assert out["movements"][0]["day"] == "2026-11-26"
    fixed = c.post(f"/stock/movements/{out['movements'][0]['id']}/correct", json={"note": "typo"}, headers=keeper)
    assert fixed.status_code == 201 and fixed.json()["day"] == "2026-11-26"


def test_same_unit_twice_in_one_batch_is_refused(api):
    """Two labels of one unit (`unit_id`) in a batch: refused as a whole, nothing moves."""
    c, adm, eng, keeper, _ = api
    store, bin_, van, part = _setup(c, keeper)
    out = _batch(c, keeper, [{"kind": "receive", "part_id": part["id"], "serial": "1200000001", "to_location_id": bin_["id"]}])
    uid = out["movements"][0]["unit_id"]
    row = {"kind": "transfer", "unit_id": uid, "to_location_id": van["id"]}
    r = _batch(c, eng, [row, dict(row)], 409)
    assert "twice in this batch" in str(r)
    units = c.get("/stock/units", params={"part_id": part["id"]}, headers=eng).json()
    assert [u["location_id"] for u in units] == [bin_["id"]]
