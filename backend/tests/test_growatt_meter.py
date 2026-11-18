"""Energy meter (grid connection point): parsing, discovery, retention, and grid / load on the curve."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from unittest.mock import MagicMock

from sqlalchemy import select

from app.db.models import GrowattInverterReading, GrowattMeter, GrowattMeterReading, GrowattPlant
from app.db.session import get_db
from app.services import growatt_sync
from app.services.growatt_meter import attach_grid, day_energy
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


def test_day_energy_leaves_null_slots_out_and_needs_two_counter_records(client):  # noqa: F811
    s = _session(client)
    start, end = DAY, DAY + timedelta(days=1)
    ts = [
        {"timestamp": "2026-11-11 10:00:00", "pac_kw": 10.0},
        {"timestamp": "2026-11-11 10:05:00", "pac_kw": 10.0},
        {"timestamp": "2026-11-11 10:10:00", "pac_kw": 10.0},
    ]
    # export above PV in every slot: load is unknown, never 0 kWh
    attach_grid(ts, {r["timestamp"]: -20000.0 for r in ts})
    e = day_energy(s, PLANT, start, end, ts)
    assert e["load_kwh"] is None
    assert e["grid_export_kwh"] == 5.0 and e["grid_import_kwh"] == 0.0

    # an unknown load between two known slots adds nothing: its 5 min are not credited to the next slot
    attach_grid(ts, {ts[0]["timestamp"]: 2000.0, ts[1]["timestamp"]: -20000.0, ts[2]["timestamp"]: 2000.0})
    e = day_energy(s, PLANT, start, end, ts)
    assert e["load_kwh"] == 2.0  # 12 kW x 2 slots of 5 min
    assert e["grid_export_kwh"] == 1.7 and e["grid_import_kwh"] == 0.3

    # one counter record spans nothing: import stays the integrated 2 kW x 15 min, not 0
    attach_grid(ts, {r["timestamp"]: 2000.0 for r in ts})
    _seed_meter(s, [(DAY + timedelta(hours=10, seconds=3), 2000.0, 1000.0)])
    e = day_energy(s, PLANT, start, end, ts)
    assert e["grid_import_kwh"] == 0.5 and e["load_kwh"] == 3.0

    s.add(GrowattMeterReading(datalogger_sn=DL, address=ADDR, timestamp=DAY + timedelta(hours=10, minutes=10), active_power_w=2000.0, import_counter_kwh=1000.7))
    s.commit()
    assert day_energy(s, PLANT, start, end, ts)["grid_import_kwh"] == 0.7  # two records: the counter


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


def test_attach_grid_adds_meter_only_slots_with_pv_null():
    ts = [
        {"timestamp": "2026-11-11 06:00:00", "pac_kw": 0.0},
        {"timestamp": "2026-11-11 12:00:00", "pac_kw": 10.0},
        {"timestamp": "2026-11-11 17:50:00", "pac_kw": 0.4},
    ]
    slots = {
        "2026-11-11 02:00:00": 5000.0,  # sun down
        "2026-11-11 05:30:00": 4000.0,  # before the first inverter row, which read 0 kW
        "2026-11-11 12:05:00": 3000.0,  # between inverter rows
        "2026-11-11 18:10:00": 2000.0,  # after the last inverter row, which still produced
        "2026-11-11 19:30:00": 1000.0,  # sun down
        "2026-11-11 23:00:00": -500.0,  # export with the sun down: inconsistent
    }
    attach_grid(ts, slots, cap_kwp=20.0)
    assert [r["timestamp"] for r in ts] == sorted(r["timestamp"] for r in ts) and len(ts) == 9
    by = {r["timestamp"][11:16]: r for r in ts}
    for key in ("02:00", "05:30", "12:05", "18:10", "19:30", "23:00"):
        assert by[key]["pac_kw"] is None and by[key]["ppv_kw"] is None and by[key]["inverters"] == 0  # never 0 kW
    assert by["02:00"]["grid_import_kw"] == 5.0 and by["02:00"]["load_kw"] == 5.0
    assert by["05:30"]["load_kw"] == 4.0
    assert by["12:05"]["grid_import_kw"] == 3.0 and by["12:05"]["load_kw"] is None  # PV unknown by day
    assert by["18:10"]["load_kw"] is None
    assert by["19:30"]["load_kw"] == 1.0
    assert by["23:00"]["grid_export_kw"] == 0.5 and by["23:00"]["load_kw"] is None
    assert by["02:00"]["expected_kw"] == 0.0 and by["12:05"]["expected_kw"] > 0  # clear-sky model, as on inverter rows


def test_night_meter_slots_and_period_energy_from_the_backend(client):  # noqa: F811
    s = _session(client)
    readings = [(DAY + timedelta(hours=2, minutes=m, seconds=3), 6000.0, 990.0 + m / 10) for m in (0, 5, 10)]
    for m in range(0, 60, 5):
        readings.append((DAY + timedelta(hours=10, minutes=m, seconds=3), 3000.0, 1000.0 + m / 20))
    _seed_meter(s, readings)

    ov = client.get(f"/api/growatt/plants/{PLANT}/overview?day=2026-11-11").json()
    by = {r["timestamp"]: r for r in ov["timeseries"]}
    night = by["2026-11-11 02:05:00"]
    assert night["pac_kw"] is None and night["grid_import_kw"] == 6.0 and night["load_kw"] == 6.0
    assert ov["kpis"]["peak_power_kw"] is not None and ov["kpis"]["tariff_thb_per_kwh"] is not None

    power = client.get(f"/api/growatt/plants/{PLANT}/power?day=2026-11-11").json()
    assert "2026-11-11 02:05:00" in {r["timestamp"] for r in power["timeseries"]}
    for key in ("grid_import_kwh", "grid_export_kwh", "load_kwh"):
        assert power[key] == ov["kpis"][key]  # one integration for a whole day and a period
    assert power["grid_import_kwh"] == 12.8  # the import counter: 990.0 -> 1002.75

    win = client.get(f"/api/growatt/plants/{PLANT}/power?day=2026-11-11&start=10:00&end=10:25").json()
    assert all("10:00:00" <= r["timestamp"][11:] <= "10:25:00" for r in win["timeseries"])
    assert win["grid_import_kwh"] == 1.5  # 3 kW x 6 slots of 5 min, integrated: the counter spans the whole day
    assert win["grid_export_kwh"] == 0.0 and win["load_kwh"] is not None

    # the inverters shut down at 17:00 (0 kW): a 17:20-17:40 window without that record still
    # derives the evening load, as the whole day does
    s.add(GrowattInverterReading(device_sn="INVA", timestamp=DAY + timedelta(hours=17), pac_w=0, ppv_w=0))
    for m in (20, 25, 30):
        s.add(GrowattMeterReading(datalogger_sn=DL, address=ADDR, timestamp=DAY + timedelta(hours=17, minutes=m, seconds=3), active_power_w=4000.0))
    s.commit()
    day_rows = {r["timestamp"]: r for r in client.get(f"/api/growatt/plants/{PLANT}/power?day=2026-11-11").json()["timeseries"]}
    assert day_rows["2026-11-11 17:25:00"]["load_kw"] == 4.0
    eve = client.get(f"/api/growatt/plants/{PLANT}/power?day=2026-11-11&start=17:20&end=17:40").json()
    assert [r["load_kw"] for r in eve["timeseries"]] == [4.0, 4.0, 4.0]
    assert eve["load_kwh"] == 1.0 and eve["grid_import_kwh"] == 1.0

    bare = client.get(f"/api/growatt/plants/{PLANT}/power?day=2026-11-11&records=false").json()
    assert bare["has_meter"] is True and bare["timeseries"] == [] and bare["grid_import_kwh"] is None


def test_overview_reports_a_meter_before_any_inverter_record(client):  # noqa: F811
    s = _session(client)
    s.add(GrowattPlant(plant_id=222, name="New Plant", peak_power_kwp=10.0))
    s.flush()
    s.add(GrowattMeter(datalogger_sn="DLNEW", address=1, plant_id=222, device_name="CHNT_THREE"))
    s.commit()
    k = client.get("/api/growatt/plants/222/overview").json()["kpis"]
    assert k["has_meter"] is True
    assert k["grid_import_kwh"] is None and k["load_kwh"] is None


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
