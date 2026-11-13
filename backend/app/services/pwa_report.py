"""Data for the Monitoring PWA Report Google Sheet (Apps Script `Monitoring Report/apps-script/Code.gs`).

The sheet reads the published daily plant docs (Firestore `daily/{day}/plants`) through the API
with a shared key, so the Apps Script needs no Google Cloud permission of its own. Plant names,
locations and datalogger serials come from the SQL registry.
"""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any, Dict, Iterable, List, Optional, Protocol, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant

# Only what the sheet uses (Firestore reads stay one per plant doc either way)
DAY_FIELDS = ["hourly_kw", "yield_kwh", "checks", "weather.has_sensor", "weather.slots", "google_weather.slots"]
# A day's docs and the registry are kept in API memory this long (per Cloud Run instance), so the
# sheet's repeated calls cost no extra Firestore reads; short enough that a publish shows up soon.
DAY_CACHE_S = 120
REGISTRY_CACHE_S = 600


class DayDocs(Protocol):
    def __call__(self, day: date) -> Iterable[Tuple[str, Dict[str, Any]]]: ...


_client = None


def firestore_day_docs(day: date) -> Iterable[Tuple[str, Dict[str, Any]]]:
    """(plant_id, doc) for one day from Firestore. On Cloud Run: the service's own account
    (needs roles/datastore.viewer); locally: FIREBASE_CREDENTIALS_FILE."""
    global _client
    if _client is None:
        import firebase_admin
        from firebase_admin import credentials, firestore

        try:
            app = firebase_admin.get_app("pwa-report")
        except ValueError:
            cred = (
                credentials.Certificate(settings.firebase_credentials_file)
                if settings.firebase_credentials_file
                else credentials.ApplicationDefault()
            )
            opts = {"projectId": settings.firebase_project_id} if settings.firebase_project_id else None
            app = firebase_admin.initialize_app(cred, opts, name="pwa-report")
        _client = firestore.client(app)
    q = _client.collection(f"daily/{day.isoformat()}/plants").select(DAY_FIELDS)
    return ((d.id, d.to_dict() or {}) for d in q.stream())


_lock = threading.Lock()
_day_cache: Dict[date, Tuple[float, Dict[str, Dict[str, Any]]]] = {}
_registry_cache: Optional[Tuple[float, Dict[str, Any], Dict[str, str]]] = None


def cached_day_docs(day: date) -> Dict[str, Dict[str, Any]]:
    """firestore_day_docs, kept DAY_CACHE_S in memory (older days dropped)."""
    now = time.monotonic()
    with _lock:
        hit = _day_cache.get(day)
        if hit and now - hit[0] < DAY_CACHE_S:
            return hit[1]
    docs = {pid: doc for pid, doc in firestore_day_docs(day)}
    with _lock:
        for d in [d for d, (t, _) in _day_cache.items() if now - t >= DAY_CACHE_S]:
            del _day_cache[d]
        _day_cache[day] = (now, docs)
    return docs


def _registry(db: Session, cache: bool) -> Tuple[Dict[str, Any], Dict[str, str]]:
    global _registry_cache
    now = time.monotonic()
    if cache and _registry_cache and now - _registry_cache[0] < REGISTRY_CACHE_S:
        return _registry_cache[1], _registry_cache[2]
    plants = {
        str(p.plant_id): {"name": p.name, "latitude": p.latitude, "longitude": p.longitude}
        for p in db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id))
    }
    loggers = {
        sn: str(pid)
        for sn, pid in db.execute(
            select(GrowattInverter.datalogger_sn, GrowattInverter.plant_id)
            .where(GrowattInverter.datalogger_sn.is_not(None))
            .order_by(GrowattInverter.device_sn)
        )
        if sn
    }
    if cache:
        _registry_cache = (now, plants, loggers)
    return plants, loggers


def build(db: Session, day: date, day_docs: Optional[DayDocs] = None) -> Dict[str, Any]:
    """Raw data: registry + the day's published docs. `day_docs` given (tests, the worker's own
    reader) = no caching."""
    plants, loggers = _registry(db, cache=day_docs is None)
    docs = cached_day_docs(day) if day_docs is None else {pid: doc for pid, doc in day_docs(day)}
    return {"day": day.isoformat(), "plants": plants, "loggers": loggers, "days": docs}


def cells(db: Session, day: date, hours: Sequence[int], day_docs: Optional[DayDocs] = None) -> Dict[str, Any]:
    """The sheet's values, built with the worker's own rules (pwa_sheet.plant_cells), so the Apps
    Script only matches rows and writes. Per plant: `checks` {"09": [CELL_COLUMNS...]},
    `weather_status`, `yield_kwh`. Rows match by `loggers` (datalogger SN) then a unique `names` hit."""
    from app.services import pwa_sheet

    data = build(db, day, day_docs)
    docs = data["days"]
    plants: Dict[str, Any] = {}
    for pid, info in data["plants"].items():
        c = pwa_sheet.plant_cells(day, docs.get(pid) or {}, info, hours)
        c.pop("sources")
        plants[pid] = c
    return {
        "day": data["day"],
        "hours": [f"{h:02d}" for h in hours],
        "columns": list(pwa_sheet.CELL_COLUMNS),
        "published_plants": len(docs),
        "loggers": data["loggers"],
        "names": {pid: info["name"] for pid, info in data["plants"].items()},
        "plants": plants,
    }
