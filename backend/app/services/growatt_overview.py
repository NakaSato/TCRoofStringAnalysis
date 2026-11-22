"""Growatt analytics computed from persisted history (DB only, no Growatt calls).

Shared by the `/growatt/plants*` routes and the daily summary job so both report the
same numbers. Timestamps in the reading tables are plant-local (Thai) time. Values that
cannot be computed from stored data are `None` — no defaults are invented.
"""

from __future__ import annotations

import statistics
import threading
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from solar_core.sun import sun_times
from app.services import epi_fit, growatt_curtailment, growatt_meter, growatt_weather
from app.db.models import (
    GrowattInverter,
    GrowattInverterEnergyDay,
    GrowattPlant,
    GrowattPlantEnergyDay,
    GrowattPlantPower,
    inverter_installed,
)

from app.services.growatt_common import GrowattNotFound, INACTIVE_MAX_A, MAX_DC_AC_RATIO, MAX_GAP_H, R, S, SAMPLE_H, _bucket, _day_bounds, _expected_kw, _fmt_ts, _get_plant, _integrate_kwh, _latest_reading, _max, _mean, _round, capacity_check, inverter_out, newest_inverter_ts, plant_coords, plant_phase, plant_rated_ac_w, plausible_capacity_kwp  # noqa: F401 (re-export)
from app.services.growatt_layout import LAYOUT_SEEN_LOOKBACK, Layout, WIRED_CACHE_S, WIRED_LOOKBACK, _wired_cache, get_string_layout, load_layout, newest_string_ts, put_string_layout, wired_inputs  # noqa: F401 (re-export)
from app.services.growatt_strings import MAX_RANGE_DAYS, DEAD_LOOKBACK, DEAD_PEER_MIN_A, _classify_strings, _split_inactive, _synthesize_iv_pv_curve, build_string_detail  # noqa: F401 (re-export)
from app.services.growatt_inverter_history import MAX_TREND_DAYS, build_inverter_daily, build_inverter_raw, build_inverter_timeseries  # noqa: F401 (re-export)


def list_plants_summary(db: Session, plant_ids: Optional[Set[int]] = None) -> List[Dict[str, Any]]:
    """Plant registry from the DB, with inverter counts and energy from stored history.

    `total_energy_kwh` is the sum of each inverter's newest stored `eac_total`.
    `current_power_w` and `status` are realtime and always null here; the UI fills them from
    `/growatt/live/plants`. `plant_ids` limits the list (an engineer's assignments); None = all.
    """
    q = select(GrowattPlant).order_by(GrowattPlant.phase.is_(None), GrowattPlant.phase, GrowattPlant.plant_id)
    if plant_ids is not None:
        if not plant_ids:
            return []
        q = q.where(GrowattPlant.plant_id.in_(plant_ids))
    db_plants = list(db.scalars(q))

    rated_ac = plant_rated_ac_w(db)
    inv_counts: Dict[int, int] = {
        int(pid): int(cnt)
        for pid, cnt in db.execute(
            select(GrowattInverter.plant_id, func.count()).where(inverter_installed()).group_by(GrowattInverter.plant_id)
        )
    }

    # Per-inverter "newest record" lookups ride the (device_sn, timestamp) primary key: one short
    # index scan per inverter, instead of grouping the whole readings table on every request.
    inv = GrowattInverter
    inv_q = select(inv.plant_id, inv.device_sn).where(inverter_installed())
    if plant_ids is not None:
        inv_q = inv_q.where(inv.plant_id.in_(plant_ids))

    def newest(col, *where):
        return (
            select(col)
            .where(R.device_sn == inv.device_sn, col.is_not(None), *where)
            .order_by(R.device_sn.desc(), R.timestamp.desc())  # primary-key order, not ix_growatt_inv_ts
            .limit(1)
            .correlate(inv)
            .scalar_subquery()
        )

    def per_plant(value) -> Dict[int, float]:
        out: Dict[int, float] = {}
        for pid, _sn, v in db.execute(inv_q.add_columns(value)):
            if v is not None:
                out[int(pid)] = out.get(int(pid), 0.0) + float(v)
        return out

    latest = db.scalar(select(func.max(R.timestamp)))  # ix_growatt_inv_ts
    energy_date = latest.date() if latest else None
    day_energy: Dict[int, float] = {}
    if energy_date:
        start, end = _day_bounds(energy_date)
        # eac_today of each inverter's last record that day (see overview for why not MAX()).
        day_energy = per_plant(newest(R.eac_today_kwh, R.timestamp >= start, R.timestamp < end))

    # Lifetime energy: each inverter's newest stored eac_total counter, summed per plant.
    lifetime = per_plant(newest(R.eac_total_kwh))

    return [
        {
            "plant_id": p.plant_id,
            "phase": p.phase,
            "name": p.name,
            "city": p.city,
            "country": p.country,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "peak_power_kwp": plausible_capacity_kwp(p.peak_power_kwp, rated_ac.get(p.plant_id)),
            # Growatt's peak power when rejected as impossible for the plant's inverters
            "reported_peak_power_kwp": (
                p.peak_power_kwp
                if p.peak_power_kwp and plausible_capacity_kwp(p.peak_power_kwp, rated_ac.get(p.plant_id)) is None
                else None
            ),
            "current_power_w": None,  # realtime: /growatt/live/plants
            "today_energy_kwh": _round(day_energy.get(p.plant_id), 2),
            "energy_date": energy_date.isoformat() if energy_date and p.plant_id in day_energy else None,
            "total_energy_kwh": _round(lifetime.get(p.plant_id), 2),
            "inverter_count": inv_counts.get(p.plant_id, 0),
            "status": None,  # realtime: /growatt/live/plants
            "create_date": p.create_date,
            "synced_at": p.synced_at.isoformat() if p.synced_at else None,
        }
        for p in db_plants
    ]


