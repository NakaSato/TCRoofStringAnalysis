"""I-V curve sweep service (DB only): ingests string and module I-V sweeps, translates to STC via
IEC 60891 Procedure 1, extracts parameters, classifies fault signatures, evaluates the two-source
warranty rule (I-V + IR, or I-V + time-series trend), and links tickets into `growatt_issues`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattIssue, GrowattIvSweep, GrowattPlant
from app.services import fleet_settings, growatt_issues
from app.services.growatt_common import GrowattNotFound, _get_plant
from app.services.growatt_layout import load_layout
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
    (R5, R6, R1, or R4) in `growatt_issues` — the second source for a warranty claim."""
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
        "warranty_claim_ready": row.warranty_claim_ready,
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
    )

    cls = result["classification"]
    row = GrowattIvSweep(
        plant_id=plant_id,
        device_sn=device_sn,
        string_no=int(string_no) if string_no is not None else None,
        module_no=int(payload["module_no"]) if payload.get("module_no") is not None else None,
        level=level,
        source=payload.get("source") or "upload",
        swept_at=swept_dt,
        irradiance_wm2=float(payload["irradiance_wm2"]),
        module_temp_c=float(payload["module_temp_c"]),
        irradiance_change_pct=payload.get("irradiance_change_pct"),
        reference_cell_tech=payload.get("reference_cell_tech"),
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
        warranty_claim_ready=bool(cls["warranty"]["warranty_claim_ready"]),
        note=(payload.get("note") or "").strip() or None,
        created_by=username,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return serialize_sweep(row)


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
    return [serialize_sweep(r) for r in rows]


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
    # Re-evaluate two-source warranty agreement
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
    warranty["warranty_claim_ready"] = bool(below and second_source is not None)
    cls["warranty"] = warranty
    row.classification_json = cls
    row.warranty_claim_ready = warranty["warranty_claim_ready"]
    db.commit()
    db.refresh(row)
    return serialize_sweep(row)
