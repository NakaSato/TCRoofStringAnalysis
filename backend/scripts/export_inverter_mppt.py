"""Export inverter details with MPPT usage (used / voltage-only / spare) to CSV.

Usage (from repo root):
    PYTHONPATH=backend uv run python backend/scripts/export_inverter_mppt.py                  # yesterday, all phases
    PYTHONPATH=backend uv run python backend/scripts/export_inverter_mppt.py --day 2026-11-11 --phase 2
    PYTHONPATH=backend uv run python backend/scripts/export_inverter_mppt.py --mppt-capacity 125=10 --mppt-capacity 100=10
    PYTHONPATH=backend uv run python backend/scripts/export_inverter_mppt.py --no-fetch      # stored history only

Writes three UTF-8 (BOM, opens in Excel with Thai names) files into `--out` (default data/exports/):
    inverter_mppt_summary_<day>.csv   one row per inverter: name, SN, status, yield, MPPT + string counts
    inverter_mppt_detail_<day>.csv    one row per inverter x MPPT slot
    inverter_string_detail_<day>.csv  one row per inverter x string slot (2 per MPPT)
    inverter_string_inputs_<day>.csv  one row per inverter, one column per string input
                                      ("String 3 (MPPT 2)"): which inputs are used at a glance —
                                      "USED 13.9 A" / IDLE / SPARE / V-ONLY / NO DATA / N/R,
                                      blank past the inverter's input count

How MPPTs are classified, from the day's records while the inverter produces (ppv > 0):
    used          max MPPT current >= --min-current (default 0.5 A)
    voltage_only  max voltage >= --min-voltage (default 200 V) but no current: PV connected yet
                  not producing (fuse, connector, breaker) — worth a site check
    spare         neither: the input has no PV attached
    no_data       the inverter had no production records that day (offline / no upload)

Strings (string n sits on MPPT ceil(n/2), 2 per MPPT; peak current while producing):
    used          peak current >= --min-string-current (default 0.3 A)
    idle          its MPPT is in use but this string carried no current: an unused second
                  input, or an open string / blown fuse — compare with the as-built design
    voltage_only  its MPPT has voltage but no current
    spare         its MPPT is spare
    not_reported  the inverter sent no per-string currents (MPPT data only)
    no_data       no production records that day
`peak_vs_inverter_median_pct` compares a used string's peak current with the median peak of the
inverter's used strings; `low_current` flags < --low-pct (default 80 %). Peak-of-day only — a
screening hint, not a performance ratio (strings on different roofs/orientations differ).

`inverter_status` is the status of the inverter's last record that day (stored history), and
`yield_kwh` that record's eac_today.

MPPT slot count (needed for "spare"): Growatt's max_data always carries 16 MPPT / 32 string
fields and the OpenAPI does not report the hardware MPPT count. So it is taken from, in order:
    user          --mppt-capacity <rated kW>=<MPPTs> (datasheet value)
    observed      highest MPPT number in use on any inverter of the same rated power that day
    self          highest MPPT number in use on this inverter (rated power unknown) — lower bound
`mppt_capacity_source` in the CSV says which one applied; "observed"/"self" can undercount spare
inputs when no inverter of that rating uses its last MPPT.

Data: stored history (growatt_inverter_readings / growatt_string_readings) for the day. Inverters
with nothing stored are fetched from Growatt (max_data, that phase's token) and upserted through
the normal history sync — Growatt-timestamped history only, nothing realtime is stored.
Rated power / alias / firmware come from `device/inverter/inv_data_info`, cached in
data/growatt_inverter_info.json (static, so re-runs make no calls for it).
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import pathlib
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import DATA_DIR, settings
from app.db.models import GrowattInverter, GrowattInverterReading, GrowattPlant, GrowattStringReading
from app.db.session import SessionLocal, ensure_schema
from app.services.growatt_sync import _retry, sync_inverter_history
from solar_core.growatt import INVERTER_STATUS_NAMES, GrowattAPIError, GrowattClient

log = logging.getLogger("mppt_export")

INFO_CACHE = DATA_DIR / "growatt_inverter_info.json"
STRINGS_PER_MPPT = 2  # string n sits on MPPT ceil(n/2)


# --------------------------------------------------------------------------- analysis (pure)


@dataclass
class MpptStat:
    mppt_no: int
    max_voltage_v: float = 0.0
    max_current_a: float = 0.0
    max_power_w: float = 0.0
    status: str = "spare"
    strings_used: List[int] = field(default_factory=list)
    string_max_current_a: Dict[int, float] = field(default_factory=dict)


def classify_mppts(
    production_mppt_rows: Iterable[List[Dict[str, Any]]],
    string_max_current: Dict[int, float],
    min_current_a: float = 0.5,
    min_voltage_v: float = 200.0,
    min_string_current_a: float = 0.3,
) -> Dict[int, MpptStat]:
    """Per-MPPT maxima and status from the day's `mppt_json` rows (production records only).

    Returns only MPPTs that reported anything; slots never seen are spare (added by the caller
    once the slot count is known).
    """
    stats: Dict[int, MpptStat] = {}
    for row in production_mppt_rows:
        for m in row or []:
            n = int(m["mppt"])
            s = stats.setdefault(n, MpptStat(n))
            s.max_voltage_v = max(s.max_voltage_v, float(m.get("v") or 0))
            s.max_current_a = max(s.max_current_a, float(m.get("i") or 0))
            s.max_power_w = max(s.max_power_w, float(m.get("p") or 0))
    for sn, cur in string_max_current.items():
        n = (sn + 1) // 2
        s = stats.setdefault(n, MpptStat(n))
        s.string_max_current_a[sn] = round(cur, 2)
        if cur >= min_string_current_a:
            s.strings_used.append(sn)
    for s in stats.values():
        if s.max_current_a >= min_current_a or s.strings_used:
            s.status = "used"
        elif s.max_voltage_v >= min_voltage_v:
            s.status = "voltage_only"
        else:
            s.status = "spare"
        s.strings_used.sort()
    return stats


def classify_strings(
    stats: Dict[int, MpptStat], capacity: int, min_string_current_a: float = 0.3, low_pct: float = 80.0
) -> List[Dict[str, Any]]:
    """One row per string slot 1..2*capacity (see module docs for the statuses)."""
    if not stats:
        return [{"string_no": n, "mppt_no": (n + 1) // 2, "status": "no_data", "peak_current_a": None,
                 "mppt_peak_voltage_v": None, "peak_vs_inverter_median_pct": None, "low_current": None}
                for n in range(1, STRINGS_PER_MPPT * capacity + 1)]
    reported = any(s.string_max_current_a for s in stats.values())
    used_peaks = sorted(c for s in stats.values() for c in s.string_max_current_a.values() if c >= min_string_current_a)
    median = None
    if used_peaks:
        k = len(used_peaks)
        median = used_peaks[k // 2] if k % 2 else (used_peaks[k // 2 - 1] + used_peaks[k // 2]) / 2
    out = []
    for n in range(1, STRINGS_PER_MPPT * capacity + 1):
        m = stats.get((n + 1) // 2) or MpptStat((n + 1) // 2)
        cur = m.string_max_current_a.get(n)
        if m.status == "spare":
            status = "spare"
        elif m.status == "voltage_only":
            status = "voltage_only"
        elif not reported:
            status = "not_reported"
        elif cur is not None and cur >= min_string_current_a:
            status = "used"
        else:
            status = "idle"
        pct = round(cur / median * 100, 1) if status == "used" and median and cur is not None else None
        out.append({
            "string_no": n,
            "mppt_no": m.mppt_no,
            "status": status,
            "peak_current_a": cur if reported else None,
            "mppt_peak_voltage_v": round(m.max_voltage_v, 1) if m.status != "spare" else None,
            "peak_vs_inverter_median_pct": pct,
            "low_current": (pct < low_pct) if pct is not None else None,
        })
    return out


def highest_active(stats: Dict[int, MpptStat]) -> int:
    return max((n for n, s in stats.items() if s.status in ("used", "voltage_only")), default=0)


# --------------------------------------------------------------------------- data access


@dataclass
class InvRow:
    inv: GrowattInverter
    plant: GrowattPlant
    phase: int
    info: Dict[str, Any]
    source: str = "none"
    records: int = 0
    peak_ppv_kw: Optional[float] = None
    last_status: Optional[int] = None
    last_record_at: Optional[datetime] = None
    yield_kwh: Optional[float] = None
    stats: Dict[int, MpptStat] = field(default_factory=dict)
    capacity: Optional[int] = None
    capacity_source: str = ""
    strings: List[Dict[str, Any]] = field(default_factory=list)


def _day_bounds(day: date) -> Tuple[datetime, datetime]:
    start = datetime.combine(day, datetime.min.time())
    return start, start + timedelta(days=1)


@dataclass
class DayData:
    records: int
    peak_kw: Optional[float]
    mppt_rows: List[List[Dict[str, Any]]]
    strings: Dict[int, float]
    last_status: Optional[int]
    last_at: Optional[datetime]
    yield_kwh: Optional[float]


def _load_day(db: Session, sn: str, day: date) -> DayData:
    start, end = _day_bounds(day)
    rows = db.execute(
        select(
            GrowattInverterReading.timestamp, GrowattInverterReading.ppv_w, GrowattInverterReading.mppt_json,
            GrowattInverterReading.status, GrowattInverterReading.eac_today_kwh,
        )
        .where(
            GrowattInverterReading.device_sn == sn,
            GrowattInverterReading.timestamp >= start,
            GrowattInverterReading.timestamp < end,
        )
        .order_by(GrowattInverterReading.timestamp)
    ).all()
    prod = [(ppv, mj) for _, ppv, mj, _, _ in rows if (ppv or 0) > 0]
    last = rows[-1] if rows else None
    # daily yield = eac_today of the day's last record that has one (not MAX: midnight carry-over)
    yield_kwh = next((e for *_, e in reversed(rows) if e is not None), None)
    peak = max((ppv for ppv, _ in prod), default=None)
    strings: Dict[int, float] = defaultdict(float)
    for no, cur in db.execute(
        select(GrowattStringReading.string_no, GrowattStringReading.current_a).where(
            GrowattStringReading.device_sn == sn,
            GrowattStringReading.timestamp >= start,
            GrowattStringReading.timestamp < end,
        )
    ):
        strings[no] = max(strings[no], cur or 0.0)
    return DayData(
        records=len(rows),
        peak_kw=round(peak / 1000, 2) if peak is not None else None,
        mppt_rows=[mj for _, mj in prod],
        strings=dict(strings),
        last_status=last[3] if last else None,
        last_at=last[0] if last else None,
        yield_kwh=yield_kwh,
    )


def _load_info_cache() -> Dict[str, Dict[str, Any]]:
    try:
        return json.loads(INFO_CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _fetch_info(client: GrowattClient, sn: str) -> Dict[str, Any]:
    d = _retry(lambda: client._request("GET", "device/inverter/inv_data_info", {"device_sn": sn}), f"{sn} inv_data_info") or {}
    nominal = d.get("nominalPower")
    return {
        "nominal_power_w": float(nominal) if nominal not in (None, "", 0) else None,
        "alias": d.get("alias") or d.get("treeName"),
        "fw_version": d.get("fwVersion"),
        "inner_version": d.get("innerVersion"),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def _rated_kw(info: Dict[str, Any]) -> Optional[float]:
    w = info.get("nominal_power_w")
    return round(w / 1000, 1) if w else None


# --------------------------------------------------------------------------- main


def _parse_capacity(values: List[str]) -> Dict[float, int]:
    out: Dict[float, int] = {}
    for v in values:
        kw, _, n = v.partition("=")
        try:
            out[round(float(kw), 1)] = int(n)
        except ValueError:
            raise SystemExit(f"--mppt-capacity expects <rated kW>=<MPPTs>, got {v!r}")
    return out


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Export inverter details with MPPT used / spare to CSV")
    ap.add_argument("--day", type=date.fromisoformat, default=date.today() - timedelta(days=1),
                    help="Plant-local day to analyse (default: yesterday)")
    ap.add_argument("--phase", type=int, action="append", help="Only these phases (repeatable)")
    ap.add_argument("--plant", type=int, action="append", help="Only these Growatt plant ids (repeatable)")
    ap.add_argument("--sn", action="append", help="Only these inverter serials (repeatable)")
    ap.add_argument("--mppt-capacity", action="append", default=[], metavar="KW=N",
                    help="Datasheet MPPT count per rated power, e.g. 125=10 (repeatable)")
    ap.add_argument("--min-current", type=float, default=0.5, help="A; MPPT counts as used above this")
    ap.add_argument("--min-voltage", type=float, default=200.0, help="V; voltage without current = voltage_only")
    ap.add_argument("--min-string-current", type=float, default=0.3, help="A; string counts as used above this")
    ap.add_argument("--low-pct", type=float, default=80.0, help="flag used strings below this %% of the inverter median")
    ap.add_argument("--no-fetch", action="store_true", help="Use stored history only; no max_data calls")
    ap.add_argument("--no-info", action="store_true", help="Skip inv_data_info (rated power) calls; cache still used")
    ap.add_argument("--out", type=pathlib.Path, default=DATA_DIR / "exports")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    accounts = settings.growatt_accounts()
    if not accounts and not (args.no_fetch and args.no_info):
        raise SystemExit("No Growatt token configured (GROWATT_TOKEN_PHASE1..4 or GROWATT_API_TOKEN)")
    first = min(accounts) if accounts else 1
    clients: Dict[int, GrowattClient] = {}

    def client_for(phase: int) -> Optional[GrowattClient]:
        if phase not in accounts:
            return None
        if phase not in clients:
            clients[phase] = GrowattClient(token=accounts[phase], base_url=settings.growatt_base_url, timeout=60)
        return clients[phase]

    user_capacity = _parse_capacity(args.mppt_capacity)
    info_cache = _load_info_cache()
    rows: List[InvRow] = []

    with SessionLocal() as db:
        ensure_schema(db.get_bind())
        q = (
            select(GrowattInverter, GrowattPlant)
            .join(GrowattPlant, GrowattPlant.plant_id == GrowattInverter.plant_id)
            .order_by(GrowattPlant.phase, GrowattPlant.plant_id, GrowattInverter.device_sn)
        )
        if args.phase:
            q = q.where(GrowattPlant.phase.in_(args.phase))
        if args.plant:
            q = q.where(GrowattPlant.plant_id.in_(args.plant))
        if args.sn:
            q = q.where(GrowattInverter.device_sn.in_(args.sn))
        pairs = [(inv, plant) for inv, plant in db.execute(q)]
        if not pairs:
            raise SystemExit("No inverters match (run the fleet sync first?)")
        log.info("%d inverters, day %s", len(pairs), args.day)

        for idx, (inv, plant) in enumerate(pairs, 1):
            phase = plant.phase if plant.phase is not None else first
            client = client_for(phase)
            r = InvRow(inv=inv, plant=plant, phase=phase, info=info_cache.get(inv.device_sn, {}))

            if not r.info and client and not args.no_info:
                try:
                    r.info = info_cache[inv.device_sn] = _fetch_info(client, inv.device_sn)
                except GrowattAPIError as exc:
                    log.warning("%s info: %s", inv.device_sn, exc)
                time.sleep(0.3)

            d = _load_day(db, inv.device_sn, args.day)
            r.source = "db" if d.records else "none"
            if not d.records and client and not args.no_fetch:
                try:
                    sync_inverter_history(db, client, inv, args.day, args.day)
                    d = _load_day(db, inv.device_sn, args.day)
                    r.source = "api" if d.records else "none"
                except Exception as exc:  # keep going; reported in the CSV
                    db.rollback()
                    r.source = f"error: {exc}"
                    log.warning("%s history: %s", inv.device_sn, exc)
                time.sleep(0.3)

            r.records, r.peak_ppv_kw = d.records, d.peak_kw
            r.last_status, r.last_record_at, r.yield_kwh = d.last_status, d.last_at, d.yield_kwh
            r.stats = (
                classify_mppts(d.mppt_rows, d.strings, args.min_current, args.min_voltage, args.min_string_current)
                if d.mppt_rows else {}
            )
            rows.append(r)
            if idx % 25 == 0:
                log.info("[%d/%d] processed", idx, len(pairs))
                INFO_CACHE.write_text(json.dumps(info_cache, ensure_ascii=False, indent=1), encoding="utf-8")

    INFO_CACHE.write_text(json.dumps(info_cache, ensure_ascii=False, indent=1), encoding="utf-8")

    # MPPT slot count: datasheet override > highest MPPT in use among same-rating inverters > own
    observed: Dict[Optional[float], int] = defaultdict(int)
    for r in rows:
        kw = _rated_kw(r.info)
        if kw is not None:
            observed[kw] = max(observed[kw], highest_active(r.stats))
    for r in rows:
        kw = _rated_kw(r.info)
        own = highest_active(r.stats)
        if kw is not None and kw in user_capacity:
            r.capacity, r.capacity_source = user_capacity[kw], "user"
        elif kw is not None and observed.get(kw):
            r.capacity, r.capacity_source = observed[kw], "observed"
        elif own:
            r.capacity, r.capacity_source = own, "self"
        if r.capacity and own > r.capacity:
            log.warning("%s uses MPPT %d but capacity is %d (%s)", r.inv.device_sn, own, r.capacity, r.capacity_source)
            r.capacity = own

    args.out.mkdir(parents=True, exist_ok=True)
    summary_path = args.out / f"inverter_mppt_summary_{args.day}.csv"
    detail_path = args.out / f"inverter_mppt_detail_{args.day}.csv"
    string_path = args.out / f"inverter_string_detail_{args.day}.csv"
    inputs_path = args.out / f"inverter_string_inputs_{args.day}.csv"
    for r in rows:
        r.strings = classify_strings(r.stats, r.capacity or 0, args.min_string_current, args.low_pct)
    _write(summary_path, detail_path, rows, args.day)
    _write_strings(string_path, rows, args.day)
    _write_inputs(inputs_path, rows, args.day)
    _report(rows, summary_path, detail_path, string_path)
    return 0


def _fmt_list(ns: Iterable[int]) -> str:
    """Numbers as "1, 2, 3" (the CSV writer quotes the cell)."""
    return ", ".join(str(n) for n in ns)


def _write(summary_path: pathlib.Path, detail_path: pathlib.Path, rows: List[InvRow], day: date) -> None:
    with summary_path.open("w", newline="", encoding="utf-8-sig") as fs, detail_path.open(
        "w", newline="", encoding="utf-8-sig"
    ) as fd:
        ws, wd = csv.writer(fs), csv.writer(fd)
        ws.writerow([
            "day", "phase", "plant_id", "plant_name", "inverter_name", "inverter_sn", "datalogger_sn", "model_code",
            "rated_power_kw", "fw_version", "inverter_status", "last_record_at", "yield_kwh", "data_source",
            "records_in_day", "peak_dc_power_kw",
            "mppt_capacity", "mppt_capacity_source", "mppt_used", "mppt_voltage_only", "mppt_spare",
            "used_mppts", "voltage_only_mppts", "spare_mppts",
            "string_capacity", "strings_used", "strings_idle", "strings_spare", "strings_low_current",
            "used_strings", "idle_strings", "spare_strings", "low_current_strings",
        ])
        wd.writerow([
            "day", "phase", "plant_id", "plant_name", "inverter_name", "inverter_sn", "rated_power_kw", "mppt_no",
            "status", "max_voltage_v", "max_current_a", "max_power_w", "strings_on_mppt_used", "used_strings",
            "string_max_current_a",
        ])
        for r in rows:
            has_data = bool(r.stats) or r.records > 0
            cap = r.capacity
            slots = range(1, (cap or 0) + 1)
            status = {n: (r.stats[n].status if n in r.stats else "spare") for n in slots} if r.stats else {}
            used = [n for n, s in status.items() if s == "used"]
            vonly = [n for n, s in status.items() if s == "voltage_only"]
            spare = [n for n, s in status.items() if s == "spare"]
            produced = bool(r.stats)
            by_status: Dict[str, List[int]] = defaultdict(list)
            for x in r.strings:
                by_status[x["status"]].append(x["string_no"])
            low = [x["string_no"] for x in r.strings if x["low_current"]]
            reported = produced and "not_reported" not in by_status

            def cnt(ns: List[int], ok: bool = reported) -> Optional[int]:
                return len(ns) if ok else None

            ws.writerow([
                day, r.phase, r.plant.plant_id, r.plant.name, r.info.get("alias"), r.inv.device_sn,
                r.inv.datalogger_sn, r.inv.model, _rated_kw(r.info), r.info.get("fw_version"),
                _status_label(r.last_status), r.last_record_at.strftime("%Y-%m-%d %H:%M:%S") if r.last_record_at else None,
                r.yield_kwh, r.source, r.records, r.peak_ppv_kw, cap, r.capacity_source or None,
                len(used) if produced else None, len(vonly) if produced else None, len(spare) if produced else None,
                _fmt_list(used), _fmt_list(vonly), _fmt_list(spare),
                STRINGS_PER_MPPT * cap if cap else None,
                cnt(by_status["used"]), cnt(by_status["idle"]), cnt(by_status["spare"], produced), cnt(low),
                _fmt_list(by_status["used"]), _fmt_list(by_status["idle"]), _fmt_list(by_status["spare"]), _fmt_list(low),
            ])
            if not produced:
                wd.writerow([day, r.phase, r.plant.plant_id, r.plant.name, r.info.get("alias"), r.inv.device_sn,
                             _rated_kw(r.info), None, "no_data" if not has_data else "no_production",
                             None, None, None, None, "", ""])
                continue
            for n in slots:
                s = r.stats.get(n, MpptStat(n))
                wd.writerow([
                    day, r.phase, r.plant.plant_id, r.plant.name, r.info.get("alias"), r.inv.device_sn,
                    _rated_kw(r.info), n, status[n], round(s.max_voltage_v, 1), round(s.max_current_a, 2),
                    round(s.max_power_w, 1), len(s.strings_used), _fmt_list(s.strings_used),
                    ", ".join(f"{k}:{v}" for k, v in sorted(s.string_max_current_a.items())),
                ])


def _status_label(code: Optional[int]) -> Optional[str]:
    if code is None:
        return None
    return INVERTER_STATUS_NAMES.get(int(code), f"Status {code}")


def _write_strings(path: pathlib.Path, rows: List[InvRow], day: date) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([
            "day", "phase", "plant_id", "plant_name", "inverter_name", "inverter_sn", "rated_power_kw",
            "inverter_status", "string_no", "mppt_no", "status", "peak_current_a", "mppt_peak_voltage_v",
            "peak_vs_inverter_median_pct", "low_current",
        ])
        for r in rows:
            for x in r.strings:
                w.writerow([
                    day, r.phase, r.plant.plant_id, r.plant.name, r.info.get("alias"), r.inv.device_sn,
                    _rated_kw(r.info), _status_label(r.last_status), x["string_no"], x["mppt_no"], x["status"],
                    x["peak_current_a"], x["mppt_peak_voltage_v"], x["peak_vs_inverter_median_pct"],
                    {True: "yes", False: "no"}.get(x["low_current"]),
                ])


_INPUT_CELL = {"idle": "IDLE", "spare": "SPARE", "voltage_only": "V-ONLY", "no_data": "NO DATA", "not_reported": "N/R"}


def _input_cell(x: Dict[str, Any]) -> str:
    if x["status"] == "used":
        cell = f"USED {x['peak_current_a']:.1f} A"
        return cell + " LOW" if x["low_current"] else cell
    return _INPUT_CELL.get(x["status"], x["status"])


def _write_inputs(path: pathlib.Path, rows: List[InvRow], day: date) -> None:
    """Grid: one row per inverter, one column per string input (which inputs carry PV)."""
    width = max((len(r.strings) for r in rows), default=0)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([
            "day", "phase", "plant_id", "plant_name", "inverter_name", "inverter_sn", "rated_power_kw",
            "inverter_status", "inputs_total", "inputs_used", "inputs_idle", "inputs_spare", "used_inputs",
            "idle_inputs",
            *[f"String {n} (MPPT {(n + 1) // 2})" for n in range(1, width + 1)],
        ])
        for r in rows:
            by: Dict[str, List[int]] = defaultdict(list)
            for x in r.strings:
                by[x["status"]].append(x["string_no"])
            known = bool(r.stats) and "not_reported" not in by
            cells = [_input_cell(x) for x in r.strings]
            w.writerow([
                day, r.phase, r.plant.plant_id, r.plant.name, r.info.get("alias"), r.inv.device_sn, _rated_kw(r.info),
                _status_label(r.last_status), len(r.strings) or None,
                len(by["used"]) if known else None, len(by["idle"]) if known else None,
                len(by["spare"]) if r.stats else None, _fmt_list(by["used"]),
                _fmt_list(by["idle"]),
                *cells, *[""] * (width - len(cells)),
            ])


def _report(rows: List[InvRow], summary_path: pathlib.Path, detail_path: pathlib.Path, string_path: pathlib.Path) -> None:
    produced = [r for r in rows if r.stats]
    tot = defaultdict(int)
    for r in produced:
        for n in range(1, (r.capacity or 0) + 1):
            tot[r.stats[n].status if n in r.stats else "spare"] += 1
    by_src = defaultdict(int)
    for r in rows:
        by_src[r.source.split(":")[0]] += 1
    log.info("inverters: %d (with production data %d) — sources %s", len(rows), len(produced), dict(by_src))
    log.info("MPPTs: used %d, voltage_only %d, spare %d", tot["used"], tot["voltage_only"], tot["spare"])
    st = defaultdict(int)
    for r in rows:
        for x in r.strings:
            st[x["status"]] += 1
        st["low_current"] += sum(1 for x in r.strings if x["low_current"])
    log.info("strings: %s", dict(st))
    log.info("wrote %s", string_path)
    log.info("wrote %s", summary_path)
    log.info("wrote %s", detail_path)


if __name__ == "__main__":
    raise SystemExit(main())
