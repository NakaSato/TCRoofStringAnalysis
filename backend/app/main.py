"""FastAPI application entrypoint for the TC Roof Solar PV O&M Engineering Suite."""

from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    analysis,
    auth,
    datasets,
    growatt,
    maintenance,
    plants,
    rca,
    report,
    she,
    users,
)
from app.auth import get_current_user, require_admin
from app.config import settings
from app.db.seed import ensure_seeded
from app.db.session import SessionLocal


@asynccontextmanager
async def lifespan(_app: FastAPI):
    with SessionLocal() as db:
        ensure_seeded(db)
    yield


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

    api_router = APIRouter()
    api_router.include_router(auth.router)  # /auth/login is the only route open without a token
    api_router.include_router(report.router)  # PWA Report sheet: shared key (X-Report-Key), no login
    # Every data route needs a signed-in user. Growatt routes scope engineers to their assigned
    # plants per route (app.auth.require_plant_*); fleet settings and jobs are admin only.
    api_router.include_router(growatt.router, dependencies=[Depends(get_current_user)])
    # Legacy analysis / O&M modules work on the local `plants` table, which has no link to the
    # Growatt plants an engineer is assigned, so they are admin only.
    admin_only = [Depends(require_admin)]
    for module in (plants, datasets, analysis, maintenance, rca, she, users):
        api_router.include_router(module.router, dependencies=admin_only)

    # Mount at both `/api` and `/` for compatibility
    app.include_router(api_router, prefix="/api")
    app.include_router(api_router)

    @app.get("/health", tags=["Health"])
    @app.get("/api/health", tags=["Health"])
    def health_check():
        return {"status": "ok", "service": settings.app_name, "version": settings.app_version}

    return app


app = create_app()
