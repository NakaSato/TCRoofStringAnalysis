"""Knowledge Base phase 1 (docs/plans/knowledge-base.md): roles, draft visibility, 409, revisions,
restore, delete vs archive, slugs and the Thai word search."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_password
from app.db.models import KbRevision, User
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import kb


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'kb.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add(User(username="engineer2", email="engineer2@example.com", full_name="Second Engineer",
                    hashed_password=hash_password("engineer2pw"), role="engineer"))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return client, hdr("admin", "admin123"), hdr("engineer", "engineer123"), hdr("engineer2", "engineer2pw"), f


def _new(client, h, **kw):
    body = {"title": "Inverter reset SOP", "category": "sop", "tags": ["reset"], "body_md": "# Steps\n\n1. Switch **off** DC"}
    body.update(kw)
    r = client.post("/kb/articles", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_fields_and_validation(api):
    client, adm, eng, _, _ = api
    a = _new(client, eng, title="  Inverter reset SOP  ", tags=[" MAX 80KTL3 ", "max 80ktl3", "Reset"])
    assert a["slug"] == "inverter-reset-sop"
    assert a["title"] == "Inverter reset SOP"
    assert a["tags"] == ["MAX 80KTL3", "Reset"]
    assert a["status"] == "draft" and a["version"] == 1
    assert a["created_by"] == "engineer" and a["updated_by"] == "engineer"
    assert a["published_by"] is None and a["published_at"] is None
    assert a["created_at"].endswith("Z")
    assert a["can_edit"] is True and a["can_publish"] is False
    assert client.get(f"/kb/articles/{a['slug']}", headers=adm).json()["can_publish"] is True
    bad = [
        {"title": "   ", "category": "sop"},
        {"title": "x" * 201, "category": "sop"},
        {"title": "ok", "category": "nope"},
        {"title": "ok", "category": "sop", "tags": [" "]},
        {"title": "ok", "category": "sop", "tags": ["x" * 41]},
        {"title": "ok", "category": "sop", "tags": [f"t{i}" for i in range(21)]},
        {"title": "ok", "category": "sop", "body_md": "x" * 200_001},
    ]
    for body in bad:
        assert client.post("/kb/articles", json=body, headers=eng).status_code == 422, body
    # 20 tags after de-duplication is fine
    assert client.post("/kb/articles", json={"title": "ok", "category": "sop", "tags": [f"t{i}" for i in range(20)] + ["T0"]}, headers=eng).status_code == 201
    # PATCH needs base_version
    assert client.patch(f"/kb/articles/{a['id']}", json={"title": "x"}, headers=eng).status_code == 422


def test_roles_and_visibility(api):
    client, adm, eng, eng2, _ = api
    d = _new(client, eng, title="Engineer draft")
    # engineers can't publish, archive or delete
    for path in (f"/kb/articles/{d['id']}/publish", f"/kb/articles/{d['id']}/archive"):
        assert client.post(path, headers=eng).status_code == 403
    assert client.delete(f"/kb/articles/{d['id']}", headers=eng).status_code == 403
    # another engineer's draft is not found
    assert client.get(f"/kb/articles/{d['slug']}", headers=eng2).status_code == 404
    assert client.patch(f"/kb/articles/{d['id']}", json={"base_version": 1, "title": "x"}, headers=eng2).status_code == 404
    assert client.get(f"/kb/articles/{d['id']}/revisions", headers=eng2).status_code == 404
    assert client.get(f"/kb/articles/{d['id']}/revisions/1", headers=eng2).status_code == 404
    assert client.post(f"/kb/articles/{d['id']}/restore/1", json={"base_version": 1}, headers=eng2).status_code == 404
    assert [i["id"] for i in client.get("/kb/articles", headers=eng2).json()["items"]] == []
    # the author and admins see it
    assert [i["id"] for i in client.get("/kb/articles", headers=eng).json()["items"]] == [d["id"]]
    assert [i["id"] for i in client.get("/kb/articles", headers=adm).json()["items"]] == [d["id"]]
    # published: everyone sees and edits it
    r = client.post(f"/kb/articles/{d['id']}/publish", headers=adm)
    assert r.status_code == 200
    p = r.json()
    assert p["status"] == "published" and p["published_by"] == "admin" and p["published_at"]
    assert p["version"] == 1  # publish adds no version
    assert client.get(f"/kb/articles/{d['slug']}", headers=eng2).json()["can_edit"] is True
    r = client.patch(f"/kb/articles/{d['id']}", json={"base_version": 1, "body_md": "edited by eng2"}, headers=eng2)
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["updated_by"] == "engineer2"
    # archived: engineers get 404 (even the author), admins still see it
    a = client.post(f"/kb/articles/{d['id']}/archive", headers=adm).json()
    assert a["status"] == "archived" and a["version"] == 2
    for h in (eng, eng2):
        assert client.get(f"/kb/articles/{d['slug']}", headers=h).status_code == 404
        assert client.patch(f"/kb/articles/{d['id']}", json={"base_version": 2, "title": "x"}, headers=h).status_code == 404
        assert client.get("/kb/articles", headers=h).json()["items"] == []
        assert client.get("/kb/articles?status=archived", headers=h).json() == {"items": [], "total": 0, "tags": []}
    assert client.get(f"/kb/articles/{d['slug']}", headers=adm).status_code == 200
    assert client.get("/kb/articles", headers=adm).json()["items"] == []  # default never archived
    assert [i["id"] for i in client.get("/kb/articles?status=archived", headers=adm).json()["items"]] == [d["id"]]
    # publish un-archives
    assert client.post(f"/kb/articles/{d['id']}/publish", headers=adm).json()["status"] == "published"


def test_list_status_filter_tags_and_excerpt(api):
    client, adm, eng, eng2, _ = api
    mine = _new(client, eng, title="Mine", tags=["Zeta", "alpha"], body_md="## Heading\n\n**Bold** text with [a link](https://x.y) " + "word " * 80)
    other = _new(client, eng2, title="Other draft", tags=["secret"])
    pub = _new(client, adm, title="Published one", tags=["Beta"], category="safety")
    client.post(f"/kb/articles/{pub['id']}/publish", headers=adm)
    arch = _new(client, adm, title="Archived one", tags=["gone"])
    client.post(f"/kb/articles/{arch['id']}/publish", headers=adm)
    client.post(f"/kb/articles/{arch['id']}/archive", headers=adm)

    r = client.get("/kb/articles", headers=eng).json()
    assert {i["id"] for i in r["items"]} == {mine["id"], pub["id"]} and r["total"] == 2
    assert r["tags"] == ["alpha", "Beta", "Zeta"]
    item = next(i for i in r["items"] if i["id"] == mine["id"])
    assert "body_md" not in item
    assert item["excerpt"].startswith("Heading Bold text with a link word")
    assert item["excerpt"].endswith("…") and len(item["excerpt"]) <= 201
    assert [i["id"] for i in client.get("/kb/articles?status=draft", headers=eng).json()["items"]] == [mine["id"]]
    assert [i["id"] for i in client.get("/kb/articles?status=published", headers=eng).json()["items"]] == [pub["id"]]
    assert [i["id"] for i in client.get("/kb/articles?category=safety", headers=eng).json()["items"]] == [pub["id"]]
    assert [i["id"] for i in client.get("/kb/articles?tag=zeta", headers=eng).json()["items"]] == [mine["id"]]

    ra = client.get("/kb/articles", headers=adm).json()
    assert {i["id"] for i in ra["items"]} == {mine["id"], other["id"], pub["id"]}
    assert "gone" not in ra["tags"] and "secret" in ra["tags"]
    assert [i["id"] for i in client.get("/kb/articles?status=draft", headers=adm).json()["items"]] == [other["id"], mine["id"]]
    # newest first, paging
    page = client.get("/kb/articles?limit=1&offset=1", headers=adm).json()
    assert page["total"] == 3 and [i["id"] for i in page["items"]] == [other["id"]]
    assert client.get("/kb/articles?limit=0", headers=adm).status_code == 422
    assert client.get("/kb/articles?limit=201", headers=adm).status_code == 422
    assert client.get("/kb/articles?status=deleted", headers=adm).status_code == 422


def test_conflict_noop_and_revisions(api):
    client, adm, eng, _, f = api
    a = _new(client, eng)
    aid = a["id"]
    # no-op: same values, no version, no revision
    r = client.patch(f"/kb/articles/{aid}", json={"base_version": 1, "title": "Inverter reset SOP", "tags": ["reset"], "note": "nothing"}, headers=eng)
    assert r.status_code == 200 and r.json()["version"] == 1
    with f() as db:
        assert db.scalar(select(func.count()).select_from(KbRevision).where(KbRevision.article_id == aid)) == 1
    # a real edit
    r = client.patch(f"/kb/articles/{aid}", json={"base_version": 1, "title": "Inverter reset (renamed)", "body_md": "v2 body", "note": "rewrite"}, headers=eng)
    assert r.status_code == 200
    v2 = r.json()
    assert v2["version"] == 2 and v2["slug"] == "inverter-reset-sop"  # slug survives a rename
    assert client.get("/kb/articles/inverter-reset-sop", headers=eng).json()["body_md"] == "v2 body"
    # stale base_version → 409 with the current article
    r = client.patch(f"/kb/articles/{aid}", json={"base_version": 1, "body_md": "mine"}, headers=adm)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["message"] and detail["current"]["version"] == 2 and detail["current"]["body_md"] == "v2 body"
    # revisions newest first, without bodies
    revs = client.get(f"/kb/articles/{aid}/revisions", headers=eng).json()["items"]
    assert [x["rev_no"] for x in revs] == [2, 1]
    assert revs[0]["note"] == "rewrite" and revs[0]["author"] == "engineer" and "body_md" not in revs[0]
    assert set(revs[0]) == {"rev_no", "title", "category", "tags", "author", "note", "created_at"}
    r1 = client.get(f"/kb/articles/{aid}/revisions/1", headers=eng).json()
    assert r1["title"] == "Inverter reset SOP" and r1["body_md"].startswith("# Steps")
    assert client.get(f"/kb/articles/{aid}/revisions/9", headers=eng).status_code == 404
    # restore: stale → 409, else a new revision with the old content
    assert client.post(f"/kb/articles/{aid}/restore/1", json={"base_version": 1}, headers=eng).status_code == 409
    assert client.post(f"/kb/articles/{aid}/restore/9", json={"base_version": 2}, headers=eng).status_code == 404
    r = client.post(f"/kb/articles/{aid}/restore/1", json={"base_version": 2}, headers=eng)
    assert r.status_code == 200
    v3 = r.json()
    assert v3["version"] == 3 and v3["title"] == "Inverter reset SOP" and v3["body_md"].startswith("# Steps")
    revs = client.get(f"/kb/articles/{aid}/revisions", headers=eng).json()["items"]
    assert revs[0]["rev_no"] == 3 and revs[0]["note"] == "Restored revision 1"
    # the search text follows the restore
    assert client.get("/kb/articles?q=renamed", headers=eng).json()["total"] == 0
    assert client.get("/kb/articles?q=switch", headers=eng).json()["total"] == 1


def test_delete_draft_vs_archive_published(api):
    client, adm, eng, _, f = api
    d = _new(client, eng, title="Throwaway")
    client.patch(f"/kb/articles/{d['id']}", json={"base_version": 1, "body_md": "x"}, headers=eng)
    assert client.delete(f"/kb/articles/{d['id']}", headers=adm).json() == {"result": "deleted"}
    assert client.get(f"/kb/articles/{d['slug']}", headers=adm).status_code == 404
    with f() as db:
        assert db.scalar(select(func.count()).select_from(KbRevision).where(KbRevision.article_id == d["id"])) == 0
    p = _new(client, eng, title="Keeper")
    client.post(f"/kb/articles/{p['id']}/publish", headers=adm)
    assert client.delete(f"/kb/articles/{p['id']}", headers=adm).json() == {"result": "archived"}
    got = client.get(f"/kb/articles/{p['slug']}", headers=adm).json()
    assert got["status"] == "archived"
    assert len(client.get(f"/kb/articles/{p['id']}/revisions", headers=adm).json()["items"]) == 1
    assert client.delete("/kb/articles/9999", headers=adm).status_code == 404


def test_slugs(api):
    client, _, eng, _, _ = api
    thai = _new(client, eng, title="การรีเซ็ตอินเวอร์เตอร์")
    assert thai["slug"] == f"kb-{thai['id']}"
    a = _new(client, eng, title="Café & Inverter: Reset!")
    assert a["slug"] == "cafe-inverter-reset"
    b = _new(client, eng, title="cafe inverter reset")
    assert b["slug"] == f"cafe-inverter-reset-{b['id']}"
    mixed = _new(client, eng, title="MAX 80KTL3 รีเซ็ต")
    assert mixed["slug"] == "max-80ktl3"
    short = _new(client, eng, title="A1 ทดสอบ")
    assert short["slug"] == f"kb-{short['id']}"
    assert client.get(f"/kb/articles/{thai['slug']}", headers=eng).json()["id"] == thai["id"]


def test_thai_search_and_ranking(api):
    client, adm, eng, _, _ = api
    both = _new(client, eng, title="คู่มือหน้างาน", tags=[], body_md="เมื่อ **อินเวอร์เตอร์** แสดงไฟแดง ให้ตรวจสอบว่าระบบ ไม่ทำงาน หรือไม่")
    only_one = _new(client, eng, title="อีกบทความ", tags=[], body_md="อินเวอร์เตอร์ ทำงานปกติดี")
    r = client.get("/kb/articles", params={"q": "อินเวอร์เตอร์ ไม่ทำงาน"}, headers=eng).json()
    assert [i["id"] for i in r["items"]] == [both["id"]]
    assert {i["id"] for i in client.get("/kb/articles", params={"q": "อินเวอร์เตอร์"}, headers=eng).json()["items"]} == {both["id"], only_one["id"]}
    # title hit > tag hit > body hit, even when the body hit is newer
    title_hit = _new(client, eng, title="Relay check fail", body_md="steps")
    tag_hit = _new(client, eng, title="Something", tags=["relay"], body_md="steps")
    body_hit = _new(client, eng, title="Other thing", body_md="the relay clicks")
    ids = [i["id"] for i in client.get("/kb/articles", params={"q": "relay"}, headers=eng).json()["items"]]
    assert ids == [title_hit["id"], tag_hit["id"], body_hit["id"]]
    # LIKE wildcards are literal; a query of Markdown marks only has no words (= no filter)
    assert client.get("/kb/articles", params={"q": "%"}, headers=eng).json()["total"] == 0
    assert client.get("/kb/articles", params={"q": "relay **"}, headers=eng).json()["total"] == 3
    # an edit refreshes the search text
    client.patch(f"/kb/articles/{body_hit['id']}", json={"base_version": 1, "body_md": "no match now"}, headers=eng)
    ids = [i["id"] for i in client.get("/kb/articles", params={"q": "relay"}, headers=eng).json()["items"]]
    assert ids == [title_hit["id"], tag_hit["id"]]


def test_strip_markdown():
    s = kb.strip_markdown("# Title\n> - **bold** _it_ `code` fault_type\n\n| a | b |\n|---|---|\n![pic](kb-asset:1) [link](http://x)")
    assert s == "Title bold it code fault_type a b pic link"
