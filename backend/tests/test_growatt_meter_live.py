"""Live energy meter (`meter_last_data`, memory only): grid import / export now and the derived load."""

from __future__ import annotations

from datetime import datetime

from app.db.models import GrowattMeter
from app.db.session import get_db
from app.services.growatt_live import GrowattLiveService, LiveUnavailable, get_live_service
from app.services.growatt_meter import live_load
from solar_core.growatt import GrowattAPIError
from tests.test_growatt_routes import PLANT, client  # noqa: F401  (fixture)

DL, ADDR = "DLMETER1", 36
NOW = datetime(2026, 11, 15, 10, 7)


class _Meter:
    """Fake client: `meter_last_data` answering `power` W, or raising when `power` is an exception."""

    def __init__(self, power=3000, ts="2026-11-15 10:05:00"):
        self.power, self.ts, self.calls = power, ts, []

    def meter_latest(self, datalogger_sn, address):
        self.calls.append((datalogger_sn, address))
        if isinstance(self.power, Exception):
            raise self.power
        return {"timeText": self.ts, "activePower": self.power, "activePowerL1": 1000, "posiActivePower": 2660470, "lost": False}


def _svc(fake, **kw):
    return GrowattLiveService(client_factory=lambda phase: fake, clock=lambda: 1000.0, now_local=lambda: NOW, **kw)  # type: ignore[arg-type,return-value]


def _inv(sn, ts, pac):
    return {"device_sn": sn, "timestamp": ts, "pac_w": pac}


def test_plant_meter_signs_sums_and_caches():
    fake = _Meter(power=-2500)
    svc = _svc(fake)
    env = svc.plant_meter(PLANT, [(DL, ADDR)])
    g = env["data"]["grid"]
    assert (g["grid_power_kw"], g["grid_import_kw"], g["grid_export_kw"]) == (-2.5, 0.0, 2.5)
    assert g["timestamp"] == "2026-11-15 10:05:00"
    m = env["data"]["meters"][0]
    assert m["active_power_w"] == -2500.0 and m["import_counter_kwh"] == 2660470.0 and m["lost"] is False
    assert env["source"] == "live" and env["refresh_in_s"] >= 15
    svc.plant_meter(PLANT, [(DL, ADDR)])
    assert len(fake.calls) == 1  # served from memory until the next record is due


def test_plant_meter_partial_sum_is_null_and_failure_is_unavailable():
    class _Two(_Meter):
        def meter_latest(self, datalogger_sn, address):
            return None if address == 2 else super().meter_latest(datalogger_sn, address)

    env = _svc(_Two()).plant_meter(PLANT, [(DL, ADDR), (DL, 2)])
    assert len(env["data"]["meters"]) == 1
    assert env["data"]["grid"]["grid_import_kw"] is None  # one meter without a record: never a partial sum

    try:
        _svc(_Meter(power=GrowattAPIError("rate limited", error_code=10012))).plant_meter(PLANT, [(DL, ADDR)])
    except LiveUnavailable:
        pass
    else:
        raise AssertionError("expected LiveUnavailable")


def test_live_load_rules():
    grid = {"timestamp": "2026-11-15 10:05:00", "grid_power_kw": 3.0}
    sns = ["A", "B", "C"]
    # A producing near the meter's time, B shut down earlier at 0 W, C no record today (off)
    r = live_load(grid, sns, [_inv("A", "2026-11-15 10:04:10", 10000), _inv("B", "2026-11-15 06:00:00", 0)], {})
    assert (r["pv_kw"], r["load_kw"], r["reason"]) == (10.0, 13.0, None)
    # B silent for hours while producing: PV unknown, so load null
    r = live_load(grid, sns, [_inv("A", "2026-11-15 10:04:10", 10000), _inv("B", "2026-11-15 08:00:00", 5000)], {})
    assert r["load_kw"] is None and "1 of 3" in r["reason"]
    # C failed to read: unknown, not 0
    r = live_load(grid, sns, [_inv("A", "2026-11-15 10:04:10", 10000)], {"C": "rate limited"})
    assert r["load_kw"] is None
    # export above PV: inconsistent, never a negative load
    r = live_load({**grid, "grid_power_kw": -20.0}, ["A"], [_inv("A", "2026-11-15 10:05:00", 10000)], {})
    assert r["load_kw"] is None and r["pv_kw"] == 10.0
    assert live_load({"timestamp": None, "grid_power_kw": None}, ["A"], [], {})["reason"] == "no complete meter record"


def test_live_meter_route(client):  # noqa: F811
    s = next(client.app_ref.dependency_overrides[get_db]())
    assert client.get(f"/api/growatt/live/plants/{PLANT}/meter").status_code == 404  # no meter registered
    s.add(GrowattMeter(datalogger_sn=DL, address=ADDR, plant_id=PLANT, device_name="CHNT_THREE"))
    s.commit()

    class _Svc(GrowattLiveService):
        def plant_latest(self, plant_id, device_sns, day, phase=None, coords=None):
            recs = [_inv(sn, "2026-11-15 10:04:00", 2000) for sn in device_sns]
            return {"source": "live", "refresh_in_s": 20, "stale": False, "error": None, "fetched_at": "", "data": {"inverters": recs, "errors": {}}}

    fake = _Meter(power=3000)
    client.app_ref.dependency_overrides[get_live_service] = lambda: _Svc(client_factory=lambda p: fake, clock=lambda: 1000.0, now_local=lambda: NOW)  # type: ignore[arg-type]
    body = client.get(f"/api/growatt/live/plants/{PLANT}/meter").json()
    assert body["data"]["grid"]["grid_import_kw"] == 3.0
    load = body["data"]["load"]
    assert load["derived"] is True and load["pv_kw"] == 6.0 and load["load_kw"] == 9.0  # 3 inverters × 2 kW + 3 kW
    assert body["refresh_in_s"] == 20  # the earlier of meter and inverter cache

    body = client.get(f"/api/growatt/live/plants/{PLANT}/meter", params={"load": "false"}).json()
    assert "load" not in body["data"]
