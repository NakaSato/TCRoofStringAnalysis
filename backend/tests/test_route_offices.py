"""Visit Route offices `/growatt/routes/offices` (docs/plans/site-visit-route.md §5) and the
`office` start of `/growatt/routes/solve`: CRUD, admin-only writes, the single default, names
unique case-insensitively, 0,0 refused, solve on Geoapify (fake session) and straight line."""

from __future__ import annotations

from app.services import visit_route as vr
from tests.test_visit_route_api import DAY, api  # noqa: F401  (pytest fixture)

URL = "/growatt/routes/offices"
HQ = {"name": "  Head Office ", "address": "Bang Na, Bangkok", "lat": 13.668, "lon": 100.604}
NORTH = {"name": "North base", "lat": 14.35, "lon": 100.57}


def _post(api, body, who="adm"):
    return api["client"].post(URL, json=body, headers=api[who])


def _list(api, who="adm"):
    r = api["client"].get(URL, headers=api[who])
    assert r.status_code == 200
    return r.json()["offices"]


def test_create_list_first_is_default(api):
    r = _post(api, HQ)
    assert r.status_code == 201
    hq = r.json()
    assert hq["name"] == "Head Office" and hq["address"] == "Bang Na, Bangkok"
    assert hq["is_default"] is True and hq["lat"] == 13.668 and hq["created_by"] is not None
    assert hq["created_at"] and hq["updated_at"]
    north = _post(api, NORTH).json()
    assert north["is_default"] is False and north["address"] is None
    alpha = _post(api, {"name": "Alpha depot", "lat": 13.9, "lon": 100.4, "address": "  "}).json()
    assert alpha["address"] is None
    # default first, then by name
    assert [o["name"] for o in _list(api)] == ["Head Office", "Alpha depot", "North base"]
    assert [o["name"] for o in _list(api, who="eng")] == ["Head Office", "Alpha depot", "North base"]


def test_engineer_reads_but_cannot_write(api):
    hq = _post(api, HQ).json()
    assert _post(api, NORTH, who="eng").status_code == 403
    c = api["client"]
    assert c.patch(f"{URL}/{hq['id']}", json={"name": "X"}, headers=api["eng"]).status_code == 403
    assert c.delete(f"{URL}/{hq['id']}", headers=api["eng"]).status_code == 403
    assert c.get(URL).status_code == 401
    assert len(_list(api, who="eng")) == 1


def test_default_moves_and_delete_promotes_oldest(api):
    c = api["client"]
    hq = _post(api, HQ).json()
    north = _post(api, NORTH).json()
    third = _post(api, {"name": "East", "lat": 13.69, "lon": 101.08, "is_default": True}).json()
    assert third["is_default"] is True
    assert [o["id"] for o in _list(api) if o["is_default"]] == [third["id"]]
    r = c.patch(f"{URL}/{north['id']}", json={"is_default": True}, headers=api["adm"])
    assert r.status_code == 200 and r.json()["is_default"] is True
    assert [o["id"] for o in _list(api) if o["is_default"]] == [north["id"]]
    # unsetting the default is refused: pick another one instead
    r = c.patch(f"{URL}/{north['id']}", json={"is_default": False}, headers=api["adm"])
    assert r.status_code == 422
    # false on a non-default is a no-op
    assert c.patch(f"{URL}/{hq['id']}", json={"is_default": False}, headers=api["adm"]).status_code == 200
    # deleting the default promotes the oldest remaining office
    r = c.delete(f"{URL}/{north['id']}", headers=api["adm"])
    assert r.status_code == 200 and r.json() == {"id": north["id"], "deleted": True, "default_office_id": hq["id"]}
    assert [o["id"] for o in _list(api) if o["is_default"]] == [hq["id"]]
    # deleting a non-default keeps the default
    r = c.delete(f"{URL}/{third['id']}", headers=api["adm"])
    assert r.json()["default_office_id"] == hq["id"]
    assert c.delete(f"{URL}/{hq['id']}", headers=api["adm"]).json()["default_office_id"] is None
    assert _list(api) == []
    assert c.delete(f"{URL}/{hq['id']}", headers=api["adm"]).status_code == 404


