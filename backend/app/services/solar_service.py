"""Service layer bridging SQLAlchemy ORM models, Pandas DataFrames, and solar_core."""

from __future__ import annotations

from datetime import date, datetime
import json
from typing import Any, Dict, Iterable, List, Optional, Tuple, cast

import numpy as np
import pandas as pd
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import (
    AnalysisRun,
    CMWorkOrder,
    Dataset,
    PMTask,
    PTWPermit,
    Plant,
    RCARecord,
    StringSpecModel,
    TelemetryRow,
)
from solar_core.analysis import AnalysisResults, run_pv_string_analysis
from solar_core.models import CANONICAL_COLUMNS, PlantConfig, StringSpec
from solar_core.om_management import (
    compute_period_generation_summary,
    generate_cm_work_orders_from_analysis,
)


def df_to_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Convert a DataFrame to JSON-safe list of dicts (converting timestamps/dates to strings)."""
    if df is None or df.empty:
        return []
    clean = df.copy()
    for col in clean.columns:
        if pd.api.types.is_datetime64_any_dtype(clean[col]):
            clean[col] = clean[col].dt.strftime("%Y-%m-%d %H:%M:%S")
        elif clean[col].dtype == "object":
            clean[col] = clean[col].map(
                lambda v: v.isoformat() if isinstance(v, (date, datetime, pd.Timestamp)) else v
            )
    clean = clean.replace({np.nan: None})
    return json.loads(clean.to_json(orient="records") or "[]")


def build_plant_config(plant: Plant, df: Optional[pd.DataFrame] = None) -> PlantConfig:
    """Build a solar_core PlantConfig from a Plant ORM model and optional telemetry DataFrame."""
    specs: Dict[str, StringSpec] = {}
    for s in plant.string_specs:
        specs[s.string_id] = StringSpec(
            string_id=s.string_id,
            inverter_id=s.inverter_id,
            mppt_id=s.mppt_id,
            modules_per_string=s.modules_per_string,
            module_wp=s.module_wp,
            voc_stc=s.voc_stc,
            vmp_stc=s.vmp_stc,
            isc_stc=s.isc_stc,
            imp_stc=s.imp_stc,
            temp_coeff_pmax=s.temp_coeff_pmax,
            temp_coeff_voc=s.temp_coeff_voc,
            temp_coeff_isc=s.temp_coeff_isc,
        )

    if df is not None and not df.empty:
        for s_id in sorted(df["string_id"].astype(str).unique()):
            if s_id not in specs:
                sub = df.loc[df["string_id"] == s_id]
                inv_id = str(sub["inverter_id"].iloc[0]) if "inverter_id" in sub.columns else "INV-01"
                mppt_id = str(sub["mppt_id"].iloc[0]) if "mppt_id" in sub.columns else "MPPT-1"
                specs[s_id] = StringSpec(
                    string_id=s_id,
                    inverter_id=inv_id,
                    mppt_id=mppt_id,
                    modules_per_string=plant.modules_per_string,
                    module_wp=plant.module_wp,
                    vmp_stc=plant.vmp_stc,
                    voc_stc=round(plant.vmp_stc * 1.188, 2),
                    imp_stc=plant.imp_stc,
                    isc_stc=round(plant.imp_stc * 1.065, 2),
                )

    return PlantConfig(
        plant_name=plant.name,
        location=plant.location,
        latitude=plant.latitude,
        longitude=plant.longitude,
        system_loss_factor=plant.system_loss_factor,
        underperformance_threshold_pct=plant.underperformance_threshold_pct,
        zero_current_threshold_a=plant.zero_current_threshold_a,
        min_irradiance_for_anomaly_wm2=plant.min_irradiance_for_anomaly_wm2,
        strings=specs,
    )


def sync_plant_string_specs_from_df(db: Session, plant: Plant, df: pd.DataFrame) -> None:
    """Ensure all string_ids present in `df` have a StringSpecModel row on `plant`."""
    existing_ids = {s.string_id for s in plant.string_specs}
    for s_id in sorted(df["string_id"].astype(str).unique()):
        if s_id not in existing_ids:
            sub = df.loc[df["string_id"] == s_id]
            inv_id = str(sub["inverter_id"].iloc[0]) if "inverter_id" in sub.columns else "INV-01"
            mppt_id = str(sub["mppt_id"].iloc[0]) if "mppt_id" in sub.columns else "MPPT-1"
            spec_row = StringSpecModel(
                plant_id=plant.id,
                string_id=s_id,
                inverter_id=inv_id,
                mppt_id=mppt_id,
                modules_per_string=plant.modules_per_string,
                module_wp=plant.module_wp,
                vmp_stc=plant.vmp_stc,
                voc_stc=round(plant.vmp_stc * 1.188, 2),
                imp_stc=plant.imp_stc,
                isc_stc=round(plant.imp_stc * 1.065, 2),
            )
            db.add(spec_row)
    db.flush()
    db.refresh(plant)


def store_dataset_from_dataframe(
    db: Session,
    plant: Plant,
    df: pd.DataFrame,
    name: str,
    source_type: str,
    source_label: str,
) -> Dataset:
    """Persist a canonical telemetry DataFrame into `datasets` and `telemetry` tables."""
    work = df.loc[:, CANONICAL_COLUMNS].copy()
    work["timestamp"] = pd.to_datetime(work["timestamp"])

    start_ts = work["timestamp"].min().isoformat() if not work.empty else None
    end_ts = work["timestamp"].max().isoformat() if not work.empty else None
    str_count = int(work["string_id"].nunique()) if not work.empty else 0

    dataset = Dataset(
        plant_id=plant.id,
        name=name,
        source_type=source_type,
        source_label=source_label,
        row_count=len(work),
        string_count=str_count,
        start_timestamp=start_ts,
        end_timestamp=end_ts,
        status="ready",
    )
    db.add(dataset)
    db.flush()

    records = []
    # itertuples rows are namedtuples with the canonical column names (typed as plain tuples)
    for row in cast(Iterable[Any], work.itertuples(index=False)):
        records.append(
            {
                "dataset_id": dataset.id,
                "timestamp": row.timestamp.to_pydatetime()
                if hasattr(row.timestamp, "to_pydatetime")
                else row.timestamp,
                "inverter_id": str(row.inverter_id),
                "mppt_id": str(row.mppt_id),
                "string_id": str(row.string_id),
                "voltage_v": float(row.voltage_v),
                "current_a": float(row.current_a),
                "power_w": float(row.power_w),
                "irradiance_wm2": float(row.irradiance_wm2),
                "module_temp_c": float(row.module_temp_c),
                "ambient_temp_c": float(row.ambient_temp_c),
            }
        )

    if records:
        db.bulk_insert_mappings(TelemetryRow, records)

    sync_plant_string_specs_from_df(db, plant, work)
    db.commit()
    db.refresh(dataset)
    return dataset


def load_dataset_dataframe(db: Session, dataset_id: int) -> pd.DataFrame:
    """Load canonical telemetry DataFrame for a dataset_id."""
    stmt = (
        select(
            TelemetryRow.timestamp,
            TelemetryRow.inverter_id,
            TelemetryRow.mppt_id,
            TelemetryRow.string_id,
            TelemetryRow.voltage_v,
            TelemetryRow.current_a,
            TelemetryRow.power_w,
            TelemetryRow.irradiance_wm2,
            TelemetryRow.module_temp_c,
            TelemetryRow.ambient_temp_c,
        )
        .where(TelemetryRow.dataset_id == dataset_id)
        .order_by(TelemetryRow.timestamp.asc(), TelemetryRow.string_id.asc())
    )
    rows = db.execute(stmt).all()
    if not rows:
        return pd.DataFrame(columns=CANONICAL_COLUMNS)
    df = pd.DataFrame(rows, columns=CANONICAL_COLUMNS)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def execute_and_store_analysis(
    db: Session,
    plant: Plant,
    dataset: Dataset,
    target_pr_pct: Optional[float] = None,
    tariff_thb_per_kwh: Optional[float] = None,
    sync_cm_orders: bool = True,
) -> Tuple[AnalysisRun, AnalysisResults]:
    """Run solar_core string analysis + period generation summary and persist AnalysisRun."""
    df = load_dataset_dataframe(db, dataset.id)
    config = build_plant_config(plant, df)

    eff_target_pr = float(target_pr_pct if target_pr_pct is not None else plant.target_pr_pct)
    eff_tariff = float(tariff_thb_per_kwh if tariff_thb_per_kwh is not None else plant.tariff_thb_per_kwh)

    results = run_pv_string_analysis(df, config)
    daily_plant_df, monthly_plant_df, waterfall_df, opp_df = compute_period_generation_summary(
        results.enriched_df,
        config,
        target_pr_pct=eff_target_pr,
        tariff_thb_per_kwh=eff_tariff,
    )

    kpis = dict(results.plant_kpis)
    kpis["target_pr_pct"] = eff_target_pr
    kpis["tariff_thb_per_kwh"] = eff_tariff
    kpis["recoverable_revenue_thb"] = round(kpis.get("recoverable_loss_kwh", 0.0) * eff_tariff, 2)

    run = AnalysisRun(
        plant_id=plant.id,
        dataset_id=dataset.id,
        target_pr_pct=eff_target_pr,
        tariff_thb_per_kwh=eff_tariff,
        plant_kpis_json=kpis,
        string_summary_json=df_to_records(results.string_summary_df),
        daily_string_json=df_to_records(results.daily_string_df),
        anomalies_json=df_to_records(results.anomalies_df),
        daily_plant_json=df_to_records(daily_plant_df),
        monthly_plant_json=df_to_records(monthly_plant_df),
        waterfall_json=df_to_records(waterfall_df),
        opportunities_json=df_to_records(opp_df),
    )
    db.add(run)
    db.flush()

    if sync_cm_orders:
        regenerate_cm_work_orders(db, plant.id, run.id, results)

    db.commit()
    db.refresh(run)
    return run, results


def regenerate_cm_work_orders(
    db: Session,
    plant_id: int,
    analysis_run_id: Optional[int],
    results: AnalysisResults,
) -> List[CMWorkOrder]:
    """Generate CM work orders from analysis results and replace auto-generated ones for the plant."""
    cm_df = generate_cm_work_orders_from_analysis(results)
    db.execute(delete(CMWorkOrder).where(CMWorkOrder.plant_id == plant_id))
    created: List[CMWorkOrder] = []
    for row in cm_df.to_dict(orient="records"):
        wo = CMWorkOrder(
            plant_id=plant_id,
            analysis_run_id=analysis_run_id,
            wo_number=str(row["WO_Number"]),
            created_date=str(row["Created_Date"]),
            asset_id=str(row["Asset_ID"]),
            equipment_type=str(row["Equipment_Type"]),
            priority=str(row["Priority"]),
            fault_symptom=str(row["Fault_Symptom"]),
            troubleshooting_checklist=str(row["Troubleshooting_Checklist"]),
            ptw_required=str(row["PTW_Required"]),
            status=str(row["Status"]),
        )
        db.add(wo)
        created.append(wo)
    db.flush()
    return created


def reconstruct_analysis_results(
    db: Session, run: AnalysisRun
) -> Tuple[AnalysisResults, PlantConfig]:
    """Recompute enriched_df and AnalysisResults for a stored AnalysisRun (used for charts)."""
    plant = db.get(Plant, run.plant_id)
    if plant is None:
        raise LookupError(f"plant {run.plant_id} of analysis run {run.id} not found")
    df = load_dataset_dataframe(db, run.dataset_id)
    config = build_plant_config(plant, df)
    results = run_pv_string_analysis(df, config)
    return results, config

