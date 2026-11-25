"""Devices page (docs/plans/devices-page.md): fleet lists of inverters, meters and dataloggers.

DB only (`meta.source = "db"`), scoped by `allowed_plant_ids` (None = every plant). Live state
comes from the existing `/growatt/live/*` sweeps; nothing here calls Growatt or writes anything.
Missing values are null, never 0. Inverters marked not installed are listed only on request
(`include_not_installed`) and left out of every average.

The response shapes are fixed by `frontend/src/api/types/devices.ts`.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattAlarm,
    GrowattAlarmSync,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattIssue,
    GrowattMeter,
    GrowattMeterReading,
    GrowattPlant,
    GrowattStringLayout,
    SiteDevice,
    SiteRegister,
    SyncRun,
)
from app.services.growatt_common import _bucket, _day_bounds, _integrate_kwh, _round

ACTIVE_ISSUE = ("open", "acknowledged")


# --------------------------------------------------------------------------- shared


def local_today(now: Optional[datetime] = None) -> date:
    """Plant-local today (the fleet is in one time zone, UTC+7)."""
    from app.services.growatt_issues import LOCAL

    return (now or datetime.now(timezone.utc)).astimezone(LOCAL).date()


def history_synced_at(db: Session) -> Optional[str]:
    """Start of the newest finished `history` run (UTC ISO), None when none finished."""
    started = db.scalar(
        select(SyncRun.started_at)
        .where(SyncRun.job == "history", SyncRun.status.in_(("ok", "partial")), SyncRun.finished_at.is_not(None))
        .order_by(SyncRun.finished_at.desc())
        .limit(1)
    )
    if started is None:
        return None
    # SQLite returns naive datetimes; they were stored as UTC
    return (started if started.tzinfo else started.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()


def meta(db: Session, today: date) -> Dict[str, Any]:
    return {"source": "db", "day": today.isoformat(), "synced_at": history_synced_at(db)}


def _local_iso(ts: Optional[datetime]) -> Optional[str]:
    """Plant-local naive timestamp → "YYYY-MM-DDTHH:MM:SS"."""
    return ts.replace(microsecond=0).isoformat() if ts else None


def _scoped(col: Any, plant_ids: Optional[Set[int]]) -> List[Any]:
    """WHERE clauses limiting `col` to the user's plants (an empty set matches nothing)."""
    return [] if plant_ids is None else [col.in_(sorted(plant_ids) or [-1])]


def _plants(db: Session, plant_ids: Optional[Set[int]]) -> Dict[int, GrowattPlant]:
    q = select(GrowattPlant).where(*_scoped(GrowattPlant.plant_id, plant_ids))
    return {p.plant_id: p for p in db.scalars(q)}


def _register(db: Session, plant_ids: Iterable[int]) -> Dict[int, Tuple[Optional[str], Optional[str]]]:
    """{plant_id: (site_code, province)} of the matched site-register stations."""
    ids = sorted(set(plant_ids))
    if not ids:
        return {}
    q = select(SiteRegister.plant_id, SiteRegister.site_code, SiteRegister.province).where(SiteRegister.plant_id.in_(ids))
    return {int(pid): (code, prov) for pid, code, prov in db.execute(q) if pid is not None}


def _province(plant: GrowattPlant, reg: Dict[int, Tuple[Optional[str], Optional[str]]]) -> Optional[str]:
    """Site register province, else Growatt `city`."""
    prov = reg.get(plant.plant_id, (None, None))[1]
    return prov or plant.city or None


def _register_logger_sn(db: Session, plant_ids: Iterable[int]) -> Dict[int, str]:
    """{plant_id: logger SN} from the site register's datalogger device (lowest seq) of the plant's station."""
    ids = sorted(set(plant_ids))
    if not ids:
        return {}
    q = (
        select(SiteRegister.plant_id, SiteDevice.serial)
        .join(SiteDevice, SiteDevice.site_code == SiteRegister.site_code)
        .where(SiteRegister.plant_id.in_(ids), SiteDevice.kind == "datalogger", SiteDevice.serial.is_not(None))
        .order_by(SiteRegister.plant_id, SiteDevice.seq)
    )
    out: Dict[int, str] = {}
    for pid, serial in db.execute(q):
        sn = (serial or "").strip()
        if pid is not None and sn and int(pid) not in out:
            out[int(pid)] = sn
    return out


def register_match(register_sn: Optional[str], serial: str) -> Optional[str]:
    """"match" / "prefix" (the register SN is the serial truncated) / "differs"; None without a register SN."""
    reg = (register_sn or "").strip().upper()
    if not reg:
        return None
    sn = serial.strip().upper()
    if reg == sn:
        return "match"
    if sn.startswith(reg):
        return "prefix"
    return "differs"


