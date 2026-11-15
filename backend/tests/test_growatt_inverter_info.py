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
    # real answer (EPHHDXB00L, 2026-11-15, producing 78 kW of 80 kW): every setting 0 = not read
    zeros = parse_max_info({
        "alias": "INV 3", "normalPower": 80000, "status": 1, "activeRate": 0, "reactiveRate": 0, "pf": 0,
        "pfModel": 0, "exportLimit": 0, "exportLimitPowerRate": 0, "onOff": 0, "voltageHighLimit": 0,
    })
    assert zeros["nominal_power_w"] == 80000.0 and zeros["alias"] == "INV 3"
    for k in ("active_rate_pct", "reactive_rate_pct", "pf_setting", "pf_model", "export_limit", "export_limit_rate_pct", "on_off"):
        assert zeros[k] is None, k


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


def test_live_latest_row_carries_power_tail_oldest_first(monkeypatch):
    from app.services import growatt_live

    page = [
        {**REC, "time": "2026-11-12 10:10:00", "pac": 900, "ppv": 950},
        {**REC, "time": "2026-11-12 10:05:00", "pac": 800, "ppv": None},
        {**REC, "time": "2026-11-12 10:00:00", "pac": 700, "ppv": 720},
    ]
    seen = {}

    def fake(c, sn, day, n=1):
        seen["n"] = n
        return page[:n]

    monkeypatch.setattr(growatt_live, "newest_max_records", fake)
    row = _latest_row(None, "EPHHDXB00M", date(2026, 11, 12))  # type: ignore[arg-type]
    assert row is not None
    assert seen["n"] == growatt_live.POWER_TAIL_RECORDS
    assert row["timestamp"] == "2026-11-12 10:10:00"
    # missing power stays null, never 0
    assert row["power"] == [
        ["2026-11-12 10:00:00", 700.0, 720.0],
        ["2026-11-12 10:05:00", 800.0, None],
        ["2026-11-12 10:10:00", 900.0, 950.0],
    ]
    assert len(row["previous_strings"]) == 2


# --------------------------------------------------------------------------- readPower (power limit)


class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def test_read_power_parses_new_api_reply():
    from solar_core.growatt import GrowattClient

    c = GrowattClient(token="t")
    seen = {}

    def post(url, params=None, timeout=None, **kw):
        seen.update(url=url, params=params, data=kw.get("data"))
        return _Resp({"code": 0, "data": 10, "message": "success"})

    c.session.post = post  # type: ignore[method-assign]
    assert c.read_power("BUFUEXB009") == 10.0
    assert seen["url"].endswith("/v1/new-api/readPower")
    assert seen["params"] == {"deviceSn": "BUFUEXB009", "deviceType": "max"} and seen["data"] is None

    for body, code in (
        ({"code": 18, "data": None, "message": "READ_DEVICE_PARAM_FAIL"}, 18),
        ({"code": 5, "data": None, "message": "DEVICE_OFFLINE"}, 5),
        ({"error_code": 10012, "error_msg": "error_frequently_access", "data": ""}, 10012),
        ({"code": 0, "data": None, "message": "SUCCESSFUL_OPERATION"}, 0),  # ok without a value: not a reading
    ):
        c.session.post = lambda *a, body=body, **k: _Resp(body)  # type: ignore[method-assign]
        try:
            c.read_power("X")
        except GrowattAPIError as exc:
            assert exc.error_code == code
        else:
            raise AssertionError(f"{body} should raise")


class _PowerAcct:
    def __init__(self, answers):
        self.answers = answers  # sn -> value | GrowattAPIError
        self.calls: list = []

    def read_power(self, sn):
        self.calls.append(sn)
        a = self.answers[sn]
        if isinstance(a, Exception):
            raise a
        return a


