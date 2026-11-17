"""Growatt records → rows: field maps and parsers for inverter, string, weather-sensor and meter
records. No HTTP here."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# Weather-sensor fields worth keeping → column name. `env_data` also returns ~20 other
# fields (rain, snow, pressure, soil, gas, …) that this fleet's sensors are not fitted with:
# they are always 0 and are dropped. `etodayRadiation` is 0 here too; insolation is
# integrated from `radiant` instead.
ENV_FIELDS: Dict[str, str] = {
    "radiant": "irradiance_wm2",  # plane-of-array irradiance, W/m²
    "envTemp": "ambient_temp_c",
    "panelTemp": "module_temp_c",  # back-of-module temperature
    "envHumidity": "humidity_pct",
    "windSpeed": "wind_speed_ms",
    "windAngle": "wind_dir_deg",
}


def _env_time(r: Dict[str, Any]) -> Optional[datetime]:
    """`timeText` is plant-local wall-clock time. (The Java `calendar` block next to it labels
    the same wall time as Asia/Shanghai, so its epoch millis are an hour off — ignore it.)"""
    try:
        return datetime.strptime(str(r.get("timeText")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def parse_env_records(datalogger_sn: str, address: int, records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """`env_data` records → `growatt_env_readings` rows (one per timestamp, values as reported).

    Values are stored as Growatt reports them; a probe the sensor lacks reads 0, which readers
    turn into null per day (see `growatt_weather`).
    """
    rows: Dict[datetime, Dict[str, Any]] = {}
    for r in records:
        ts = _env_time(r)
        if ts is None:
            continue
        rows[ts] = {
            "datalogger_sn": datalogger_sn,
            "address": int(address),
            "timestamp": ts,
            **{col: _f(r.get(key)) for key, col in ENV_FIELDS.items()},
        }
    return list(rows.values())


# Meter fields kept → column, under Growatt's own meaning (probed 15 Nov 2026 on a CHNT_THREE at
# the grid connection point). `activePower` read 260 kW at night with PV at 0 (the site's draw
# from the grid) and `posiActivePower` (= `activeEnergy`) rose by the energy drawn: the import
# counter. Whether `activePower` turns negative while exporting, and which reverse field is
# export energy, is not confirmed yet; they are stored raw and not shown as export.
METER_FIELDS: Dict[str, str] = {
    "activePower": "active_power_w",
    "activePowerL1": "active_power_l1_w",
    "activePowerL2": "active_power_l2_w",
    "activePowerL3": "active_power_l3_w",
    "reactivePower": "reactive_power_var",
    "powerFactor": "power_factor",
    "frequency": "frequency_hz",
    "posiActivePower": "import_counter_kwh",
    "positiveActiveTodayEnergy": "forward_today_kwh",
    "reverActivePower": "rever_active_power_raw",
    "reverseActiveTodayEnergy": "reverse_today_kwh",
}


def parse_meter_records(datalogger_sn: str, address: int, records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """`meter_data` records → `growatt_meter_readings` rows (one per timestamp, values as reported)."""
    rows: Dict[datetime, Dict[str, Any]] = {}
    for r in records:
        ts = _env_time(r)
        if ts is None:
            continue
        rows[ts] = {
            "datalogger_sn": datalogger_sn,
            "address": int(address),
            "timestamp": ts,
            **{col: _f(r.get(key)) for key, col in METER_FIELDS.items()},
        }
    return list(rows.values())


def parse_max_info(m: Dict[str, Any]) -> Dict[str, Any]:
    """`max_data_info` → registry fields; blanks become None."""
    text = lambda k: (str(m.get(k)).strip() or None) if m.get(k) not in (None, "") else None
    power = _f(m.get("normalPower"))
    num = lambda k: _f(m.get(k)) if m.get(k) not in (None, "") else None
    integer = lambda k: int(v) if (v := num(k)) is not None else None
    settings = {
        "active_rate_pct": num("activeRate"),  # active power limit, % of rated; < 100 = curtailed
        "reactive_rate_pct": num("reactiveRate"),
        "pf_setting": num("pf"),
        "pf_model": integer("pfModel"),  # Growatt PF mode code
        "export_limit": integer("exportLimit"),  # export limitation enabled flag / mode as reported
        "export_limit_rate_pct": num("exportLimitPowerRate"),
        "on_off": integer("onOff"),  # 1 = on, 0 = switched off
    }
    # The OpenAPI often answers the whole settings block as 0 (activeRate, pf, onOff, voltage and
    # frequency limits) for inverters producing at full power: settings not read, not configured
    # at 0. pf 0 is impossible, so a block with activeRate and pf both 0 is stored as unknown.
    if not settings["active_rate_pct"] and not settings["pf_setting"]:
        settings = dict.fromkeys(settings)
    return {
        "alias": text("alias"),
        "nominal_power_w": power if power else None,  # 0 = not reported
        "fw_version": text("fwVersion"),
        "inner_version": text("innerVersion"),
        # settings as configured on the inverter (not measurements)
        **settings,
    }


# `max_data` grid-side fields, as reported (V, A, Hz; reactPower in var).
MAX_GRID_FIELDS = {
    "vacr": "v_r", "vacs": "v_s", "vact": "v_t",            # phase voltage
    "vacRs": "v_rs", "vacSt": "v_st", "vacTr": "v_tr",      # line voltage
    "iacr": "i_r", "iacs": "i_s", "iact": "i_t",
    "pf": "pf", "reactPower": "reactive_var", "fac": "fac_hz",
}


# PV insulation resistance; Growatt reports 65530 when it has no reading.
PV_ISO_NO_READING = 65530


def parse_max_grid(r: Dict[str, Any]) -> Dict[str, Any]:
    """Grid-side values of one `max_data` record."""
    return {col: _f(r.get(key)) for key, col in MAX_GRID_FIELDS.items()}


def parse_max_diagnostics(r: Dict[str, Any]) -> Dict[str, Any]:
    """Fault / warning codes and internal temperatures of one `max_data` record, as reported.

    Code 0 = none. `str_break` is Growatt's string-break bit field (0 = none).
    """
    num = lambda k: int(v) if (v := _f(r.get(k))) is not None else None
    iso = _f(r.get("pvIso"))
    return {
        "fault_type": num("faultType"),
        "fault_code1": num("faultCode1"),
        "fault_code2": num("faultCode2"),
        "fault_value": num("faultValue"),
        "warn_code": num("warnCode1"),
        "warning_values": [num(f"warningValue{n}") for n in (1, 2, 3)],
        "pid_fault_code": num("pidFaultCode"),
        "str_break": num("StrBreak"),
        "pv_iso_kohm": None if iso is None or iso >= PV_ISO_NO_READING else iso,
        # safety: arc-fault detection and leakage / DC injection, as reported by Growatt
        "afci_status": num("afciStatus"),
        "afci_pv": [num("afciPv1"), num("afciPv2")],
        "gfci": _f(r.get("gfci")),
        "dci": [_f(r.get("rDci")), _f(r.get("sDci")), _f(r.get("tDci"))],
        "time_total_h": _round_h(_f(r.get("timeTotal"))),
        # Matched against Growatt's own history export (GKLRF6R00G, 13 Nov 2026): temperature =
        # AMTemp1, temperature2 = INVTemp, temperature3 = BTTemp (temperature5 = AMTemp2). The
        # "ipm" key name was a guess and is kept only so the API does not change.
        "temperature_c": _f(r.get("temperature")),
        "ipm_temperature_c": _f(r.get("temperature2")),
        "boost_temperature_c": _f(r.get("temperature3")),
    }


def _round_h(seconds_or_none: Optional[float]) -> Optional[float]:
    """`timeTotal` is reported in seconds (25 378 280 ≈ 7 050 h ≈ 1.6 years of daylight) → hours."""
    return None if seconds_or_none is None else round(seconds_or_none / 3600.0, 1)


def parse_max_mppt_energy(r: Dict[str, Any], max_mppts: int = 16) -> List[Dict[str, Any]]:
    """Today's and lifetime DC energy per PV input (`epv{n}Today` / `epv{n}Total`, kWh)."""
    out = []
    for n in range(1, max_mppts + 1):
        today, total = _f(r.get(f"epv{n}Today")), _f(r.get(f"epv{n}Total"))
        if today or total:
            out.append({"mppt": n, "today_kwh": today, "total_kwh": total})
    return out


