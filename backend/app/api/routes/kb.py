"""Knowledge Base phase 1: O&M manuals, text only (docs/plans/knowledge-base.md).

Everyone signed in reads (engineers: published articles plus their own drafts; anything else
404). Admins and engineers create, edit and restore; admins publish, archive and delete. A save
against an older `version` answers 409 with `detail = {message, current}`.
"""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_admin, require_write_access
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import KbArticleCreate, KbArticlePatch, KbCategoryName, KbRestoreBody
from app.services import kb as svc
from app.api.routes.growatt._common import audit

router = APIRouter(prefix="/kb", tags=["Knowledge Base"])


def _who(user: User) -> str:
    return user.username or user.email


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, svc.KbNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, svc.KbConflict):
        return HTTPException(status_code=409, detail={"message": exc.message, "current": exc.current})
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (svc.KbNotFound, svc.KbConflict, ValueError)


def _article(db: Session, user: User, article_id: int):
    try:
        return svc.get_visible(db, user, article_id)
    except svc.KbNotFound as exc:
        raise _errors(exc) from exc


@router.get("/articles")
def list_articles(
    q: Optional[str] = Query(None, max_length=svc.Q_MAX),
    category: Optional[KbCategoryName] = Query(None),
    tag: Optional[str] = Query(None, max_length=40),
    status: Optional[Literal["draft", "published", "archived"]] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Articles the user may see (never archived unless `status=archived`, admins only), with
    `excerpt` instead of `body_md`; `tags` = every tag over the visible non-archived articles."""
    return svc.list_articles(db, user, q=q, category=category, tag=tag, status=status, limit=limit, offset=offset)


@router.post("/articles", status_code=201)
def create_article(payload: KbArticleCreate, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """A new draft, revision 1. The slug is made from the title once and never changes."""
    a = svc.create_article(db, user, payload.model_dump())
    audit.info("%s created KB article %s (%s, draft)", _who(user), a.slug, a.category)
    return svc.article_out(a, user)


@router.get("/articles/{slug}")
def get_article(slug: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    try:
        a = svc.get_by_slug(db, user, slug)
    except svc.KbNotFound as exc:
        raise _errors(exc) from exc
    return svc.article_out(a, user)


@router.patch("/articles/{article_id}")
def patch_article(
    article_id: int, payload: KbArticlePatch, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Change the fields sent on `base_version` (409 with the current article when stale). A
    PATCH that changes nothing answers the article unchanged (no new version or revision)."""
    a = _article(db, user, article_id)
    try:
        changed = svc.update_article(db, user, a, payload.model_dump(exclude_unset=True))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    if changed:
        audit.info("%s edited KB article %s → v%d (%s)", _who(user), a.slug, a.version, ", ".join(changed))
    return svc.article_out(a, user)


@router.post("/articles/{article_id}/publish")
def publish_article(article_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    a = _article(db, user, article_id)
    if svc.publish(db, user, a):
        audit.info("%s published KB article %s", _who(user), a.slug)
    return svc.article_out(a, user)


@router.post("/articles/{article_id}/archive")
def archive_article(article_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    a = _article(db, user, article_id)
    if svc.archive(db, a):
        audit.info("%s archived KB article %s", _who(user), a.slug)
    return svc.article_out(a, user)


@router.delete("/articles/{article_id}")
def delete_article(article_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, str]:
    """A never-published draft is deleted with its revisions; anything else is archived."""
    a = _article(db, user, article_id)
    slug = a.slug
    result = svc.delete_article(db, a)
    audit.info("%s deleted KB article %s (%s)", _who(user), slug, result)
    return {"result": result}


@router.get("/articles/{article_id}/revisions")
def list_revisions(article_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Revisions newest first, without bodies."""
    return svc.list_revisions(db, _article(db, user, article_id))


@router.get("/articles/{article_id}/revisions/{rev_no}")
def get_revision(article_id: int, rev_no: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    a = _article(db, user, article_id)
    try:
        r = svc.get_revision(db, a, rev_no)
    except svc.KbNotFound as exc:
        raise _errors(exc) from exc
    return svc.revision_out(r, body=True)


@router.post("/articles/{article_id}/restore/{rev_no}")
def restore_revision(
    article_id: int, rev_no: int, payload: KbRestoreBody, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Save revision `rev_no`'s content as a new revision (note "Restored revision N")."""
    a = _article(db, user, article_id)
    try:
        svc.restore_revision(db, user, a, rev_no, payload.base_version)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s restored KB article %s to revision %d → v%d", _who(user), a.slug, rev_no, a.version)
    return svc.article_out(a, user)
