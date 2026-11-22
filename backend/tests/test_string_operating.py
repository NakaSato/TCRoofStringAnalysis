"""Live string operating points on the modelled curve (memory only, no network)."""

from __future__ import annotations

from datetime import datetime

import pytest

from app.db.models import GrowattStringLayout
from app.db.session import get_db
from app.services import growatt_weather as wx
from app.services import string_operating
from app.services.growatt_live import GrowattLiveService, get_live_service
from solar_core.iv_analysis import ModuleStcSpec
from solar_core.iv_operating import judge_point, string_curve_at
from tests.test_growatt_routes import PLANT, SN_A, SN_B, client  # noqa: F401  (fixture)

NOW = datetime(2026, 11, 15, 12, 7)
GATES = string_operating.criteria()["gates"]


def test_curve_matches_the_datasheet_at_stc_and_scales_with_conditions():
    spec = ModuleStcSpec()
    c = string_curve_at(spec, 18, 1000, 25)
    assert c is not None
    assert c["p_mp_w"] == pytest.approx(18 * spec.wp, rel=0.01)
    assert c["v_oc_v"] == pytest.approx(18 * spec.voc_stc, rel=0.01)
    assert c["i_sc_a"] == pytest.approx(spec.isc_stc, rel=0.01)
    assert c["v_mp_v"] == pytest.approx(18 * spec.vmp_stc, rel=0.01)
    hot = string_curve_at(spec, 18, 800, 58)
    assert hot is not None and hot["i_sc_a"] == pytest.approx(0.8 * spec.isc_stc, rel=0.03)
    assert hot["v_oc_v"] < c["v_oc_v"] and hot["p_mp_w"] < 0.8 * c["p_mp_w"]
    # the curve is drawn from 0 V to Voc, current falling to 0
    assert c["points"][0]["v"] == 0 and c["points"][-1]["i"] == pytest.approx(0, abs=0.05)
    assert string_curve_at(spec, 0, 800, 50) is None and string_curve_at(spec, 18, 0, 50) is None


def test_gates():
    curve = string_curve_at(ModuleStcSpec(), 18, 800, 55)
    assert curve is not None
    ok = judge_point(curve["v_mp_v"], curve["i_mp_a"] * 0.95, curve, 800, GATES, inverter_status=1, record_age_s=60, weather_gap_s=60)
    assert ok["diagnostic"] and ok["gates"] == [] and ok["r_imp"] == pytest.approx(0.95, abs=0.002) and ok["r_v"] == pytest.approx(1.0, abs=0.002)
    # zero export: the MPPT walked towards Voc, which looks like low current
    off = judge_point(curve["v_oc_v"] * 0.97, 1.0, curve, 800, GATES, inverter_status=1)
    assert "off_mpp" in off["gates"] and not off["diagnostic"]
    assert "low_irradiance" in judge_point(700, 4, curve, 300, GATES)["gates"]
    assert "stale" in judge_point(700, 9, curve, 800, GATES, record_age_s=3600)["gates"]
    assert "weather_not_aligned" in judge_point(700, 9, curve, 800, GATES, weather_gap_s=900)["gates"]
    assert "clipped_or_limited" in judge_point(700, 9, curve, 800, GATES, limited=True)["gates"]
    assert "out_of_range" in judge_point(700, 40, curve, 800, GATES)["gates"]
    # no curve: no ratios, never a made-up one
    none = judge_point(700, 9, None, 800, GATES)
    assert none["r_imp"] is None and none["gates"] == ["no_model"]


