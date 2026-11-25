"""API request middleware for System → Logs.

Sets a request id (context var + `X-Request-ID` header), logs only what matters (5xx and
unhandled exceptions with traceback, slow requests; slow `/growatt/live/*` only as INFO) and, because Cloud Run cuts the CPU after the
response, flushes the DB log buffer before the response is returned. Ordinary 2xx/4xx requests
are not logged."""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool

from app import logging_db
from app.config import settings

log = logging.getLogger("app.api.request")

# Realtime routes wait on Growatt / Google whenever their memory cache has expired, so a few
# seconds there is the upstream's speed, not a fault of ours: logged as INFO, not WARNING.
UPSTREAM_PREFIXES = ("/growatt/live/",)


def _route(request: Request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", None) or request.url.path  # template: no ids in the text


def install(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_log(request: Request, call_next):
        rid = uuid.uuid4().hex[:16]
        token = logging_db.request_id_var.set(rid)
        t0 = time.monotonic()
        try:
            try:
                response = await call_next(request)
            except Exception:
                log.exception("%s %s failed: unhandled exception", request.method, _route(request))
                raise
            ms = (time.monotonic() - t0) * 1000
            if response.status_code >= 500:
                log.warning("%s %s answered %d in %.0f ms", request.method, _route(request), response.status_code, ms)
            elif ms > settings.log_slow_request_ms:
                route = _route(request)
                upstream = route.startswith(UPSTREAM_PREFIXES)
                log.log(
                    logging.INFO if upstream else logging.WARNING,
                    "%s %s slow: %.0f ms (status %d)%s",
                    request.method,
                    route,
                    ms,
                    response.status_code,
                    " · waited on Growatt / Google (live cache refresh)" if upstream else "",
                )
            response.headers["X-Request-ID"] = rid
            return response
        finally:
            logging_db.request_id_var.reset(token)
            h = logging_db.db_handler()
            if h is not None and h.pending() and not h.waiting():
                await run_in_threadpool(h.flush)
