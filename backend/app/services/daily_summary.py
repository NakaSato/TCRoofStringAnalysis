"""Daily Growatt summaries → JSON files or Firestore.

Only small, slowly-changing documents are published; realtime values and raw 1–5 minute
history are never written (raw history stays in SQL). Layout::

    daily/{YYYY-MM-DD}                     fleet summary: every plant embedded (1 read per day view)
    daily/{YYYY-MM-DD}/plants/{plantId}    plant KPIs, hourly curve, top anomalies
    daily/{YYYY-MM-DD}/inverters/{sn}      inverter KPIs + per-string map
    plants/{plantId}, inverters/{sn}       registry (static fields only; inverters carry the
                                           as-built string layout once one is entered)
    config/fleet_module                    global settings (PV module used across the fleet)

About 43 + 215 + 1 ≈ 260 writes per day. Documents whose content is unchanged since the last
publish are skipped (`published_docs`), so re-running costs nothing. Writes are counted per
Firestore quota day (midnight US/Pacific) and stop at `publish_daily_write_budget`.

Usage (from repo root):
    PYTHONPATH=backend uv run python -m app.services.daily_summary                 # yesterday → JSON
    PYTHONPATH=backend uv run python -m app.services.daily_summary --day 2026-11-11 --sink firestore
    PYTHONPATH=backend uv run python -m app.services.daily_summary --dry-run       # sizes + write count only

Schedule it twice a day, not more: a still-open day changes on every run and would be
rewritten each time (~250 writes per run). Suggested cron (plant-local time):
    19:30  --day <today>     publish the day after sunset
    06:00  (default)         finalize yesterday; only docs changed by late uploads are rewritten
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import pathlib
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Protocol, Sequence, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import DATA_DIR, settings
from app.db.models import GrowattInverter, GrowattPlant, GrowattStringLayout, PublishedDoc, PublishWriteCount
from app.services import google_weather
from app.services.fleet_settings import config_docs
from app.services.growatt_overview import build_plant_overview

log = logging.getLogger("daily_summary")

SCHEMA_VERSION = 1
PLANT_TZ = ZoneInfo("Asia/Bangkok")
QUOTA_TZ = ZoneInfo("America/Los_Angeles")  # Firestore free-tier quotas reset at Pacific midnight
MAX_DOC_BYTES = 1_000_000  # Firestore limit is 1 MiB; JSON size is a close upper-bound proxy
TOP_ANOMALIES = 10

Doc = Tuple[str, Dict[str, Any]]


# --------------------------------------------------------------------------- build


def _round2(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(float(v), 2)


def _hourly_kw(timeseries: List[Dict[str, Any]]) -> List[Optional[float]]:
    """Mean plant AC power per hour (24 values) — a compact day curve for history charts."""
    acc: Dict[int, List[float]] = defaultdict(list)
    for r in timeseries:
        acc[int(r["timestamp"][11:13])].append(r["pac_kw"])
    return [round(sum(acc[h]) / len(acc[h]), 2) if acc.get(h) else None for h in range(24)]


def build_day_docs(db: Session, day: date) -> List[Doc]:
    """All daily documents for one plant-local day. Plants/inverters without data that day are skipped."""
    ds = day.isoformat()
    docs: List[Doc] = []
    fleet: Dict[str, Dict[str, Any]] = {}

    for plant in db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id)):
        ov = build_plant_overview(db, plant.plant_id, day)
        k = ov["kpis"]
        has_data = bool(ov["timeseries"])
        pid = str(plant.plant_id)
        fleet[pid] = {
            "name": plant.name,
            "phase": plant.phase,
            "capacity_kwp": _round2(k["capacity_kwp"]),
            "yield_kwh": k["yield_today_kwh"],
            "specific_yield": k["specific_yield_kwh_per_kwp"],
            "peak_kw": k["peak_power_kw"],
            "pr_index_pct": k["plant_pr_pct"],
            "iec_pr_pct": k["iec_pr_pct"],
            "insolation_kwh_m2": k["insolation_kwh_m2"],
            "critical_strings": k["critical_strings"],
            "warning_strings": k["warning_strings"],
            "has_data": has_data,
        }
        if not has_data:
            continue

        docs.append(
            (
                f"daily/{ds}/plants/{pid}",
                {
                    "schema": SCHEMA_VERSION,
                    "day": ds,
                    "plant_id": plant.plant_id,
                    "phase": plant.phase,
                    "name": plant.name,
                    "capacity_kwp": _round2(k["capacity_kwp"]),
                    "yield_kwh": k["yield_today_kwh"],
                    "specific_yield": k["specific_yield_kwh_per_kwp"],
                    "peak_kw": k["peak_power_kw"],
                    # peer-relative string index (strings compared with each other)
                    "pr_index_pct": k["plant_pr_pct"],
                    # IEC 61724-1 PR from the plant's weather sensor; null without one / poor coverage
                    "iec_pr_pct": k["iec_pr_pct"],
                    "weather": {
                        "insolation_kwh_m2": k["insolation_kwh_m2"],
                        "peak_irradiance_wm2": k["peak_irradiance_wm2"],
                        "avg_module_temp_c": k["avg_module_temp_c"],
                        "avg_ambient_temp_c": k["avg_ambient_temp_c"],
                        "pr_coverage_pct": ov["weather"]["iec_pr"]["coverage_pct"],
                    },
                    # Google Maps Weather for the plant's grid cell: modelled, not measured
                    "google_weather": google_weather.day_summary(db, plant, day),
                    "conversion_efficiency_pct": k["conversion_efficiency_pct"],
                    "avg_temp_c": k["avg_temp_c"],
                    "max_temp_c": k["max_temp_c"],
                    "avg_freq_hz": k["avg_freq_hz"],
                    "inverter_count": k["inverter_count"],
                    "string_count": k["string_count"],
                    "healthy_strings": k["healthy_strings"],
                    "warning_strings": k["warning_strings"],
                    "critical_strings": k["critical_strings"],
                    "avg_health_score": k["avg_health_score"],
                    "hourly_kw": _hourly_kw(ov["timeseries"]),
                    "anomalies": [
                        {key: a[key] for key in ("string_id", "severity", "category", "pr_pct", "energy_loss_kwh")}
                        for a in ov["anomalies"][:TOP_ANOMALIES]
                    ],
                    "data_until": ov["meta"]["data_until"] if ov["meta"]["day"] == ds else None,
                },
            )
        )

        strings_by_sn: Dict[str, Dict[str, Any]] = defaultdict(dict)
        for s in ov["strings"]:
            strings_by_sn[s["device_sn"]][str(s["string_no"])] = {
                "mppt": s["mppt_no"],
                "kwh": s["actual_energy_kwh"],
                "v_avg": s["v_avg"],
                "i_avg": s["i_avg"],
                "i_max": s["i_max"],
                "pr_index_pct": s["pr_pct"],
                "health": s["status"],  # daily diagnostic: Healthy / Warning / Critical
            }
        for inv in ov["inverters"]:
            if inv["peak_ac_kw"] is None:  # no readings that day
                continue
            sn = inv["device_sn"]
            docs.append(
                (
                    f"daily/{ds}/inverters/{sn}",
                    {
                        "schema": SCHEMA_VERSION,
                        "day": ds,
                        "plant_id": plant.plant_id,
                        "device_sn": sn,
                        "yield_kwh": inv["yield_today_kwh"],
                        "integrated_kwh": inv["period_energy_kwh"],
                        "peak_ac_kw": inv["peak_ac_kw"],
                        "peak_dc_kw": inv["peak_dc_kw"],
                        "efficiency_pct": inv["efficiency_pct"],
                        "pr_index_pct": inv["pr_pct"],
                        "avg_temp_c": inv["avg_temp_c"],
                        "max_temp_c": inv["max_temp_c"],
                        "avg_freq_hz": inv["avg_freq_hz"],
                        "string_count": inv["string_count"],
                        "strings": strings_by_sn.get(sn, {}),
                    },
                )
            )

    with_data = [p for p in fleet.values() if p["has_data"]]
    docs.append(
        (
            f"daily/{ds}",
            {
                "schema": SCHEMA_VERSION,
                "day": ds,
                "plant_count": len(fleet),
                "plants_with_data": len(with_data),
                "capacity_kwp": round(sum(p["capacity_kwp"] or 0.0 for p in fleet.values()), 2),
                "yield_kwh": round(sum(p["yield_kwh"] or 0.0 for p in with_data), 2),
                "plants": fleet,
            },
        )
    )
    return docs


def build_inverter_docs(db: Session, plant_id: Optional[int] = None) -> List[Doc]:
    """`inverters/{sn}` registry docs (all, or one plant's).

    `strings` is the as-built layout: [{string_no, modules, module_wp}], `module_wp` null = the
    fleet module (`config/fleet_module`). The key is left out while an inverter has no layout,
    so adding the field rewrote only inverters that have one.
    """
    q = select(GrowattInverter).order_by(GrowattInverter.device_sn)
    if plant_id is not None:
        q = q.where(GrowattInverter.plant_id == plant_id)
    invs = list(db.scalars(q))
    layout: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    if invs:
        for r in db.scalars(
            select(GrowattStringLayout)
            .where(GrowattStringLayout.device_sn.in_([i.device_sn for i in invs]))
            .order_by(GrowattStringLayout.device_sn, GrowattStringLayout.string_no)
        ):
            layout[r.device_sn].append({"string_no": r.string_no, "modules": r.modules, "module_wp": r.module_wp})
    docs: List[Doc] = []
    for inv in invs:
        doc: Dict[str, Any] = {
            "schema": SCHEMA_VERSION,
            "device_sn": inv.device_sn,
            "plant_id": inv.plant_id,
            "model": inv.model,
            "datalogger_sn": inv.datalogger_sn,
            "device_types": inv.device_types.split(",") if inv.device_types else [],
        }
        if layout.get(inv.device_sn):
            doc["strings"] = layout[inv.device_sn]
        docs.append((f"inverters/{inv.device_sn}", doc))
    return docs


def build_registry_docs(db: Session) -> List[Doc]:
    """Static plant / inverter fields only — status and power are realtime and stay out."""
    docs: List[Doc] = build_inverter_docs(db)
    inv_by_plant: Dict[int, List[str]] = defaultdict(list)
    for _path, doc in docs:
        inv_by_plant[doc["plant_id"]].append(doc["device_sn"])
    for p in db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id)):
        docs.append(
            (
                f"plants/{p.plant_id}",
                {
                    "schema": SCHEMA_VERSION,
                    "plant_id": p.plant_id,
                    "phase": p.phase,
                    "name": p.name,
                    "city": p.city,
                    "country": p.country,
                    "latitude": p.latitude,
                    "longitude": p.longitude,
                    "capacity_kwp": _round2(p.peak_power_kwp),
                    "create_date": p.create_date,
                    "inverters": inv_by_plant.get(p.plant_id, []),
                },
            )
        )
    docs.extend((path, {"schema": SCHEMA_VERSION, **doc}) for path, doc in config_docs(db))
    return docs


def publish_plant_inverters(db: Session, plant_id: int, sink: Optional["DocSink"] = None) -> "PublishReport":
    """Publish one plant's `inverters/{sn}` docs (only changed ones are written), e.g. after a layout edit."""
    return publish(db, sink or make_sink(settings.publish_sink), build_inverter_docs(db, plant_id), settings.publish_daily_write_budget)


def publish_config(db: Session, sink: Optional["DocSink"] = None) -> "PublishReport":
    """Publish only the `config/*` documents (1 write when changed), e.g. right after an edit."""
    docs = [(path, {"schema": SCHEMA_VERSION, **doc}) for path, doc in config_docs(db)]
    return publish(db, sink or make_sink(settings.publish_sink), docs, settings.publish_daily_write_budget)


# --------------------------------------------------------------------------- sinks


class DocSink(Protocol):
    name: str

    def write(self, docs: Sequence[Doc]) -> None: ...


class JsonFileSink:
    """Writes each document to `<root>/<path>.json` — for review before Firestore is enabled."""

    name = "json"

    def __init__(self, root: pathlib.Path):
        self.root = root

    def write(self, docs: Sequence[Doc]) -> None:
        for path, doc in docs:
            f = self.root / f"{path}.json"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")


class FirestoreSink:
    """Firestore via the Admin SDK (service account; backend only, never shipped to the browser)."""

    name = "firestore"
    BATCH = 400  # Firestore allows 500 operations per batch

    def __init__(self, credentials_file: str, project_id: str = ""):
        if not credentials_file:
            raise RuntimeError("Set FIREBASE_CREDENTIALS_FILE in .env to publish to Firestore.")
        import firebase_admin
        from firebase_admin import credentials, firestore

        opts = {"projectId": project_id} if project_id else None
        try:
            app = firebase_admin.get_app("daily-summary")
        except ValueError:
            app = firebase_admin.initialize_app(credentials.Certificate(credentials_file), opts, name="daily-summary")
        self.client = firestore.client(app)

    def write(self, docs: Sequence[Doc]) -> None:
        for i in range(0, len(docs), self.BATCH):
            batch = self.client.batch()
            for path, doc in docs[i : i + self.BATCH]:
                batch.set(self.client.document(path), doc)
            batch.commit()


# --------------------------------------------------------------------------- publish


def _canonical(doc: Dict[str, Any]) -> bytes:
    return json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def quota_day(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(QUOTA_TZ).date().isoformat()


@dataclass
class PublishReport:
    sink: str
    considered: int = 0
    unchanged: int = 0
    written: int = 0
    over_budget: List[str] = field(default_factory=list)
    too_large: List[Tuple[str, int]] = field(default_factory=list)
    writes_today: int = 0
    budget: int = 0
    max_doc_bytes: int = 0
    total_bytes: int = 0


def publish(
    db: Session,
    sink: DocSink,
    docs: Sequence[Doc],
    budget: int,
    dry_run: bool = False,
    now: Optional[datetime] = None,
) -> PublishReport:
    """Write only changed documents, within today's write budget. `dry_run` writes nothing anywhere."""
    qday = quota_day(now)
    counter = db.get(PublishWriteCount, (sink.name, qday))
    used = counter.writes if counter else 0
    rep = PublishReport(sink=sink.name, considered=len(docs), budget=budget)

    known = {
        row.path: row.content_hash
        for row in db.scalars(select(PublishedDoc).where(PublishedDoc.sink == sink.name))
    }
    pending: List[Tuple[str, Dict[str, Any], str, int]] = []
    for path, doc in docs:
        body = _canonical(doc)
        size = len(body)
        rep.max_doc_bytes = max(rep.max_doc_bytes, size)
        rep.total_bytes += size
        if size > MAX_DOC_BYTES:
            rep.too_large.append((path, size))
            continue
        digest = hashlib.sha256(body).hexdigest()
        if known.get(path) == digest:
            rep.unchanged += 1
            continue
        if used + len(pending) >= budget:
            rep.over_budget.append(path)
            continue
        pending.append((path, doc, digest, size))

    rep.written = len(pending)
    rep.writes_today = used + len(pending)
    if dry_run or not pending:
        if dry_run:
            rep.writes_today = used
        return rep

    stamp = now or datetime.now(timezone.utc)
    sink.write([(path, {**doc, "published_at": stamp.isoformat()}) for path, doc, _, _ in pending])
    for path, _doc, digest, size in pending:
        db.merge(PublishedDoc(sink=sink.name, path=path, content_hash=digest, size_bytes=size, written_at=stamp))
    if counter is None:
        counter = PublishWriteCount(sink=sink.name, quota_day=qday, writes=0)
        db.add(counter)
    counter.writes = used + len(pending)
    db.commit()
    return rep


def make_sink(kind: str, out_dir: Optional[pathlib.Path] = None) -> DocSink:
    if kind == "firestore":
        return FirestoreSink(settings.firebase_credentials_file, settings.firebase_project_id)
    return JsonFileSink(out_dir or DATA_DIR / "firestore_export")


def run(
    db: Session,
    days: Sequence[date],
    sink: DocSink,
    include_registry: bool = True,
    dry_run: bool = False,
    budget: Optional[int] = None,
) -> PublishReport:
    docs: List[Doc] = build_registry_docs(db) if include_registry else []
    for d in days:
        docs.extend(build_day_docs(db, d))
    return publish(db, sink, docs, budget if budget is not None else settings.publish_daily_write_budget, dry_run)


def main(argv: Optional[Sequence[str]] = None) -> int:
    from app.db.session import Base, SessionLocal

    today = datetime.now(PLANT_TZ).date()
    ap = argparse.ArgumentParser(description="Publish daily Growatt summaries (never realtime data)")
    ap.add_argument("--day", type=date.fromisoformat, action="append", help="Plant-local day (repeatable)")
    ap.add_argument("--sink", choices=["json", "firestore"], default="json")
    ap.add_argument("--out", type=pathlib.Path, help="JSON sink output dir (default data/firestore_export)")
    ap.add_argument("--no-registry", action="store_true", help="Skip plants/, inverters/ and config/ registry docs")
    ap.add_argument("--dry-run", action="store_true", help="Build and size documents, write nothing")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    days = args.day or [today - timedelta(days=1)]
    sink = make_sink(args.sink, args.out)
    with SessionLocal() as db:
        Base.metadata.create_all(bind=db.get_bind())
        rep = run(db, days, sink, include_registry=not args.no_registry, dry_run=args.dry_run)

    log.info(
        "%s%s: %d docs, %d unchanged, %d %s; %d/%d writes used this quota day; largest doc %.1f KB, total %.1f KB",
        rep.sink, " (dry run)" if args.dry_run else "", rep.considered, rep.unchanged, rep.written,
        "would be written" if args.dry_run else "written", rep.writes_today, rep.budget,
        rep.max_doc_bytes / 1024, rep.total_bytes / 1024,
    )
    for path, size in rep.too_large:
        log.error("too large for Firestore (%d bytes): %s", size, path)
    if rep.over_budget:
        log.warning("write budget reached; %d docs deferred to the next quota day", len(rep.over_budget))
    return 1 if rep.too_large or rep.over_budget else 0


if __name__ == "__main__":
    raise SystemExit(main())
