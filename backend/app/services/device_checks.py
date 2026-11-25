"""Device checks for the Devices page (docs/plans/devices-page.md §4.5): `GET /growatt/devices/checks`.

Computed on request from stored data only (DB, `meta.source = "db"`); nothing is stored and no
issue is opened. Every check carries its code, severity (warn / info), the device, an English
`reason` with the values behind it, those values in `params`, and the app path where it gets fixed.

Inverters marked not installed are left out entirely (`inverter_installed()`), from every check
and every count. The list is scoped to `plant_ids` (None = every plant).

Checks (thresholds in `DEVICE_CHECKS`, overridable through the `app_settings` key `device_checks`):

- `inverter_never_reported` (warn): installed, nothing ever stored (`history_synced_until` null),
  and added to Growatt more than `never_reported_days` ago. With no Growatt create date the age
  is unknown: it is listed as info (not judged as a fault).
- `inverter_silent` (warn): only in plant-local daylight (sunrise–sunset from the plant's
  coordinates, else `daylight_start_h`–`daylight_end_h`); the newest stored record is more than
  `silent_hours` behind the newest of the plant's other installed inverters, at least one of which
  has a record today. An inverter with nothing stored is `inverter_never_reported`'s, not this one's.
- `inverter_switched_off` (warn): configured `on_off` = 0. `inverter_limited` (info): configured
  active power limit below `limit_below_pct`.
- `nameplate_missing` (info): `nominal_power_w` and `rated_power_w` both null.
- `info_not_read` (info): `info_synced_at` / `param_synced_at` null or older than
  `info_stale_factor` × the fleet job's refresh (`INFO_REFRESH_HOURS`, `PARAM_REFRESH_DAYS`).
- `firmware_minority` (info): the firmware differs from the one most installed inverters of the
  same `device_model` run (groups of >= `firmware_min_group` inverters with a firmware, one clear
  most common version; a tie judges nothing). The majority is taken over the whole fleet, so an
  engineer's few plants do not change it; only the inverters in scope are listed. A version with
  masked digits (`xx1.0`: Growatt did not read it) is unread: neither counted nor judged.
- `no_string_layout` (info, plant): one check per plant whose installed inverters lack String
  Layout rows, naming them (one per inverter would list nearly the whole fleet until layouts are entered).
- `inverter_count_mismatch` (info, plant): Growatt's entered inverter count matches neither the
  installed count nor the registry total (Growatt's count may or may not include an inverter
  marked not installed, so either agreeing is no mismatch).
- `logger_sn_mismatch` (warn, datalogger): the site register's own `logger_sn_differs` check.
- `no_meter` (info, plant): no registered energy meter. `meter_silent` (warn): in daylight, the
  meter's newest stored record is more than `meter_silent_hours` older than the last finished
  `history` run (the time stored data can reach; now when no run is known), or nothing was ever
  stored. Skipped when meter history is off (`METER_HISTORY_ENABLED`).
- `sensor_probe_missing` / `sensor_irradiance_zero_daylight` (warn): the weather-sensor list's
  stored-data flags for today (`growatt_sensors.list_sensors`), mapped one to one, not recomputed.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import AppSetting, GrowattInverter, GrowattMeter, GrowattPlant, GrowattStringLayout, inverter_installed
from app.services import growatt_sensors, site_register
from app.services.daily_checks import inverter_label
from app.services.growatt_sync import INFO_REFRESH_HOURS, PARAM_REFRESH_DAYS
from app.services.jobs import PLANT_TZ, _aware
from solar_core.sun import sun_times

SETTING_KEY = "device_checks"
PLANT_UTC_OFFSET_H = 7.0

DEVICE_CHECKS: Dict[str, float] = {
    "never_reported_days": 3,  # added to Growatt longer ago than this and nothing stored
    "silent_hours": 2,  # newest record this far behind the plant's other inverters
    "meter_silent_hours": 2,  # newest meter record this far behind the last history run
    "limit_below_pct": 100,  # configured active power limit under this = limited
    "info_stale_factor": 3,  # info / param read older than this × their refresh
    "firmware_min_group": 5,  # inverters of one device model with a firmware, at least
    "daylight_start_h": 6,  # daylight window when the plant has no coordinates (plant-local)
    "daylight_end_h": 18,
}

SEVERITY = {
    "inverter_never_reported": "warn",
    "inverter_silent": "warn",
    "inverter_switched_off": "warn",
    "inverter_limited": "info",
    "nameplate_missing": "info",
    "info_not_read": "info",
    "firmware_minority": "info",
    "no_string_layout": "info",
    "inverter_count_mismatch": "info",
    "logger_sn_mismatch": "warn",
    "no_meter": "info",
    "meter_silent": "warn",
    "sensor_probe_missing": "warn",
    "sensor_irradiance_zero_daylight": "warn",
}

SENSOR_FLAG_CODE = {
    "probe_missing": "sensor_probe_missing",
    "irradiance_zero_daylight": "sensor_irradiance_zero_daylight",
}


def thresholds(db: Session) -> Dict[str, float]:
    """`DEVICE_CHECKS` with the numeric overrides saved under `app_settings` `device_checks`."""
    row = db.get(AppSetting, SETTING_KEY)
    saved = row.value if row is not None and isinstance(row.value, dict) else {}
    out = dict(DEVICE_CHECKS)
    for k, v in saved.items():
        if k in DEVICE_CHECKS and isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = v
    return out


def _local(ts: Optional[datetime]) -> Optional[str]:
    return ts.strftime("%Y-%m-%dT%H:%M:%S") if ts else None


def _hours(td: timedelta) -> float:
    return round(td.total_seconds() / 3600.0, 1)


def fw_read(fw: Optional[str]) -> bool:
    """A firmware version Growatt actually read: not empty and no masked digits (`xx1.0`)."""
    return bool(fw) and "x" not in (fw or "").lower()


def _daylight(plant: GrowattPlant, day: date, th: Dict[str, float]) -> Tuple[datetime, datetime]:
    """Plant-local (sunrise, sunset) of `day` from the plant's coordinates, else the fallback hours.
    A plant at 0,0 has no location."""
    lat, lon = plant.latitude, plant.longitude
    if lat is not None and lon is not None and not (lat == 0 and lon == 0):
        st = sun_times(day, float(lat), float(lon), PLANT_UTC_OFFSET_H)
        if st:
            return st
    day0 = datetime.combine(day, time())
    return day0 + timedelta(hours=th["daylight_start_h"]), day0 + timedelta(hours=th["daylight_end_h"])


def _check(
    code: str,
    kind: str,
    plant: GrowattPlant,
    device_key: Optional[str],
    device_label: Optional[str],
    reason: str,
    params: Dict[str, Any],
    fix_path: Optional[str],
    severity: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "code": code,
        "severity": severity or SEVERITY[code],
        "kind": kind,
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        "device_key": device_key,
        "device_label": device_label,
        "reason": reason,
        "params": params,
        "fix_path": fix_path,
    }


@dataclass
class _Ctx:
    """What every group of checks reads: the plants in scope, their installed inverters, the clock."""

    db: Session
    plant_ids: Optional[Set[int]]
    th: Dict[str, float]
    now_utc: datetime
    now_local: datetime
    plants: Dict[int, GrowattPlant]
    by_plant: Dict[int, List[GrowattInverter]]
    daylight: Dict[int, Tuple[datetime, datetime]]
    synced: Optional[datetime]  # start (UTC) of the newest finished `history` run

    @property
    def pids(self) -> List[int]:
        return list(self.plants) or [-1]

    def in_daylight(self, pid: int) -> bool:
        rise, sset = self.daylight[pid]
        return rise <= self.now_local < sset


def _context(db: Session, plant_ids: Optional[Set[int]], now: Optional[datetime]) -> _Ctx:
    now_utc = now if now is not None else datetime.now(timezone.utc)
    now_utc = now_utc.replace(tzinfo=timezone.utc) if now_utc.tzinfo is None else now_utc.astimezone(timezone.utc)
    now_local = now_utc.astimezone(PLANT_TZ).replace(tzinfo=None)
    th = thresholds(db)

    pq = select(GrowattPlant).order_by(GrowattPlant.name)
    if plant_ids is not None:
        pq = pq.where(GrowattPlant.plant_id.in_(list(plant_ids) or [-1]))
    plants: Dict[int, GrowattPlant] = {p.plant_id: p for p in db.scalars(pq)}
    by_plant: Dict[int, List[GrowattInverter]] = defaultdict(list)
    for i in db.scalars(
        select(GrowattInverter)
        .where(GrowattInverter.plant_id.in_(list(plants) or [-1]), inverter_installed())
        .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
    ):
        by_plant[i.plant_id].append(i)
    return _Ctx(
        db=db,
        plant_ids=plant_ids,
        th=th,
        now_utc=now_utc,
        now_local=now_local,
        plants=plants,
        by_plant=by_plant,
        daylight={pid: _daylight(p, now_local.date(), th) for pid, p in plants.items()},
        synced=growatt_sensors.last_env_sync(db),
    )


def _firmware_majority(db: Session, th: Dict[str, float]) -> Dict[str, Tuple[str, int, int]]:
    """{device model: (firmware most of them run, inverters on it, inverters in the group)} over the whole
    installed fleet; groups under `firmware_min_group` and ties are left out."""
    fleet_fw: Dict[str, Counter[str]] = defaultdict(Counter)
    for dm, fw in db.execute(
        select(GrowattInverter.device_model, GrowattInverter.fw_version).where(
            inverter_installed(), GrowattInverter.device_model.is_not(None), GrowattInverter.fw_version.is_not(None)
        )
    ):
        if dm and fw and fw_read(fw):
            fleet_fw[dm][fw] += 1
    out: Dict[str, Tuple[str, int, int]] = {}
    for dm, cnt in fleet_fw.items():
        total = sum(cnt.values())
        top = cnt.most_common(2)
        if total >= th["firmware_min_group"] and len(top) > 1 and top[0][1] > top[1][1]:
            out[dm] = (top[0][0], top[0][1], total)
    return out


def _reporting_checks(
    c: _Ctx, inv: GrowattInverter, label: str, newest_today: Dict[str, datetime], judge_silent: bool
) -> List[Tuple[str, str, Dict[str, Any], Optional[str]]]:
    """`inverter_never_reported` / `inverter_silent` of one inverter: (code, reason, params, severity)."""
    th, sn = c.th, inv.device_sn
    last, created = inv.history_synced_until, inv.growatt_created_at
    if last is None:
        if created is None:
            return [
                (
                    "inverter_never_reported",
                    f"{label} ({sn}): no record stored, and Growatt gives no create date to tell how long it has been listed",
                    {"growatt_created_at": None, "days": None},
                    "info",
                )
            ]
        if created < c.now_local - timedelta(days=th["never_reported_days"]):
            days = (c.now_local - created).days
            return [
                (
                    "inverter_never_reported",
                    f"{label} ({sn}): no record stored since it was added to Growatt on {created.date().isoformat()} "
                    f"({days} days ago): mark it not installed, or check it on site",
                    {"growatt_created_at": _local(created), "days": days},
                    None,
                )
            ]
        return []
    if not judge_silent:
        return []
    others = [t for s, t in newest_today.items() if s != sn and t is not None]
    if not others:
        return []
    ref = max(others)
    gap = ref - last
    if gap <= timedelta(hours=th["silent_hours"]):
        return []
    return [
        (
            "inverter_silent",
            f"{label} ({sn}): newest stored record {_local(last)}, {_hours(gap)} h behind the plant's other "
            f"inverters (newest {_local(ref)}); more than {th['silent_hours']:g} h",
            {"last_record": _local(last), "plant_newest": _local(ref), "behind_h": _hours(gap), "limit_h": th["silent_hours"]},
            None,
        )
    ]


def _setting_checks(
    c: _Ctx, inv: GrowattInverter, label: str, fw_major: Dict[str, Tuple[str, int, int]]
) -> List[Tuple[str, str, Dict[str, Any], Optional[str]]]:
    """Switched off, limited, nameplate missing, info not read, firmware minority of one inverter."""
    th, sn = c.th, inv.device_sn
    out: List[Tuple[str, str, Dict[str, Any], Optional[str]]] = []
    if inv.on_off == 0:
        out.append(("inverter_switched_off", f"{label} ({sn}) is switched off in its settings (on/off = 0)", {"on_off": 0}, None))
    lim = inv.active_limit_pct
    if lim is not None and lim < th["limit_below_pct"]:
        src = "read_power" if inv.power_limit_pct is not None else "max_data_info"
        out.append(("inverter_limited", f"{label} ({sn}): active power limit set to {lim:g} % (configured, {src})", {"limit_pct": lim, "source": src}, None))
    if inv.nominal_power_w is None and inv.rated_power_w is None:
        out.append(
            (
                "nameplate_missing",
                f"{label} ({sn}): no rated power from Growatt (nominal and model rating both missing): rated AC kW and the clipping checks are off",
                {"nominal_power_w": None, "rated_power_w": None},
                None,
            )
        )

    info_at, param_at = _aware(inv.info_synced_at), _aware(inv.param_synced_at)
    info_cut = c.now_utc - timedelta(hours=INFO_REFRESH_HOURS * th["info_stale_factor"])
    param_cut = c.now_utc - timedelta(days=PARAM_REFRESH_DAYS * th["info_stale_factor"])
    stale: List[str] = []
    if info_at is None or info_at < info_cut:
        stale.append(
            f"inverter info {'never read' if info_at is None else 'last read ' + info_at.isoformat(timespec='minutes')} "
            f"(refresh every {INFO_REFRESH_HOURS} h)"
        )
    if param_at is None or param_at < param_cut:
        stale.append(
            f"model parameters {'never read' if param_at is None else 'last read ' + param_at.isoformat(timespec='minutes')} "
            f"(refresh every {PARAM_REFRESH_DAYS} days)"
        )
    if stale:
        out.append(
            (
                "info_not_read",
                f"{label} ({sn}): " + "; ".join(stale),
                {
                    "info_synced_at": info_at.isoformat() if info_at else None,
                    "param_synced_at": param_at.isoformat() if param_at else None,
                    "info_refresh_h": INFO_REFRESH_HOURS,
                    "param_refresh_days": PARAM_REFRESH_DAYS,
                    "factor": th["info_stale_factor"],
                },
                None,
            )
        )

    maj = fw_major.get(inv.device_model or "")
    if maj and fw_read(inv.fw_version) and inv.fw_version != maj[0]:
        out.append(
            (
                "firmware_minority",
                f"{label} ({sn}): firmware {inv.fw_version}, while {maj[1]} of {maj[2]} {inv.device_model} inverters run {maj[0]}",
                {"fw_version": inv.fw_version, "majority_fw": maj[0], "majority": maj[1], "group": maj[2], "device_model": inv.device_model},
                None,
            )
        )
    return out


def _inverter_checks(c: _Ctx) -> List[Dict[str, Any]]:
    """Every per-inverter check, and `no_string_layout` (one per plant)."""
    sns = [i.device_sn for plist in c.by_plant.values() for i in plist]
    with_layout: Set[str] = (
        set(c.db.scalars(select(GrowattStringLayout.device_sn).where(GrowattStringLayout.device_sn.in_(sns)).distinct())) if sns else set()
    )
    fw_major = _firmware_majority(c.db, c.th)
    day_start = datetime.combine(c.now_local.date(), time())

    checks: List[Dict[str, Any]] = []
    for pid, plist in c.by_plant.items():
        plant = c.plants[pid]
        sole = len(plist) == 1
        newest_today = {i.device_sn: i.history_synced_until for i in plist if i.history_synced_until and i.history_synced_until >= day_start}
        judge_silent = c.in_daylight(pid)
        for inv in plist:
            label = inverter_label(inv, sole)
            found = _reporting_checks(c, inv, label, newest_today, judge_silent) + _setting_checks(c, inv, label, fw_major)
            for code, reason, params, severity in found:
                checks.append(_check(code, "inverter", plant, inv.device_sn, label, reason, params, f"/plant/{pid}/inverters?sn={inv.device_sn}", severity))

        no_layout = [(inverter_label(i, sole), i.device_sn) for i in plist if i.device_sn not in with_layout]
        if no_layout:
            names = ", ".join(f"{lab} ({sn})" if lab != sn else sn for lab, sn in no_layout)
            checks.append(
                _check(
                    "no_string_layout",
                    "plant",
                    plant,
                    None,
                    None,
                    f"{len(no_layout)} of {len(plist)} installed inverters have no String Layout ({names}): "
                    "voltage per module and per-kWp peer checks stay off",
                    {"missing": len(no_layout), "installed": len(plist), "inverters": ", ".join(sn for _l, sn in no_layout)},
                    f"/plant/{pid}/string-layout?inv={no_layout[0][1]}",
                )
            )
    return checks


def _plant_checks(c: _Ctx) -> List[Dict[str, Any]]:
    """`inverter_count_mismatch`, `no_meter` and `meter_silent`."""
    th = c.th
    # registry total per plant, not installed included (Growatt lists those too)
    registry_total: Counter[int] = Counter(c.db.scalars(select(GrowattInverter.plant_id).where(GrowattInverter.plant_id.in_(c.pids))))
    meters: Dict[int, List[GrowattMeter]] = defaultdict(list)
    for m in c.db.scalars(select(GrowattMeter).where(GrowattMeter.plant_id.in_(c.pids)).order_by(GrowattMeter.datalogger_sn, GrowattMeter.address)):
        meters[m.plant_id].append(m)
    meter_gap = timedelta(hours=th["meter_silent_hours"])
    synced_local = c.synced.astimezone(PLANT_TZ).replace(tzinfo=None) if c.synced else None
    meter_ref = min(c.now_local, synced_local) if synced_local else c.now_local

    checks: List[Dict[str, Any]] = []
    for pid, plant in c.plants.items():
        n = len(c.by_plant.get(pid, ()))
        total = registry_total.get(pid, 0)
        gc = plant.growatt_inverter_count
        if gc is not None and gc not in (n, total):
            extra = f" ({total} with those marked not installed)" if total != n else ""
            checks.append(
                _check(
                    "inverter_count_mismatch",
                    "plant",
                    plant,
                    None,
                    None,
                    f"{n} installed inverters in the registry{extra}, {gc} entered in Growatt",
                    {"installed": n, "registry_total": total, "growatt_count": gc},
                    f"/plant/{pid}/inverters",
                )
            )
        if not meters.get(pid):
            checks.append(
                _check("no_meter", "plant", plant, None, None, "No energy meter registered in Growatt: grid import / export are not measured", {}, f"/plant/{pid}")
            )
            continue
        if not settings.meter_history_enabled or not c.in_daylight(pid):
            continue
        for m in meters[pid]:
            key = f"{m.datalogger_sn}:{m.address}"
            last = m.history_synced_until
            if last is None:
                reason = f"Meter {m.device_name or key}: no record ever stored (never stored since it was registered)"
                params: Dict[str, Any] = {"last_record": None, "behind_h": None, "limit_h": th["meter_silent_hours"]}
            elif meter_ref - last > meter_gap:
                reason = (
                    f"Meter {m.device_name or key}: newest stored record {_local(last)}, {_hours(meter_ref - last)} h before "
                    f"{_local(meter_ref)}; more than {th['meter_silent_hours']:g} h"
                )
                params = {"last_record": _local(last), "reference": _local(meter_ref), "behind_h": _hours(meter_ref - last), "limit_h": th["meter_silent_hours"]}
            else:
                continue
            checks.append(_check("meter_silent", "meter", plant, key, m.device_name, reason, params, f"/plant/{pid}"))
    return checks


def _register_checks(c: _Ctx) -> List[Dict[str, Any]]:
    """`logger_sn_mismatch`: the site register's own `logger_sn_differs` check."""
    regs = [r for r in site_register.list_all(c.db, c.plant_ids) if r.get("plant_id") in c.plants]
    growatt_info = site_register._growatt_info(c.db, [r["plant_id"] for r in regs])  # pyright: ignore[reportPrivateUsage]
    checks: List[Dict[str, Any]] = []
    for r in regs:
        for chk in r["checks"]:
            if chk.get("key") != "logger_sn_differs":
                continue
            pid = r["plant_id"]
            reg_sn = (r.get("logger_sn") or "").strip().upper() or None
            checks.append(
                _check(
                    "logger_sn_mismatch",
                    "datalogger",
                    c.plants[pid],
                    reg_sn,
                    f"Site register {r['site_code']}",
                    f"Site register {r['site_code']}: {chk['text']}",
                    {
                        "site_code": r["site_code"],
                        "register_sn": reg_sn,
                        "growatt_sns": ", ".join(growatt_info.get(pid, {}).get("logger_sns", [])) or None,
                    },
                    f"/plant/{pid}/documents",
                )
            )
    return checks


