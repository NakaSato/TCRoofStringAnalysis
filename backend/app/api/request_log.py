"""API request middleware for System → Logs.

Sets a request id (context var + `X-Request-ID` header), logs only what matters (5xx and
unhandled exceptions with traceback, slow requests) and, because Cloud Run cuts the CPU after the
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
                log.warning("%s %s slow: %.0f ms (status %d)", request.method, _route(request), ms, response.status_code)
            response.headers["X-Request-ID"] = rid
            return response
        finally:
            logging_db.request_id_var.reset(token)
            h = logging_db.db_handler()
            if h is not None and h.pending():
                await run_in_threadpool(h.flush)
