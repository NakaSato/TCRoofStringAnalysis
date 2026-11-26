"""Spares phase 5 (docs/plans/spares-failed-units.md §5.7, §8 step 5): stock counts. Preview
(anyone), confirm (admin / store keeper) writing one batch of `count_adjust` movements and a
`stock_counts` row; the `missing` state; corrections of count rows; the ledger still replays."""

from __future__ import annotations

from collections import defaultdict

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, SpareUnit, StockCount, StockMovement, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app

P1, P2 = 9801, 9802


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'count.db'}")
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
    r = c.post("/users", json={"username": "keeper", "full_name": "Store Keeper", "password": "keeper12345", "role": "engineer", "store_keeper": True, "plant_ids": [P1]}, headers=adm)
    assert r.status_code == 201, r.text
    keeper = login("keeper", "keeper12345")
    store = c.post("/stock/locations", json={"code": "STORE", "name": "Main store", "kind": "store"}, headers=keeper).json()
    bin_ = c.post("/stock/locations", json={"code": "STORE-A-01", "name": "Shelf A1", "kind": "bin", "parent_id": store["id"]}, headers=keeper).json()
    van = c.post("/stock/locations", json={"code": "VAN-CREW1", "name": "Crew 1 van", "kind": "van"}, headers=keeper).json()
    sup = c.post("/stock/locations", json={"code": "SUP-X", "name": "Supplier", "kind": "supplier"}, headers=keeper).json()
    router = c.post("/stock/parts", json={"code": "P-ROUTER", "name": "Router", "category": "router"}, headers=keeper).json()
    logger = c.post("/stock/parts", json={"code": "P-LOGGER", "name": "Logger", "category": "datalogger"}, headers=keeper).json()
    return {"c": c, "adm": adm, "eng": login("engineer", "engineer123"), "keeper": keeper, "f": f,
            "store": store, "bin": bin_, "van": van, "sup": sup, "router": router, "logger": logger}


