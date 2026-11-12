"""Comprehensive API tests covering Phases 3, 4, and 5 (Core API, O&M API, Reports, and JWT RBAC Auth)."""

from __future__ import annotations

import pathlib
from fastapi.testclient import TestClient
import pytest

from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from sqlalchemy.orm import sessionmaker

SAMPLE_CSV_PATH = (
    pathlib.Path(__file__).resolve().parent.parent.parent
    / "sample_data"
    / "sample_solar_strings_7days.csv"
)


@pytest.fixture()
def client(tmp_path):
    db_file = tmp_path / "test_api_solar.db"
    test_engine = build_engine(f"sqlite:///{db_file}")
    TestingSessionLocal = sessionmaker(
        bind=test_engine, autoflush=False, autocommit=False, expire_on_commit=False
    )
    Base.metadata.create_all(bind=test_engine)
    with TestingSessionLocal() as session:
        ensure_seeded(session)

    app = create_app()

    def _override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    return TestClient(app)


def _login_headers(client: TestClient, email: str, password: str) -> dict[str, str]:
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_auth_login_and_rbac_guards(client: TestClient):
    # 1. Unauthenticated write should return 401
    unauth = client.post(
        "/api/rca",
        json={
            "plant_id": 1,
            "equipment_category": "Inverter",
            "asset_id": "INV-01",
            "failure_mode": "Trip",
            "why_1": "a",
            "why_2": "b",
            "why_3": "c",
            "why_4": "d",
            "why_5_root_cause": "e",
            "fishbone_category": "Machine / Maintenance PM",
            "capa_corrective_action": "fix",
            "capa_preventive_action": "prevent",
        },
    )
    assert unauth.status_code == 401

    # 2. Viewer role login succeeds on /auth/me but gets 403 on write endpoints
    viewer_headers = _login_headers(client, "viewer@tcroofsolar.com", "viewer123")
    me_resp = client.get("/api/auth/me", headers=viewer_headers)
    assert me_resp.status_code == 200
    assert me_resp.json()["role"] == "viewer"

    forbidden = client.post(
        "/api/rca",
        headers=viewer_headers,
        json={
            "plant_id": 1,
            "equipment_category": "Inverter",
            "asset_id": "INV-01",
            "failure_mode": "Trip",
            "why_1": "a",
            "why_2": "b",
            "why_3": "c",
            "why_4": "d",
            "why_5_root_cause": "e",
            "fishbone_category": "Machine / Maintenance PM",
            "capa_corrective_action": "fix",
            "capa_preventive_action": "prevent",
        },
    )
    assert forbidden.status_code == 403

    # 3. Admin role succeeds on write endpoints
    admin_headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")
    created = client.post(
        "/api/rca",
        headers=admin_headers,
        json={
            "plant_id": 1,
            "equipment_category": "Inverter",
            "asset_id": "INV-01",
            "failure_mode": "Trip",
            "why_1": "a",
            "why_2": "b",
            "why_3": "c",
            "why_4": "d",
            "why_5_root_cause": "e",
            "fishbone_category": "Machine / Maintenance PM",
            "capa_corrective_action": "fix",
            "capa_preventive_action": "prevent",
        },
    )
    assert created.status_code == 201
    assert created.json()["rca_id"].startswith("RCA-2026-")


