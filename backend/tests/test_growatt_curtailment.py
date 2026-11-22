"""Curtailment estimate per slot (services/growatt_curtailment.py): pure function, no DB."""
from types import SimpleNamespace
from typing import Optional

from app.services import growatt_curtailment as gc


def _row(hhmm, pac, g: Optional[float] = 800.0, imp=None, exp=None, inverters=2, tmod: Optional[float] = 25.0):
    return {
        "timestamp": f"2026-11-20 {hhmm}:00",
        "pac_kw": pac,
        "irradiance_wm2": g,
        "module_temp_c": tmod,
        "grid_import_kw": imp,
        "grid_export_kw": exp,
        "inverters": inverters,
    }


KW = dict(kwp=100.0, rated_ac_kw=100.0, limit_kw=None, gamma_pct=0.0, factor=1.0, inverter_count=2)


def test_zero_export_run_is_curtailed_and_integrated():
    # available = 100 kWp × 0.8 = 80 kW; PV held at 50 kW while the meter reads ~0
    rows = [_row("10:00", 50, imp=0.5, exp=0.0), _row("10:05", 50, imp=1.0, exp=0.0), _row("10:10", 78, imp=20.0, exp=0.0)]
    s = gc.annotate(rows, **KW)
    assert [r["available_kw"] for r in rows] == [80.0, 80.0, 80.0]
    assert [r["curtailed_kw"] for r in rows] == [30.0, 30.0, 0.0]
    assert [r["curtailed_by"] for r in rows] == ["export_limit", "export_limit", None]
    assert s["kwh"] == 5.0  # 2 slots × 30 kW × 5 min
    assert s["slots"] == 2 and s["judged_slots"] == 3
    assert s["by"] == {"export_limit": 5.0}
    assert gc.per_day(rows) == {"2026-11-20": 5.0}


def test_low_pv_with_grid_import_is_not_curtailment():
    # PV well below the model but the site still buys from the grid: under-performance, not curtailment
    rows = [_row("10:00", 40, imp=60.0, exp=0.0), _row("10:05", 40, imp=60.0, exp=0.0)]
    s = gc.annotate(rows, **KW)
    assert [r["curtailed_kw"] for r in rows] == [0.0, 0.0]
    assert s["kwh"] == 0.0


def test_a_single_slot_is_not_a_run():
    rows = [_row("10:00", 78, imp=20.0, exp=0.0), _row("10:05", 50, imp=0.0, exp=0.0), _row("10:10", 78, imp=20.0, exp=0.0)]
    s = gc.annotate(rows, **KW)
    assert s["slots"] == 0 and rows[1]["curtailed_kw"] == 0.0


def test_power_limit_setting_without_meter():
    lim = dict(KW, limit_kw=60.0)
    rows = [_row("12:00", 59.5), _row("12:05", 59.4)]
    s = gc.annotate(rows, **lim)
    assert [r["curtailed_by"] for r in rows] == ["power_limit", "power_limit"]
    assert rows[0]["curtailed_kw"] == 20.5
    assert s["by"] == {"power_limit": round((20.5 + 20.6) * 5 / 60, 1)}


def test_not_judged_slots_stay_null():
    rows = [
        _row("06:30", 5, g=120.0, imp=0.0, exp=0.0),  # low irradiance: modelled, not judged
        _row("10:00", 50, g=None, imp=0.0, exp=0.0),  # no sensor reading
        _row("10:05", 30, imp=0.0, exp=0.0, inverters=1),  # partial sum over fewer inverters
        _row("10:10", None, imp=0.0, exp=0.0),  # no inverter record
    ]
    s = gc.annotate(rows, **KW)
    assert rows[0]["available_kw"] == 12.0 and rows[0]["curtailed_kw"] is None
    assert all(r["curtailed_kw"] is None for r in rows)
    assert s["kwh"] is None and s["reason"] == "no_sensor_slots"
    assert gc.per_day(rows) == {"2026-11-20": None}


def test_rated_ac_caps_available_and_no_capacity_is_null():
    rows = [_row("12:00", 70, g=1000.0, imp=0.0, exp=0.0), _row("12:05", 70, g=1000.0, imp=0.0, exp=0.0)]
    gc.annotate(rows, **dict(KW, rated_ac_kw=75.0))
    assert rows[0]["available_kw"] == 75.0 and rows[0]["curtailed_kw"] == 0.0  # 5 kW < 15 % of 75
    s = gc.annotate(rows, **dict(KW, kwp=None))
    assert rows[0]["available_kw"] is None and s["kwh"] is None and s["reason"] == "no_capacity"


def test_stale_slots_and_temperature_fallback():
    rows = [_row("10:00", 50, imp=0.0, exp=0.0, tmod=None), _row("10:05", 50, imp=0.0, exp=0.0, tmod=None)]
    s = gc.annotate(rows, **dict(KW, gamma_pct=-0.4), tmod_fallback={"2026-11-20": 50.0})
    assert rows[0]["available_kw"] == 72.0  # 80 × (1 − 0.004 × 25)
    assert s["slots"] == 2
    s = gc.annotate(rows, **KW, stale={"2026-11-20 10:00:00"}, tmod_fallback={"2026-11-20": 25.0})
    assert rows[0]["curtailed_kw"] is None and s["slots"] == 0


def test_plant_limit_needs_every_nameplate_and_one_limited_inverter():
    inv = lambda w, pct: SimpleNamespace(nominal_power_w=w, active_limit_pct=pct)  # noqa: E731
    assert gc.plant_limit_kw([inv(100_000, 60), inv(50_000, None)]) == 110.0
    assert gc.plant_limit_kw([inv(100_000, 100), inv(50_000, None)]) is None
    assert gc.plant_limit_kw([inv(None, 60)]) is None
    assert gc.plant_limit_kw([]) is None