def _batch(t, h, rows, status=201):
    r = t["c"].post("/stock/movements/batch", json={"rows": rows}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


def _receive(t, serials, loc, part="router"):
    return _batch(t, t["keeper"], [{"kind": "receive", "part_id": t[part]["id"], "serial": s, "to_location_id": t[loc]["id"]} for s in serials])


def _preview(t, loc, scans, h=None, status=200):
    r = t["c"].post("/stock/counts/preview", json={"location_id": t[loc]["id"], "scans": scans}, headers=h or t["eng"])
    assert r.status_code == status, r.text
    return r.json()


def _confirm(t, loc, scans, expected_ids, h=None, status=201, note=None):
    r = t["c"].post("/stock/counts", json={"location_id": t[loc]["id"], "scans": scans, "expected_ids": expected_ids, "note": note}, headers=h or t["keeper"])
    assert r.status_code == status, r.text
    return r.json()


def _units(t):
    return {u["serial"]: u for u in t["c"].get("/stock/units", headers=t["adm"]).json()}


def _replay(t):
    """Replaying the ledger gives every unit's current state and place (as test_stock.py)."""
    with t["f"]() as db:
        state = defaultdict(lambda: ("void", None, None))
        for m in db.scalars(select(StockMovement).order_by(StockMovement.id)):
            assert m.from_state == state[m.unit_id][0] or (m.from_state is None and state[m.unit_id][0] == "void"), (m.id, m.kind)
            state[m.unit_id] = (m.to_state, m.to_location_id if m.to_state == "in_stock" else None, m.plant_id if m.to_state == "installed" else None)
        for u in db.scalars(select(SpareUnit)):
            assert state[u.id] == (u.state, u.location_id, u.plant_id), u.serial


def test_first_count_of_an_empty_location(api):
    t = api
    rid = t["router"]["id"]
    scans = [{"raw": "R-001", "part_id": rid, "input_method": "hid"}, {"raw": "S/N: r-002", "part_id": rid, "input_method": "camera"}, {"raw": "R-003"}]
    p = _preview(t, "bin", scans)
    assert p["location"]["code"] == "STORE-A-01" and p["location"]["last_count_at"] is None and p["location"]["last_count_by"] is None
    assert p["expected"] == [] and p["expected_ids"] == [] and p["missing"] == []
    assert [r["result"] for r in p["rows"]] == ["new", "new", "needs_part"]
    assert p["rows"][1]["serial"] == "R-002" and p["rows"][1]["part_id"] == rid and p["rows"][1]["unit"] is None
    assert p["rows"][2]["part_id"] is None and p["rows"][2]["message"]
    assert p["counts"] == {"scanned": 3, "matched": 0, "moved_here": 0, "found_again": 0, "new": 2, "missing": 0, "needs_part": 1, "ambiguous": 0, "blocked": 0, "duplicate": 0, "not_a_unit": 0}
    # needs_part blocks the confirm: 409 with the row, nothing written
    r = _confirm(t, "bin", scans, [], status=409)
    assert [e["row"] for e in r["detail"]["errors"]] == [2]
    assert _units(t) == {}
    scans[2]["part_id"] = rid
    out = _confirm(t, "bin", scans, [], note="Opening count")
    cnt = out["count"]
    assert cnt["location_code"] == "STORE-A-01" and cnt["by"] == "keeper" and cnt["note"] == "Opening count" and cnt["batch_id"]
    assert (cnt["scanned"], cnt["matched"], cnt["new_units"], cnt["missing"], cnt["moved_here"], cnt["found_again"]) == (3, 0, 3, 0, 0, 0)
    mv = out["movements"]
    assert len(mv) == 3 and {m["kind"] for m in mv} == {"count_adjust"} and {m["batch_id"] for m in mv} == {cnt["batch_id"]}
    assert mv[0]["from_state"] is None and mv[0]["to_state"] == "in_stock" and mv[0]["to_location_code"] == "STORE-A-01"
    assert mv[0]["input_method"] == "hid" and mv[0]["raw_scan"] == "R-001" and mv[0]["note"] == "Count at STORE-A-01: Opening count"
    u = _units(t)
    assert set(u) == {"R-001", "R-002", "R-003"} and all(x["state"] == "in_stock" and x["location_code"] == "STORE-A-01" and x["received_day"] for x in u.values())
    loc = next(x for x in t["c"].get("/stock/locations", headers=t["eng"]).json() if x["id"] == t["bin"]["id"])
    assert loc["last_count_at"] and loc["last_count_by"] == "keeper" and loc["units"] == 3
    lst = t["c"].get("/stock/counts", params={"location_id": t["bin"]["id"]}, headers=t["eng"]).json()
    assert [x["id"] for x in lst] == [cnt["id"]] and set(lst[0]) == set(cnt)
    _replay(t)


def test_later_count_matched_moved_missing_found_again(api):
    t = api
    _receive(t, ["A1", "A2", "A3"], "bin")
    _receive(t, ["V1"], "van")
    # A1, A2 scanned; V1 is in the van; A3 not scanned → missing
    scans = [{"raw": "A1"}, {"raw": "a2 "}, {"raw": "V1", "input_method": "manual"}, {"raw": "A1"}, {"raw": "loc:VAN-CREW1"}, {"raw": "sp:P-ROUTER"}]
    p = _preview(t, "bin", scans)
    assert [r["result"] for r in p["rows"]] == ["matched", "matched", "moved_here", "duplicate", "not_a_unit", "not_a_unit"]
    assert p["rows"][2]["unit"]["location_code"] == "VAN-CREW1" and "VAN-CREW1" in p["rows"][2]["message"]
    assert [u["serial"] for u in p["missing"]] == ["A3"] and len(p["expected"]) == 3
    assert p["counts"]["missing"] == 1 and p["counts"]["duplicate"] == 1 and p["counts"]["not_a_unit"] == 2
    # engineers preview but cannot confirm
    _confirm(t, "bin", scans, p["expected_ids"], h=t["eng"], status=403)
    out = _confirm(t, "bin", scans, p["expected_ids"])
    c = out["count"]
    assert (c["scanned"], c["matched"], c["moved_here"], c["missing"], c["new_units"], c["found_again"]) == (6, 2, 1, 1, 0, 0)
    by_serial = {m["serial"]: m for m in out["movements"]}
    assert set(by_serial) == {"V1", "A3"}
    assert by_serial["V1"]["from_location_code"] == "VAN-CREW1" and by_serial["V1"]["to_location_code"] == "STORE-A-01" and by_serial["V1"]["input_method"] == "manual"
    assert by_serial["A3"]["from_state"] == "in_stock" and by_serial["A3"]["to_state"] == "missing" and by_serial["A3"]["to_location_id"] is None and by_serial["A3"]["raw_scan"] is None
    u = _units(t)
    assert u["A3"]["state"] == "missing" and u["A3"]["location_id"] is None and u["V1"]["location_code"] == "STORE-A-01"
    assert t["c"].get("/stock/summary", headers=t["eng"]).json()["missing_units"] == 1
    # a missing unit is still found by lookup / the resolver
    lk = t["c"].get("/stock/lookup", params={"code": "A3"}, headers=t["eng"]).json()
    assert lk["kind"] == "serial" and lk["units"][0]["state"] == "missing"
    rs = t["c"].get("/scan/resolve", params={"code": "A3"}, headers=t["eng"]).json()
    assert any(m["kind"] == "spare_unit" for m in rs["matches"])
    # transfer / issue of a missing unit are refused; receive tells to count it in
    r = _batch(t, t["eng"], [{"kind": "transfer", "part_id": t["router"]["id"], "serial": "A3", "to_location_id": t["van"]["id"]}], 409)
    assert "missing" in r["detail"]["errors"][0]["error"]
    _batch(t, t["eng"], [{"kind": "issue", "part_id": t["router"]["id"], "serial": "A3", "plant_id": P1}], 409)
    r = _batch(t, t["keeper"], [{"kind": "receive", "part_id": t["router"]["id"], "serial": "A3", "to_location_id": t["bin"]["id"]}], 409)
    assert "missing since the count of" in r["detail"]["errors"][0]["error"] and "count it in" in r["detail"]["errors"][0]["error"]
    # found again in the van's count
    p = _preview(t, "van", [{"raw": "A3"}])
    assert p["rows"][0]["result"] == "found_again" and p["expected"] == []
    out = _confirm(t, "van", [{"raw": "A3"}], [])
    assert out["count"]["found_again"] == 1
    assert out["movements"][0]["from_state"] == "missing" and out["movements"][0]["from_location_id"] is None and out["movements"][0]["to_location_code"] == "VAN-CREW1"
    assert _units(t)["A3"]["state"] == "in_stock" and t["c"].get("/stock/summary", headers=t["eng"]).json()["missing_units"] == 0
    # a count that changes nothing: no batch
    p = _preview(t, "van", [{"raw": "A3"}])
    out = _confirm(t, "van", [{"raw": "A3"}], p["expected_ids"])
    assert out["movements"] == [] and out["count"]["batch_id"] is None and out["count"]["matched"] == 1
    counts = t["c"].get("/stock/counts", headers=t["eng"]).json()
    assert len(counts) == 3 and counts[0]["id"] > counts[1]["id"]
    _replay(t)


def test_ambiguous_and_blocked_rows_block_confirm(api):
    t = api
    _receive(t, ["DUP1"], "bin", "router")
    _receive(t, ["DUP1"], "van", "logger")
    _receive(t, ["INST1", "KEEP1"], "store")
    _batch(t, t["eng"], [{"kind": "issue", "part_id": t["router"]["id"], "serial": "INST1", "plant_id": P1}])
    scans = [{"raw": "DUP1"}, {"raw": "INST1"}, {"raw": "KEEP1"}]
    p = _preview(t, "store", scans)
    assert [r["result"] for r in p["rows"]] == ["ambiguous", "blocked", "matched"]
    assert "installed" in p["rows"][1]["message"] and "P-ROUTER" in p["rows"][0]["message"] and "P-LOGGER" in p["rows"][0]["message"]
    before = t["c"].get("/stock/movements", headers=t["adm"]).json()["total"]
    r = _confirm(t, "store", scans, p["expected_ids"], status=409)
    assert [e["row"] for e in r["detail"]["errors"]] == [0, 1]
    assert t["c"].get("/stock/movements", headers=t["adm"]).json()["total"] == before
    with t["f"]() as db:
        assert db.scalars(select(StockCount)).first() is None
    # part_id picks one of the units that share a serial
    scans[0]["part_id"] = t["logger"]["id"]
    p = _preview(t, "store", scans[:1] + scans[2:])
    assert p["rows"][0]["result"] == "moved_here" and p["rows"][0]["unit"]["part_code"] == "P-LOGGER"
    # an engineer's preview treats a unit on a hidden plant as not found
    _batch(t, t["adm"], [{"kind": "issue", "part_id": t["router"]["id"], "serial": "KEEP1", "plant_id": P2}])
    p = _preview(t, "store", [{"raw": "KEEP1"}, {"raw": "KEEP1", "part_id": t["router"]["id"]}], h=t["eng"])
    assert [r["result"] for r in p["rows"]] == ["needs_part", "blocked"] and p["rows"][1]["unit"] is None
    p = _preview(t, "store", [{"raw": "KEEP1"}], h=t["adm"])
    assert p["rows"][0]["result"] == "blocked" and "Plant 9802" in p["rows"][0]["message"]
    # only an active store / bin / van can be counted
    _preview(t, "sup", [], status=422)
    r = t["c"].post("/stock/counts/preview", json={"location_id": 99999, "scans": []}, headers=t["eng"])
    assert r.status_code == 404


def test_stock_changed_between_preview_and_confirm(api):
    t = api
    _receive(t, ["C1", "C2"], "bin")
    scans = [{"raw": "C1"}, {"raw": "C2"}]
    p = _preview(t, "bin", scans)
    assert p["expected_ids"] == sorted(u["id"] for u in p["expected"]) and len(p["expected_ids"]) == 2
    _batch(t, t["eng"], [{"kind": "transfer", "part_id": t["router"]["id"], "serial": "C2", "to_location_id": t["van"]["id"]}])
    r = _confirm(t, "bin", scans, p["expected_ids"], status=409)
    assert r["detail"]["code"] == "stock_changed" and r["detail"]["errors"][0]["row"] is None
    assert _units(t)["C2"]["location_code"] == "VAN-CREW1"
    with t["f"]() as db:
        assert db.scalars(select(StockCount)).first() is None
    p = _preview(t, "bin", scans)
    assert [r["result"] for r in p["rows"]] == ["matched", "moved_here"]
    assert _confirm(t, "bin", scans, p["expected_ids"])["count"]["moved_here"] == 1


def test_duplicates_and_unit_ids(api):
    t = api
    _receive(t, ["D1"], "bin")
    uid = _units(t)["D1"]["id"]
    rid = t["router"]["id"]
    scans = [{"raw": "D1"}, {"raw": f"sp:{uid}"}, {"raw": "anything", "unit_id": uid}, {"raw": "N1", "part_id": rid}, {"raw": "n1", "part_id": rid},
             {"raw": "Q9"}, {"raw": "Q9"}, {"raw": "x", "unit_id": 424242}, {"raw": "   "}]
    p = _preview(t, "bin", scans)
    assert [r["result"] for r in p["rows"]] == ["matched", "duplicate", "duplicate", "new", "duplicate", "needs_part", "duplicate", "not_a_unit", "not_a_unit"]
    assert p["missing"] == []
    out = _confirm(t, "bin", [s for s in scans if s["raw"] != "Q9"], p["expected_ids"])
    assert out["count"]["new_units"] == 1 and out["count"]["matched"] == 1 and len(out["movements"]) == 1


def test_part_number_label_is_not_a_unit(api):
    """A `P/N` scan is a part number, never a new serial to count in (issue #139)."""
    t = api
    p = _preview(t, "bin", [{"raw": "P/N: XYZ-123", "part_id": t["router"]["id"]}, {"raw": "sp:²"}, {"raw": "sp:2147483648"}])
    assert [r["result"] for r in p["rows"]] == ["not_a_unit", "not_a_unit", "not_a_unit"]
    assert p["counts"]["new"] == 0


def test_corrections_of_count_rows(api):
    t = api
    rid = t["router"]["id"]
    _receive(t, ["K1", "K2"], "bin")
    _receive(t, ["K3"], "van")
    _batch(t, t["keeper"], [{"kind": "transfer", "part_id": rid, "serial": "K3", "to_location_id": t["store"]["id"]}])
    scans = [{"raw": "K1"}, {"raw": "K3"}, {"raw": "K9", "part_id": rid}]
    p = _preview(t, "bin", scans)
    out = _confirm(t, "bin", scans, p["expected_ids"])
    mv = {m["serial"]: m for m in out["movements"]}
    assert set(mv) == {"K2", "K3", "K9"}

    def correct(m, status=201):
        r = t["c"].post(f"/stock/movements/{m['id']}/correct", json={"note": "count mistake"}, headers=t["keeper"])
        assert r.status_code == status, r.text
        return r.json()

    # new → void (the serial can be counted in / received again)
    c = correct(mv["K9"])
    assert c["to_state"] == "void" and "K9" not in _units(t)
    # missing → back in stock at the counted location
    c = correct(mv["K2"])
    assert c["from_state"] == "missing" and c["to_state"] == "in_stock" and c["to_location_code"] == "STORE-A-01"
    assert _units(t)["K2"]["location_code"] == "STORE-A-01"
    # moved here → back at its old location
    c = correct(mv["K3"])
    assert c["to_location_code"] == "STORE" and _units(t)["K3"]["location_code"] == "STORE"
    correct(mv["K3"], 409)  # already corrected
    # found again → missing again; a voided serial counted in again reuses its unit
    out = _confirm(t, "van", [], [])
    assert out["movements"] == [] and out["count"]["missing"] == 0
    p = _preview(t, "bin", [{"raw": "K1"}])
    assert [u["serial"] for u in p["missing"]] == ["K2"]
    _confirm(t, "bin", [{"raw": "K1"}], p["expected_ids"])
    found = _confirm(t, "van", [{"raw": "K2"}, {"raw": "K9", "part_id": rid}], [])
    fmv = {m["serial"]: m for m in found["movements"]}
    assert fmv["K9"]["from_state"] == "void" and found["count"]["new_units"] == 1 and found["count"]["found_again"] == 1
    c = correct(fmv["K2"])
    assert c["to_state"] == "missing" and c["to_location_id"] is None and _units(t)["K2"]["state"] == "missing"
    _replay(t)