# --------------------------------------------------------------------------- inverters


def _yield_today(db: Session, sns: List[str], today: date) -> Dict[str, float]:
    """{serial: eac_today of its newest record today} in one grouped query (no record today = absent)."""
    if not sns:
        return {}
    R = GrowattInverterReading
    start, end = _day_bounds(today)
    newest = (
        select(R.device_sn.label("sn"), func.max(R.timestamp).label("ts"))
        .where(R.timestamp >= start, R.timestamp < end, R.eac_today_kwh.is_not(None))
        .group_by(R.device_sn)
        .subquery()
    )
    q = select(R.device_sn, R.eac_today_kwh).join(newest, (R.device_sn == newest.c.sn) & (R.timestamp == newest.c.ts))
    want = set(sns)
    return {str(sn): float(v) for sn, v in db.execute(q) if sn in want and v is not None}


def _issues(db: Session, plant_ids: Optional[Set[int]]) -> Dict[str, Tuple[int, Optional[str]]]:
    """{serial: (active issue count, highest tier)}. Shadow issues are left out for everyone (engineers
    never see them; admins get the same counts, like the Energy & Billing figures)."""
    from app.services.growatt_rules import TIER_ORDER

    q = select(GrowattIssue.device_sn, GrowattIssue.tier).where(
        GrowattIssue.status.in_(ACTIVE_ISSUE),
        GrowattIssue.shadow.is_(False),
        GrowattIssue.device_sn.is_not(None),
        *_scoped(GrowattIssue.plant_id, plant_ids),
    )
    count: Counter[str] = Counter()
    top: Dict[str, str] = {}
    for sn, tier in db.execute(q):
        if sn is None:
            continue
        count[sn] += 1
        if sn not in top or TIER_ORDER.get(tier, 9) < TIER_ORDER.get(top[sn], 9):
            top[sn] = tier
    return {sn: (n, top.get(sn)) for sn, n in count.items()}


def _alarms_today(db: Session, plant_ids: Optional[Set[int]], today: date) -> Dict[str, Tuple[int, int]]:
    """{serial: (records today, still open)} for every inverter whose alarm log was read today;
    an inverter not read today is absent (the API answers null, never 0)."""
    synced = set(
        db.scalars(select(GrowattAlarmSync.device_sn).where(GrowattAlarmSync.day == today, *_scoped(GrowattAlarmSync.plant_id, plant_ids)))
    )
    out: Dict[str, Tuple[int, int]] = {sn: (0, 0) for sn in synced}
    # total and open (no end time) records per inverter: count(end_time) skips the nulls
    q = (
        select(GrowattAlarm.device_sn, func.count(), func.count(GrowattAlarm.end_time))
        .where(GrowattAlarm.day == today, *_scoped(GrowattAlarm.plant_id, plant_ids))
        .group_by(GrowattAlarm.device_sn)
    )
    for sn, n, ended in db.execute(q):
        if sn in out:
            out[sn] = (int(n), int(n) - int(ended))
    return out


