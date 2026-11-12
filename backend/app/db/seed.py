"""Database seeding and legacy SQLite migration helper."""

from __future__ import annotations

import pathlib
import sqlite3
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_password, verify_password
from app.config import DATA_DIR, Settings, settings as app_settings
from app.db.models import (
    PMTask,
    PQTestRecord,
    PTWPermit,
    Plant,
    RCARecord,
    SubcontractorAudit,
    User,
)
from app.db.session import Base, engine, ensure_schema
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


def _backfill_usernames(db: Session) -> None:
    """Give users created before usernames existed one from their email's local part."""
    missing = list(db.scalars(select(User).where(User.username.is_(None)).order_by(User.id)))
    if not missing:
        return
    taken = set(db.scalars(select(User.username).where(User.username.is_not(None))))
    for user in missing:
        base = (user.email.split("@", 1)[0] or f"user{user.id}").strip().lower()[:60]
        name, n = base, 2
        while name in taken:
            name, n = f"{base}{n}", n + 1
        user.username = name
        taken.add(name)
    # commit here: on an already-seeded DB ensure_seeded returns before any later commit
    db.commit()


# Demo accounts seeded in dev: (username, password). In prod they are never created, and any
# that still has its demo password (e.g. a DB first started in dev) is disabled at startup.
DEMO_ACCOUNTS = {"admin": "admin123", "engineer": "engineer123", "viewer": "viewer123"}
# Roles: admin (everything) and engineer (only the plants an admin assigned). `viewer` is the
# demo account of the former read-only role; it is no longer seeded but stays listed above so
# prod still disables it while it has its demo password.
ROLES = ("admin", "engineer")


def _normalize_roles(db: Session) -> None:
    """Any role other than admin/engineer (the former `viewer`) becomes engineer, with no plants
    assigned until an admin assigns some: it keeps seeing nothing it could not see before."""
    for user in db.scalars(select(User).where(User.role.not_in(ROLES))):
        user.role = "engineer"
    db.flush()
DEFAULT_JWT_SECRET = "tc-roof-solar-super-secret-jwt-key-2026-engineering"


def check_production_config(cfg: Settings) -> None:
    """Refuse to start in prod with settings that would leave the public site open."""
    if not cfg.is_prod:
        return
    problems = []
    if not cfg.admin_password:
        problems.append("ADMIN_PASSWORD is not set")
    elif len(cfg.admin_password) < 12 or cfg.admin_password in DEMO_ACCOUNTS.values():
        problems.append("ADMIN_PASSWORD must be at least 12 characters and not a demo password")
    if cfg.jwt_secret_key == DEFAULT_JWT_SECRET or len(cfg.jwt_secret_key) < 32:
        problems.append("JWT_SECRET_KEY is the default or shorter than 32 characters")
    if problems:
        raise RuntimeError("Unsafe production config (APP_ENV=prod): " + "; ".join(problems))


def _seed_users(db: Session, cfg: Settings) -> None:
    if cfg.admin_password:
        # The configured admin is the source of truth: created if missing, password reset if changed.
        name = cfg.admin_username.strip().lower()
        admin = db.scalar(select(User).where(User.username == name))
        if admin is None:
            db.add(User(username=name, email=cfg.admin_email.strip().lower(), full_name="Administrator",
                        hashed_password=hash_password(cfg.admin_password), role="admin"))
        else:
            if not verify_password(cfg.admin_password, admin.hashed_password):
                admin.hashed_password = hash_password(cfg.admin_password)
            admin.role, admin.is_active = "admin", True
        db.flush()
    if cfg.is_prod:
        for user in db.scalars(select(User).where(User.username.in_(list(DEMO_ACCOUNTS)), User.is_active.is_(True))):
            if user.username != cfg.admin_username.strip().lower() and verify_password(
                DEMO_ACCOUNTS[user.username], user.hashed_password
            ):
                user.is_active = False  # demo password on a public site
        db.flush()
        return
    if db.scalar(select(User).limit(1)) is None:
        db.add_all(
            [
                User(
                    username="admin",
                    email="admin@tcroofsolar.com",
                    full_name="Chanthawat W. (O&M Lead Engineer)",
                    hashed_password=hash_password("admin123"),
                    role="admin",
                ),
                User(
                    username="engineer",
                    email="engineer@tcroofsolar.com",
                    full_name="Anucha P. (Senior O&M Engineer)",
                    hashed_password=hash_password("engineer123"),
                    role="engineer",
                ),
            ]
        )
        db.flush()


def ensure_seeded(db: Session, cfg: Settings | None = None) -> Plant:
    """Create tables if needed and seed users and the default plant; in dev (or SEED_DEMO_DATA=true)
    also the demo telemetry dataset, analysis run and O&M registers."""
    cfg = cfg or app_settings
    check_production_config(cfg)
    ensure_schema(db.get_bind())

    # 1. Users
    _backfill_usernames(db)
    _seed_users(db, cfg)
    _normalize_roles(db)
    db.commit()

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
    if not cfg.demo_data:
        # prod: plant configuration only — no invented registers, telemetry or analysis runs
        db.commit()
        return plant

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
