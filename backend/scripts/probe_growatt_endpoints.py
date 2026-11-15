"""Probe Growatt OpenAPI read endpoints once per phase and save the raw replies.

One-off research tool: which endpoints answer for our tokens, and with what fields.
Endpoint list and parameters follow the `growatt-public-api` package (2026.5.19).

READ ONLY. Every endpoint is on the READ list below; anything that sets, adds, deletes,
modifies or registers is never called (the request function refuses such paths).

Sample devices come from the DB (first plant / MAX inverter / sensor of each phase), so the
DB must have been synced by the worker first.

    PYTHONPATH=backend uv run python backend/scripts/probe_growatt_endpoints.py
    ... --phase 1               one phase only
    ... --only device/max/      endpoints whose path contains this text
    ... --other-types           also probe the TLX / mix / SPA / storage / ... families with our MAX SN
    ... --pause 3               seconds between calls (default 2)
    ... --dry-run               print what would be called, call nothing
    ... --maxs-batch --phase 1  maxs_data batch size / repeat test (live values: replies not saved)
    ... --read-power --phase 3  readPower (power limit %) for every MAX of the phase, vs today's stored peak

Replies go to data/growatt_probe/phase<N>/<endpoint>.json (gitignored; no token is written).
Run it outside the worker's busy minutes (09/13/17:20-:31 and the half-hour history runs):
it shares the worker's tokens and Growatt's per-token rate limits.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests
from sqlalchemy import select

from app.config import settings
from app.db.models import GrowattEnvSensor, GrowattInverter, GrowattPlant
from app.db.session import SessionLocal

OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "growatt_probe"
RATE_LIMIT_CODE = 10012  # Growatt "access too frequently"
RATE_LIMIT_WAIT_S = 65
FORBIDDEN = re.compile(r"(set|add|delete|modify|register|remove|validate)", re.IGNORECASE)
# read endpoints whose name matches FORBIDDEN anyway
READ_DESPITE_NAME = {"device/tlx/tlx_set_info"}
KNOWN_USED = {
    "plant/list", "plant/data", "device/list", "device/max/max_data_info", "device/max/max_data",
    "device/max/alarm_data", "device/env/env_list", "device/env/env_data", "device/env/env_last_data",
}


@dataclass
class Sample:
    phase: int
    plant_id: int
    max_sn: str
    max_sns: List[str]
    datalogger_sn: Optional[str]
    env: Optional[Tuple[str, int]]  # (datalogger_sn, address)


@dataclass
class Probe:
    path: str
    method: str  # GET | POST
    build: Callable[[Sample, date], Optional[Dict[str, Any]]]  # None = skip (no sample device)
    as_query: bool = False  # POST with the parameters in the query string (new-api)
    group: str = "core"


def _day(d: date) -> str:
    return d.isoformat()


def _env(fn: Callable[[Tuple[str, int], date], Dict[str, Any]]) -> Callable[[Sample, date], Optional[Dict[str, Any]]]:
    """Builder that gets the sample sensor (datalogger SN, address); skipped without one."""
    return lambda s, d: fn(s.env, d) if s.env else None


def _dl(fn: Callable[[Sample, date], Dict[str, Any]]) -> Callable[[Sample, date], Optional[Dict[str, Any]]]:
    return lambda s, d: fn(s, d) if s.datalogger_sn else None


def _v4(extra: Optional[Dict[str, Any]] = None) -> Callable[[Sample, date], Dict[str, Any]]:
    return lambda s, d: {"deviceSn": s.max_sn, "deviceType": "max", **(extra or {})}


CORE: List[Probe] = [
    # plant
    Probe("plant/list", "GET", lambda s, d: {"page": 1, "perpage": 100}),
    Probe("plant/details", "GET", lambda s, d: {"plant_id": s.plant_id}),
    Probe("plant/data", "GET", lambda s, d: {"plant_id": s.plant_id}),
    Probe("plant/energy", "GET", lambda s, d: {"plant_id": s.plant_id, "start_date": _day(d - timedelta(days=6)),
                                               "end_date": _day(d), "time_unit": "day", "page": 1, "perpage": 100}),
    Probe("plant/power", "GET", lambda s, d: {"plant_id": s.plant_id, "date": _day(d)}),
    Probe("plant/sn_plant", "POST", lambda s, d: {"device_sn": s.max_sn}),
    # devices
    Probe("device/list", "GET", lambda s, d: {"plant_id": s.plant_id, "page": 1, "perpage": 100}),
    Probe("device/datalogger/list", "GET", lambda s, d: {"plant_id": s.plant_id, "page": 1, "perpage": 100}),
    Probe("device/check/sn", "GET", _dl(lambda s, d: {"dataloggerSn": s.datalogger_sn})),
    Probe("device/sn_datalog", "POST", lambda s, d: {"device_sn": s.max_sn}),
    Probe("device/all/create_date", "POST", lambda s, d: {"pageNum": 1, "devices": ",".join(s.max_sns)}),
    Probe("device/inverter/day_energy", "GET", lambda s, d: {"device_sn": s.max_sn, "date": _day(d)}),
    Probe("device/ammeter/meter_list", "GET", _dl(lambda s, d: {"datalog_sn": s.datalogger_sn, "page": 1, "perpage": 100})),
    # MAX
    Probe("device/max/max_data_info", "GET", lambda s, d: {"device_sn": s.max_sn}),
    Probe("device/max/max_last_data", "POST", lambda s, d: {"max_sn": s.max_sn}),
    Probe("device/max/maxs_data", "POST", lambda s, d: {"maxs": ",".join(s.max_sns), "pageNum": 1}),
    Probe("device/max/max_data", "POST", lambda s, d: {"max_sn": s.max_sn, "start_date": _day(d), "end_date": _day(d),
                                                      "page": 1, "perpage": 100}),
    Probe("device/max/alarm_data", "POST", lambda s, d: {"max_sn": s.max_sn, "date": _day(d), "page": 1, "perpage": 100}),
    # readMaxParam only reads; the paramId is a named setting (on/off state)
    Probe("readMaxParam", "POST", lambda s, d: {"device_sn": s.max_sn, "paramId": "pv_on_off", "startAddr": 0, "endAddr": 0}),
    # weather sensor
    Probe("device/env/env_list", "GET", _dl(lambda s, d: {"datalog_sn": s.env[0] if s.env else s.datalogger_sn,
                                                         "page": 1, "perpage": 100})),
    Probe("device/env/env_last_data", "GET", _env(lambda e, d: {"datalog_sn": e[0], "address": e[1]})),
    Probe("device/env/env_data", "GET", _env(lambda e, d: {"datalog_sn": e[0], "address": e[1],
                                                         "start_date": _day(d), "end_date": _day(d), "page": 1, "perpage": 100})),
    # new API (read only)
    Probe("new-api/queryDeviceList", "POST", lambda s, d: {"page": 1}, as_query=True),
    Probe("new-api/queryDeviceInfo", "POST", _v4(), as_query=True),
    Probe("new-api/queryDeviceInfoParam", "POST", _v4(), as_query=True),
    Probe("new-api/queryLastData", "POST", _v4(), as_query=True),
    Probe("new-api/queryDfcData", "POST", _v4(), as_query=True),
    Probe("new-api/readPower", "POST", _v4(), as_query=True),
    Probe("new-api/queryHistoricalData", "POST", lambda s, d: {**_v4()(s, d), "date": _day(d)}, as_query=True),
    Probe("new-api/queryDevicesHistoricalData", "POST", lambda s, d: {"deviceSn": ",".join(s.max_sns), "deviceType": "max",
                                                                     "date": _day(d)}, as_query=True),
    Probe("new-api/getWiFiSignalByDevice", "POST", _v4(), as_query=True),
    # users
    Probe("user/c_user_list", "GET", lambda s, d: {"page": 1, "perpage": 100}),
]


def _family(prefix: str, sn_key: str, info: bool = True, last: bool = True, many: Optional[str] = None,
            alarm: bool = True) -> List[Probe]:
    """Read endpoints of another device family, probed with our MAX SN (expect 'no such device')."""
    out: List[Probe] = []
    base = f"device/{prefix}/{prefix}"
    if info:
        out.append(Probe(f"{base}_data_info", "GET", lambda s, d: {"device_sn": s.max_sn}, group="other"))
    if last:
        out.append(Probe(f"{base}_last_data", "POST", lambda s, d: {sn_key: s.max_sn}, group="other"))
    if many:
        out.append(Probe(f"device/{prefix}/{many}", "POST", lambda s, d: {many.replace("_data", ""): s.max_sn, "pageNum": 1},
                         group="other"))
    out.append(Probe(f"{base}_data", "POST", lambda s, d: {sn_key: s.max_sn, "start_date": _day(d), "end_date": _day(d),
                                                        "page": 1, "perpage": 100}, group="other"))
    if alarm:
        out.append(Probe(f"device/{prefix}/alarm_data", "POST", lambda s, d: {sn_key: s.max_sn, "date": _day(d)}, group="other"))
    return out


OTHER: List[Probe] = [
    *_family("tlx", "tlx_sn", many="tlxs_data"),
    Probe("device/tlx/tlx_set_info", "GET", lambda s, d: {"device_sn": s.max_sn}, group="other"),
    *_family("mix", "mix_sn", many="mixs_data"),
    *_family("spa", "spa_sn", many="spas_data"),
    *_family("storage", "storage_sn"),
    *_family("hps", "hps_sn"),
    *_family("pbd", "pbd_sn"),
    *_family("pcs", "pcs_sn"),
    *_family("boost", "boost_sn", many="boosts_data", alarm=False),
    Probe("device/inverter/inv_data_info", "GET", lambda s, d: {"device_sn": s.max_sn}, group="other"),
    Probe("device/inverter/last_new_data", "GET", lambda s, d: {"device_sn": s.max_sn}, group="other"),
    Probe("device/inverter/invs_data", "POST", lambda s, d: {"inverters": s.max_sn, "pageNum": 1}, group="other"),
    Probe("device/inverter/data", "GET", lambda s, d: {"device_sn": s.max_sn, "start_date": _day(d), "end_date": _day(d),
                                                      "page": 1, "perpage": 100}, group="other"),
    Probe("device/inverter/alarm", "GET", lambda s, d: {"device_sn": s.max_sn, "date": _day(d), "page": 1, "perpage": 100},
          group="other"),
    Probe("device/ammeter/meter_last_data", "GET", _dl(lambda s, d: {"datalog_sn": s.datalogger_sn, "address": 1}), group="other"),
    Probe("device/ammeter/meter_data", "GET", _dl(lambda s, d: {"datalog_sn": s.datalogger_sn, "address": 1,
                                                               "start_date": _day(d), "end_date": _day(d), "page": 1,
                                                               "perpage": 100}), group="other"),
    Probe("device/vpp/getSocData", "POST", lambda s, d: {"vppSn": s.max_sn}, group="other"),
    Probe("noahDeviceApi/noah/getSystemStatus", "POST", lambda s, d: {"deviceSn": s.max_sn}, group="other"),
    Probe("noahDeviceApi/noah/getBatteryData", "POST", lambda s, d: {"deviceSn": s.max_sn}, group="other"),
]


def _is_read_only(path: str) -> bool:
    # only the last path part names the action (e.g. "noahDeviceApi/noah/getSystemStatus")
    return path in READ_DESPITE_NAME or not FORBIDDEN.search(path.rsplit("/", 1)[-1])


def call(session: requests.Session, base_url: str, probe: Probe, params: Dict[str, Any]) -> Dict[str, Any]:
    if not _is_read_only(probe.path):
        raise RuntimeError(f"refusing non-read endpoint {probe.path}")
    url = base_url + probe.path
    t0 = time.monotonic()
    try:
        if probe.method == "GET":
            resp = session.get(url, params=params, timeout=60)
        elif probe.as_query:
            resp = session.post(url, params=params, timeout=60)
        else:
            resp = session.post(url, data=params, timeout=60)
        ms = round((time.monotonic() - t0) * 1000)
        try:
            body: Any = resp.json()
        except ValueError:
            body = {"_non_json": resp.text[:2000]}
        return {"http": resp.status_code, "ms": ms, "body": body}
    except requests.RequestException as exc:
        return {"http": None, "ms": round((time.monotonic() - t0) * 1000), "body": {"_error": f"{type(exc).__name__}: {exc}"}}


def _count_fields(data: Any) -> int:
    """Distinct keys in the reply's data (first record of a list), a rough size of what it returns."""
    if isinstance(data, list):
        return _count_fields(data[0]) if data else 0
    if isinstance(data, dict):
        lists = [v for v in data.values() if isinstance(v, list) and v and isinstance(v[0], dict)]
        return max([len(data)] + [len(v[0]) for v in lists])
    return 0


