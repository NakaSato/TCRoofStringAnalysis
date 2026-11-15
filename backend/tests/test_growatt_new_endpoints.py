"""Endpoints found by the probe (docs/plans/growatt-new-endpoints.md): Growatt's own daily energy and
plant curve (finished days only), plant details / inverter model in the registry, and the
`maxs_data` fleet snapshot (memory only)."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    Base,
    GrowattInverter,
    GrowattInverterEnergyDay,
    GrowattPlant,
    GrowattPlantEnergyDay,
    GrowattPlantPower,
)
from app.db.session import build_engine
from app.services import growatt_energy, growatt_sync
from app.services.growatt_live import GrowattLiveService
from solar_core.growatt import GrowattAPIError, GrowattClient

from tests.test_growatt_routes import client  # noqa: F401  (fixture)

TODAY = date(2026, 11, 15)


class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _client(get=None, post=None) -> GrowattClient:
    c = GrowattClient(token="t")
    if get:
        c.session.get = get  # type: ignore[method-assign]
    if post:
        c.session.post = post  # type: ignore[method-assign]
    return c


# --------------------------------------------------------------------------- client parsing (real replies, trimmed)


def test_client_parses_energy_power_details_and_model():
    replies = {
        "plant/energy": {"error_code": 0, "data": {"energys": [{"date": "2026-11-13", "energy": "1319.9"}, {"date": "2026-11-14", "energy": ""}], "count": 2}},
        "plant/power": {"error_code": 0, "data": {"count": 4, "powers": [
            {"time": "2026-11-14 08:05", "power": 96193.6015625}, {"time": "2026-11-14 01:55", "power": 0},
            {"time": "2026-11-14 18:50", "power": None}, {"time": "2026-11-14 07:30", "power": 49547.8984375},
        ]}},
        "device/inverter/day_energy": {"error_code": 0, "data": 189.60000610351562, "device_sn": "EPHNEYN00Q"},
        "plant/details": {"error_code": 0, "data": {
            "timezone": "GMT+7", "address1": "214", "address2": "", "maxs": [{"max_num": 3}],
            "dataloggers": [{"datalogger_num": 1}], "installed_dc_capacity": "",
        }},
    }
    seen = []

    def get(url, params=None, timeout=None):
        path = url.split("/v1/", 1)[1]
        seen.append((path, params))
        return _Resp(replies[path])

    def post(url, params=None, timeout=None, **kw):
        assert url.endswith("new-api/queryDeviceInfoParam") and params == {"deviceSn": "S", "deviceType": "max"}
        return _Resp({"code": 0, "data": {"deviceModel": "MAX 80KTL3 LV", "dataloggerModel": "ShineMaster", "norminalPower": 80000}})

    c = _client(get, post)
    assert c.plant_energy_days(1, date(2026, 11, 13), date(2026, 11, 14)) == [(date(2026, 11, 13), 1319.9), (date(2026, 11, 14), None)]
    pts: Any = c.plant_power_day(1, date(2026, 11, 14))
    assert [t.strftime("%H:%M") for t, _ in pts] == ["01:55", "07:30", "08:05"]  # null slot left out, sorted
    assert pts[0][1] == 0.0
    assert c.inverter_day_energy("EPHNEYN00Q", date(2026, 11, 14)) == 189.60000610351562
    assert c.plant_details(1) == {"timezone": "GMT+7", "address": "214", "growatt_inverter_count": 3, "growatt_datalogger_count": 1}
    assert c.device_info_param("S") == {"device_model": "MAX 80KTL3 LV", "datalogger_model": "ShineMaster", "rated_power_w": 80000.0}
    assert ("plant/energy", {"plant_id": 1, "start_date": "2026-11-13", "end_date": "2026-11-14", "time_unit": "day", "page": 1, "perpage": 100}) in seen
    try:
        c.plant_energy_days(1, date(2026, 10, 1), date(2026, 11, 14))
    except ValueError:
        pass
    else:
        raise AssertionError("over 31 days must be refused")


def test_maxs_latest_pages_and_keeps_datalogger():
    calls = []

    def post(url, data: Any = None, timeout=None, **kw):
        calls.append(data)
        page = data["pageNum"]
        sns = data["maxs"].split(",")
        chunk = sns[(page - 1) * 50 : page * 50]
        return _Resp({"error_code": 0, "data": {sn: {"dataloggerSn": "DL", sn: {"time": "2026-11-15 13:31:04", "pac": 1}} for sn in chunk}})

    c = _client(post=post)
    sns = [f"S{i:03}" for i in range(60)]
    out = c.maxs_latest(sns)
    assert len(out) == 60 and len(calls) == 2  # 50 per page
    assert out["S000"]["dataloggerSn"] == "DL" and out["S000"]["pac"] == 1


# --------------------------------------------------------------------------- energy sweep


class _EnergyAcct:
    def __init__(self):
        self.calls: list = []
        self.fail: dict = {}

    def _call(self, key):
        self.calls.append(key)
        if key in self.fail:
            raise self.fail[key]

    def plant_energy_days(self, pid, start, end):
        self._call(("energy", pid))
        out, d = [], start
        while d <= end:
            out.append((d, 100.0 + d.day))
            d += timedelta(days=1)
        out.append((TODAY, 5.0))  # Growatt also lists today: realtime, must not be stored
        return out

    def plant_power_day(self, pid, day):
        self._call(("power", pid, day))
        lo = datetime.combine(day, datetime.min.time())
        return [(lo + timedelta(hours=8), 1000.0), (lo + timedelta(hours=12), 3000.0)]

    def inverter_day_energy(self, sn, day):
        self._call(("inv", sn, day))
        return 50.0


def _db(tmp_path) -> Any:
    engine = build_engine(f"sqlite:///{tmp_path / 'e.db'}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    db.add_all([GrowattPlant(plant_id=1, name="P1", phase=1), GrowattPlant(plant_id=2, name="P2", phase=2)])
    db.add_all([GrowattInverter(device_sn=sn, plant_id=pid) for sn, pid in (("A", 1), ("B", 1), ("Z", 2))])
    db.commit()
    return db


def test_energy_sweep_stores_finished_days_and_skips_stored(tmp_path):
    db = _db(tmp_path)
    acct = _EnergyAcct()
    out = growatt_energy.sync_growatt_energy(db, acct, TODAY, phase=1, curve_days=2, pause_s=0)  # type: ignore[arg-type]
    assert out["failed"] == [] and out["plant_energy_days"] == 7
    days = list(db.scalars(select(GrowattPlantEnergyDay.day).where(GrowattPlantEnergyDay.plant_id == 1).order_by(GrowattPlantEnergyDay.day)))
    assert days[0] == TODAY - timedelta(days=7) and days[-1] == TODAY - timedelta(days=1)  # never today
    assert db.scalar(select(GrowattPlantEnergyDay).where(GrowattPlantEnergyDay.plant_id == 2)) is None  # phase 2's plant
    assert out["plant_power_days"] == 2 and out["plant_power_points"] == 4
    assert out["inverter_energy_days"] == 4  # A, B × 2 days
    assert db.get(GrowattInverterEnergyDay, ("A", TODAY - timedelta(days=1))).energy_kwh == 50.0

    acct.calls.clear()
    growatt_energy.sync_growatt_energy(db, acct, TODAY, phase=1, curve_days=2, pause_s=0)  # type: ignore[arg-type]
    assert acct.calls == [("energy", 1)]  # curves and inverter days stored: only the energy re-read


def test_energy_sweep_stops_after_rate_limits_and_resumes(tmp_path):
    db = _db(tmp_path)
    acct = _EnergyAcct()
    y = TODAY - timedelta(days=1)
    limited = GrowattAPIError("frequently access", error_code=10012)
    acct.fail = {("power", 1, y): limited, ("inv", "A", y): limited, ("inv", "B", y): limited}
    out = growatt_energy.sync_growatt_energy(db, acct, TODAY, phase=1, curve_days=1, pause_s=0)  # type: ignore[arg-type]
    assert out["failed"] and out["errors"] == {"10012": 3}
    acct.fail.clear()
    acct.calls.clear()
    out = growatt_energy.sync_growatt_energy(db, acct, TODAY, phase=1, curve_days=1, pause_s=0)  # type: ignore[arg-type]
    assert out["failed"] == [] and ("power", 1, y) in acct.calls and ("inv", "B", y) in acct.calls


def test_plant_power_api_shows_growatt_figures(tmp_path):
    from app.services.growatt_overview import build_plant_power

    db = _db(tmp_path)
    y = TODAY - timedelta(days=1)
    db.add(GrowattPlantEnergyDay(plant_id=1, day=y, energy_kwh=1319.9))
    db.add_all([GrowattInverterEnergyDay(device_sn=sn, day=y, plant_id=1, energy_kwh=600.0) for sn in ("A", "B")])
    db.add(GrowattPlantPower(plant_id=1, timestamp=datetime.combine(y, datetime.min.time()) + timedelta(hours=8, minutes=5), power_w=96193.6))
    db.commit()
    out = build_plant_power(db, 1, y)
    assert out["growatt_timeseries"] == [{"timestamp": f"{y} 08:05:00", "pac_kw": 96.19}]
    d = out["daily"][0]
    assert d["growatt_energy_kwh"] == 1319.9 and d["growatt_inverters_kwh"] == 1200.0 and d["growatt_inverters_reported"] == 2
    assert d["energy_kwh"] is None  # no stored records: our figure stays unknown, never Growatt's
    assert build_plant_power(db, 1, y, start_time=datetime.min.time().replace(hour=9))["growatt_timeseries"] == []
    only = build_plant_power(db, 1, y, include_records=False)  # a page holding the day's overview
    assert only["timeseries"] == [] and only["growatt_timeseries"] == out["growatt_timeseries"]
    assert only["daily"][0]["growatt_energy_kwh"] == 1319.9


def test_retention_prunes_old_growatt_curve(tmp_path):
    db = _db(tmp_path)
    old = datetime.combine(TODAY - timedelta(days=100), datetime.min.time())
    db.add_all([GrowattPlantPower(plant_id=1, timestamp=old, power_w=1.0), GrowattPlantPower(plant_id=1, timestamp=datetime.combine(TODAY, datetime.min.time()), power_w=2.0)])
    db.commit()
    assert growatt_energy.prune_plant_power(db, TODAY, 90) == 1


# --------------------------------------------------------------------------- registry


class _RegistryAcct:
    def __init__(self):
        self.calls: list = []

    def plant_details(self, pid):
        self.calls.append(("details", pid))
        return {"timezone": "GMT+7", "address": None, "growatt_inverter_count": 2, "growatt_datalogger_count": 1}

    def device_info_param(self, sn):
        self.calls.append(("param", sn))
        if sn == "B":
            raise GrowattAPIError("DEVICE_OFFLINE", error_code=5)
        return {"device_model": "MAX 80KTL3 LV", "datalogger_model": "ShineMaster", "rated_power_w": 80000.0}


def test_registry_sweeps_fill_details_and_model_then_wait(tmp_path):
    db = _db(tmp_path)
    p1 = db.get(GrowattPlant, 1)
    p1.address = "kept"
    db.commit()
    acct = _RegistryAcct()
    now = datetime.now().astimezone()
    assert growatt_sync._sync_plant_details(db, acct, [1], now, pause_s=0) == 1  # type: ignore[arg-type]
    assert growatt_sync._sync_device_params(db, acct, [1], now, pause_s=0) == 1  # type: ignore[arg-type]
    p1 = db.get(GrowattPlant, 1)
    assert p1.timezone == "GMT+7" and p1.growatt_inverter_count == 2 and p1.address == "kept"  # blank never erases
    a, b = db.get(GrowattInverter, "A"), db.get(GrowattInverter, "B")
    assert a.device_model == "MAX 80KTL3 LV" and a.rated_power_w == 80000.0 and a.param_synced_at is not None
    assert b.device_model is None and b.param_synced_at is None  # refused: asked again next run
    acct.calls.clear()
    growatt_sync._sync_plant_details(db, acct, [1], now, pause_s=0)  # type: ignore[arg-type]
    growatt_sync._sync_device_params(db, acct, [1], now, pause_s=0)  # type: ignore[arg-type]
    assert acct.calls == [("param", "B")]

    from app.services.growatt_common import inverter_out

    o = inverter_out(a)
    assert (o["device_model"], o["datalogger_model"], o["rated_power_kw"]) == ("MAX 80KTL3 LV", "ShineMaster", 80.0)


# --------------------------------------------------------------------------- live snapshot (memory only)


class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class _MaxsAcct:
    def __init__(self, records):
        self.records = records
        self.calls: list = []
        self.fail: Any = None

    def maxs_latest(self, sns):
        self.calls.append(list(sns))
        if self.fail:
            raise self.fail
        return {sn: self.records[sn] for sn in sns if sn in self.records}


def _rec(t, eac=10.0):
    return {"time": t, "status": 1, "statusText": "Normal", "pac": 5000, "ppv": 5200.5, "eacToday": eac, "temperature": 41.2,
            "faultType": 0, "warnCode": 0, "lost": False, "dataloggerSn": "DL1"}


def test_snapshot_chunks_per_account_and_keeps_record_time():
    sns1 = [f"A{i:03}" for i in range(120)]
    records = {sn: _rec("2026-11-15 13:31:04") for sn in sns1}
    records["A000"] = _rec("2025-06-24 14:38:12", eac=99.0)  # silent since June 2025
    fake, clock = _MaxsAcct(records), _Clock()
    svc = GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=clock, phases=(1, 2), now_local=lambda: datetime(2026, 11, 15, 13, 35), snapshot_sweep=2,
    )
    invs = [(sn, 1) for sn in sns1] + [("Z001", 2)]
    env = svc.inverter_snapshot(invs)
    assert len(fake.calls) == 2 and all(len(c) <= 50 for c in fake.calls)  # 2 chunks per request
    assert env["refresh_in_s"] == 15 and env["data"]["sweep"]["total"] == 4  # 3 chunks phase 1 + 1 phase 2
    clock.t += 15
    env = svc.inverter_snapshot(invs)
    assert len(fake.calls) == 4 and len(env["data"]["inverters"]) == 120  # Z001 not answered: absent, not invented
    old = env["data"]["inverters"]["A000"]
    assert old["record_time"] == "2025-06-24 14:38:12" and old["eac_today_kwh"] is None  # its own time, not today
    cur = env["data"]["inverters"]["A001"]
    assert (cur["pac_w"], cur["ppv_w"], cur["eac_today_kwh"], cur["status_label"], cur["datalogger_sn"]) == (5000.0, 5200.5, 10.0, "Normal", "DL1")
    svc.inverter_snapshot(invs)
    assert len(fake.calls) == 4  # all fresh: memory only

    # an engineer's subset sweeps only the chunks holding their inverters
    fake.calls.clear()
    svc2 = GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=clock, phases=(1, 2), now_local=lambda: datetime(2026, 11, 15, 13, 35),
    )
    env = svc2.inverter_snapshot(invs, wanted={"A060"})
    assert len(fake.calls) == 1 and "A060" in fake.calls[0] and set(env["data"]["inverters"]) == {"A060"}


def test_snapshot_rate_limited_chunk_is_reported():
    fake, clock = _MaxsAcct({"A": _rec("2026-11-15 13:31:04")}), _Clock()
    fake.fail = GrowattAPIError("frequently access", error_code=10012)
    svc = GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=clock, phases=(1,), now_local=lambda: datetime(2026, 11, 15, 13, 35),
    )
    env = svc.inverter_snapshot([("A", 1)])
    assert env["data"]["inverters"] == {} and len(env["data"]["errors"]) == 1
    assert next(iter(env["data"]["errors"])).startswith("p1#1:")


def test_new_jobs_registered_and_energy_scheduled():
    from datetime import time as dtime

    from app import worker
    from app.services import jobs

    assert {"growatt_energy", "energy_backfill"} <= set(jobs.JOBS)
    at = [s.at for s in worker.default_schedule() if s.job == "growatt_energy"]
    assert at == [dtime(0, 50)]
    assert not [s for s in worker.default_schedule() if s.job == "energy_backfill"]


def test_snapshot_account_without_token_fails_only_its_chunks():
    fake, clock = _MaxsAcct({"A": _rec("2026-11-15 13:31:04")}), _Clock()
    svc = GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=clock, phases=(1,), now_local=lambda: datetime(2026, 11, 15, 13, 35),
    )
    env = svc.inverter_snapshot([("A", None), ("Q", 4)])  # untagged → phase 1; phase 4 has no token
    assert set(env["data"]["inverters"]) == {"A"}
    assert [k.split(":")[0] for k in env["data"]["errors"]] == ["p4#1"]


def test_snapshot_route_scopes_to_user_and_writes_nothing(client):  # noqa: F811
    from app.services.growatt_live import get_live_service
    from tests.test_growatt_routes import PLANT, SN_A

    fake, clock = _MaxsAcct({SN_A: _rec("2026-11-15 13:31:04")}), _Clock()
    svc = GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=clock, phases=(1,), now_local=lambda: datetime(2026, 11, 15, 13, 35),
    )
    client.app_ref.dependency_overrides[get_live_service] = lambda: svc
    before = client.get("/api/growatt/plants").json()
    env = client.get("/api/growatt/live/inverters/snapshot").json()
    assert env["source"] == "live" and env["data"]["inverters"][SN_A]["plant_id"] == PLANT
    assert client.get(f"/api/growatt/live/inverters/snapshot?plant_id={PLANT}").status_code == 200
    assert client.get("/api/growatt/plants").json() == before  # realtime values never reach the DB

    tok = client.post("/api/auth/login", json={"username": "engineer", "password": "engineer123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    env = client.get("/api/growatt/live/inverters/snapshot", headers=h).json()
    assert env["data"]["inverters"] == {} and env["data"]["sweep"]["total"] == 0  # no plants assigned
    assert client.get(f"/api/growatt/live/inverters/snapshot?plant_id={PLANT}", headers=h).status_code == 404


def test_implausible_growatt_day_figure_is_withheld(tmp_path):
    from app.services.growatt_overview import build_plant_power

    db = _db(tmp_path)
    db.get(GrowattPlant, 1).peak_power_kwp = 645.8
    y = TODAY - timedelta(days=1)
    # real glitch (plant 10004563, 13 Nov 2026): 46,027 kWh from 645.8 kWp
    db.add(GrowattPlantEnergyDay(plant_id=1, day=y, energy_kwh=46027.5))
    db.add(GrowattPlantEnergyDay(plant_id=1, day=y - timedelta(days=1), energy_kwh=2092.0))
    db.commit()
    out = build_plant_power(db, 1, y - timedelta(days=1), end_day=y)
    a, b = out["daily"]
    assert a["growatt_energy_kwh"] == 2092.0 and a["growatt_implausible"] is False
    assert b["growatt_energy_kwh"] is None and b["growatt_implausible"] is True