def _record_time(r: Dict[str, Any]) -> Optional[datetime]:
    try:
        return datetime.strptime(str(r.get("time")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _text(v: Any) -> Optional[str]:
    t = str(v).strip() if v is not None else ""
    return t or None


def _nonzero_int(v: Any) -> Optional[int]:
    """A Growatt code field as int; 0, empty or unreadable = None (no code)."""
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n or None


# Fields of a `max_data` record left out of the raw copy: `calendar` repeats `time` as a Java
# calendar object (about a quarter of the record), the other two are the row's own key.
RAW_SKIP_FIELDS = frozenset({"calendar", "serialNum", "time"})


def parse_max_raw(device_sn: str, records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """`max_data` records → `growatt_inverter_raw` rows: every field of the record exactly as
    Growatt reports it (names and values untouched), except `RAW_SKIP_FIELDS`. One per timestamp."""
    rows: Dict[datetime, Dict[str, Any]] = {}
    for r in records:
        t = r.get("time")
        if not t:
            continue
        ts = datetime.strptime(t, "%Y-%m-%d %H:%M:%S")
        rows[ts] = {
            "device_sn": device_sn,
            "timestamp": ts,
            "data": {k: v for k, v in r.items() if k not in RAW_SKIP_FIELDS},
        }
    return list(rows.values())


def parse_max_records(
    device_sn: str, records: List[Dict[str, Any]], max_strings: int = 32, max_mppts: int = 16
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split `max_data` records into inverter rows and per-string rows.

    `time` is plant-local time. String n sits on MPPT ceil(n/2); both strings on an MPPT
    report the MPPT voltage, current is per string. String rows are kept only while the
    inverter produces (ppv > 0) — at night PID recovery holds ~60 V on idle strings.
    Only string inputs that ever report voltage or current in the batch are emitted.
    """
    inv_rows: Dict[datetime, Dict[str, Any]] = {}
    str_rows: Dict[Tuple[datetime, int], Dict[str, Any]] = {}
    active: set = set()
    for r in records:
        for n in range(1, max_strings + 1):
            if (_f(r.get(f"vString{n}")) or 0) > 0 or (_f(r.get(f"currentString{n}")) or 0) > 0:
                active.add(n)

    for r in records:
        t = r.get("time")
        if not t:
            continue
        ts = datetime.strptime(t, "%Y-%m-%d %H:%M:%S")
        ppv = _f(r.get("ppv")) or 0.0
        mppts = []
        for n in range(1, max_mppts + 1):
            v, i, p = _f(r.get(f"vpv{n}")) or 0.0, _f(r.get(f"ipv{n}")) or 0.0, _f(r.get(f"ppv{n}")) or 0.0
            if v or i or p:
                mppts.append({"mppt": n, "v": round(v, 2), "i": round(i, 2), "p": round(p, 1)})
        inv_rows[ts] = {
            "device_sn": device_sn,
            "timestamp": ts,
            "status": r.get("status"),
            "pac_w": _f(r.get("pac")),
            "ppv_w": ppv,
            "eac_today_kwh": _f(r.get("eacToday")),
            "eac_total_kwh": _f(r.get("eacTotal")),
            "temperature_c": _f(r.get("temperature")),
            "fac_hz": _f(r.get("fac")),
            "mppt_json": mppts,
            # the record's own fault / warning code (0 = none), as Growatt reports it
            "fault_code": _nonzero_int(r.get("faultType")),
            "warn_code": _nonzero_int(r.get("warnCode")),
        }
        if ppv <= 0:
            continue
        for n in sorted(active):
            v = _f(r.get(f"vString{n}")) or 0.0
            i = _f(r.get(f"currentString{n}")) or 0.0
            str_rows[(ts, n)] = {
                "device_sn": device_sn,
                "timestamp": ts,
                "string_no": n,
                "mppt_no": (n + 1) // 2,
                "voltage_v": round(v, 2),
                "current_a": round(i, 3),
                "power_w": round(v * i, 1),
            }
    return list(inv_rows.values()), list(str_rows.values())