# One computation of the full plant list at a time per database: concurrent page loads wait for
# it instead of each running the same queries (on the e2-micro, ten parallel copies of this
# exhausted the API's connection pool). Nothing is cached once the computation has finished.
_summary_lock = threading.Lock()
_summary_inflight: Dict[int, Dict[str, Any]] = {}
SUMMARY_WAIT_S = 120.0


def list_plants_summary_shared(db: Session, plant_ids: Optional[Set[int]] = None) -> List[Dict[str, Any]]:
    """`list_plants_summary` for every plant, shared by concurrent callers, then narrowed to
    `plant_ids` (None = all). A waiting caller first ends its transaction, so it does not hold a
    pooled connection while it waits."""
    if plant_ids is not None and not plant_ids:
        return []
    key = id(db.get_bind())
    with _summary_lock:
        entry = _summary_inflight.get(key)
        leader = entry is None
        if leader:
            entry = _summary_inflight[key] = {"done": threading.Event(), "rows": None}
    assert entry is not None
    if leader:
        try:
            entry["rows"] = list_plants_summary(db, None)
        finally:
            with _summary_lock:
                _summary_inflight.pop(key, None)
            entry["done"].set()
        rows = entry["rows"]
    else:
        db.rollback()  # read-only so far: give the connection back while waiting
        rows = entry["rows"] if entry["done"].wait(SUMMARY_WAIT_S) else None
        if rows is None:  # the shared run failed or took too long: compute our own
            rows = list_plants_summary(db, None)
    return rows if plant_ids is None else [p for p in rows if p["plant_id"] in plant_ids]


def list_inverters(db: Session, plant_id: int, include_not_installed: bool = False) -> List[Dict[str, Any]]:
    """The plant's inverters; those marked not installed only with `include_not_installed`."""
    q = select(GrowattInverter).where(GrowattInverter.plant_id == plant_id).order_by(GrowattInverter.device_sn)
    if not include_not_installed:
        q = q.where(inverter_installed())
    return [inverter_out(inv) for inv in db.scalars(q)]


def not_installed_inverters(db: Session, plant_id: int) -> List[Dict[str, Any]]:
    """The plant's inverters marked not installed (left out of every figure), newest mark first."""
    q = (
        select(GrowattInverter)
        .where(GrowattInverter.plant_id == plant_id, GrowattInverter.not_installed_at.is_not(None))
        .order_by(GrowattInverter.not_installed_at.desc(), GrowattInverter.device_sn)
    )
    return [inverter_out(inv) for inv in db.scalars(q)]


def _plant_curve(raw: Sequence[Any], cap_kwp: Optional[float]) -> List[Dict[str, Any]]:
    """The plant's 5-minute curve from stored records `(sn, ts, pac_w, ppv_w, temp, fac, eac)`,
    ordered by inverter then time (any number of days)."""
    out: List[Dict[str, Any]] = []
    # 5-minute plant curve, bucketed in Python (portable across SQLite / PostgreSQL).
    # Each inverter's samples are averaged within the slot first, then summed across
    # inverters, so 1-minute reporters are not counted five times.
    per_inv: Dict[Tuple[datetime, str], Dict[str, List[float]]] = {}
    for sn, ts, pac, ppv, temp, fac, _eac in raw:
        b = per_inv.setdefault((_bucket(ts), sn), {"pac": [], "ppv": [], "temp": [], "fac": []})
        b["pac"].append(pac or 0.0)
        b["ppv"].append(ppv or 0.0)
        if temp is not None and temp > 0:
            b["temp"].append(temp)
        if fac is not None and fac > 40:
            b["fac"].append(fac)
    buckets: Dict[datetime, Dict[str, List[float]]] = {}
    for (ts, _sn), b in per_inv.items():
        slot = buckets.setdefault(ts, {"pac": [], "ppv": [], "temp": [], "fac": [], "held": []})
        slot["pac"].append(statistics.mean(b["pac"]))
        slot["ppv"].append(statistics.mean(b["ppv"]))
        slot["temp"].extend(b["temp"])
        slot["fac"].extend(b["fac"])
    # Inverters report every 4-5 min, so a record often drifts past a slot edge and the slot
    # misses that inverter, making the plant sum dip. A missing inverter keeps its own last
    # slot value for up to MAX_GAP_H (as energy integration credits a reading), in slots that
    # exist anyway; never longer, never another inverter's value. `held` counts these.
    hold = timedelta(hours=MAX_GAP_H)
    last: Dict[str, Tuple[datetime, float, float]] = {}
    by_slot: Dict[datetime, Set[str]] = {}
    for t, sn in per_inv:
        by_slot.setdefault(t, set()).add(sn)
    for ts in sorted(buckets):
        for sn in by_slot[ts]:
            b = per_inv[(ts, sn)]
            last[sn] = (ts, statistics.mean(b["pac"]), statistics.mean(b["ppv"]))
        for sn, (t, pac, ppv) in last.items():
            if sn not in by_slot[ts] and ts - t <= hold:
                buckets[ts]["pac"].append(pac)
                buckets[ts]["ppv"].append(ppv)
                buckets[ts]["held"].append(1.0)
    for ts in sorted(buckets):
        b = buckets[ts]
        hr = ts.hour + ts.minute / 60.0
        expected_kw = _expected_kw(cap_kwp, hr)
        pac_kw = round(sum(b["pac"]) / 1000.0, 2)
        ppv_kw = round(sum(b["ppv"]) / 1000.0, 2)
        out.append(
            {
                "timestamp": _fmt_ts(ts),
                "pac_kw": pac_kw,
                "ppv_kw": ppv_kw,
                "expected_kw": expected_kw,
                "temp_c": _round(_mean(b["temp"]), 1),
                "freq_hz": _round(_mean(b["fac"]), 2),
                # inverters in the sum (measured + held); a sum over fewer than the plant has is low
                "inverters": len(b["pac"]),
                "held": len(b["held"]),
            }
        )
    return out


