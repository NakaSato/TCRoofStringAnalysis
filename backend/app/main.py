"""FastAPI application entrypoint for the TC Roof Solar PV O&M Engineering Suite."""

from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import APIRouter, Depends, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api.routes import (
    analysis,
    assistant,
    auth,
    calendar_feed,
    claims,
    datasets,
    growatt,
    maintenance,
    plants,
    push,
    pvsyst,
    pwa_meter,
    tfrs16,
    rca,
    report,
    system,
    tools,
    users,
)
from app.api import request_log
from app.auth import get_current_user, require_admin
from app.config import settings
from app.db.seed import ensure_seeded
from app.db.session import SessionLocal, get_db
from app.logging_db import setup_logging, teardown_logging
from app.services import jobs


@asynccontextmanager
async def lifespan(_app: FastAPI):
    with SessionLocal() as db:
        ensure_seeded(db)
    # after the schema exists: records go to app_logs, flushed per request (no thread on Cloud Run)
    setup_logging("api")
    yield
    teardown_logging()


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=(
            "Full-Stack REST API for Solar PV String Performance, IEC 61724 PR & Loss Waterfall, "
            "PM/CM Maintenance, Equipment Failure RCA, "
            "SH&E Compliance, and Management Reporting."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # JSON (fleet lists, the PWA report) shrinks ~5-10x; clients that don't ask get it plain.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    request_log.install(app)

    api_router = APIRouter()
    api_router.include_router(auth.router)  # /auth/login is the only route open without a token
    api_router.include_router(report.router)  # PWA Report sheet: shared key (X-Report-Key), no login
    api_router.include_router(calendar_feed.router)  # ICS feed: the secret in the URL is the key, no login
    # Every data route needs a signed-in user. Growatt routes scope engineers to their assigned
    # plants per route (app.auth.require_plant_*); fleet settings and jobs are admin only.
    api_router.include_router(growatt.router, dependencies=[Depends(get_current_user)])
    # AI Assistant: tools apply the user's plant scope like the Growatt routes; /usage is admin only
    api_router.include_router(assistant.router, dependencies=[Depends(get_current_user)])
    # Alarm push notifications: each user manages only their own devices
    api_router.include_router(push.router, dependencies=[Depends(get_current_user)])
    # Claims: scoped to the user's plants per route; status changes and delete are admin only
    api_router.include_router(claims.router, dependencies=[Depends(get_current_user)])
    # Measuring Tools: everyone views and checks out / in; add, edit, delete, calibrations admin only
    api_router.include_router(tools.router, dependencies=[Depends(get_current_user)])
    # PWA daily meter report: read-only, scoped to the user's plants (import is the CLI)
    api_router.include_router(pwa_meter.router, dependencies=[Depends(get_current_user)])
    # PVsyst design data: read-only, stations scoped like the meter sites (import is the CLI)
    api_router.include_router(pvsyst.router, dependencies=[Depends(get_current_user)])
    # Legacy analysis / O&M modules work on the local `plants` table, which has no link to the
    # Growatt plants an engineer is assigned, so they are admin only.
    admin_only = [Depends(require_admin)]
    for module in (plants, datasets, analysis, maintenance, rca, users, system):
        api_router.include_router(module.router, dependencies=admin_only)
    # TFRS 16 lease model (finance data, read-only; import is the CLI): admin only
    api_router.include_router(tfrs16.router, dependencies=admin_only)

    # Mount at both `/api` and `/` for compatibility
    app.include_router(api_router, prefix="/api")
    app.include_router(api_router)

    @app.get("/health", tags=["Health"])
    @app.get("/api/health", tags=["Health"])
    def health_check():
        return {"status": "ok", "service": settings.app_name, "version": settings.app_version}

    # Open like /health: the uptime check behind the "data sync failing" alert. 503 when the
    # worker has not finished a `history` run lately, or the database can't be reached.
    @app.get("/health/worker", tags=["Health"])
    @app.get("/api/health/worker", tags=["Health"])
    def worker_health_check(db: Session = Depends(get_db)):
        try:
            body = jobs.worker_health(db)
        except Exception:  # noqa: BLE001 - DB down is exactly what this check reports
            return JSONResponse({"ok": False, "last_history_at": None, "error": "database unavailable"}, status_code=503)
        return JSONResponse(body, status_code=200 if body["ok"] else 503)

    return app


app = create_app()
