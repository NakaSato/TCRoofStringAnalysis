"""Knowledge Base: O&M manuals written in the app (docs/plans/knowledge-base.md, phase 1).

Articles are Markdown text with a full snapshot per saved change (`kb_revisions`). `version` is
the edit-conflict check (a save against an older version answers 409). `search_text` is the
lower-cased title + tags + body with the Markdown punctuation stripped, kept up to date on every
save, for the word search (`LIKE %word%`, works for Thai on SQLite and Postgres). SQL only (never
Firestore), kept indefinitely.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class KbArticle(Base):
    """One manual. `status` is draft / published / archived; new articles start as draft. `slug` is
    fixed at creation (a rename keeps links valid). `created_by_user_id` decides who may see a
    draft (engineers see only their own)."""

    __tablename__ = "kb_articles"
    __table_args__ = (UniqueConstraint("slug", name="uq_kb_articles_slug"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(120), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(24), nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    body_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft", index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[Optional[str]] = mapped_column(String(64))
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class KbRevision(Base):
    """A full snapshot of an article after one saved change (create, edit or restore).
    `rev_no` equals the article's `version` after that save."""

    __tablename__ = "kb_revisions"
    __table_args__ = (UniqueConstraint("article_id", "rev_no", name="uq_kb_revisions_article_rev"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    article_id: Mapped[int] = mapped_column(Integer, ForeignKey("kb_articles.id", ondelete="CASCADE"), nullable=False)
    rev_no: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(24), nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    body_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    author: Mapped[Optional[str]] = mapped_column(String(64))
    note: Mapped[Optional[str]] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


# --------------------------------------------------------------------------- documents (PDF library)
# docs/plans/kb-documents.md. A document is one controlled item of the library (a vendor manual, a
# datasheet, a drawing, an SOP as PDF); each uploaded file is a revision. The file itself is never
# changed (object storage, SHA-256 kept); its text is kept per page for the search.


class KbDocument(Base):
    """One library document. `status`: draft / released / superseded / withdrawn. `number` is the
    document number (`{TYPE}-{DISCIPLINE}-{SEQ:3}`, e.g. MAN-INV-001), unique. `general` = visible
    to everyone; otherwise only to users who may see one of its linked plants (admins see all)."""

    __tablename__ = "kb_documents"
    __table_args__ = (UniqueConstraint("number", name="uq_kb_documents_number"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    number: Mapped[str] = mapped_column(String(40), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="imported")
    doc_type: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    discipline: Mapped[str] = mapped_column(String(8), nullable=False)
    title_en: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    title_th: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    language: Mapped[str] = mapped_column(String(8), nullable=False, default="en")
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    general: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft", index=True)
    status_note: Mapped[Optional[str]] = mapped_column(String(500))
    superseded_by_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("kb_documents.id", ondelete="SET NULL"))
    current_rev_id: Mapped[Optional[int]] = mapped_column(Integer)
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    owner: Mapped[Optional[str]] = mapped_column(String(64))
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    released_by: Mapped[Optional[str]] = mapped_column(String(64))
    released_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class KbDocRevision(Base):
    """One uploaded file of a document (immutable). `rev_no` counts 1, 2, … per document;
    `label` is the source's own version ("v1.2", "Rev C"). `text_status`: ok (every page has
    text), ocr_pending (pages waiting for the worker's OCR), partial (some pages have no text
    after OCR), no_text (none), failed (the file could not be read)."""

    __tablename__ = "kb_doc_revisions"
    __table_args__ = (UniqueConstraint("doc_id", "rev_no", name="uq_kb_doc_revisions_doc_rev"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doc_id: Mapped[int] = mapped_column(Integer, ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    rev_no: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[Optional[str]] = mapped_column(String(40))
    change_note: Mapped[Optional[str]] = mapped_column(String(500))
    object_name: Mapped[str] = mapped_column(String(255), nullable=False)
    original_name: Mapped[Optional[str]] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(64), nullable=False, default="application/pdf")
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    text_status: Mapped[str] = mapped_column(String(16), nullable=False, default="ok", index=True)
    ocr_langs: Mapped[Optional[str]] = mapped_column(String(32))
    uploaded_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class KbDocPage(Base):
    """The text of one page of a revision, for the search. `source`: pdf (its text layer), ocr,
    pending (no text layer, OCR not run yet) or none (no text found, also after OCR)."""

    __tablename__ = "kb_doc_pages"
    __table_args__ = (UniqueConstraint("revision_id", "page_no", name="uq_kb_doc_pages_rev_page"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    revision_id: Mapped[int] = mapped_column(Integer, ForeignKey("kb_doc_revisions.id", ondelete="CASCADE"), nullable=False)
    page_no: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source: Mapped[str] = mapped_column(String(8), nullable=False, default="pdf", index=True)


class KbDocLink(Base):
    """What a document (optionally one of its pages) concerns: `target_type` fault_code (key
    `"<fault_type>:<code>"`, e.g. "Error:203"), equipment (inverter model key, spaces dropped,
    upper case) or plant (Growatt plant id)."""

    __tablename__ = "kb_doc_links"
    __table_args__ = (
        UniqueConstraint("doc_id", "target_type", "target_id", "page", name="uq_kb_doc_links"),
        Index("ix_kb_doc_links_target", "target_type", "target_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doc_id: Mapped[int] = mapped_column(Integer, ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(16), nullable=False)
    target_id: Mapped[str] = mapped_column(String(64), nullable=False)
    page: Mapped[Optional[int]] = mapped_column(Integer)
    label: Mapped[Optional[str]] = mapped_column(String(120))


class KbDocPin(Base):
    """A document a user pinned to "Pinned for you" (per user)."""

    __tablename__ = "kb_doc_pins"
    __table_args__ = (UniqueConstraint("user_id", "doc_id", name="uq_kb_doc_pins"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    doc_id: Mapped[int] = mapped_column(Integer, ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