def _day_rate(db: Session, plant_id: int, day: Optional[date], timeseries: List[Dict[str, Any]]) -> float:
    """THB/kWh of the day's generation: each slot's tariff rate weighted by its AC power. With no
    generation: the rate at noon (so revenue of 0 kWh stays 0, and the tile still shows a rate)."""
    from app.services import tariff

    pr = tariff.pricer(db)
    pts: List[Tuple[datetime, float]] = []
    for r in timeseries:
        ts = r.get("timestamp")
        try:
            t = ts if isinstance(ts, datetime) else datetime.fromisoformat(str(ts))
        except ValueError:
            continue
        pts.append((t, float(r.get("pac_kw") or 0.0)))
    rate = pr.energy_weighted_rate(plant_id, pts)
    if rate is None:
        rate = pr.rate_at(plant_id, datetime.combine(day or date.today(), time(12, 0)))
    return round(rate, 4)


def _sensor_health(db: Session, plant_id: int, day: Optional[date]) -> Optional[Dict[str, Any]]:
    if day is None:
        return None
    from app.db.models import GrowattPlantDaily
    from app.services import growatt_rules

    v = growatt_rules.sensor_verdict(db.get(GrowattPlantDaily, (plant_id, day)), growatt_rules.rule_settings(db))
    return None if v is None else {"ok": v["ok"], "flags": v["flags"], "reasons": v["reasons"]}


DEFAULT_SUNRISE = time(6, 0)


def _documents(db: Session, plant_id: int) -> Dict[str, Any]:
    """{kind: {url, title, revision}} of the plant's document links (Drive), {} when none."""
    from app.services import plant_documents  # local: plant_documents imports the models only

    return {k: {"url": d["url"], "title": d["title"], "revision": d["revision"]} for k, d in plant_documents.for_plant(db, plant_id).items()}


def _sunrise(plant: GrowattPlant, day: date) -> datetime:
    """Plant-local sunrise of `day` (NOAA, from the plant's coordinates), else 06:00."""
    if plant.latitude is not None and plant.longitude is not None:
        st = sun_times(day, float(plant.latitude), float(plant.longitude), 7.0)
        if st:
            return st[0]
    return datetime.combine(day, DEFAULT_SUNRISE)


