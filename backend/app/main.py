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
    quality,
    rca,
    reports,
    she,
)
from app.auth import get_current_user
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
            "PM/CM Maintenance, Equipment Failure RCA, Subcontractor QA/QC, Commissioning/IEEE 519 Power Quality, "
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
    # Every data route needs a signed-in user (writes additionally check the role per route).
    signed_in = [Depends(get_current_user)]
    for module in (plants, datasets, analysis, maintenance, rca, quality, she, reports, growatt):
        api_router.include_router(module.router, dependencies=signed_in)

    # Mount at both `/api` and `/` for compatibility
    app.include_router(api_router, prefix="/api")
    app.include_router(api_router)

    @app.get("/health", tags=["Health"])
    @app.get("/api/health", tags=["Health"])
    def health_check():
        return {"status": "ok", "service": settings.app_name, "version": settings.app_version}

    return app


app = create_app()
