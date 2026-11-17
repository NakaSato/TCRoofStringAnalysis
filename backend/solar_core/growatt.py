"""Growatt OpenAPI v1 client (https://openapi.growatt.com/v1/, header `token`).

Responses are `{"error_code": 0, "error_msg": "", "data": {...}}`; a non-zero
`error_code` is an error even on HTTP 200. Growatt rate-limits per endpoint, so
callers should cache (see `GrowattClient` TTL cache).
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

import requests
import requests.adapters

# Keep-alive connections per host for one client (one Growatt account).
POOL_MAXSIZE = 32

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

# Inverter `status` codes (0 = waiting, 1 = normal, 3 = fault). "Offline" is not a code: it is an
# inverter Growatt lost contact with (`lost`) or one with no record today.
INVERTER_STATUS_NAMES: Dict[int, str] = {0: "Waiting", 1: "Normal", 3: "Fault"}
OFFLINE_LABEL = "Offline"


# Longest raw reply quoted in an error message.
ERROR_SNIPPET_MAX = 300


def _snippet(value: Any) -> str:
    text = value if isinstance(value, str) else repr(value)
    text = " ".join(text.split())
    return text if len(text) <= ERROR_SNIPPET_MAX else text[: ERROR_SNIPPET_MAX - 1] + "…"


def growatt_error_text(body: Dict[str, Any]) -> str:
    """Growatt's own reason for a refused call: `error_msg`, else another message field it
    sent (`msg`, `message`, …), else the raw reply (shortened). Never a made-up text."""
    for key in ("error_msg", "msg", "message", "error_message", "error", "result_msg"):
        val = body.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    rest = {k: v for k, v in body.items() if k != "error_code"}
    return f"no message; reply {_snippet(rest)}" if rest else "no message and no other fields"


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
        # One client is shared by several thread pools (live /latest, alarms, sensor sweep,
        # concurrent requests); the default 10-connection pool would discard the extras
        # ("Connection pool is full") and pay a fresh TLS handshake on the next call.
        adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=POOL_MAXSIZE)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
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
        if not isinstance(body, dict):
            raise GrowattAPIError(f"Growatt {path} returned an unexpected reply: {_snippet(body)}")
        code = body.get("error_code")
        if code != 0:
            raise GrowattAPIError(f"Growatt {path} error {code}: {growatt_error_text(body)}", error_code=code)
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

    def plant_data(self, plant_id: int) -> Dict[str, Any]:
        """`plant/data`: one plant's current power, today / month / year / total energy and
        `last_update_time` (plant-local). `plant/list` has no today energy; this is the only
        plant-level source of it. One call per plant, never cached here."""
        return self._get("plant/data", use_cache=False, plant_id=plant_id) or {}

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
                    "status_label": OFFLINE_LABEL
                    if dev.get("lost")
                    else INVERTER_STATUS_NAMES.get(int(dev["status"]), f"Status {dev['status']}")
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

    def _new_api(self, path: str, params: Dict[str, Any]) -> Any:
        """POST to a `new-api/*` endpoint (query parameters). These reply `{code, data, message}`
        instead of `{error_code, data, error_msg}`; returns `data`, raises GrowattAPIError
        (`error_code` = Growatt's code) on any refusal."""
        try:
            resp = self.session.post(self.base_url + path, params=params, timeout=self.timeout)
            resp.raise_for_status()
            body = resp.json()
        except requests.RequestException as exc:
            raise GrowattAPIError(f"Growatt request {path} failed: {exc}") from exc
        except ValueError as exc:
            raise GrowattAPIError(f"Growatt request {path} returned non-JSON response") from exc
        if not isinstance(body, dict):
            raise GrowattAPIError(f"Growatt {path} returned an unexpected reply: {_snippet(body)}")
        code = body.get("code", body.get("error_code"))
        if code != 0:
            msg = body.get("message") or body.get("error_msg") or _snippet(body)
            raise GrowattAPIError(f"Growatt {path} error {code}: {msg}", error_code=code)
        return body.get("data")

    def read_power(self, device_sn: str) -> float:
        """Active power limit of one MAX inverter, % of rated (`new-api/readPower`).

        Read from the inverter itself through its datalogger, so it answers only while the
        inverter is reachable (daylight): code 5 DEVICE_OFFLINE, code 18 READ_DEVICE_PARAM_FAIL
        (some dataloggers never pass it on). Unlike `max_data_info`, which answers the setting
        as 0 for every inverter, this returns the configured limit (checked 15 Nov 2026: 487 of
        488 answering inverters 100, one 10 while producing 10 % of its rating).
        """
        path = "new-api/readPower"
        value = _f(self._new_api(path, {"deviceSn": device_sn, "deviceType": "max"}))
        if value is None:
            raise GrowattAPIError(f"Growatt {path} answered no value", error_code=0)
        return value

    def device_info(self, device_sn: str) -> Dict[str, Any]:
        """The `max_info` fields of one MAX inverter from `new-api/queryDeviceInfo` instead of
        `device/max/max_data_info`: its reply (`data.max[0]`) carries the same field names
        (`alias`, `normalPower`, `fwVersion`, `innerVersion` and the settings block, also answered
        as 0; probed 15 Nov 2026). Its rate limit was not measured."""
        data = self._new_api("new-api/queryDeviceInfo", {"deviceSn": device_sn, "deviceType": "max"})
        rows = data.get("max") if isinstance(data, dict) else None
        m = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
        return parse_max_info(m)

    def device_last_record(self, device_sn: str) -> Optional[Dict[str, Any]]:
        """Newest record of one MAX inverter from `new-api/queryLastData` (`data.max[0]`): the
        `max_data` record fields, `time` plant-local. None when there is none. Realtime: callers
        must not store it."""
        data = self._new_api("new-api/queryLastData", {"deviceSn": device_sn, "deviceType": "max"})
        rows = data.get("max") if isinstance(data, dict) else None
        rec = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
        return rec if rec and rec.get("time") else None

    def account_create_times(self, max_pages: int = 20) -> Dict[str, datetime]:
        """Every device of the account with its creation time on Growatt
        (`new-api/queryDeviceList`, 100 per page), {serial: createDate}; naive, as reported."""
        out: Dict[str, datetime] = {}
        for page in range(1, max_pages + 1):
            data = self._new_api("new-api/queryDeviceList", {"page": page})
            d = data if isinstance(data, dict) else {}
            rows = [r for r in (d.get("data") or []) if isinstance(r, dict)]
            for r in rows:
                try:
                    out[str(r.get("deviceSn"))] = datetime.strptime(str(r.get("createDate"))[:19], "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    continue
            if not rows or page >= int(_f(d.get("pages")) or 0):
                break
        return out

    def device_info_param(self, device_sn: str) -> Dict[str, Any]:
        """Model text, datalogger model and nominal power of one MAX inverter
        (`new-api/queryDeviceInfoParam`), e.g. "MAX 80KTL3 LV", "ShineMaster", 80000 W.
        Empty text and a non-positive power are None."""
        data = self._new_api("new-api/queryDeviceInfoParam", {"deviceSn": device_sn, "deviceType": "max"})
        d = data if isinstance(data, dict) else {}
        power = _f(d.get("norminalPower", d.get("nominalPower")))  # sic: Growatt's spelling
        return {
            "device_model": _text(d.get("deviceModel")),
            "datalogger_model": _text(d.get("dataloggerModel")),
            "rated_power_w": power if power and power > 0 else None,
        }

    # ------------------------------------------------------------------ Growatt's own energy / curves
    def plant_energy_days(self, plant_id: int, start_date: date, end_date: date) -> List[Tuple[date, Optional[float]]]:
        """Growatt's daily energy (kWh) of a plant (`plant/energy`, time_unit=day), both dates
        inclusive, at most 31 days per call. A day Growatt lists without a number is None."""
        if (end_date - start_date).days > 30:
            raise ValueError("plant/energy range must not exceed 31 days")
        out: List[Tuple[date, Optional[float]]] = []
        page = 1
        while True:
            data = self._get(
                "plant/energy",
                use_cache=False,
                plant_id=plant_id,
                start_date=start_date.isoformat(),
                end_date=end_date.isoformat(),
                time_unit="day",
                page=page,
                perpage=100,
            ) or {}
            batch = data.get("energys") or []
            for row in batch:
                try:
                    d = date.fromisoformat(str(row.get("date"))[:10])
                except ValueError:
                    continue
                out.append((d, _f(row.get("energy"))))
            if not batch or len(out) >= int(data.get("count") or 0):
                return out
            page += 1

    def plant_power_day(self, plant_id: int, day: date) -> List[Tuple[datetime, float]]:
        """Growatt's 5-minute AC power curve (W) of a plant for one day (`plant/power`), oldest
        first, plant-local naive times. Slots Growatt answers as null (no upload, the future)
        are left out, never 0."""
        data = self._get("plant/power", use_cache=False, plant_id=plant_id, date=day.isoformat()) or {}
        out: List[Tuple[datetime, float]] = []
        for row in data.get("powers") or []:
            w = _f(row.get("power"))
            if w is None:
                continue
            try:
                ts = datetime.strptime(str(row.get("time")), "%Y-%m-%d %H:%M")
            except ValueError:
                continue
            out.append((ts, w))
        return sorted(out)

    def inverter_day_energy(self, device_sn: str, day: date) -> Optional[float]:
        """Growatt's energy (kWh) of one inverter for one day (`device/inverter/day_energy`)."""
        return _f(self._get("device/inverter/day_energy", use_cache=False, device_sn=device_sn, date=day.isoformat()))

    def plant_details(self, plant_id: int) -> Dict[str, Any]:
        """Static plant fields from `plant/details` worth keeping (most of its 51 are empty in
        this fleet): time zone, street address, Growatt's own inverter / datalogger counts."""
        d = self._get("plant/details", use_cache=False, plant_id=plant_id) or {}
        if not isinstance(d, dict):
            d = {}

        def count(rows: Any, key: str) -> Optional[int]:
            if not isinstance(rows, list):
                return None
            vals = [int(n) for r in rows if isinstance(r, dict) and (n := _f(r.get(key))) is not None]
            return sum(vals) if vals else None

        address = ", ".join(t for t in (_text(d.get("address1")), _text(d.get("address2"))) if t) or None
        return {
            "timezone": _text(d.get("timezone")),
            "address": address,
            "growatt_inverter_count": count(d.get("maxs"), "max_num"),
            "growatt_datalogger_count": count(d.get("dataloggers"), "datalogger_num"),
        }

    MAXS_PAGE = 50  # `device/max/maxs_data` answers about 50 serials per page (measured 15 Nov 2026)

    def maxs_latest(self, device_sns: List[str], max_pages: int = 10) -> Dict[str, Dict[str, Any]]:
        """Newest record of several MAX inverters in one call (`device/max/maxs_data`, POST),
        {serial: record}; the record has the same fields as `max_data` (`time` is plant-local)
        plus `dataloggerSn`. Realtime: the live services must not store it; only the worker's
        `inverter_latest` job does, as the record under its own `time`. Rate limited per account
        (about 4 calls, then 10012 until ≈ 5 min after the first)."""
        out: Dict[str, Dict[str, Any]] = {}
        wanted = set(device_sns)
        for page in range(1, max_pages + 1):
            data = self._request("POST", "device/max/maxs_data", {"maxs": ",".join(device_sns), "pageNum": page})
            batch = data if isinstance(data, dict) else {}
            for sn, v in batch.items():
                if not isinstance(v, dict):
                    continue
                rec = v.get(sn)
                if isinstance(rec, dict):
                    out[sn] = {**rec, "dataloggerSn": v.get("dataloggerSn")}
            if not batch or wanted <= set(out) or len(batch) < self.MAXS_PAGE:
                break
        return out

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

    def max_history_batch(self, device_sns: Sequence[str], day: date) -> Dict[str, List[Dict[str, Any]]]:
        """One day's records of several MAX inverters in one call
        (`new-api/queryDevicesHistoricalData`), {serial: records, newest first}.

        The records carry the fields `parse_max_records` reads under the same names as `max_data`
        (probed 15 Nov 2026: same 70 records and 952 string rows for one inverter-day; float32
        noise in `pac` only). The reply has no paging fields, so a caller must check that an
        inverter's records reach back as far as it needs and fall back to `max_history`. Rate
        limit and the largest accepted serial list were not measured."""
        data = self._new_api(
            "new-api/queryDevicesHistoricalData",
            {"deviceSn": ",".join(device_sns), "deviceType": "max", "date": day.isoformat()},
        )
        out: Dict[str, List[Dict[str, Any]]] = {}
        for sn, recs in (data if isinstance(data, dict) else {}).items():
            if isinstance(recs, list):
                out[str(sn)] = [r for r in recs if isinstance(r, dict)]
        return out

    def max_history_day(self, device_sn: str, day: date) -> Optional[List[Dict[str, Any]]]:
        """One day's records of one MAX inverter from `new-api/queryHistoricalData`, newest first
        (the `max_data` record fields). None when Growatt says more follow (`haveNext`): how it
        pages was not probed, so an incomplete answer is not used."""
        data = self._new_api(
            "new-api/queryHistoricalData", {"deviceSn": device_sn, "deviceType": "max", "date": day.isoformat()}
        )
        d = data if isinstance(data, dict) else {}
        if d.get("haveNext"):
            return None
        return [r for r in (d.get("datas") or []) if isinstance(r, dict)]

    def max_last_record(self, device_sn: str) -> Optional[Dict[str, Any]]:
        """Newest record of one MAX inverter (`device/max/max_last_data`, POST): the `max_data`
        record fields, `time` plant-local. None when there is none. Realtime: callers must not
        store it."""
        data = self._request("POST", "device/max/max_last_data", {"max_sn": device_sn})
        return data if isinstance(data, dict) and data.get("time") else None

    def device_datalogger(self, device_sn: str) -> Optional[str]:
        """Serial of the datalogger a device hangs on (`device/sn_datalog`, POST); None when
        Growatt names none."""
        data = self._request("POST", "device/sn_datalog", {"device_sn": device_sn})
        return _text(data.get("datalogSN")) if isinstance(data, dict) else None

    def list_dataloggers(self, plant_id: int) -> List[Dict[str, Any]]:
        """Dataloggers of one plant (`device/datalogger/list`): sn, model, `lost` and
        `last_update_time` (a Java date object; its `time` is epoch milliseconds). Realtime:
        callers must not store `lost` / `last_update_time`."""
        loggers: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._get("device/datalogger/list", use_cache=False, plant_id=plant_id, page=page, perpage=100) or {}
            batch = [d for d in (data.get("dataloggers") or []) if isinstance(d, dict)]
            loggers.extend(batch)
            if not batch or len(loggers) >= int(data.get("count") or 0):
                return loggers
            page += 1

    def devices_create_time(self, device_sns: Sequence[str], max_pages: int = 10) -> Dict[str, datetime]:
        """When each device was added to Growatt (`device/all/create_date`, POST, several serials
        per call), {serial: createTime}. Naive, as Growatt reports it (its time zone was not
        verified). Serials Growatt does not answer, or answers without a readable time, are absent."""
        out: Dict[str, datetime] = {}
        wanted = set(device_sns)
        seen: set = set()
        for page in range(1, max_pages + 1):
            data = self._request("POST", "device/all/create_date", {"pageNum": page, "devices": ",".join(device_sns)})
            batch = data if isinstance(data, dict) else {}
            new = set(batch) - seen
            seen |= new
            for sn in new:
                v = batch[sn]
                try:
                    out[str(sn)] = datetime.strptime(str(v.get("createTime"))[:19], "%Y-%m-%d %H:%M:%S")
                except (AttributeError, ValueError):
                    continue
            if not new or wanted <= seen:
                break
        return out

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

    # Energy meters ("ammeter"): device/list shows each as a type-3 device with `device_sn`
    # "meter"; `device/ammeter/meter_list` on its datalogger gives the bus address (e.g. 36 for
    # the CHNT three-phase meter at the grid connection point). Addressed like weather sensors.

    def list_meters(self, datalogger_sn: str, refresh: bool = False) -> List[Dict[str, Any]]:
        """Meters on one datalogger (`device/ammeter/meter_list`): address, device_name, device_type, lost."""
        meters: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._get("device/ammeter/meter_list", use_cache=not refresh, datalog_sn=datalogger_sn, page=page, perpage=100) or {}
            batch = data.get("meters") or []
            meters.extend(batch)
            if not batch or len(meters) >= int(data.get("count") or 0):
                return meters
            page += 1

    def meter_latest(self, datalogger_sn: str, address: int) -> Optional[Dict[str, Any]]:
        """Newest meter record (`device/ammeter/meter_last_data`), or None when the meter has none.
        Probed 15 Nov 2026 (CHNT_THREE, address 36): same field names as `meter_data`, `timeText`
        plant-local."""
        data = self._request("GET", "device/ammeter/meter_last_data", {"datalog_sn": datalogger_sn, "address": address})
        return data if isinstance(data, dict) and data.get("timeText") else None

    def meter_history(
        self, datalogger_sn: str, address: int, start_date: date, end_date: date, stop_before: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """Meter records between two dates (inclusive), newest first, 100 per page (about 245 a day).

        `stop_before` stops paging once a page reaches records older than it (incremental sync).
        """
        if (end_date - start_date).days > 6:
            raise ValueError("Growatt meter_data date range must not exceed 7 days")
        records: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._request(
                "GET",
                "device/ammeter/meter_data",
                {
                    "datalog_sn": datalogger_sn,
                    "address": address,
                    "start_date": start_date.strftime("%Y-%m-%d"),
                    "end_date": end_date.strftime("%Y-%m-%d"),
                    "page": page,
                    "perpage": 100,
                },
            ) or {}
            batch = data.get("meter_data") or []
            records.extend(batch)
            if not batch or len(records) >= int(data.get("count") or 0):
                return records
            oldest = _env_time(batch[-1])
            if stop_before is not None and oldest is not None and oldest < stop_before:
                return records
            page += 1


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
