"""Inverter name / rating / firmware (max_data_info) and live grid + diagnostics from max_data."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import sessionmaker

from app.db.models import Base, GrowattInverter
from app.db.session import build_engine
from app.services import growatt_sync
from app.services.growatt_live import _latest_row
from app.services.growatt_overview import inverter_out
from solar_core.growatt import GrowattAPIError, parse_max_diagnostics, parse_max_grid, parse_max_info, parse_max_mppt_energy

# trimmed real max_data record (EPHHDXB00M, 2026-11-12)
REC = {
    "time": "2026-11-12 17:56:23", "status": 1, "pac": 4.8, "ppv": 10.0, "eacToday": 379.2, "eacTotal": 242620.4,
    "fac": 49.96, "temperature": 40.1, "temperature2": 47.7, "temperature3": 51,
    "vacr": 227.40001, "vacs": 228.90001, "vact": 227.6, "vacRs": 395.9, "vacSt": 395.2, "vacTr": 393.9,
    "iacr": 0.8, "iacs": 0.8, "iact": 0.90000004, "pf": 1, "reactPower": 1322.7001,
    "faultType": 0, "faultCode1": 0, "faultCode2": 0, "faultValue": 0, "warnCode1": 0,
    "warningValue1": 0, "warningValue2": 0, "warningValue3": 0, "pidFaultCode": 0, "StrBreak": 0, "pvIso": 65530,
    "afciStatus": 2, "afciPv1": 407, "afciPv2": 36, "gfci": 2, "rDci": 18.6, "sDci": 2.1000001, "tDci": 18.800001,
    "timeTotal": 25378280.0, "epv1Today": 65.8, "epv1Total": 42031.9, "epv2Today": 67.6, "epv2Total": 42967.2,
    "epv9Today": 0, "epv9Total": 0,
    "vpv1": 600, "ipv1": 0.01, "ppv1": 6,
}


def test_parse_max_info():
    info = parse_max_info({
        "alias": "INVERTER 7", "normalPower": 80000, "fwVersion": "TI1.0", "innerVersion": "TIAA22200401",
        "activeRate": 80, "reactiveRate": 0, "pf": 1, "pfModel": 0, "exportLimit": 0, "exportLimitPowerRate": 100, "onOff": 1,
    })
    assert (info["alias"], info["nominal_power_w"], info["fw_version"], info["inner_version"]) == (
        "INVERTER 7", 80000.0, "TI1.0", "TIAA22200401"
    )
    assert info["active_rate_pct"] == 80 and info["pf_setting"] == 1 and info["on_off"] == 1
    assert info["export_limit_rate_pct"] == 100
    empty = parse_max_info({"alias": "", "normalPower": 0})
    assert all(v is None for v in empty.values())  # missing settings stay null


def test_parse_grid_and_diagnostics():
    g = parse_max_grid(REC)
    assert g["v_r"] == 227.40001 and g["v_rs"] == 395.9 and g["i_t"] == 0.90000004
    assert g["pf"] == 1 and g["reactive_var"] == 1322.7001 and g["fac_hz"] == 49.96
    d = parse_max_diagnostics(REC)
    assert d["fault_code1"] == 0 and d["warn_code"] == 0 and d["warning_values"] == [0, 0, 0]
    assert d["pv_iso_kohm"] is None  # 65530 = no reading
    assert d["ipm_temperature_c"] == 47.7 and d["boost_temperature_c"] == 51
    assert d["afci_status"] == 2 and d["afci_pv"] == [407, 36]
    assert d["gfci"] == 2 and d["dci"] == [18.6, 2.1000001, 18.800001]
    assert d["time_total_h"] == 7049.5
    assert parse_max_mppt_energy(REC) == [
        {"mppt": 1, "today_kwh": 65.8, "total_kwh": 42031.9},
        {"mppt": 2, "today_kwh": 67.6, "total_kwh": 42967.2},
    ]
    # missing fields stay null, never 0
    assert parse_max_diagnostics({})["fault_code1"] is None
    assert parse_max_grid({})["v_r"] is None


def test_live_latest_row_carries_grid_and_diagnostics(monkeypatch):
    from app.services import growatt_live

    monkeypatch.setattr(growatt_live, "newest_max_records", lambda c, sn, day, n=2: [REC])
    row = _latest_row(None, "EPHHDXB00M", date(2026, 11, 12))  # type: ignore[arg-type]
    assert row is not None
    assert row["grid"]["v_r"] == 227.40001
    assert row["diagnostics"]["boost_temperature_c"] == 51
    assert row["mppt_energy"][0] == {"mppt": 1, "today_kwh": 65.8, "total_kwh": 42031.9}


class _Acct:
    def __init__(self):
        self.info_calls: list = []
        self.limit_c = True
        self.empty_d = False

    def list_plants(self, refresh=False):
        return [{"plant_id": "5", "name": "P"}]

    def list_inverters(self, plant_id, refresh=False):
        return [
            {"device_sn": "A", "model": "", "datalogger_sn": "D", "device_types": ["inverter"]},
            {"device_sn": "B", "model": "", "datalogger_sn": "D", "device_types": ["inverter"]},
            {"device_sn": "C", "model": "", "datalogger_sn": "D", "device_types": ["inverter"]},
            {"device_sn": "D", "model": "", "datalogger_sn": "D", "device_types": ["inverter"]},
        ]

    def list_env_sensors(self, datalogger_sn, refresh=False):
        return []

    def list_devices(self, plant_id, refresh=False):
        return []

    def max_info(self, sn):
        self.info_calls.append(sn)
        if sn == "B":
            raise RuntimeError("bad answer")
        if sn == "D" and self.empty_d:
            return {"alias": None, "nominal_power_w": None}
        if sn == "C" and self.limit_c:
            raise GrowattAPIError("frequently access", error_code=10012)
        return {"alias": "INVERTER 1", "nominal_power_w": 50000.0, "fw_version": "TI1.0", "inner_version": "X", "active_rate_pct": 100.0}


def test_fleet_reads_info_oldest_first_and_stops_at_rate_limit(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'i.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    acct = _Acct()
    with Session() as db:
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]
        # A ok, B fails (skipped), C rate limited -> sweep stops, D not asked this run
        assert acct.info_calls == ["A", "B", "C"]
        a = db.get(GrowattInverter, "A")
        assert (a.alias, a.nominal_power_w, a.active_rate_pct) == ("INVERTER 1", 50000.0, 100.0)
        assert db.get(GrowattInverter, "D").info_synced_at is None
        out = inverter_out(a)
        assert out["nominal_power_kw"] == 50.0 and out["settings"]["active_rate_pct"] == 100.0

        # next run: never-read ones first (B, C, D); A is fresh
        acct.info_calls.clear()
        acct.limit_c = False
        acct.empty_d = True
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]
        assert acct.info_calls == ["B", "C", "D"]
        assert db.get(GrowattInverter, "D").info_synced_at is None  # empty answer is not stamped as read
        acct.empty_d = False
        acct.info_calls.clear()
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]
        assert acct.info_calls == ["B", "D"]

        # once older than INFO_REFRESH_HOURS, A is read again
        a.info_synced_at = datetime.now(timezone.utc) - timedelta(hours=growatt_sync.INFO_REFRESH_HOURS + 1)
        db.commit()
        acct.info_calls.clear()
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]
        assert acct.info_calls == ["B", "A"]  # never-read B first, then stale A
