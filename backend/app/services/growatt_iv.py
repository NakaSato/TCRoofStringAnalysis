"""I-V curve sweep service (DB only): ingests string and module I-V sweeps, translates to STC via
IEC 60891 Procedure 1 (cross-checked with Procedures 2, 4 and the dynamic procedure), extracts parameters, classifies fault signatures, and marks a string as a
candidate for module-level testing when it is below warranted power and a second source agrees
(IR, or a time-series issue in `growatt_issues`). A string sweep alone is not warranty evidence.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from statistics import median
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattIssue, GrowattIvSweep, GrowattPlant
from app.services import fleet_settings, growatt_issues
from app.services.growatt_common import GrowattNotFound, _get_plant
from app.services.growatt_layout import load_layout
from solar_core.iv_site_fit import fit_site_coefficients
from solar_core.iv_analysis import (
    DEFAULT_DEAD_BAND_PCT,
    ModuleStcSpec,
    analyze_iv_sweep,
    parse_iv_csv,
)


def _parse_swept_at(raw: str) -> datetime:
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1]
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as exc:
        raise ValueError(f"Invalid swept_at timestamp {raw!r}; use YYYY-MM-DD HH:MM:SS") from exc
    return dt.replace(tzinfo=None)


def _plant_age_years(plant: GrowattPlant, on_day: date) -> float:
    if not plant.create_date:
        return 0.0
    try:
        created = date.fromisoformat(str(plant.create_date)[:10])
    except ValueError:
        return 0.0
    return max(0.0, (on_day - created).days / 365.25)


def _has_timeseries_trend(db: Session, plant_id: int, device_sn: Optional[str], string_no: Optional[int]) -> bool:
    """True when the string has an active time-series degradation/drift/underperformance issue
    (R5, R6, R1, or R4) in `growatt_issues` — the second source for a module-test candidate."""
    if not device_sn or string_no is None:
        return False
    hit = db.scalar(
        select(GrowattIssue.id)
        .where(
            GrowattIssue.plant_id == plant_id,
            GrowattIssue.device_sn == device_sn,
            GrowattIssue.string_no == string_no,
            GrowattIssue.status.in_(growatt_issues.ACTIVE),
            GrowattIssue.rule.in_(("R1", "R4", "R5", "R6")),
        )
        .limit(1)
    )
    return hit is not None


# Same-time peer and own-baseline comparison (computed on read, never stored: the peers of a sweep
# are often uploaded after it). The flag levels are proposed defaults that need site calibration
# (repeat sweeps on healthy strings), so they only mark a sweep and never open a ticket.
PEER_WINDOW_MIN = 30  # strings of one inverter swept within this many minutes are peers
PEER_MIN = 2  # fewer peers = no peer verdict
PEER_PMAX_FLAG = 0.97
PEER_ISC_FLAG = 0.98
PEER_FF_FLAG = 0.97
BASELINE_PMAX_FLAG = 0.97
BASELINE_ROC_FLAG = 1.20  # slope near Voc (series resistance indicator) vs baseline
BASELINE_RSC_FLAG = 0.50  # slope near Isc (shunt resistance indicator) vs baseline
SETUP_MIN_STRINGS = 3  # all of this many strings low together = suspect the setup, not the strings


def _stc(row: GrowattIvSweep) -> Optional[Dict[str, Any]]:
    params = (row.stc_json or {}).get("parameters")
    return params if isinstance(params, dict) and params.get("p_max_w") else None


def _comparable(row: GrowattIvSweep) -> bool:
    """Good enough to compare STC values: passed the gate, a string sweep with a known string."""
    return bool(
        row.level == "string" and row.device_sn and row.string_no is not None and row.quality_gate_passed and _stc(row)
    )


def _stepped(row: GrowattIvSweep) -> bool:
    return row.signature == "steps_in_curve"


def _ratio(a: Any, b: Any) -> Optional[float]:
    try:
        return round(float(a) / float(b), 4) if float(b) > 0 else None
    except (TypeError, ValueError):
        return None


def _peer_block(row: GrowattIvSweep, pool: Sequence[GrowattIvSweep]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "window_min": PEER_WINDOW_MIN,
        "peers": 0,
        "peer_strings": [],
        "ratios": None,
        "flags": [],
        "setup_error_suspected": False,
        "reason": None,
    }
    if not _comparable(row):
        out["reason"] = "This sweep did not pass the quality gate, or is not a string sweep"
        return out
    window = timedelta(minutes=PEER_WINDOW_MIN)
    nearest: Dict[int, GrowattIvSweep] = {}
    for p in pool:
        if (
            p.id == row.id
            or p.device_sn != row.device_sn
            or p.string_no == row.string_no
            or p.source != row.source
            or not _comparable(p)
            or abs(p.swept_at - row.swept_at) > window
        ):
            continue
        assert p.string_no is not None
        best = nearest.get(p.string_no)
        if best is None or abs(p.swept_at - row.swept_at) < abs(best.swept_at - row.swept_at):
            nearest[p.string_no] = p
    together = list(nearest.values())
    # a stepped (shaded / mismatched) peer is not a reference for a healthy string
    peers = [p for p in together if not _stepped(p)]
    out["peers"] = len(peers)
    out["peer_strings"] = sorted(p.string_no for p in peers if p.string_no is not None)
    if len(peers) < PEER_MIN:
        out["reason"] = f"Needs at least {PEER_MIN} other strings of this inverter swept within {PEER_WINDOW_MIN} min"
        return out

    mine = _stc(row) or {}

    def med(key: str, per_module: bool = False) -> float:
        return median(float((_stc(p) or {})[key]) / (max(1, p.modules) if per_module else 1) for p in peers)

    n = max(1, row.modules)
    ratios = {
        # strings differ in length: power and voltage are compared per module, current as it is
        "p_max": _ratio(float(mine["p_max_w"]) / n, med("p_max_w", True)),
        "i_sc": _ratio(mine["i_sc_a"], med("i_sc_a")),
        "v_oc": _ratio(float(mine["v_oc_v"]) / n, med("v_oc_v", True)),
        "fill_factor": _ratio(mine["fill_factor"], med("fill_factor")),
    }
    out["ratios"] = ratios
    flags: List[str] = []
    if ratios["p_max"] is not None and ratios["p_max"] < PEER_PMAX_FLAG:
        flags.append("pmax_below_peers")
    if ratios["i_sc"] is not None and ratios["i_sc"] < PEER_ISC_FLAG:
        flags.append("isc_below_peers")
    if ratios["fill_factor"] is not None and ratios["fill_factor"] < PEER_FF_FLAG:
        flags.append("ff_below_peers")
    out["flags"] = flags

    # Isc low against the datasheet on every string swept together points at the irradiance
    # reading or the setup, not at the strings.
    group = [row] + together
    if len(group) >= SETUP_MIN_STRINGS:
        devs = [((g.classification_json or {}).get("deviations_pct") or {}).get("i_sc_vs_stc_pct") for g in group]
        band = float((row.classification_json or {}).get("dead_band_pct") or DEFAULT_DEAD_BAND_PCT)
        out["setup_error_suspected"] = all(d is not None and float(d) < -band for d in devs)
    return out


def _baseline_block(row: GrowattIvSweep, pool: Sequence[GrowattIvSweep]) -> Optional[Dict[str, Any]]:
    """Ratios against the string's own first valid sweep from the same kind of instrument."""
    if not _comparable(row) or _stepped(row):
        return None
    earlier = [
        p
        for p in pool
        if p.id != row.id
        and p.device_sn == row.device_sn
        and p.string_no == row.string_no
        and p.source == row.source
        and p.modules == row.modules
        and p.swept_at < row.swept_at
        and _comparable(p)
        and not _stepped(p)
    ]
    if not earlier:
        return None
    base = min(earlier, key=lambda p: (p.swept_at, p.id))
    mine, ref = _stc(row) or {}, _stc(base) or {}
    ratios = {
        "p_max": _ratio(mine.get("p_max_w"), ref.get("p_max_w")),
        "fill_factor": _ratio(mine.get("fill_factor"), ref.get("fill_factor")),
        "slope_voc": _ratio(mine.get("slope_voc_ohm"), ref.get("slope_voc_ohm")),
        "slope_isc": _ratio(mine.get("slope_isc_ohm"), ref.get("slope_isc_ohm")),
    }
    flags: List[str] = []
    if ratios["p_max"] is not None and ratios["p_max"] < BASELINE_PMAX_FLAG:
        flags.append("pmax_below_baseline")
    if ratios["slope_voc"] is not None and ratios["slope_voc"] > BASELINE_ROC_FLAG:
        flags.append("series_resistance_up")
    if ratios["slope_isc"] is not None and ratios["slope_isc"] < BASELINE_RSC_FLAG:
        flags.append("shunt_resistance_down")
    return {
        "sweep_id": base.id,
        "swept_at": base.swept_at.strftime("%Y-%m-%d %H:%M:%S"),
        "ratios": ratios,
        "flags": flags,
    }


