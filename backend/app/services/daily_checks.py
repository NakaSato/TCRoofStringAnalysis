"""Inverter state at the daily O&M check times (09:00 / 13:00 / 17:00) for the PWA report.

Per check, from stored Growatt history only (never realtime):
- `offline`: inverters with no record within CHECK_NEAREST of hh:00 (datalogger / inverter silent)
- `fault`:   inverters whose nearest record has Growatt status 3 (fault)
- `alarms`:  "<INV> <message>" for Growatt alarm-log entries open at that time

Inverters named as replaced in Growatt ("INV 1 old", "GKLNF3901P(old)") are left out: they stay
listed under the plant but never report again, so they would read "offline" every day.

Published in the Firestore daily plant doc as `checks`; the report's Note column is built from it.
"""

from __future__ import annotations

import re
from datetime import date, datetime, time
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.db.models import GrowattAlarm, GrowattInverter, GrowattInverterReading
from app.services.growatt_weather import CHECK_HOURS, CHECK_NEAREST

FAULT_STATUS = 3  # Growatt MAX inverter status: 0 waiting, 1 normal, 3 fault
# Growatt's placeholder text for an unmapped code; it says nothing an engineer can act on
SKIP_ALARMS = {"undown error"}
REPLACED = re.compile(r"\bold\b", re.IGNORECASE)


def is_replaced(inv: GrowattInverter) -> bool:
    return bool(inv.alias and REPLACED.search(inv.alias))


def inverter_label(inv: GrowattInverter) -> str:
    """"INV3" from Growatt aliases such as "INVERTER 3", "inverter 3", "Inverter no.3", "Inverter03"."""
    m = re.search(r"(\d+)\s*$", inv.alias or "")
    if m:
        return f"INV{int(m.group(1))}"
    return inv.alias or inv.device_sn


def _sort_key(label: str) -> Tuple[int, str]:
    m = re.fullmatch(r"INV(\d+)", label)
    return (int(m.group(1)), "") if m else (10**6, label)


def build_checks(db: Session, plant_id: int, day: date) -> Optional[Dict[str, Dict[str, Any]]]:
    """{"09": {"inverters", "offline", "fault", "alarms"}, "13": …, "17": …}; None without inverters."""
    invs = [i for i in db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id)) if not is_replaced(i)]
    if not invs:
        return None
    label = {i.device_sn: inverter_label(i) for i in invs}
    sns = list(label)
    times = {h: datetime.combine(day, time(h)) for h in CHECK_HOURS}

    windows = [and_(GrowattInverterReading.timestamp >= t - CHECK_NEAREST, GrowattInverterReading.timestamp <= t + CHECK_NEAREST) for t in times.values()]
    nearest: Dict[Tuple[int, str], Tuple[datetime, Optional[int]]] = {}
    for sn, ts, status in db.execute(
        select(GrowattInverterReading.device_sn, GrowattInverterReading.timestamp, GrowattInverterReading.status)
        .where(GrowattInverterReading.device_sn.in_(sns), or_(*windows))
    ):
        for h, t in times.items():
            if abs(ts - t) <= CHECK_NEAREST:
                best = nearest.get((h, sn))
                if best is None or abs(ts - t) < abs(best[0] - t):
                    nearest[(h, sn)] = (ts, status)

    alarms = list(
        db.scalars(
            select(GrowattAlarm).where(GrowattAlarm.plant_id == plant_id, GrowattAlarm.day == day, GrowattAlarm.start_time.is_not(None))
        )
    )

    out: Dict[str, Dict[str, Any]] = {}
    for h, t in times.items():
        offline = sorted({label[sn] for sn in sns if (h, sn) not in nearest}, key=_sort_key)
        fault = sorted({label[sn] for sn in sns if (h, sn) in nearest and nearest[(h, sn)][1] == FAULT_STATUS}, key=_sort_key)
        open_now: List[str] = []
        for a in sorted(alarms, key=lambda a: (_sort_key(label.get(a.device_sn) or a.device_sn), a.start_time or t)):
            msg = (a.alarm_message or a.alarm_code or "").strip()
            if not msg or msg.lower() in SKIP_ALARMS:
                continue
            if a.start_time is not None and a.start_time <= t and (a.end_time is None or a.end_time >= t):
                text = f"{label.get(a.device_sn) or a.device_sn} {msg}"
                if text not in open_now:
                    open_now.append(text)
        out[f"{h:02d}"] = {"inverters": len(sns), "offline": offline, "fault": fault, "alarms": open_now}
    return out