def test_patch_fields_and_unknown(api):
    c = api["client"]
    hq = _post(api, HQ).json()
    r = c.patch(f"{URL}/{hq['id']}", json={"name": " HQ ", "address": None, "lat": 13.7}, headers=api["adm"])
    assert r.status_code == 200
    out = r.json()
    assert out["name"] == "HQ" and out["address"] is None and out["lat"] == 13.7 and out["lon"] == 100.604
    assert c.patch(f"{URL}/999", json={"name": "Y"}, headers=api["adm"]).status_code == 404
    assert c.patch(f"{URL}/{hq['id']}", json={"name": None}, headers=api["adm"]).status_code == 422
    assert c.patch(f"{URL}/{hq['id']}", json={"lat": None}, headers=api["adm"]).status_code == 422
    # renaming to its own name in another case is fine
    assert c.patch(f"{URL}/{hq['id']}", json={"name": "hq"}, headers=api["adm"]).status_code == 200


def test_duplicate_name_409(api):
    c = api["client"]
    _post(api, HQ)
    north = _post(api, NORTH).json()
    r = _post(api, {**NORTH, "name": "HEAD office"})
    assert r.status_code == 409
    assert c.patch(f"{URL}/{north['id']}", json={"name": "head office  "}, headers=api["adm"]).status_code == 409
    assert len(_list(api)) == 2


def test_bad_location_and_name_422(api):
    c = api["client"]
    assert _post(api, {"name": "Zero", "lat": 0, "lon": 0}).status_code == 422
    assert _post(api, {"name": "Far", "lat": 91, "lon": 100}).status_code == 422
    assert _post(api, {"name": "   ", "lat": 13.7, "lon": 100.5}).status_code == 422
    assert _post(api, {"name": "x" * 81, "lat": 13.7, "lon": 100.5}).status_code == 422
    assert _post(api, {"name": "Addr", "address": "a" * 201, "lat": 13.7, "lon": 100.5}).status_code == 422
    office = _post(api, {"name": "Equator", "lat": 0, "lon": 100.5}).json()
    # lat alone would make it 0,0
    r = c.patch(f"{URL}/{office['id']}", json={"lon": 0}, headers=api["adm"])
    assert r.status_code == 422
    assert _list(api)[0]["lon"] == 100.5


def _solve_from(api, start, stops=(102, 103), who="adm"):
    body = {"start": start, "day": DAY, "stops": [{"plant_id": p} for p in stops]}
    return api["client"].post("/growatt/routes/solve", json=body, headers=api[who])


def test_solve_from_office_geoapify(api):
    hq = _post(api, HQ).json()
    r = _solve_from(api, {"kind": "office", "office_id": hq["id"]})
    assert r.status_code == 200
    out = r.json()
    assert out["start"] == {"kind": "office", "plant_id": None, "office_id": hq["id"], "name": "Head Office",
                            "lat": 13.668, "lon": 100.604}
    assert out["source"] == "geoapify" and len(out["stops"]) == 2
    assert out["geometry"]["coordinates"][0][0] == [100.604, 13.668]  # the first leg leaves the office
    # same coordinates as a point start: the cached matrix and line are reused (keys are by points)
    calls = len(api["fake"].calls)
    p = _solve_from(api, {"kind": "point", "lat": 13.668, "lon": 100.604, "label": "Same spot"}).json()
    assert len(api["fake"].calls) == calls and p["credits_used"] == 0
    assert p["start"]["kind"] == "point" and p["start"]["office_id"] is None and p["start"]["name"] == "Same spot"


def test_solve_from_office_straight_line_and_engineer(api):
    api["state"]["router"] = vr.GeoapifyRouter(None)
    hq = _post(api, HQ).json()
    out = _solve_from(api, {"kind": "office", "office_id": hq["id"]}, who="eng").json()
    assert out["source"] == "straight_line" and out["fallback_reason"] == "no_key"
    assert out["start"]["kind"] == "office" and out["start"]["name"] == "Head Office"
    assert out["return_leg"]["leg_source"] == "straight_line"


def test_solve_unknown_office_404(api):
    r = _solve_from(api, {"kind": "office", "office_id": 999})
    assert r.status_code == 404 and "Office 999" in r.json()["detail"]
    assert api["fake"].calls == []
    assert _solve_from(api, {"kind": "office"}).status_code == 422  # office_id required
