"""Knowledge Base library: PDF documents (docs/plans/kb-documents.md, spec phase 1).

Everyone signed in reads what they may see (`services/kb_docs.py`: released / superseded, own
drafts, plant scope; anything else 404). Admins and engineers upload; engineers edit only their
own drafts; admins edit anything, release, withdraw, supersede and delete.

`router` needs a signed-in user (added in main.py). `files_router` is the one exception: it serves
a stored file to a link signed by `/kb/docs/{id}/file` (HMAC, `KB_FILE_URL_TTL_S`), so the PDF
viewer and a plain download link work without an Authorization header.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_admin, require_plant_read, require_write_access
from app.config import settings
from app.db.models import KbDocRevision, KbDocument, User
from app.db.session import get_db
from app.schemas.api_schemas import (
    KbDocCreate,
    KbDocLinks,
    KbDocPatch,
    KbDocPinBody,
    KbDocSupersede,
    KbDocTypeName,
    KbDocWithdraw,
    KbLanguageName,
)
from app.services import jobs, kb_docs as svc, kb_storage
from app.services import plant_documents
from app.api.routes.growatt._common import audit

router = APIRouter(prefix="/kb", tags=["Knowledge Base"])
files_router = APIRouter(prefix="/kb", tags=["Knowledge Base"])


def _who(user: User) -> str:
    return user.username or user.email


def _err(exc: Exception) -> HTTPException:
    if isinstance(exc, svc.DocNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, svc.DocConflict):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, kb_storage.StorageUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (svc.DocNotFound, svc.DocConflict, svc.DocInvalid, kb_storage.StorageUnavailable)


def _doc(db: Session, user: User, doc_id: int) -> KbDocument:
    try:
        return svc.get_visible(db, user, doc_id)
    except svc.DocNotFound as exc:
        raise _err(exc) from exc


def _editable(db: Session, user: User, doc_id: int) -> KbDocument:
    d = _doc(db, user, doc_id)
    if not svc.can_edit(d, user):
        raise HTTPException(status_code=403, detail="Only an admin edits this document (engineers edit their own drafts).")
    return d


async def _read_upload(file: UploadFile) -> bytes:
    limit = settings.kb_max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"The file is larger than {settings.kb_max_upload_mb} MB.")
    return data


def _queue_ocr(db: Session, r: KbDocRevision) -> None:
    if r.text_status != "ocr_pending":
        return
    try:
        jobs.enqueue(db, "kb_ocr", trigger="upload")
    except jobs.JobBusy:
        pass  # a run is queued or running already; it picks these pages up too


# --------------------------------------------------------------------------- reads


@router.get("/docs")
def list_documents(
    type: Optional[KbDocTypeName] = Query(None),
    status: Optional[str] = Query(None, pattern="^(draft|released|superseded|withdrawn)$"),
    language: Optional[KbLanguageName] = Query(None),
    equipment: Optional[str] = Query(None, max_length=64),
    plant_id: Optional[int] = Query(None),
    fault: Optional[str] = Query(None, max_length=40),
    tag: Optional[str] = Query(None, max_length=40),
    owner: Optional[str] = Query(None, max_length=64),
    q: Optional[str] = Query(None, max_length=500),
    sort: str = Query("updated", pattern="^(updated|number|title)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Visible documents (withdrawn only for admins with `status=withdrawn`); `q` = words in the
    metadata (the page text is searched by `/kb/search`)."""
    if status == "withdrawn" and not svc.is_admin(user):
        return {"items": [], "total": 0, "facets": {"tags": [], "owners": [], "equipment": []}}
    return svc.list_docs(
        db, user, doc_type=type, status=status, language=language, equipment=equipment, plant_id=plant_id,
        fault=fault, tag=tag, owner=owner, q=q, sort=sort, limit=limit, offset=offset,
    )


