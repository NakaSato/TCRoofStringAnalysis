"""APP_ENV=prod: one configured admin, no demo users or demo data, unsafe config refused."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.auth import verify_password
from app.config import Settings
from app.db.models import AnalysisRun, PMTask, Plant, User
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine

STRONG = "correct-horse-battery-1"
JWT = "x" * 48


def _factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'prod.db'}")
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _prod(**kw):
    return Settings(_env_file=None, app_env="prod", admin_password=STRONG, jwt_secret_key=JWT, **kw)


@pytest.mark.parametrize(
    "cfg, msg",
    [
        (Settings(_env_file=None, app_env="prod", jwt_secret_key=JWT), "ADMIN_PASSWORD is not set"),
        (Settings(_env_file=None, app_env="prod", admin_password="admin123", jwt_secret_key=JWT), "at least 12"),
        (Settings(_env_file=None, app_env="prod", admin_password=STRONG), "JWT_SECRET_KEY"),
    ],
)
def test_prod_refuses_unsafe_config(tmp_path, cfg, msg):
    with _factory(tmp_path)() as db, pytest.raises(RuntimeError, match=msg):
        ensure_seeded(db, cfg)


def test_prod_seeds_only_the_admin_and_no_demo_data(tmp_path):
    f = _factory(tmp_path)
    with f() as db:
        ensure_seeded(db, _prod())
    with f() as db:
        users = list(db.scalars(select(User)))
        assert [(u.username, u.role) for u in users] == [("admin", "admin")]
        assert verify_password(STRONG, users[0].hashed_password)
        assert db.scalar(select(func.count()).select_from(Plant)) == 1  # plant config only
        assert db.scalar(select(func.count()).select_from(AnalysisRun)) == 0
        assert db.scalar(select(func.count()).select_from(PMTask)) == 0


def test_prod_disables_demo_accounts_and_resets_admin_password(tmp_path):
    f = _factory(tmp_path)
    with f() as db:
        ensure_seeded(db, Settings(_env_file=None, seed_demo_data=False))  # dev start: demo users
    with f() as db:
        ensure_seeded(db, _prod())
    with f() as db:
        state = {u.username: u.is_active for u in db.scalars(select(User))}
        admin = db.scalar(select(User).where(User.username == "admin"))
    assert state == {"admin": True, "engineer": False, "viewer": False}
    assert verify_password(STRONG, admin.hashed_password) and not verify_password("admin123", admin.hashed_password)


def test_dev_still_seeds_demo_users_and_data(tmp_path):
    f = _factory(tmp_path)
    with f() as db:
        ensure_seeded(db, Settings(_env_file=None))
    with f() as db:
        assert {u.username for u in db.scalars(select(User))} == {"admin", "engineer", "viewer"}
        assert db.scalar(select(func.count()).select_from(AnalysisRun)) == 1