def _summary(body: Any) -> tuple:
    if not isinstance(body, dict):
        return None, "", 0
    code = body.get("error_code", body.get("code"))
    msg = str(body.get("error_msg") or body.get("msg") or body.get("_error") or body.get("_non_json") or "")[:60]
    data = body.get("data")
    return code, msg, _count_fields(data)


def samples(phases: List[int]) -> Dict[int, Sample]:
    first = min(settings.growatt_accounts())
    out: Dict[int, Sample] = {}
    with SessionLocal() as db:
        for phase in phases:
            q = select(GrowattPlant).order_by(GrowattPlant.plant_id)
            q = q.where((GrowattPlant.phase == phase) | (GrowattPlant.phase.is_(None))) if phase == first \
                else q.where(GrowattPlant.phase == phase)
            for plant in db.scalars(q):
                invs = db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant.plant_id)
                                  .order_by(GrowattInverter.device_sn)).all()
                if not invs:
                    continue
                env = db.scalars(select(GrowattEnvSensor).where(GrowattEnvSensor.plant_id == plant.plant_id)).first()
                out[phase] = Sample(
                    phase=phase,
                    plant_id=plant.plant_id,
                    max_sn=invs[0].device_sn,
                    max_sns=[i.device_sn for i in invs[:5]],
                    datalogger_sn=invs[0].datalogger_sn,
                    env=(env.datalogger_sn, env.address) if env else None,
                )
                # prefer a plant with a weather sensor; keep looking for one
                if env:
                    break
            if phase in out and out[phase].env is None:
                # take the first sensor of the phase for the env probes
                env = db.scalars(select(GrowattEnvSensor).join(GrowattPlant, GrowattPlant.plant_id == GrowattEnvSensor.plant_id)
                                 .where(GrowattPlant.phase == phase)).first()
                if env:
                    out[phase].env = (env.datalogger_sn, env.address)
    return out


