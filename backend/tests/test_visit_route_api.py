"""Site visit route `/growatt/routes/solve` (docs/plans/site-visit-route.md §5): Geoapify matrix and
route line (fake session, never the network), straight-line fallback, credits, caches, scoping,
422 / 429, Google Maps links and the sunset / latest-finish flags."""

from __future__ import annotations

import logging
import math
from urllib.parse import parse_qs, urlsplit

import pytest
import requests
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import GrowattPlant, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.logging_db import redact
from app.main import create_app
from app.services import visit_route as vr

KEY = "geo-test-key-0123456789abcdef"
BASE = {"kind": "point", "lat": 13.75, "lon": 100.55, "label": "Base"}
DAY = "2026-11-22"

PLANTS = {
    101: ("Bangkok", 13.7563, 100.5018),
    102: ("Ayutthaya", 14.3532, 100.5689),
    103: ("Nakhon Pathom", 13.8199, 100.0621),
    104: ("Chachoengsao", 13.6904, 101.0779),
    105: ("Saraburi", 14.5289, 100.9101),
    106: ("No location", None, None),
    107: ("Zero zero", 0.0, 0.0),
}
GRID = {200 + k: (f"Grid {k}", 13.5 + 0.1 * (k % 6), 100.2 + 0.12 * (k // 6)) for k in range(30)}

ROAD = 1.25  # the fake's road km per great-circle km
SPEED_KMH = 50.0


def _gc(a, b):
    return vr.haversine_km(a, b)


class FakeResponse:
    def __init__(self, status: int, body):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeGeoapify:
    """Stands in for `requests.Session`: answers `v1/routematrix` and `v1/routing` like Geoapify."""

    def __init__(self):
        self.calls = []
        self.null_pairs = set()  # {((lat, lon), (lat, lon))} with no route
        self.fail = None  # an HTTP status, or an exception to raise

    def _fail(self):
        if isinstance(self.fail, Exception):
            raise self.fail
        if self.fail:
            return FakeResponse(self.fail, {"statusCode": self.fail, "error": "Internal", "message": "boom"})
        return None

    def post(self, url, params=None, json=None, timeout=None):
        self.calls.append(("matrix", url, dict(params or {}), json))
        bad = self._fail()
        if bad:
            return bad
        assert json["mode"] == "drive" and json["sources"] == json["targets"]
        pts = [(loc["location"][1], loc["location"][0]) for loc in json["sources"]]
        rows = []
        for i, a in enumerate(pts):
            row = []
            for j, b in enumerate(pts):
                km = _gc(a, b) * ROAD
                none = (a, b) in self.null_pairs
                row.append({
                    "distance": None if none else km * 1000.0,
                    "time": None if none else km / SPEED_KMH * 3600.0,
                    "source_index": i, "target_index": j,
                })
            rows.append(row)
        return FakeResponse(200, {"sources": [], "targets": [], "sources_to_targets": rows, "mode": "drive"})

    def get(self, url, params=None, timeout=None):
        self.calls.append(("route", url, dict(params or {}), None))
        bad = self._fail()
        if bad:
            return bad
        pts = []
        for wp in params["waypoints"].split("|"):
            assert wp.startswith("lonlat:")
            lon, lat = wp[len("lonlat:"):].split(",")
            pts.append((float(lat), float(lon)))
        legs, lines = [], []
        for a, b in zip(pts, pts[1:]):
            km = _gc(a, b) * ROAD * 1.02  # the routed line is a little longer than the matrix says
            legs.append({"distance": km * 1000.0, "time": km / SPEED_KMH * 3600.0, "steps": []})
            mid = [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2 + 0.01]
            lines.append([[a[1], a[0]], mid, [b[1], b[0]]])
        return FakeResponse(200, {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {"mode": "drive", "distance": sum(leg["distance"] for leg in legs),
                               "time": sum(leg["time"] for leg in legs), "legs": legs},
                "geometry": {"type": "MultiLineString", "coordinates": lines},
            }],
        })

    def count(self, kind):
        return sum(1 for c in self.calls if c[0] == kind)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite:///{tmp_path / 'route.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid, (name, lat, lon) in {**PLANTS, **GRID}.items():
            db.add(GrowattPlant(plant_id=pid, name=name, latitude=lat, longitude=lon))
        db.commit()
        eng = db.query(User).filter(User.username == "engineer").one()
        for pid in (102, 103, 106):
            db.add(UserPlantAssignment(user_id=eng.id, plant_id=pid))
        db.commit()
    monkeypatch.setattr(settings, "route_solve_per_min", 1000)
    monkeypatch.setattr(settings, "geoapify_daily_credits", 2800)
    vr.solve_limiter.reset()

    fake = FakeGeoapify()
    router = vr.GeoapifyRouter(lambda: vr.GeoapifyClient(KEY, session=fake), cooldown_s=60.0)
    app = create_app()

    def override():
        with f() as db:
            yield db

    state = {"router": router}
    app.dependency_overrides[get_db] = override
    app.dependency_overrides[vr.get_router] = lambda: state["router"]
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    yield {"client": client, "adm": hdr("admin", "admin123"), "eng": hdr("engineer", "engineer123"),
           "fake": fake, "state": state, "f": f}
    vr.solve_limiter.reset()


def _solve(api, stops, who="adm", **kw):
    body = {"start": BASE, "day": DAY, "stops": [s if isinstance(s, dict) else {"plant_id": s} for s in stops], **kw}
    return api["client"].post("/growatt/routes/solve", json=body, headers=api[who])


def _db_credits(api):
    with api["f"]() as db:
        return vr.credits_today(db)


def test_geoapify_path_order_legs_geometry(api):
    r = _solve(api, [102, 103, 104])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["source"] == "geoapify" and out["fallback_reason"] is None
    assert out["geometry_source"] == "geoapify" and out["geometry_fallback_reason"] is None
    assert out["method"] == "exact" and out["straight_line_pairs"] == 0 and out["estimate"] is None
    assert out["attribution"] == ["Powered by Geoapify", "© OpenStreetMap contributors"]
    assert sorted(s["plant_id"] for s in out["stops"]) == [102, 103, 104]
    assert [s["seq"] for s in out["stops"]] == [1, 2, 3]
    # credits: 4 × 4 matrix = 16, routing over 5 waypoints = 4
    assert out["credits_used"] == 20 and _db_credits(api) == 20 and out["credits_today"] == 20
    fake = api["fake"]
    assert fake.count("matrix") == 1 and fake.count("route") == 1
    assert all(c[2]["apiKey"] == KEY for c in fake.calls)
    assert fake.calls[0][1] == "https://api.geoapify.com/v1/routematrix"
    assert fake.calls[1][1] == "https://api.geoapify.com/v1/routing" and fake.calls[1][2]["mode"] == "drive"

    # legs come from the routing answer (2 % longer than the matrix) and the times chain up
    prev_etd = 8 * 60.0
    prev = (BASE["lat"], BASE["lon"])
    for s in out["stops"]:
        here = (s["lat"], s["lon"])
        assert s["leg_source"] == "geoapify"
        assert s["leg_km"] == pytest.approx(_gc(prev, here) * ROAD * 1.02, abs=0.11)
        assert s["leg_min"] == pytest.approx(s["leg_km"] / SPEED_KMH * 60, abs=0.2)
        assert s["eta_min"] == pytest.approx(prev_etd + s["leg_min"], abs=0.2)
        assert s["etd_min"] == pytest.approx(s["eta_min"] + s["wait_min"] + 45, abs=0.2)
        assert s["service_min"] == 45 and s["late_min"] == 0
        prev_etd, prev = s["etd_min"], here
    ret = out["return_leg"]
    assert ret["leg_km"] == pytest.approx(_gc(prev, (BASE["lat"], BASE["lon"])) * ROAD * 1.02, abs=0.11)
    assert ret["eta_min"] == pytest.approx(prev_etd + ret["leg_min"], abs=0.2)
    t = out["totals"]
    assert t["finish"] == ret["eta"] and t["stops"] == 3 and t["service_min"] == 135
    assert t["drive_km"] == pytest.approx(sum(s["leg_km"] for s in out["stops"]) + ret["leg_km"], abs=0.3)
    geo = out["geometry"]
    assert geo["type"] == "MultiLineString" and len(geo["coordinates"]) == 4
    assert geo["coordinates"][0][0] == [BASE["lon"], BASE["lat"]]
    assert out["start"] == {"kind": "point", "plant_id": None, "office_id": None, "name": "Base", "lat": 13.75, "lon": 100.55}


def test_best_order_avoids_zigzag(api):
    """West (103) and east (104) of the base, Ayutthaya (102) north: the order never crosses twice."""
    out = _solve(api, [104, 102, 103], end_mode="last").json()
    order = [s["plant_id"] for s in out["stops"]]
    assert order in ([103, 102, 104], [104, 102, 103])
    assert out["return_leg"] is None and out["geometry"]["coordinates"].__len__() == 3


def test_cached_resolve_costs_zero(api):
    first = _solve(api, [102, 103, 104]).json()
    assert first["credits_used"] == 20
    again = _solve(api, [102, 103, 104]).json()
    assert again["credits_used"] == 0 and again["source"] == "geoapify" and again["geometry_source"] == "geoapify"
    assert api["fake"].count("matrix") == 1 and api["fake"].count("route") == 1
    # the same stops listed in another order: same point set = the cached matrix. A round trip
    # and its reverse drive the same, so the solver may pick either; only a new line is bought.
    shuffled = _solve(api, [104, 102, 103]).json()
    same = [s["plant_id"] for s in shuffled["stops"]] == [s["plant_id"] for s in first["stops"]]
    assert shuffled["credits_used"] == (0 if same else 4)
    assert api["fake"].count("matrix") == 1
    assert _db_credits(api) == 20 + shuffled["credits_used"]
    again = _solve(api, [104, 102, 103]).json()
    assert again["credits_used"] == 0 and _db_credits(api) == 20 + shuffled["credits_used"]
    # a fixed other order reuses the matrix and buys only its own line (5 waypoints = 4)
    best = [s["plant_id"] for s in first["stops"]]
    order = best[1:] + best[:1]  # neither the best loop nor its reverse
    fixed = _solve(api, order, keep_order=True).json()
    assert fixed["method"] == "fixed" and [s["plant_id"] for s in fixed["stops"]] == order
    assert fixed["credits_used"] == 4 and api["fake"].count("matrix") == 1


def test_null_pair_gets_straight_line(api):
    a = (PLANTS[103][1], PLANTS[103][2])
    b = (PLANTS[104][1], PLANTS[104][2])
    api["fake"].null_pairs = {(a, b), (b, a)}
    out = _solve(api, [102, 103, 104]).json()
    assert out["source"] == "geoapify" and out["straight_line_pairs"] == 2
    assert out["estimate"]["road_factor"] == vr.ROAD_FACTOR and out["estimate"]["speed_kmh"] == vr.STRAIGHT_LINE_SPEED_KMH
    assert "straight_line_pairs" in out["labels"]


def test_error_falls_back_and_cools_down(api):
    fake = api["fake"]
    fake.fail = 500
    out = _solve(api, [102, 103]).json()
    assert out["source"] == "straight_line" and out["fallback_reason"] == "error"
    assert out["geometry_source"] == "straight_line" and out["geometry_fallback_reason"] == "error"
    assert out["credits_used"] == 0 and out["attribution"] == [] and _db_credits(api) == 0
    assert out["straight_line_pairs"] == 6 and out["estimate"] is not None
    assert out["labels"]["drive"].startswith("straight line")
    # straight-line legs: great-circle km, minutes from the named constants
    s = out["stops"][0]
    km = _gc((BASE["lat"], BASE["lon"]), (s["lat"], s["lon"]))
    assert s["leg_km"] == pytest.approx(km, abs=0.06) and s["leg_source"] == "straight_line"
    assert s["leg_min"] == pytest.approx(km * vr.ROAD_FACTOR / vr.STRAIGHT_LINE_SPEED_KMH * 60, abs=0.1)
    geo = out["geometry"]
    assert geo["type"] == "MultiLineString" and all(len(line) == 2 for line in geo["coordinates"])
    assert fake.count("matrix") == 1
    # the next solve does not call Geoapify during the cooldown
    fake.fail = None
    nxt = _solve(api, [102, 103]).json()
    assert nxt["source"] == "straight_line" and nxt["fallback_reason"] == "cooldown"
    assert len(fake.calls) == 1


def test_bad_request_does_not_cool_down(api):
    fake = api["fake"]
    fake.fail = 400
    assert _solve(api, [102, 103]).json()["fallback_reason"] == "error"
    fake.fail = None
    assert _solve(api, [102, 103]).json()["source"] == "geoapify"


def test_budget_cap_falls_back(api, monkeypatch):
    monkeypatch.setattr(settings, "geoapify_daily_credits", 10)  # a 4 × 4 matrix costs 16
    out = _solve(api, [102, 103, 104]).json()
    assert out["source"] == "straight_line" and out["fallback_reason"] == "budget"
    assert "credits" in out["fallback_detail"] and out["credits_daily_cap"] == 10
    assert api["fake"].calls == []
    # room for the matrix (9) but not the line (3 waypoints = 2 credits) after it
    monkeypatch.setattr(settings, "geoapify_daily_credits", 10)
    out = _solve(api, [102, 103], end_mode="last").json()
    assert out["source"] == "geoapify" and out["credits_used"] == 9
    assert out["geometry_source"] == "straight_line" and out["geometry_fallback_reason"] == "budget"
    assert api["fake"].count("route") == 0 and _db_credits(api) == 9


def test_no_key_is_straight_line(api):
    api["state"]["router"] = vr.GeoapifyRouter(None)
    out = _solve(api, [102]).json()
    assert out["source"] == "straight_line" and out["fallback_reason"] == "no_key" and out["method"] == "trivial"


def test_key_never_in_logs_or_answers(api, monkeypatch, caplog):
    url = f"https://api.geoapify.com/v1/routing?waypoints=lonlat:100.5,13.7&mode=drive&apiKey={KEY}"
    assert KEY not in redact(url)  # the apiKey= pattern, without the key in settings
    monkeypatch.setattr(settings, "geoapify_api_key", KEY)
    assert KEY not in redact(f"failed: {KEY}")  # the exact value from settings
    api["fake"].fail = requests.ConnectionError(f"Max retries exceeded with url: {url}")
    with caplog.at_level(logging.WARNING, logger="app.services.visit_route"):
        r = _solve(api, [102, 103])
    assert r.status_code == 200 and KEY not in r.text
    assert r.json()["fallback_detail"] == "Geoapify routematrix: ConnectionError"
    assert caplog.records and all(KEY not in rec.getMessage() for rec in caplog.records)


def test_engineer_scope_404(api):
    assert _solve(api, [102, 103], who="eng").status_code == 200
    r = _solve(api, [102, 104], who="eng")
    assert r.status_code == 404 and "104" in r.json()["detail"]
    r = api["client"].post("/growatt/routes/solve", headers=api["eng"],
                           json={"start": {"kind": "plant", "plant_id": 105}, "stops": [{"plant_id": 102}]})
    assert r.status_code == 404
    assert _solve(api, [999]).status_code == 404  # unknown plant, admin
    ok = api["client"].post("/growatt/routes/solve", headers=api["eng"],
                            json={"start": {"kind": "plant", "plant_id": 102}, "stops": [{"plant_id": 103}]})
    assert ok.status_code == 200 and ok.json()["start"]["plant_id"] == 102
    assert api["fake"].count("matrix") == 2  # the two answered solves; refused ones never reach Geoapify


def test_plant_without_location_422(api):
    r = _solve(api, [102, 106, 107])
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["message"] == "no location in Growatt, can't be routed"
    assert [p["plant_id"] for p in d["plants"]] == [106, 107]
    assert api["fake"].calls == []


def test_too_many_and_bad_stops_422(api):
    r = _solve(api, list(GRID)[:26])
    assert r.status_code == 422 and "split the day" in r.json()["detail"]
    assert _solve(api, list(GRID)[:25]).status_code == 200
    assert _solve(api, [102, 102]).status_code == 422  # duplicate
    assert _solve(api, []).status_code == 422
    assert _solve(api, [{"plant_id": 102, "window": {"open": "12:00", "close": "10:00"}}]).status_code == 422
    assert _solve(api, [102], leave_at="8am").status_code == 422
    bad_start = api["client"].post("/growatt/routes/solve", headers=api["adm"],
                                   json={"start": {"kind": "point", "lat": 0, "lon": 0}, "stops": [{"plant_id": 102}]})
    assert bad_start.status_code == 422


def test_rate_limit_429(api, monkeypatch):
    monkeypatch.setattr(settings, "route_solve_per_min", 2)
    assert _solve(api, [102]).status_code == 200
    assert _solve(api, [102]).status_code == 200
    r = _solve(api, [102])
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
    assert _solve(api, [102], who="eng").status_code == 200  # per user


def _pt(text):
    lat, lon = text.split(",")
    return round(float(lat), 5), round(float(lon), 5)


def test_google_links_split_and_chain(api):
    stops = list(GRID)[:8]
    out = _solve(api, stops).json()
    links = out["google_maps_links"]
    assert len(links) == 3  # 10 points (start, 8 stops, start), 9 legs → 4 + 4 + 1
    qs = [parse_qs(urlsplit(u).query) for u in links]
    for q, u in zip(qs, links):
        assert u.startswith("https://www.google.com/maps/dir/?api=1&")
        assert q["travelmode"] == ["driving"] and q["dir_action"] == ["navigate"]
        assert len(q.get("waypoints", [""])[0].split("|")) <= 3
    for a, b in zip(qs, qs[1:]):
        assert a["destination"] == b["origin"]
    start = (BASE["lat"], BASE["lon"])
    assert _pt(qs[0]["origin"][0]) == start and _pt(qs[-1]["destination"][0]) == start
    visited = [_pt(w) for q in qs for w in (q.get("waypoints", [""])[0].split("|") if q.get("waypoints") else [])]
    visited += [_pt(q["destination"][0]) for q in qs[:-1]]
    order = [(round(s["lat"], 5), round(s["lon"], 5)) for s in out["stops"]]
    assert sorted(visited) == sorted(order)

    last = _solve(api, stops, end_mode="last").json()["google_maps_links"]
    assert len(last) == 2  # 9 points, 8 legs → 4 + 4
    q_end = parse_qs(urlsplit(last[-1]).query)
    final = _solve(api, stops, end_mode="last").json()["stops"][-1]
    assert _pt(q_end["destination"][0]) == (round(final["lat"], 5), round(final["lon"], 5))


def test_links_helper_short_routes():
    assert vr.google_maps_links([(13.0, 100.0)]) == []
    one = vr.google_maps_links([(13.0, 100.0), (14.0, 101.0)])
    assert len(one) == 1 and "waypoints" not in one[0]
    five = vr.google_maps_links([(13.0 + k / 10, 100.0) for k in range(5)])
    assert len(five) == 1 and parse_qs(urlsplit(five[0]).query)["waypoints"][0].count("|") == 2


def test_after_sunset_and_after_latest_flags(api):
    early = _solve(api, [102]).json()["stops"][0]
    assert early["after_sunset"] is False and early["after_latest"] is False
    assert early["sunset"] and "17:30" < early["sunset"] < "18:15"  # Ayutthaya, 22 Nov (NOAA)
    late = _solve(api, [{"plant_id": 102, "service_min": 120}], leave_at="16:30", latest_finish="17:00").json()
    s = late["stops"][0]
    assert s["after_sunset"] is True and s["after_latest"] is True
    assert late["return_leg"]["after_latest"] is True and late["totals"]["after_latest"] is True
    assert late["latest_finish"] == "17:00"


def test_window_wait(api):
    out = _solve(api, [{"plant_id": 101, "service_min": 30, "window": {"open": "10:00", "close": "11:00"}}]).json()
    s = out["stops"][0]
    assert s["eta_min"] < 600 and s["wait_min"] == pytest.approx(600 - s["eta_min"], abs=0.2)
    assert s["etd"] == "10:30" and s["window"] == {"open": "10:00", "close": "11:00"}


def test_credit_costs():
    # stops + start, round trip (waypoints = stops + 2), under 500 km
    assert vr.matrix_credits(6) + vr.routing_credits(7, 300) == 36 + 6
    assert vr.matrix_credits(11) + vr.routing_credits(12, 400) == 110 + 11
    assert vr.matrix_credits(26) + vr.routing_credits(27, 450) == 260 + 26
    assert vr.routing_credits(27, 1200) == 26 + 2
    assert vr.matrix_credits(9) == 81 and vr.matrix_credits(26) == 260
    assert math.isclose(vr.straight_line_min(60.0), 78.0)
