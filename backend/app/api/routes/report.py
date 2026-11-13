"""`GET /report/pwa/{day}`: data for the Monitoring PWA Report Google Sheet.

No user login: the sheet's Apps Script sends the shared key REPORT_API_KEY in `X-Report-Key`.
"""

from __future__ import annotations

import hmac
from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.services import pwa_report

router = APIRouter(prefix="/report", tags=["PWA Report"])


def get_day_docs() -> Optional[pwa_report.DayDocs]:
    return None  # Firestore; tests override


def require_report_key(x_report_key: str = Header(default="")) -> None:
    if not settings.report_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "REPORT_API_KEY is not configured")
    if not hmac.compare_digest(x_report_key.encode(), settings.report_api_key.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong or missing X-Report-Key")


@router.get("/pwa/{day}", dependencies=[Depends(require_report_key)])
def pwa_day(day: date, db: Session = Depends(get_db), day_docs=Depends(get_day_docs)) -> Dict[str, Any]:
    return pwa_report.build(db, day, day_docs)
