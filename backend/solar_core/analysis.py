"""PV String Performance Analysis & Fault Detection Engine (IEC 61724 standard).

Computes:
1. Time-step interval integration (dt hours)
2. Plant-level & String-level KPIs:
   - Actual DC Energy Yield (kWh)
   - Expected STC & Temperature-corrected Energy (kWh)
   - Reference Yield Y_r (kWh/m² or peak sun hours)
   - Specific Yield Y_f (kWh / kWp)
   - Performance Ratio PR (%) and Temperature-Corrected PR_temp (%)
   - Capacity Factor CF (%)
   - Peer Median Comparison & Energy Loss Breakdown (kWh & %)
3. Automated Fault & Anomaly Diagnosis per String:
   - Open Circuit / Blown Fuse / Disconnected String (Zero current under active irradiance)
   - Bypassed Diode / Sub-string Voltage Drop (Low Vmp relative to peer strings)
   - Partial Shading / Current Mismatch (Afternoon or time-windowed current deficit)
   - General Soiling / Degradation Underperformance
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from solar_core.models import PlantConfig, StringSpec


@dataclass
class AnalysisResults:
    """Container for all computed PV string analysis outputs."""
    enriched_df: pd.DataFrame
    string_summary_df: pd.DataFrame
    daily_string_df: pd.DataFrame
    anomalies_df: pd.DataFrame
    plant_kpis: Dict[str, float]


def infer_interval_hours(df: pd.DataFrame) -> float:
    """Infer typical sampling interval in hours from timestamps."""
    unique_ts = pd.Series(df["timestamp"].unique()).sort_values()
    if len(unique_ts) < 2:
        return 0.25  # default 15 min
    diffs_sec = unique_ts.diff().dropna().dt.total_seconds()
    median_sec = float(diffs_sec.median())
    if median_sec <= 0:
        return 0.25
    return median_sec / 3600.0


def ensure_plant_config_matches_df(df: pd.DataFrame, config: Optional[PlantConfig] = None) -> PlantConfig:
    """Ensure every string_id in `df` has a corresponding `StringSpec` in `config`."""
    if config is None:
        config = PlantConfig()

    unique_strings = sorted(df["string_id"].unique())
    for idx, str_id in enumerate(unique_strings, start=1):
        if str_id not in config.strings:
            sub = df[df["string_id"] == str_id]
            inv_id = str(sub["inverter_id"].iloc[0]) if "inverter_id" in sub.columns else "INV-01"
            mppt_id = str(sub["mppt_id"].iloc[0]) if "mppt_id" in sub.columns else f"MPPT-{((idx - 1) // 2) + 1}"
            config.strings[str_id] = StringSpec(
                string_id=str_id,
                inverter_id=inv_id,
                mppt_id=mppt_id,
            )
    return config


def run_pv_string_analysis(
    df: pd.DataFrame,
    config: Optional[PlantConfig] = None,
) -> AnalysisResults:
    """Run complete IEC 61724 PV string performance analysis and anomaly diagnosis."""
    if df.empty:
        raise ValueError("Cannot analyze an empty DataFrame.")

    config = ensure_plant_config_matches_df(df, config)
    dt_hours = infer_interval_hours(df)

    work = df.copy().sort_values(["timestamp", "string_id"]).reset_index(drop=True)
    work["dt_hours"] = dt_hours

    # Map string specifications
    cap_map = {s_id: spec.capacity_kwp for s_id, spec in config.strings.items()}
    gamma_map = {s_id: spec.temp_coeff_pmax for s_id, spec in config.strings.items()}
    vmp_stc_map = {s_id: spec.string_vmp_stc for s_id, spec in config.strings.items()}
    imp_stc_map = {s_id: spec.imp_stc for s_id, spec in config.strings.items()}

    work["capacity_kwp"] = work["string_id"].map(cap_map).fillna(9.9)
    work["gamma_pmax"] = work["string_id"].map(gamma_map).fillna(-0.0035)
    work["vmp_stc"] = work["string_id"].map(vmp_stc_map).fillna(754.2)
    work["imp_stc"] = work["string_id"].map(imp_stc_map).fillna(13.13)

    # Energy per interval (kWh)
    work["energy_kwh"] = (work["power_w"] / 1000.0) * dt_hours
    work["insolation_kwh_m2"] = (work["irradiance_wm2"] / 1000.0) * dt_hours

    # Expected power at STC and Temperature-Corrected
    work["expected_power_stc_w"] = (
        work["capacity_kwp"] * 1000.0 * (work["irradiance_wm2"] / 1000.0)
    )
    temp_correction = 1.0 + work["gamma_pmax"] * (work["module_temp_c"] - 25.0)
    work["expected_power_temp_corr_w"] = (
        work["expected_power_stc_w"] * temp_correction * (1.0 - config.system_loss_factor)
    ).clip(lower=0.0)

    work["expected_energy_kwh"] = (work["expected_power_temp_corr_w"] / 1000.0) * dt_hours

    # Peer group benchmarks at each timestamp
    peer_stats = (
        work.groupby("timestamp")
        .agg(
            peer_median_current_a=("current_a", "median"),
            peer_median_voltage_v=("voltage_v", "median"),
            peer_median_power_w=("power_w", "median"),
            peer_max_power_w=("power_w", "max"),
        )
        .reset_index()
    )
    work = work.merge(peer_stats, on="timestamp", how="left")

    # Normalized specific power (W/kWp) for fair comparison across strings of different sizes
    work["specific_power_w_kwp"] = work["power_w"] / work["capacity_kwp"]
    peer_spec_median = work.groupby("timestamp")["specific_power_w_kwp"].transform("median")
    work["peer_median_specific_power"] = peer_spec_median

    # Deviation (%) from peer median during active sunshine (POA >= min_irradiance_for_anomaly_wm2)
    active_mask = work["irradiance_wm2"] >= config.min_irradiance_for_anomaly_wm2
    work["current_dev_pct"] = np.where(
        active_mask & (work["peer_median_current_a"] > 0.5),
        ((work["current_a"] - work["peer_median_current_a"]) / work["peer_median_current_a"]) * 100.0,
        0.0,
    )
    work["voltage_dev_pct"] = np.where(
        active_mask & (work["peer_median_voltage_v"] > 100.0),
        ((work["voltage_v"] - work["peer_median_voltage_v"]) / work["peer_median_voltage_v"]) * 100.0,
        0.0,
    )
    work["power_dev_pct"] = np.where(
        active_mask & (work["peer_median_specific_power"] > 20.0),
        (
            (work["specific_power_w_kwp"] - work["peer_median_specific_power"])
            / work["peer_median_specific_power"]
        )
        * 100.0,
        0.0,
    )

    # Interval-level anomaly classification
    work["interval_fault"] = "Normal"
    zero_curr_cond = active_mask & (work["current_a"] <= config.zero_current_threshold_a)
    volt_drop_cond = (
        active_mask
        & (~zero_curr_cond)
        & (work["voltage_dev_pct"] <= -7.5)
    )
    curr_drop_cond = (
        active_mask
        & (~zero_curr_cond)
        & (~volt_drop_cond)
        & (work["current_dev_pct"] <= -config.underperformance_threshold_pct)
    )

    work.loc[curr_drop_cond, "interval_fault"] = "Shading / Current Mismatch"
    work.loc[volt_drop_cond, "interval_fault"] = "Bypassed Diode / Voltage Drop"
    work.loc[zero_curr_cond, "interval_fault"] = "Open Circuit / Zero Current"

    # Compute daily string aggregation
    work["date"] = work["timestamp"].dt.date
    daily_string_df = _build_daily_string_summary(work)

    # Compute overall string summary table
    string_summary_df = _build_string_summary(work, config)

    # Extract detailed anomaly events log
    anomalies_df = _build_anomalies_log(work, string_summary_df, config)

    # Compute Plant-level KPIs
    plant_kpis = _compute_plant_kpis(work, string_summary_df, config)

    return AnalysisResults(
        enriched_df=work,
        string_summary_df=string_summary_df,
        daily_string_df=daily_string_df,
        anomalies_df=anomalies_df,
        plant_kpis=plant_kpis,
    )


def _build_daily_string_summary(work: pd.DataFrame) -> pd.DataFrame:
    daily = (
        work.groupby(["date", "string_id", "inverter_id", "mppt_id"], as_index=False)
        .agg(
            capacity_kwp=("capacity_kwp", "first"),
            energy_kwh=("energy_kwh", "sum"),
            expected_energy_kwh=("expected_energy_kwh", "sum"),
            reference_yield_psh=("insolation_kwh_m2", "sum"),
            peak_power_w=("power_w", "max"),
            avg_module_temp_c=("module_temp_c", "mean"),
        )
    )
    daily["specific_yield_kwh_kwp"] = daily["energy_kwh"] / daily["capacity_kwp"]
    daily["pr_pct"] = np.where(
        daily["reference_yield_psh"] > 0.1,
        (daily["specific_yield_kwh_kwp"] / daily["reference_yield_psh"]) * 100.0,
        0.0,
    ).clip(0.0, 105.0)
    return daily.sort_values(["date", "string_id"]).reset_index(drop=True)


def _build_string_summary(work: pd.DataFrame, config: PlantConfig) -> pd.DataFrame:
    total_hours = work["timestamp"].nunique() * float(work["dt_hours"].iloc[0])
    active_work = work[work["irradiance_wm2"] >= config.min_irradiance_for_anomaly_wm2]

    grouped = (
        work.groupby(["string_id", "inverter_id", "mppt_id"], as_index=False)
        .agg(
            capacity_kwp=("capacity_kwp", "first"),
            actual_energy_kwh=("energy_kwh", "sum"),
            expected_energy_kwh=("expected_energy_kwh", "sum"),
            reference_yield_psh=("insolation_kwh_m2", "sum"),
            peak_power_kw=("power_w", lambda s: s.max() / 1000.0),
        )
    )

    if not active_work.empty:
        active_stats = (
            active_work.groupby("string_id", as_index=False)
            .agg(
                avg_vmp_v=("voltage_v", "mean"),
                avg_imp_a=("current_a", "mean"),
                mean_voltage_dev_pct=("voltage_dev_pct", "mean"),
                mean_current_dev_pct=("current_dev_pct", "mean"),
                mean_power_dev_pct=("power_dev_pct", "mean"),
                zero_current_intervals=("interval_fault", lambda s: int((s == "Open Circuit / Zero Current").sum())),
                voltage_drop_intervals=("interval_fault", lambda s: int((s == "Bypassed Diode / Voltage Drop").sum())),
                shading_intervals=("interval_fault", lambda s: int((s == "Shading / Current Mismatch").sum())),
                active_intervals=("interval_fault", "count"),
            )
        )
    else:
        active_stats = pd.DataFrame(
            {
                "string_id": grouped["string_id"],
                "avg_vmp_v": 0.0,
                "avg_imp_a": 0.0,
                "mean_voltage_dev_pct": 0.0,
                "mean_current_dev_pct": 0.0,
                "mean_power_dev_pct": 0.0,
                "zero_current_intervals": 0,
                "voltage_drop_intervals": 0,
                "shading_intervals": 0,
                "active_intervals": 1,
            }
        )

    summary = grouped.merge(active_stats, on="string_id", how="left")
    summary["specific_yield_kwh_kwp"] = summary["actual_energy_kwh"] / summary["capacity_kwp"]

    # IEC 61724 Performance Ratio (%)
    summary["pr_pct"] = np.where(
        summary["reference_yield_psh"] > 0.01,
        (summary["specific_yield_kwh_kwp"] / summary["reference_yield_psh"]) * 100.0,
        0.0,
    ).clip(0.0, 105.0)

    # Temperature-Corrected Performance Ratio (%)
    summary["temp_corrected_pr_pct"] = np.where(
        summary["expected_energy_kwh"] > 0.01,
        (summary["actual_energy_kwh"] / summary["expected_energy_kwh"]) * (1.0 - config.system_loss_factor) * 100.0,
        0.0,
    ).clip(0.0, 110.0)

    # Capacity Factor (%)
    summary["capacity_factor_pct"] = np.where(
        total_hours > 0,
        (summary["actual_energy_kwh"] / (summary["capacity_kwp"] * total_hours)) * 100.0,
        0.0,
    )

    # Peer comparison against median specific yield
    peer_median_sy = float(summary["specific_yield_kwh_kwp"].median())
    summary["peer_gap_pct"] = np.where(
        peer_median_sy > 0,
        ((summary["specific_yield_kwh_kwp"] - peer_median_sy) / peer_median_sy) * 100.0,
        0.0,
    )
    summary["estimated_loss_kwh"] = np.maximum(
        0.0, (peer_median_sy - summary["specific_yield_kwh_kwp"]) * summary["capacity_kwp"]
    )

    # Health Score (0 - 100) and Status Diagnosis
    statuses: List[str] = []
    diagnoses: List[str] = []
    recommendations: List[str] = []
    health_scores: List[float] = []

    for _, row in summary.iterrows():
        act_cnt = max(1, int(row["active_intervals"]))
        zero_ratio = row["zero_current_intervals"] / act_cnt
        vdrop_ratio = row["voltage_drop_intervals"] / act_cnt
        shade_ratio = row["shading_intervals"] / act_cnt
        gap = float(row["peer_gap_pct"])

        score = max(0.0, min(100.0, 100.0 + min(0.0, gap * 1.8) - zero_ratio * 60.0))
        health_scores.append(round(score, 1))

        if zero_ratio >= 0.08:
            statuses.append("Critical")
            diagnoses.append("Open Circuit / Blown Fuse")
            recommendations.append(
                "Inspect DC string fuse, MC4 connectors, and combiner box breaker; string recorded zero current during active irradiance."
            )
        elif vdrop_ratio >= 0.15 or row["mean_voltage_dev_pct"] <= -7.0:
            statuses.append("Warning")
            diagnoses.append("Bypassed Diode / Voltage Mismatch")
            recommendations.append(
                "Perform I-V curve trace and infrared thermography on string modules; operating voltage Vmp is significantly below peer strings."
            )
        elif shade_ratio >= 0.10 or gap <= -config.underperformance_threshold_pct:
            statuses.append("Warning")
            diagnoses.append("Partial Shading / Current Deficit")
            recommendations.append(
                "Check for rooftop obstructions, inter-row shading, or localized heavy soiling reducing string current during peak/afternoon hours."
            )
        elif gap <= -5.0:
            statuses.append("Monitor")
            diagnoses.append("Mild Underperformance / Soiling")
            recommendations.append(
                "Schedule module cleaning and monitor string PR trend over the next 7 days."
            )
        else:
            statuses.append("Healthy")
            diagnoses.append("Normal Operation")
            recommendations.append("No corrective action required.")

    summary["health_score"] = health_scores
    summary["status"] = statuses
    summary["primary_diagnosis"] = diagnoses
    summary["recommended_action"] = recommendations

    return summary.sort_values("string_id").reset_index(drop=True)


def _build_anomalies_log(
    work: pd.DataFrame, string_summary_df: pd.DataFrame, config: PlantConfig
) -> pd.DataFrame:
    """Summarize distinct fault episodes by string and date."""
    fault_rows = work[work["interval_fault"] != "Normal"].copy()
    if fault_rows.empty:
        return pd.DataFrame(
            columns=[
                "date",
                "string_id",
                "inverter_id",
                "mppt_id",
                "fault_type",
                "start_time",
                "end_time",
                "duration_hours",
                "avg_irradiance_wm2",
                "avg_voltage_v",
                "avg_current_a",
                "estimated_loss_kwh",
                "severity",
            ]
        )

    fault_rows["peer_power_loss_w"] = np.maximum(
        0.0,
        (fault_rows["peer_median_specific_power"] - fault_rows["specific_power_w_kwp"])
        * fault_rows["capacity_kwp"],
    )
    fault_rows["interval_loss_kwh"] = (fault_rows["peer_power_loss_w"] / 1000.0) * fault_rows["dt_hours"]

    episodes = (
        fault_rows.groupby(["date", "string_id", "inverter_id", "mppt_id", "interval_fault"], as_index=False)
        .agg(
            start_time=("timestamp", lambda s: s.min().strftime("%H:%M")),
            end_time=("timestamp", lambda s: s.max().strftime("%H:%M")),
            duration_hours=("dt_hours", "sum"),
            avg_irradiance_wm2=("irradiance_wm2", "mean"),
            avg_voltage_v=("voltage_v", "mean"),
            avg_current_a=("current_a", "mean"),
            estimated_loss_kwh=("interval_loss_kwh", "sum"),
        )
        .rename(columns={"interval_fault": "fault_type"})
    )

    # Filter out single-interval transient noise (< 0.5 hr unless Open Circuit)
    episodes = episodes[
        (episodes["duration_hours"] >= 0.5) | (episodes["fault_type"] == "Open Circuit / Zero Current")
    ].copy()

    episodes["severity"] = np.where(
        episodes["fault_type"] == "Open Circuit / Zero Current",
        "Critical",
        np.where(episodes["estimated_loss_kwh"] >= 2.0, "High", "Medium"),
    )

    return episodes.sort_values(["date", "string_id", "start_time"], ascending=[False, True, True]).reset_index(drop=True)


def _compute_plant_kpis(
    work: pd.DataFrame, string_summary_df: pd.DataFrame, config: PlantConfig
) -> Dict[str, float]:
    total_cap_kwp = float(string_summary_df["capacity_kwp"].sum())
    total_energy_kwh = float(string_summary_df["actual_energy_kwh"].sum())
    total_expected_kwh = float(string_summary_df["expected_energy_kwh"].sum())
    total_loss_kwh = float(string_summary_df["estimated_loss_kwh"].sum())
    ref_yield_psh = float(string_summary_df["reference_yield_psh"].mean())

    specific_yield = total_energy_kwh / total_cap_kwp if total_cap_kwp > 0 else 0.0
    plant_pr = (specific_yield / ref_yield_psh * 100.0) if ref_yield_psh > 0 else 0.0
    temp_corr_pr = (
        (total_energy_kwh / total_expected_kwh) * (1.0 - config.system_loss_factor) * 100.0
        if total_expected_kwh > 0
        else 0.0
    )

    healthy_count = int((string_summary_df["status"] == "Healthy").sum())
    warning_count = int(string_summary_df["status"].isin(["Warning", "Monitor"]).sum())
    critical_count = int((string_summary_df["status"] == "Critical").sum())

    return {
        "total_capacity_kwp": round(total_cap_kwp, 2),
        "total_energy_kwh": round(total_energy_kwh, 2),
        "expected_energy_kwh": round(total_expected_kwh, 2),
        "recoverable_loss_kwh": round(total_loss_kwh, 2),
        "specific_yield_kwh_kwp": round(specific_yield, 2),
        "reference_yield_psh": round(ref_yield_psh, 2),
        "plant_pr_pct": round(min(100.0, plant_pr), 2),
        "temp_corrected_pr_pct": round(min(105.0, temp_corr_pr), 2),
        "avg_health_score": round(float(string_summary_df["health_score"].mean()), 1),
        "num_strings": int(len(string_summary_df)),
        "healthy_strings": healthy_count,
        "warning_strings": warning_count,
        "critical_strings": critical_count,
    }
