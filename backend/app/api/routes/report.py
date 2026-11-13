"""Data for the Monitoring PWA Report Google Sheet.

    GET /report/pwa/{day}                   raw: registry + the day's published docs
    GET /report/pwa/{day}/cells?hours=9,13  the sheet's values per plant (what the Apps Script writes)

No user login: the sheet's Apps Script sends the shared key REPORT_API_KEY in `X-Report-Key`.
"""

from __future__ import annotations

import hmac
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.services import pwa_report
from app.services.pwa_sheet import CHECK_HOURS

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


def parse_hours(hours: Optional[str] = Query(None, description="check hours, e.g. 9,13 or 09,13,17; default all")) -> List[int]:
    if not hours:
        return list(CHECK_HOURS)
    try:
        out = sorted({int(h) for h in hours.split(",") if h.strip()})
    except ValueError:
        out = []
    if not out or any(h not in CHECK_HOURS for h in out):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"hours: comma list of {', '.join(map(str, CHECK_HOURS))}")
    return out


@router.get("/pwa/{day}/cells", dependencies=[Depends(require_report_key)])
def pwa_cells(
    day: date, hours: List[int] = Depends(parse_hours), db: Session = Depends(get_db), day_docs=Depends(get_day_docs)
) -> Dict[str, Any]:
    return pwa_report.cells(db, day, hours, day_docs)