def read_power_sweep(phases: List[int], pause: float, day: Optional[date]) -> int:
    """`new-api/readPower` (active power limit %) for every MAX of the phases, next to the
    nameplate and the stored peak AC of `day` (default: the newest stored day in the DB), to see
    whether the value matches what the inverter does."""
    from sqlalchemy import func

    from app.db.models import GrowattInverterReading

    accounts = settings.growatt_accounts()
    first = min(accounts)
    base_url = settings.growatt_base_url.rstrip("/") + "/"
    probe = Probe("new-api/readPower", "POST", _v4(), as_query=True)
    if day is None:
        with SessionLocal() as db:
            newest = db.scalar(select(func.max(GrowattInverterReading.timestamp)))
        day = newest.date() if newest else date.today()
    print(f"peak AC compared from stored day {day}")
    start = datetime.combine(day, datetime.min.time())
    rows: List[Dict[str, Any]] = []
    for phase in phases:
        with SessionLocal() as db:
            cond = (GrowattPlant.phase == phase) | (GrowattPlant.phase.is_(None)) if phase == first else GrowattPlant.phase == phase
            invs = db.execute(
                select(GrowattInverter.device_sn, GrowattInverter.plant_id, GrowattPlant.name, GrowattInverter.nominal_power_w)
                .join(GrowattPlant, GrowattPlant.plant_id == GrowattInverter.plant_id).where(cond)
                .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
            ).all()
            peaks = dict(db.execute(
                select(GrowattInverterReading.device_sn, func.max(GrowattInverterReading.pac_w))
                .where(GrowattInverterReading.timestamp >= start, GrowattInverterReading.timestamp < start + timedelta(days=1))
                .group_by(GrowattInverterReading.device_sn)
            ).all())
        session = requests.Session()
        session.headers.update({"token": accounts[phase]})
        print(f"\nphase {phase}: {len(invs)} inverters, readPower every {pause:g} s")
        for i, (sn, plant_id, plant_name, nominal_w) in enumerate(invs):
            if i:
                time.sleep(pause)
            res = call(session, base_url, probe, {"deviceSn": sn, "deviceType": "max"})
            body = res["body"] if isinstance(res["body"], dict) else {}
            if body.get("code") == RATE_LIMIT_CODE or body.get("error_code") == RATE_LIMIT_CODE:
                print(f"  {sn}: rate limited, waiting {RATE_LIMIT_WAIT_S} s")
                time.sleep(RATE_LIMIT_WAIT_S)
                res = call(session, base_url, probe, {"deviceSn": sn, "deviceType": "max"})
                body = res["body"] if isinstance(res["body"], dict) else {}
            ok = body.get("code") == 0 and isinstance(body.get("data"), (int, float))
            peak = peaks.get(sn)
            peak_pct = round(peak / nominal_w * 100, 1) if peak is not None and nominal_w else None
            row = {"phase": phase, "plant_id": plant_id, "plant": plant_name, "device_sn": sn,
                   "read_power_pct": body.get("data") if ok else None,
                   "error": None if ok else f"{body.get('code')}: {body.get('message')}",
                   "nominal_w": nominal_w, "peak_ac_today_w": peak, "peak_pct_of_nominal": peak_pct}
            rows.append(row)
            flag = "  <-- limited" if ok and body["data"] < 100 else ""
            print(f"  {sn:12} {str(plant_name)[:28]:28} readPower {str(row['read_power_pct'] if ok else row['error']):28}"
                  f" peak {peak_pct if peak_pct is not None else '—'}% of nominal{flag}")
    out = OUT_DIR / f"read_power_phase{'_'.join(map(str, phases))}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
    n_ok = sum(1 for r in rows if r["read_power_pct"] is not None)
    limited = [r for r in rows if r["read_power_pct"] is not None and r["read_power_pct"] < 100]
    print(f"\nanswered {n_ok}/{len(rows)}, below 100 %: {len(limited)}")
    for r in limited:
        print(f"  {r['device_sn']:12} {str(r['plant'])[:30]:30} limit {r['read_power_pct']}%  peak {r['peak_pct_of_nominal']}% of nominal")
    print(f"saved {out}")
    return 0