def _record(sn, currents, v=690.0, status=1, ts="2026-11-15 12:05:00"):
    return {
        "device_sn": sn,
        "timestamp": ts,
        "status": status,
        "pac_w": 20000,
        "stale": False,
        "strings": [
            {"string_no": n, "mppt_no": (n + 1) // 2, "voltage_v": v, "current_a": i, "power_w": v * i} for n, i in enumerate(currents, start=1)
        ],
        "previous_strings": [],
    }


class _Svc(GrowattLiveService):
    weather: dict | None = {"datalogger_sn": "DL", "address": 1, "timestamp": "2026-11-15 12:04:00", "irradiance_wm2": 800.0, "module_temp_c": 55.0, "ambient_temp_c": 33.0, "stale": False}

    def plant_latest(self, plant_id, device_sns, day, phase=None, coords=None):
        recs = [_record(SN_A, [10.5, 10.4, 10.6, 6.0]), _record(SN_B, [10.5, 10.5, 10.4])]
        return {"source": "live", "refresh_in_s": 40, "stale": False, "error": None, "fetched_at": "", "data": {"inverters": recs, "errors": {}}}

    def plant_weather(self, plant_id, sensors, phase=None, coords=None):
        rows = [self.weather] if self.weather else []
        return {"source": "live", "refresh_in_s": 25, "stale": False, "error": None, "fetched_at": "", "data": {"sensors": rows, "errors": {}}}


def _use(client, svc, monkeypatch, sensor=True):  # noqa: F811
    monkeypatch.setattr(wx, "measured_fields", lambda db, plant_id, since: {("DL", 1): None} if sensor else {})
    client.app_ref.dependency_overrides[get_live_service] = lambda: svc


def test_route_places_points_on_the_modelled_curve(client, monkeypatch):  # noqa: F811
    s = next(client.app_ref.dependency_overrides[get_db]())
    s.add_all([GrowattStringLayout(device_sn=SN_A, string_no=n, modules=18) for n in (1, 2, 3, 4)])
    s.commit()
    _use(client, _Svc(client_factory=lambda p: None, now_local=lambda: NOW), monkeypatch)  # type: ignore[arg-type]
    body = client.get(f"/api/growatt/live/plants/{PLANT}/strings/operating").json()
    d = body["data"]
    assert body["source"] == "live" and body["refresh_in_s"] == 25  # the earlier of inverter and sensor cache
    assert d["modelled"] is True and d["weather"]["irradiance_wm2"] == 800.0 and d["weather"]["module_temp_c"] == 55.0
    assert [c["modules"] for c in d["curves"]] == [18]
    by = {(r["device_sn"], r["string_no"]): r for r in d["strings"]}
    a1, a4 = by[(SN_A, 1)], by[(SN_A, 4)]
    assert a1["modules"] == 18 and a1["r_imp"] is not None and a1["diagnostic"] is True
    assert a4["r_i"] is not None and a4["r_i"] < 0.7 and a4["r_imp"] < a1["r_imp"]
    # INVB has no module counts: measured point and peer ratio, but no model and no made-up ratio
    b1 = by[(SN_B, 1)]
    assert b1["modules"] is None and b1["r_imp"] is None and b1["gates"] == ["no_model"]
    assert "String Layout" in b1["model_reason"] and b1["r_i"] is not None


def test_route_without_sensor_or_module_temperature(client, monkeypatch):  # noqa: F811
    s = next(client.app_ref.dependency_overrides[get_db]())
    s.add(GrowattStringLayout(device_sn=SN_A, string_no=1, modules=18))
    s.commit()
    svc = _Svc(client_factory=lambda p: None, now_local=lambda: NOW)  # type: ignore[arg-type]
    _use(client, svc, monkeypatch, sensor=False)
    d = client.get(f"/api/growatt/live/plants/{PLANT}/strings/operating").json()["data"]
    assert d["weather"] is None and "no weather sensor" in d["weather_reason"] and d["curves"] == []

    svc.weather = {**_Svc.weather, "module_temp_c": None}  # type: ignore[dict-item]
    _use(client, svc, monkeypatch)
    d = client.get(f"/api/growatt/live/plants/{PLANT}/strings/operating").json()["data"]
    assert d["weather"] is None and "module temperature" in d["weather_reason"]


def test_route_is_scoped_like_every_plant_route(client):  # noqa: F811
    assert client.get("/api/growatt/live/plants/999999/strings/operating").status_code == 404
