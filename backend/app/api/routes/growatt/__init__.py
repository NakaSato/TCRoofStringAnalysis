"""Growatt routes (`/growatt/*`), one module per area.

- `live`          `/growatt/live/*`: realtime values from the Growatt cloud, memory only
- `plants`        `/growatt/plants*`, `/growatt/sensors`, `/growatt/alarms`: persisted data (DB only)
- `fleet_config`  fleet module, string layout, tariff
- `rules`         decision rules, Issues queue, daily rule / KPI rows
- `iv`            I-V curve sweeps
- `events`        site events
- `calendar`      Calendar Team: planned O&M tasks and crews
- `documents`     per-plant document links (as-built PDF, site photos on Drive)
- `visit_route`   site visit route: visit order, drive times, Google Maps links (nothing stored)
- `visit_route_candidates`  site visit route: the plants worth visiting on a day, with their reasons (DB only)
- `route_offices` site visit route: saved offices a route can start from (GET everyone; writes admin)
- `sync`          worker job status and queueing

Live and persisted data never mix: a live route never writes to the database, and a DB route
never calls Growatt.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes.growatt import calendar, documents, events, fleet_config, iv, live, plants, rules, sync, visit_route
from app.api.routes.growatt import route_offices, visit_route_candidates

router = APIRouter(prefix="/growatt", tags=["Growatt OpenAPI & Plant Telemetry"])
# before `visit_route`, so `/routes/candidates` is matched ahead of any `/routes/{id}` there
router.include_router(visit_route_candidates.router)
router.include_router(route_offices.router)
for _module in (live, plants, fleet_config, rules, iv, events, calendar, documents, visit_route, sync):
    router.include_router(_module.router)
