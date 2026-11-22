"""Python `logging` records from the API and the worker, stored in SQL (`app_logs`).

Admins read them on System → Logs (`/system/logs`), so a failed or partial job can be explained
without the GCP console or SSH.

- `DbLogHandler.emit` formats and **redacts** a record and appends it to an in-memory buffer;
  `flush` bulk-inserts the buffer on the handler's own engine connection (never the request's
  session). A failed insert is printed to stderr and dropped, never logged again (no recursion).
- Worker / CLI: a daemon thread flushes every `LOG_FLUSH_INTERVAL_S`, at once after an ERROR,
  and at exit. API: no thread (Cloud Run cuts CPU after the response); the request middleware
  flushes after each response and the lifespan at shutdown.
- Context (`run_id`, `job`, `request_id`) comes from context vars: `jobs.execute` sets the run,
  the request middleware sets the request id; `_per_phase` threads copy the context.
"""

from __future__ import annotations

import atexit
import contextvars
import logging
import os
import re
import socket
import sys
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional
from urllib.parse import urlsplit

from app.config import settings

run_id_var: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar("log_run_id", default=None)
job_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("log_job", default=None)
request_id_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("log_request_id", default=None)

MESSAGE_MAX = 4_000
EXC_MAX = 16_000
MASK = "***"
CONSOLE_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

# Loggers never stored: SQL echo (and our own insert), and HTTP clients below WARNING, whose
# debug lines carry full URLs (the Google key is a `?key=` parameter).
_SKIP_PREFIXES = ("sqlalchemy", "app.logging_db")
_QUIET_PREFIXES = ("urllib3", "httpx", "httpcore", "requests")

_PATTERNS = [
    (re.compile(r"([?&](?:key|token|access_token|api_key|apikey)=)[^&\s\"']+", re.I), r"\1" + MASK),
    (re.compile(r"(Authorization:\s*Bearer\s+)\S+", re.I), r"\1" + MASK),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._-]{12,}"), r"\1" + MASK),
    (re.compile(r"(token[\"']?\s*[:=]\s*[\"']?)[A-Za-z0-9._-]{12,}", re.I), r"\1" + MASK),
    (re.compile(r"(postgres(?:ql)?(?:\+\w+)?://[^:/@\s]+:)[^@\s]+(@)"), r"\1" + MASK + r"\2"),
    (re.compile(r"(rediss?://[^:/@\s]*:)[^@\s]+(@)"), r"\1" + MASK + r"\2"),
]


def _secret_values() -> List[str]:
    """Exact secret values from settings, longest first (a token containing another is masked whole)."""
    vals = [
        settings.growatt_api_token,
        settings.growatt_token_phase1,
        settings.growatt_token_phase2,
        settings.growatt_token_phase3,
        settings.growatt_token_phase4,
        settings.google_weather_api_key,
        settings.jwt_secret_key,
        settings.admin_password,
        settings.report_api_key,
        settings.ai_api_key,
        settings.longdo_api_key,
        settings.geoapify_api_key,
    ]
    for url in (settings.database_url, settings.redis_url):
        try:
            pw = urlsplit(url).password if url else None
        except ValueError:
            pw = None
        if pw:
            vals.append(pw)
    # very short values would mask ordinary words
    return sorted({v.strip() for v in vals if v and len(v.strip()) >= 6}, key=len, reverse=True)


def redact(text: Optional[str]) -> Optional[str]:
    """`text` with secret values from settings and token-shaped patterns replaced by `***`."""
    if not text:
        return text
    for v in _secret_values():
        text = text.replace(v, MASK)
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text


