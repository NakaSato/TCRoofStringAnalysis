"""Energy meter (grid connection point): parsing, discovery, retention, and grid / load on the curve."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from unittest.mock import MagicMock

from sqlalchemy import select

from app.db.models import GrowattMeter, GrowattMeterReading
from app.db.session import get_db
from app.services import growatt_sync
from app.services.growatt_meter import attach_grid
from solar_core.growatt import parse_meter_records
from tests.test_growatt_routes import PLANT, client  # noqa: F401  (fixture)

DL, ADDR = "DLMETER1", 36
DAY = datetime(2026, 11, 11)


def _session(c):
    return next(c.app_ref.dependency_overrides[get_db]())


def _seed_meter(s, readings) -> None:
    s.add(GrowattMeter(datalogger_sn=DL, address=ADDR, plant_id=PLANT, device_name="CHNT_THREE"))
    s.flush()
    for ts, p, counter in readings:
        s.add(GrowattMeterReading(datalogger_sn=DL, address=ADDR, timestamp=ts, active_power_w=p, import_counter_kwh=counter))
    s.commit()


def test_parse_meter_records_keeps_values_as_reported():
    rows = parse_meter_records(
        DL,
        ADDR,
        [
            {"timeText": "2026-11-15 20:05:01", "activePower": 259611, "posiActivePower": 2659930, "activePowerL1": 67749},
            {"timeText": "2026-11-15 20:05:01", "activePower": 1},  # same timestamp: one row
            {"timeText": "bad", "activePower": 5},
        ],
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["timestamp"] == datetime(2026, 11, 15, 20, 5, 1)
    assert r["active_power_w"] == 1.0 and r["import_counter_kwh"] is None
    assert r["frequency_hz"] is None  # missing = null, never 0


def test_attach_grid_signs_and_derived_load():
    ts = [
        {"timestamp": "2026-11-11 10:00:00", "pac_kw": 10.0},
        {"timestamp": "2026-11-11 10:05:00", "pac_kw": 10.0},
        {"timestamp": "2026-11-11 10:10:00", "pac_kw": 10.0},
        {"timestamp": "2026-11-11 10:15:00", "pac_kw": 10.0},
    ]
    attach_grid(ts, {"2026-11-11 10:00:00": 3000.0, "2026-11-11 10:05:00": -2000.0, "2026-11-11 10:10:00": -20000.0})
    assert (ts[0]["grid_import_kw"], ts[0]["grid_export_kw"], ts[0]["load_kw"]) == (3.0, 0.0, 13.0)
    assert (ts[1]["grid_import_kw"], ts[1]["grid_export_kw"], ts[1]["load_kw"]) == (0.0, 2.0, 8.0)
    assert ts[2]["load_kw"] is None  # export above PV: inconsistent, never a negative load
    assert ts[3]["grid_import_kw"] is None and ts[3]["load_kw"] is None  # no meter record


def test_overview_carries_grid_and_load_only_with_a_meter(client):  # noqa: F811
    ov = client.get(f"/api/growatt/plants/{PLANT}/overview?day=2026-11-11").json()
    assert ov["kpis"]["has_meter"] is False
    assert ov["kpis"]["grid_import_kwh"] is None and ov["kpis"]["load_kwh"] is None
    assert all(r["load_kw"] is None for r in ov["timeseries"])

    s = _session(client)
    readings = []
    for m in range(0, 60, 5):
        p = 3000.0 if m < 30 else -2000.0
        readings.append((DAY + timedelta(hours=10, minutes=m, seconds=3), p, 1000.0 + (2.0 if m >= 30 else m / 15)))
    _seed_meter(s, readings)

    ov = client.get(f"/api/growatt/plants/{PLANT}/overview?day=2026-11-11").json()
    k = ov["kpis"]
    assert k["has_meter"] is True
    assert k["grid_import_kwh"] == 2.0  # from the import counter
    assert k["grid_export_kwh"] is not None and k["grid_export_kwh"] > 0
    by = {r["timestamp"]: r for r in ov["timeseries"]}
    r = by["2026-11-11 10:10:00"]
    assert r["grid_import_kw"] == 3.0 and r["grid_export_kw"] == 0.0
    assert r["load_kw"] == round(r["pac_kw"] + 3.0, 2)
    r = by["2026-11-11 10:40:00"]
    assert r["grid_export_kw"] == 2.0 and r["load_kw"] == round(r["pac_kw"] - 2.0, 2)

    power = client.get(f"/api/growatt/plants/{PLANT}/power?day=2026-11-11").json()
    assert power["has_meter"] is True
    assert any(r["load_kw"] is not None for r in power["timeseries"])


def test_sync_meters_registers_by_bus_address_and_retention_prunes(client):  # noqa: F811
    s = _session(client)
    fake = MagicMock()
    fake.list_devices.return_value = [
        {"type": 3, "device_sn": "meter", "datalogger_sn": DL},
        {"type": 3, "device_sn": "env", "datalogger_sn": "ENVDL"},
        {"type": 4, "device_sn": "INVA", "datalogger_sn": DL},
    ]
    fake.list_meters.return_value = [{"address": "36", "device_name": "CHNT_THREE", "device_type": "71"}, {"address": "x"}]
    assert growatt_sync.sync_meters(s, fake, PLANT) == 1
    fake.list_meters.assert_called_once_with(DL, refresh=True)
    m = s.get(GrowattMeter, (DL, ADDR))
    assert m is not None and m.device_name == "CHNT_THREE" and m.device_type == "71"

    old, new = datetime(2026, 1, 1, 10), datetime(2026, 11, 11, 10)
    s.add_all(
        [
            GrowattMeterReading(datalogger_sn=DL, address=ADDR, timestamp=old, active_power_w=1.0),
            GrowattMeterReading(datalogger_sn=DL, address=ADDR, timestamp=new, active_power_w=1.0),
        ]
    )
    s.commit()
    out = growatt_sync.prune_history(s, date(2026, 11, 15), 90)
    assert out["meter_rows"] == 1
    assert [t for (t,) in s.execute(select(GrowattMeterReading.timestamp))] == [new]


def test_meter_history_sync_writes_rows_and_marks_synced_until(client):  # noqa: F811
    s = _session(client)
    s.add(GrowattMeter(datalogger_sn=DL, address=ADDR, plant_id=PLANT))
    s.commit()
    fake = MagicMock()
    fake.meter_history.return_value = [
        {"timeText": "2026-11-11 10:05:01", "activePower": 100},
        {"timeText": "2026-11-11 10:00:03", "activePower": 90},
    ]
    out = growatt_sync.sync_meter_incremental(s, fake, date(2026, 11, 11), pause_s=0)
    assert out["meter_rows"] == 2 and out["meter_failed"] == []
    assert s.get(GrowattMeter, (DL, ADDR)).history_synced_until == datetime(2026, 11, 11, 10, 5, 1)