def _with_comparison(db: Session, rows: Sequence[GrowattIvSweep]) -> List[Dict[str, Any]]:
    """Serialized sweeps, each with `comparison` = {peer, baseline, thresholds}."""
    sns = {r.device_sn for r in rows if r.device_sn and r.level == "string"}
    pool: List[GrowattIvSweep] = []
    if sns:
        pool = list(
            db.scalars(
                select(GrowattIvSweep).where(
                    GrowattIvSweep.plant_id.in_({r.plant_id for r in rows}),
                    GrowattIvSweep.device_sn.in_(sns),
                    GrowattIvSweep.level == "string",
                )
            )
        )
    out = []
    for r in rows:
        d = serialize_sweep(r)
        d["comparison"] = {
            "peer": _peer_block(r, pool),
            "baseline": _baseline_block(r, pool),
            "thresholds": {
                "status": "proposed",  # not from a standard; calibrate on site
                "peer_p_max": PEER_PMAX_FLAG,
                "peer_i_sc": PEER_ISC_FLAG,
                "peer_fill_factor": PEER_FF_FLAG,
                "baseline_p_max": BASELINE_PMAX_FLAG,
                "baseline_slope_voc": BASELINE_ROC_FLAG,
                "baseline_slope_isc": BASELINE_RSC_FLAG,
            },
        }
        out.append(d)
    return out


