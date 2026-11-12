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


def latest_max_record(client: "GrowattClient", device_sn: str, day: date) -> Optional[Dict[str, Any]]:
    """Newest `max_data` record of the day (first page, newest first) — one API call, no paging."""
    data = client._request(
        "POST",
        "device/max/max_data",
        {"max_sn": device_sn, "start_date": day.strftime("%Y-%m-%d"), "end_date": day.strftime("%Y-%m-%d"), "page": 1, "perpage": 100},
    ) or {}
    batch = data.get("datas") or []
    return batch[0] if batch else None


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
