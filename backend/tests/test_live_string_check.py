"""Live string check: one record, strings judged against their own inverter at that moment."""

from app.services.live_string_check import check_inverter, check_plant


def _s(no, i, v=720.0, mppt=None):
    return {"string_no": no, "mppt_no": mppt or (no + 1) // 2, "voltage_v": v, "current_a": i, "power_w": v * i}


def test_current_below_peers_warns_and_open_string_is_critical():
    strings = [_s(1, 8.0), _s(2, 8.2), _s(3, 7.9), _s(4, 6.5), _s(5, 0.1), _s(6, 4.0), _s(7, 8.1), _s(8, 7.8)]
    r = check_inverter("INV", strings, wired=set(range(1, 9)))
    st = {k: v["status"] for k, v in r["strings"].items()}
    assert r["status"] == "ok"
    assert st[1] == st[2] == st[3] == st[7] == st[8] == "Healthy"
    assert st[4] == "Warning"  # about -18 % (median 7.9 A, the open string left out)
    assert st[5] == "Critical" and "open string" in r["strings"][5]["reason"]
    assert st[6] == "Critical"  # about -50 %


def test_shorter_string_is_not_flagged_on_voltage_without_layout():
    """The Nong Bua case: two strings at ~0.73 of the voltage (fewer modules), same current."""
    strings = [_s(n, 8.0) for n in range(1, 8)] + [_s(17, 8.0, v=527.0), _s(19, 8.1, v=539.0)]
    r = check_inverter("INV", strings)
    assert all(v["status"] == "Healthy" for v in r["strings"].values())
    assert r["voltage_basis"] is None


def test_voltage_judged_per_module_with_layout():
    strings = [_s(1, 8.0, 720.0), _s(2, 8.0, 720.0), _s(3, 8.0, 520.0), _s(4, 8.0, 600.0)]
    # strings 1-2: 18 modules, 3: 13 modules (same volts per module), 4: 18 modules but low = fault
    layout = {("INV", 1): (18, None), ("INV", 2): (18, None), ("INV", 3): (13, None), ("INV", 4): (18, None)}
    r = check_inverter("INV", strings, layout)
    st = {k: v["status"] for k, v in r["strings"].items()}
    assert r["voltage_basis"] == "per_module"
    assert st[1] == st[2] == st[3] == "Healthy"
    assert st[4] == "Warning" and "Voltage per module" in r["strings"][4]["reason"]


def test_low_light_and_too_few_strings_give_no_verdict():
    dusk = check_inverter("INV", [_s(n, 0.4) for n in range(1, 7)])
    assert dusk["status"] == "low_light" and all(v["status"] is None for v in dusk["strings"].values())
    two = check_inverter("INV", [_s(1, 8.0), _s(2, 0.0)])
    assert two["status"] == "too_few_strings" and all(v["status"] is None for v in two["strings"].values())


def test_check_plant_summary():
    invs = [
        {"device_sn": "A", "timestamp": "2026-11-13 11:00:00", "strings": [_s(1, 8.0), _s(2, 8.0), _s(3, 8.0), _s(4, 0.0)]},
        {"device_sn": "B", "timestamp": "2026-11-13 11:02:00", "stale": True, "strings": [_s(1, 0.2), _s(2, 0.2), _s(3, 0.2)]},
    ]
    r = check_plant(invs, wired={"A": {1, 2, 3, 4}, "B": {1, 2, 3}})
    assert r["summary"] == {"healthy": 3, "warning": 0, "critical": 1, "unknown": 3, "checked_inverters": 1, "at": "2026-11-13 11:00:00"}
    assert r["inverters"]["B"]["stale"] is True


def test_unwired_inputs_are_left_out_and_unknown_zero_inputs_get_no_verdict():
    strings = [_s(n, 8.0) for n in range(1, 6)] + [_s(n, 0.0) for n in range(6, 9)]
    known = check_inverter("INV", strings, wired={1, 2, 3, 4, 5, 6})
    assert set(known["strings"]) == {1, 2, 3, 4, 5, 6}  # inputs 7, 8 are not wired: not reported
    assert known["strings"][6]["status"] == "Critical"  # wired but 0 A = open string
    unknown = check_inverter("INV", strings)  # wiring unknown
    assert unknown["strings"][6]["status"] is None and "String Layout" in unknown["strings"][6]["reason"]
    assert all(unknown["strings"][n]["status"] == "Healthy" for n in range(1, 6))


def test_mismatch_judged_only_in_strong_light():
    morning = [_s(n, 2.4) for n in range(1, 7)] + [_s(7, 1.9), _s(8, 0.0)]  # median 2.4 A
    r = check_inverter("INV", morning, wired=set(range(1, 9)))
    assert r["strings"][7]["status"] == "Healthy"  # -21 %, but light too weak to judge mismatch
    assert r["strings"][8]["status"] == "Critical"  # an open string is clear in any light
