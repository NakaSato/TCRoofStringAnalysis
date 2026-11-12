"""Database seeding and legacy SQLite migration helper."""

from __future__ import annotations

import pathlib
import sqlite3
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_password
from app.config import DATA_DIR
from app.db.models import (
    PMTask,
    PQTestRecord,
    PTWPermit,
    Plant,
    RCARecord,
    SubcontractorAudit,
    User,
)
from app.db.session import Base, engine
from app.services.solar_service import (
    df_to_records,
    execute_and_store_analysis,
    store_dataset_from_dataframe,
)
from solar_core.ingestion import generate_simulated_string_data
from solar_core.om_management import (
    evaluate_commissioning_and_power_quality,
    get_default_pm_schedule,
    get_default_rca_records,
    get_default_subcontractor_audits,
    get_she_dashboard_data,
)


def _load_legacy_or_default(table_name: str, default_df: pd.DataFrame) -> pd.DataFrame:
    """If legacy `data/solar_om.db` exists and has `table_name`, load it; otherwise return `default_df`."""
    legacy_path: pathlib.Path = DATA_DIR / "solar_om.db"
    if legacy_path.exists():
        try:
            with sqlite3.connect(str(legacy_path)) as conn:
                df = pd.read_sql(f"SELECT * FROM {table_name}", conn)
                if not df.empty:
                    return df
        except Exception:
            pass
    return default_df


