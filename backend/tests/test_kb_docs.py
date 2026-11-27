"""Knowledge Base library (docs/plans/kb-documents.md): PDF upload, unchanged file + checksum,
page text and search, numbering, plant scope, links (fault codes, equipment, plants), release /
withdraw / supersede, revisions, signed file links, the plant Documents tab and OCR."""

from __future__ import annotations

import hashlib
import json
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_password
from app.db.models import GrowattInverter, GrowattPlant, KbDocPage, KbDocRevision, SyncRun, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import kb_docs, kb_pdf, kb_storage


def make_pdf(pages: list[str]) -> bytes:
    """A small valid PDF, one Helvetica line per page ("" = a page with no text layer)."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(len(pages)))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>")
    font = 3 + 2 * len(pages)
    for i, text in enumerate(pages):
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {4 + 2 * i} 0 R >>"
        )
        s = f"BT /F1 18 Tf 72 700 Td ({text}) Tj ET" if text else ""
        objs.append(f"<< /Length {len(s)} >>\nstream\n{s}\nendstream")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out, offs = "%PDF-1.4\n", []
    for n, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{n} 0 obj\n{o}\nendobj\n"
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
    return out.encode("latin-1")


MANUAL = make_pdf(["Growatt MAX inverter user manual", "9.3 Fault codes: 203 PV isolation low, check MC4 connectors", "Bus voltage abnormal"])


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'kbdocs.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add(User(username="engineer2", email="engineer2@example.com", full_name="Second Engineer",
                    hashed_password=hash_password("engineer2pw"), role="engineer"))
        db.add_all([GrowattPlant(plant_id=101, name="Fah Saeng"), GrowattPlant(plant_id=202, name="Other Roof")])
        db.flush()
        db.add(GrowattInverter(plant_id=101, device_sn="SN101A", device_model="MAX 125KTL3-X LV"))
        eng = db.scalar(select(User).where(User.username == "engineer"))
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=101))
        db.commit()
    kb_storage.reset_store(kb_storage.LocalStore(tmp_path / "files"))
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    yield client, hdr("admin", "admin123"), hdr("engineer", "engineer123"), hdr("engineer2", "engineer2pw"), f, tmp_path
    kb_storage.reset_store()


def upload(client, h, data=MANUAL, **meta):
    m = {"doc_type": "manual", "discipline": "INV", "title_en": "Growatt MAX 100-125KTL3-X manual", "label": "v1.2"}
    m.update(meta)
    r = client.post("/kb/docs", headers=h, data={"meta": json.dumps(m)}, files={"file": ("growatt max.pdf", data, "application/pdf")})
    return r


def test_upload_keeps_file_unchanged_and_reads_pages(api):
    client, adm, _, _, f, tmp = api
    r = upload(client, adm)
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["number"] == "MAN-INV-001" and d["status"] == "draft"
    rev = d["current_revision"]
    assert rev["page_count"] == 3 and rev["text_status"] == "ok" and rev["label"] == "v1.2"
    assert rev["sha256"] == hashlib.sha256(MANUAL).hexdigest() and rev["bytes"] == len(MANUAL)
    stored = list((tmp / "files").rglob("*.pdf"))
    assert len(stored) == 1 and stored[0].read_bytes() == MANUAL
    with f() as db:
        texts = [p.text for p in db.scalars(select(KbDocPage).order_by(KbDocPage.page_no))]
    assert texts[1].startswith("9.3 Fault codes: 203")
    # the next number counts on
    assert upload(client, adm, title_en="Second").json()["number"] == "MAN-INV-002"
    assert client.get("/kb/docs/next-number?type=sop&discipline=OM", headers=adm).json() == {"number": "SOP-OM-001"}


def test_upload_rejects_non_pdf_and_bad_meta(api):
    client, adm, _, _, _, _ = api
    assert upload(client, adm, data=b"hello").status_code == 422
    assert upload(client, adm, title_en="", title_th="").status_code == 422
    r = client.post("/kb/docs", headers=adm, data={"meta": "{nope"}, files={"file": ("x.pdf", MANUAL, "application/pdf")})
    assert r.status_code == 422
    assert upload(client, adm, doc_type="poster").status_code == 422


def test_admin_number_and_conflict(api):
    client, adm, eng, _, _, _ = api
    assert upload(client, adm, number="man-inv-010").json()["number"] == "MAN-INV-010"
    assert upload(client, adm, number="MAN-INV-010").status_code == 409
    # engineers get the automatic number whatever they send
    assert upload(client, eng, number="ZZZ-999").json()["number"] == "MAN-INV-011"


def test_visibility_drafts_and_plant_scope(api):
    client, adm, eng, eng2, _, _ = api
    own = upload(client, eng, title_en="Engineer draft").json()
    assert client.get(f"/kb/docs/{own['id']}", headers=eng).status_code == 200
    assert client.get(f"/kb/docs/{own['id']}", headers=eng2).status_code == 404
    # a plant-only document: visible to engineers assigned to the plant, once released
    scoped = upload(client, adm, title_en="As-built Fah Saeng", doc_type="drawing", discipline="ELE", general=False,
                    links=[{"target_type": "plant", "target_id": "101"}]).json()
    assert client.post(f"/kb/docs/{scoped['id']}/release", headers=adm).status_code == 200
    assert client.get(f"/kb/docs/{scoped['id']}", headers=eng).status_code == 200
    assert client.get(f"/kb/docs/{scoped['id']}", headers=eng2).status_code == 404
    ids = {d["id"] for d in client.get("/kb/docs", headers=eng2).json()["items"]}
    assert scoped["id"] not in ids and own["id"] not in ids
    # an engineer may not make a document only for plants they cannot see
    assert upload(client, eng2, general=False, links=[{"target_type": "plant", "target_id": "101"}]).status_code == 422
    assert upload(client, eng2, general=False).status_code == 422


def test_engineer_never_learns_about_plants_or_documents_outside_their_scope(api):
    """#148: links to unassigned plants, a plant_id filter on one, and a superseding document the
    engineer may not open are all left out; an engineer cannot lock themselves out of a draft."""
    client, adm, eng, _, f, _ = api
    both = upload(client, adm, title_en="Two roofs", general=False,
                  links=[{"target_type": "plant", "target_id": "101"}, {"target_type": "plant", "target_id": "202"},
                         {"target_type": "fault_code", "target_id": "Error:203"}]).json()
    general = upload(client, adm, title_en="General with a plant", links=[{"target_type": "plant", "target_id": "202"}]).json()
    for d in (both, general):
        assert client.post(f"/kb/docs/{d['id']}/release", headers=adm).status_code == 200
    assert {x["target_id"] for x in client.get(f"/kb/docs/{both['id']}", headers=adm).json()["links"]} == {"101", "202", "Error:203"}
    seen = client.get(f"/kb/docs/{both['id']}", headers=eng).json()["links"]
    assert {x["target_id"] for x in seen} == {"101", "Error:203"} and "Other Roof" not in json.dumps(seen)
    assert client.get(f"/kb/docs/{general['id']}", headers=eng).json()["links"] == []

    # filtering on an unassigned plant finds nothing, as for a plant that does not exist
    assert client.get("/kb/docs?plant_id=202", headers=eng).json()["total"] == 0
    assert client.get("/kb/docs?plant_id=999", headers=eng).json()["total"] == 0
    assert client.get("/kb/docs?plant_id=101", headers=eng).json()["total"] == 1
    assert client.get("/kb/docs?plant_id=202", headers=adm).json()["total"] == 2

    # superseded by a draft: the engineer reads the old one without the new one's number or title
    draft = upload(client, adm, title_en="Secret successor").json()
    out = client.post(f"/kb/docs/{general['id']}/supersede", headers=adm, json={"by_doc_id": draft["id"]}).json()
    assert out["superseded_by"]["id"] == draft["id"]
    mine = client.get(f"/kb/docs/{general['id']}", headers=eng).json()
    assert mine["status"] == "superseded" and mine["superseded_by"] is None
    client.post(f"/kb/docs/{draft['id']}/release", headers=adm)
    assert client.get(f"/kb/docs/{general['id']}", headers=eng).json()["superseded_by"]["id"] == draft["id"]

    # an engineer's general draft with no plant of theirs cannot be made plant-only
    own = upload(client, eng, title_en="My draft").json()
    r = client.patch(f"/kb/docs/{own['id']}", headers=eng, json={"general": False})
    assert r.status_code == 422
    assert client.get(f"/kb/docs/{own['id']}", headers=eng).status_code == 200
    assert client.put(f"/kb/docs/{own['id']}/links", headers=eng, json={"links": [{"target_type": "plant", "target_id": "101"}]}).status_code == 200
    assert client.patch(f"/kb/docs/{own['id']}", headers=eng, json={"general": False}).json()["general"] is False

    # an admin's link to a plant the engineer cannot see survives the engineer's link edit
    assert client.put(f"/kb/docs/{own['id']}/links", headers=adm, json={"links": [
        {"target_type": "plant", "target_id": "101"}, {"target_type": "plant", "target_id": "202"}]}).status_code == 200
    assert client.put(f"/kb/docs/{own['id']}/links", headers=eng, json={"links": [
        {"target_type": "plant", "target_id": "101"}, {"target_type": "fault_code", "target_id": "Error:117"}]}).status_code == 200
    assert {x["target_id"] for x in client.get(f"/kb/docs/{own['id']}", headers=adm).json()["links"]} == {"101", "202", "Error:117"}


def test_edit_rights_release_withdraw_supersede(api):
    client, adm, eng, _, _, _ = api
    d = upload(client, eng).json()
    assert client.patch(f"/kb/docs/{d['id']}", headers=eng, json={"title_th": "คู่มือ"}).json()["title_th"] == "คู่มือ"
    assert client.post(f"/kb/docs/{d['id']}/release", headers=eng).status_code == 403
    assert client.post(f"/kb/docs/{d['id']}/release", headers=adm).json()["status"] == "released"
    # released: only admins edit
    assert client.patch(f"/kb/docs/{d['id']}", headers=eng, json={"title_en": "x"}).status_code == 403
    assert client.patch(f"/kb/docs/{d['id']}", headers=eng, json={"number": "X-1"}).status_code == 403
    new = upload(client, adm, title_en="Newer manual").json()
    sup = client.post(f"/kb/docs/{d['id']}/supersede", headers=adm, json={"by_doc_id": new["id"]}).json()
    assert sup["status"] == "superseded" and sup["superseded_by"]["number"] == new["number"]
    assert client.get(f"/kb/docs/{d['id']}", headers=eng).status_code == 200  # still readable
    assert client.post(f"/kb/docs/{d['id']}/withdraw", headers=adm, json={"reason": "Wrong model"}).json()["status"] == "withdrawn"
    assert client.get(f"/kb/docs/{d['id']}", headers=eng).status_code == 404
    # delete: a never-released draft goes; a released one is withdrawn
    assert client.delete(f"/kb/docs/{new['id']}", headers=adm).json() == {"result": "deleted"}
    assert client.get(f"/kb/docs/{new['id']}", headers=adm).status_code == 404


def test_new_revision_keeps_old_one(api):
    client, adm, _, _, f, tmp = api
    d = upload(client, adm).json()
    client.post(f"/kb/docs/{d['id']}/release", headers=adm)
    v2 = make_pdf(["Manual v1.3", "Fault 203 updated"])
    r = client.post(f"/kb/docs/{d['id']}/revisions", headers=adm, data={"label": "v1.3"}, files={"file": ("m.pdf", v2, "application/pdf")})
    assert r.status_code == 422  # a released document needs a change note
    r = client.post(f"/kb/docs/{d['id']}/revisions", headers=adm, data={"label": "v1.3", "change_note": "Vendor update"},
                    files={"file": ("m.pdf", v2, "application/pdf")})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["current_revision"]["rev_no"] == 2 and out["current_revision"]["page_count"] == 2
    assert [x["rev_no"] for x in out["revisions"]] == [2, 1]
    assert len(list((tmp / "files").rglob("*.pdf"))) == 2
    # the old revision's file is still served
    link = client.get(f"/kb/docs/{d['id']}/file?rev=1", headers=adm).json()
    assert client.get(link["url"]).content == MANUAL


def test_signed_file_link(api):
    client, adm, eng, _, _, _ = api
    d = upload(client, adm).json()
    client.post(f"/kb/docs/{d['id']}/release", headers=adm)
    link = client.get(f"/kb/docs/{d['id']}/file", headers=eng).json()
    assert link["api"] is True and link["url"].startswith("/kb/files/")
    r = client.get(link["url"])  # no Authorization header
    assert r.status_code == 200 and r.content == MANUAL
    assert r.headers["content-type"] == "application/pdf" and r.headers["content-disposition"].startswith("inline")
    dl = client.get(f"/kb/docs/{d['id']}/file?download=true", headers=eng).json()
    assert client.get(dl["url"]).headers["content-disposition"].startswith("attachment")
    # tampered or expired links are refused
    qs = parse_qs(urlsplit(link["url"]).query)
    rid = urlsplit(link["url"]).path.rsplit("/", 1)[-1]
    assert client.get(f"/kb/files/{rid}?exp={qs['exp'][0]}&sig={'0' * 40}").status_code == 403
    assert client.get(f"/kb/files/{rid}?exp=1&sig={qs['sig'][0]}").status_code == 403
    assert client.get(f"/kb/files/{rid}?exp={qs['exp'][0]}&sig={qs['sig'][0]}&download=1").status_code == 403


def test_search_pages_snippets_and_fault_codes(api):
    client, adm, eng, _, _, _ = api
    d = upload(client, adm, links=[{"target_type": "fault_code", "target_id": "error:203", "page": 2}]).json()
    client.post(f"/kb/docs/{d['id']}/release", headers=adm)
    other = upload(client, adm, title_en="Module datasheet", doc_type="datasheet", discipline="MOD", data=make_pdf(["JA Solar 545 W"])).json()
    client.post(f"/kb/docs/{other['id']}/release", headers=adm)
    r = client.get("/kb/search", params={"q": "isolation MC4"}, headers=eng).json()
    assert [x["number"] for x in r["documents"]] == ["MAN-INV-001"]
    hit = r["documents"][0]
    assert hit["match"] == "pages" and hit["pages"][0]["page_no"] == 2 and "isolation" in hit["pages"][0]["snippet"]
    # words split over metadata and a page still match
    assert client.get("/kb/search", params={"q": "growatt bus"}, headers=eng).json()["documents"][0]["pages"][0]["page_no"] == 3
    # title hits rank first and need no page
    r = client.get("/kb/search", params={"q": "datasheet"}, headers=eng).json()
    assert r["documents"][0]["number"] == "DS-MOD-001" and r["documents"][0]["match"] == "title"
    # a fault-code query answers the linked page first
    r = client.get("/kb/search", params={"q": "growatt 203"}, headers=eng).json()
    assert r["faults"][0]["key"] == "Error:203" and r["faults"][0]["links"][0]["page"] == 2
    assert client.get("/kb/search", params={"q": "warning 203"}, headers=eng).json()["faults"] == []
    assert client.get("/kb/search", params={"q": "nothing-here"}, headers=eng).json()["total"] == 0


def test_links_validation_and_context(api):
    client, adm, eng, _, _, _ = api
    d = upload(client, adm).json()
    bad = [{"target_type": "fault_code", "target_id": "203"}]
    assert client.put(f"/kb/docs/{d['id']}/links", headers=adm, json={"links": bad}).status_code == 422
    assert client.put(f"/kb/docs/{d['id']}/links", headers=adm, json={"links": [{"target_type": "fault_code", "target_id": "Error:203", "page": 9}]}).status_code == 422
    assert client.put(f"/kb/docs/{d['id']}/links", headers=adm, json={"links": [{"target_type": "plant", "target_id": "999"}]}).status_code == 422
    links = [
        {"target_type": "fault_code", "target_id": "Error:203", "page": 2},
        {"target_type": "equipment", "target_id": "MAX125KTL3-XLV"},
        {"target_type": "equipment", "target_id": "MAX 125KTL3-X LV"},  # same key: one link
        {"target_type": "plant", "target_id": "101"},
    ]
    out = client.put(f"/kb/docs/{d['id']}/links", headers=adm, json={"links": links}).json()
    assert len(out["links"]) == 3
    assert {x["label"] for x in out["links"] if x["target_type"] == "plant"} == {"Fah Saeng"}
    # context lists released documents only
    assert client.get("/kb/docs/context", headers=eng).json()["fault_codes"] == {}
    client.post(f"/kb/docs/{d['id']}/release", headers=adm)
    ctx = client.get("/kb/docs/context", headers=eng).json()
    assert ctx["fault_codes"]["Error:203"][0]["page"] == 2
    assert ctx["equipment"]["MAX125KTL3-XLV"][0]["number"] == "MAN-INV-001"
    assert [x["number"] for x in client.get("/kb/docs?fault=203", headers=eng).json()["items"]] == ["MAN-INV-001"]
    assert client.get("/kb/docs?equipment=MAX 125KTL3-X LV", headers=eng).json()["total"] == 1


def test_plant_documents_tab_and_home(api):
    client, adm, eng, eng2, _, _ = api
    manual = upload(client, adm, links=[{"target_type": "equipment", "target_id": "MAX 125KTL3-X LV", "page": 2}]).json()
    sop = upload(client, adm, title_en="Breaker trip recovery", doc_type="sop", discipline="OM").json()
    drawing = upload(client, adm, title_en="As-built", doc_type="drawing", discipline="ELE", general=False,
                     links=[{"target_type": "plant", "target_id": "101"}]).json()
    for x in (manual, sop, drawing):
        client.post(f"/kb/docs/{x['id']}/release", headers=adm)
    tab = client.get("/kb/plants/101/documents", headers=eng).json()
    assert [x["number"] for x in tab["linked"]] == ["DWG-ELE-001"]
    assert tab["equipment"][0]["model"] == "MAX 125KTL3-X LV" and tab["equipment"][0]["documents"][0]["pages"] == [2]
    assert [x["number"] for x in tab["procedures"]] == ["SOP-OM-001"]
    assert client.get("/kb/plants/101/documents", headers=eng2).status_code == 404
    home = client.get("/kb/docs/home", headers=eng).json()
    assert {x["number"] for x in home["for_plants"]} == {"MAN-INV-001", "DWG-ELE-001"}
    assert client.put(f"/kb/docs/{sop['id']}/pin", headers=eng, json={"pinned": True}).json() == {"pinned": True}
    home = client.get("/kb/docs/home", headers=eng).json()
    assert [x["number"] for x in home["pinned"]] == ["SOP-OM-001"] and home["pinned"][0]["pinned"] is True


def test_scanned_pages_wait_for_ocr(api, monkeypatch):
    client, adm, _, _, f, _ = api
    scan = make_pdf(["Cover page with enough text", ""])
    d = upload(client, adm, data=scan).json()
    assert d["current_revision"]["text_status"] == "ocr_pending" and d["current_revision"]["ocr_pending_pages"] == 1
    # OCR unavailable: pages are marked without text
    monkeypatch.setattr(kb_pdf, "ocr_langs", lambda: None)
    with f() as db:
        status, detail = kb_docs.ocr_pending(db)
        assert detail["revisions"] == 1 and db.scalar(select(KbDocRevision.text_status)) == "partial"
    # installed later: "OCR again" sends them back, and the OCR text is searchable
    assert client.post(f"/kb/docs/{d['id']}/revisions/1/ocr", headers=adm).json()["pages"] == 1
    monkeypatch.setattr(kb_pdf, "ocr_langs", lambda: "eng")
    monkeypatch.setattr(kb_pdf, "ocr_pages", lambda data, pages, langs: {n: "Scanned wiring diagram Q1" for n in pages})
    with f() as db:
        status, detail = kb_docs.ocr_pending(db)
    assert status == "ok" and detail["pages_read"] == 1
    r = client.get("/kb/search", params={"q": "wiring diagram"}, headers=adm).json()
    assert r["documents"][0]["pages"][0]["page_no"] == 2
    assert client.get(f"/kb/docs/{d['id']}", headers=adm).json()["current_revision"]["text_status"] == "ok"


def test_catalog_reports_the_workers_ocr_not_the_apis(api, monkeypatch):
    """The API image has no tesseract: `/kb/docs/catalog` reports the languages of the worker's
    newest finished `kb_ocr` run, never a check of the API's own host."""
    from datetime import datetime, timedelta, timezone

    from app.services import jobs

    client, adm, _, _, f, _ = api
    asked = []
    monkeypatch.setattr(kb_pdf, "ocr_langs", lambda: asked.append(1) or "eng")
    # no run yet: unknown, not "installed"
    assert client.get("/kb/docs/catalog", headers=adm).json()["ocr"] == {"langs": None, "checked_at": None}
    assert asked == []
    t0 = datetime(2026, 11, 27, 3, 0, tzinfo=timezone.utc)
    with f() as db:
        db.add(SyncRun(job="kb_ocr", trigger="schedule", status="ok", started_at=t0, finished_at=t0 + timedelta(seconds=2),
                       detail_json={"revisions": 0, "langs": "tha+eng"}))
        # a newer failed run and a running one carry no answer and are skipped
        db.add(SyncRun(job="kb_ocr", trigger="upload", status="failed", started_at=t0 + timedelta(minutes=5), error="boom"))
        db.add(SyncRun(job="kb_ocr", trigger="schedule", status="running", started_at=t0 + timedelta(minutes=6)))
        db.commit()
    ocr = client.get("/kb/docs/catalog", headers=adm).json()["ocr"]
    assert ocr["langs"] == "tha+eng" and ocr["checked_at"].startswith("2026-11-27T03:00:02")
    # the worker without tesseract: its run records langs None, and the API says so
    with f() as db:
        db.add(SyncRun(job="kb_ocr", trigger="schedule", status="ok", started_at=t0 + timedelta(minutes=30),
                       finished_at=t0 + timedelta(minutes=30), detail_json={"revisions": 0, "langs": None}))
        db.commit()
    assert client.get("/kb/docs/catalog", headers=adm).json()["ocr"]["langs"] is None
    assert asked == []
    # and a real run of the job records what the worker's host has
    with f() as db:
        status, detail = jobs.job_kb_ocr(db)
    assert detail["langs"] == "eng" and asked == [1]


def test_ocr_page_through_tesseract_if_installed():
    if kb_pdf.ocr_langs() is None:
        pytest.skip("tesseract not installed")
    data = make_pdf(["Fault 202 PV isolation low"])
    text = kb_pdf.ocr_pages(data, [1], "eng")[1]
    assert "isolation" in text.lower()


def test_prod_without_bucket_refuses_upload(api, monkeypatch):
    client, adm, _, _, _, _ = api
    kb_storage.reset_store()
    monkeypatch.setattr(kb_storage.settings, "app_env", "prod")
    monkeypatch.setattr(kb_storage.settings, "kb_assets_bucket", "")
    assert upload(client, adm).status_code == 503
