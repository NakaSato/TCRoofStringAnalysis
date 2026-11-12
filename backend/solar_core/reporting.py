"""Report generation module for Solar String & O&M Engineering Analysis.

Exports:
1. Multi-sheet Excel Workbook (.xlsx) with:
   - Plant_Overview
   - Daily_Monthly_PR
   - PR_Improvement_Opportunities
   - String_Performance
   - Anomaly_Log
   - PM_Schedule
   - CM_Work_Orders
   - Equipment_RCA_Log
   - Subcontractor_QAQC
   - Commissioning_PowerQuality
   - SHE_Safety_Log
2. Executive & Technical PDF Report (.pdf) built with fpdf2 (String + O&M + RCA + PQ + SH&E)
3. Standalone Printable HTML Management & Engineering Report (.html)
"""

from __future__ import annotations

import io
from datetime import datetime
from typing import Dict, Optional

import pandas as pd
from fpdf import FPDF

from solar_core.analysis import AnalysisResults
from solar_core.models import PlantConfig
from solar_core.om_management import (
    compute_period_generation_summary,
    evaluate_commissioning_and_power_quality,
    generate_cm_work_orders_from_analysis,
    get_default_pm_schedule,
    get_default_rca_records,
    get_default_subcontractor_audits,
    get_she_dashboard_data,
)


