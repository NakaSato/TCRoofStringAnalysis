"""Per-plant document links (docs/plans/plant-asbuilt-links.md).

A link to a file or folder kept elsewhere (Google Drive): the newest as-built drawing PDF and the
site photo folder. The app stores only the link, never the file. Rows come from the Drive name
matcher (`source = "matched"`) or an admin (`"manual"`); a re-import never overwrites `manual`.
`plant_id` has no foreign key, as for claims and site events.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class PlantDocument(Base):
    __tablename__ = "plant_documents"
    __table_args__ = (UniqueConstraint("plant_id", "kind", name="uq_plant_documents_plant_kind"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    # asbuilt | site_photos
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # Drive file / folder id when the link is on Drive; the URL is what the UI opens
    drive_id: Mapped[Optional[str]] = mapped_column(String(128))
    url: Mapped[str] = mapped_column(String(1000), nullable=False)
    title: Mapped[Optional[str]] = mapped_column(String(300))
    # "REV.3" as read from the file name
    revision: Mapped[Optional[str]] = mapped_column(String(16))
    # matched | manual
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="manual")
    # name-match confidence 0…1 (matched rows only)
    match_score: Mapped[Optional[float]] = mapped_column(Float)
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)