def _power_db(tmp_path):
    from app.db.models import GrowattPlant

    engine = build_engine(f"sqlite:///{tmp_path / 'p.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    db = Session()
    db.add_all([GrowattPlant(plant_id=1, name="P1", phase=1), GrowattPlant(plant_id=2, name="P2", phase=2)])
    db.add_all([
        GrowattInverter(device_sn=sn, plant_id=pid, nominal_power_w=60000.0)
        for sn, pid in (("A", 1), ("B", 1), ("C", 1), ("D", 1), ("Z", 2))
    ])
    db.commit()
    return db


def test_power_limit_sweep_stores_reads_and_keeps_old_value_on_refusal(tmp_path):
    db = _power_db(tmp_path)
    acct = _PowerAcct({
        "A": 100.0,
        "B": 10.0,
        "C": GrowattAPIError("READ_DEVICE_PARAM_FAIL", error_code=18),
        "D": GrowattAPIError("DEVICE_OFFLINE", error_code=5),
    })
    out = growatt_sync.sync_power_limits(db, acct, phase=1, pause_s=0)  # type: ignore[arg-type]
    assert acct.calls == ["A", "B", "C", "D"]  # phase 1 only, never phase 2's Z
    assert (out["power_limits_read"], out["power_limited"], out["power_limit_unreadable"]) == (2, 1, 2)
    assert out["power_limit_errors"] == {"18": 1, "5": 1} and out["failed"] == []
    b = db.get(GrowattInverter, "B")
    assert b.power_limit_pct == 10.0 and b.power_limit_read_at is not None
    c = db.get(GrowattInverter, "C")
    assert c.power_limit_pct is None and c.power_limit_read_at is None  # refused: unknown, never 100

    # next run: read ones are fresh; the unread ones are asked first
    acct.calls.clear()
    growatt_sync.sync_power_limits(db, acct, phase=1, pause_s=0)  # type: ignore[arg-type]
    assert acct.calls == ["C", "D"]

    # a day later B is read again and refused: the old reading stays, with its read time
    stamp = b.power_limit_read_at
    b.power_limit_read_at = datetime.now(timezone.utc) - timedelta(hours=growatt_sync.POWER_LIMIT_REFRESH_HOURS + 1)
    db.commit()
    acct.answers["B"] = GrowattAPIError("DEVICE_OFFLINE", error_code=5)
    acct.calls.clear()
    growatt_sync.sync_power_limits(db, acct, phase=1, pause_s=0)  # type: ignore[arg-type]
    assert acct.calls == ["C", "D", "B"]
    assert db.get(GrowattInverter, "B").power_limit_pct == 10.0
    assert stamp is not None


def test_power_limit_sweep_stops_after_rate_limits(tmp_path):
    db = _power_db(tmp_path)
    limited = GrowattAPIError("frequently access", error_code=10012)
    acct = _PowerAcct({"A": limited, "B": limited, "C": limited, "D": 100.0})
    out = growatt_sync.sync_power_limits(db, acct, phase=1, pause_s=0)  # type: ignore[arg-type]
    assert acct.calls == ["A", "B", "C"]  # 3 in a row end the sweep; D waits for the next run
    assert out["failed"] and out["power_limits_read"] == 0 and out["power_limit_unreadable"] == 0


def test_power_limit_from_read_power_wins_over_max_data_info(tmp_path):
    from app.services import growatt_daily

    db = _power_db(tmp_path)
    inv = db.get(GrowattInverter, "A")
    assert inv.active_limit_pct is None and not growatt_daily._limited(inv)
    assert growatt_daily._limit_w(inv) == 60000.0  # unknown limit: nameplate (never curtailed by guess)
    out = inverter_out(inv)["settings"]
    assert out["active_rate_pct"] is None and out["active_rate_source"] is None

    inv.active_rate_pct = 100.0  # as max_data_info would report it
    assert inverter_out(inv)["settings"]["active_rate_source"] == "max_data_info"

    inv.power_limit_pct = 10.0
    inv.power_limit_read_at = datetime(2026, 11, 15, 3, 40, tzinfo=timezone.utc)
    assert inv.active_limit_pct == 10.0 and growatt_daily._limited(inv)
    assert growatt_daily._limit_w(inv) == 6000.0
    out = inverter_out(inv)["settings"]
    assert out["active_rate_pct"] == 10.0 and out["active_rate_source"] == "read_power"
    assert out["power_limit_read_at"].startswith("2026-11-15T03:40")


def test_power_limits_job_scheduled_in_daylight():
    from app import worker

    s = [x for x in worker.default_schedule() if x.job == "power_limits"]
    assert len(s) == 1 and s[0].at is not None and 9 <= s[0].at.hour <= 11
    from app.services.jobs import JOBS

    assert "power_limits" in JOBS
