"""Username login (email still accepted) and username backfill for pre-existing users."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import User
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, ensure_schema, get_db
from app.main import create_app


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'auth.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as s:
        ensure_seeded(s)
    return f


@pytest.fixture()
def client(factory):
    app = create_app()

    def _db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    return TestClient(app)


def _login(client, **body):
    return client.post("/api/auth/login", json=body)


def test_login_with_username_case_insensitive(client):
    r = _login(client, username="Admin ", password="admin123")
    assert r.status_code == 200, r.text
    assert r.json()["user"]["username"] == "admin" and r.json()["user"]["role"] == "admin"
    tok = r.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).json()
    assert me["username"] == "admin"


def test_email_still_works_in_either_field(client):
    assert _login(client, email="engineer@tcroofsolar.com", password="engineer123").status_code == 200
    assert _login(client, username="viewer@tcroofsolar.com", password="viewer123").status_code == 200


def test_bad_credentials_and_disabled_users_get_the_same_401(client, factory):
    wrong = _login(client, username="admin", password="nope")
    unknown = _login(client, username="ghost", password="admin123")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["detail"] == unknown.json()["detail"] == "Invalid username or password"

    with factory() as db:
        db.scalar(select(User).where(User.username == "viewer")).is_active = False
        db.commit()
    assert _login(client, username="viewer", password="viewer123").status_code == 401


def test_missing_username_is_rejected(client):
    assert _login(client, password="admin123").status_code == 422
    assert _login(client, username="  ", password="admin123").status_code == 422


def test_existing_users_get_usernames_from_email(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:  # users table from before usernames existed
        conn.execute(text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, "
            "full_name VARCHAR(255) NOT NULL, hashed_password VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, "
            "is_active BOOLEAN NOT NULL, created_at DATETIME NOT NULL)"
        ))
        for i, email in enumerate(["Somchai@a.com", "somchai@b.com", "ops@a.com"], 1):
            conn.execute(text(
                "INSERT INTO users VALUES (:i, :e, 'x', 'h', 'viewer', 1, '2026-01-01')"
            ), {"i": i, "e": email})
    ensure_schema(engine)
    with Session(engine) as db:
        ensure_seeded(db)  # backfills, then seeds the rest of the demo data
    with Session(engine) as db:
        names = {e: u for e, u in db.execute(select(User.email, User.username))}
    assert names == {"Somchai@a.com": "somchai", "somchai@b.com": "somchai2", "ops@a.com": "ops"}