def list_inverters(
    db: Session, plant_ids: Optional[Set[int]], include_not_installed: bool = False, now: Optional[datetime] = None
) -> Dict[str, Any]:
    from app.services.daily_checks import inverter_label, left_out

    today = local_today(now)
    plants = _plants(db, plant_ids)
    invs = list(
        db.scalars(
            select(GrowattInverter)
            .where(*_scoped(GrowattInverter.plant_id, plant_ids))
            .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
        )
    )
    invs = [i for i in invs if i.plant_id in plants]
    installed = [i for i in invs if i.installed]
    summary = {
        "inverters": len(invs),
        "installed": len(installed),
        "not_installed": len(invs) - len(installed),
        "plants": len({i.plant_id for i in invs}),
    }
    rows = invs if include_not_installed else installed
    sns = [i.device_sn for i in rows]

    reg = _register(db, plants)
    yields = _yield_today(db, sns, today)
    issues = _issues(db, plant_ids)
    alarms = _alarms_today(db, plant_ids, today)
    with_layout = set(db.scalars(select(GrowattStringLayout.device_sn).where(GrowattStringLayout.device_sn.in_(sns or [""])).distinct()))

    # the plant's mean yield over its installed inverters with a yield today
    per_plant: Dict[int, List[float]] = defaultdict(list)
    for i in installed:
        if i.device_sn in yields:
            per_plant[i.plant_id].append(yields[i.device_sn])
    plant_mean = {pid: sum(v) / len(v) for pid, v in per_plant.items() if v}
    # "INV1" for a plant's only inverter (as the daily checks name it)
    counted = Counter(i.plant_id for i in invs if not left_out(i))

    out: List[Dict[str, Any]] = []
    for i in rows:
        p = plants[i.plant_id]
        y = yields.get(i.device_sn)
        mean = plant_mean.get(i.plant_id)
        pct = round(y / mean * 100.0, 1) if y is not None and i.installed and mean else None
        n_issues, top = issues.get(i.device_sn, (0, None))
        alarm = alarms.get(i.device_sn)
        rated_w = i.nominal_power_w or i.rated_power_w
        out.append(
            {
                "device_sn": i.device_sn,
                "plant_id": i.plant_id,
                "plant_name": p.name,
                "phase": p.phase,
                "province": _province(p, reg),
                "site_code": reg.get(i.plant_id, (None, None))[0],
                "label": inverter_label(i, sole=counted[i.plant_id] == 1),
                "alias": i.alias,
                "model": i.model,
                "device_model": i.device_model,
                "rated_kw": round(rated_w / 1000.0, 1) if rated_w else None,
                "fw_version": i.fw_version,
                "datalogger_sn": i.datalogger_sn,
                "datalogger_model": i.datalogger_model,
                "growatt_created_at": i.growatt_created_at.strftime("%Y-%m-%d %H:%M:%S") if i.growatt_created_at else None,
                "power_limit_pct": i.active_limit_pct,
                "power_limit_source": (
                    "read_power" if i.power_limit_pct is not None else "max_data_info" if i.active_rate_pct is not None else None
                ),
                "on_off": i.on_off,
                "last_record": _local_iso(i.history_synced_until),
                "yield_today_kwh": _round(y, 2),
                "pct_of_plant_avg": pct,
                "open_issues": n_issues,
                "top_tier": top,
                "alarms_today": alarm[0] if alarm else None,
                "alarms_open": alarm[1] if alarm else None,
                "has_string_layout": i.device_sn in with_layout,
                "not_installed": (
                    {"at": i.not_installed_at.isoformat(), "by": i.not_installed_by, "note": i.not_installed_note}
                    if i.not_installed_at is not None
                    else None
                ),
            }
        )
    out.sort(key=lambda r: (r["phase"] is None, r["phase"] or 0, r["plant_name"], r["plant_id"], r["device_sn"]))
    return {"meta": meta(db, today), "inverters": out, "summary": summary}


# --------------------------------------------------------------------------- meters


def _meter_energy(rows: List[Tuple[datetime, Optional[float], Optional[float]]]) -> Tuple[Optional[float], Optional[float]]:
    """(import kWh, export kWh) of one meter's records of a day, by the rule of `growatt_meter.day_energy`:
    import from the import counter where it has at least two records (> 0), else integrated from the
    5-min slot means of the signed power; export integrated. Null when no slot has a value."""
    slots: Dict[datetime, List[float]] = defaultdict(list)
    counters: List[float] = []
    for ts, p, counter in rows:
        if p is not None:
            slots[_bucket(ts)].append(float(p))
        if counter is not None and counter > 0:
            counters.append(float(counter))
    pts = sorted((t, sum(v) / len(v)) for t, v in slots.items())
    imp: Optional[float] = None
    exp: Optional[float] = None
    if pts:
        imp = round(_integrate_kwh([(t, max(w, 0.0)) for t, w in pts]), 1)
        exp = round(_integrate_kwh([(t, max(-w, 0.0)) for t, w in pts]), 1)
    if len(counters) >= 2:
        imp = round(max(counters) - min(counters), 1)
    return imp, exp


def list_meters(db: Session, plant_ids: Optional[Set[int]], now: Optional[datetime] = None) -> Dict[str, Any]:
    today = local_today(now)
    plants = _plants(db, plant_ids)
    reg = _register(db, plants)
    meters = [m for m in db.scalars(select(GrowattMeter).where(*_scoped(GrowattMeter.plant_id, plant_ids))) if m.plant_id in plants]

    M = GrowattMeterReading
    start, end = _day_bounds(today)
    recs: Dict[Tuple[str, int], List[Tuple[datetime, Optional[float], Optional[float]]]] = defaultdict(list)
    if meters:
        q = (
            select(M.datalogger_sn, M.address, M.timestamp, M.active_power_w, M.import_counter_kwh)
            .where(M.timestamp >= start, M.timestamp < end, M.datalogger_sn.in_(sorted({m.datalogger_sn for m in meters})))
            .order_by(M.timestamp)
        )
        for dl, addr, ts, p, counter in db.execute(q):
            recs[(str(dl), int(addr))].append((ts, p, counter))

    out: List[Dict[str, Any]] = []
    for m in meters:
        p = plants[m.plant_id]
        rows = recs.get((m.datalogger_sn, int(m.address)), [])
        imp, exp = _meter_energy(rows)
        out.append(
            {
                "plant_id": m.plant_id,
                "plant_name": p.name,
                "phase": p.phase,
                "province": _province(p, reg),
                "datalogger_sn": m.datalogger_sn,
                "address": int(m.address),
                "device_name": m.device_name,
                "device_type": m.device_type,
                "last_record": _local_iso(m.history_synced_until),
                "import_today_kwh": imp,
                "export_today_kwh": exp,
                "records_today": len(rows),
            }
        )
    out.sort(key=lambda r: (r["phase"] is None, r["phase"] or 0, r["plant_name"], r["plant_id"], r["datalogger_sn"], r["address"]))
    with_meter = {m.plant_id for m in meters}
    without = sorted(
        ({"plant_id": pid, "plant_name": p.name} for pid, p in plants.items() if pid not in with_meter),
        key=lambda r: (r["plant_name"], r["plant_id"]),
    )
    return {"meta": meta(db, today), "meters": out, "plants_without_meter": without}


