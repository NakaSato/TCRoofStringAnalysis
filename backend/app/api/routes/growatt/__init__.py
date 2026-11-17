"""Growatt routes (`/growatt/*`), one module per area.

- `live`          `/growatt/live/*`: realtime values from the Growatt cloud, memory only
- `plants`        `/growatt/plants*`, `/growatt/sensors`, `/growatt/alarms`: persisted data (DB only)
- `fleet_config`  fleet module, string layout, tariff
- `rules`         decision rules, Issues queue, daily rule / KPI rows
- `iv`            I-V curve sweeps
- `events`        site events
- `sync`          worker job status and queueing

Live and persisted data never mix: a live route never writes to the database, and a DB route
never calls Growatt.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes.growatt import events, fleet_config, iv, live, plants, rules, sync

router = APIRouter(prefix="/growatt", tags=["Growatt OpenAPI & Plant Telemetry"])
for _module in (live, plants, fleet_config, rules, iv, events, sync):
    router.include_router(_module.router)
