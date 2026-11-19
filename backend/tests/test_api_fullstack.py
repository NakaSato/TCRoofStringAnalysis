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


def _endpoints_unreachable(monkeypatch):
    """Every provider call fails as if the host were down (tests never touch the network)."""
    import requests

    def _refuse(*_a, **_k):
        raise requests.ConnectionError("connection refused (test)")

    monkeypatch.setattr(requests, "post", _refuse)
    monkeypatch.setattr(requests, "request", _refuse)


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


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

    # 2. Engineer login succeeds on /auth/me but the legacy O&M modules are admin only
    eng_headers = _login_headers(client, "engineer@tcroofsolar.com", "engineer123")
    me_resp = client.get("/api/auth/me", headers=eng_headers)
    assert me_resp.status_code == 200
    assert me_resp.json()["role"] == "engineer" and me_resp.json()["plant_ids"] == []
    assert client.get("/api/rca", headers=eng_headers).status_code == 403

    forbidden = client.post(
        "/api/rca",
        headers=eng_headers,
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


def test_core_ingestion_analysis_and_charts(client: TestClient, monkeypatch):
    _endpoints_unreachable(monkeypatch)
    admin_headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")
    client.headers.update(admin_headers)  # every data route needs a signed-in user

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
    assert fetch_resp.json()["source_type"] == "simulated"

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


def test_om_crud_and_she(client: TestClient):
    admin_headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")
    client.headers.update(admin_headers)  # every data route needs a signed-in user

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


def test_data_routes_require_login(client: TestClient):
    for path in ("/api/plants", "/api/pm-tasks", "/api/plants/1/analysis/latest",
                 "/api/growatt/plants", "/plants"):
        assert client.get(path).status_code == 401, path
    assert client.get("/api/health").status_code == 200


FETCH_BODIES = {
    "huawei": {"provider": "huawei", "dev_id": "INV-H1"},
    "sungrow": {"provider": "sungrow", "ps_key": "PS-1"},
    "generic_rest": {"provider": "generic_rest", "base_url": "http://unreachable.test/data"},
}


@pytest.mark.parametrize("provider", sorted(FETCH_BODIES))
def test_fetch_unreachable_falls_back_only_when_asked(client: TestClient, monkeypatch, provider):
    _endpoints_unreachable(monkeypatch)
    headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")
    plant_id = client.get("/api/plants", headers=headers).json()[0]["id"]
    url = f"/api/plants/{plant_id}/datasets/fetch"
    body = FETCH_BODIES[provider]

    # default (flag omitted) = off: an unreachable endpoint is an error, not fake data
    off = client.post(url, headers=headers, json=body)
    assert off.status_code == 400, off.text
    assert "API fetch failed" in off.json()["detail"]

    on = client.post(url, headers=headers, json={**body, "simulate_if_unreachable": True})
    assert on.status_code == 201, on.text
    ds = on.json()
    assert ds["source_type"] == "simulated"
    assert ds["source_label"].startswith("Sandbox simulator (") and "unreachable" in ds["source_label"]
    assert ds["row_count"] > 0 and ds["latest_analysis_run_id"] is not None


def test_fetch_unparseable_response_is_400_even_with_fallback(client: TestClient, monkeypatch):
    """A reachable endpoint with a misconfigured records_key must not be masked by simulated data."""
    import requests

    monkeypatch.setattr(requests, "request", lambda *a, **k: _FakeResponse({"foo": [{"x": 1}]}))
    headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")
    plant_id = client.get("/api/plants", headers=headers).json()[0]["id"]
    resp = client.post(
        f"/api/plants/{plant_id}/datasets/fetch",
        headers=headers,
        json={"provider": "generic_rest", "base_url": "http://ok.test/data", "records_key": None,
              "simulate_if_unreachable": True},
    )
    assert resp.status_code == 400, resp.text
    assert "records_key" in resp.json()["detail"]


def test_fetch_generic_rest_success_keeps_provider_source(client: TestClient, monkeypatch):
    import requests

    records = [
        {"timestamp": f"2026-11-10T{h:02d}:00:00", "inverter_id": "INV-01", "string_id": f"INV-01-STR-{n:02d}",
         "voltage_v": 600.0, "current_a": 8.0 + n * 0.1, "irradiance_wm2": 800.0, "module_temp_c": 45.0}
        for h in range(8, 17) for n in (1, 2)
    ]
    monkeypatch.setattr(requests, "request", lambda *a, **k: _FakeResponse({"data": records}))
    headers = _login_headers(client, "admin@tcroofsolar.com", "admin123")
    plant_id = client.get("/api/plants", headers=headers).json()[0]["id"]
    resp = client.post(
        f"/api/plants/{plant_id}/datasets/fetch",
        headers=headers,
        json={"provider": "generic_rest", "base_url": "http://ok.test/data", "simulate_if_unreachable": True},
    )
    assert resp.status_code == 201, resp.text
    ds = resp.json()
    assert ds["source_type"] == "generic_rest"
    assert ds["source_label"] == "Generic REST API (http://ok.test/data)"
    assert ds["row_count"] == len(records)
