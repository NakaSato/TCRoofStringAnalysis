"""Unit and integration tests for Solar String Analysis & O&M Engineering Management."""

from __future__ import annotations

import io
import pandas as pd
import pytest

from solar_core.analysis import run_pv_string_analysis
from solar_core.charts import (
    plot_daily_generation_and_pr_trend,
    plot_energy_loss_waterfall,
    plot_monthly_generation_and_pr_trend,
)
from solar_core.ingestion import (
    SolarAPIClient,
    generate_simulated_string_data,
    load_from_uploaded_file,
    normalize_dataframe,
)
from solar_core.models import CANONICAL_COLUMNS
from solar_core.om_management import (
    compute_period_generation_summary,
    evaluate_commissioning_and_power_quality,
    generate_cm_work_orders_from_analysis,
    get_default_pm_schedule,
    get_default_rca_records,
    get_default_subcontractor_audits,
    get_qaqc_engineering_checklist,
    get_she_dashboard_data,
)
from solar_core.reporting import (
    generate_excel_report,
    generate_html_report,
    generate_pdf_report,
)
from solar_core.storage import OMDatabase


def test_simulated_data_and_fault_detection():
    df, config = generate_simulated_string_data(days=5, interval_minutes=15, num_strings=8, seed=42)
    assert not df.empty
    assert list(df.columns) == CANONICAL_COLUMNS
    assert df["string_id"].nunique() == 8

    results = run_pv_string_analysis(df, config)
    summary = results.string_summary_df.set_index("string_id")

    # STR-01 should be healthy
    assert summary.loc["STR-01", "status"] == "Healthy"

    # STR-03 has simulated afternoon shading
    assert summary.loc["STR-03", "status"] in ("Warning", "Monitor")
    assert "Shading" in summary.loc["STR-03", "primary_diagnosis"]

    # STR-05 has simulated bypassed diode / voltage drop
    assert summary.loc["STR-05", "status"] == "Warning"
    assert "Voltage" in summary.loc["STR-05", "primary_diagnosis"]

    # STR-06 has simulated open circuit on final 2 days
    assert summary.loc["STR-06", "status"] == "Critical"
    assert "Open Circuit" in summary.loc["STR-06", "primary_diagnosis"]

    # Check plant KPIs
    assert results.plant_kpis["total_capacity_kwp"] > 0
    assert 50.0 <= results.plant_kpis["plant_pr_pct"] <= 100.0
    assert results.plant_kpis["recoverable_loss_kwh"] > 0


def test_wide_scada_format_normalization():
    wide_df = pd.DataFrame(
        {
            "timestamp": ["2026-11-10 11:00:00", "2026-11-10 11:15:00"],
            "irradiance": [850.0, 880.0],
            "pv1_u": [720.0, 718.0],
            "pv1_i": [11.2, 11.5],
            "pv2_u": [715.0, 714.0],
            "pv2_i": [11.0, 11.4],
        }
    )
    norm = normalize_dataframe(wide_df)
    assert list(norm.columns) == CANONICAL_COLUMNS
    assert sorted(norm["string_id"].unique().tolist()) == ["STR-01", "STR-02"]
    assert len(norm) == 4


def test_huawei_api_mock_parser():
    client = SolarAPIClient()
    mock_payload = client.build_mock_huawei_payload(dev_id="INV-TEST-01", days=2)
    df = client.parse_huawei_response(mock_payload, inverter_id="INV-TEST-01")
    assert not df.empty
    assert df["string_id"].nunique() == 8
    assert (df["inverter_id"] == "INV-TEST-01").all()


def test_om_engineering_pillars_and_reports():
    df, config = generate_simulated_string_data(days=4, interval_minutes=30, num_strings=8)
    results = run_pv_string_analysis(df, config)

    # 1. Daily/Monthly PR & Loss Waterfall + Improvement Opportunities
    daily_df, monthly_df, waterfall_df, opp_df = compute_period_generation_summary(results.enriched_df, config)
    assert len(daily_df) >= 4
    assert len(monthly_df) >= 6
    assert len(waterfall_df) == 7
    assert len(opp_df) == 4

    # Verify charts build cleanly
    assert plot_daily_generation_and_pr_trend(daily_df) is not None
    assert plot_monthly_generation_and_pr_trend(monthly_df) is not None
    assert plot_energy_loss_waterfall(waterfall_df) is not None

    # 2. PM & CM Work Orders
    pm_df = get_default_pm_schedule()
    cm_df = generate_cm_work_orders_from_analysis(results)
    assert len(pm_df) >= 5
    assert len(cm_df) >= 5

    # 3. Equipment Failure RCA (Inverters, Transformers, Switchgear, Strings)
    rca_df = get_default_rca_records()
    eq_cats = set(rca_df["Equipment_Category"].tolist())
    assert {"Inverter", "Transformer", "Switchgear", "PV String / DC Combiner"}.issubset(eq_cats)

    # 4. Subcontractor QA/QC
    sub_df = get_default_subcontractor_audits()
    qaqc_df = get_qaqc_engineering_checklist()
    assert len(sub_df) == 3
    assert len(qaqc_df) == 4

    # 5. Commissioning & Power Quality Testing
    pq_df, comm_df = evaluate_commissioning_and_power_quality()
    assert (pq_df["Compliant"] == "Pass").all()
    assert len(comm_df) == 5

    # 6. SH&E Compliance
    she_kpis, ptw_df, she_chk_df = get_she_dashboard_data()
    assert she_kpis["lti_count"] == 0
    assert len(ptw_df) >= 3
    assert len(she_chk_df) == 4

    # 7. Management Reports (PDF, 11-sheet Excel, HTML)
    pdf_bytes = generate_pdf_report(results, config, pm_df, cm_df, rca_df, sub_df, pq_df)
    assert pdf_bytes.startswith(b"%PDF")

    excel_bytes = generate_excel_report(results, config, pm_df, cm_df, rca_df, sub_df, pq_df, comm_df, ptw_df)
    assert len(excel_bytes) > 2000

    html_report = generate_html_report(results, config)
    assert "Root Cause Analysis" in html_report and "Subcontractor" in html_report


def test_sqlite_om_database(tmp_path):
    db_file = tmp_path / "test_solar_om.db"
    db = OMDatabase(db_path=db_file)

    pm_loaded = db.load_table("pm_schedule")
    assert len(pm_loaded) == 5

    rca_loaded = db.load_table("rca_register")
    assert len(rca_loaded) == 4
    rca_loaded.loc[0, "RCA_Status"] = "Closed - Verified"
    db.save_table("rca_register", rca_loaded)

    rca_reloaded = db.load_table("rca_register")
    assert rca_reloaded.loc[0, "RCA_Status"] == "Closed - Verified"
