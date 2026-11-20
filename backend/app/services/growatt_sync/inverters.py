"""Inverter and string history: `max_data` records, today's batch / fallback reads, the newest
record between runs, and the whole records kept as reported."""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import GrowattInverter, GrowattInverterRaw, GrowattInverterReading, GrowattStringReading
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_max_raw, parse_max_records
from app.services.growatt_sync.common import RATE_LIMIT_CODE, _date_chunks, _inverters_query, _retry, _upsert, log

def sync_inverter_history(
    db: Session,
    client: GrowattClient,
    inverter: GrowattInverter,
    start: date,
    end: date,
    retries: int = 3,
    stop_before: Optional[datetime] = None,
) -> tuple[int, int]:
    """Fetch and upsert MAX history for one inverter. Returns (inverter_rows, string_rows).

    With `stop_before` (incremental runs) only records from that time on are written: the last
    page Growatt answers holds up to 100 records, most of them stored by earlier runs, and
    rewriting them made `history` write ~30x more rows than it added (Nov 2026)."""
    n_inv = n_str = 0
    for a, b in _date_chunks(start, end):
        records: List[Dict[str, Any]] = _retry(
            lambda: client.max_history(inverter.device_sn, a, b, stop_before=stop_before),
            f"{inverter.device_sn} {a}..{b}",
            retries,
        )
        inv_rows, str_rows = parse_max_records(inverter.device_sn, records)
        if stop_before is not None:
            inv_rows = [r for r in inv_rows if r["timestamp"] >= stop_before]
            str_rows = [r for r in str_rows if r["timestamp"] >= stop_before]
        _upsert(db, GrowattInverterReading, inv_rows)
        _upsert(db, GrowattStringReading, str_rows)
        _store_raw(db, inverter.device_sn, records, stop_before)
        n_inv += len(inv_rows)
        n_str += len(str_rows)
    latest = db.scalar(
        # primary-key order, so Postgres does not walk ix_growatt_inv_ts for an idle inverter
        select(GrowattInverterReading.timestamp)
        .where(GrowattInverterReading.device_sn == inverter.device_sn)
        .order_by(GrowattInverterReading.device_sn.desc(), GrowattInverterReading.timestamp.desc())
        .limit(1)
    )
    inverter.history_synced_until = latest
    db.commit()
    return n_inv, n_str


def sync_all_history(
    db: Session,
    client: GrowattClient,
    start: date,
    end: date,
    device_sns: Optional[Sequence[str]] = None,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
) -> Dict[str, Any]:
    q = _inverters_query(phase, include_untagged)
    if device_sns:
        q = q.where(GrowattInverter.device_sn.in_(device_sns))
    inverters = list(db.scalars(q))
    totals = {"inverters": len(inverters), "inverter_rows": 0, "string_rows": 0, "failed": []}
    for idx, inv in enumerate(inverters, 1):
        try:
            n_inv, n_str = sync_inverter_history(db, client, inv, start, end)
            totals["inverter_rows"] += n_inv
            totals["string_rows"] += n_str
            # DEBUG: 629 lines per run would be ~30 k rows/day in app_logs; the phase summary stays INFO
            log.debug("[%d/%d] %s (plant %s): %d records, %d string rows", idx, len(inverters), inv.device_sn, inv.plant_id, n_inv, n_str)
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            totals["failed"].append((inv.device_sn, str(exc)))
            log.error("[%d/%d] %s failed: %s", idx, len(inverters), inv.device_sn, exc)
        time.sleep(pause_s)
    return totals


def sync_incremental(
    db: Session,
    client: GrowattClient,
    today: date,
    overlap: timedelta = timedelta(minutes=30),
    max_back_days: int = 7,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    batch_size: int = 0,
) -> Dict[str, Any]:
    """Fetch only what is new for each inverter since its `history_synced_until`.

    The overlap re-reads the last half hour (Growatt uploads arrive late); upserts make the
    overlap free. Inverters never synced start yesterday; long-offline ones look back at
    most `max_back_days` (older gaps are for the `--start/--end` backfill).

    `batch_size` > 0: inverters already holding a record of today are first read `batch_size`
    per call (`_sync_today_batched`); the others, and any the batch did not cover, get their own
    `max_data` call as before (`batch_calls` / `batch_inverters` / `batch_fallback` /
    `batch_errors` in the totals). An inverter whose `max_data` call fails is tried once more
    through `new-api/queryHistoricalData` (`_sync_today_single`, `day_fallback` in the totals)
    before it counts as failed.
    """
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())
    inverters = list(db.scalars(_inverters_query(phase, include_untagged)))
    totals: Dict[str, Any] = {"inverters": len(inverters), "inverter_rows": 0, "string_rows": 0, "failed": [], "day_fallback": 0}
    if batch_size > 0:
        done = _sync_today_batched(db, client, inverters, today, overlap, batch_size, pause_s, totals)
        inverters = [inv for inv in inverters if inv.device_sn not in done]
    for inv in inverters:
        since = (inv.history_synced_until - overlap) if inv.history_synced_until else datetime.combine(
            today - timedelta(days=1), datetime.min.time()
        )
        since = max(since, floor)
        try:
            n_inv, n_str = sync_inverter_history(db, client, inv, since.date(), today, stop_before=since)
            totals["inverter_rows"] += n_inv
            totals["string_rows"] += n_str
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            rows = _sync_today_single(db, client, inv, today, overlap)
            if rows is None:
                totals["failed"].append((inv.device_sn, str(exc)))
                log.error("%s incremental sync failed: %s", inv.device_sn, exc)
            else:
                totals["inverter_rows"] += rows[0]
                totals["string_rows"] += rows[1]
                totals["day_fallback"] += 1
                log.warning("%s max_data failed (%s): today read through queryHistoricalData", inv.device_sn, exc)
        time.sleep(pause_s)
    return totals