def _redact_obj(obj: Any) -> Any:
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, dict):
        return {str(k): _redact_obj(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_redact_obj(v) for v in obj]
    if obj is None or isinstance(obj, (int, float, bool)):
        return obj
    return redact(str(obj))


def _trunc(text: Optional[str], n: int) -> Optional[str]:
    return text if text is None or len(text) <= n else text[: n - 20] + " … [truncated]"


class _DbFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        name = record.name
        if name.startswith(_SKIP_PREFIXES):
            return False
        if name.startswith(_QUIET_PREFIXES) and record.levelno < logging.WARNING:
            return False
        return True


class DbLogHandler(logging.Handler):
    """Buffers redacted records and bulk-inserts them into `app_logs` on `flush()`."""

    def __init__(self, source: str, engine=None, level: int = logging.INFO, buffer_max: int = 5000):
        super().__init__(level)
        self.source = source
        self.host = (os.environ.get("K_REVISION") or socket.gethostname())[:64]
        self._engine = engine
        self._buf: Deque[Dict[str, Any]] = deque(maxlen=max(1, buffer_max))
        self._dropped = 0
        self._flush_lock = threading.Lock()
        self.wake = threading.Event()  # set on ERROR+: the flush thread writes at once
        self.addFilter(_DbFilter())
        self.setFormatter(logging.Formatter("%(message)s"))

    @property
    def engine(self):
        if self._engine is None:
            from app.db.session import engine

            self._engine = engine
        return self._engine

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
            exc_text = None
            if record.exc_info:
                exc_text = self.formatter.formatException(record.exc_info) if self.formatter else None
            elif record.exc_text:
                exc_text = record.exc_text
            if record.stack_info:
                exc_text = f"{exc_text or ''}\n{record.stack_info}".strip()
            ctx = getattr(record, "ctx", None)
            row = {
                "ts": datetime.fromtimestamp(record.created, tz=timezone.utc),
                "level": record.levelname[:8],
                "level_no": record.levelno,
                "source": self.source,
                "host": self.host,
                "logger": record.name[:128],
                "message": _trunc(redact(message), MESSAGE_MAX) or "",
                "exc_text": _trunc(redact(exc_text), EXC_MAX),
                "run_id": run_id_var.get(),
                "job": job_var.get(),
                "request_id": request_id_var.get(),
                "extra_json": _redact_obj(ctx) if isinstance(ctx, dict) else None,
            }
            if len(self._buf) == self._buf.maxlen:
                self._dropped += 1
            self._buf.append(row)
            if record.levelno >= logging.ERROR:
                self.wake.set()
        except Exception:  # noqa: BLE001 - logging must never raise into the caller
            self.handleError(record)

    def pending(self) -> int:
        return len(self._buf)

    def flush(self) -> None:
        """Insert everything buffered so far in one transaction; on failure print and drop."""
        if not self._buf and not self._dropped:
            return
        with self._flush_lock:
            rows: List[Dict[str, Any]] = []
            while self._buf:
                rows.append(self._buf.popleft())
            if self._dropped:
                rows.append(
                    {
                        "ts": datetime.now(timezone.utc), "level": "WARNING", "level_no": logging.WARNING,
                        "source": self.source, "host": self.host, "logger": "app.logging_db",
                        "message": f"log buffer full: {self._dropped} older records dropped", "exc_text": None,
                        "run_id": None, "job": None, "request_id": None, "extra_json": None,
                    }
                )
                self._dropped = 0
            if not rows:
                return
            try:
                from sqlalchemy import insert

                from app.db.models import AppLog

                with self.engine.begin() as conn:
                    conn.execute(insert(AppLog), rows)
            except Exception as exc:  # noqa: BLE001 - never re-logged: that would recurse
                print(f"app_logs insert failed, {len(rows)} records dropped: {type(exc).__name__}: {(redact(str(exc)) or "")[:300]}", file=sys.stderr)


_handler: Optional[DbLogHandler] = None
_thread: Optional[threading.Thread] = None


def db_handler() -> Optional[DbLogHandler]:
    """The process's DB handler, or None when DB logging is off / not set up (tests)."""
    return _handler


def flush_logs() -> None:
    if _handler is not None:
        _handler.flush()


def _flush_loop(h: DbLogHandler, interval: float) -> None:
    while True:
        h.wake.wait(interval)
        h.wake.clear()
        h.flush()


def setup_logging(source: str, engine=None, start_thread: Optional[bool] = None) -> Optional[DbLogHandler]:
    """Console logging as before, plus `DbLogHandler` when `LOG_DB_ENABLED`. Idempotent.

    `source`: "api" | "worker" | "cli". The flush thread runs for the worker and CLIs; the API
    flushes per request instead (`start_thread` overrides)."""
    global _handler, _thread
    root = logging.getLogger()
    if not any(getattr(h, "_tcroof_console", False) for h in root.handlers):
        if not root.handlers:  # uvicorn configures its own; don't print every line twice
            console = logging.StreamHandler()
            console.setFormatter(logging.Formatter(CONSOLE_FORMAT))
            console._tcroof_console = True  # type: ignore[attr-defined]
            root.addHandler(console)
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    logging.getLogger("app").setLevel(logging.INFO)

    if not settings.log_db_enabled or _handler is not None:
        return _handler
    level = logging.getLevelNamesMapping().get(settings.log_db_level.upper(), logging.INFO)
    _handler = DbLogHandler(source, engine, level, settings.log_buffer_max)
    root.addHandler(_handler)
    if start_thread if start_thread is not None else source != "api":
        _thread = threading.Thread(
            target=_flush_loop, args=(_handler, float(settings.log_flush_interval_s)), name="app-log-flush", daemon=True
        )
        _thread.start()
    atexit.register(flush_logs)
    return _handler


def teardown_logging() -> None:
    """Flush and detach the DB handler (tests, shutdown)."""
    global _handler
    if _handler is not None:
        _handler.flush()
        logging.getLogger().removeHandler(_handler)
        _handler = None
