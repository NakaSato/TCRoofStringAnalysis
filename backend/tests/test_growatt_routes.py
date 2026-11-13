"""Growatt routes: DB-only endpoints vs memory-only live endpoints (no network)."""

from __future__ import annotations

from datetime import datetime, timedelta

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattInverterReading, GrowattPlant, GrowattStringReading
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services.growatt_live import GrowattLiveService, LiveUnavailable, get_live_service
from solar_core.growatt import GrowattAPIError, GrowattClient

PLANT = 111
SN_A, SN_B = "INVA", "INVB"


def _seed_growatt(session) -> None:
    session.add(GrowattPlant(plant_id=PLANT, name="Test Plant", peak_power_kwp=20.0))
    session.flush()
    session.add_all(
        [
            GrowattInverter(device_sn=SN_A, plant_id=PLANT, device_types="inverter,max"),
            GrowattInverter(device_sn=SN_B, plant_id=PLANT, device_types="inverter,max"),
            GrowattInverter(device_sn="INVC", plant_id=PLANT),  # no readings at all
        ]
    )
    session.flush()
    day = datetime(2026, 11, 11)
    # Yesterday's total carried over just after midnight, then the counter resets.
    session.add(GrowattInverterReading(device_sn=SN_A, timestamp=day + timedelta(minutes=1), pac_w=0, ppv_w=0, eac_today_kwh=99.0))
    # INVA: 1-minute records, 10:00–10:59 at 6 kW AC / 6.2 kW DC  -> ~6 kWh
    for m in range(60):
        ts = day + timedelta(hours=10, minutes=m)
        session.add(
            GrowattInverterReading(
                device_sn=SN_A, timestamp=ts, pac_w=6000, ppv_w=6200, eac_today_kwh=round(m / 10, 1),
                eac_total_kwh=1000.0 + round(m / 10, 1), temperature_c=40.0, fac_hz=50.0,
            )
        )
        session.add(GrowattStringReading(device_sn=SN_A, timestamp=ts, string_no=1, mppt_no=1, voltage_v=600, current_a=5.0, power_w=3000))
        session.add(GrowattStringReading(device_sn=SN_A, timestamp=ts, string_no=2, mppt_no=1, voltage_v=600, current_a=5.0, power_w=3000))
    # INVB: 5-minute records over the same hour at 4 kW, no temperature / frequency reported
    for m in range(0, 60, 5):
        ts = day + timedelta(hours=10, minutes=m, seconds=20)
        session.add(GrowattInverterReading(device_sn=SN_B, timestamp=ts, pac_w=4000, ppv_w=4100, eac_today_kwh=4.0))
    session.commit()