def build_plant_overview(db: Session, plant_id: int, day: Optional[date] = None) -> Dict[str, Any]:
    """Single-plant overview for one day (default: latest day with data)."""
    """Single-plant overview for one day from persisted max_data history.

    Values that cannot be computed from stored data are `null` (no defaults are invented).
    """
    plant = _get_plant(db, plant_id)
    inverters = list(
        db.scalars(
            select(GrowattInverter)
            .where(GrowattInverter.plant_id == plant_id, inverter_installed())
            .order_by(GrowattInverter.device_sn)
        )
    )
    sns = [inv.device_sn for inv in inverters]
    cap_kwp, rejected_kwp = capacity_check(db, plant)
    inv_cap_kwp = cap_kwp / len(sns) if cap_kwp and sns else None

    data_until = _latest_reading(db, sns)
    if day is None and data_until is not None:
        day = data_until.date()
        # the newest day holds only night records (just after midnight, or the sync stopped
        # overnight): open the last day with records before it instead of an all-dark day. A day
        # past sunrise stays, so inverters reading 0 W all morning still show as today's fault.
        if data_until < _sunrise(plant, day):
            prev = newest_inverter_ts(db, sns, before=_day_bounds(day)[0])
            if prev is not None:
                day, data_until = prev.date(), prev

    inv_metrics: Dict[str, Dict[str, Any]] = {}
    latest_mppt: Dict[str, Dict[str, Any]] = {}
    timeseries: List[Dict[str, Any]] = []
    string_aggs: List[Dict[str, Any]] = []
    inactive_strings: List[Dict[str, Any]] = []

    if sns and day is not None:
        start, end = _day_bounds(day)
        in_day = (R.device_sn.in_(sns), R.timestamp >= start, R.timestamp < end)

        raw = db.execute(
            select(R.device_sn, R.timestamp, R.pac_w, R.ppv_w, R.temperature_c, R.fac_hz, R.eac_today_kwh)
            .where(*in_day)
            .order_by(R.device_sn, R.timestamp)
        ).all()
        by_sn: Dict[str, List[Any]] = {}
        for r in raw:
            by_sn.setdefault(r[0], []).append(r)

        # 1. Per-inverter aggregates
        agg = db.execute(
            select(
                R.device_sn,
                func.max(R.pac_w),
                func.max(R.ppv_w),
                func.max(R.eac_total_kwh),
                func.avg(case((R.pac_w > 0, R.temperature_c), else_=None)),
                func.max(R.temperature_c),
                func.avg(case((R.fac_hz > 40, R.fac_hz), else_=None)),
            )
            .where(*in_day)
            .group_by(R.device_sn)
        ).all()
        for sn, pac_max, ppv_max, eac_total, t_avg, t_max, f_avg in agg:
            rows_sn = by_sn.get(sn, [])
            # eac_today from the day's last record: the counter carries yesterday's total for
            # a few minutes after midnight, so MAX() would pick the stale value.
            eac_today = next((r[6] for r in reversed(rows_sn) if r[6] is not None), None)
            ac_kwh = _integrate_kwh((r[1], r[2]) for r in rows_sn)
            dc_kwh = _integrate_kwh((r[1], r[3]) for r in rows_sn)
            inv_metrics[sn] = {
                "peak_ac_kw": _round(pac_max / 1000.0, 2) if pac_max is not None else None,
                "peak_dc_kw": _round(ppv_max / 1000.0, 2) if ppv_max is not None else None,
                "period_energy_kwh": round(ac_kwh, 2),
                "dc_energy_kwh": round(dc_kwh, 2),
                "yield_today_kwh": _round(eac_today if eac_today is not None else ac_kwh, 2),
                "total_yield_kwh": _round(eac_total, 2),
                "avg_temp_c": _round(t_avg, 1),
                "max_temp_c": _round(t_max, 1),
                "avg_freq_hz": _round(f_avg, 2),
                "efficiency_pct": round(ac_kwh / dc_kwh * 100.0, 2) if dc_kwh > 0 else None,
            }

        # Latest producing record per inverter (MPPT snapshot)
        latest_ts = (
            select(R.device_sn, func.max(R.timestamp).label("ts")).where(*in_day, R.pac_w > 0).group_by(R.device_sn)
        ).subquery()
        for sn, pac, mppt in db.execute(
            select(R.device_sn, R.pac_w, R.mppt_json).join(
                latest_ts, (R.device_sn == latest_ts.c.device_sn) & (R.timestamp == latest_ts.c.ts)
            )
        ):
            latest_mppt[sn] = {"latest_pac_kw": _round((pac or 0.0) / 1000.0, 2), "mppt_json": mppt or []}

        timeseries = _plant_curve(raw, cap_kwp)

        # 2. Per-string aggregates
        mppt_max: Dict[str, int] = {}
        idle: Dict[Tuple[str, int], Dict[str, Any]] = {}
        s_in_day = (S.device_sn.in_(sns), S.timestamp >= start, S.timestamp < end)
        str_series: Dict[Tuple[str, int], List[Tuple[datetime, float]]] = {}
        for sn, sno, ts, p in db.execute(
            select(S.device_sn, S.string_no, S.timestamp, S.power_w).where(*s_in_day).order_by(
                S.device_sn, S.string_no, S.timestamp
            )
        ):
            str_series.setdefault((sn, int(sno)), []).append((ts, p))
        for sn, sno, mppt_no, n, v_avg, v_max, i_avg, i_max, p_max in db.execute(
            select(
                S.device_sn,
                S.string_no,
                S.mppt_no,
                func.count(),
                func.avg(S.voltage_v),
                func.max(S.voltage_v),
                func.avg(S.current_a),
                func.max(S.current_a),
                func.max(S.power_w),
            )
            .where(*s_in_day)
            .group_by(S.device_sn, S.string_no, S.mppt_no)
            .order_by(S.device_sn, S.string_no)
        ):
            mppt_max[sn] = max(mppt_max.get(sn, 0), int(mppt_no))
            if float(i_max or 0.0) <= INACTIVE_MAX_A:
                idle[(sn, int(sno))] = {"mppt_no": int(mppt_no), "v_max": round(float(v_max or 0.0), 1)}
                continue
            string_aggs.append(
                {
                    "device_sn": sn,
                    "string_no": int(sno),
                    "mppt_no": int(mppt_no),
                    "samples": int(n),
                    "v_avg": round(float(v_avg or 0.0), 1),
                    "v_max": round(float(v_max or 0.0), 1),
                    "i_avg": round(float(i_avg or 0.0), 2),
                    "i_max": round(float(i_max or 0.0), 2),
                    "p_max_w": round(float(p_max or 0.0), 1),
                    "energy_kwh": round(_integrate_kwh(str_series.get((sn, int(sno)), [])), 2),
                }
            )

        dead, inactive_strings = _split_inactive(db, string_aggs, idle, mppt_max, start)
        string_aggs.extend(dead)
        string_aggs.sort(key=lambda x: (x["device_sn"], x["string_no"]))

    layout = load_layout(db, sns)
    strings_summary, anomalies, inv_string_counts, inv_pr_list = _classify_strings(string_aggs, inv_cap_kwp, layout)

    # 3. Inverter list
    inverters_out: List[Dict[str, Any]] = []
    for inv in inverters:
        sn = inv.device_sn
        m = inv_metrics.get(sn, {})
        mppt_info = latest_mppt.get(sn, {})
        yield_kwh = m.get("yield_today_kwh")
        dc_kwh = m.get("dc_energy_kwh")
        yf_inv = round(yield_kwh / inv_cap_kwp, 2) if yield_kwh is not None and inv_cap_kwp else None
        ya_inv = round(dc_kwh / inv_cap_kwp, 2) if dc_kwh is not None and inv_cap_kwp else None
        ya_minus_yf_inv = (
            round((dc_kwh - yield_kwh) / inv_cap_kwp, 3)
            if dc_kwh is not None and yield_kwh is not None and inv_cap_kwp and dc_kwh >= yield_kwh
            else None
        )
        inverters_out.append(
            {
                **inverter_out(inv),
                "model": inv.model or "",
                "capacity_kwp": _round(inv_cap_kwp, 2),
                "current_ac_kw": mppt_info.get("latest_pac_kw"),
                "peak_ac_kw": m.get("peak_ac_kw"),
                "peak_dc_kw": m.get("peak_dc_kw"),
                "yield_today_kwh": yield_kwh,
                "period_energy_kwh": m.get("period_energy_kwh"),
                "dc_energy_kwh": dc_kwh,
                "total_yield_kwh": m.get("total_yield_kwh"),
                "specific_yield": yf_inv,
                "ya_kwh_kwp": ya_inv,
                "ya_minus_yf": ya_minus_yf_inv,
                "efficiency_pct": m.get("efficiency_pct"),
                "pr_pct": _round(_mean(inv_pr_list.get(sn, [])), 1),
                "avg_temp_c": m.get("avg_temp_c"),
                "max_temp_c": m.get("max_temp_c"),
                "avg_freq_hz": m.get("avg_freq_hz"),
                "string_count": inv_string_counts.get(sn, 0),
                "mppt_latest": mppt_info.get("mppt_json") or [],
            }
        )

    # 4. Plant KPIs
    healthy_cnt = sum(1 for s in strings_summary if s["status"] == "Healthy")
    warning_cnt = sum(1 for s in strings_summary if s["status"] == "Warning")
    critical_cnt = sum(1 for s in strings_summary if s["status"] == "Critical")

    plant_pr_pct = _round(_mean(s["pr_pct"] for s in strings_summary), 1)
    avg_health = _round(_mean(s["health_score"] for s in strings_summary), 1)
    inv_yields = [i["yield_today_kwh"] for i in inverters_out if i["yield_today_kwh"] is not None]
    yield_today_kwh = round(sum(inv_yields), 2) if inv_yields else None
    inv_dc_yields = [i["dc_energy_kwh"] for i in inverters_out if i.get("dc_energy_kwh") is not None]
    dc_yield_today_kwh = round(sum(inv_dc_yields), 2) if inv_dc_yields else None
    yf_kwh_kwp = round(yield_today_kwh / cap_kwp, 2) if yield_today_kwh is not None and cap_kwp else None
    ya_kwh_kwp = round(dc_yield_today_kwh / cap_kwp, 2) if dc_yield_today_kwh is not None and cap_kwp else None
    ya_minus_yf = (
        round((dc_yield_today_kwh - yield_today_kwh) / cap_kwp, 3)
        if dc_yield_today_kwh is not None and yield_today_kwh is not None and cap_kwp and dc_yield_today_kwh >= yield_today_kwh
        else None
    )
    inv_totals = [i["total_yield_kwh"] for i in inverters_out if i["total_yield_kwh"] is not None]
    total_yield_kwh = _round(sum(inv_totals) if inv_totals else None, 2)
    peak_power_kw = _round(_max(r["pac_kw"] for r in timeseries), 2)
    avg_temp_c = _round(_mean(i["avg_temp_c"] for i in inverters_out), 1)
    max_temp_c = _round(_max(i["max_temp_c"] for i in inverters_out), 1)
    avg_freq_hz = _round(_mean(i["avg_freq_hz"] for i in inverters_out), 2)
    avg_eff_pct = _round(_mean(i["efficiency_pct"] for i in inverters_out), 2)

    from app.services import fleet_settings

    mod = fleet_settings.get_fleet_module(db)
    gamma_pct = float(mod.get("temp_coeff_pmax_pct") or growatt_weather.DEFAULT_GAMMA_PCT_PER_K)

    # Energy meter at the grid connection point: grid import / export measured, load derived.
    # Meter slots without an inverter record (night) become rows with PV null, so every reader
    # of `timeseries` below treats a null pac_kw as "no inverter record", never as 0.
    grid_energy: Dict[str, Optional[float]] = {"grid_import_kwh": None, "grid_export_kwh": None, "load_kwh": None}
    if day is not None:
        m_start, m_end = _day_bounds(day)
        has_meter, gslots = growatt_meter.meter_slots(db, plant_id, m_start, m_end)
        growatt_meter.attach_grid(timeseries, gslots, cap_kwp)
        if gslots:
            grid_energy = growatt_meter.day_energy(db, plant_id, m_start, m_end, timeseries)
    else:  # no inverter record yet: the meter is still reported, its figures stay null
        has_meter = bool(growatt_meter.plant_meters(db, plant_id))
    # Weather sensor (measured irradiance / temperatures) for the same day, merged onto the
    # 5-minute curve, and the IEC 61724-1 PR it allows. Null where the plant has no sensor.
    weather = growatt_weather.build_weather_day(db, plant_id, day, latest_if_none=False)
    wx_by_ts = {p["timestamp"]: p for p in weather["series"]}
    for r in timeseries:
        wx = wx_by_ts.get(r["timestamp"]) or {}
        r["irradiance_wm2"] = wx.get("irradiance_wm2")  # measured, plane of array
        r["module_temp_c"] = wx.get("module_temp_c")
        r["ambient_temp_c"] = wx.get("ambient_temp_c")
    pr = growatt_weather.iec_pr(
        yield_today_kwh, cap_kwp, weather, [r["timestamp"] for r in timeseries if (r["pac_kw"] or 0) > 0], gamma_pct
    )
    wk = weather["kpis"]

    # EPI (Energy Performance Index = measured AC energy / modelled AC energy from POA & T_mod)
    # over POA-filtered (200-1200 W/m²), non-stale, non-clipped slots.
    epi: Optional[float] = None
    epi_factor = epi_fit.factor_info(db, plant_id)  # the plant's fitted model factor, else the default
    if pr["pr_pct"] is not None and cap_kwp:
        stale_ts = growatt_weather._stale_timestamps(weather["series"], "irradiance_wm2")
        rated_ac_kw = (plant_rated_ac_w(db, [plant_id]).get(plant_id) or 0.0) / 1000.0
        meas_kw_sum = 0.0
        mod_kw_sum = 0.0
        valid_epi_slots = 0
        fallback_tmod = wk.get("irradiance_weighted_module_temp_c") or wk.get("avg_module_temp_daylight_c")
        for r in timeseries:
            ts_str = r["timestamp"]
            g = r.get("irradiance_wm2")
            pac_kw = r.get("pac_kw")
            if (
                g is None
                or pac_kw is None  # no inverter record in this slot
                or ts_str in stale_ts
                or not (growatt_weather.POA_FILTER_MIN_WM2 <= g <= growatt_weather.POA_FILTER_MAX_WM2)
                or (rated_ac_kw > 0 and pac_kw >= 0.98 * rated_ac_kw)
            ):
                continue
            t_mod = r.get("module_temp_c")
            if t_mod is None:
                t_mod = fallback_tmod  # the day's measured (irradiance-weighted) module temperature
            if t_mod is None:
                continue  # no module temperature measured at all: the slot cannot be modelled
            temp_factor = max(0.5, 1.0 + (gamma_pct / 100.0) * (float(t_mod) - 25.0))
            p_mod_kw = cap_kwp * (float(g) / 1000.0) * temp_factor * epi_factor["factor"]
            if p_mod_kw > 0:
                meas_kw_sum += pac_kw
                mod_kw_sum += p_mod_kw
                valid_epi_slots += 1
        if valid_epi_slots >= 3 and mod_kw_sum > 0:
            epi = round(meas_kw_sum / mod_kw_sum, 3)
    pr["epi"] = epi

    # Curtailment per slot (estimated): the modelled available power where the AC is held below
    # it by a zero-export meter or the power-limit setting (services/growatt_curtailment.py)
    c_invs = growatt_curtailment.inverters(db, plant_id)
    curtailment = growatt_curtailment.annotate(
        timeseries,
        kwp=cap_kwp,
        rated_ac_kw=(plant_rated_ac_w(db, [plant_id]).get(plant_id) or 0.0) / 1000.0 or None,
        limit_kw=growatt_curtailment.plant_limit_kw(c_invs),
        gamma_pct=gamma_pct,
        factor=float(epi_factor["factor"]),
        inverter_count=len(c_invs),
        stale=growatt_weather._stale_timestamps(weather["series"], "irradiance_wm2"),
        tmod_fallback={day.isoformat(): wk.get("irradiance_weighted_module_temp_c") or wk.get("avg_module_temp_daylight_c")} if day else None,
    )

    # Loss waterfall — a modelled breakdown; only built when every input is measured. With a
    # weather sensor the reference is the measured POA insolation × kWp (IEC reference yield)
    # and thermal derating uses the measured module temperature.
    loss_waterfall: List[Dict[str, Any]] = []
    insolation: Optional[float] = wk["insolation_kwh_m2"]
    reference_kwh = (
        round(cap_kwp * insolation, 1) if pr["pr_pct"] is not None and cap_kwp and insolation else None
    )
    reference_measured = reference_kwh is not None
    module_temp_c = wk["avg_module_temp_daylight_c"] if reference_measured else None
    if yield_today_kwh and (reference_measured or plant_pr_pct) and avg_temp_c is not None and avg_eff_pct is not None:
        if reference_kwh is not None:
            nominal_dc_kwh = reference_kwh
        else:
            nominal_dc_kwh = round(yield_today_kwh / max(0.65, (plant_pr_pct or 0.0) / 100.0), 1)
        cell_temp_c = module_temp_c if module_temp_c is not None else avg_temp_c
        thermal_loss_kwh = round(nominal_dc_kwh * max(0.015, (cell_temp_c - 25.0) * 0.0034), 1)
        mismatch_loss_kwh = round(sum(s["energy_loss_kwh"] or 0.0 for s in strings_summary), 1)
        conv_loss_kwh = round(yield_today_kwh * max(0.0, 100.0 - avg_eff_pct) / 100.0, 1)
        optical_loss_kwh = round(
            max(0.0, nominal_dc_kwh - yield_today_kwh - thermal_loss_kwh - mismatch_loss_kwh - conv_loss_kwh), 1
        )
        loss_waterfall = [
            {
                "stage": "POA Insolation × kWp (measured)" if reference_measured else "Nominal DC Reference",
                "kwh": nominal_dc_kwh,
                "type": "base",
            },
            {"stage": "Optical & Soiling Loss", "kwh": -optical_loss_kwh, "type": "loss"},
            {"stage": "Thermal Derating Loss", "kwh": -thermal_loss_kwh, "type": "loss"},
            {"stage": "String & MPPT Mismatch", "kwh": -mismatch_loss_kwh, "type": "loss"},
            {"stage": "Inverter Conversion Loss", "kwh": -conv_loss_kwh, "type": "loss"},
            {"stage": "Net AC Grid Export", "kwh": yield_today_kwh, "type": "net"},
        ]

    return {
        "meta": {
            "source": "db",
            "day": day.isoformat() if day else None,
            "data_until": _fmt_ts(data_until),
            "synced_at": plant.synced_at.isoformat() if plant.synced_at else None,
        },
        "plant": {
            "plant_id": plant.plant_id,
            "name": plant.name,
            "city": plant.city,
            "country": plant.country,
            "latitude": plant.latitude,
            "longitude": plant.longitude,
            "peak_power_kwp": cap_kwp,
            "reported_peak_power_kwp": rejected_kwp,
            "current_power_w": None,  # realtime: the UI overlays /growatt/live/*
            "total_energy_kwh": total_yield_kwh,
            "status": None,  # realtime: the UI overlays /growatt/live/plants
            "create_date": plant.create_date,
            # from Growatt `plant/details` (registry, weekly)
            "timezone": plant.timezone,
            "address": plant.address,
            "growatt_inverter_count": plant.growatt_inverter_count,
            "growatt_datalogger_count": plant.growatt_datalogger_count,
            # as-built PDF / site photo links on Google Drive (plant_documents; links only)
            "documents": _documents(db, plant.plant_id),
        },
        "kpis": {
            "capacity_kwp": cap_kwp,
            "current_power_kw": None,  # realtime: the UI overlays /growatt/live/*
            "peak_power_kw": peak_power_kw,
            "yield_today_kwh": yield_today_kwh,
            "dc_yield_today_kwh": dc_yield_today_kwh,
            "total_yield_kwh": total_yield_kwh,
            "specific_yield_kwh_per_kwp": yf_kwh_kwp,
            "ya_kwh_kwp": ya_kwh_kwp,
            "ya_minus_yf": ya_minus_yf,
            # peer-relative string index (not IEC: compares strings with each other)
            "plant_pr_pct": plant_pr_pct,
            # IEC 61724-1 PR from the weather sensor's measured irradiance (null without one)
            "iec_pr_pct": pr["pr_pct"],
            "iec_pr_temp_corrected_pct": pr.get("pr_temp_corrected_pct"),
            "epi": epi,
            # the model's system factor behind `epi` (modelled): fitted per plant, or the default
            "epi_factor": epi_factor,
            # curtailed energy of the day (estimated) with what it rests on; per slot in `timeseries`
            "curtailment": curtailment,
            # R16 verdict on the day's stored sensor evidence (null = not computed / no irradiance);
            # ok false = the IEC PR, PR' and EPI above rest on a suspect sensor
            "sensor_health": _sensor_health(db, plant_id, day),
            "insolation_kwh_m2": wk["insolation_kwh_m2"],
            "peak_irradiance_wm2": wk["peak_irradiance_wm2"],
            "avg_module_temp_c": wk["avg_module_temp_daylight_c"],
            "irradiance_weighted_module_temp_c": wk.get("irradiance_weighted_module_temp_c"),
            "avg_ambient_temp_c": wk["avg_ambient_temp_c"],
            "target_pr_pct": 85.0,
            "conversion_efficiency_pct": avg_eff_pct,
            "avg_temp_c": avg_temp_c,
            "max_temp_c": max_temp_c,
            "avg_freq_hz": avg_freq_hz,
            "inverter_count": len(inverters_out),
            "online_inverters": None,  # realtime: the UI counts live inverter status
            "string_count": len(strings_summary),
            "healthy_strings": healthy_cnt,
            "warning_strings": warning_cnt,
            "critical_strings": critical_cnt,
            "inactive_strings": len(inactive_strings),
            # strings whose module count is in the registry / compared per module with peers
            "strings_with_module_count": sum(1 for s in strings_summary if s["modules"] is not None),
            "strings_normalized": sum(1 for s in strings_summary if s["peer_basis"] != "raw"),
            "avg_health_score": avg_health,
            # the day's generation priced slot by slot with the tariff (TOU + Ft, or the plant's flat rate)
            "tariff_thb_per_kwh": _day_rate(db, plant_id, day, timeseries),
            # energy meter (grid connection point): import / export measured, load = PV + grid (derived)
            "has_meter": has_meter,
            **grid_energy,
        },
        "inverters": inverters_out,
        # listed in Growatt but marked not installed: in no figure above
        "not_installed_inverters": not_installed_inverters(db, plant_id),
        "timeseries": timeseries,
        "weather": {
            "has_sensor": weather["has_sensor"],
            "sensors": weather["sensors"],
            "data_until": weather["meta"]["data_until"],
            "kpis": wk,
            "iec_pr": pr,
            # sensor reading at the daily check times 09/13/17 (None = no reading near that time)
            "check_slots": growatt_weather.check_slots(weather["series"], day),
        },
        "loss_waterfall": loss_waterfall,
        "strings": strings_summary,
        # String inputs with no current today (unused inputs, or no light yet). Kept out of
        # `strings` so KPIs and diagnostics only cover connected strings.
        "inactive_strings": inactive_strings,
        "anomalies": anomalies[:40],
    }


