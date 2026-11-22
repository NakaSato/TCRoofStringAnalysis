"""Knowledge Base library: PDF documents (manuals, datasheets, SOPs, drawings, reports), their
file revisions, the text of every page, links to fault codes / equipment / plants, pins and the
page-level search (docs/plans/kb-documents.md, spec phase 1).

The uploaded file is never changed: it is stored once (`kb_storage`) with its SHA-256, and a new
file is a new revision. Text comes from the PDF's own text layer at upload; pages without one
wait for the worker's `kb_ocr` job (tesseract). SQL keeps metadata, page text and links only
(never Firestore).

Access (the routes add the role checks):
- admins see every document;
- everyone else sees released and superseded documents, plus the drafts they uploaded
  themselves, and only when the document is `general` or linked to a plant they may see;
- anything else is "not found" (ids are not revealed).
Editing: admins edit any document; an engineer edits only their own drafts. Release, withdraw,
supersede and delete are admin only.

Search: words are split as for the articles (the browser pre-splits Thai). A document matches
when every word is in its metadata (number, titles, tags, file name) or on one page together with
the words the metadata lacks. Numbers in the query (`growatt 202`, `error 407`) are matched against
the fault-code links first.
"""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer

from app.auth import allowed_plant_ids
from app.config import settings
from app.db.models import (
    GrowattInverter,
    GrowattPlant,
    KbDocLink,
    KbDocPage,
    KbDocPin,
    KbDocRevision,
    KbDocument,
    User,
)
from app.db.models.base import _utcnow
from app.services import kb_pdf, kb_storage
from app.services.kb import query_words

log = logging.getLogger("kb.docs")

# type → number prefix (spec §6.1: {TYPE}-{DISCIPLINE}-{SEQ:3})
DOC_TYPES: Dict[str, str] = {
    "manual": "MAN",
    "datasheet": "DS",
    "sop": "SOP",
    "work_instruction": "WI",
    "method_statement": "MS",
    "checklist": "CHK",
    "report": "RPT",
    "drawing": "DWG",
    "certificate": "CERT",
    "technical_note": "TN",
    "other": "DOC",
}
DISCIPLINES = ("OM", "ENG", "INV", "MOD", "ELE", "INS", "SAF", "GEN")
LANGUAGES = ("en", "th", "both")
STATUSES = ("draft", "released", "superseded", "withdrawn")
LINK_TYPES = ("fault_code", "equipment", "plant")
# readable by everyone who may see the document (a superseded one shows a banner)
_READ_STATUSES = ("released", "superseded")
PROCEDURE_TYPES = ("sop", "work_instruction", "method_statement", "checklist")

NUMBER_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{2,39}$")
FAULT_RE = re.compile(r"^([A-Za-z]{1,16}):([0-9A-Za-z_.-]{1,16})$")
MAX_LINKS = 200
SNIPPET_CHARS = 90
PAGES_PER_HIT = 3


class DocNotFound(Exception):
    """No such document / revision, or one the user may not see: 404."""


class DocConflict(Exception):
    """A clash with stored data (number taken, wrong status for the action): 409."""


class DocInvalid(ValueError):
    """Bad input: 422."""


# --------------------------------------------------------------------------- helpers


def _name(user: User) -> str:
    return user.username or user.email


def _iso(ts: Optional[datetime]) -> Optional[str]:
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts(d: KbDocument) -> float:
    ts = d.updated_at or d.created_at
    if ts is None:
        return 0.0
    return (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).timestamp()


def model_key(name: str) -> str:
    """Inverter / module model as a link key: spaces and underscores dropped, upper case (Growatt
    writes "MAX 125KTL3-X LV" and "MAX125KTL3-XLV" for the same model)."""
    return re.sub(r"[\s_]+", "", name or "").upper()[:64]


def fault_key(fault_type: str, code: Any) -> str:
    return f"{str(fault_type).strip().capitalize()}:{str(code).strip()}"


def is_admin(user: User) -> bool:
    return user.role == "admin"


def title_of(d: KbDocument) -> str:
    return d.title_en or d.title_th or d.number


def _search_meta(d: KbDocument, rev: Optional[KbDocRevision]) -> str:
    parts = [d.number, d.title_en, d.title_th, " ".join(d.tags or []), DOC_TYPES.get(d.doc_type, ""), d.doc_type.replace("_", " ")]
    if rev is not None:
        parts += [rev.label or "", rev.original_name or ""]
    return kb_pdf.search_form(" ".join(p for p in parts if p))


# --------------------------------------------------------------------------- access


def _plants_of(db: Session, doc_ids: Iterable[int]) -> Dict[int, Set[int]]:
    ids = list(doc_ids)
    out: Dict[int, Set[int]] = {i: set() for i in ids}
    if not ids:
        return out
    for doc_id, target in db.execute(
        select(KbDocLink.doc_id, KbDocLink.target_id).where(KbDocLink.doc_id.in_(ids), KbDocLink.target_type == "plant")
    ):
        if str(target).isdigit():
            out.setdefault(doc_id, set()).add(int(target))
    return out


def can_view(d: KbDocument, user: User, plants: Set[int], allowed: Optional[Set[int]]) -> bool:
    if is_admin(user):
        return True
    if d.status in _READ_STATUSES:
        pass
    elif not (d.status == "draft" and d.created_by_user_id == user.id):
        return False
    if d.general:
        return True
    return allowed is not None and bool(plants & allowed)


def can_edit(d: KbDocument, user: User) -> bool:
    if is_admin(user):
        return True
    return user.role == "engineer" and d.status == "draft" and d.created_by_user_id == user.id


