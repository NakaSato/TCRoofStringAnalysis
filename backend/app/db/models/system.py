"""App bookkeeping: settings, publish log, PWA check slots, API call counts, job runs, logs, AI usage."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import Date, DateTime, Float, Index, Integer, JSON, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class AppSetting(Base):
    """Fleet-wide settings as JSON, one row per key (e.g. `fleet_module`).

    Source of truth for global data the operator enters; mirrored to Firestore `config/{key}`
    by the publish job (and right after an edit).
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=False)
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class PublishedDoc(Base):
    """Last version of each summary document published to a sink (`json` / `firestore`).

    Lets the daily job skip documents whose content has not changed, so re-runs cost no
    Firestore writes. Realtime data is never published — only daily summaries and registry.
    """

    __tablename__ = "published_docs"

    sink: Mapped[str] = mapped_column(String(32), primary_key=True)
    path: Mapped[str] = mapped_column(String(255), primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    written_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class PublishWriteCount(Base):
    """Document writes per sink per quota day (Firestore quotas reset at midnight US/Pacific)."""

    __tablename__ = "publish_write_counts"

    sink: Mapped[str] = mapped_column(String(32), primary_key=True)
    quota_day: Mapped[str] = mapped_column(String(10), primary_key=True)  # YYYY-MM-DD, Pacific
    writes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class PwaCheckSlot(Base):
    """One PWA report check slot of one plant, frozen when it was first fully built.

    Built from stored, source-timestamped history only (services/check_slots.py), never from
    realtime values. Later publishes reuse it, so a slot the sheet has already shown never
    changes, even when late uploads would change a recomputation. Pruned with the raw history.
    """

    __tablename__ = "pwa_check_slots"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    hour: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)  # 9 / 13 / 17
    slot_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    built_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class ExternalApiCallCount(Base):
    """Billable calls to an external API per plant-local day (worker and API share the count)."""

    __tablename__ = "external_api_call_counts"

    api: Mapped[str] = mapped_column(String(32), primary_key=True)  # google_weather_history | google_weather_current
    day: Mapped[str] = mapped_column(String(10), primary_key=True)  # YYYY-MM-DD, plant-local
    calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class SyncRun(Base):
    """One run of a background job (Growatt sync / daily publish), written by the worker or the API.

    Also serves as the job lock: a `running` row younger than the stale timeout blocks a
    second run of the same job.
    """

    __tablename__ = "sync_runs"
    __table_args__ = (Index("ix_sync_runs_job_started", "job", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job: Mapped[str] = mapped_column(String(32), nullable=False)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default="schedule")  # schedule | api | cli
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")  # running | ok | partial | failed
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    detail_json: Mapped[Optional[Any]] = mapped_column(JSON)
    error: Mapped[Optional[str]] = mapped_column(Text)


class AppLog(Base):
    """One Python log record of the API or the worker (System → Logs), redacted before insert.

    Bookkeeping, not measurements: no live values go in messages. `ts` is UTC. `run_id` links a
    job run (`sync_runs.id`) without a foreign key, because runs and logs are pruned separately.
    """

    __tablename__ = "app_logs"
    __table_args__ = (
        Index("ix_app_logs_ts", "ts"),
        Index("ix_app_logs_level_ts", "level_no", "ts"),
        Index("ix_app_logs_run_id", "run_id"),
        Index("ix_app_logs_source_ts", "source", "ts"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    level: Mapped[str] = mapped_column(String(8), nullable=False)
    level_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # api | worker | cli
    host: Mapped[Optional[str]] = mapped_column(String(64))
    logger: Mapped[str] = mapped_column(String(128), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    exc_text: Mapped[Optional[str]] = mapped_column(Text)
    run_id: Mapped[Optional[int]] = mapped_column(Integer)
    job: Mapped[Optional[str]] = mapped_column(String(32))
    request_id: Mapped[Optional[str]] = mapped_column(String(32))
    extra_json: Mapped[Optional[Any]] = mapped_column(JSON)


class AiUsage(Base):
    """Token use and cost of one AI Assistant turn (one user question), for the monthly budget and
    the per-user daily limit.

    Bookkeeping only: no prompt, answer or tool result is stored (the conversation lives in the
    browser), so no measurement ever lands here. `ts` is UTC.
    """

    __tablename__ = "ai_usage"
    __table_args__ = (Index("ix_ai_usage_ts", "ts"), Index("ix_ai_usage_user_ts", "user_id", "ts"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    rounds: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    tools: Mapped[Optional[Any]] = mapped_column(JSON)  # tool names only, in call order
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # ok | refused | error | timeout
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer)