def generate_excel_report(
    results: AnalysisResults,
    config: PlantConfig,
    pm_df: Optional[pd.DataFrame] = None,
    cm_df: Optional[pd.DataFrame] = None,
    rca_df: Optional[pd.DataFrame] = None,
    sub_df: Optional[pd.DataFrame] = None,
    pq_df: Optional[pd.DataFrame] = None,
    comm_df: Optional[pd.DataFrame] = None,
    ptw_df: Optional[pd.DataFrame] = None,
) -> bytes:
    """Generate a comprehensive multi-sheet O&M and String Engineering Excel (.xlsx) workbook."""
    daily_plant, monthly_plant, _, opportunities_df = compute_period_generation_summary(
        results.enriched_df, config
    )
    if pm_df is None:
        pm_df = get_default_pm_schedule()
    if cm_df is None:
        cm_df = generate_cm_work_orders_from_analysis(results)
    if rca_df is None:
        rca_df = get_default_rca_records()
    if sub_df is None:
        sub_df = get_default_subcontractor_audits()
    if pq_df is None or comm_df is None:
        pq_df, comm_df = evaluate_commissioning_and_power_quality()
    if ptw_df is None:
        _, ptw_df, _ = get_she_dashboard_data()

    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        # Sheet 1: Plant Overview KPIs
        kpi_rows = [
            {"Metric": "Plant Name", "Value": config.plant_name, "Unit": ""},
            {"Metric": "Location", "Value": config.location, "Unit": ""},
            {"Metric": "Report Generated At", "Value": datetime.now().strftime("%Y-%m-%d %H:%M"), "Unit": ""},
            {"Metric": "Total Installed DC Capacity", "Value": results.plant_kpis["total_capacity_kwp"], "Unit": "kWp"},
            {"Metric": "Total Monitored Strings", "Value": results.plant_kpis["num_strings"], "Unit": "Strings"},
            {"Metric": "Total DC Energy Yield", "Value": results.plant_kpis["total_energy_kwh"], "Unit": "kWh"},
            {"Metric": "Expected Temperature-Corrected Yield", "Value": results.plant_kpis["expected_energy_kwh"], "Unit": "kWh"},
            {"Metric": "Estimated Recoverable Energy Loss", "Value": results.plant_kpis["recoverable_loss_kwh"], "Unit": "kWh"},
            {"Metric": "Specific Yield", "Value": results.plant_kpis["specific_yield_kwh_kwp"], "Unit": "kWh/kWp"},
            {"Metric": "Reference Yield (Peak Sun Hours)", "Value": results.plant_kpis["reference_yield_psh"], "Unit": "h"},
            {"Metric": "Plant Performance Ratio (PR)", "Value": results.plant_kpis["plant_pr_pct"], "Unit": "%"},
            {"Metric": "Temp-Corrected Performance Ratio", "Value": results.plant_kpis["temp_corrected_pr_pct"], "Unit": "%"},
            {"Metric": "Average String Health Score", "Value": results.plant_kpis["avg_health_score"], "Unit": "/ 100"},
        ]
        pd.DataFrame(kpi_rows).to_excel(writer, sheet_name="Plant_Overview", index=False)

        # Sheet 2: Daily & Monthly PR Trends
        daily_plant.round(2).to_excel(writer, sheet_name="Daily_PR_Trend", index=False)
        monthly_plant.round(2).to_excel(writer, sheet_name="Monthly_PR_Trend", index=False)

        # Sheet 3: PR Improvement Opportunities
        opportunities_df.round(2).to_excel(writer, sheet_name="PR_Opportunities", index=False)

        # Sheet 4: String Performance Summary
        cols_order = [
            "string_id",
            "inverter_id",
            "mppt_id",
            "capacity_kwp",
            "actual_energy_kwh",
            "expected_energy_kwh",
            "specific_yield_kwh_kwp",
            "pr_pct",
            "temp_corrected_pr_pct",
            "capacity_factor_pct",
            "avg_vmp_v",
            "avg_imp_a",
            "peer_gap_pct",
            "estimated_loss_kwh",
            "health_score",
            "status",
            "primary_diagnosis",
            "recommended_action",
        ]
        existing_cols = [c for c in cols_order if c in results.string_summary_df.columns]
        results.string_summary_df[existing_cols].round(2).to_excel(
            writer, sheet_name="String_Performance", index=False
        )

        # Sheet 5: Anomaly Episodes Log
        results.anomalies_df.round(2).to_excel(writer, sheet_name="Anomaly_Log", index=False)

        # Sheet 6: PM Schedule & CM Work Orders
        pm_df.to_excel(writer, sheet_name="PM_Schedule", index=False)
        cm_df.to_excel(writer, sheet_name="CM_Work_Orders", index=False)

        # Sheet 7: Equipment Failure RCA
        rca_df.to_excel(writer, sheet_name="Equipment_RCA", index=False)

        # Sheet 8: Subcontractor QA/QC
        sub_df.to_excel(writer, sheet_name="Subcontractor_QAQC", index=False)

        # Sheet 9: Commissioning & Power Quality
        pq_df.to_excel(writer, sheet_name="Power_Quality", index=False)
        comm_df.to_excel(writer, sheet_name="Commissioning_Tests", index=False)

        # Sheet 10: SH&E Permit-to-Work Log
        ptw_df.to_excel(writer, sheet_name="SHE_Safety_PTW", index=False)

    return buffer.getvalue()


def _pdf_safe(text: str) -> str:
    """Sanitize Unicode punctuation (e.g., em-dash, Ohm) into Latin-1 safe characters for standard PDF fonts."""
    replacements = {
        "—": "-",
        "–": "-",
        "Ω": "Ohm",
        "•": "*",
        "“": '"',
        "”": '"',
        "’": "'",
    }
    out = str(text)
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out.encode("latin-1", errors="replace").decode("latin-1")


class _SolarPDFReport(FPDF):
    def __init__(self, plant_name: str):
        super().__init__(orientation="L", unit="mm", format="A4")
        self.plant_name = _pdf_safe(plant_name)

    def header(self):
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(20, 50, 90)
        self.cell(
            0,
            8,
            f"Solar PV Engineering & O&M Management Report - {self.plant_name}",
            new_x="LMARGIN",
            new_y="NEXT",
        )
        self.set_draw_color(200, 210, 225)
        self.line(10, self.get_y(), 287, self.get_y())
        self.ln(3)

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(120, 120, 120)
        self.cell(
            0,
            8,
            f"TC Roof Solar O&M Engineering Suite | IEC 61724 / IEC 62446 / IEEE 519 / SH&E Compliant | Page {self.page_no()}/{{nb}}",
            align="C",
        )