BATCH_MAX_ERRORS = 2  # refused batch calls in a row: stop batching for this run


def _store_today(
    db: Session, inv: GrowattInverter, records: Sequence[Dict[str, Any]], today: date, overlap: timedelta
) -> Optional[Tuple[int, int]]:
    """Store today's `records` of `inv` (max_data record fields) from an endpoint whose answer
    may be cut short: (inverter rows, string rows) written, or None when the answer is not
    proven complete, in which case nothing is written.

    Proof = the inverter's newest stored record is from today and the answer reaches back to it
    (that record is still on Growatt, so a complete answer includes it). Only rows inside the
    overlap window are written, like the `max_data` path."""
    stored = inv.history_synced_until
    if stored is None or stored < datetime.combine(today, datetime.min.time()):
        return None
    inv_rows, str_rows = parse_max_records(inv.device_sn, list(records))
    times = [r["timestamp"] for r in inv_rows]
    if not times or min(times) > stored:
        return None
    since = stored - overlap
    inv_rows = [r for r in inv_rows if r["timestamp"] >= since]
    str_rows = [r for r in str_rows if r["timestamp"] >= since]
    _upsert(db, GrowattInverterReading, inv_rows)
    _upsert(db, GrowattStringReading, str_rows)
    _store_raw(db, inv.device_sn, records, since)
    inv.history_synced_until = max(stored, max(times))
    db.commit()
    return len(inv_rows), len(str_rows)


LATEST_CHUNK = GrowattClient.MAXS_PAGE  # serials per `maxs_data` call (one page)


def sync_latest_records(
    db: Session,
    client: GrowattClient,
    today: date,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    first_chunk: int = 0,
    pause_s: float = 0.3,
) -> Dict[str, Any]:
    """Store each inverter's newest record of today from `maxs_data` (LATEST_CHUNK serials per
    call), between `history` runs.

    The record is a `max_data` record with Growatt's own `time`, so it goes into the same tables
    under the same key and `history` later rewrites it with the same values: source-timestamped
    history, not a poll-time value. `history_synced_until` is left alone, so `history` still
    reads everything since its own last run and a record this job missed is never skipped. A
    record of another day is not written (a silent inverter answers its last one, possibly
    months old).

    `maxs_data` answers about 4 calls per account, then 10012 for about 5 min: the first 10012
    ends the account's sweep and the chunks not read are listed in `failed` (run `partial`).
    `first_chunk` rotates the starting chunk, so a cut-short sweep does not always miss the same
    inverters."""
    sns = sorted({inv.device_sn for inv in db.scalars(_inverters_query(phase, include_untagged))})
    chunks = [sns[i : i + LATEST_CHUNK] for i in range(0, len(sns), LATEST_CHUNK)]
    totals: Dict[str, Any] = {
        "inverters": len(sns),
        "chunks": len(chunks),
        "chunks_read": 0,
        "answered": 0,
        "not_today": 0,
        "inverter_rows": 0,
        "string_rows": 0,
        "failed": [],
    }
    order = [(first_chunk + n) % len(chunks) for n in range(len(chunks))] if chunks else []
    label = lambda k: f"chunk {k + 1}/{len(chunks)}"  # noqa: E731
    day = today.isoformat()
    for n, k in enumerate(order):
        if n:
            time.sleep(pause_s)
        try:
            records = client.maxs_latest(chunks[k])
            inv_rows: List[Dict[str, Any]] = []
            str_rows: List[Dict[str, Any]] = []
            members = set(chunks[k])
            for sn, rec in records.items():
                if sn not in members:
                    continue
                totals["answered"] += 1
                if str(rec.get("time") or "")[:10] != day:
                    totals["not_today"] += 1
                    continue
                # `dataloggerSn` is added by the client; it is not a field of the record
                rec = {f: v for f, v in rec.items() if f != "dataloggerSn"}
                a, b = parse_max_records(sn, [rec])
                inv_rows += a
                str_rows += b
                _store_raw(db, sn, [rec])
            _upsert(db, GrowattInverterReading, inv_rows)
            _upsert(db, GrowattStringReading, str_rows)
            db.commit()
        except Exception as exc:  # keep going with the next chunk; report at the end
            db.rollback()
            if isinstance(exc, GrowattAPIError) and exc.error_code == RATE_LIMIT_CODE:
                totals["failed"] += [(label(j), str(exc)) for j in order[n:]]
                log.warning("maxs_data rate limited at %s: %d chunk(s) left for the next run", label(k), len(order) - n)
                break
            totals["failed"].append((label(k), str(exc)))
            log.error("maxs_data %s failed: %s", label(k), exc)
            continue
        totals["chunks_read"] += 1
        totals["inverter_rows"] += len(inv_rows)
        totals["string_rows"] += len(str_rows)
    return totals