def ensure_seeded(db: Session) -> Plant:
    """Create tables if needed and seed default users, plant, telemetry dataset, analysis run, and O&M registers."""
    Base.metadata.create_all(bind= db.get_bind())

    # 1. Seed users
    existing_user = db.scalar(select(User).limit(1))
    if existing_user is None:
        db.add_all(
            [
                User(
                    email="admin@tcroofsolar.com",
                    full_name="Chanthawat W. (O&M Lead Engineer)",
                    hashed_password=hash_password("admin123"),
                    role="admin",
                ),
                User(
                    email="engineer@tcroofsolar.com",
                    full_name="Anucha P. (Senior O&M Engineer)",
                    hashed_password=hash_password("engineer123"),
                    role="engineer",
                ),
                User(
                    email="viewer@tcroofsolar.com",
                    full_name="Executive Management Viewer",
                    hashed_password=hash_password("viewer123"),
                    role="viewer",
                ),
            ]
        )
        db.flush()

    # 2. Seed default plant
    plant = db.scalar(select(Plant).order_by(Plant.id.asc()).limit(1))
    if plant is not None:
        return plant

    plant = Plant(
        name="TC Roof Solar PV Plant",
        location="Bangkok, Thailand",
        latitude=13.7563,
        longitude=100.5018,
        system_loss_factor=0.04,
        underperformance_threshold_pct=10.0,
        zero_current_threshold_a=0.25,
        min_irradiance_for_anomaly_wm2=150.0,
        target_pr_pct=84.0,
        tariff_thb_per_kwh=4.20,
        modules_per_string=18,
        module_wp=550.0,
        vmp_stc=41.9,
        imp_stc=13.13,
    )
    db.add(plant)
    db.flush()

    # 3. Seed default PM schedule
    pm_df = _load_legacy_or_default("pm_schedule", get_default_pm_schedule())
    for row in pm_df.to_dict(orient="records"):
        db.add(
            PMTask(
                plant_id=plant.id,
                pm_id=str(row["PM_ID"]),
                asset_category=str(row["Asset_Category"]),
                task_description=str(row["Task_Description"]),
                frequency=str(row["Frequency"]),
                standard_ref=str(row["Standard_Ref"]),
                last_completed=str(row["Last_Completed"]),
                next_due=str(row["Next_Due"]),
                assigned_subcontractor=str(row["Assigned_Subcontractor"]),
                compliance_status=str(row["Compliance_Status"]),
                estimated_pr_recovery_pct=float(row["Estimated_PR_Recovery_Pct"]),
            )
        )

    # 4. Seed default RCA records
    rca_df = _load_legacy_or_default("rca_register", get_default_rca_records())
    for row in rca_df.to_dict(orient="records"):
        db.add(
            RCARecord(
                plant_id=plant.id,
                rca_id=str(row["RCA_ID"]),
                incident_date=str(row["Incident_Date"]),
                equipment_category=str(row["Equipment_Category"]),
                asset_id=str(row["Asset_ID"]),
                failure_mode=str(row["Failure_Mode"]),
                downtime_hours=float(row["Downtime_Hours"]),
                energy_loss_kwh=float(row["Energy_Loss_kWh"]),
                why_1=str(row["Why_1"]),
                why_2=str(row["Why_2"]),
                why_3=str(row["Why_3"]),
                why_4=str(row["Why_4"]),
                why_5_root_cause=str(row["Why_5_Root_Cause"]),
                fishbone_category=str(row["Fishbone_Category"]),
                capa_corrective_action=str(row["CAPA_Corrective_Action"]),
                capa_preventive_action=str(row["CAPA_Preventive_Action"]),
                rca_status=str(row["RCA_Status"]),
            )
        )

    # 5. Seed default Subcontractor audits
    sub_df = _load_legacy_or_default("subcontractor_audits", get_default_subcontractor_audits())
    for row in sub_df.to_dict(orient="records"):
        db.add(
            SubcontractorAudit(
                plant_id=plant.id,
                contractor_id=str(row["Contractor_ID"]),
                subcontractor_name=str(row["Subcontractor_Name"]),
                scope_of_work=str(row["Scope_of_Work"]),
                active_work_orders=int(row["Active_Work_Orders"]),
                workmanship_score_pct=float(row["Workmanship_Score_Pct"]),
                engineering_std_compliance_pct=float(row["Engineering_Std_Compliance_Pct"]),
                safety_she_compliance_pct=float(row["Safety_SHE_Compliance_Pct"]),
                on_time_sla_pct=float(row["On_Time_SLA_Pct"]),
                open_ncrs=int(row["Open_NCRs"]),
                torque_seal_verified=str(row["Torque_Seal_Verified"]),
                calibrated_tools_cert=str(row["Calibrated_Tools_Cert"]),
                overall_rating=str(row["Overall_Rating"]),
            )
        )

    # 6. Seed default SH&E PTW register
    _, default_ptw_df, _ = get_she_dashboard_data()
    ptw_df = _load_legacy_or_default("she_ptw_register", default_ptw_df)
    for row in ptw_df.to_dict(orient="records"):
        db.add(
            PTWPermit(
                plant_id=plant.id,
                ptw_number=str(row["PTW_Number"]),
                issue_date=str(row["Issue_Date"]),
                work_activity=str(row["Work_Activity"]),
                high_risk_permits=str(row["High_Risk_Permits"]),
                loto_padlock_id=str(row["LOTO_Padlock_ID"]),
                arc_flash_ppe=str(row["Arc_Flash_PPE"]),
                gas_heat_index_check=str(row["Gas_Heat_Index_Check"]),
                safety_supervisor=str(row["Safety_Supervisor"]),
                status=str(row["Status"]),
            )
        )

    # 7. Seed default Commissioning & Power Quality test
    pq_df, comm_df = evaluate_commissioning_and_power_quality()
    db.add(
        PQTestRecord(
            plant_id=plant.id,
            voltage_thd_pct=2.1,
            current_thd_pct=3.4,
            power_factor=0.992,
            voltage_unbalance_pct=0.85,
            flicker_plt=0.42,
            grid_frequency_hz=50.02,
            dc_injection_pct=0.18,
            min_riso_mohm=42.5,
            pq_results_json=df_to_records(pq_df),
            commissioning_results_json=df_to_records(comm_df),
            overall_compliant=bool((pq_df["Compliant"] == "Pass").all()),
        )
    )
    db.flush()

    # 8. Seed initial 7-day simulated dataset & initial analysis run
    sim_df, _ = generate_simulated_string_data(days=7, interval_minutes=15, num_strings=8, seed=42)
    dataset = store_dataset_from_dataframe(
        db=db,
        plant=plant,
        df=sim_df,
        name="Built-in Realistic Rooftop PV Dataset (8 Strings, 7 Days)",
        source_type="simulated",
        source_label="Built-in Realistic Rooftop PV Dataset (8 Strings, 7 Days)",
    )
    execute_and_store_analysis(
        db=db,
        plant=plant,
        dataset=dataset,
        target_pr_pct=plant.target_pr_pct,
        tariff_thb_per_kwh=plant.tariff_thb_per_kwh,
        sync_cm_orders=True,
    )
    return plant


if __name__ == "__main__":
    from app.db.session import SessionLocal

    with SessionLocal() as session:
        seeded_plant = ensure_seeded(session)
        print(f"Seeded plant #{seeded_plant.id}: {seeded_plant.name}")