MAX_GROWATT_KWH_PER_KWP_DAY = 10.0  # Thailand's best days are ≈ 5–6 kWh/kWp; above this is a Growatt glitch


def build_plant_power(
    db: Session,
    plant_id: int,
    day: date,
    end_day: Optional[date] = None,
    start_time: Optional[time] = None,
    end_time: Optional[time] = None,
    include_records: bool = True,
) -> Dict[str, Any]:
    """The plant's stored 5-minute AC / DC curve for `day`..`end_day` (both inclusive, at most
    MAX_RANGE_DAYS), optionally narrowed to a plant-local time-of-day window on every day. DB only.
    `daily` = each day's AC energy integrated from the records (null for a day with none).
    `include_records=False`: only Growatt's own figures (curve, daily kWh); `timeseries` is empty
    and `energy_kwh` null (a page that already holds the day's overview)."""
    plant = _get_plant(db, plant_id)
    last_day = end_day if end_day is not None and end_day > day else day
    if (last_day - day).days + 1 > MAX_RANGE_DAYS:
        raise ValueError(f"A day range covers at most {MAX_RANGE_DAYS} days")
    sns = list(db.scalars(select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id, inverter_installed())))
    cap_kwp, _ = capacity_check(db, plant)
    rated_w = plant_rated_ac_w(db, [plant_id]).get(plant_id)
    raw: List[Any] = []
    if sns and include_records:
        start, _ = _day_bounds(day)
        _, end = _day_bounds(last_day)
        raw = list(
            db.execute(
                select(R.device_sn, R.timestamp, R.pac_w, R.ppv_w, R.temperature_c, R.fac_hz, R.eac_today_kwh)
                .where(R.device_sn.in_(sns), R.timestamp >= start, R.timestamp < end)
                .order_by(R.device_sn, R.timestamp)
            ).all()
        )
    raw_all = raw  # the whole days: the curve is built and the meter attached on these, then windowed
    if start_time is not None or end_time is not None:
        lo = start_time or time.min
        hi = end_time or time.max
        # inclusive 5-min slots: a record at 10:04 belongs to the 10:00 slot
        raw = [r for r in raw if lo <= _bucket(r[1]).time() <= hi]
    per_day: Dict[date, Dict[str, List[Tuple[datetime, Any]]]] = {}
    for r in raw:
        per_day.setdefault(r[1].date(), {}).setdefault(r[0], []).append((r[1], r[2]))
    g_start, _ = _day_bounds(day)
    _, g_end = _day_bounds(last_day)
    g_raw = [
        (ts, w)
        for ts, w in db.execute(
            select(GrowattPlantPower.timestamp, GrowattPlantPower.power_w)
            .where(GrowattPlantPower.plant_id == plant_id, GrowattPlantPower.timestamp >= g_start, GrowattPlantPower.timestamp < g_end)
            .order_by(GrowattPlantPower.timestamp)
        ).all()
        if start_time is None and end_time is None
        or (start_time or time.min) <= ts.time() <= (end_time or time.max)
    ]
    g_energy = dict(
        db.execute(
            select(GrowattPlantEnergyDay.day, GrowattPlantEnergyDay.energy_kwh).where(
                GrowattPlantEnergyDay.plant_id == plant_id, GrowattPlantEnergyDay.day >= day, GrowattPlantEnergyDay.day <= last_day
            )
        ).all()
    )
    g_inv: Dict[date, Tuple[float, int]] = {}
    for d_, kwh, n in db.execute(
        select(GrowattInverterEnergyDay.day, func.sum(GrowattInverterEnergyDay.energy_kwh), func.count(GrowattInverterEnergyDay.energy_kwh))
        .where(GrowattInverterEnergyDay.plant_id == plant_id, GrowattInverterEnergyDay.day >= day, GrowattInverterEnergyDay.day <= last_day)
        .group_by(GrowattInverterEnergyDay.day)
    ).all():
        if n and kwh is not None:
            g_inv[d_] = (float(kwh), int(n))
    # Growatt's day figures are stored as reported but only shown when physically possible:
    # e.g. two serials of one plant answered 22,259 kWh each for 13 Nov 2026 (≈ 71 kWh/kWp)
    max_day_kwh = cap_kwp * MAX_GROWATT_KWH_PER_KWP_DAY if cap_kwp else None

    def plausible(v: Optional[float]) -> Optional[float]:
        return None if v is None or (max_day_kwh is not None and v > max_day_kwh) else v

    daily = []
    d = day
    while d <= last_day:
        inv = per_day.get(d)
        gi = g_inv.get(d)
        g_raw_day, gi_raw = g_energy.get(d), gi[0] if gi else None
        daily.append(
            {
                "day": d.isoformat(),
                "energy_kwh": round(sum(_integrate_kwh(v) for v in inv.values()), 2) if inv else None,
                # Growatt's own figures for the day (finished days only; null = not read)
                "growatt_energy_kwh": _round(plausible(g_raw_day), 2),
                "growatt_inverters_kwh": _round(plausible(gi_raw), 2),
                "growatt_inverters_reported": gi[1] if gi else 0,
                # a Growatt figure above MAX_GROWATT_KWH_PER_KWP_DAY × kWp was withheld (shown as null)
                "growatt_implausible": plausible(g_raw_day) != g_raw_day or plausible(gi_raw) != gi_raw,
            }
        )
        d += timedelta(days=1)
    # built on the whole days and windowed after the meter is attached: a meter-only row's load
    # depends on the day's first / last inverter record, which a window may cut off
    curve = _plant_curve(raw_all, cap_kwp)
    has_meter, gslots = growatt_meter.meter_slots(db, plant_id, g_start, g_end)
    if not include_records:
        gslots = {}
    growatt_meter.attach_grid(curve, gslots, cap_kwp)
    windowed = start_time is not None or end_time is not None
    if windowed:
        w_lo, w_hi = (start_time or time.min).strftime("%H:%M:%S"), (end_time or time.max).strftime("%H:%M:%S")
        curve = [r for r in curve if w_lo <= r["timestamp"][11:] <= w_hi]
        gslots = {k: v for k, v in gslots.items() if w_lo <= k[11:] <= w_hi}
    # the period's grid / load energy, integrated like a whole day's (the import counter only
    # without a time window: its span is the whole days')
    grid_energy: Dict[str, Optional[float]] = {"grid_import_kwh": None, "grid_export_kwh": None, "load_kwh": None}
    if gslots:
        grid_energy = growatt_meter.day_energy(db, plant_id, g_start, g_end, curve, use_counter=not windowed)
    # Weather sensor POA irradiance (measured) per slot, built day by day as the day view does,
    # so a probe stuck at 0 all day counts as not measured. Null where the plant has no sensor.
    irr: Dict[str, Optional[float]] = {}
    tmod: Dict[str, Optional[float]] = {}
    stale: Set[str] = set()
    tmod_day: Dict[str, Optional[float]] = {}
    if growatt_weather.plant_sensors(db, plant_id):
        d = day
        while d <= last_day:
            wday = growatt_weather.build_weather_day(db, plant_id, d, latest_if_none=False)
            for p in wday["series"]:
                irr[p["timestamp"]] = p["irradiance_wm2"]
                tmod[p["timestamp"]] = p.get("module_temp_c")
            stale |= set(growatt_weather._stale_timestamps(wday["series"], "irradiance_wm2"))
            wk = wday["kpis"]
            tmod_day[d.isoformat()] = wk.get("irradiance_weighted_module_temp_c") or wk.get("avg_module_temp_daylight_c")
            d += timedelta(days=1)
    for r in curve:
        r["irradiance_wm2"] = irr.get(r["timestamp"])
        r["module_temp_c"] = tmod.get(r["timestamp"])
    # curtailment per slot and day (estimated; services/growatt_curtailment.py)
    from app.services import fleet_settings

    c_invs = growatt_curtailment.inverters(db, plant_id)
    gamma_pct = float(fleet_settings.get_fleet_module(db).get("temp_coeff_pmax_pct") or growatt_weather.DEFAULT_GAMMA_PCT_PER_K)
    curtailment = growatt_curtailment.annotate(
        curve,
        kwp=cap_kwp,
        rated_ac_kw=rated_w / 1000.0 if rated_w else None,
        limit_kw=growatt_curtailment.plant_limit_kw(c_invs),
        gamma_pct=gamma_pct,
        factor=float(epi_fit.factor_info(db, plant_id)["factor"]),
        inverter_count=len(c_invs),
        stale=stale,
        tmod_fallback=tmod_day,
    )
    c_days = growatt_curtailment.per_day(curve)
    for row in daily:
        row["curtailed_kwh"] = c_days.get(row["day"])
    return {
        "meta": {
            "source": "db",
            "day": day.isoformat(),
            "end_day": last_day.isoformat(),
            "window": [start_time.strftime("%H:%M") if start_time else None, end_time.strftime("%H:%M") if end_time else None],
        },
        "plant_id": plant_id,
        "inverter_count": len(sns),
        "rated_ac_kw": _round(rated_w / 1000.0, 1) if rated_w else None,
        "timeseries": curve,
        "has_meter": has_meter,
        **grid_energy,
        # curtailed energy of the period (estimated); per slot in `timeseries`, per day in `daily`
        "curtailment": curtailment,
        # Growatt's own 5-minute plant AC curve (`plant/power`, stored for finished days)
        "growatt_timeseries": [{"timestamp": _fmt_ts(ts), "pac_kw": round(w / 1000.0, 2)} for ts, w in g_raw],
        "daily": daily,
    }