def _visible_docs(db: Session, user: User, *, status: Optional[str] = None) -> List[KbDocument]:
    """Every document the user may see (withdrawn ones only for admins asking for them)."""
    stmt = select(KbDocument).options(defer(KbDocument.search_text))
    if status:
        stmt = stmt.where(KbDocument.status == status)
    elif not is_admin(user):
        stmt = stmt.where(KbDocument.status != "withdrawn")
    docs = list(db.scalars(stmt))
    if is_admin(user):
        return docs
    allowed = allowed_plant_ids(db, user)
    plants = _plants_of(db, [d.id for d in docs if not d.general])
    return [d for d in docs if can_view(d, user, plants.get(d.id, set()), allowed)]


def get_visible(db: Session, user: User, doc_id: int) -> KbDocument:
    d = db.get(KbDocument, doc_id)
    if d is None:
        raise DocNotFound(f"Document {doc_id} not found")
    if not is_admin(user):
        if not can_view(d, user, _plants_of(db, [d.id]).get(d.id, set()), allowed_plant_ids(db, user)):
            raise DocNotFound(f"Document {doc_id} not found")
    return d


# --------------------------------------------------------------------------- output


def revision_out(r: KbDocRevision, *, current: bool, pending_pages: int = 0) -> Dict[str, Any]:
    return {
        "id": r.id,
        "rev_no": r.rev_no,
        "label": r.label,
        "change_note": r.change_note,
        "original_name": r.original_name,
        "bytes": r.bytes,
        "sha256": r.sha256,
        "page_count": r.page_count,
        "text_status": r.text_status,
        "ocr_pending_pages": pending_pages,
        "ocr_langs": r.ocr_langs,
        "uploaded_by": r.uploaded_by,
        "created_at": _iso(r.created_at),
        "is_current": current,
    }


def link_out(link: KbDocLink, plant_names: Dict[int, str]) -> Dict[str, Any]:
    label = link.label
    if link.target_type == "plant" and str(link.target_id).isdigit():
        label = plant_names.get(int(link.target_id), label)
    return {"target_type": link.target_type, "target_id": link.target_id, "page": link.page, "label": label}


def _plant_names(db: Session, ids: Iterable[int]) -> Dict[int, str]:
    ids = list(set(ids))
    if not ids:
        return {}
    return {pid: name for pid, name in db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(ids)))}


def doc_summary(d: KbDocument, user: User, rev: Optional[KbDocRevision], *, pinned: bool = False) -> Dict[str, Any]:
    return {
        "id": d.id,
        "number": d.number,
        "kind": d.kind,
        "doc_type": d.doc_type,
        "discipline": d.discipline,
        "title": title_of(d),
        "title_en": d.title_en,
        "title_th": d.title_th,
        "language": d.language,
        "tags": list(d.tags or []),
        "general": d.general,
        "status": d.status,
        "owner": d.owner,
        "updated_at": _iso(d.updated_at or d.created_at),
        "released_at": _iso(d.released_at),
        "revision": None
        if rev is None
        else {"rev_no": rev.rev_no, "label": rev.label, "page_count": rev.page_count, "text_status": rev.text_status, "bytes": rev.bytes},
        "pinned": pinned,
        "can_edit": can_edit(d, user),
    }


def _revs(db: Session, docs: List[KbDocument]) -> Dict[int, KbDocRevision]:
    ids = [d.current_rev_id for d in docs if d.current_rev_id]
    if not ids:
        return {}
    return {r.id: r for r in db.scalars(select(KbDocRevision).where(KbDocRevision.id.in_(ids)))}


def _pinned(db: Session, user: User) -> Set[int]:
    return set(db.scalars(select(KbDocPin.doc_id).where(KbDocPin.user_id == user.id)))


def doc_out(db: Session, d: KbDocument, user: User) -> Dict[str, Any]:
    revs = list(db.scalars(select(KbDocRevision).where(KbDocRevision.doc_id == d.id).order_by(KbDocRevision.rev_no.desc())))
    current = next((r for r in revs if r.id == d.current_rev_id), revs[0] if revs else None)
    pending: Dict[int, int] = {}
    if revs:
        pending = {
            rid: n
            for rid, n in db.execute(
                select(KbDocPage.revision_id, func.count())
                .where(KbDocPage.revision_id.in_([r.id for r in revs]), KbDocPage.source == "pending")
                .group_by(KbDocPage.revision_id)
            )
        }
    links = list(db.scalars(select(KbDocLink).where(KbDocLink.doc_id == d.id).order_by(KbDocLink.target_type, KbDocLink.target_id, KbDocLink.page)))
    names = _plant_names(db, [int(x.target_id) for x in links if x.target_type == "plant" and str(x.target_id).isdigit()])
    out = doc_summary(d, user, current, pinned=d.id in _pinned(db, user))
    sup = db.get(KbDocument, d.superseded_by_id) if d.superseded_by_id else None
    out.update(
        {
            "status_note": d.status_note,
            "superseded_by": None if sup is None else {"id": sup.id, "number": sup.number, "title": title_of(sup)},
            "created_by": d.owner,
            "created_at": _iso(d.created_at),
            "updated_by": d.updated_by,
            "released_by": d.released_by,
            "current_revision": None if current is None else revision_out(current, current=True, pending_pages=pending.get(current.id, 0)),
            "revisions": [revision_out(r, current=r.id == (current.id if current else None), pending_pages=pending.get(r.id, 0)) for r in revs],
            "links": [link_out(x, names) for x in links],
            "can_release": is_admin(user),
        }
    )
    return out


# --------------------------------------------------------------------------- list / home


