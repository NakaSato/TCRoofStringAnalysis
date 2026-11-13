"""Data for the Monitoring PWA Report Google Sheet (Apps Script `Monitoring Report/apps-script/Code.gs`).

The sheet reads the published daily plant docs (Firestore `daily/{day}/plants`) through the API
with a shared key, so the Apps Script needs no Google Cloud permission of its own. Plant names,
locations and datalogger serials come from the SQL registry.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Iterable, Optional, Protocol, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant

# Only what the sheet uses (Firestore reads stay one per plant doc either way)
DAY_FIELDS = ["hourly_kw", "checks", "weather.has_sensor", "weather.slots", "google_weather.slots"]


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


def build(db: Session, day: date, day_docs: Optional[DayDocs] = None) -> Dict[str, Any]:
    plants = {
        str(p.plant_id): {"name": p.name, "latitude": p.latitude, "longitude": p.longitude}
        for p in db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id))
    }
    loggers = {
        i.datalogger_sn: str(i.plant_id)
        for i in db.scalars(select(GrowattInverter).order_by(GrowattInverter.device_sn))
        if i.datalogger_sn
    }
    docs = {pid: doc for pid, doc in (day_docs or firestore_day_docs)(day)}
    return {"day": day.isoformat(), "plants": plants, "loggers": loggers, "days": docs}