@router.get("/docs/home")
def library_home(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """"Pinned for you": pins, documents for the user's plants and their equipment, newest changes."""
    return svc.home(db, user)


@router.get("/docs/context")
def document_context(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Released documents by fault code and by inverter model (alarm rows, inverter pages)."""
    return svc.context(db, user)


@router.get("/docs/catalog")
def link_catalog(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Choices for the link editor: fault codes seen in the alarm log, inverter models, the next
    document number per type / discipline is asked for separately."""
    return {
        "fault_codes": svc.known_fault_codes(db),
        "equipment": svc.equipment_models(db),
        "doc_types": svc.DOC_TYPES,
        "disciplines": list(svc.DISCIPLINES),
        "ocr": {"langs": svc.kb_pdf.ocr_langs()},
        "max_upload_mb": settings.kb_max_upload_mb,
    }


@router.get("/docs/next-number")
def next_number(
    type: KbDocTypeName = Query(...),
    discipline: str = Query(..., pattern="^(OM|ENG|INV|MOD|ELE|INS|SAF|GEN)$"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> Dict[str, str]:
    return {"number": svc.next_number(db, type, discipline)}


@router.get("/search")
def search(
    q: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(20, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Fault-code links, then documents with the matching pages and a snippet each."""
    return svc.search(db, user, q, limit=limit)


@router.get("/docs/{doc_id}")
def get_document(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return svc.doc_out(db, _doc(db, user, doc_id), user)


@router.get("/docs/{doc_id}/file")
def document_file(
    doc_id: int,
    rev: Optional[int] = Query(None, ge=1),
    download: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """A short-lived link to the file of the current (or `rev`) revision, never changed."""
    d = _doc(db, user, doc_id)
    try:
        r = svc.get_revision(db, d, rev)
        return svc.file_link(d, r, download=download)
    except _HANDLED as exc:
        raise _err(exc) from exc


@router.get("/plants/{plant_id}/documents")
def plant_documents_tab(plant_id: int, db: Session = Depends(get_db), user: User = Depends(require_plant_read)) -> Dict[str, Any]:
    """The plant's Documents tab: the as-built / site photo links, documents linked to the plant,
    manuals for its inverter models, general procedures."""
    out = svc.plant_documents(db, user, plant_id)
    out["drive"] = plant_documents.for_plant(db, plant_id)
    return out


# --------------------------------------------------------------------------- writes


@router.post("/docs", status_code=201)
async def upload_document(
    file: UploadFile = File(...),
    meta: str = Form(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Upload a PDF as a new draft (revision 1). `meta` = KbDocCreate as JSON."""
    try:
        fields = KbDocCreate.model_validate(json.loads(meta)).model_dump()
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail=f"meta: {exc}") from exc
    data = await _read_upload(file)
    try:
        d = svc.create_doc(db, user, fields, data, file.filename)
    except _HANDLED as exc:
        raise _err(exc) from exc
    r = db.get(KbDocRevision, d.current_rev_id)
    if r is None:  # create_doc always writes the first revision
        raise HTTPException(status_code=500, detail="the new document has no revision")
    _queue_ocr(db, r)
    audit.info("%s uploaded KB document %s (%s, %d pages, sha256 %s)", _who(user), d.number, d.doc_type, r.page_count, r.sha256[:12])
    return svc.doc_out(db, d, user)


@router.post("/docs/{doc_id}/revisions", status_code=201)
async def upload_revision(
    doc_id: int,
    file: UploadFile = File(...),
    label: Optional[str] = Form(None, max_length=40),
    change_note: Optional[str] = Form(None, max_length=500),
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """A new file for the document; it becomes the current revision (the older ones stay)."""
    d = _editable(db, user, doc_id)
    data = await _read_upload(file)
    try:
        r = svc.add_revision(db, user, d, data, file.filename, label, change_note)
    except _HANDLED as exc:
        raise _err(exc) from exc
    _queue_ocr(db, r)
    audit.info("%s uploaded revision %d of KB document %s (sha256 %s)", _who(user), r.rev_no, d.number, r.sha256[:12])
    return svc.doc_out(db, d, user)


@router.patch("/docs/{doc_id}")
def patch_document(doc_id: int, payload: KbDocPatch, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    d = _editable(db, user, doc_id)
    try:
        changed = svc.update_doc(db, user, d, payload.model_dump(exclude_unset=True))
    except _HANDLED as exc:
        raise _err(exc) from exc
    if changed:
        audit.info("%s edited KB document %s (%s)", _who(user), d.number, ", ".join(changed))
    return svc.doc_out(db, d, user)


@router.put("/docs/{doc_id}/links")
def put_links(doc_id: int, payload: KbDocLinks, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """Replace the document's links (fault codes, equipment, plants; each with an optional page)."""
    d = _editable(db, user, doc_id)
    try:
        svc.replace_links(db, user, d, [x.model_dump() for x in payload.links])
    except _HANDLED as exc:
        raise _err(exc) from exc
    audit.info("%s set %d links on KB document %s", _who(user), len(payload.links), d.number)
    return svc.doc_out(db, d, user)


@router.put("/docs/{doc_id}/pin")
def pin_document(doc_id: int, payload: KbDocPinBody, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, bool]:
    d = _doc(db, user, doc_id)
    return {"pinned": svc.set_pin(db, user, d, payload.pinned)}


@router.post("/docs/{doc_id}/release")
def release_document(doc_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    d = _doc(db, user, doc_id)
    try:
        if svc.release(db, user, d):
            audit.info("%s released KB document %s", _who(user), d.number)
    except _HANDLED as exc:
        raise _err(exc) from exc
    return svc.doc_out(db, d, user)


@router.post("/docs/{doc_id}/withdraw")
def withdraw_document(doc_id: int, payload: KbDocWithdraw, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    d = _doc(db, user, doc_id)
    try:
        if svc.withdraw(db, user, d, payload.reason):
            audit.info("%s withdrew KB document %s: %s", _who(user), d.number, payload.reason)
    except _HANDLED as exc:
        raise _err(exc) from exc
    return svc.doc_out(db, d, user)


@router.post("/docs/{doc_id}/supersede")
def supersede_document(doc_id: int, payload: KbDocSupersede, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    d = _doc(db, user, doc_id)
    try:
        svc.supersede(db, user, d, payload.by_doc_id, payload.note)
    except _HANDLED as exc:
        raise _err(exc) from exc
    audit.info("%s marked KB document %s superseded (by %s)", _who(user), d.number, payload.by_doc_id)
    return svc.doc_out(db, d, user)


@router.post("/docs/{doc_id}/revisions/{rev_no}/ocr")
def ocr_again(doc_id: int, rev_no: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    """Send the revision's pages without text back to OCR (after tesseract / a language was added)."""
    d = _doc(db, user, doc_id)
    try:
        r = svc.get_revision(db, d, rev_no)
    except _HANDLED as exc:
        raise _err(exc) from exc
    n = svc.queue_ocr_again(db, r)
    _queue_ocr(db, r)
    return {"pages": n, "text_status": r.text_status}


@router.delete("/docs/{doc_id}")
def delete_document(doc_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, str]:
    """A never-released draft is deleted with its files; anything else is withdrawn."""
    d = _doc(db, user, doc_id)
    number = d.number
    result = svc.delete_doc(db, user, d)
    audit.info("%s deleted KB document %s (%s)", _who(user), number, result)
    return {"result": result}


# --------------------------------------------------------------------------- signed file (no auth header)


@files_router.get("/files/{revision_id}", include_in_schema=False)
def serve_file(
    revision_id: int,
    exp: int = Query(...),
    sig: str = Query(..., max_length=64),
    download: bool = Query(False),
    db: Session = Depends(get_db),
):
    if not kb_storage.check_api_sig(revision_id, exp, sig, download):
        raise HTTPException(status_code=403, detail="The link is invalid or has expired; open the document again.")
    r = db.get(KbDocRevision, revision_id)
    d = db.get(KbDocument, r.doc_id) if r else None
    if r is None or d is None:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        store = kb_storage.get_store()
    except kb_storage.StorageUnavailable as exc:
        raise _err(exc) from exc
    fname = svc.file_name(d, r)
    url = store.signed_url(r.object_name, filename=fname, download=download, ttl_s=300)
    if url:
        return RedirectResponse(url, status_code=302)
    path = store.path(r.object_name)  # type: ignore[attr-defined]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=fname,
        content_disposition_type="attachment" if download else "inline",
        headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"},
    )