def list_docs(
    db: Session,
    user: User,
    *,
    doc_type: Optional[str] = None,
    status: Optional[str] = None,
    language: Optional[str] = None,
    equipment: Optional[str] = None,
    plant_id: Optional[int] = None,
    fault: Optional[str] = None,
    tag: Optional[str] = None,
    owner: Optional[str] = None,
    q: Optional[str] = None,
    sort: str = "updated",
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """Visible documents with the filters (metadata only; `q` here = words in the metadata). The
    facets (`tags`, `owners`, `equipment`) are counted over every visible document."""
    docs = _visible_docs(db, user, status=status)
    all_docs = docs
    links_by: Dict[int, List[KbDocLink]] = {}
    if docs:
        for link in db.scalars(select(KbDocLink).where(KbDocLink.doc_id.in_([d.id for d in docs]))):
            links_by.setdefault(link.doc_id, []).append(link)

    def has(d: KbDocument, kind: str, key: str) -> bool:
        return any(x.target_type == kind and x.target_id == key for x in links_by.get(d.id, []))

    if doc_type:
        docs = [d for d in docs if d.doc_type == doc_type]
    if language:
        docs = [d for d in docs if d.language == language or d.language == "both"]
    if equipment:
        docs = [d for d in docs if has(d, "equipment", model_key(equipment))]
    if plant_id is not None:
        docs = [d for d in docs if has(d, "plant", str(plant_id))]
    if fault:
        m = FAULT_RE.match(fault.strip())
        if m:
            key = fault_key(m.group(1), m.group(2))
            docs = [d for d in docs if has(d, "fault_code", key)]
        else:  # a bare code: any fault type
            code = fault.strip()
            docs = [d for d in docs if any(x.target_type == "fault_code" and x.target_id.split(":", 1)[-1] == code for x in links_by.get(d.id, []))]
    if tag and tag.strip():
        want = tag.strip().lower()
        docs = [d for d in docs if any(t.lower() == want for t in (d.tags or []))]
    if owner:
        docs = [d for d in docs if (d.owner or "") == owner]
    revs = _revs(db, all_docs)
    words = query_words(q)
    if words:
        docs = [d for d in docs if all(w in _search_meta(d, revs.get(d.current_rev_id or -1)) for w in words)]
    if sort == "number":
        docs.sort(key=lambda d: d.number)
    elif sort == "title":
        docs.sort(key=lambda d: title_of(d).lower())
    else:
        docs.sort(key=lambda d: (-_ts(d), -d.id))
    total = len(docs)
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    pinned = _pinned(db, user)
    tags: Dict[str, int] = {}
    owners: Dict[str, int] = {}
    equip: Dict[str, Dict[str, Any]] = {}
    for d in all_docs:
        for t in d.tags or []:
            tags[t] = tags.get(t, 0) + 1
        if d.owner:
            owners[d.owner] = owners.get(d.owner, 0) + 1
        for x in links_by.get(d.id, []):
            if x.target_type == "equipment":
                e = equip.setdefault(x.target_id, {"key": x.target_id, "label": x.label or x.target_id, "count": 0})
                e["count"] += 1
    return {
        "items": [doc_summary(d, user, revs.get(d.current_rev_id or -1), pinned=d.id in pinned) for d in docs[offset : offset + limit]],
        "total": total,
        "facets": {
            "tags": sorted(tags, key=lambda t: (t.lower(), t)),
            "owners": sorted(owners),
            "equipment": sorted(equip.values(), key=lambda e: e["label"]),
        },
    }


def _equipment_of_plants(db: Session, plant_ids: Optional[Set[int]]) -> Dict[str, Tuple[str, int]]:
    """{model key: (model name, inverters)} over the given plants' installed inverters (None = all)."""
    q = select(GrowattInverter.device_model, func.count()).where(
        GrowattInverter.device_model.is_not(None), GrowattInverter.not_installed_at.is_(None)
    )
    if plant_ids is not None:
        q = q.where(GrowattInverter.plant_id.in_(plant_ids or {-1}))
    out: Dict[str, Tuple[str, int]] = {}
    for name, n in db.execute(q.group_by(GrowattInverter.device_model)):
        k = model_key(name)
        prev = out.get(k)
        out[k] = (prev[0] if prev else name, (prev[1] if prev else 0) + int(n))
    return out


def home(db: Session, user: User) -> Dict[str, Any]:
    """"Pinned for you": the user's pins, documents for the user's plants (linked to them, or to
    their inverter models; engineers only, an admin has every plant) and the newest changes."""
    docs = _visible_docs(db, user)
    revs = _revs(db, docs)
    pinned = _pinned(db, user)
    by_id = {d.id: d for d in docs}
    pins = [by_id[i] for i in pinned if i in by_id]
    pins.sort(key=lambda d: d.number)
    for_plants: List[KbDocument] = []
    if not is_admin(user):
        allowed = allowed_plant_ids(db, user) or set()
        models = set(_equipment_of_plants(db, allowed)) if allowed else set()
        keys = {("plant", str(p)) for p in allowed} | {("equipment", m) for m in models}
        if keys and docs:
            hit: Set[int] = set()
            for link in db.scalars(select(KbDocLink).where(KbDocLink.doc_id.in_(list(by_id)))):
                if (link.target_type, link.target_id) in keys:
                    hit.add(link.doc_id)
            for_plants = [by_id[i] for i in hit if by_id[i].status == "released" and i not in pinned]
            for_plants.sort(key=lambda d: (-_ts(d), d.id))
    recent = sorted(docs, key=lambda d: (-_ts(d), -d.id))[:8]
    out = lambda ds: [doc_summary(d, user, revs.get(d.current_rev_id or -1), pinned=d.id in pinned) for d in ds]  # noqa: E731
    return {"pinned": out(pins), "for_plants": out(for_plants[:12]), "recent": out(recent), "total": len(docs)}


def set_pin(db: Session, user: User, d: KbDocument, on: bool) -> bool:
    row = db.scalar(select(KbDocPin).where(KbDocPin.user_id == user.id, KbDocPin.doc_id == d.id))
    if on and row is None:
        db.add(KbDocPin(user_id=user.id, doc_id=d.id))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    elif not on and row is not None:
        db.delete(row)
        db.commit()
    return on


# --------------------------------------------------------------------------- numbering


def next_number(db: Session, doc_type: str, discipline: str) -> str:
    prefix = f"{DOC_TYPES[doc_type]}-{discipline}-"
    seq = 0
    for (num,) in db.execute(select(KbDocument.number).where(KbDocument.number.like(f"{prefix}%"))):
        tail = num[len(prefix) :]
        if tail.isdigit():
            seq = max(seq, int(tail))
    return f"{prefix}{seq + 1:03d}"


def _check_number(db: Session, number: str, doc_id: Optional[int]) -> str:
    n = number.strip().upper()
    if not NUMBER_RE.match(n):
        raise DocInvalid("Document number: 3–40 characters, A–Z, 0–9 and hyphens (e.g. MAN-INV-001).")
    q = select(KbDocument.id).where(KbDocument.number == n)
    if doc_id is not None:
        q = q.where(KbDocument.id != doc_id)
    if db.scalar(q) is not None:
        raise DocConflict(f"Document number {n} is already used.")
    return n


# --------------------------------------------------------------------------- upload


def _check_fields(f: Dict[str, Any]) -> None:
    if f.get("doc_type") is not None and f["doc_type"] not in DOC_TYPES:
        raise DocInvalid(f"Unknown document type {f['doc_type']!r}.")
    if f.get("discipline") is not None and f["discipline"] not in DISCIPLINES:
        raise DocInvalid(f"Unknown discipline {f['discipline']!r}.")
    if f.get("language") is not None and f["language"] not in LANGUAGES:
        raise DocInvalid(f"Unknown language {f['language']!r}.")


def _clean_tags(tags: Optional[Iterable[str]]) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for t in tags or []:
        t = " ".join(str(t).split())[:40]
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out[:20]


def _check_file(data: bytes) -> List[kb_pdf.PageText]:
    if not data:
        raise DocInvalid("The file is empty.")
    if len(data) > settings.kb_max_upload_mb * 1024 * 1024:
        raise DocInvalid(f"The file is larger than {settings.kb_max_upload_mb} MB.")
    try:
        pages = kb_pdf.read_pages(data)
    except kb_pdf.PdfUnreadable as exc:
        raise DocInvalid(str(exc)) from exc
    if not pages:
        raise DocInvalid("The PDF has no pages.")
    return pages


def _text_status(sources: Iterable[str]) -> str:
    s = list(sources)
    if not s:
        return "no_text"
    if "pending" in s:
        return "ocr_pending"
    if all(x in ("pdf", "ocr") for x in s):
        return "ok"
    if any(x in ("pdf", "ocr") for x in s):
        return "partial"
    return "no_text"


def _add_revision(
    db: Session,
    user: User,
    d: KbDocument,
    data: bytes,
    pages: List[kb_pdf.PageText],
    *,
    filename: Optional[str],
    label: Optional[str],
    note: Optional[str],
) -> Tuple[KbDocRevision, str]:
    """Stage a revision with its pages (no commit); the file is written. Returns the revision
    and the object name (to delete when the commit fails)."""
    rev_no = (db.scalar(select(func.max(KbDocRevision.rev_no)).where(KbDocRevision.doc_id == d.id)) or 0) + 1
    sha = hashlib.sha256(data).hexdigest()
    name = f"docs/{d.id}/{rev_no}-{sha[:12]}.pdf"
    sources = ["pending" if p.needs_ocr else "pdf" for p in pages]
    r = KbDocRevision(
        doc_id=d.id,
        rev_no=rev_no,
        label=(label or "").strip()[:40] or None,
        change_note=(note or "").strip()[:500] or None,
        object_name=name,
        original_name=(filename or "").strip()[:255] or None,
        content_type="application/pdf",
        bytes=len(data),
        sha256=sha,
        page_count=len(pages),
        text_status=_text_status(sources),
        uploaded_by=_name(user),
        created_at=_utcnow(),
    )
    db.add(r)
    db.flush()
    for p, src in zip(pages, sources):
        text = "" if src == "pending" else p.text
        db.add(KbDocPage(revision_id=r.id, page_no=p.page_no, text=text, search_text=kb_pdf.search_form(text), source=src))
    kb_storage.get_store().put(name, data, "application/pdf")
    return r, name


def _commit_or_drop(db: Session, name: Optional[str]) -> None:
    try:
        db.commit()
    except Exception:
        db.rollback()
        if name:
            try:
                kb_storage.get_store().delete(name)
            except Exception:  # noqa: BLE001 - the original error matters more
                log.exception("could not remove %s after a failed save", name)
        raise


def create_doc(db: Session, user: User, fields: Dict[str, Any], data: bytes, filename: Optional[str]) -> KbDocument:
    """A new draft with revision 1 from the uploaded PDF. `number` (admins) or the next free one."""
    _check_fields(fields)
    title_en = (fields.get("title_en") or "").strip()[:200]
    title_th = (fields.get("title_th") or "").strip()[:200]
    if not title_en and not title_th:
        raise DocInvalid("Give the document a title (English or Thai).")
    pages = _check_file(data)
    kb_storage.get_store()  # 503 before anything is staged when storage is off
    doc_type = fields["doc_type"]
    discipline = fields["discipline"]
    number = fields.get("number")
    if number and is_admin(user):
        number = _check_number(db, number, None)
    else:
        number = next_number(db, doc_type, discipline)
    now = _utcnow()
    who = _name(user)
    d = KbDocument(
        number=number,
        kind="imported",
        doc_type=doc_type,
        discipline=discipline,
        title_en=title_en,
        title_th=title_th,
        language=fields.get("language") or "en",
        tags=_clean_tags(fields.get("tags")),
        general=bool(fields.get("general", True)),
        status="draft",
        owner=who,
        created_by_user_id=user.id,
        created_at=now,
        updated_by=who,
        updated_at=now,
    )
    db.add(d)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise DocConflict(f"Document number {number} is already used.") from None
    name: Optional[str] = None
    try:
        r, name = _add_revision(db, user, d, data, pages, filename=filename, label=fields.get("label"), note=fields.get("change_note"))
        d.current_rev_id = r.id
        d.search_text = _search_meta(d, r)
        if fields.get("links") or not d.general:
            _replace_links(db, user, d, fields.get("links") or [], page_count=r.page_count)
    except BaseException:
        db.rollback()
        if name:
            kb_storage.get_store().delete(name)
        raise
    _commit_or_drop(db, name)
    db.refresh(d)
    return d


def add_revision(db: Session, user: User, d: KbDocument, data: bytes, filename: Optional[str], label: Optional[str], note: Optional[str]) -> KbDocRevision:
    """A new file for the document; it becomes the current revision. Released documents need a
    change note (it goes in the revision list)."""
    if d.status == "withdrawn":
        raise DocConflict("A withdrawn document takes no new revision; release it again first.")
    if d.status != "draft" and not (note or "").strip():
        raise DocInvalid("Say what changed (change note) for a new revision of a released document.")
    pages = _check_file(data)
    name: Optional[str] = None
    try:
        r, name = _add_revision(db, user, d, data, pages, filename=filename, label=label, note=note)
        d.current_rev_id = r.id
        d.updated_by = _name(user)
        d.updated_at = _utcnow()
        d.search_text = _search_meta(d, r)
    except BaseException:
        db.rollback()
        if name:
            kb_storage.get_store().delete(name)
        raise
    _commit_or_drop(db, name)
    db.refresh(r)
    return r


# --------------------------------------------------------------------------- edits


def update_doc(db: Session, user: User, d: KbDocument, fields: Dict[str, Any]) -> List[str]:
    """Metadata edits (null = unchanged). The number only by admins."""
    _check_fields(fields)
    changes: Dict[str, Any] = {}
    for k in ("title_en", "title_th"):
        if fields.get(k) is not None:
            changes[k] = fields[k].strip()[:200]
    for k in ("doc_type", "discipline", "language", "general"):
        if fields.get(k) is not None:
            changes[k] = fields[k]
    if fields.get("tags") is not None:
        changes["tags"] = _clean_tags(fields["tags"])
    if fields.get("number") is not None:
        if not is_admin(user):
            raise DocInvalid("Only an admin changes a document number.")
        changes["number"] = _check_number(db, fields["number"], d.id)
    changes = {k: v for k, v in changes.items() if v != getattr(d, k)}
    title_en = changes.get("title_en", d.title_en)
    title_th = changes.get("title_th", d.title_th)
    if not title_en and not title_th:
        raise DocInvalid("Give the document a title (English or Thai).")
    if not changes:
        return []
    for k, v in changes.items():
        setattr(d, k, v)
    d.updated_by = _name(user)
    d.updated_at = _utcnow()
    rev = db.get(KbDocRevision, d.current_rev_id) if d.current_rev_id else None
    d.search_text = _search_meta(d, rev)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise DocConflict("Document number is already used.") from None
    db.refresh(d)
    return list(changes)


def _norm_link(db: Session, user: User, raw: Dict[str, Any], page_count: int, allowed: Optional[Set[int]]) -> Tuple[str, str, Optional[int], Optional[str]]:
    kind = str(raw.get("target_type") or "")
    tid = str(raw.get("target_id") or "").strip()
    label = (str(raw.get("label") or "").strip()[:120]) or None
    page = raw.get("page")
    if page is not None:
        page = int(page)
        if not (1 <= page <= max(1, page_count)):
            raise DocInvalid(f"Page {page} is not in the document (1–{page_count}).")
    if kind == "fault_code":
        m = FAULT_RE.match(tid)
        if not m:
            raise DocInvalid(f"Fault code {tid!r}: use <type>:<code>, e.g. Error:203.")
        tid = fault_key(m.group(1), m.group(2))
    elif kind == "equipment":
        label = label or tid
        tid = model_key(tid)
        if not tid:
            raise DocInvalid("Equipment link without a model.")
    elif kind == "plant":
        if not tid.isdigit():
            raise DocInvalid(f"Plant {tid!r} is not a plant id.")
        pid = int(tid)
        if db.get(GrowattPlant, pid) is None or (allowed is not None and pid not in allowed):
            raise DocInvalid(f"Plant {pid} not found.")
        label = None  # the plant's name is read when shown
    else:
        raise DocInvalid(f"Unknown link type {kind!r}.")
    return kind, tid, page, label


def _replace_links(db: Session, user: User, d: KbDocument, links: List[Dict[str, Any]], *, page_count: int) -> None:
    if len(links) > MAX_LINKS:
        raise DocInvalid(f"At most {MAX_LINKS} links.")
    allowed = allowed_plant_ids(db, user)
    seen: Dict[Tuple[str, str, Optional[int]], Optional[str]] = {}
    for raw in links:
        kind, tid, page, label = _norm_link(db, user, raw, page_count, allowed)
        seen[(kind, tid, page)] = label
    if not is_admin(user) and not d.general and not any(k == "plant" for k, _, _ in seen):
        raise DocInvalid("A document that is not general needs at least one of your plants.")
    db.execute(delete(KbDocLink).where(KbDocLink.doc_id == d.id))
    for (kind, tid, page), label in seen.items():
        db.add(KbDocLink(doc_id=d.id, target_type=kind, target_id=tid, page=page, label=label))


def replace_links(db: Session, user: User, d: KbDocument, links: List[Dict[str, Any]]) -> None:
    rev = db.get(KbDocRevision, d.current_rev_id) if d.current_rev_id else None
    _replace_links(db, user, d, links, page_count=rev.page_count if rev else 1)
    d.updated_by = _name(user)
    d.updated_at = _utcnow()
    db.commit()


def release(db: Session, user: User, d: KbDocument) -> bool:
    if d.current_rev_id is None:
        raise DocConflict("The document has no file to release.")
    if d.status == "released":
        return False
    d.status = "released"
    d.status_note = None
    d.superseded_by_id = None
    d.released_by = _name(user)
    d.released_at = _utcnow()
    db.commit()
    return True


def withdraw(db: Session, user: User, d: KbDocument, reason: str) -> bool:
    if not reason.strip():
        raise DocInvalid("Give a reason for withdrawing the document.")
    if d.status == "withdrawn":
        return False
    d.status = "withdrawn"
    d.status_note = reason.strip()[:500]
    d.updated_by = _name(user)
    d.updated_at = _utcnow()
    db.commit()
    return True


def supersede(db: Session, user: User, d: KbDocument, by_doc_id: Optional[int], note: Optional[str]) -> None:
    if d.status not in ("released", "superseded"):
        raise DocConflict("Only a released document is superseded.")
    if by_doc_id is not None:
        if by_doc_id == d.id or db.get(KbDocument, by_doc_id) is None:
            raise DocInvalid("The replacing document was not found.")
    d.status = "superseded"
    d.superseded_by_id = by_doc_id
    d.status_note = (note or "").strip()[:500] or None
    d.updated_by = _name(user)
    d.updated_at = _utcnow()
    db.commit()


def delete_doc(db: Session, user: User, d: KbDocument) -> str:
    """A never-released draft is deleted with its files (`deleted`); anything else is withdrawn."""
    if d.status == "draft" and d.released_at is None:
        names = list(db.scalars(select(KbDocRevision.object_name).where(KbDocRevision.doc_id == d.id)))
        rev_ids = list(db.scalars(select(KbDocRevision.id).where(KbDocRevision.doc_id == d.id)))
        if rev_ids:
            db.execute(delete(KbDocPage).where(KbDocPage.revision_id.in_(rev_ids)))
        db.execute(delete(KbDocRevision).where(KbDocRevision.doc_id == d.id))
        db.execute(delete(KbDocLink).where(KbDocLink.doc_id == d.id))
        db.execute(delete(KbDocPin).where(KbDocPin.doc_id == d.id))
        db.delete(d)
        db.commit()
        store = kb_storage.get_store()
        for n in names:
            try:
                store.delete(n)
            except Exception:  # noqa: BLE001
                log.exception("could not remove %s", n)
        return "deleted"
    withdraw(db, user, d, "Deleted by an admin")
    return "withdrawn"


def get_revision(db: Session, d: KbDocument, rev_no: Optional[int]) -> KbDocRevision:
    if rev_no is None:
        r = db.get(KbDocRevision, d.current_rev_id) if d.current_rev_id else None
    else:
        r = db.scalar(select(KbDocRevision).where(KbDocRevision.doc_id == d.id, KbDocRevision.rev_no == rev_no))
    if r is None:
        raise DocNotFound(f"Revision {rev_no} of document {d.id} not found")
    return r


def file_name(d: KbDocument, r: KbDocRevision) -> str:
    base = re.sub(r"[^\w.-]+", "_", f"{d.number}_r{r.rev_no}" + (f"_{r.label}" if r.label else ""), flags=re.ASCII)
    return f"{base}.pdf"


def file_link(d: KbDocument, r: KbDocRevision, *, download: bool) -> Dict[str, Any]:
    """Where the browser GETs the file: a signed GCS URL, or the API's own signed path."""
    store = kb_storage.get_store()
    ttl = max(60, settings.kb_file_url_ttl_s)
    fname = file_name(d, r)
    url = store.signed_url(r.object_name, filename=fname, download=download, ttl_s=ttl)
    if url:
        exp = int(datetime.now(timezone.utc).timestamp()) + ttl
        return {"url": url, "api": False, "expires_at": exp, "filename": fname, "bytes": r.bytes, "sha256": r.sha256}
    path, exp = kb_storage.sign_api_path(r.id, download=download, ttl_s=ttl)
    return {"url": path, "api": True, "expires_at": exp, "filename": fname, "bytes": r.bytes, "sha256": r.sha256}


def queue_ocr_again(db: Session, r: KbDocRevision) -> int:
    """Pages without text go back to OCR (after tesseract or a language was installed)."""
    rows = list(db.scalars(select(KbDocPage).where(KbDocPage.revision_id == r.id, KbDocPage.source == "none")))
    for p in rows:
        p.source = "pending"
    if rows:
        r.text_status = "ocr_pending"
    db.commit()
    return len(rows)


# --------------------------------------------------------------------------- search


def _snippet(text: str, words: List[str]) -> str:
    flat = re.sub(r"\s+", " ", text)
    low = flat.lower()
    pos = -1
    for w in words:
        i = low.find(w)
        if i >= 0 and (pos < 0 or i < pos):
            pos = i
    if pos < 0:
        return flat[: SNIPPET_CHARS * 2].rstrip() + ("…" if len(flat) > SNIPPET_CHARS * 2 else "")
    if len(low) != len(flat):  # a case change altered lengths: show the lowered text
        flat = low
    a = max(0, pos - SNIPPET_CHARS)
    b = min(len(flat), pos + SNIPPET_CHARS)
    return ("…" if a > 0 else "") + flat[a:b].strip() + ("…" if b < len(flat) else "")


def _fault_words(words: List[str]) -> Tuple[Optional[str], List[str]]:
    kind = None
    for w in words:
        if w in ("error", "fault"):
            kind = "Error"
        elif w in ("warning", "warn"):
            kind = "Warning"
    codes = [w for w in words if w.isdigit() and 1 <= len(w) <= 5]
    return kind, codes


def search(db: Session, user: User, q: str, *, limit: int = 20) -> Dict[str, Any]:
    """Fault-code links first, then documents (metadata or page hits, with up to three pages and
    a snippet each). Only each document's current revision is searched."""
    words = query_words(q)
    if not words:
        return {"words": [], "faults": [], "documents": [], "total": 0}
    docs = _visible_docs(db, user)
    by_id = {d.id: d for d in docs}
    revs = _revs(db, docs)
    pinned = _pinned(db, user)

    faults: List[Dict[str, Any]] = []
    kind, codes = _fault_words(words)
    if codes and by_id:
        links = db.scalars(select(KbDocLink).where(KbDocLink.doc_id.in_(list(by_id)), KbDocLink.target_type == "fault_code"))
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for link in links:
            ftype, _, code = link.target_id.partition(":")
            if code in codes and (kind is None or ftype == kind):
                d = by_id[link.doc_id]
                groups.setdefault(link.target_id, []).append(
                    {"doc": doc_summary(d, user, revs.get(d.current_rev_id or -1), pinned=d.id in pinned), "page": link.page, "label": link.label}
                )
        for key in sorted(groups):
            items = sorted(groups[key], key=lambda x: (x["doc"]["status"] != "released", x["doc"]["number"], x["page"] or 0))
            faults.append({"key": key, "links": items})

    meta = {d.id: _search_meta(d, revs.get(d.current_rev_id or -1)) for d in docs}
    rev_to_doc = {r.id: r.doc_id for r in revs.values()}
    page_words: Dict[Tuple[int, int], Set[str]] = {}
    if rev_to_doc:
        for w in words:
            for rid, pno in db.execute(
                select(KbDocPage.revision_id, KbDocPage.page_no).where(
                    KbDocPage.revision_id.in_(list(rev_to_doc)), KbDocPage.search_text.contains(w, autoescape=True)
                )
            ):
                page_words.setdefault((rid, pno), set()).add(w)
    want = set(words)
    hits: Dict[int, List[Tuple[int, int, int]]] = {}  # doc → [(rev, page, words on page)]
    for (rid, pno), found in page_words.items():
        did = rev_to_doc[rid]
        in_meta = {w for w in want if w in meta[did]}
        if found | in_meta >= want:
            hits.setdefault(did, []).append((rid, pno, len(found)))
    results: List[Tuple[Tuple, Dict[str, Any], List[Tuple[int, int]]]] = []
    for d in docs:
        m = meta[d.id]
        meta_all = all(w in m for w in words)
        ph = sorted(hits.get(d.id, []), key=lambda x: (-x[2], x[1]))
        if not meta_all and not ph:
            continue
        title = (d.title_en + " " + d.title_th + " " + d.number).lower()
        in_title = sum(1 for w in words if w in title)
        rank = (0 if in_title == len(words) else 1 if meta_all else 2, -in_title, -len(ph), d.status != "released", -_ts(d))
        item = doc_summary(d, user, revs.get(d.current_rev_id or -1), pinned=d.id in pinned)
        item["match"] = "title" if meta_all else "pages"
        item["page_hits"] = len(ph)
        results.append((rank, item, [(rid, pno) for rid, pno, _ in ph[:PAGES_PER_HIT]]))
    results.sort(key=lambda x: x[0])
    total = len(results)
    top = results[:limit]
    want_pages = [p for _, _, ps in top for p in ps]
    texts: Dict[Tuple[int, int], str] = {}
    if want_pages:
        rids = {rid for rid, _ in want_pages}
        for rid, pno, text in db.execute(
            select(KbDocPage.revision_id, KbDocPage.page_no, KbDocPage.text).where(KbDocPage.revision_id.in_(rids))
        ):
            if (rid, pno) in want_pages:
                texts[(rid, pno)] = text
    documents = []
    for _, item, ps in top:
        item["pages"] = [{"page_no": pno, "snippet": _snippet(texts.get((rid, pno), ""), words)} for rid, pno in ps]
        documents.append(item)
    return {"words": words, "faults": faults, "documents": documents, "total": total}


# --------------------------------------------------------------------------- in-context links


def context(db: Session, user: User) -> Dict[str, Any]:
    """Released documents the user may see, keyed for the alarm rows and inverter pages:
    `fault_codes` {"Error:203": [...]}, `equipment` {model key: [...]}."""
    docs = [d for d in _visible_docs(db, user) if d.status == "released"]
    by_id = {d.id: d for d in docs}
    faults: Dict[str, List[Dict[str, Any]]] = {}
    equip: Dict[str, List[Dict[str, Any]]] = {}
    if by_id:
        for link in db.scalars(
            select(KbDocLink).where(KbDocLink.doc_id.in_(list(by_id)), KbDocLink.target_type.in_(("fault_code", "equipment")))
        ):
            d = by_id[link.doc_id]
            row = {"doc_id": d.id, "number": d.number, "title": title_of(d), "doc_type": d.doc_type, "page": link.page}
            (faults if link.target_type == "fault_code" else equip).setdefault(link.target_id, []).append(row)
    order = lambda rows: sorted(rows, key=lambda r: (r["doc_type"] not in ("manual", "datasheet"), r["number"], r["page"] or 0))  # noqa: E731
    return {"fault_codes": {k: order(v) for k, v in faults.items()}, "equipment": {k: order(v) for k, v in equip.items()}}


def plant_documents(db: Session, user: User, plant_id: int) -> Dict[str, Any]:
    """The plant's Documents tab: documents linked to the plant, manuals for its inverter models,
    and the general procedures (SOPs, work instructions, method statements, checklists)."""
    docs = _visible_docs(db, user)
    by_id = {d.id: d for d in docs}
    revs = _revs(db, docs)
    pinned = _pinned(db, user)
    models = _equipment_of_plants(db, {plant_id})
    linked: Dict[int, List[Optional[int]]] = {}
    equip: Dict[str, Dict[int, List[Optional[int]]]] = {k: {} for k in models}
    if by_id:
        for link in db.scalars(select(KbDocLink).where(KbDocLink.doc_id.in_(list(by_id)))):
            if link.target_type == "plant" and link.target_id == str(plant_id):
                linked.setdefault(link.doc_id, []).append(link.page)
            elif link.target_type == "equipment" and link.target_id in equip:
                equip[link.target_id].setdefault(link.doc_id, []).append(link.page)

    def item(did: int, pages: List[Optional[int]]) -> Dict[str, Any]:
        d = by_id[did]
        out = doc_summary(d, user, revs.get(d.current_rev_id or -1), pinned=did in pinned)
        out["pages"] = sorted({p for p in pages if p is not None})
        return out

    plant_items = sorted((item(i, p) for i, p in linked.items()), key=lambda x: (x["doc_type"], x["number"]))
    equipment = [
        {"model_key": k, "model": models[k][0], "inverters": models[k][1], "documents": sorted((item(i, p) for i, p in equip[k].items()), key=lambda x: x["number"])}
        for k in sorted(models, key=lambda k: -models[k][1])
    ]
    procedures = sorted(
        (item(d.id, []) for d in docs if d.general and d.status == "released" and d.doc_type in PROCEDURE_TYPES),
        key=lambda x: x["number"],
    )
    return {"plant_id": plant_id, "linked": plant_items, "equipment": equipment, "procedures": procedures}


def known_fault_codes(db: Session) -> List[Dict[str, Any]]:
    """Fault codes the alarm log has seen (type, code, Growatt's message, records), for the link
    picker. Codes only from stored data; none are invented."""
    from app.db.models import GrowattAlarm

    rows = db.execute(
        select(GrowattAlarm.fault_type, GrowattAlarm.alarm_code, func.max(GrowattAlarm.alarm_message), func.count())
        .where(GrowattAlarm.fault_type.is_not(None), GrowattAlarm.alarm_code.is_not(None))
        .group_by(GrowattAlarm.fault_type, GrowattAlarm.alarm_code)
    )
    out = [{"key": fault_key(t, c), "fault_type": str(t).capitalize(), "code": str(c), "message": m, "records": int(n)} for t, c, m, n in rows]
    out.sort(key=lambda r: (-r["records"], r["key"]))
    return out


def equipment_models(db: Session) -> List[Dict[str, Any]]:
    """Inverter models in the registry (installed inverters), for the link picker."""
    from app.services.inverter_models import INVERTER_MODELS

    have = _equipment_of_plants(db, None)
    for name in INVERTER_MODELS:
        have.setdefault(model_key(name), (name, 0))
    return [{"key": k, "model": v[0], "inverters": v[1]} for k, v in sorted(have.items(), key=lambda kv: (-kv[1][1], kv[1][0]))]


# --------------------------------------------------------------------------- OCR (worker)


def ocr_pending(db: Session, *, max_pages: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
    """OCR the pages waiting for it, oldest revision first, at most `KB_OCR_PAGES_PER_RUN` pages.
    Without tesseract (or none of `KB_OCR_LANGS` installed) the pages are marked "no text"
    (`queue_ocr_again` sends them back once it is installed)."""
    budget = max_pages if max_pages is not None else max(1, settings.kb_ocr_pages_per_run)
    langs = kb_pdf.ocr_langs()
    revs = list(db.scalars(select(KbDocRevision).where(KbDocRevision.text_status == "ocr_pending").order_by(KbDocRevision.created_at, KbDocRevision.id)))
    done = failed = 0
    left = 0
    for r in revs:
        pages = list(db.scalars(select(KbDocPage).where(KbDocPage.revision_id == r.id, KbDocPage.source == "pending").order_by(KbDocPage.page_no)))
        if langs is None:
            for p in pages:
                p.source = "none"
        elif budget <= 0:
            left += len(pages)
            continue
        else:
            take = pages[:budget]
            left += len(pages) - len(take)
            try:
                data = kb_storage.get_store().get(r.object_name)
                texts = kb_pdf.ocr_pages(data, [p.page_no for p in take], langs)
            except Exception:  # noqa: BLE001 - one bad file must not stop the others
                log.exception("OCR of revision %s failed", r.id)
                texts = {}
            for p in take:
                text = texts.get(p.page_no, "")
                p.text = text
                p.search_text = kb_pdf.search_form(text)
                p.source = "ocr" if kb_pdf.visible_chars(text) >= 3 else "none"
                done += p.page_no in texts
                failed += p.page_no not in texts
            budget -= len(take)
            r.ocr_langs = langs
        db.flush()
        r.text_status = _text_status(db.scalars(select(KbDocPage.source).where(KbDocPage.revision_id == r.id)))
        db.commit()
    detail = {"revisions": len(revs), "pages_read": done, "pages_failed": failed, "pages_left": left, "langs": langs}
    if langs is None and revs:
        detail["note"] = "tesseract (or the languages in KB_OCR_LANGS) is not installed: pages marked without text"
    return ("partial" if failed or left else "ok"), detail
