"""Growatt OpenAPI v1 client (https://openapi.growatt.com/v1/, header `token`).

Responses are `{"error_code": 0, "error_msg": "", "data": {...}}`; a non-zero
`error_code` is an error even on HTTP 200. Growatt rate-limits per endpoint, so
callers should cache (see `GrowattClient` TTL cache).
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

import requests

# device/list `type` codes
DEVICE_TYPE_NAMES: Dict[int, str] = {
    1: "inverter",
    2: "storage",
    3: "other",
    4: "max",
    5: "sph",
    6: "spa",
    7: "min",
    8: "pcs",
    9: "hps",
    10: "pbd",
}
INVERTER_TYPES = {1, 4, 5, 6, 7}

# Inverter `status` codes as observed in device/list (0 = offline/waiting, 1 = normal, 3 = fault)
INVERTER_STATUS_NAMES: Dict[int, str] = {0: "Offline", 1: "Normal", 3: "Fault"}


class GrowattAPIError(RuntimeError):
    def __init__(self, message: str, error_code: Optional[int] = None):
        super().__init__(message)
        self.error_code = error_code


class GrowattClient:
    """Thin Growatt OpenAPI v1 client with an in-memory TTL cache."""

    def __init__(self, token: str, base_url: str = "https://openapi.growatt.com/v1/", timeout: int = 30, cache_ttl_s: int = 300):
        if not token:
            raise GrowattAPIError("Growatt API token is not configured (set GROWATT_API_TOKEN in .env).")
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout = timeout
        self.cache_ttl_s = cache_ttl_s
        self.session = requests.Session()
        self.session.headers.update({"token": token})
        self._cache: Dict[Tuple[str, Tuple[Tuple[str, Any], ...]], Tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def _request(self, method: str, path: str, params: Dict[str, Any]) -> Any:
        try:
            if method == "POST":
                resp = self.session.post(self.base_url + path, data=params, timeout=self.timeout)
            else:
                resp = self.session.get(self.base_url + path, params=params, timeout=self.timeout)
            resp.raise_for_status()
            body = resp.json()
        except requests.RequestException as exc:
            raise GrowattAPIError(f"Growatt request {path} failed: {exc}") from exc
        except ValueError as exc:
            raise GrowattAPIError(f"Growatt request {path} returned non-JSON response") from exc
        code = body.get("error_code")
        if code != 0:
            raise GrowattAPIError(f"Growatt {path} error {code}: {body.get('error_msg') or 'unknown error'}", error_code=code)
        return body.get("data")

    def _get(self, path: str, use_cache: bool = True, **params: Any) -> Any:
        key = (path, tuple(sorted(params.items())))
        now = time.monotonic()
        if use_cache:
            with self._lock:
                hit = self._cache.get(key)
            if hit and now - hit[0] < self.cache_ttl_s:
                return hit[1]
        data = self._request("GET", path, params)
        with self._lock:
            self._cache[key] = (now, data)
        return data

    def list_plants(self, refresh: bool = False) -> List[Dict[str, Any]]:
        plants: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._get("plant/list", use_cache=not refresh, page=page, perpage=100) or {}
            batch = data.get("plants") or []
            plants.extend(batch)
            if not batch or len(plants) >= int(data.get("count") or 0):
                return plants
            page += 1

    def list_devices(self, plant_id: int, refresh: bool = False) -> List[Dict[str, Any]]:
        devices: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._get("device/list", use_cache=not refresh, plant_id=plant_id, page=page, perpage=100) or {}
            batch = data.get("devices") or []
            devices.extend(batch)
            if not batch or len(devices) >= int(data.get("count") or 0):
                return devices
            page += 1

    def list_inverters(self, plant_id: int, refresh: bool = False) -> List[Dict[str, Any]]:
        """Inverters for a plant, de-duplicated by serial.

        Growatt lists MAX inverters twice (type 1 and type 4, same `device_sn`); merge them.
        """
        merged: Dict[str, Dict[str, Any]] = {}
        for dev in self.list_devices(plant_id, refresh=refresh):
            dtype = dev.get("type")
            if dtype not in INVERTER_TYPES:
                continue
            sn = str(dev.get("device_sn"))
            entry = merged.setdefault(
                sn,
                {
                    "device_sn": sn,
                    "model": dev.get("model") or "",
                    "datalogger_sn": dev.get("datalogger_sn") or "",
                    "manufacturer": dev.get("manufacturer") or "",
                    "status": dev.get("status"),
                    "status_label": INVERTER_STATUS_NAMES.get(int(dev["status"]), f"Status {dev['status']}")
                    if isinstance(dev.get("status"), int)
                    else f"Status {dev.get('status')}",
                    "lost": bool(dev.get("lost")),
                    "last_update_time": dev.get("last_update_time"),
                    "device_types": [],
                },
            )
            entry["device_types"].append(DEVICE_TYPE_NAMES.get(dtype, str(dtype)))
        return sorted(merged.values(), key=lambda d: d["device_sn"])

    def max_info(self, device_sn: str) -> Dict[str, Any]:
        """Static facts of one MAX inverter (`device/max/max_data_info`): name, rating, firmware."""
        data = self._get("device/max/max_data_info", use_cache=False, device_sn=device_sn) or {}
        m = data.get("max")
        return parse_max_info(m if isinstance(m, dict) else data)

    def max_history(
        self, device_sn: str, start_date: date, end_date: date, stop_before: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """Records for a MAX inverter between two dates (inclusive, max 7 days).

        `device/max/max_data` returns newest first, 100 per page (Growatt rejects perpage > 100).
        With `stop_before`, paging stops once a page reaches records older than it — an
        incremental sync then needs about one page per inverter instead of the whole range.
        """
        if (end_date - start_date).days > 6:
            raise ValueError("Growatt max_data date range must not exceed 7 days")
        records: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._request(
                "POST",
                "device/max/max_data",
                {
                    "max_sn": device_sn,
                    "start_date": start_date.strftime("%Y-%m-%d"),
                    "end_date": end_date.strftime("%Y-%m-%d"),
                    "page": page,
                    "perpage": 100,
                },
            ) or {}
            batch = data.get("datas") or []
            records.extend(batch)
            if not batch or len(records) >= int(data.get("count") or 0):
                return records
            oldest = _record_time(batch[-1])
            if stop_before is not None and oldest is not None and oldest < stop_before:
                return records
            page += 1


    # ------------------------------------------------------------------ weather (environmental) sensors
    # A datalogger with a weather sensor lists a type-3 device whose `device_sn` is literally
    # "env" in device/list. The sensor itself is addressed by (datalogger SN, bus address),
    # which only `device/env/env_list` reveals. Rate limits apply per datalogger.

    def list_env_sensors(self, datalogger_sn: str, refresh: bool = False) -> List[Dict[str, Any]]:
        """Weather sensors on one datalogger (`device/env/env_list`): address, name, lost, lastUpdateTime."""
        sensors: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._get("device/env/env_list", use_cache=not refresh, datalog_sn=datalogger_sn, page=page, perpage=100) or {}
            batch = data.get("envs") or []
            sensors.extend(batch)
            if not batch or len(sensors) >= int(data.get("count") or 0):
                return sensors
            page += 1

    def env_history(
        self, datalogger_sn: str, address: int, start_date: date, end_date: date, stop_before: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """Weather-sensor records between two dates (inclusive, max 7 days), newest first, 100 per page.

        `stop_before` stops paging once a page reaches records older than it (incremental sync).
        """
        if (end_date - start_date).days > 6:
            raise ValueError("Growatt env_data date range must not exceed 7 days")
        records: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._request(
                "GET",
                "device/env/env_data",
                {
                    "datalog_sn": datalogger_sn,
                    "address": address,
                    "start_date": start_date.strftime("%Y-%m-%d"),
                    "end_date": end_date.strftime("%Y-%m-%d"),
                    "page": page,
                    "perpage": 100,
                },
            ) or {}
            batch = data.get("env_data") or []
            records.extend(batch)
            if not batch or len(records) >= int(data.get("count") or 0):
                return records
            oldest = _env_time(batch[-1])
            if stop_before is not None and oldest is not None and oldest < stop_before:
                return records
            page += 1

    def env_latest(self, datalogger_sn: str, address: int) -> Optional[Dict[str, Any]]:
        """Newest weather-sensor record (`device/env/env_last_data`), or None when the sensor has none."""
        data = self._request("GET", "device/env/env_last_data", {"datalog_sn": datalogger_sn, "address": address})
        return data if isinstance(data, dict) and data.get("timeText") else None


    def max_alarms(self, device_sn: str, day: date, perpage: int = 100, max_pages: int = 10) -> List[Dict[str, Any]]:
        """Alarm / fault log of one MAX inverter for one plant-local day (`device/max/alarm_data`, POST).

        Each record: start_time, end_time (plant-local text), alarm_code, alarm_message,
        fault_type ("Warning" / "Fault" …) and status. Pages until `count` records are read.
        """
        out: List[Dict[str, Any]] = []
        for page in range(1, max_pages + 1):
            data = self._request(
                "POST",
                "device/max/alarm_data",
                {"max_sn": device_sn, "date": day.isoformat(), "page": page, "perpage": perpage},
            )
            body = data if isinstance(data, dict) else {}
            batch = body.get("alarms") or []
            out.extend(batch)
            total = int(body.get("count") or 0)
            if not batch or len(out) >= total:
                break
        return out

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


def parse_max_info(m: Dict[str, Any]) -> Dict[str, Any]:
    """`max_data_info` → registry fields; blanks become None."""
    text = lambda k: (str(m.get(k)).strip() or None) if m.get(k) not in (None, "") else None
    power = _f(m.get("normalPower"))
    num = lambda k: _f(m.get(k)) if m.get(k) not in (None, "") else None
    integer = lambda k: int(v) if (v := num(k)) is not None else None
    return {
        "alias": text("alias"),
        "nominal_power_w": power if power else None,  # 0 = not reported
        "fw_version": text("fwVersion"),
        "inner_version": text("innerVersion"),
        # settings as configured on the inverter (not measurements)
        "active_rate_pct": num("activeRate"),  # active power limit, % of rated; < 100 = curtailed
        "reactive_rate_pct": num("reactiveRate"),
        "pf_setting": num("pf"),
        "pf_model": integer("pfModel"),  # Growatt PF mode code
        "export_limit": integer("exportLimit"),  # export limitation enabled flag / mode as reported
        "export_limit_rate_pct": num("exportLimitPowerRate"),
        "on_off": integer("onOff"),  # 1 = on, 0 = switched off
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


def newest_max_records(client: "GrowattClient", device_sn: str, day: date, n: int = 1) -> List[Dict[str, Any]]:
    """The day's `n` newest `max_data` records, newest first (first page only) — one API call, no paging."""
    data = client._request(
        "POST",
        "device/max/max_data",
        {"max_sn": device_sn, "start_date": day.strftime("%Y-%m-%d"), "end_date": day.strftime("%Y-%m-%d"), "page": 1, "perpage": 100},
    ) or {}
    return (data.get("datas") or [])[:n]


def _record_time(r: Dict[str, Any]) -> Optional[datetime]:
    try:
        return datetime.strptime(str(r.get("time")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


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