def test_core_ingestion_analysis_and_charts(client: TestClient):
    admin_headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")

    # List plants & strings
    plants = client.get("/api/plants").json()
    assert len(plants) == 1
    plant_id = plants[0]["id"]
    assert len(plants[0]["string_specs"]) == 8

    # Upload sample CSV
    with SAMPLE_CSV_PATH.open("rb") as f:
        up_resp = client.post(
            f"/api/plants/{plant_id}/datasets/upload",
            headers=admin_headers,
            files={"file": ("sample_solar_strings_7days.csv", f, "text/csv")},
        )
    assert up_resp.status_code == 201, up_resp.text
    ds_data = up_resp.json()
    assert ds_data["string_count"] == 8
    run_id = ds_data["latest_analysis_run_id"]
    assert run_id is not None

    # Fetch Huawei sandbox dataset
    fetch_resp = client.post(
        f"/api/plants/{plant_id}/datasets/fetch",
        headers=admin_headers,
        json={"provider": "huawei", "dev_id": "INV-HUAWEI-01", "simulate_if_unreachable": True},
    )
    assert fetch_resp.status_code == 201

    # Check Generation, Waterfall, Opportunities, Strings, and Anomalies
    gen = client.get(f"/api/analysis/{run_id}/generation").json()
    assert "kpis" in gen and len(gen["daily"]) >= 5 and len(gen["monthly"]) >= 6

    wf = client.get(f"/api/analysis/{run_id}/waterfall").json()
    assert len(wf) == 7

    opp = client.get(f"/api/analysis/{run_id}/opportunities").json()
    assert len(opp) == 4

    strs = client.get(f"/api/analysis/{run_id}/strings").json()
    assert len(strs) == 8

    # Verify all 7 Plotly chart JSON endpoints
    for chart_name in ("daily_pr", "monthly_pr", "waterfall", "yield_pr", "heatmap", "timeseries", "iv_pv"):
        chart_resp = client.get(f"/api/analysis/{run_id}/charts/{chart_name}")
        assert chart_resp.status_code == 200, f"Chart {chart_name} failed: {chart_resp.text}"
        chart_json = chart_resp.json()
        assert "data" in chart_json and "layout" in chart_json


def test_om_crud_pq_she_and_reports_streaming(client: TestClient):
    admin_headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")

    # PM tasks CRUD
    pm_list = client.get("/api/pm-tasks").json()
    assert len(pm_list) >= 5
    first_pm = pm_list[0]
    first_pm["compliance_status"] = "Completed"
    upd_pm = client.put(f"/api/pm-tasks/{first_pm['id']}", headers=admin_headers, json=first_pm)
    assert upd_pm.status_code == 200
    assert upd_pm.json()["compliance_status"] == "Completed"

    # CM work orders
    cm_list = client.get("/api/cm-work-orders").json()
    assert len(cm_list) >= 5

    # Subcontractors & QA/QC
    sub_list = client.get("/api/subcontractor-audits").json()
    assert len(sub_list) == 3
    qaqc = client.get("/api/qaqc-checklist").json()
    assert len(qaqc) == 4

    # PQ Evaluation
    pq_eval = client.post(
        "/api/pq-tests/evaluate",
        json={
            "plant_id": 1,
            "voltage_thd_pct": 2.0,
            "current_thd_pct": 3.1,
            "power_factor": 0.995,
            "voltage_unbalance_pct": 0.7,
            "flicker_plt": 0.35,
            "grid_frequency_hz": 50.01,
            "dc_injection_pct": 0.15,
            "min_riso_mohm": 48.0,
        },
    )
    assert pq_eval.status_code == 200
    assert pq_eval.json()["overall_compliant"] is True

    # SH&E Dashboard & PTW
    she = client.get("/api/she/dashboard").json()
    assert she["kpis"]["lti_count"] == 0
    assert len(she["ptw_permits"]) >= 3

    # Reports Streaming (PDF, XLSX, HTML, CSV)
    latest_run = client.get("/api/plants/1/analysis/latest").json()
    run_id = latest_run["id"]

    pdf_resp = client.get(f"/api/analysis/{run_id}/reports/pdf")
    assert pdf_resp.status_code == 200
    assert pdf_resp.content.startswith(b"%PDF")

    xlsx_resp = client.get(f"/api/analysis/{run_id}/reports/xlsx")
    assert xlsx_resp.status_code == 200
    assert len(xlsx_resp.content) > 2000

    html_resp = client.get(f"/api/analysis/{run_id}/reports/html")
    assert html_resp.status_code == 200
    assert "Root Cause Analysis" in html_resp.text

    csv_resp = client.get(f"/api/analysis/{run_id}/reports/csv")
    assert csv_resp.status_code == 200
    assert "STR-01" in csv_resp.text
