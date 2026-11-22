"""Plant document links (docs/plans/plant-asbuilt-links.md): Drive name matching, the API, scoping,
the import keeping admin links, and the overview field."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, PlantDocument, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import drive_match as dm
from app.services import plant_documents

P1, P2, P3 = 9201, 9202, 9203
DRIVE_PDF = "https://drive.google.com/file/d/1-HEN-X3Y1EbDeWdABRjNT3Zdfhqev5nG/view"


# --------------------------------------------------------------------------- name matching


@pytest.mark.parametrize(
    "title, place, branch, rev",
    [
        ("186 As-built สถานีจ่ายน้ำบ้านท่านางหอม กปภ.สาขาสงขลา.pdf", "บ้านท่านางหอม", "สงขลา", None),
        ("156. AS BUILT โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง 30.07.69 REV.3.pdf", "รวมอ่างทอง", "อ่างทอง", 3),
        ("3 โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง 147.06kWp AS Built REV.1.pdf", "รวมอ่างทอง", "อ่างทอง", 1),
        ("232. AS BUILT สถานีผลิตน้ำเกาะเทโพ การประปาส่วนภูมิภาคสาขาอุทัยธานี 05.08.69  REV.4.pdf", "เกาะเทโพ", "อุทัยธานี", 4),
        ("17.โรงกรองน้ำอุโมงค์ การประปาส่วนภูมิภาคสาขาเชียงใหม่ As-Build.pdf", "อุโมงค์", "เชียงใหม่", None),
        ("P2 57 สำนักงานประปาเดิมบางนางบวช กปภ.สาขาเดิมบางนางบวช", "เดิมบางนางบวช", "เดิมบางนางบวช", None),
        ("P1_16 สถานีจ่ายนํ้าโพหัก (W)", "โพหัก", None, None),
        ("สถานีจ่ายน้ำบ้านท่านางหอม 061126 Rev.2 (2) (ขนานไฟ).pdf", "บ้านท่านางหอม", None, 2),
        ("82 สถานีผลิตน้ำบ้านถ่อน R1.pdf", "บ้านถ่อน", None, 1),
        ("สถานีผลิตน้ำอุบลรัตน์ 2 กปภ.สาขาขอนแก่น V2.pdf", "อุบลรัตน์2", "ขอนแก่น", 2),
        ("AS BUILT 10 สถานีผลิตน้ำห้วยซากนอก กปภ.พัทยา 359.10 kWp.pdfpdf", "ห้วยซากนอก", "พัทยา", None),
        ("107 สำนักงานประปาเขต 9 กปภ.เขต 9", "เขต9", "เขต9", None),
        # an office named only by its branch: the branch is the place
        ("118 สำนักงานการประปาส่วนภูมิภาคสาขาลำพูน กปภ.สาขาลำพูน", "ลำพูน", "ลำพูน", None),
    ],
)
def test_parse_strips_numbers_revisions_and_tags(title, place, branch, rev):
    s = dm.parse(title)
    assert s.place == place
    assert s.branch == branch
    assert dm.revision(title) == rev


def test_best_matches_by_name_not_number_and_respects_phase():
    plants = [
        dm.candidates(1, ["สถานีจ่ายน้ำบ้านท่านางหอม กปภ.สาขาสงขลา"], 3),
        dm.candidates(2, ["สถานีจ่ายน้ำหนองบัว กปภ.สาขาสิงห์บุรี"], 3),
        dm.candidates(3, ["P1_17 โรงกรองน้ำอุโมงค์"], 1),
        dm.candidates(4, ["สถานีจ่ายน้ำบ้านท่านางหอม"], 1),  # same name, other phase
    ]
    ranked = dm.best("186 As-built สถานีจ่ายน้ำบ้านท่านางหอม กปภ.สาขาสงขลา.pdf", plants, [3])
    assert ranked[0][0] == 1 and dm.verdict(ranked) == "auto"
    assert 4 not in [pid for pid, _ in ranked]  # phase 1 plant left out for a phase 3 folder
    assert dm.best("17.โรงกรองน้ำอุโมงค์ การประปาส่วนภูมิภาคสาขาเชียงใหม่ As-Build.pdf", plants, [1])[0][0] == 3


def test_numbered_namesakes_and_non_drawings():
    one, two = dm.parse("สถานีผลิตน้ำปลายคลอง 1 กปภ.ตราด"), dm.parse("140 สถานีผลิตน้ำปลายคลอง 2 กปภ.สาขาตราด")
    assert dm.score(one, two) < 0.75  # "1" is not "2"
    assert not dm.is_drawing("186 (S)รายการคำนวนทางไฟฟ้า สถานีจ่ายน้ำสำราญ.pdf")
    assert not dm.is_drawing("route line สถานีผลิตน้ำดอนทราย 14-09-26.pdf")
    assert not dm.is_drawing("รายงาน_สำนักงานประปาประจวบคีรีขันธ์.pdf")
    assert not dm.is_drawing("2  IV TEST Before-After PWA P2_สำนักงานประปาประจวบคีรีขันธ์.pdf")
    assert not dm.is_drawing("1   IEC 62446 Test Report PWA P2_สถานีผลิตน้ำเขาย้อย.pdf")
    assert dm.is_drawing("155. AS BUILT สถานีจ่ายน้ำหนองบัว การประปาส่วนภูมิภาคสาขาสิงห์บุรี 30.07.69 REV.3.pdf")


def test_verdict_needs_a_clear_winner():
    assert dm.verdict([(1, 0.95), (2, 0.9)]) == "review"
    assert dm.verdict([(1, 0.95), (2, 0.5)]) == "auto"
    assert dm.verdict([(1, 1.0), (2, 0.942)]) == "auto"  # an exact name beats a near namesake
    assert dm.verdict([(1, 1.0), (2, 0.97)]) == "review"
    assert dm.verdict([(1, 0.4)]) == "none"
    assert dm.verdict([]) == "none"


def _script():
    path = Path(__file__).resolve().parents[1] / "scripts" / "drive_asbuilt_match.py"
    spec = importlib.util.spec_from_file_location("drive_asbuilt_match", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_script_keeps_newest_revision_and_skips_empty_files():
    m = _script()
    plants = [dm.candidates(1, ["โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง"], 3),
              dm.candidates(2, ["สำนักงานประปาพังโคน กปภ.สาขาพังโคน"], 3)]
    inv = {
        "asbuilt_pdfs": [
            {"id": "rev1", "title": "3 โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง 147.06kWp AS Built REV.1.pdf", "source_folder": "P3", "size": 9},
            {"id": "rev3", "title": "156. AS BUILT โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง 30.07.69 REV.3.pdf", "source_folder": "P3", "size": 7},
            {"id": "empty", "title": "202 สำนักงานประปาพังโคน การประปาส่วนภูมิภาคสาขาพังโคน.pdf", "source_folder": "P3", "size": "0"},
        ],
        "site_folders": [{"id": "site1", "title": "156 โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง"}],
        "picture_folders": [{"id": "pic1", "title": "Picture", "site_folder_id": "site1"}],
    }
    rows = m.match(inv, plants)
    asb = {r["plant_id"]: r for r in rows if r["kind"] == "asbuilt" and r.get("plant_id")}
    assert asb[1]["drive_id"] == "rev3" and asb[1]["revision"] == "REV.3" and asb[1]["status"] == "auto"
    # "AS BUILT / รายการคำนวณ PHASE 3-4" is not a source: its files are not matched at all
    inv["asbuilt_pdfs"].append({"id": "p34", "title": "156. AS BUILT โรงสูบน้ำแรงต่ำรวมสำนักงานประปาอ่างทอง กปภ.สาขาอ่างทอง REV.9.pdf",
                                "source_folder": "P34-other", "size": 7})
    assert not any(r.get("drive_id") == "p34" for r in m.match(inv, plants))
    assert asb[2]["status"] == "none"  # its only file is empty
    assert any(r["status"] == "skipped" and r["drive_id"] == "empty" for r in rows)
    photos = {r["plant_id"]: r for r in rows if r["kind"] == "site_photos" and r.get("plant_id")}
    assert photos[1]["url"].endswith("/folders/pic1")


def test_script_takes_site_subfolder_pdf_from_the_site_folder_match():
    m = _script()
    plants = [dm.candidates(1, ["P1_17 โรงกรองน้ำอุโมงค์"], 1), dm.candidates(2, ["สถานีผลิตน้ำแม่กวง กปภ.สาขาเชียงใหม่"], 1)]
    inv = {
        "asbuilt_pdfs": [{"id": "calc", "title": "รายการคำนวณทางไฟฟ้า โรงกรองน้ำอุโมงค์.pdf", "source_folder": "P1", "size": 5}],
        # the file name alone says little; the site folder it sits in decides
        "asbuilt_subfolder_pdfs": [{"id": "sub", "title": "ASBUILT 17 กปภ.สาขาเชียงใหม่ 28.03.2025.pdf",
                                    "source_folder": "site:17. อุโมงค์", "size": 5}],
        "site_folders": [{"id": "site17", "title": "17. อุโมงค์"}],
        "picture_folders": [],
    }
    rows = m.match(inv, plants)
    asb = {r["plant_id"]: r for r in rows if r["kind"] == "asbuilt" and r.get("plant_id")}
    assert asb[1]["drive_id"] == "sub" and asb[1]["status"] == "auto"
    assert any(r["drive_id"] == "calc" and r["status"] == "skipped" for r in rows if r.get("drive_id"))
    photos = {r["plant_id"]: r for r in rows if r["kind"] == "site_photos" and r.get("plant_id")}
    assert photos[1]["drive_id"] == "site17"  # no Picture subfolder: the site folder


def test_script_prefers_the_site_folder_pdf_over_a_phase_folder_revision():
    m = _script()
    plants = [dm.candidates(1, ["สถานีจ่ายน้ำหนองบัว กปภ.สาขาสิงห์บุรี"], 3)]
    inv = {
        "asbuilt_pdfs": [{"id": "phase", "title": "155. AS BUILT สถานีจ่ายน้ำหนองบัว การประปาส่วนภูมิภาคสาขาสิงห์บุรี 30.07.69 REV.3.pdf",
                          "source_folder": "P3", "size": 5}],
        "asbuilt_subfolder_pdfs": [{"id": "site", "title": "สถานีจ่ายน้ำหนองบัว กปภ.สิงห์บุรี.pdf",
                                    "source_folder": "site:155 สถานีจ่ายน้ำหนองบัว กปภ.สาขาสิงห์บุรี", "size": 5}],
        "site_folders": [{"id": "s155", "title": "155 สถานีจ่ายน้ำหนองบัว กปภ.สาขาสิงห์บุรี"}],
        "picture_folders": [],
    }
    asb = [r for r in m.match(inv, plants) if r["kind"] == "asbuilt" and r.get("plant_id") == 1]
    assert len(asb) == 1 and asb[0]["drive_id"] == "site" and asb[0]["status"] == "auto"
    # with the site's subfolder empty, the phase folder's PDF is used
    inv["asbuilt_subfolder_pdfs"] = []
    asb = [r for r in m.match(inv, plants) if r["kind"] == "asbuilt" and r.get("plant_id") == 1]
    assert asb[0]["drive_id"] == "phase" and asb[0]["revision"] == "REV.3"


# --------------------------------------------------------------------------- API


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'docs.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2, P3):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}", phase=3))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
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

    return f, client, hdr("admin", "admin123"), hdr("engineer", "engineer123")


def test_admin_sets_link_engineer_reads_only_own_plants(api):
    f, c, admin, eng = api
    r = c.put(f"/growatt/plants/{P1}/documents/asbuilt", json={"url": DRIVE_PDF, "title": "As-built"}, headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "manual"
    with f() as db:
        d = db.scalars(select(PlantDocument)).one()
        assert d.drive_id == "1-HEN-X3Y1EbDeWdABRjNT3Zdfhqev5nG"

    assert c.put(f"/growatt/plants/{P1}/documents/asbuilt", json={"url": DRIVE_PDF}, headers=eng).status_code == 403
    assert c.get(f"/growatt/plants/{P1}/documents", headers=eng).json()["documents"]["asbuilt"]["url"] == DRIVE_PDF
    assert c.get(f"/growatt/plants/{P2}/documents", headers=eng).status_code == 404
    listed = c.get("/growatt/documents", headers=eng).json()["plants"]
    assert [p["plant_id"] for p in listed] == [P1]
    assert len(c.get("/growatt/documents", headers=admin).json()["plants"]) == 3


def test_put_refuses_bad_kind_and_non_https(api):
    _, c, admin, _ = api
    assert c.put(f"/growatt/plants/{P1}/documents/invoice", json={"url": DRIVE_PDF}, headers=admin).status_code == 422
    assert c.put(f"/growatt/plants/{P1}/documents/asbuilt", json={"url": "javascript:alert(1)"}, headers=admin).status_code == 422
    assert c.put("/growatt/plants/1/documents/asbuilt", json={"url": DRIVE_PDF}, headers=admin).status_code == 404


def test_import_dry_run_then_apply_keeps_manual(api):
    f, c, admin, eng = api
    c.put(f"/growatt/plants/{P2}/documents/asbuilt", json={"url": DRIVE_PDF}, headers=admin)
    rows = [
        {"plant_id": P1, "kind": "asbuilt", "url": "https://drive.google.com/file/d/aaaaaaaaaaaa/view", "drive_id": "aaaaaaaaaaaa", "revision": "REV.3", "match_score": 0.97},
        {"plant_id": P2, "kind": "asbuilt", "url": "https://drive.google.com/file/d/bbbbbbbbbbbb/view"},
        {"plant_id": 1, "kind": "asbuilt", "url": "https://drive.google.com/file/d/cccccccccccc/view"},
    ]
    assert c.post("/growatt/documents/import", json={"rows": rows}, headers=eng).status_code == 403
    dry = c.post("/growatt/documents/import", json={"rows": rows}, headers=admin).json()
    assert (dry["applied"], dry["created"], dry["kept_manual"], len(dry["errors"])) == (False, 1, 1, 1)
    with f() as db:
        assert db.scalar(select(PlantDocument).where(PlantDocument.plant_id == P1)) is None
    out = c.post("/growatt/documents/import?apply=true", json={"rows": rows}, headers=admin).json()
    assert out["created"] == 1
    with f() as db:
        d1 = db.scalar(select(PlantDocument).where(PlantDocument.plant_id == P1))
        d2 = db.scalar(select(PlantDocument).where(PlantDocument.plant_id == P2))
        assert (d1.source, d1.revision) == ("matched", "REV.3")
        assert (d2.source, d2.url) == ("manual", DRIVE_PDF)  # admin link untouched
    again = c.post("/growatt/documents/import?apply=true", json={"rows": rows[:1]}, headers=admin).json()
    assert again["unchanged"] == 1


def test_delete_and_overview_field(api):
    f, c, admin, _ = api
    c.put(f"/growatt/plants/{P1}/documents/site_photos", json={"url": "https://drive.google.com/drive/folders/pppppppppppp"}, headers=admin)
    ov = c.get(f"/growatt/plants/{P1}/overview", headers=admin).json()
    assert ov["plant"]["documents"]["site_photos"]["url"].endswith("pppppppppppp")
    assert "asbuilt" not in ov["plant"]["documents"]
    assert c.delete(f"/growatt/plants/{P1}/documents/site_photos", headers=admin).status_code == 200
    assert c.delete(f"/growatt/plants/{P1}/documents/site_photos", headers=admin).status_code == 404
    assert c.get(f"/growatt/plants/{P1}/overview", headers=admin).json()["plant"]["documents"] == {}


def test_blocked_plant_cleanup_removes_links(api):
    f, _, _, _ = api
    with f() as db:
        db.add(PlantDocument(plant_id=P3, kind="asbuilt", url=DRIVE_PDF, source="manual"))
        db.commit()
        plant_documents.delete_plant_rows(db, [P3])
        db.commit()
        assert db.scalars(select(PlantDocument)).all() == []
