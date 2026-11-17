"""Row builders: one Growatt answer → the fields a live feature serves. Realtime, never stored."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from solar_core.growatt import (
    ENV_FIELDS,
    METER_FIELDS,
    GrowattAPIError,
    GrowattClient,
    newest_max_records,
    parse_max_diagnostics,
    parse_max_grid,
    parse_max_mppt_energy,
    parse_max_records,
)
from app.services.growatt_live.core import GROWATT_SERVER_TZ, MAX_INTERVAL_S, MIN_INTERVAL_S, PLANT_TZ

def _alarm_row(sn: str, a: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "device_sn": sn,
        "start_time": a.get("start_time") or None,  # plant-local
        "end_time": a.get("end_time") or None,
        "alarm_code": a.get("alarm_code"),
        "alarm_message": a.get("alarm_message") or None,
        "fault_type": a.get("fault_type") or None,
        "status": a.get("status"),
    }


SNAPSHOT_CHUNK = 50  # `maxs_data` answers about 50 serials per page; one call per chunk


def _maxs_rows(client: GrowattClient, sns: List[str]) -> Dict[str, Dict[str, Any]]:
    """`maxs_data` → {serial: the fields the fleet views use}; realtime, never stored. A serial
    Growatt does not answer is absent (unknown), never filled in."""
    out: Dict[str, Dict[str, Any]] = {}
    for sn, rec in client.maxs_latest(sns).items():
        t = rec.get("time")
        status = rec.get("status")
        out[sn] = {
            "record_time": str(t)[:19] if t else None,  # plant-local, the record's own time
            "status": int(status) if isinstance(status, (int, float)) else None,
            "status_label": rec.get("statusText") or None,
            "pac_w": _f(rec.get("pac")),
            "ppv_w": _f(rec.get("ppv")),
            "eac_today_kwh": _f(rec.get("eacToday")),
            "temperature_c": _f(rec.get("temperature")),
            "fault_type": _f(rec.get("faultType")),
            "warn_code": _f(rec.get("warnCode")),
            "lost": _flag(rec.get("lost")),
            "datalogger_sn": rec.get("dataloggerSn") or rec.get("dataLogSn") or None,
        }
    return out


def _plant_data_row(client: GrowattClient, plant_id: int) -> Dict[str, Any]:
    """The `plant/data` fields the plant directory uses; `last_update_time` is plant-local."""
    d = client.plant_data(plant_id)
    upd = d.get("last_update_time")
    return {
        "today_energy_kwh": _f(d.get("today_energy")),
        "last_update_time": str(upd) if upd else None,
    }


def _env_row(client: GrowattClient, datalogger_sn: str, address: int) -> Optional[Dict[str, Any]]:
    rec = client.env_latest(datalogger_sn, address)
    if rec is None:
        return None
    return {
        "datalogger_sn": datalogger_sn,
        "address": address,
        "timestamp": str(rec.get("timeText")),  # plant-local
        "interval_s": None,  # set by `_env_fetch` from the previously cached record
        **{col: _f(rec.get(key)) for key, col in ENV_FIELDS.items()},
        # the record as reported, for the sensor Info view's "Raw record" (admin only; memory only)
        "raw": {str(k): v for k, v in rec.items() if isinstance(v, (str, int, float, bool)) or v is None},
    }


def _record_gap(prev: Dict[str, Any], row: Dict[str, Any]) -> Optional[float]:
    """Seconds between two consecutive records of one sensor (`interval_s`)."""
    try:
        a = datetime.strptime(str(prev["timestamp"]), "%Y-%m-%d %H:%M:%S")
        b = datetime.strptime(str(row["timestamp"]), "%Y-%m-%d %H:%M:%S")
    except (KeyError, TypeError, ValueError):
        return None
    gap = (b - a).total_seconds()
    if gap < 0:  # an older record than the cached one: Growatt glitch, measure again next time
        return None
    if MIN_INTERVAL_S <= gap <= MAX_INTERVAL_S:
        return gap
    return prev.get("interval_s")  # same record, or an outage gap: keep the rhythm already measured


def _meter_row(client: GrowattClient, datalogger_sn: str, address: int) -> Optional[Dict[str, Any]]:
    rec = client.meter_latest(datalogger_sn, address)
    if rec is None:
        return None
    return {
        "datalogger_sn": datalogger_sn,
        "address": address,
        "timestamp": str(rec.get("timeText")),  # plant-local
        "interval_s": None,  # set by `_interval_fetch` from the previously cached record
        "lost": _flag(rec.get("lost")),
        **{col: _f(rec.get(key)) for key, col in METER_FIELDS.items()},
    }


def _env_status_rows(client: GrowattClient, datalogger_sn: str) -> List[Dict[str, Any]]:
    """`env_list` → [{address, lost, last_update_time}]: realtime, never stored."""
    rows: List[Dict[str, Any]] = []
    for e in client.list_env_sensors(datalogger_sn, refresh=True):
        try:
            addr = int(str(e.get("address")))
        except ValueError:
            continue
        rows.append({"address": addr, "lost": _flag(e.get("lost")), "last_update_time": _local_ts(e.get("lastUpdateTime"))})
    return rows


def _datalogger_rows(client: GrowattClient, plant_id: int) -> List[Dict[str, Any]]:
    """`device/datalogger/list` → [{datalogger_sn, model, lost, last_update_time}]: realtime, never stored."""
    rows: List[Dict[str, Any]] = []
    for d in client.list_dataloggers(plant_id):
        sn = str(d.get("sn") or "").strip()
        if not sn:
            continue
        rows.append(
            {
                "datalogger_sn": sn,
                "model": str(d.get("model") or "").strip() or None,
                "lost": _flag(d.get("lost")),
                "last_update_time": _epoch_local(d.get("last_update_time")),
            }
        )
    return sorted(rows, key=lambda r: r["datalogger_sn"])


def _epoch_local(v: Any) -> Optional[str]:
    """A Java date object (`{"time": epoch ms, ...}`, as `device/datalogger/list` gives
    `last_update_time`) → plant-local "YYYY-MM-DD HH:MM:SS". Epoch milliseconds carry no time
    zone, so nothing is assumed; any other shape is None."""
    ms = v.get("time") if isinstance(v, dict) else None
    if isinstance(ms, bool) or not isinstance(ms, (int, float)) or ms <= 0:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(PLANT_TZ).strftime("%Y-%m-%d %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return None


def _flag(v: Any) -> Optional[bool]:
    t = str(v).strip().lower()
    return True if t in ("1", "true") else False if t in ("0", "false") else None


def _local_ts(v: Any) -> Optional[str]:
    """`env_list`'s `lastUpdateTime` → plant-local "YYYY-MM-DD HH:MM:SS"; else None.

    Unlike `timeText`, Growatt gives this one in China time (UTC+8, checked 2026-11-13: one hour
    ahead of the same upload's `timeText` at every sensor sampled), so it is converted to Bangkok.
    """
    try:
        at = datetime.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return at.replace(tzinfo=GROWATT_SERVER_TZ).astimezone(PLANT_TZ).strftime("%Y-%m-%d %H:%M:%S")


PREVIOUS_RECORDS = 5  # with the newest: 6 records ≈ 30 min a string fault must last


POWER_TAIL_RECORDS = 100  # the first page of `max_data`: today's newest ≈ 8 h at 5-min records


def _latest_row(client: GrowattClient, sn: str, day: date) -> Optional[Dict[str, Any]]:
    # same single call either way (first page = 100 records); the older ones let the live string
    # check require a fault to persist instead of flagging one passing cloud shadow
    page, source = _newest_records(client, sn, day)
    if not page:
        return None
    recs = page[: 1 + PREVIOUS_RECORDS]
    inv_rows, str_rows = parse_max_records(sn, recs[:1])
    previous = []
    for rec in recs[1:]:
        _, older = parse_max_records(sn, [rec])
        ts = _record_ts(rec)
        previous.append({
            "timestamp": ts.strftime("%Y-%m-%d %H:%M:%S") if ts else None,
            "strings": [{k: r[k] for k in ("string_no", "voltage_v", "current_a")} for r in older],
        })
    row = inv_rows[0]
    prev = _record_ts(recs[1]) if len(recs) > 1 else None
    return {
        "device_sn": sn,
        # which Growatt call gave the record: `max_data`, or (when that one refused) one of the
        # newest-record endpoints, which bring no older records (no persistence check, no power tail)
        "record_source": source,
        "timestamp": row["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),  # plant-local
        # gap to the previous record (Growatt timestamps); sets when the next one is due
        "interval_s": (row["timestamp"] - prev).total_seconds() if prev else None,
        "status": row["status"],
        "pac_w": row["pac_w"],
        "ppv_w": row["ppv_w"],
        "eac_today_kwh": row["eac_today_kwh"],
        "temperature_c": row["temperature_c"],
        "fac_hz": row["fac_hz"],
        "mppt": row["mppt_json"],
        "grid": parse_max_grid(recs[0]),
        "diagnostics": parse_max_diagnostics(recs[0]),
        "mppt_energy": parse_max_mppt_energy(recs[0]),
        "strings": [
            {k: r[k] for k in ("string_no", "mppt_no", "voltage_v", "current_a", "power_w")} for r in str_rows
        ],
        # older records, newest first: input to the live string check only (the route drops it)
        "previous_strings": previous,
        # today's power from the same page, oldest first: [timestamp, pac_w, ppv_w]. Lets the
        # overview chart draw past the newest stored record; memory only, never stored
        "power": _power_tail(page),
    }


def _newest_records(client: GrowattClient, sn: str, day: date) -> Tuple[List[Dict[str, Any]], str]:
    """Today's newest records of one inverter, newest first, and the call that gave them.

    `max_data` first (up to POWER_TAIL_RECORDS records). When it refuses (10012 inside the
    inverter's 4–5 min window, or any other Growatt error), the newest record alone is read from
    `device/max/max_last_data`, then `new-api/queryLastData` (same record fields, their own rate
    limits; not measured). A record of another day means no record today: []. If they refuse too,
    the `max_data` error stands."""
    try:
        return newest_max_records(client, sn, day, n=POWER_TAIL_RECORDS), "max_data"
    except GrowattAPIError as first:
        for source, name in (("max_last_data", "max_last_record"), ("queryLastData", "device_last_record")):
            try:
                rec = getattr(client, name)(sn)
            except Exception:  # refused as well, or a client without it: try the next one
                continue
            ts = _record_ts(rec) if rec else None
            if rec is None or ts is None:
                continue
            return ([rec] if ts.date() == day else []), source
        raise first


def _power_tail(recs: List[Dict[str, Any]]) -> List[List[Any]]:
    out = []
    for rec in recs:
        ts = _record_ts(rec)
        if ts is not None:
            out.append([ts.strftime("%Y-%m-%d %H:%M:%S"), _f(rec.get("pac")), _f(rec.get("ppv"))])
    out.sort(key=lambda r: r[0])
    return out


def _record_ts(rec: Dict[str, Any]) -> Optional[datetime]:
    try:
        return datetime.strptime(str(rec.get("time")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None