@pytest.fixture()
def client(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'growatt.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed_growatt(s)

    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    c.app_ref = app  # type: ignore[attr-defined]
    return c


def test_plants_list_is_db_only_and_uses_last_counter_value(client):
    plants = {p["plant_id"]: p for p in client.get("/api/growatt/plants").json()}
    p = plants[PLANT]
    # last eac_today of each inverter: INVA 5.9 + INVB 4.0 (not the 99 kWh carried over from yesterday)
    assert p["today_energy_kwh"] == pytest.approx(9.9)
    assert p["energy_date"] == "2026-11-11"
    assert p["inverter_count"] == 3
    assert "synced_at" in p
    # lifetime = newest stored eac_total per inverter (INVA 1005.9; INVB/INVC report none)
    assert p["total_energy_kwh"] == pytest.approx(1005.9)
    # realtime fields are never stored, so the DB list returns them as null
    assert p["current_power_w"] is None and p["status"] is None


def test_overview_day_filter_energy_integration_and_nulls(client):
    ov = client.get(f"/api/growatt/plants/{PLANT}/overview").json()
    assert ov["meta"]["source"] == "db"
    assert ov["meta"]["day"] == "2026-11-11"

    invs = {i["device_sn"]: i for i in ov["inverters"]}
    # 1-minute records are weighted by their real interval, not 5 minutes each
    assert invs[SN_A]["period_energy_kwh"] == pytest.approx(6.0, abs=0.5)
    assert invs[SN_B]["period_energy_kwh"] == pytest.approx(4.0, abs=0.5)
    assert invs[SN_A]["yield_today_kwh"] == pytest.approx(5.9)
    # missing measurements stay null instead of invented defaults
    assert invs[SN_B]["avg_temp_c"] is None and invs[SN_B]["avg_freq_hz"] is None
    assert invs["INVC"]["efficiency_pct"] is None and invs["INVC"]["current_ac_kw"] is None
    assert invs[SN_A]["avg_temp_c"] == 40.0
    # realtime fields are null in the DB overview; the UI overlays /growatt/live/*
    assert all(i["status"] is None and i["lost"] is None and i["last_update_time"] is None for i in invs.values())
    assert ov["plant"]["current_power_w"] is None and ov["plant"]["status"] is None
    assert ov["kpis"]["current_power_kw"] is None and ov["kpis"]["online_inverters"] is None
    assert ov["kpis"]["total_yield_kwh"] == pytest.approx(1005.9)

    # plant curve sums the per-inverter mean in each 5-minute slot: 6 kW + 4 kW
    peak = max(r["pac_kw"] for r in ov["timeseries"])
    assert peak == pytest.approx(10.0)
    assert ov["kpis"]["yield_today_kwh"] == pytest.approx(9.9)

    strings = {s["string_no"]: s for s in ov["strings"]}
    assert strings[1]["actual_energy_kwh"] == pytest.approx(3.0, abs=0.2)

    empty = client.get(f"/api/growatt/plants/{PLANT}/overview", params={"day": "2026-11-01"}).json()
    assert empty["timeseries"] == [] and empty["kpis"]["yield_today_kwh"] is None
    assert empty["kpis"]["plant_pr_pct"] is None and empty["loss_waterfall"] == []


def test_string_detail_day_and_peer(client):
    d = client.get(f"/api/growatt/plants/{PLANT}/strings/{SN_A}/1").json()
    assert d["meta"] == {"source": "db", "day": "2026-11-11"}
    assert d["summary"]["energy_kwh"] == pytest.approx(3.0, abs=0.2)
    assert d["timeseries"][0]["peer_current_a"] == pytest.approx(5.0)
    assert client.get(f"/api/growatt/plants/{PLANT}/strings/{SN_A}/1", params={"day": "2026-11-01"}).status_code == 404


def test_inverter_timeseries_5min_slots_and_modelled_reference(client):
    d = client.get(f"/api/growatt/plants/{PLANT}/inverters/{SN_A}/timeseries").json()
    assert d["meta"] == {"source": "db", "day": "2026-11-11"}
    # No layout entries: the modelled reference uses plant kWp / 3 inverters.
    assert d["capacity_basis"] == "plant_share"
    assert d["capacity_kwp"] == pytest.approx(6.67)
    day_rows = [r for r in d["timeseries"] if r["timestamp"].startswith("2026-11-11 10:") or "T10:" in r["timestamp"]]
    assert len(day_rows) == 12  # 1-minute records averaged into 5-minute slots
    assert day_rows[0]["pac_kw"] == pytest.approx(6.0)
    assert day_rows[0]["ppv_kw"] == pytest.approx(6.2)
    assert day_rows[0]["temp_c"] == pytest.approx(40.0)
    assert day_rows[0]["expected_kw"] > 0
    # Missing temperature stays null; an inverter with no readings has an empty series.
    b = client.get(f"/api/growatt/plants/{PLANT}/inverters/{SN_B}/timeseries").json()
    assert all(r["temp_c"] is None for r in b["timeseries"])
    c = client.get(f"/api/growatt/plants/{PLANT}/inverters/INVC/timeseries").json()
    assert c["timeseries"] == [] and c["meta"]["day"] is None
    assert client.get(f"/api/growatt/plants/{PLANT}/inverters/NOPE/timeseries").status_code == 404


def test_inverter_timeseries_string_heatmap_and_rating(client):
    d = client.get(f"/api/growatt/plants/{PLANT}/inverters/{SN_A}/timeseries").json()
    h = d["strings"]
    assert h["string_nos"] == [1, 2]
    assert len(h["timestamps"]) == 12 and len(h["current_a"]) == 2 and len(h["current_a"][0]) == 12
    assert h["current_a"][0][0] == pytest.approx(5.0)
    assert d["nominal_power_kw"] is None  # not read from Growatt yet: null, not a guess
    b = client.get(f"/api/growatt/plants/{PLANT}/inverters/{SN_B}/timeseries").json()
    assert b["strings"] == {"string_nos": [], "timestamps": [], "current_a": []}


def test_inverter_daily_trend_vs_plant_average(client):
    d = client.get(f"/api/growatt/plants/{PLANT}/inverters/{SN_A}/daily", params={"days": 3}).json()
    assert d["meta"] == {"source": "db", "from": "2026-11-09", "to": "2026-11-11", "days": 3}
    last = d["daily"][-1]
    # last eac_today of the day (5.9), not the 99 kWh carried over from the day before
    assert last["yield_kwh"] == pytest.approx(5.9)
    assert last["plant_avg_yield_kwh"] == pytest.approx(4.95)  # (5.9 + 4.0) / 2 reporting inverters
    assert last["inverters_reporting"] == 2
    assert last["vs_plant_pct"] == pytest.approx(119.2)
    assert last["peak_ac_kw"] == pytest.approx(6.0) and last["max_temp_c"] == pytest.approx(40.0)
    # days without records are null, never zero
    assert d["daily"][0]["yield_kwh"] is None and d["daily"][0]["vs_plant_pct"] is None
    assert client.get(f"/api/growatt/plants/{PLANT}/inverters/{SN_A}/daily", params={"days": 91}).status_code == 422
    assert client.get(f"/api/growatt/plants/{PLANT}/inverters/NOPE/daily").status_code == 404


class _FakeClient:
    def __init__(self):
        self.calls = 0
        self.fail: GrowattAPIError | None = None

    def list_plants(self, refresh=False):
        self.calls += 1
        if self.fail:
            raise self.fail
        return [{"plant_id": "111", "name": "Test Plant", "current_power": "1234.5", "status": 1}]

    def list_inverters(self, plant_id, refresh=False):
        self.calls += 1
        return [{"device_sn": SN_A, "status": 1}]


_LATE = __import__("datetime").datetime(2026, 11, 12, 18, 0)  # hours after the fakes' records


def _service(fake, clock):
    return GrowattLiveService(client_factory=lambda phase: fake, ttl_s=60, cooldown_s=30, clock=lambda: clock[0])


def test_live_service_cache_stale_fallback_and_rate_limit_cooldown():
    fake, clock = _FakeClient(), [0.0]
    svc = _service(fake, clock)

    env = svc.plants()
    assert env["source"] == "live" and env["stale"] is False
    assert env["data"][0]["current_power_w"] == 1234.5
    svc.plants()
    assert fake.calls == 1  # served from memory within TTL

    clock[0] = 61.0
    fake.fail = GrowattAPIError("rate limited", error_code=10012)
    env = svc.plants()
    assert env["stale"] is True and env["data"][0]["plant_id"] == 111
    assert fake.calls == 2

    clock[0] = 70.0  # inside cooldown: no upstream call, still stale
    assert svc.plants()["stale"] is True
    assert fake.calls == 2

    clock[0] = 100.0
    fake.fail = None
    assert svc.plants()["stale"] is False
    assert fake.calls == 3


def test_refresh_in_follows_cache_expiry_and_cooldown():
    from datetime import date as _date

    fake, clock = _FakeClient(), [0.0]
    svc = _service(fake, clock)  # ttl 60 s, cooldown 30 s

    assert svc.plants()["refresh_in_s"] == 60  # fresh fetch: full TTL
    clock[0] = 40.0
    assert svc.plants()["refresh_in_s"] == 20  # cache hit: time left
    clock[0] = 55.0
    assert svc.plants()["refresh_in_s"] == 15  # never below the floor

    clock[0] = 61.0
    fake.fail = GrowattAPIError("rate limited", error_code=10012)
    env = svc.plants()
    assert env["stale"] is True and env["refresh_in_s"] == 30  # end of the cooldown
    clock[0] = 76.0
    assert svc.plants()["refresh_in_s"] == 15

    # plant_latest: the earliest inverter to expire decides
    mfake, mclock = _ScriptedMaxClient(), [0.0]
    msvc = GrowattLiveService(
        client_factory=lambda phase: mfake, latest_ttl_s=300, clock=lambda: mclock[0], now_local=lambda: _LATE
    )
    day = _date(2026, 11, 12)
    msvc.plant_latest(PLANT, ["A"], day)
    mclock[0] = 100.0
    assert msvc.plant_latest(PLANT, ["A", "B"], day)["refresh_in_s"] == 200  # A at 0 s, B at 100 s


def test_live_service_without_cache_raises():
    fake, clock = _FakeClient(), [0.0]
    fake.fail = GrowattAPIError("offline")
    with pytest.raises(LiveUnavailable):
        _service(fake, clock).plants()


def test_live_routes_do_not_write_db(client):
    fake, clock = _FakeClient(), [0.0]
    client.app_ref.dependency_overrides[get_live_service] = lambda: _service(fake, clock)

    before = client.get("/api/growatt/plants").json()
    live = client.get("/api/growatt/live/plants").json()
    assert live["source"] == "live" and live["data"][0]["current_power_w"] == 1234.5
    assert client.get(f"/api/growatt/live/plants/{PLANT}/inverters").json()["data"][0]["device_sn"] == SN_A
    after = client.get("/api/growatt/plants").json()
    assert before == after  # realtime values never reach the DB

    fake.fail = GrowattAPIError("offline")
    fresh = _service(fake, clock)
    client.app_ref.dependency_overrides[get_live_service] = lambda: fresh
    assert client.get("/api/growatt/live/plants").status_code == 503


class _FakeMaxClient:
    """Answers device/max/max_data with one newest record per inverter (INVB fails)."""

    def __init__(self):
        self.calls = []

    def _request(self, method, path, params):
        self.calls.append(params["max_sn"])
        if params["max_sn"] == SN_B:
            raise GrowattAPIError("device offline", error_code=10001)
        if params["max_sn"] == "INVC":
            return {"datas": []}
        return {
            "count": 300,
            "datas": [
                {"time": "2026-11-12 11:47:31", "status": 1, "pac": 6100, "ppv": 6300, "eacToday": 12.5,
                 "temperature": 41.0, "fac": 50.01, "vpv1": 600, "ipv1": 10.0, "ppv1": 6000,
                 "vString1": 600, "currentString1": 5.1, "vString2": 600, "currentString2": 4.9},
                {"time": "2026-11-12 11:42:31", "pac": 5000, "ppv": 5200},
            ],
        }


def test_live_latest_route_overlays_newest_record_without_writing(client):
    fake, clock = _FakeMaxClient(), [0.0]
    svc = GrowattLiveService(client_factory=lambda phase: fake, ttl_s=60, clock=lambda: clock[0])
    client.app_ref.dependency_overrides[get_live_service] = lambda: svc

    before = client.get(f"/api/growatt/plants/{PLANT}/overview", params={"day": "2026-11-11"}).json()
    r = client.get(f"/api/growatt/live/plants/{PLANT}/latest")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live"
    invs = {i["device_sn"]: i for i in body["data"]["inverters"]}
    assert set(invs) == {SN_A}  # INVB errored, INVC had no record today
    assert body["data"]["errors"].keys() == {SN_B}
    a = invs[SN_A]
    assert a["timestamp"] == "2026-11-12 11:47:31" and a["pac_w"] == 6100
    assert [s["string_no"] for s in a["strings"]] == [1, 2]
    assert a["strings"][0]["current_a"] == 5.1
    # only 2 strings: too few peers for a verdict, never a guessed status
    chk = body["data"]["string_check"]
    assert chk["inverters"][SN_A]["status"] == "too_few_strings"
    assert chk["summary"]["unknown"] == 2 and chk["summary"]["warning"] == 0

    client.get(f"/api/growatt/live/plants/{PLANT}/latest")
    assert len(fake.calls) == 3  # second call served from memory

    after = client.get(f"/api/growatt/plants/{PLANT}/overview", params={"day": "2026-11-11"}).json()
    assert before == after  # nothing written to the DB
    assert client.get("/api/growatt/live/plants/999/latest").status_code == 404


class _ScriptedMaxClient:
    """max_data answers per serial; `fail` maps serial -> error code to raise."""

    def __init__(self):
        self.calls: list = []
        self.fail: dict = {}

    def _request(self, method, path, params):
        sn = params["max_sn"]
        self.calls.append(sn)
        if sn in self.fail:
            raise GrowattAPIError("refused", error_code=self.fail[sn])
        return {"datas": [{"time": "2026-11-12 12:00:00", "pac": 1000 + len(self.calls), "ppv": 1100}]}

    def list_plants(self, refresh=False):
        self.calls.append("plants")
        return [{"plant_id": 1}]


def test_rate_limit_cooldown_is_per_key_and_latest_is_per_inverter():
    from datetime import date as _date

    fake, clock = _ScriptedMaxClient(), [0.0]
    svc = GrowattLiveService(
        client_factory=lambda phase: fake, ttl_s=60, latest_ttl_s=300, cooldown_s=60, clock=lambda: clock[0],
        now_local=lambda: _LATE,
    )
    day = _date(2026, 11, 12)

    first = svc.plant_latest(PLANT, ["A", "B"], day)
    assert first["stale"] is False and {i["device_sn"] for i in first["data"]["inverters"]} == {"A", "B"}

    clock[0] = 200.0  # inside the 300 s per-inverter TTL: no upstream calls
    svc.plant_latest(PLANT, ["A", "B"], day)
    assert fake.calls == ["A", "B"]

    clock[0] = 301.0  # both expired; B is refused by Growatt
    fake.fail = {"B": 10012}
    env = svc.plant_latest(PLANT, ["A", "B"], day)
    items = {i["device_sn"]: i for i in env["data"]["inverters"]}
    assert env["stale"] is False  # A is fresh, so the plant is not stale as a whole
    assert items["A"]["stale"] is False and items["B"]["stale"] is True  # B keeps its last value
    assert "B" in env["data"]["errors"]

    # B's cooldown does not block other keys (old behaviour paused every live call)
    svc.plants()
    assert fake.calls[-1] == "plants"

    clock[0] = 330.0  # B still cooling down: not called again, still served stale
    n = len(fake.calls)
    env = svc.plant_latest(PLANT, ["A", "B"], day)
    assert fake.calls[n:] == []  # A cached (fresh at 301), B in cooldown
    assert {i["device_sn"]: i["stale"] for i in env["data"]["inverters"]} == {"A": False, "B": True}


class _RhythmClient:
    """One inverter uploading every `step` seconds from 12:00:00; `records` = how many exist so far."""

    def __init__(self, step=300, records=2):
        from datetime import datetime as _dt, timedelta as _td

        self.step, self.records, self.calls = step, records, 0
        self._t = lambda i: (_dt(2026, 11, 12, 12, 0) + _td(seconds=i * step)).strftime("%Y-%m-%d %H:%M:%S")

    def _request(self, method, path, params):
        self.calls += 1
        return {"datas": [{"time": self._t(i), "pac": 1000, "ppv": 1100} for i in reversed(range(self.records))]}


def test_latest_expires_when_the_next_record_is_due():
    from datetime import date as _date, datetime as _dt, timedelta as _td

    fake, clock = _RhythmClient(step=300, records=2), [0.0]  # newest record 12:05:00, interval 300 s
    now = [_dt(2026, 11, 12, 12, 6, 0)]
    svc = GrowattLiveService(
        client_factory=lambda phase: fake, latest_ttl_s=300, cooldown_s=60,
        clock=lambda: clock[0], now_local=lambda: now[0],
    )
    day = _date(2026, 11, 12)

    env = svc.plant_latest(PLANT, ["A"], day)
    inv = env["data"]["inverters"][0]
    assert inv["timestamp"] == "2026-11-12 12:05:00" and inv["interval_s"] == 300
    assert env["refresh_in_s"] == 300  # due 12:10:00 + 60 s grace, now 12:06:00

    clock[0], now[0] = 299.0, now[0] + _td(seconds=299)
    svc.plant_latest(PLANT, ["A"], day)
    assert fake.calls == 1  # still cached

    # due time passed but Growatt has no new record yet: retry after LATE_RETRY_S
    clock[0], now[0] = 301.0, _dt(2026, 11, 12, 12, 11, 1)
    assert svc.plant_latest(PLANT, ["A"], day)["refresh_in_s"] == 60
    assert fake.calls == 2

    # the 12:10:00 record lands: back on the rhythm (due 12:16:00)
    fake.records = 3
    clock[0], now[0] = 362.0, _dt(2026, 11, 12, 12, 12, 2)
    env = svc.plant_latest(PLANT, ["A"], day)
    assert fake.calls == 3 and env["data"]["inverters"][0]["timestamp"] == "2026-11-12 12:10:00"
    assert env["refresh_in_s"] == 238

    # silent for more than two intervals (offline / evening): fall back to latest_ttl_s
    clock[0], now[0] = 1000.0, _dt(2026, 11, 12, 12, 40, 0)
    assert svc.plant_latest(PLANT, ["A"], day)["refresh_in_s"] == 300


def test_device_gap_spaces_calls_per_inverter():
    """Growatt answers max_data once per ~4.5 min per inverter; never ask sooner."""
    from datetime import date as _date, datetime as _dt
    from solar_core.growatt import GrowattAPIError

    day = _date(2026, 11, 12)
    make = lambda fake, clock, now: GrowattLiveService(
        client_factory=lambda phase: fake, latest_ttl_s=300, cooldown_s=60, device_gap_s=270,
        clock=lambda: clock[0], now_local=lambda: now[0],
    )

    # late record: retried after the gap, not after LATE_RETRY_S
    fake, clock, now = _RhythmClient(step=300, records=2), [0.0], [_dt(2026, 11, 12, 12, 11, 1)]
    assert make(fake, clock, now).plant_latest(PLANT, ["A"], day)["refresh_in_s"] == 270

    # 1-min inverter: one call per gap, not per record
    fake, clock, now = _RhythmClient(step=60, records=5), [0.0], [_dt(2026, 11, 12, 12, 4, 10)]
    svc = make(fake, clock, now)
    assert svc.plant_latest(PLANT, ["A"], day)["refresh_in_s"] == 270
    clock[0] = 269.0
    svc.plant_latest(PLANT, ["A"], day)
    assert fake.calls == 1

    # refused (someone else used the window): retry after cooldown_s, never before the gap
    class _Refusing(_RhythmClient):
        refuse = False

        def _request(self, method, path, params):
            if self.refuse:
                self.calls += 1
                raise GrowattAPIError("busy", error_code=10012)
            return super()._request(method, path, params)

    fake, clock, now = _Refusing(step=300, records=2), [0.0], [_dt(2026, 11, 12, 12, 6, 0)]
    svc = GrowattLiveService(
        client_factory=lambda phase: fake, latest_ttl_s=300, cooldown_s=60, device_gap_s=270,
        clock=lambda: clock[0], now_local=lambda: now[0],
    )
    svc.plant_latest(PLANT, ["A"], day)
    svc._cache[("latest", "A", day)] = svc._cache[("latest", "A", day)][:3] + (100.0,)  # force early expiry
    fake.refuse, clock[0] = True, 150.0
    env = svc.plant_latest(PLANT, ["A"], day)
    assert env["stale"] and env["refresh_in_s"] == 120  # waits until 270 s after the success at 0


def test_latest_ttl_edge_cases():
    from datetime import datetime as _dt

    now = _dt(2026, 11, 12, 12, 0, 0)
    svc = GrowattLiveService(client_factory=lambda phase: None, latest_ttl_s=300, now_local=lambda: now)
    row = lambda ts, iv: {"timestamp": ts, "interval_s": iv}
    assert svc._latest_ttl(None) == 300  # no record today
    assert svc._latest_ttl(row("2026-11-12 11:59:00", 60)) == 60  # 1-min inverter: due 12:00 + grace
    assert svc._latest_ttl(row("2026-11-12 11:59:00", None)) == 300 + 60 - 60  # unmeasured: 5 min default
    assert svc._latest_ttl(row("2026-11-12 11:59:00", 3600)) == 300  # gap was an outage, not the rhythm
    assert svc._latest_ttl(row("2026-11-12 12:10:00", 300)) == 360  # record ahead of our clock: capped


def test_sun_times_bangkok():
    from datetime import date as _date, datetime as _dt
    from solar_core.sun import sun_times

    rise, sset = sun_times(_date(2026, 11, 12), 13.7563, 100.5018, 7)
    assert abs((rise - _dt(2026, 11, 12, 6, 16)).total_seconds()) < 180
    assert abs((sset - _dt(2026, 11, 12, 17, 48)).total_seconds()) < 180


def test_night_mode_stretches_ttl_until_dawn():
    from datetime import date as _date, datetime as _dt

    fake, clock = _FakeClient(), [0.0]
    now = [_dt(2026, 11, 12, 12, 0)]
    bkk = [(13.7563, 100.5018)]  # sunrise ~06:16, sunset ~17:48; margins 30 min
    svc = GrowattLiveService(
        client_factory=lambda phase: fake, ttl_s=60, clock=lambda: clock[0],
        now_local=lambda: now[0], night_ttl_s=1800,
    )
    assert svc.plants(coords=bkk)["refresh_in_s"] == 60  # midday: normal TTL

    clock[0], now[0] = 100.0, _dt(2026, 11, 12, 18, 10)  # dusk window still open (until ~18:18)
    assert svc.plants(coords=bkk)["refresh_in_s"] == 60

    clock[0], now[0] = 200.0, _dt(2026, 11, 12, 22, 0)  # night: capped at night_ttl_s
    assert svc.plants(coords=bkk)["refresh_in_s"] == 1800
    clock[0] = 1000.0
    svc.plants(coords=bkk)
    assert fake.calls == 3  # still cached at night

    clock[0], now[0] = 2100.0, _dt(2026, 11, 13, 5, 40)  # ~6 min before dawn window (~05:46)
    r = svc.plants(coords=bkk)["refresh_in_s"]
    assert 60 <= r <= 600  # ends at dawn, not 30 min later

    # latest: a silent inverter at night is not asked every 5 min
    mfake, mclock = _RhythmClient(records=2), [0.0]
    msvc = GrowattLiveService(
        client_factory=lambda phase: mfake, latest_ttl_s=300, clock=lambda: mclock[0],
        now_local=lambda: _dt(2026, 11, 12, 21, 0), night_ttl_s=1800,
    )
    assert msvc.plant_latest(PLANT, ["A"], _date(2026, 11, 12), coords=bkk)["refresh_in_s"] == 1800

    # night mode off (default): unchanged
    off = GrowattLiveService(client_factory=lambda phase: fake, ttl_s=60, now_local=lambda: _dt(2026, 11, 12, 22, 0))
    assert off.plants(coords=bkk)["refresh_in_s"] == 60


def test_plant_latest_all_unavailable_raises():
    from datetime import date as _date

    fake, clock = _ScriptedMaxClient(), [0.0]
    fake.fail = {"A": 10012}
    svc = GrowattLiveService(client_factory=lambda phase: fake, clock=lambda: clock[0])
    with pytest.raises(LiveUnavailable):
        svc.plant_latest(PLANT, ["A"], _date(2026, 11, 12))


def test_history_sync_waits_longer_on_rate_limit(monkeypatch):
    from datetime import date as _date
    from app.services import growatt_sync

    waits: list = []
    monkeypatch.setattr(growatt_sync.time, "sleep", lambda s: waits.append(s))

    class Flaky:
        def __init__(self):
            self.n = 0

        def max_history(self, sn, a, b, stop_before=None):
            self.n += 1
            if self.n <= 2:
                raise GrowattAPIError("busy", error_code=10012)
            return []

    inv = MagicMock(device_sn="X")
    db = MagicMock()
    db.scalar.return_value = None
    growatt_sync.sync_inverter_history(db, Flaky(), inv, _date(2026, 11, 12), _date(2026, 11, 12))
    assert waits == [60, 120]


def test_overview_inactive_inputs_fill_mppt_slots_and_dead_strings_stay_critical(tmp_path):
    """Inputs without current are "Not Active" in their MPPT slot; one that carried current in
    the last 7 days while its peers produce today is a Critical open-string fault instead."""
    from app.services.growatt_overview import build_plant_overview

    engine = build_engine(f"sqlite:///{tmp_path / 'inactive.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    day = datetime(2026, 11, 11)
    with Session() as s:
        s.add(GrowattPlant(plant_id=PLANT, name="P", peak_power_kwp=20.0))
        s.flush()
        s.add(GrowattInverter(device_sn=SN_A, plant_id=PLANT))
        s.flush()
        # yesterday: string 4 produced
        s.add(GrowattStringReading(device_sn=SN_A, timestamp=day - timedelta(hours=14), string_no=4, mppt_no=2,
                                   voltage_v=600, current_a=5.0, power_w=3000))
        for m in range(0, 60, 5):
            ts = day + timedelta(hours=10, minutes=m)
            s.add(GrowattInverterReading(device_sn=SN_A, timestamp=ts, pac_w=9000, ppv_w=9200, eac_today_kwh=1.0))
            for no, mppt, cur in ((1, 1, 5.0), (2, 1, 5.0), (3, 2, 0.0), (4, 2, 0.0), (5, 3, 5.0)):
                s.add(GrowattStringReading(device_sn=SN_A, timestamp=ts, string_no=no, mppt_no=mppt,
                                           voltage_v=600, current_a=cur, power_w=600 * cur))
        s.commit()

    with Session() as s:
        ov = build_plant_overview(s, PLANT)

    inactive = {x["string_no"]: x for x in ov["inactive_strings"]}
    assert set(inactive) == {3, 6}  # slots 1..2 x highest MPPT (3)
    assert inactive[3]["reason"] == "no_current" and inactive[3]["mppt_no"] == 2 and inactive[3]["v_max"] == 600
    assert inactive[6]["reason"] == "no_data" and inactive[6]["v_max"] is None
    assert all(x["status"] == "Not Active" for x in inactive.values())

    strings = {x["string_no"]: x for x in ov["strings"]}
    assert set(strings) == {1, 2, 4, 5}
    assert strings[4]["status"] == "Critical"
    assert any(a["string_no"] == 4 and a["category"] == "Open String Fault" for a in ov["anomalies"])
    assert ov["kpis"]["inactive_strings"] == 2 and ov["kpis"]["string_count"] == 4


class _FakeAlarmClient(GrowattClient):
    """Answers device/max/alarm_data: INVA has 3 alarms over two pages, INVB fails, INVC none."""

    def __init__(self):
        self.calls, self.dates = [], []

    def _request(self, method, path, params):
        assert method == "POST" and path == "device/max/alarm_data"
        self.calls.append((params["max_sn"], params["page"]))
        self.dates.append((params["max_sn"], params["date"]))
        if params["max_sn"] == SN_B:
            raise GrowattAPIError("device offline", error_code=10001)
        if params["max_sn"] == "INVC" or params["date"] != "2026-11-10":
            return {"alarms": [], "count": 0}
        rows = [
            {"start_time": f"2026-11-10 0{h}:00:00", "end_time": f"2026-11-10 0{h}:05:00", "alarm_code": 200 + h,
             "alarm_message": "PV Circuit short", "fault_type": "Warning", "status": 1}
            for h in (6, 9, 7)
        ]
        per = 2  # force a second page regardless of perpage
        page = rows[(params["page"] - 1) * per: params["page"] * per]
        return {"alarms": page, "count": len(rows), "max_sn": params["max_sn"]}


def test_live_alarms_route_merges_pages_newest_first_and_caches_past_day(client):
    from datetime import date as _d, datetime as _dt

    fake, clock = _FakeAlarmClient(), [0.0]
    svc = GrowattLiveService(
        client_factory=lambda phase: fake, ttl_s=60, clock=lambda: clock[0],
        now_local=lambda: _dt(2026, 11, 12, 12, 0),
    )
    client.app_ref.dependency_overrides[get_live_service] = lambda: svc
    before = client.get("/api/growatt/plants").json()

    q = {"day": "2026-11-10", "days": 1}
    r = client.get(f"/api/growatt/live/plants/{PLANT}/alarms", params=q)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live" and body["data"]["from"] == body["data"]["to"] == "2026-11-10"
    alarms = body["data"]["alarms"]
    assert [a["alarm_code"] for a in alarms] == [209, 207, 206]  # both pages, newest first
    assert all(a["device_sn"] == SN_A for a in alarms)
    assert body["data"]["errors"].keys() == {f"{SN_B} 2026-11-10"}
    assert body["refresh_in_s"] >= 60  # INVB is cooling down; past days stay cached far longer
    assert client.get("/api/growatt/plants").json() == before  # nothing written

    n = len(fake.calls)
    clock[0] = 3600.0  # past day: still cached for INVA / INVC
    client.get(f"/api/growatt/live/plants/{PLANT}/alarms", params=q)
    assert [c for c in fake.calls[n:] if c[0] != SN_B] == []

    # Default window: 7 days ending today, one call per inverter-day.
    fake.dates.clear()
    w = client.get(f"/api/growatt/live/plants/{PLANT}/alarms", params={"day": "2026-11-12"}).json()["data"]
    assert (w["from"], w["to"]) == ("2026-11-06", "2026-11-12")
    asked = {(sn, d) for sn, d in fake.dates if sn != SN_B}
    assert len(asked) == 2 * 6  # INVA + INVC, 6 new days (2026-11-10 still cached)
    assert [a["alarm_code"] for a in w["alarms"]] == [209, 207, 206]
    assert client.get(f"/api/growatt/live/plants/{PLANT}/alarms", params={"days": 40}).status_code == 422