def generate_pdf_report(
    results: AnalysisResults,
    config: PlantConfig,
    pm_df: Optional[pd.DataFrame] = None,
    cm_df: Optional[pd.DataFrame] = None,
    rca_df: Optional[pd.DataFrame] = None,
    sub_df: Optional[pd.DataFrame] = None,
    pq_df: Optional[pd.DataFrame] = None,
) -> bytes:
    """Generate a multi-page Landscape A4 Engineering & O&M Management PDF Report."""
    _, _, _, opportunities_df = compute_period_generation_summary(results.enriched_df, config)
    if pm_df is None:
        pm_df = get_default_pm_schedule()
    if cm_df is None:
        cm_df = generate_cm_work_orders_from_analysis(results)
    if rca_df is None:
        rca_df = get_default_rca_records()
    if sub_df is None:
        sub_df = get_default_subcontractor_audits()
    if pq_df is None:
        pq_df, _ = evaluate_commissioning_and_power_quality()
    she_kpis, _, _ = get_she_dashboard_data()

    pdf = _SolarPDFReport(plant_name=config.plant_name)
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=14)

    # -----------------------------------------------------------------------
    # PAGE 1: Executive KPIs, String Performance & PR Improvement Plan
    # -----------------------------------------------------------------------
    pdf.add_page()
    kpis = results.plant_kpis
    min_ts = pd.to_datetime(results.enriched_df["timestamp"].min()).strftime("%Y-%m-%d %H:%M")
    max_ts = pd.to_datetime(results.enriched_df["timestamp"].max()).strftime("%Y-%m-%d %H:%M")

    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(60, 60, 60)
    pdf.cell(
        0,
        6,
        f"Location: {config.location}   |   Analysis Period: {min_ts} to {max_ts}   |   Safe Man-Hours: {she_kpis['safe_man_hours']:,} (0 LTI)",
        new_x="LMARGIN",
        new_y="NEXT",
    )
    pdf.ln(2)

    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 50, 90)
    pdf.cell(0, 7, "1. Executive Plant & O&M KPI Summary", new_x="LMARGIN", new_y="NEXT")

    card_items = [
        ("Installed Capacity", f"{kpis['total_capacity_kwp']:.2f} kWp"),
        ("Total DC Yield", f"{kpis['total_energy_kwh']:.1f} kWh"),
        ("Specific Yield", f"{kpis['specific_yield_kwh_kwp']:.2f} kWh/kWp"),
        ("Performance Ratio (PR)", f"{kpis['plant_pr_pct']:.1f} %"),
        ("Temp-Corrected PR", f"{kpis['temp_corrected_pr_pct']:.1f} %"),
        ("Recoverable Loss", f"{kpis['recoverable_loss_kwh']:.1f} kWh"),
        ("Fleet Health Status", f"{kpis['healthy_strings']} OK / {kpis['warning_strings']} Warn / {kpis['critical_strings']} Crit"),
    ]

    col_w = 39.5
    pdf.set_fill_color(242, 246, 252)
    pdf.set_draw_color(210, 220, 235)
    pdf.set_font("Helvetica", "B", 8.5)
    for title, _ in card_items:
        pdf.cell(col_w, 6, title, border=1, align="C", fill=True)
    pdf.ln()

    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(15, 35, 65)
    for _, val in card_items:
        pdf.cell(col_w, 8, val, border=1, align="C")
    pdf.ln(9)

    # Section 2: String-Level Performance Table
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 50, 90)
    pdf.cell(0, 7, "2. String-by-String Performance & Fault Diagnosis", new_x="LMARGIN", new_y="NEXT")

    headers = [
        ("String", 20),
        ("Inverter", 22),
        ("MPPT", 18),
        ("Cap (kWp)", 20),
        ("Yield (kWh)", 23),
        ("Spec.Yield", 21),
        ("PR (%)", 17),
        ("Avg Vmp (V)", 23),
        ("Avg Imp (A)", 22),
        ("Peer Gap (%)", 23),
        ("Loss (kWh)", 21),
        ("Status", 20),
        ("Primary Diagnosis", 27),
    ]

    pdf.set_font("Helvetica", "B", 8)
    pdf.set_fill_color(30, 65, 110)
    pdf.set_text_color(255, 255, 255)
    for h_text, h_w in headers:
        pdf.cell(h_w, 7, h_text, border=1, align="C", fill=True)
    pdf.ln()

    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(30, 30, 30)

    for idx, row in results.string_summary_df.iterrows():
        status = str(row["status"])
        if status == "Critical":
            pdf.set_fill_color(254, 226, 226)
        elif status in ("Warning", "Monitor"):
            pdf.set_fill_color(254, 243, 199)
        else:
            pdf.set_fill_color(248, 250, 252) if idx % 2 == 0 else pdf.set_fill_color(255, 255, 255)

        vals = [
            (str(row["string_id"]), 20, "C"),
            (str(row["inverter_id"]), 22, "C"),
            (str(row["mppt_id"]), 18, "C"),
            (f"{row['capacity_kwp']:.2f}", 20, "R"),
            (f"{row['actual_energy_kwh']:.1f}", 23, "R"),
            (f"{row['specific_yield_kwh_kwp']:.2f}", 21, "R"),
            (f"{row['pr_pct']:.1f}%", 17, "R"),
            (f"{row['avg_vmp_v']:.1f}", 23, "R"),
            (f"{row['avg_imp_a']:.2f}", 22, "R"),
            (f"{row['peer_gap_pct']:+.1f}%", 23, "R"),
            (f"{row['estimated_loss_kwh']:.1f}", 21, "R"),
            (status, 20, "C"),
            (str(row["primary_diagnosis"])[:18], 27, "L"),
        ]
        for text, width, align in vals:
            pdf.cell(width, 6, text, border=1, align=align, fill=True)
        pdf.ln()

    pdf.ln(5)

    # Section 3: PR Improvement Opportunities
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 50, 90)
    pdf.cell(0, 7, "3. Identified Performance Ratio (PR) Improvement Opportunities", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(30, 30, 30)
    for _, opp in opportunities_df.iterrows():
        line = _pdf_safe(
            f"[{opp['Opportunity_ID']} - {opp['Priority']}] {opp['Improvement_Initiative']} | "
            f"Recoverable: {opp['Recoverable_Energy_kWh']:.1f} kWh (+{opp['Estimated_PR_Gain_Pct']:.2f}% PR, THB {opp['Revenue_Recovery_THB']:,.0f})"
        )
        pdf.multi_cell(0, 5, line, new_x="LMARGIN", new_y="NEXT")

    # -----------------------------------------------------------------------
    # PAGE 2: O&M (PM/CM), Equipment RCA, Subcontractor QA, PQ & SH&E
    # -----------------------------------------------------------------------
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 50, 90)
    pdf.cell(0, 7, "4. Corrective Maintenance (CM) Work Orders & Troubleshooting", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8.2)
    pdf.set_text_color(30, 30, 30)
    for _, wo in cm_df.iterrows():
        pdf.multi_cell(
            0,
            5,
            _pdf_safe(
                f"[{wo['WO_Number']} | {wo['Priority']} | {wo['Status']}] {wo['Asset_ID']} - {wo['Fault_Symptom']} -> {wo['Troubleshooting_Checklist']}"
            ),
            new_x="LMARGIN",
            new_y="NEXT",
        )
    pdf.ln(3)

    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 50, 90)
    pdf.cell(0, 7, "5. Root Cause Analysis (RCA) Summary (Inverters, Transformers, Switchgear & Strings)", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8.2)
    pdf.set_text_color(30, 30, 30)
    for _, rca in rca_df.iterrows():
        pdf.multi_cell(
            0,
            5,
            _pdf_safe(
                f"[{rca['RCA_ID']} | {rca['Equipment_Category']} - {rca['Asset_ID']}] Failure: {rca['Failure_Mode']} | "
                f"Root Cause: {rca['Why_5_Root_Cause']} | CAPA: {rca['CAPA_Corrective_Action']}"
            ),
            new_x="LMARGIN",
            new_y="NEXT",
        )
    pdf.ln(3)

    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 50, 90)
    pdf.cell(0, 7, "6. Subcontractor QA/QC, Power Quality Compliance & SH&E Summary", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(30, 30, 30)

    for _, sub in sub_df.iterrows():
        pdf.cell(
            0,
            5.5,
            _pdf_safe(
                f"Subcontractor: {sub['Subcontractor_Name']} | Workmanship: {sub['Workmanship_Score_Pct']:.0f}% | "
                f"Eng. Std: {sub['Engineering_Std_Compliance_Pct']:.0f}% | SH&E: {sub['Safety_SHE_Compliance_Pct']:.0f}% | Rating: {sub['Overall_Rating']}"
            ),
            new_x="LMARGIN",
            new_y="NEXT",
        )

    pq_pass_cnt = int((pq_df["Compliant"] == "Pass").sum())
    pdf.cell(
        0,
        5.5,
        f"Power Quality & Grid Code (IEEE 519 / PEA-MEA): {pq_pass_cnt}/{len(pq_df)} Parameters Compliant | "
        f"SH&E Performance: {she_kpis['days_without_lti']} Days Zero LTI, 100% PTW & LOTO Compliance.",
        new_x="LMARGIN",
        new_y="NEXT",
    )

    return bytes(pdf.output())


def generate_html_report(results: AnalysisResults, config: PlantConfig) -> str:
    """Generate a standalone, self-contained HTML Management & Engineering O&M Summary Report."""
    kpis = results.plant_kpis
    _, _, _, opportunities_df = compute_period_generation_summary(results.enriched_df, config)
    cm_df = generate_cm_work_orders_from_analysis(results)
    rca_df = get_default_rca_records()
    sub_df = get_default_subcontractor_audits()
    pq_df, _ = evaluate_commissioning_and_power_quality()
    she_kpis, _, _ = get_she_dashboard_data()

    min_ts = pd.to_datetime(results.enriched_df["timestamp"].min()).strftime("%Y-%m-%d %H:%M")
    max_ts = pd.to_datetime(results.enriched_df["timestamp"].max()).strftime("%Y-%m-%d %H:%M")

    rows_html = []
    for _, row in results.string_summary_df.iterrows():
        status = str(row["status"])
        badge_class = (
            "badge-crit"
            if status == "Critical"
            else ("badge-warn" if status in ("Warning", "Monitor") else "badge-ok")
        )
        rows_html.append(
            f"""
            <tr>
                <td><strong>{row['string_id']}</strong></td>
                <td>{row['inverter_id']}</td>
                <td>{row['mppt_id']}</td>
                <td class="num">{row['capacity_kwp']:.2f}</td>
                <td class="num">{row['actual_energy_kwh']:.1f}</td>
                <td class="num">{row['specific_yield_kwh_kwp']:.2f}</td>
                <td class="num">{row['pr_pct']:.1f}%</td>
                <td class="num">{row['avg_vmp_v']:.1f} V</td>
                <td class="num">{row['avg_imp_a']:.2f} A</td>
                <td class="num">{row['peer_gap_pct']:+.1f}%</td>
                <td class="num">{row['estimated_loss_kwh']:.1f}</td>
                <td><span class="badge {badge_class}">{status}</span></td>
                <td><strong>{row['primary_diagnosis']}</strong><br><small>{row['recommended_action']}</small></td>
            </tr>
            """
        )

    opp_rows_html = []
    for _, opp in opportunities_df.iterrows():
        opp_rows_html.append(
            f"""
            <tr>
                <td><strong>{opp['Opportunity_ID']}</strong></td>
                <td>{opp['Action_Category']}</td>
                <td>{opp['Improvement_Initiative']}</td>
                <td class="num">{opp['Recoverable_Energy_kWh']:.1f} kWh</td>
                <td class="num">+{opp['Estimated_PR_Gain_Pct']:.2f}%</td>
                <td class="num">THB {opp['Revenue_Recovery_THB']:,.0f}</td>
                <td><strong>{opp['Priority']}</strong></td>
            </tr>
            """
        )

    rca_rows_html = []
    for _, rca in rca_df.iterrows():
        rca_rows_html.append(
            f"""
            <tr>
                <td><strong>{rca['RCA_ID']}</strong></td>
                <td>{rca['Equipment_Category']}<br><small>{rca['Asset_ID']}</small></td>
                <td>{rca['Failure_Mode']}</td>
                <td>{rca['Why_5_Root_Cause']}</td>
                <td>{rca['CAPA_Corrective_Action']}<br><small><strong>Preventive:</strong> {rca['CAPA_Preventive_Action']}</small></td>
                <td><span class="badge badge-ok">{rca['RCA_Status']}</span></td>
            </tr>
            """
        )

    sub_rows_html = []
    for _, sub in sub_df.iterrows():
        sub_rows_html.append(
            f"""
            <tr>
                <td><strong>{sub['Subcontractor_Name']}</strong></td>
                <td>{sub['Scope_of_Work']}</td>
                <td class="num">{sub['Workmanship_Score_Pct']:.0f}%</td>
                <td class="num">{sub['Engineering_Std_Compliance_Pct']:.0f}%</td>
                <td class="num">{sub['Safety_SHE_Compliance_Pct']:.0f}%</td>
                <td>{sub['Torque_Seal_Verified']}</td>
                <td><strong>{sub['Overall_Rating']}</strong></td>
            </tr>
            """
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Solar PV Engineering & O&M Management Report - {config.plant_name}</title>
<style>
    body {{
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1e293b;
        background: #f8fafc;
        margin: 0;
        padding: 28px;
    }}
    .container {{
        max-width: 1280px;
        margin: 0 auto;
        background: #ffffff;
        padding: 32px;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
    }}
    h1 {{ margin: 0 0 6px 0; color: #0f172a; font-size: 24px; }}
    h2 {{ margin-top: 28px; color: #1e3a8a; font-size: 18px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }}
    .meta {{
        color: #64748b;
        font-size: 14px;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid #e2e8f0;
    }}
    .kpi-grid {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
        gap: 12px;
        margin-bottom: 24px;
    }}
    .kpi-card {{
        background: #f1f5f9;
        border-radius: 8px;
        padding: 12px 14px;
        border-left: 4px solid #0284c7;
    }}
    .kpi-label {{
        font-size: 11px;
        text-transform: uppercase;
        color: #475569;
        font-weight: 600;
    }}
    .kpi-val {{
        font-size: 20px;
        font-weight: 700;
        color: #0f172a;
        margin-top: 4px;
    }}
    table {{
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
        margin-top: 10px;
    }}
    th {{
        background: #1e3a8a;
        color: #ffffff;
        padding: 9px 8px;
        text-align: left;
    }}
    td {{
        padding: 9px 8px;
        border-bottom: 1px solid #e2e8f0;
        vertical-align: top;
    }}
    td.num {{
        text-align: right;
        font-variant-numeric: tabular-nums;
    }}
    .badge {{
        display: inline-block;
        padding: 3px 8px;
        border-radius: 999px;
        font-weight: 600;
        font-size: 11px;
    }}
    .badge-ok {{ background: #dcfce7; color: #166534; }}
    .badge-warn {{ background: #fef3c7; color: #92400e; }}
    .badge-crit {{ background: #fee2e2; color: #991b1b; }}
    small {{ color: #64748b; display: block; margin-top: 3px; }}
</style>
</head>
<body>
<div class="container">
    <h1>Solar PV Engineering & O&M Management Summary — {config.plant_name}</h1>
    <div class="meta">
        Location: <strong>{config.location}</strong> &nbsp;|&nbsp;
        Period: <strong>{min_ts}</strong> to <strong>{max_ts}</strong> &nbsp;|&nbsp;
        Standards: <strong>IEC 61724-1 / IEC 62446-1 / IEEE 519 / ISO 45001 SH&E</strong>
    </div>

    <div class="kpi-grid">
        <div class="kpi-card">
            <div class="kpi-label">Installed DC Capacity</div>
            <div class="kpi-val">{kpis['total_capacity_kwp']:.2f} kWp</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Total DC Energy Yield</div>
            <div class="kpi-val">{kpis['total_energy_kwh']:.1f} kWh</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Performance Ratio (PR)</div>
            <div class="kpi-val">{kpis['plant_pr_pct']:.1f} %</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Temp-Corrected PR</div>
            <div class="kpi-val">{kpis['temp_corrected_pr_pct']:.1f} %</div>
        </div>
        <div class="kpi-card" style="border-left-color: #dc2626;">
            <div class="kpi-label">Recoverable Loss</div>
            <div class="kpi-val">{kpis['recoverable_loss_kwh']:.1f} kWh</div>
        </div>
        <div class="kpi-card" style="border-left-color: #16a34a;">
            <div class="kpi-label">SH&E Zero-LTI Streak</div>
            <div class="kpi-val">{she_kpis['days_without_lti']} Days</div>
        </div>
        <div class="kpi-card" style="border-left-color: #2563eb;">
            <div class="kpi-label">Open CM Work Orders</div>
            <div class="kpi-val">{len(cm_df)} Active</div>
        </div>
    </div>

    <h2>1. Identified Performance Ratio (PR) Improvement Opportunities</h2>
    <table>
        <thead>
            <tr>
                <th>ID</th>
                <th>Category</th>
                <th>Improvement Initiative</th>
                <th>Recoverable Energy</th>
                <th>Est. PR Gain</th>
                <th>Revenue Recovery</th>
                <th>Priority</th>
            </tr>
        </thead>
        <tbody>
            {''.join(opp_rows_html)}
        </tbody>
    </table>

    <h2>2. String-Level Performance & Automated O&M Diagnosis</h2>
    <table>
        <thead>
            <tr>
                <th>String</th>
                <th>Inverter</th>
                <th>MPPT</th>
                <th>Cap (kWp)</th>
                <th>Yield (kWh)</th>
                <th>Spec. Yield</th>
                <th>PR (%)</th>
                <th>Avg Vmp</th>
                <th>Avg Imp</th>
                <th>Peer Gap</th>
                <th>Loss (kWh)</th>
                <th>Status</th>
                <th>Diagnosis & Recommended Action</th>
            </tr>
        </thead>
        <tbody>
            {''.join(rows_html)}
        </tbody>
    </table>

    <h2>3. Root Cause Analysis (RCA) for Equipment Failures (Inverters, Transformers, Switchgear & Strings)</h2>
    <table>
        <thead>
            <tr>
                <th>RCA ID</th>
                <th>Equipment & Asset</th>
                <th>Failure Mode</th>
                <th>Verified Root Cause (5-Why)</th>
                <th>CAPA (Corrective & Preventive Actions)</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>
            {''.join(rca_rows_html)}
        </tbody>
    </table>

    <h2>4. Subcontractor Supervision & Engineering QA/QC Compliance</h2>
    <table>
        <thead>
            <tr>
                <th>Subcontractor</th>
                <th>Scope of Work</th>
                <th>Workmanship</th>
                <th>Eng. Standards</th>
                <th>SH&E Safety</th>
                <th>Torque & QA Verification</th>
                <th>Rating</th>
            </tr>
        </thead>
        <tbody>
            {''.join(sub_rows_html)}
        </tbody>
    </table>
</div>
</body>
</html>
"""
    return html