def _sync_today_single(
    db: Session, client: GrowattClient, inv: GrowattInverter, today: date, overlap: timedelta
) -> Optional[Tuple[int, int]]:
    """Today's records of one inverter through `new-api/queryHistoricalData`, for an inverter
    `max_data` just refused. None = not used (refused too, more pages follow, or not proven
    complete): the inverter then counts as failed for this run, as before."""
    try:
        records = client.max_history_day(inv.device_sn, today)
        return None if records is None else _store_today(db, inv, records, today, overlap)
    except Exception as exc:
        db.rollback()
        log.debug("%s queryHistoricalData fallback failed: %s", inv.device_sn, exc)
        return None


def _sync_today_batched(
    db: Session,
    client: GrowattClient,
    inverters: Sequence[GrowattInverter],
    today: date,
    overlap: timedelta,
    batch_size: int,
    pause_s: float,
    totals: Dict[str, Any],
) -> set:
    """Today's new records of several inverters per call (`new-api/queryDevicesHistoricalData`).
    Returns the serials fully synced here; the caller reads the rest with `max_data`.

    Only inverters whose newest stored record is from today take part, and an answer is stored
    only when proven complete (`_store_today`). BATCH_MAX_ERRORS refused calls in a row end
    batching for this run."""
    day_start = datetime.combine(today, datetime.min.time())
    eligible = [inv for inv in inverters if inv.history_synced_until and inv.history_synced_until >= day_start]
    totals.update({"batch_calls": 0, "batch_inverters": 0, "batch_fallback": 0, "batch_errors": 0})

    def count(key: str, n: int = 1) -> None:
        totals[key] += n

    done: set = set()
    in_a_row = 0
    for i in range(0, len(eligible), batch_size):
        chunk = eligible[i : i + batch_size]
        if i:
            time.sleep(pause_s)
        count("batch_calls")
        try:
            by_sn = client.max_history_batch([inv.device_sn for inv in chunk], today)
        except GrowattAPIError as exc:
            count("batch_errors")
            in_a_row += 1
            log.warning("batch history failed for %d inverters: %s", len(chunk), exc)
            if in_a_row >= BATCH_MAX_ERRORS:
                log.warning("batch history refused %d times in a row: the rest of this run uses max_data", in_a_row)
                count("batch_fallback", len(eligible) - i)
                return done
            count("batch_fallback", len(chunk))
            continue
        in_a_row = 0
        for inv in chunk:
            try:
                rows = _store_today(db, inv, by_sn.get(inv.device_sn) or [], today, overlap)
            except Exception as exc:  # this inverter goes through max_data instead
                db.rollback()
                log.warning("%s batch history rows failed: %s", inv.device_sn, exc)
                rows = None
            if rows is None:  # not answered, or cut short
                count("batch_fallback")
                continue
            totals["inverter_rows"] += rows[0]
            totals["string_rows"] += rows[1]
            count("batch_inverters")
            done.add(inv.device_sn)
    return done


_RAW_BATCH = 200  # raw rows per statement (about 4 kB each)


def _store_raw(db: Session, device_sn: str, records: Sequence[Dict[str, Any]], since: Optional[datetime] = None) -> int:
    """Keep the whole `max_data` records (`growatt_inverter_raw`) when `HISTORY_STORE_RAW` is on;
    the caller commits. `since`: only records from that time on."""
    if not settings.history_store_raw:
        return 0
    rows = parse_max_raw(device_sn, list(records))
    if since is not None:
        rows = [r for r in rows if r["timestamp"] >= since]
    for i in range(0, len(rows), _RAW_BATCH):
        _upsert(db, GrowattInverterRaw, rows[i : i + _RAW_BATCH])
    return len(rows)
