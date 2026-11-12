"""MPPT used / voltage-only / spare classification for the CSV export (no network)."""

from __future__ import annotations

import importlib.util
import pathlib
import sys

_spec = importlib.util.spec_from_file_location(
    "export_inverter_mppt", pathlib.Path(__file__).resolve().parents[1] / "scripts" / "export_inverter_mppt.py"
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod  # dataclasses look the module up while decorating
_spec.loader.exec_module(mod)


def test_classify_used_voltage_only_and_spare():
    rows = [
        [{"mppt": 1, "v": 600, "i": 10.0, "p": 6000}, {"mppt": 2, "v": 610, "i": 0.1, "p": 0},
         {"mppt": 3, "v": 4, "i": 0, "p": 0}],
        [{"mppt": 1, "v": 620, "i": 12.0, "p": 7400}],
    ]
    stats = mod.classify_mppts(rows, {1: 6.0, 2: 6.1, 3: 0.0, 4: 0.0})
    assert stats[1].status == "used" and stats[1].max_current_a == 12.0 and stats[1].strings_used == [1, 2]
    assert stats[2].status == "voltage_only"  # PV connected, no current: site check
    assert stats[3].status == "spare"  # a few volts of noise is not PV
    assert mod.highest_active(stats) == 2


def test_string_current_alone_marks_mppt_used():
    stats = mod.classify_mppts([[]], {9: 4.2, 10: 0.0})
    assert stats[5].status == "used" and stats[5].strings_used == [9]
    assert mod.highest_active({}) == 0


def test_string_status_used_idle_spare_and_low_current():
    rows = [[{"mppt": 1, "v": 600, "i": 20, "p": 12000}, {"mppt": 2, "v": 600, "i": 8, "p": 4800}]]
    stats = mod.classify_mppts(rows, {1: 10.0, 2: 10.0, 3: 6.0, 4: 0.0})
    strings = {x["string_no"]: x for x in mod.classify_strings(stats, 3)}
    assert [strings[n]["status"] for n in range(1, 7)] == ["used", "used", "used", "idle", "spare", "spare"]
    assert strings[3]["low_current"] is True and strings[1]["low_current"] is False  # 6 A vs median 10 A
    assert strings[4]["peak_vs_inverter_median_pct"] is None


def test_string_status_without_string_data():
    stats = mod.classify_mppts([[{"mppt": 1, "v": 600, "i": 20, "p": 12000}]], {})
    assert {x["status"] for x in mod.classify_strings(stats, 1)} == {"not_reported"}
    assert {x["status"] for x in mod.classify_strings({}, 2)} == {"no_data"}
