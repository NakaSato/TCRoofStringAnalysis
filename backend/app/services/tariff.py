"""Electricity tariff for pricing energy (docs/plans/decision-rules.md §4.1).

Stored in SQL `app_settings` key `tariff` and mirrored to Firestore `config/tariff`. Until an
admin saves it, `DEFAULT_TARIFF` is used with `source = "default"`: the TOU rates from the
research report (22–33 kV, on-peak Mon–Fri 09:00–22:00) plus Ft. Holidays are off-peak all day;
the default list holds only the fixed-date public holidays and must be completed by an admin
(lunar holidays and substitution days move every year).

A plant with an entry in `plant_rates` (e.g. a PPA price) is priced at that flat rate instead.
Every baht figure made with this is an **estimate** (it prices estimated lost kWh).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.db.models import AppSetting, GrowattInverter, GrowattInverterReading, GrowattPlant

TARIFF_KEY = "tariff"

DEFAULT_TARIFF: Dict[str, Any] = {
    "on_peak_thb": 4.1839,
    "off_peak_thb": 2.6037,
    "ft_thb": 0.1623,
    "on_peak_days": [0, 1, 2, 3, 4],  # Monday = 0
    "on_peak_start": "09:00",
    "on_peak_end": "22:00",
    "holidays": [
        "2026-08-12", "2026-10-13", "2026-10-23", "2026-12-05", "2026-12-10", "2026-12-31",
        "2027-01-01", "2027-04-06", "2027-04-13", "2027-04-14", "2027-04-15",
    ],
    "valid_from": "2026-09-01",
    "plant_rates": {},  # {"<plant_id>": {"thb_per_kwh": 3.5, "basis": "PPA"}}
}


def get_tariff(db: Session) -> Dict[str, Any]:
    row = db.get(AppSetting, TARIFF_KEY)
    if row is None or not isinstance(row.value, dict):
        return {**DEFAULT_TARIFF, "source": "default", "updated_by": None, "updated_at": None}
    return {
        **DEFAULT_TARIFF,
        **row.value,
        "source": "saved",
        "updated_by": row.updated_by,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def put_tariff(db: Session, value: Dict[str, Any], username: Optional[str]) -> Dict[str, Any]:
    clean = {k: value[k] for k in DEFAULT_TARIFF if k in value}
    row = db.get(AppSetting, TARIFF_KEY)
    if row is None:
        db.add(AppSetting(key=TARIFF_KEY, value=clean, updated_by=username))
    else:
        row.value = clean
        row.updated_by = username
    db.commit()
    return get_tariff(db)


def _hm(s: str) -> time:
    h, m = (int(x) for x in str(s).split(":", 1))
    return time(23, 59, 59) if h >= 24 else time(h, m)


class Pricer:
    """Prices kWh at a plant-local time. Built once per job from the tariff setting."""

    def __init__(self, cfg: Dict[str, Any]):
        self.on = float(cfg["on_peak_thb"])
        self.off = float(cfg["off_peak_thb"])
        self.ft = float(cfg.get("ft_thb") or 0.0)
        self.days = {int(d) for d in cfg.get("on_peak_days") or ()}
        self.start = _hm(cfg.get("on_peak_start") or "09:00")
        self.end = _hm(cfg.get("on_peak_end") or "22:00")
        self.holidays = {str(d) for d in cfg.get("holidays") or ()}
        self.plant_rates: Dict[str, Dict[str, Any]] = dict(cfg.get("plant_rates") or {})

    def is_on_peak(self, t: datetime) -> bool:
        if t.weekday() not in self.days or t.date().isoformat() in self.holidays:
            return False
        return self.start <= t.time() < self.end

    def plant_rate(self, plant_id: int) -> Optional[float]:
        r = self.plant_rates.get(str(plant_id))
        if isinstance(r, dict) and r.get("thb_per_kwh") is not None:
            return float(r["thb_per_kwh"])
        return None

    def thb(self, plant_id: int, kwh: Optional[float], on_peak_kwh: Optional[float]) -> Optional[float]:
        """Baht for `kwh`, of which `on_peak_kwh` fell in on-peak hours (None = unknown split:
        priced at off-peak, the lower rate, so the estimate is never inflated)."""
        if kwh is None:
            return None
        flat = self.plant_rate(plant_id)
        if flat is not None:
            return kwh * flat
        on = min(max(on_peak_kwh or 0.0, 0.0), kwh)
        return on * (self.on + self.ft) + (kwh - on) * (self.off + self.ft)

    def rate_at(self, plant_id: int, t: datetime) -> float:
        flat = self.plant_rate(plant_id)
        if flat is not None:
            return flat
        return (self.on if self.is_on_peak(t) else self.off) + self.ft

    def on_peak_window(self, day: date) -> Optional[Tuple[datetime, datetime]]:
        """The day's on-peak hours (plant-local), None on an off-peak day (weekend / holiday)."""
        if day.weekday() not in self.days or day.isoformat() in self.holidays:
            return None
        return datetime.combine(day, self.start), datetime.combine(day, self.end)

    def split_rate(self, plant_id: int, on_peak_share: Optional[float]) -> float:
        """THB/kWh for energy of which `on_peak_share` (0–1) fell on-peak; None = unknown split,
        priced at off-peak (never inflated). A plant's flat rate wins."""
        flat = self.plant_rate(plant_id)
        if flat is not None:
            return flat
        share = min(max(on_peak_share or 0.0, 0.0), 1.0)
        return share * (self.on + self.ft) + (1.0 - share) * (self.off + self.ft)

    def energy_weighted_rate(self, plant_id: int, points: List[Tuple[datetime, float]]) -> Optional[float]:
        """THB/kWh of a day's generation: the rate of each slot weighted by its power."""
        flat = self.plant_rate(plant_id)
        if flat is not None:
            return flat
        tot = sum(max(p, 0.0) for _, p in points)
        if tot <= 0:
            return None
        return sum(max(p, 0.0) * self.rate_at(plant_id, t) for t, p in points) / tot