# --------------------------------------------------------------------------- dataloggers


def list_dataloggers(db: Session, plant_ids: Optional[Set[int]], now: Optional[datetime] = None) -> Dict[str, Any]:
    from app.db.models import inverter_installed

    today = local_today(now)
    plants = _plants(db, plant_ids)
    reg = _register(db, plants)
    reg_sn = _register_logger_sn(db, plants)

    # (serial, plant) → what is behind it
    acc: Dict[Tuple[str, int], Dict[str, Any]] = {}

    def entry(sn: Optional[str], pid: int) -> Optional[Dict[str, Any]]:
        sn = (sn or "").strip()
        if not sn or pid not in plants:
            return None
        return acc.setdefault((sn, pid), {"inverters": 0, "sensors": 0, "meters": 0, "models": Counter(), "last": None})

    def seen(e: Dict[str, Any], ts: Optional[datetime]) -> None:
        if ts is not None and (e["last"] is None or ts > e["last"]):
            e["last"] = ts

    inv_q = select(GrowattInverter.datalogger_sn, GrowattInverter.plant_id, GrowattInverter.datalogger_model, GrowattInverter.history_synced_until).where(
        inverter_installed(), *_scoped(GrowattInverter.plant_id, plant_ids)
    )
    for sn, pid, model, last in db.execute(inv_q):
        e = entry(sn, int(pid))
        if e is None:
            continue
        e["inverters"] += 1
        if model:
            e["models"][model] += 1
        seen(e, last)
    for kind, model_cls in (("sensors", GrowattEnvSensor), ("meters", GrowattMeter)):
        q = select(model_cls.datalogger_sn, model_cls.plant_id, model_cls.history_synced_until).where(*_scoped(model_cls.plant_id, plant_ids))
        for sn, pid, last in db.execute(q):
            e = entry(sn, int(pid))
            if e is None:
                continue
            e[kind] += 1
            seen(e, last)

    # The register names one logger per station; a plant may have more (one behind a sensor or meter).
    # "differs" only when none of the plant's serials matches it; the other serials of a matched plant
    # get null (same rule as the site register's logger_sn_differs check).
    matched_plants: Set[int] = {
        pid for (sn, pid) in acc if register_match(reg_sn.get(pid), sn) in ("match", "prefix")
    }

    out: List[Dict[str, Any]] = []
    found: Counter[int] = Counter()
    for (sn, pid), e in acc.items():
        p = plants[pid]
        found[pid] += 1
        rsn = reg_sn.get(pid)
        rm = register_match(rsn, sn)
        if rm == "differs" and pid in matched_plants:
            rm = None
        out.append(
            {
                "datalogger_sn": sn,
                "plant_id": pid,
                "plant_name": p.name,
                "phase": p.phase,
                "province": _province(p, reg),
                "model": e["models"].most_common(1)[0][0] if e["models"] else None,
                "inverters": e["inverters"],
                "sensors": e["sensors"],
                "meters": e["meters"],
                "last_record": _local_iso(e["last"]),
                "register_sn": rsn,
                "register_match": rm,
            }
        )
    out.sort(key=lambda r: (r["phase"] is None, r["phase"] or 0, r["plant_name"], r["plant_id"], r["datalogger_sn"]))
    plant_rows = sorted(
        (
            {"plant_id": pid, "plant_name": p.name, "growatt_count": p.growatt_datalogger_count, "found": found.get(pid, 0)}
            for pid, p in plants.items()
        ),
        key=lambda r: (r["plant_name"], r["plant_id"]),
    )
    return {"meta": meta(db, today), "dataloggers": out, "plants": plant_rows}