def serialize_sweep(row: GrowattIvSweep) -> Dict[str, Any]:
    return {
        "id": row.id,
        "plant_id": row.plant_id,
        "device_sn": row.device_sn,
        "string_no": row.string_no,
        "module_no": row.module_no,
        "level": row.level,
        "source": row.source,
        "swept_at": row.swept_at.strftime("%Y-%m-%d %H:%M:%S"),
        "irradiance_wm2": row.irradiance_wm2,
        "module_temp_c": row.module_temp_c,
        "irradiance_change_pct": row.irradiance_change_pct,
        "reference_cell_tech": row.reference_cell_tech,
        "temp_change_k_per_min": row.temp_change_k_per_min,
        "sweep_time_ms": row.sweep_time_ms,
        "cell_technology": row.cell_technology,
        "irradiance_uncertainty_pct": row.irradiance_uncertainty_pct,
        "reverse_pmax_w": row.reverse_pmax_w,
        "sensor_misalignment_deg": row.sensor_misalignment_deg,
        "modules": row.modules,
        "quality_gate_passed": row.quality_gate_passed,
        "gate_reasons": row.gate_reasons_json or [],
        "iec60891": row.iec60891_json or {},
        "measured": row.measured_json or {},
        "stc": row.stc_json or {},
        "classification": row.classification_json or {},
        "p_max_stc_w": row.p_max_stc_w,
        "expected_pmax_stc_w": row.expected_pmax_stc_w,
        "pmax_dev_pct": row.pmax_dev_pct,
        "signature": row.signature,
        "is_finding": row.is_finding,
        "ticket_recommended": row.ticket_recommended,
        "ir_confirmed": row.ir_confirmed,
        "timeseries_trend_confirmed": row.timeseries_trend_confirmed,
        # column `warranty_claim_ready` keeps its old name (no migration)
        "module_test_candidate": row.warranty_claim_ready,
        "note": row.note,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def create_iv_sweep(
    db: Session,
    plant_id: int,
    payload: Dict[str, Any],
    username: Optional[str] = None,
) -> Dict[str, Any]:
    """Validate, translate to STC, classify, and persist an I-V curve sweep."""
    plant = _get_plant(db, plant_id)
    device_sn = payload.get("device_sn")
    string_no = payload.get("string_no")
    level = payload.get("level") or "string"
    source = payload.get("source") or "upload"
    if device_sn:
        inv = db.scalar(
            select(GrowattInverter).where(GrowattInverter.plant_id == plant_id, GrowattInverter.device_sn == device_sn)
        )
        if inv is None:
            raise ValueError(f"Inverter {device_sn} does not belong to plant {plant_id}")

    pts_raw: List[Dict[str, float]] = []
    if payload.get("csv_text"):
        pts_raw = parse_iv_csv(str(payload["csv_text"]))
    elif payload.get("points"):
        pts_raw = [{"v": float(p["v"]), "i": float(p["i"])} for p in payload["points"]]
    if len(pts_raw) < 5:
        raise ValueError("Provide at least 5 (V, I) points via `points` or `csv_text`")

    swept_dt = _parse_swept_at(str(payload["swept_at"]))
    fm = fleet_settings.get_fleet_module(db)
    modules = payload.get("modules")
    module_wp_override: Optional[float] = None
    if level == "module":
        modules = 1
    elif modules is None:
        if device_sn and string_no is not None:
            lay = load_layout(db, [device_sn])
            if (device_sn, int(string_no)) in lay:
                modules, module_wp_override = lay[(device_sn, int(string_no))]
        if modules is None:
            # Infer approximate module count from measured Voc and datasheet Voc if layout is absent
            v_max = max(p["v"] for p in pts_raw)
            voc_mod = float(fm.get("voc_stc") or 51.1)
            modules = max(1, round(v_max / (voc_mod * 0.92)))

    spec_dict = dict(fm)
    if module_wp_override:
        spec_dict["wp"] = module_wp_override
    spec = ModuleStcSpec.from_dict(spec_dict)

    # per sweep, else the fleet module setting when it has one; unknown stays unknown
    cell_technology = (str(payload.get("cell_technology") or fm.get("cell_technology") or "").strip().lower()) or None

    age_years = _plant_age_years(plant, swept_dt.date())
    ts_confirmed = _has_timeseries_trend(db, plant_id, device_sn, string_no)
    ir_confirmed = bool(payload.get("ir_confirmed", False))

    result = analyze_iv_sweep(
        voltage=[p["v"] for p in pts_raw],
        current=[p["i"] for p in pts_raw],
        irradiance_wm2=payload.get("irradiance_wm2"),
        module_temp_c=payload.get("module_temp_c"),
        swept_at=swept_dt.strftime("%Y-%m-%d %H:%M:%S"),
        spec=spec,
        modules=int(modules),
        system_age_years=age_years,
        irradiance_change_pct=payload.get("irradiance_change_pct"),
        dead_band_pct=float(payload.get("dead_band_pct") or DEFAULT_DEAD_BAND_PCT),
        near_negative_pole=bool(payload.get("near_negative_pole", False)),
        low_irradiance_worse=bool(payload.get("low_irradiance_worse", False)),
        ir_confirmed=ir_confirmed,
        timeseries_trend_confirmed=ts_confirmed,
        # an inverter scan has no reference cell at the string: relative screening only
        absolute_comparison_ok=source != "inverter_scan",
        temp_change_k_per_min=payload.get("temp_change_k_per_min"),
        sweep_time_ms=payload.get("sweep_time_ms"),
        cell_technology=cell_technology,
        irradiance_uncertainty_pct=payload.get("irradiance_uncertainty_pct"),
        reverse_pmax_w=payload.get("reverse_pmax_w"),
        sensor_misalignment_deg=payload.get("sensor_misalignment_deg"),
    )

    cls = result["classification"]
    row = GrowattIvSweep(
        plant_id=plant_id,
        device_sn=device_sn,
        string_no=int(string_no) if string_no is not None else None,
        module_no=int(payload["module_no"]) if payload.get("module_no") is not None else None,
        level=level,
        source=source,
        swept_at=swept_dt,
        irradiance_wm2=float(payload["irradiance_wm2"]),
        module_temp_c=float(payload["module_temp_c"]),
        irradiance_change_pct=payload.get("irradiance_change_pct"),
        reference_cell_tech=payload.get("reference_cell_tech"),
        temp_change_k_per_min=payload.get("temp_change_k_per_min"),
        sweep_time_ms=payload.get("sweep_time_ms"),
        cell_technology=cell_technology,
        irradiance_uncertainty_pct=payload.get("irradiance_uncertainty_pct"),
        reverse_pmax_w=payload.get("reverse_pmax_w"),
        sensor_misalignment_deg=payload.get("sensor_misalignment_deg"),
        modules=int(modules),
        quality_gate_passed=bool(result["conditions"]["quality_gate_passed"]),
        gate_reasons_json=result["conditions"]["gate_reasons"],
        iec60891_json=result["iec60891"],
        measured_json=result["measured"],
        stc_json=result["stc"],
        classification_json=cls,
        p_max_stc_w=float(result["stc"]["parameters"]["p_max_w"]),
        expected_pmax_stc_w=float(cls["warranty"]["expected_pmax_stc_w"]),
        pmax_dev_pct=float(cls["deviations_pct"]["p_max_vs_expected_pct"]),
        signature=str(cls["signature"]),
        is_finding=bool(cls["is_finding"]),
        ticket_recommended=bool(cls["ticket_recommended"]),
        ir_confirmed=ir_confirmed,
        timeseries_trend_confirmed=ts_confirmed,
        warranty_claim_ready=bool(cls["warranty"]["module_test_candidate"]),
        note=(payload.get("note") or "").strip() or None,
        created_by=username,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _with_comparison(db, [row])[0]


def list_iv_sweeps(
    db: Session,
    plant_id: int,
    device_sn: Optional[str] = None,
    string_no: Optional[int] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    _get_plant(db, plant_id)
    q = select(GrowattIvSweep).where(GrowattIvSweep.plant_id == plant_id)
    if device_sn is not None:
        q = q.where(GrowattIvSweep.device_sn == device_sn)
    if string_no is not None:
        q = q.where(GrowattIvSweep.string_no == string_no)
    rows = list(db.scalars(q.order_by(GrowattIvSweep.swept_at.desc(), GrowattIvSweep.id.desc()).limit(limit)))
    return _with_comparison(db, rows)


def patch_iv_sweep(
    db: Session,
    plant_id: int,
    sweep_id: int,
    ir_confirmed: Optional[bool] = None,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    row = db.get(GrowattIvSweep, sweep_id)
    if row is None or row.plant_id != plant_id:
        raise GrowattNotFound(f"I-V sweep {sweep_id} not found on plant {plant_id}")
    if ir_confirmed is not None:
        row.ir_confirmed = bool(ir_confirmed)
    if note is not None:
        row.note = note.strip() or None
    # Re-evaluate the two-source agreement
    ts_confirmed = _has_timeseries_trend(db, plant_id, row.device_sn, row.string_no)
    row.timeseries_trend_confirmed = ts_confirmed
    cls = dict(row.classification_json or {})
    warranty = dict(cls.get("warranty") or {})
    below = bool(warranty.get("below_warranted_power"))
    second_source: Optional[str] = None
    if row.ir_confirmed and ts_confirmed:
        second_source = "ir_and_timeseries"
    elif row.ir_confirmed:
        second_source = "ir"
    elif ts_confirmed:
        second_source = "timeseries_trend"
    warranty["ir_confirmed"] = row.ir_confirmed
    warranty["timeseries_trend_confirmed"] = ts_confirmed
    warranty["second_source"] = second_source
    warranty.pop("warranty_claim_ready", None)  # key of sweeps stored before the rename
    warranty["module_test_candidate"] = bool(below and second_source is not None)
    cls["warranty"] = warranty
    row.classification_json = cls
    row.warranty_claim_ready = warranty["module_test_candidate"]
    db.commit()
    db.refresh(row)
    return _with_comparison(db, [row])[0]


# signatures of a string whose curve is good enough to fit coefficients from
_FIT_SIGNATURES = ("normal", "normal_degradation", "isc_low_normal_shape")


def site_coefficients(db: Session, plant_id: int, device_sn: str, string_no: int) -> Dict[str, Any]:
    """Coefficients fitted from this string's stored handheld sweeps, computed on read and never
    stored or applied: an admin enters the values worth keeping in the fleet module setting.

    Uses string sweeps that passed the shape gate (G >= 400 W/m², stable) without steps, of the
    module count of the newest such sweep. Sweeps at G >= 700 W/m² must also have a healthy
    signature, and at least one of them is required. Low-irradiance sweeps count: the fit needs
    the irradiance range.
    """
    _get_plant(db, plant_id)
    rows = list(
        db.scalars(
            select(GrowattIvSweep)
            .where(
                GrowattIvSweep.plant_id == plant_id,
                GrowattIvSweep.device_sn == device_sn,
                GrowattIvSweep.string_no == string_no,
                GrowattIvSweep.level == "string",
                GrowattIvSweep.source == "upload",
            )
            .order_by(GrowattIvSweep.swept_at.desc(), GrowattIvSweep.id.desc())
        )
    )

    def usable(r: GrowattIvSweep) -> bool:
        cls = r.classification_json or {}
        meas = r.measured_json or {}
        # sweeps stored before the shape gate existed carry only the stricter quality gate
        gate = cls.get("shape_gate_passed", r.quality_gate_passed)
        if not gate or len(meas.get("points") or []) < 5 or (meas.get("parameters") or {}).get("steps_count"):
            return False
        # below the STC gate the signature rests on a long translation and is not reliable:
        # such a sweep is judged by its shape only
        return r.signature in _FIT_SIGNATURES if r.quality_gate_passed else True

    good = [r for r in rows if usable(r)]
    modules = good[0].modules if good else None
    good = [r for r in good if r.modules == modules]
    extra_reasons: List[str] = []
    if good and not any(r.quality_gate_passed for r in good):
        # nothing at >= 700 W/m² says the string is healthy, so its sweeps are no basis for a fit
        extra_reasons.append("No sweep that passed the STC gate (G ≥ 700 W/m²) shows this string as healthy")
        good = []
    spec = ModuleStcSpec.from_dict(dict(fleet_settings.get_fleet_module(db)))
    fit = fit_site_coefficients(
        [
            {
                "v": [p["v"] for p in (r.measured_json or {})["points"]],
                "i": [p["i"] for p in (r.measured_json or {})["points"]],
                "g": r.irradiance_wm2,
                "t": r.module_temp_c,
            }
            for r in good
        ],
        spec,
        modules or 1,
    )
    return {
        "plant_id": plant_id,
        "device_sn": device_sn,
        "string_no": string_no,
        "modules": modules,
        "stored_sweeps": len(rows),
        "used_sweep_ids": [r.id for r in good],
        "status": "estimate",  # from field sweeps of one string; not a laboratory determination
        **fit,
        "reasons": extra_reasons + fit["reasons"],
    }