def _sensor_checks(c: _Ctx) -> List[Dict[str, Any]]:
    """The weather-sensor list's own stored-data flags for today, mapped one to one."""
    now_local = c.now_local
    sens = growatt_sensors.list_sensors(c.db, c.plant_ids, now_local=lambda: now_local)
    checks: List[Dict[str, Any]] = []
    for s in sens["sensors"]:
        splant = c.plants.get(s["plant_id"])
        if splant is None:
            continue
        for f in s["flags"]:
            code = SENSOR_FLAG_CODE.get(f["code"])
            if code is None:
                continue
            checks.append(
                _check(
                    code,
                    "sensor",
                    splant,
                    s["key"],
                    s["device_name"],
                    f"Sensor {s['device_name'] or s['key']}: {f['reason']}",
                    {"field": f.get("field"), **(f.get("params") or {})},
                    f"/plant/{splant.plant_id}/sensors?sensor={s['key']}",
                )
            )
    return checks


def build(
    db: Session,
    plant_ids: Optional[Set[int]],
    is_admin: bool,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """The `DeviceCheckList` (frontend/src/api/types/devices.ts) for the plants in `plant_ids`
    (None = all). `now` is aware (a naive value is taken as UTC); default now. `is_admin` is not
    used: no check reads issues."""
    del is_admin  # no check touches issues (engineers never see shadow ones; nothing to hide here)
    c = _context(db, plant_ids, now)
    checks = _inverter_checks(c) + _plant_checks(c) + _register_checks(c) + _sensor_checks(c)
    checks.sort(key=lambda x: (0 if x["severity"] == "warn" else 1, x["plant_name"].lower(), x["code"], x["device_key"] or ""))
    return {
        "meta": {
            "source": "db",
            "day": c.now_local.date().isoformat(),
            "synced_at": c.synced.isoformat() if c.synced else None,
            "thresholds": c.th,
        },
        "checks": checks,
        "summary": {
            "total": len(checks),
            "warn": sum(1 for x in checks if x["severity"] == "warn"),
            "info": sum(1 for x in checks if x["severity"] == "info"),
            "by_code": dict(Counter(x["code"] for x in checks)),
        },
    }
