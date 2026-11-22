"""Knowledge Base phase 1: articles (Markdown text), revisions, edit conflicts and the word search
(docs/plans/knowledge-base.md).

The service owns what the page and a future assistant tool must agree on: who may see an article,
its slug, the search text, the version check and the revision snapshots. SQL only (never
Firestore), kept indefinitely.

Access (the routes add the role checks): admins see every article; engineers see `published`
articles plus the drafts they created themselves; anything else (others' drafts, every archived
article) is "not found" to them, so ids are not revealed. Whoever may see an article may edit it
(admins and engineers); publish / archive / delete are admin only.

Search: the query is split on whitespace (the browser pre-splits Thai into words with
`Intl.Segmenter`) and every word must appear in `search_text` (`LIKE %word%`, SQLite and
Postgres). Ranking: all words in the title, then all words in title + tags, then the rest (body);
ties by the number of words in the title, then in the tags, then the newest change first.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer

from app.db.models import KbArticle, KbRevision, User
from app.db.models.base import _utcnow

CATEGORIES = ("sop", "troubleshooting", "alarm_code", "equipment", "safety", "other")
STATUSES = ("draft", "published", "archived")
EXCERPT_CHARS = 200
SLUG_MAX = 80
Q_MAX = 500
Q_WORDS_MAX = 20
_HEAD_CHARS = 1500  # body read for a list excerpt (Markdown is stripped from it first)
_FIELDS = ("title", "category", "tags", "body_md")


class KbNotFound(Exception):
    """No such article / revision, or one the user may not see: 404."""


class KbConflict(Exception):
    """A save against an older version: 409 with the current article (body included)."""

    def __init__(self, message: str, current: Dict[str, Any]):
        super().__init__(message)
        self.message = message
        self.current = current


# --------------------------------------------------------------------------- helpers


def _name(user: User) -> str:
    return user.username or user.email


def _iso(ts: Optional[datetime]) -> Optional[str]:
    """UTC ISO string; SQLite drops the zone, so a naive value is read as UTC."""
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sort_ts(a: KbArticle) -> float:
    ts = a.updated_at or a.created_at
    if ts is None:
        return 0.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.timestamp()


_RE_FENCE = re.compile(r"^\s*(```|~~~)[^\n]*$", re.M)
_RE_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_RE_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_RE_AUTOLINK = re.compile(r"<((?:https?|mailto):[^>\s]+)>")
_RE_HTML = re.compile(r"</?[A-Za-z][^>]*>")
_RE_BLOCK = re.compile(r"^[ \t]{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+", re.M)
_RE_RULE = re.compile(r"^[ \t]*\|?[ \t]*:?-{3,}[-|: \t]*$|^[ \t]*([*_-])(?:[ \t]*\1){2,}[ \t]*$", re.M)
_RE_EMPH = re.compile(r"[*~`]+|(?<!\w)_+|_+(?!\w)")
_RE_PUNCT = re.compile(r"[|#>\[\]]")
_RE_SPACE = re.compile(r"\s+")


def strip_markdown(text: str) -> str:
    """Markdown → plain words: link / image text kept (URLs dropped), headings, quotes, list
    markers, rules, table pipes, emphasis and code marks removed, whitespace collapsed. Underscores
    inside words (`fault_type`) stay."""
    t = text or ""
    t = _RE_FENCE.sub(" ", t)
    t = _RE_IMAGE.sub(r"\1", t)
    t = _RE_LINK.sub(r"\1", t)
    t = _RE_AUTOLINK.sub(r"\1", t)
    t = _RE_HTML.sub(" ", t)
    t = _RE_RULE.sub(" ", t)
    for _ in range(3):  # nested markers: "> - item", "1. > quote"
        t = _RE_BLOCK.sub("", t)
    t = _RE_EMPH.sub("", t)
    t = _RE_PUNCT.sub(" ", t)
    return _RE_SPACE.sub(" ", t).strip()


def build_search_text(title: str, tags: Iterable[str], body_md: str) -> str:
    return " ".join(p for p in (strip_markdown(title), " ".join(tags), strip_markdown(body_md)) if p).lower()


def excerpt(body_md: str) -> str:
    t = strip_markdown(body_md)
    return t if len(t) <= EXCERPT_CHARS else t[:EXCERPT_CHARS].rstrip() + "…"


def query_words(q: Optional[str]) -> List[str]:
    """The search words: split on whitespace, normalised like `search_text`, de-duplicated."""
    if not q:
        return []
    out: List[str] = []
    for raw in q[:Q_MAX].split():
        for w in strip_markdown(raw).lower().split():
            if w not in out:
                out.append(w)
    return out[:Q_WORDS_MAX]


def slug_base(title: str) -> str:
    """ASCII `[a-z0-9-]` from the title (accents folded, everything else a hyphen)."""
    s = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:SLUG_MAX].strip("-")


def _slug_taken(db: Session, slug: str, article_id: int) -> bool:
    return db.scalar(select(KbArticle.id).where(KbArticle.slug == slug, KbArticle.id != article_id)) is not None


def _make_slug(db: Session, title: str, article_id: int) -> str:
    base = slug_base(title)
    if len(base) < 3:
        base = f"kb-{article_id}"
    if not _slug_taken(db, base, article_id):
        return base
    return f"{base}-{article_id}"


# --------------------------------------------------------------------------- access


def is_admin(user: User) -> bool:
    return user.role == "admin"


def can_view(a: KbArticle, user: User) -> bool:
    if is_admin(user):
        return True
    if a.status == "published":
        return True
    return a.status == "draft" and a.created_by_user_id == user.id


def can_edit(a: KbArticle, user: User) -> bool:
    return user.role in ("admin", "engineer") and can_view(a, user)


def _visible(user: User, status: Optional[str] = None):
    """SQL condition for the articles the user may see (default: every status but archived)."""
    A = KbArticle
    if is_admin(user):
        return A.status == status if status else A.status != "archived"
    own_draft = and_(A.status == "draft", A.created_by_user_id == user.id)
    if status == "published":
        return A.status == "published"
    if status == "draft":
        return own_draft
    if status == "archived":
        return A.id.is_(None)  # never: engineers see no archived article
    return or_(A.status == "published", own_draft)


# --------------------------------------------------------------------------- output


def article_out(a: KbArticle, user: User, *, body: bool = True, head: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "id": a.id,
        "slug": a.slug,
        "title": a.title,
        "category": a.category,
        "tags": list(a.tags or []),
    }
    if body:
        out["body_md"] = a.body_md
    else:
        out["excerpt"] = excerpt(head or "")
    out.update(
        {
            "status": a.status,
            "version": a.version,
            "created_by": a.created_by,
            "created_at": _iso(a.created_at),
            "updated_by": a.updated_by,
            "updated_at": _iso(a.updated_at),
            "published_by": a.published_by,
            "published_at": _iso(a.published_at),
            "can_edit": can_edit(a, user),
            "can_publish": is_admin(user),
        }
    )
    return out


def revision_out(r: KbRevision, *, body: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "rev_no": r.rev_no,
        "title": r.title,
        "category": r.category,
        "tags": list(r.tags or []),
    }
    if body:
        out["body_md"] = r.body_md
    out.update({"author": r.author, "note": r.note, "created_at": _iso(r.created_at)})
    return out


# --------------------------------------------------------------------------- reads


def get_visible(db: Session, user: User, article_id: int) -> KbArticle:
    a = db.get(KbArticle, article_id)
    if a is None or not can_view(a, user):
        raise KbNotFound(f"Article {article_id} not found")
    return a


def get_by_slug(db: Session, user: User, slug: str) -> KbArticle:
    a = db.scalar(select(KbArticle).where(KbArticle.slug == slug))
    if a is None or not can_view(a, user):
        raise KbNotFound(f"Article {slug!r} not found")
    return a


def _rank(a: KbArticle, words: List[str]) -> Tuple[int, int, int, float]:
    title = a.title.lower()
    tags = " ".join(a.tags or []).lower()
    in_title = sum(1 for w in words if w in title)
    in_tags = sum(1 for w in words if w in tags)
    in_head = sum(1 for w in words if w in title or w in tags)
    tier = 0 if in_title == len(words) else 1 if in_head == len(words) else 2
    return (tier, -in_title, -in_tags, -_sort_ts(a))


def list_articles(
    db: Session,
    user: User,
    *,
    q: Optional[str] = None,
    category: Optional[str] = None,
    tag: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    A = KbArticle
    stmt = select(A).options(defer(A.body_md), defer(A.search_text)).where(_visible(user, status))
    if category:
        stmt = stmt.where(A.category == category)
    words = query_words(q)
    for w in words:
        stmt = stmt.where(func.lower(A.search_text).contains(w, autoescape=True))
    rows = list(db.scalars(stmt))
    if tag and tag.strip():
        want = tag.strip().lower()
        rows = [a for a in rows if any(t.lower() == want for t in (a.tags or []))]
    if words:
        rows.sort(key=lambda a: _rank(a, words))
    else:
        rows.sort(key=lambda a: (-_sort_ts(a), -a.id))
    total = len(rows)
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    page = rows[offset : offset + limit]
    heads: Dict[int, str] = {}
    if page:
        heads = {
            i: h or ""
            for i, h in db.execute(
                select(A.id, func.substr(A.body_md, 1, _HEAD_CHARS)).where(A.id.in_([a.id for a in page]))
            )
        }
    all_tags: Dict[str, str] = {}
    for tags in db.scalars(select(A.tags).where(_visible(user))):
        for t in tags or []:
            all_tags.setdefault(t, t)
    return {
        "items": [article_out(a, user, body=False, head=heads.get(a.id, "")) for a in page],
        "total": total,
        "tags": sorted(all_tags, key=lambda t: (t.lower(), t)),
    }


def list_revisions(db: Session, a: KbArticle) -> Dict[str, Any]:
    rows = db.scalars(
        select(KbRevision)
        .options(defer(KbRevision.body_md))
        .where(KbRevision.article_id == a.id)
        .order_by(KbRevision.rev_no.desc())
    )
    return {"items": [revision_out(r, body=False) for r in rows]}


def get_revision(db: Session, a: KbArticle, rev_no: int) -> KbRevision:
    r = db.scalar(select(KbRevision).where(KbRevision.article_id == a.id, KbRevision.rev_no == rev_no))
    if r is None:
        raise KbNotFound(f"Revision {rev_no} of article {a.id} not found")
    return r


# --------------------------------------------------------------------------- writes


def _snapshot(a: KbArticle, author: str, note: Optional[str], now: datetime) -> KbRevision:
    return KbRevision(
        article_id=a.id,
        rev_no=a.version,
        title=a.title,
        category=a.category,
        tags=list(a.tags or []),
        body_md=a.body_md,
        author=author,
        note=note,
        created_at=now,
    )


def _check_version(a: KbArticle, base_version: int, user: User) -> None:
    if base_version != a.version:
        raise KbConflict(
            f"Someone saved a newer version (version {a.version}; your edit was based on {base_version}).",
            article_out(a, user),
        )


def _commit_save(db: Session, a: KbArticle, user: User) -> None:
    """Commit a new version; a concurrent save of the same version (unique rev_no) → 409."""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        db.refresh(a)
        raise KbConflict("Someone saved a newer version at the same time.", article_out(a, user)) from None


def create_article(db: Session, user: User, fields: Dict[str, Any]) -> KbArticle:
    now = _utcnow()
    who = _name(user)
    tags = list(fields.get("tags") or [])
    body = fields.get("body_md") or ""
    a = KbArticle(
        slug=f"tmp-{uuid.uuid4().hex}",
        title=fields["title"],
        category=fields["category"],
        tags=tags,
        body_md=body,
        search_text=build_search_text(fields["title"], tags, body),
        status="draft",
        version=1,
        created_by=who,
        created_by_user_id=user.id,
        created_at=now,
        updated_by=who,
        updated_at=now,
    )
    db.add(a)
    db.flush()
    a.slug = _make_slug(db, a.title, a.id)
    db.add(_snapshot(a, who, fields.get("note"), now))
    db.commit()
    db.refresh(a)
    return a


def update_article(db: Session, user: User, a: KbArticle, fields: Dict[str, Any]) -> List[str]:
    """Apply the fields sent (null = unchanged) on `base_version`. Returns the changed field
    names; nothing changed = no new version, no revision."""
    _check_version(a, int(fields["base_version"]), user)
    changes = {k: fields[k] for k in _FIELDS if fields.get(k) is not None and fields[k] != getattr(a, k)}
    if not changes:
        return []
    return _save(db, user, a, changes, fields.get("note"))


def _save(db: Session, user: User, a: KbArticle, changes: Dict[str, Any], note: Optional[str]) -> List[str]:
    now = _utcnow()
    who = _name(user)
    for k, v in changes.items():
        setattr(a, k, list(v) if k == "tags" else v)
    a.search_text = build_search_text(a.title, a.tags or [], a.body_md)
    a.version += 1
    a.updated_by = who
    a.updated_at = now
    db.add(_snapshot(a, who, note, now))
    _commit_save(db, a, user)
    db.refresh(a)
    return list(changes)


def restore_revision(db: Session, user: User, a: KbArticle, rev_no: int, base_version: int) -> KbArticle:
    """Save revision `rev_no`'s content as a new revision (always a new version)."""
    r = get_revision(db, a, rev_no)
    _check_version(a, base_version, user)
    changes = {"title": r.title, "category": r.category, "tags": list(r.tags or []), "body_md": r.body_md}
    _save(db, user, a, changes, f"Restored revision {rev_no}")
    return a


def publish(db: Session, user: User, a: KbArticle) -> bool:
    """Publish (also un-archives). No new version or revision. False = already published."""
    if a.status == "published":
        return False
    a.status = "published"
    a.published_by = _name(user)
    a.published_at = _utcnow()
    db.commit()
    db.refresh(a)
    return True


def archive(db: Session, a: KbArticle) -> bool:
    """Archive. No new version or revision. False = already archived."""
    if a.status == "archived":
        return False
    a.status = "archived"
    db.commit()
    db.refresh(a)
    return True


def delete_article(db: Session, a: KbArticle) -> str:
    """A never-published draft is deleted with its revisions (`deleted`); anything else is
    archived (`archived`)."""
    if a.status == "draft" and a.published_at is None:
        db.execute(delete(KbRevision).where(KbRevision.article_id == a.id))
        db.delete(a)
        db.commit()
        return "deleted"
    archive(db, a)
    return "archived"
