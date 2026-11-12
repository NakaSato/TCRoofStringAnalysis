"""Two roles: admin (everything) and engineer (only the Growatt plants an admin assigned)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services.growatt_live import get_live_service
from tests.test_growatt_routes import PLANT, _seed_growatt
from app.db.models import GrowattPlant

OTHER = 4242


class _FakeLive:
    """Fleet-wide live list with both plants; per-plant calls just echo the id."""

    def _env(self, data: Any) -> Dict[str, Any]:
        return {"source": "live", "fetched_at": datetime.now(timezone.utc).isoformat(), "stale": False,
                "error": None, "refresh_in_s": 60, "data": data}

    def plants(self, coords=None):
        return self._env([{"plant_id": PLANT, "phase": 1}, {"plant_id": OTHER, "phase": 1}])

    def inverters(self, plant_id, phase=None, coords=None):
        return self._env([{"plant_id": plant_id}])


@pytest.fixture()
def client(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'roles.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed_growatt(s)
        s.add(GrowattPlant(plant_id=OTHER, name="Other plant"))
        s.commit()
    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_live_service] = lambda: _FakeLive()
    return TestClient(app)


def _h(c: TestClient, user: str, pw: str | None = None) -> dict:
    r = c.post("/api/auth/login", json={"username": user, "password": pw or f"{user}123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _eng_id(c: TestClient, admin: dict) -> int:
    return next(u["id"] for u in c.get("/api/users", headers=admin).json() if u["username"] == "engineer")


def test_engineer_sees_only_assigned_plants(client):
    admin, eng = _h(client, "admin"), _h(client, "engineer")
    assert client.get("/api/auth/me", headers=admin).json()["plant_ids"] is None  # admin: every plant
    assert {p["plant_id"] for p in client.get("/api/growatt/plants", headers=admin).json()} == {PLANT, OTHER}

    # nothing assigned yet: empty lists, every plant 404
    assert client.get("/api/growatt/plants", headers=eng).json() == []
    assert client.get("/api/growatt/live/plants", headers=eng).json()["data"] == []
    assert client.get(f"/api/growatt/plants/{PLANT}/overview", headers=eng).status_code == 404

    r = client.put(f"/api/users/{_eng_id(client, admin)}/plants", json={"plant_ids": [PLANT]}, headers=admin)
    assert r.status_code == 200 and r.json()["plant_ids"] == [PLANT]

    # same token: the assignment applies at once
    assert client.get("/api/auth/me", headers=eng).json()["plant_ids"] == [PLANT]
    assert [p["plant_id"] for p in client.get("/api/growatt/plants", headers=eng).json()] == [PLANT]
    assert [p["plant_id"] for p in client.get("/api/growatt/live/plants", headers=eng).json()["data"]] == [PLANT]
    assert client.get(f"/api/growatt/plants/{PLANT}/overview", headers=eng).status_code == 200
    assert client.get(f"/api/growatt/live/plants/{PLANT}/inverters", headers=eng).status_code == 200
    for path in (f"/plants/{OTHER}/overview", f"/plants/{OTHER}/inverters", f"/plants/{OTHER}/string-layout",
                 f"/live/plants/{OTHER}/inverters", f"/live/plants/{OTHER}/latest"):
        assert client.get(f"/api/growatt{path}", headers=eng).status_code == 404, path
    assert client.put(f"/api/growatt/plants/{OTHER}/string-layout", json=[], headers=eng).status_code == 404

    # revoking works the same way
    client.put(f"/api/users/{_eng_id(client, admin)}/plants", json={"plant_ids": []}, headers=admin)
    assert client.get(f"/api/growatt/plants/{PLANT}/overview", headers=eng).status_code == 404


def test_engineer_cannot_reach_admin_areas(client):
    eng = _h(client, "engineer")
    assert client.get("/api/users", headers=eng).status_code == 403
    assert client.post("/api/growatt/sync/history", headers=eng).status_code == 403
    assert client.get("/api/growatt/sync/status", headers=eng).status_code == 403
    assert client.put("/api/growatt/fleet-module", json={}, headers=eng).status_code in (403, 422)
    for path in ("/plants", "/pm-tasks", "/cm-work-orders", "/rca", "/ptw"):
        assert client.get(f"/api{path}", headers=eng).status_code == 403, path


def test_admin_manages_users(client):
    admin = _h(client, "admin")
    r = client.post("/api/users", headers=admin, json={
        "username": "Somchai", "full_name": "Somchai K.", "password": "secret-pass", "plant_ids": [PLANT, OTHER],
    })
    assert r.status_code == 201, r.text
    new = r.json()
    assert new["username"] == "somchai" and new["role"] == "engineer" and new["plant_ids"] == sorted([PLANT, OTHER])
    assert client.post("/api/users", headers=admin, json={
        "username": "somchai", "full_name": "x", "password": "secret-pass"}).status_code == 422  # duplicate
    assert client.post("/api/users", headers=admin, json={
        "username": "x1", "full_name": "x", "password": "secret-pass", "role": "viewer"}).status_code == 422  # 2 roles only
    assert client.put(f"/api/users/{new['id']}/plants", json={"plant_ids": [999999]}, headers=admin).status_code == 422

    eng = _h(client, "somchai", "secret-pass")
    assert len(client.get("/api/growatt/plants", headers=eng).json()) == 2

    # promote: assignments dropped (admins see everything); demote back to engineer: none assigned
    assert client.patch(f"/api/users/{new['id']}", json={"role": "admin"}, headers=admin).json()["plant_ids"] is None
    assert client.patch(f"/api/users/{new['id']}", json={"role": "engineer"}, headers=admin).json()["plant_ids"] == []

    # disable: the token stops working
    assert client.patch(f"/api/users/{new['id']}", json={"is_active": False}, headers=admin).status_code == 200
    assert client.get("/api/auth/me", headers=eng).status_code == 401


def test_last_admin_is_protected(client):
    admin = _h(client, "admin")
    me = client.get("/api/auth/me", headers=admin).json()
    assert client.patch(f"/api/users/{me['id']}", json={"role": "engineer"}, headers=admin).status_code == 422
    assert client.patch(f"/api/users/{me['id']}", json={"is_active": False}, headers=admin).status_code == 422
    assert client.put(f"/api/users/{me['id']}/plants", json={"plant_ids": [PLANT]}, headers=admin).status_code == 422
