"""Analysis runs, PR & Generation summaries, String diagnostics, and Plotly JSON chart endpoints."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import AnalysisRun, Dataset, Plant, User
from app.db.session import get_db
from app.schemas.api_schemas import AnalysisRunOut, AnalyzeDatasetRequest
from app.services.solar_service import (
    execute_and_store_analysis,
    reconstruct_analysis_results,
)
from solar_core.charts import (
    plot_daily_generation_and_pr_trend,
    plot_energy_loss_waterfall,
    plot_monthly_generation_and_pr_trend,
    plot_operating_iv_pv_curves,
    plot_string_deviation_heatmap,
    plot_string_yield_and_pr_bar,
    plot_timeseries_telemetry,
)

router = APIRouter(tags=["2 & 3. Generation, PR, String Analysis & Charts"])

METRIC_LABELS = {
    "current_a": "String Current (A)",
    "voltage_v": "String Voltage (V)",
    "power_w": "String DC Power (W)",
    "specific_power_w_kwp": "Specific Power (W/kWp)",
}


def _get_run_or_404(db: Session, run_id: int) -> AnalysisRun:
    run = db.get(AnalysisRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Analysis run {run_id} not found")
    return run


@router.get("/plants/{plant_id}/analysis-runs", response_model=List[AnalysisRunOut])
def list_analysis_runs(plant_id: int, db: Session = Depends(get_db)) -> List[AnalysisRunOut]:
    runs = db.scalars(
        select(AnalysisRun)
        .where(AnalysisRun.plant_id == plant_id)
        .order_by(AnalysisRun.id.desc())
    ).all()
    return [AnalysisRunOut.model_validate(r) for r in runs]


@router.get("/plants/{plant_id}/analysis/latest", response_model=AnalysisRunOut)
def get_latest_analysis_run(plant_id: int, db: Session = Depends(get_db)) -> AnalysisRunOut:
    run = db.scalar(
        select(AnalysisRun)
        .where(AnalysisRun.plant_id == plant_id)
        .order_by(AnalysisRun.id.desc())
        .limit(1)
    )
    if run is None:
        raise HTTPException(status_code=404, detail=f"No analysis runs found for plant {plant_id}")
    return AnalysisRunOut.model_validate(run)


@router.post("/datasets/{dataset_id}/analyze", response_model=AnalysisRunOut)
def analyze_dataset(
    dataset_id: int,
    payload: Optional[AnalyzeDatasetRequest] = None,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> AnalysisRunOut:
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
    plant = db.get(Plant, dataset.plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {dataset.plant_id} of dataset {dataset_id} not found")
    req = payload or AnalyzeDatasetRequest()
    run, _ = execute_and_store_analysis(
        db=db,
        plant=plant,
        dataset=dataset,
        target_pr_pct=req.target_pr_pct,
        tariff_thb_per_kwh=req.tariff_thb_per_kwh,
        sync_cm_orders=req.sync_cm_orders,
    )
    return AnalysisRunOut.model_validate(run)


@router.get("/analysis/{run_id}", response_model=AnalysisRunOut)
def get_analysis_run(run_id: int, db: Session = Depends(get_db)) -> AnalysisRunOut:
    run = _get_run_or_404(db, run_id)
    return AnalysisRunOut.model_validate(run)


@router.get("/analysis/{run_id}/generation")
def get_analysis_generation(
    run_id: int,
    period: str = Query(default="both", description="daily | monthly | both"),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    run = _get_run_or_404(db, run_id)
    if period == "daily":
        return {"kpis": run.plant_kpis_json, "daily": run.daily_plant_json}
    if period == "monthly":
        return {"kpis": run.plant_kpis_json, "monthly": run.monthly_plant_json}
    return {
        "kpis": run.plant_kpis_json,
        "daily": run.daily_plant_json,
        "monthly": run.monthly_plant_json,
    }


@router.get("/analysis/{run_id}/waterfall")
def get_analysis_waterfall(run_id: int, db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    run = _get_run_or_404(db, run_id)
    return run.waterfall_json


@router.get("/analysis/{run_id}/opportunities")
def get_analysis_opportunities(run_id: int, db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    run = _get_run_or_404(db, run_id)
    return run.opportunities_json


@router.get("/analysis/{run_id}/strings")
def get_analysis_strings(run_id: int, db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    run = _get_run_or_404(db, run_id)
    return run.string_summary_json


@router.get("/analysis/{run_id}/anomalies")
def get_analysis_anomalies(run_id: int, db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    run = _get_run_or_404(db, run_id)
    return run.anomalies_json


@router.get("/analysis/{run_id}/charts/{chart_name}")
def get_analysis_chart(
    run_id: int,
    chart_name: str,
    metric_col: str = Query(default="current_a"),
    selected_strings: Optional[str] = Query(default=None, description="Comma-separated string IDs"),
    target_irradiance: float = Query(default=850.0, ge=200.0, le=1200.0),
    target_temp_c: float = Query(default=45.0, ge=10.0, le=85.0),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Return Plotly Figure serialized via `fig.to_json()` for `react-plotly.js`."""
    run = _get_run_or_404(db, run_id)

    if chart_name == "daily_pr":
        fig = plot_daily_generation_and_pr_trend(pd.DataFrame(run.daily_plant_json))
    elif chart_name == "monthly_pr":
        fig = plot_monthly_generation_and_pr_trend(pd.DataFrame(run.monthly_plant_json))
    elif chart_name == "waterfall":
        fig = plot_energy_loss_waterfall(pd.DataFrame(run.waterfall_json))
    elif chart_name == "yield_pr":
        fig = plot_string_yield_and_pr_bar(pd.DataFrame(run.string_summary_json))
    elif chart_name in ("heatmap", "timeseries", "iv_pv"):
        results, config = reconstruct_analysis_results(db, run)
        if chart_name == "heatmap":
            fig = plot_string_deviation_heatmap(results.enriched_df)
        elif chart_name == "timeseries":
            str_list = (
                [s.strip() for s in selected_strings.split(",") if s.strip()]
                if selected_strings
                else sorted(results.enriched_df["string_id"].unique().tolist())
            )
            label = METRIC_LABELS.get(metric_col, metric_col)
            fig = plot_timeseries_telemetry(
                results.enriched_df,
                metric_col=metric_col,
                metric_label=label,
                selected_strings=str_list,
            )
        else:
            first_spec = next(iter(config.strings.values()))
            fig = plot_operating_iv_pv_curves(
                results.enriched_df,
                spec=first_spec,
                target_irradiance=float(target_irradiance),
                target_temp_c=float(target_temp_c),
            )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown chart_name '{chart_name}'. Expected one of: daily_pr, monthly_pr, waterfall, yield_pr, heatmap, timeseries, iv_pv",
        )

    return json.loads(fig.to_json() or "{}")