def pricer(db: Session) -> Pricer:
    return Pricer(get_tariff(db))


def day_rates(db: Session, day: date, plant_ids: Optional[Iterable[int]] = None) -> Dict[int, Dict[str, Any]]:
    """THB/kWh of each plant's generation on `day`: its flat rate (`plant_rates`), else the TOU
    rate weighted by the on-peak share of its stored AC power that day (one aggregate query; the
    newest records may be up to a `history` interval behind). No stored power yet = off-peak
    rate with `on_peak_share` null (unknown split, never inflated). An estimate."""
    pr = pricer(db)
    q = select(GrowattPlant.plant_id)
    if plant_ids is not None:
        q = q.where(GrowattPlant.plant_id.in_(list(plant_ids)))
    pids = [int(p) for p in db.scalars(q)]
    R = GrowattInverterReading
    lo = datetime.combine(day, time(0, 0))
    hi = lo + timedelta(days=1)
    win = pr.on_peak_window(day)
    on_expr = case(((R.timestamp >= win[0]) & (R.timestamp < win[1]), R.pac_w), else_=0.0) if win else None
    cols = [GrowattInverter.plant_id, func.sum(R.pac_w)] + ([func.sum(on_expr)] if on_expr is not None else [])
    agg = (
        select(*cols)
        .join(GrowattInverter, GrowattInverter.device_sn == R.device_sn)
        .where(R.timestamp >= lo, R.timestamp < hi, R.pac_w > 0)
        .group_by(GrowattInverter.plant_id)
    )
    if plant_ids is not None:
        agg = agg.where(GrowattInverter.plant_id.in_(pids))
    shares: Dict[int, float] = {}
    for row in db.execute(agg):
        tot = float(row[1] or 0.0)
        if tot > 0:
            shares[int(row[0])] = (float(row[2] or 0.0) / tot) if win else 0.0
    out: Dict[int, Dict[str, Any]] = {}
    for pid in pids:
        flat = pr.plant_rate(pid)
        share = shares.get(pid)
        out[pid] = {
            "thb_per_kwh": round(pr.split_rate(pid, share), 4),
            "on_peak_share": None if flat is not None or share is None else round(share, 3),
            "basis": "plant_rate" if flat is not None else ("tou" if share is not None else "off_peak_unknown_split"),
        }
    return out


def config_doc(db: Session) -> Tuple[str, Dict[str, Any]]:
    t = get_tariff(db)
    t.pop("updated_at", None)
    return (f"config/{TARIFF_KEY}", t)