def maxs_batch_test(phase: int, rounds_s: List[int], sizes: List[int]) -> int:
    """`device/max/maxs_data` with batches of real serials, repeated at `rounds_s` seconds after
    the start: how many serials one call answers (and pages), how fresh the records are, how long
    it takes and when Growatt starts refusing (10012). Raw replies are not kept (live values)."""
    accounts = settings.growatt_accounts()
    first = min(accounts)
    base_url = settings.growatt_base_url.rstrip("/") + "/"
    probe = Probe("device/max/maxs_data", "POST", lambda s, d: {})
    with SessionLocal() as db:
        cond = (GrowattPlant.phase == phase) | (GrowattPlant.phase.is_(None)) if phase == first else GrowattPlant.phase == phase
        rows = db.execute(
            select(GrowattInverter.device_sn, GrowattInverter.plant_id)
            .join(GrowattPlant, GrowattPlant.plant_id == GrowattInverter.plant_id).where(cond)
            .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
        ).all()
    by_plant: Dict[int, List[str]] = {}
    for sn, pid in rows:
        by_plant.setdefault(pid, []).append(sn)
    big_pid, big = max(by_plant.items(), key=lambda kv: len(kv[1]))
    all_sns = [sn for sn, _ in rows]
    batches = [("plant %s" % big_pid, big)] + [(f"{n} serials", all_sns[:n]) for n in sizes if n <= len(all_sns)]
    session = requests.Session()
    session.headers.update({"token": accounts[phase]})
    print(f"phase {phase}: {len(all_sns)} inverters; biggest plant {big_pid} has {len(big)}")
    results: List[Dict[str, Any]] = []
    t0 = time.monotonic()
    for r, at in enumerate(rounds_s):
        wait = at - (time.monotonic() - t0)
        if wait > 0:
            time.sleep(wait)
        for label, sns in batches:
            page, got, codes, ms_total, pages = 1, {}, [], 0, 0
            while page <= 10:
                res = call(session, base_url, probe, {"maxs": ",".join(sns), "pageNum": page})
                ms_total += res["ms"]
                pages += 1
                body = res["body"] if isinstance(res["body"], dict) else {}
                code = body.get("error_code")
                codes.append(code)
                raw = body.get("data")
                data: Dict[str, Any] = raw if isinstance(raw, dict) else {}
                for sn, v in data.items():
                    rec = (v or {}).get(sn) if isinstance(v, dict) else None
                    got[sn] = rec.get("time") if isinstance(rec, dict) else None
                if code != 0 or not data or len(got) >= len(sns):
                    break
                page += 1
                time.sleep(1)
            times = sorted(t for t in got.values() if t)
            row = {"round": r, "at_s": round(time.monotonic() - t0), "batch": label, "sent": len(sns), "answered": len(got),
                   "with_record": len(times), "pages": pages, "codes": codes, "ms": ms_total,
                   "oldest": times[0] if times else None, "newest": times[-1] if times else None}
            results.append(row)
            print(f"  +{row['at_s']:4}s {label:12} sent {len(sns):3} answered {len(got):3} with record {len(times):3}"
                  f" pages {pages} codes {codes} {ms_total:5} ms  records {row['oldest']} .. {row['newest']}", flush=True)
            time.sleep(2)
    out = OUT_DIR / f"maxs_batch_phase{phase}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str))
    print(f"saved {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", type=int, action="append", help="phase to probe (repeatable; default all configured)")
    ap.add_argument("--only", help="probe only endpoints whose path contains this text")
    ap.add_argument("--other-types", action="store_true", help="also probe other device families with our MAX SN")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between calls (default 2)")
    ap.add_argument("--day", type=date.fromisoformat, default=None, help="day for dated endpoints (default today)")
    ap.add_argument("--maxs-batch", action="store_true",
                    help="maxs_data batch test (biggest plant, 50 and 100 serials) at 0 / 60 / 180 / 300 s; first --phase only")
    ap.add_argument("--read-power", action="store_true", help="sweep new-api/readPower over every MAX of the phases")
    ap.add_argument("--dry-run", action="store_true", help="print the calls and parameters, call nothing")
    args = ap.parse_args()

    accounts = settings.growatt_accounts()
    if not accounts:
        print("No Growatt token configured (GROWATT_TOKEN_PHASE1..4 / GROWATT_API_TOKEN).", file=sys.stderr)
        return 2
    phases = [p for p in (args.phase or sorted(accounts)) if p in accounts]
    if args.maxs_batch:
        return maxs_batch_test(phases[0], [0, 60, 180, 300], [50, 100])
    if args.read_power:
        return read_power_sweep(phases, args.pause, args.day)
    probes = CORE + (OTHER if args.other_types else [])
    if args.only:
        probes = [p for p in probes if args.only in p.path]
    for p in probes:
        assert _is_read_only(p.path), p.path

    found = samples(phases)
    day = args.day or date.today()
    base_url = settings.growatt_base_url.rstrip("/") + "/"
    rows: List[Dict[str, Any]] = []

    for phase in phases:
        s = found.get(phase)
        if not s:
            print(f"phase {phase}: no plant with inverters in the DB, skipped (run the worker's fleet sync first)")
            continue
        print(f"\nphase {phase}: plant {s.plant_id}, MAX {s.max_sn}, datalogger {s.datalogger_sn}, sensor {s.env}")
        session = requests.Session()
        session.headers.update({"token": accounts[phase]})
        out_dir = OUT_DIR / f"phase{phase}"
        out_dir.mkdir(parents=True, exist_ok=True)

        for i, probe in enumerate(probes):
            params = probe.build(s, day)
            if params is None:
                rows.append({"phase": phase, "path": probe.path, "code": "skip", "msg": "no sample device", "fields": 0, "ms": 0})
                continue
            if args.dry_run:
                print(f"  {probe.method:4} {probe.path:42} {params}")
                continue
            if i:
                time.sleep(args.pause)
            res = call(session, base_url, probe, params)
            code, msg, fields = _summary(res["body"])
            if code == RATE_LIMIT_CODE:
                print(f"  {probe.path}: rate limited, waiting {RATE_LIMIT_WAIT_S} s and retrying once")
                time.sleep(RATE_LIMIT_WAIT_S)
                res = call(session, base_url, probe, params)
                code, msg, fields = _summary(res["body"])
            (out_dir / (probe.path.replace("/", "__") + ".json")).write_text(
                json.dumps({"path": probe.path, "method": probe.method, "params": params, **res},
                           ensure_ascii=False, indent=2, default=str)
            )
            row = {"phase": phase, "path": probe.path, "code": code, "msg": msg, "fields": fields, "ms": res["ms"],
                   "http": res["http"]}
            rows.append(row)
            print(f"  {probe.path:42} http {res['http']}  code {code!s:6} fields {fields:3}  {res['ms']:5} ms  {msg}")

    if args.dry_run:
        return 0
    # summary: one line per endpoint over all phases
    print("\nendpoint                                    used  ok/phases  fields  note")
    by_path: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        by_path.setdefault(r["path"], []).append(r)
    for path, rs in by_path.items():
        ok = sum(1 for r in rs if r["code"] == 0)
        fields = max(r["fields"] for r in rs)
        note = next((f"{r['code']}: {r['msg']}" for r in rs if r["code"] not in (0,)), "")
        print(f"{path:42}  {'yes' if path in KNOWN_USED else '   ':4}  {ok}/{len(rs):<7}  {fields:6}  {note[:60]}")
    (OUT_DIR / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
    print(f"\nraw replies: {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
