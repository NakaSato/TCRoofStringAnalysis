"""Interactive Plotly visualizations for PV String Analysis."""

from __future__ import annotations

from typing import List, Optional
import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from solar_core.models import StringSpec


STATUS_COLORS = {
    "Healthy": "#10b981",
    "Monitor": "#f59e0b",
    "Warning": "#f97316",
    "Critical": "#ef4444",
}


def plot_string_yield_and_pr_bar(string_summary_df: pd.DataFrame) -> go.Figure:
    """Create a dual-metric chart comparing Specific Yield (kWh/kWp) and PR (%) across strings."""
    df = string_summary_df.sort_values("string_id")
    colors = [STATUS_COLORS.get(str(s), "#3b82f6") for s in df["status"]]

    fig = make_subplots(specs=[[{"secondary_y": True}]])

    fig.add_trace(
        go.Bar(
            x=df["string_id"],
            y=df["specific_yield_kwh_kwp"],
            name="Specific Yield (kWh/kWp)",
            marker_color=colors,
            text=df["specific_yield_kwh_kwp"].map(lambda v: f"{v:.1f}"),
            textposition="outside",
            hovertemplate=(
                "<b>%{x}</b><br>"
                "Specific Yield: %{y:.2f} kWh/kWp<br>"
                "Status: %{customdata[0]}<br>"
                "Diagnosis: %{customdata[1]}<extra></extra>"
            ),
            customdata=df[["status", "primary_diagnosis"]].values,
        ),
        secondary_y=False,
    )

    peer_median = float(df["specific_yield_kwh_kwp"].median())
    fig.add_hline(
        y=peer_median,
        line_dash="dash",
        line_color="#475569",
        annotation_text=f"Peer Median ({peer_median:.1f} kWh/kWp)",
        annotation_position="top left",
    )

    fig.add_trace(
        go.Scatter(
            x=df["string_id"],
            y=df["pr_pct"],
            name="Performance Ratio (%)",
            mode="lines+markers",
            line=dict(color="#1e3a8a", width=2.5),
            marker=dict(size=9, symbol="diamond"),
            hovertemplate="<b>%{x}</b><br>PR: %{y:.1f}%<extra></extra>",
        ),
        secondary_y=True,
    )

    fig.update_layout(
        title="String Comparison: Specific Yield (kWh/kWp) & Performance Ratio (%)",
        xaxis_title="PV String ID",
        template="plotly_white",
        height=410,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=40, r=40, t=65, b=40),
    )
    fig.update_yaxes(title_text="Specific Yield (kWh/kWp)", secondary_y=False)
    fig.update_yaxes(title_text="Performance Ratio (%)", range=[0, 108], secondary_y=True)
    return fig


def plot_timeseries_telemetry(
    enriched_df: pd.DataFrame,
    metric_col: str = "current_a",
    metric_label: str = "String Current (A)",
    selected_strings: Optional[List[str]] = None,
) -> go.Figure:
    """Plot interactive time-series of Current, Voltage, or Power overlaid with POA Irradiance."""
    df = enriched_df.copy()
    if selected_strings:
        df = df[df["string_id"].isin(selected_strings)]

    fig = make_subplots(specs=[[{"secondary_y": True}]])

    # Add POA irradiance background area on secondary y-axis
    irr_series = (
        enriched_df.groupby("timestamp", as_index=False)["irradiance_wm2"].first().sort_values("timestamp")
    )
    fig.add_trace(
        go.Scatter(
            x=irr_series["timestamp"],
            y=irr_series["irradiance_wm2"],
            name="POA Irradiance (W/m²)",
            mode="lines",
            line=dict(color="rgba(251, 191, 36, 0.35)", width=1),
            fill="tozeroy",
            fillcolor="rgba(251, 191, 36, 0.14)",
            hovertemplate="Irradiance: %{y:.0f} W/m²<extra></extra>",
        ),
        secondary_y=True,
    )

    for str_id, grp in df.groupby("string_id"):
        grp_sorted = grp.sort_values("timestamp")
        fig.add_trace(
            go.Scatter(
                x=grp_sorted["timestamp"],
                y=grp_sorted[metric_col],
                name=str(str_id),
                mode="lines",
                line=dict(width=2),
                hovertemplate=f"<b>{str_id}</b><br>%{{x}}<br>{metric_label}: %{{y:.2f}}<extra></extra>",
            ),
            secondary_y=False,
        )

    fig.update_layout(
        title=f"Time-Series Telemetry: {metric_label} vs. POA Irradiance",
        xaxis_title="Timestamp",
        template="plotly_white",
        height=450,
        hovermode="x unified",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=40, r=40, t=65, b=40),
    )
    fig.update_yaxes(title_text=metric_label, secondary_y=False)
    fig.update_yaxes(
        title_text="POA Irradiance (W/m²)",
        range=[0, 1250],
        showgrid=False,
        secondary_y=True,
    )
    return fig


def plot_string_deviation_heatmap(enriched_df: pd.DataFrame) -> go.Figure:
    """Create a heatmap of daily or hourly string current deviation (%) from peer median."""
    active = enriched_df[enriched_df["irradiance_wm2"] >= 150.0].copy()
    if active.empty:
        active = enriched_df.copy()

    active["hour_label"] = active["timestamp"].dt.strftime("%m-%d %H:00")
    piv = (
        active.pivot_table(
            index="string_id",
            columns="hour_label",
            values="power_dev_pct",
            aggfunc="mean",
        )
        .fillna(0.0)
        .clip(-100.0, 25.0)
    )

    fig = go.Figure(
        data=go.Heatmap(
            z=piv.values,
            x=piv.columns,
            y=piv.index,
            colorscale=[
                [0.0, "#991b1b"],
                [0.5, "#ef4444"],
                [0.75, "#fde047"],
                [0.88, "#10b981"],
                [1.0, "#059669"],
            ],
            zmin=-60,
            zmax=10,
            colorbar=dict(title="Peer Dev (%)"),
            hovertemplate="String: <b>%{y}</b><br>Window: %{x}<br>Power Dev vs Peer: %{z:.1f}%<extra></extra>",
        )
    )
    fig.update_layout(
        title="String Specific Power Deviation (%) vs. Peer Median Across Sunshine Hours",
        xaxis_title="Date & Hour (Active Sunshine Windows)",
        yaxis_title="String ID",
        template="plotly_white",
        height=390,
        margin=dict(l=40, r=40, t=60, b=40),
    )
    return fig


def plot_operating_iv_pv_curves(
    enriched_df: pd.DataFrame,
    spec: StringSpec,
    target_irradiance: float = 850.0,
    target_temp_c: float = 45.0,
) -> go.Figure:
    """Plot theoretical single-diode I-V and P-V characteristic curves alongside actual string operating points."""
    voc = spec.string_voc_stc * (1.0 + spec.temp_coeff_voc * (target_temp_c - 25.0))
    vmp = spec.string_vmp_stc * (1.0 + spec.temp_coeff_voc * (target_temp_c - 25.0))
    isc = spec.isc_stc * (target_irradiance / 1000.0) * (1.0 + spec.temp_coeff_isc * (target_temp_c - 25.0))
    imp = spec.imp_stc * (target_irradiance / 1000.0) * (1.0 + spec.temp_coeff_isc * (target_temp_c - 25.0))

    v_grid = np.linspace(0, voc, 200)
    # Smooth exponential I-V approximation matching (0, Isc), (Vmp, Imp), (Voc, 0)
    shape_k = np.log(max(1e-4, 1.0 - (imp / max(isc, 0.1)))) / ((vmp / voc) - 1.0)
    shape_k = max(6.0, min(22.0, abs(shape_k)))
    i_curve = isc * (1.0 - np.exp(shape_k * ((v_grid / voc) - 1.0)))
    i_curve = np.clip(i_curve, 0.0, isc)
    p_curve_kw = (v_grid * i_curve) / 1000.0

    # Filter operating points near target irradiance (+/- 150 W/m²)
    band = enriched_df[
        (enriched_df["irradiance_wm2"] >= target_irradiance - 150.0)
        & (enriched_df["irradiance_wm2"] <= target_irradiance + 150.0)
    ]
    if band.empty:
        band = enriched_df[enriched_df["irradiance_wm2"] >= 200.0]

    op_points = (
        band.groupby("string_id", as_index=False)
        .agg(
            voltage_v=("voltage_v", "median"),
            current_a=("current_a", "median"),
            power_kw=("power_w", lambda s: s.median() / 1000.0),
            fault=("interval_fault", lambda s: s.mode().iloc[0] if not s.empty else "Normal"),
        )
    )

    fig = make_subplots(specs=[[{"secondary_y": True}]])

    fig.add_trace(
        go.Scatter(
            x=v_grid,
            y=i_curve,
            name="Theoretical I-V Curve (A)",
            mode="lines",
            line=dict(color="#0284c7", width=2.5),
        ),
        secondary_y=False,
    )

    fig.add_trace(
        go.Scatter(
            x=v_grid,
            y=p_curve_kw,
            name="Theoretical P-V Curve (kW)",
            mode="lines",
            line=dict(color="#94a3b8", width=2, dash="dot"),
        ),
        secondary_y=True,
    )

    fig.add_trace(
        go.Scatter(
            x=op_points["voltage_v"],
            y=op_points["current_a"],
            mode="markers+text",
            text=op_points["string_id"],
            textposition="top center",
            name="Actual String Operating Point (Vmp, Imp)",
            marker=dict(
                size=12,
                color="#ef4444",
                line=dict(width=1.5, color="#ffffff"),
            ),
            hovertemplate=(
                "<b>%{text}</b><br>"
                "Operating Voltage: %{x:.1f} V<br>"
                "Operating Current: %{y:.2f} A<extra></extra>"
            ),
        ),
        secondary_y=False,
    )

    fig.update_layout(
        title=f"String I-V & P-V Curve Envelope (@ ~{target_irradiance:.0f} W/m², {target_temp_c:.0f}°C) vs. Actual Operating Points",
        xaxis_title="String DC Voltage (V)",
        template="plotly_white",
        height=420,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=40, r=40, t=65, b=40),
    )
    fig.update_yaxes(title_text="String Current (A)", range=[0, max(16.0, isc * 1.15)], secondary_y=False)
    fig.update_yaxes(title_text="String Power (kW)", range=[0, max(12.0, p_curve_kw.max() * 1.2)], secondary_y=True)
    return fig


def plot_daily_generation_and_pr_trend(daily_plant_df: pd.DataFrame) -> go.Figure:
    """Plot Daily Generation (kWh) vs Expected Energy and Daily PR (%) vs Target PR."""
    df = daily_plant_df.sort_values("date")
    fig = make_subplots(specs=[[{"secondary_y": True}]])

    fig.add_trace(
        go.Bar(
            x=df["date"],
            y=df["actual_generation_kwh"],
            name="Actual Generation (kWh)",
            marker_color="#0284c7",
            hovertemplate="<b>%{x}</b><br>Actual: %{y:.1f} kWh<extra></extra>",
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Bar(
            x=df["date"],
            y=df["expected_temp_corr_kwh"],
            name="Expected Temp-Corr Energy (kWh)",
            marker_color="rgba(148, 163, 184, 0.55)",
            hovertemplate="<b>%{x}</b><br>Expected: %{y:.1f} kWh<extra></extra>",
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=df["date"],
            y=df["pr_pct"],
            name="Daily PR (%)",
            mode="lines+markers",
            line=dict(color="#16a34a", width=2.5),
            marker=dict(size=8),
            hovertemplate="<b>%{x}</b><br>PR: %{y:.1f}%<extra></extra>",
        ),
        secondary_y=True,
    )
    if "target_pr_pct" in df.columns and not df.empty:
        target_pr = float(df["target_pr_pct"].iloc[0])
        fig.add_hline(
            y=target_pr,
            line_dash="dash",
            line_color="#dc2626",
            secondary_y=True,
            annotation_text=f"Target PR ({target_pr:.1f}%)",
            annotation_position="top right",
        )

    fig.update_layout(
        title="Daily Plant Generation (kWh) & Performance Ratio (PR %) Trend",
        barmode="group",
        template="plotly_white",
        height=400,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=40, r=40, t=65, b=40),
    )
    fig.update_yaxes(title_text="Energy Generation (kWh)", secondary_y=False)
    fig.update_yaxes(title_text="Performance Ratio (%)", range=[0, 108], secondary_y=True)
    return fig


def plot_monthly_generation_and_pr_trend(monthly_plant_df: pd.DataFrame) -> go.Figure:
    """Plot 6-Month Generation (kWh), Specific Yield, and Monthly PR (%) vs Target PR."""
    df = monthly_plant_df.sort_values("year_month")
    fig = make_subplots(specs=[[{"secondary_y": True}]])

    fig.add_trace(
        go.Bar(
            x=df["year_month"],
            y=df["actual_generation_kwh"],
            name="Monthly Generation (kWh)",
            marker_color="#1e3a8a",
            text=df["actual_generation_kwh"].map(lambda v: f"{v:,.0f}"),
            textposition="outside",
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=df["year_month"],
            y=df["pr_pct"],
            name="Monthly PR (%)",
            mode="lines+markers",
            line=dict(color="#f59e0b", width=3),
            marker=dict(size=9, symbol="diamond"),
        ),
        secondary_y=True,
    )
    if "target_pr_pct" in df.columns and not df.empty:
        target_pr = float(df["target_pr_pct"].iloc[0])
        fig.add_hline(
            y=target_pr,
            line_dash="dot",
            line_color="#dc2626",
            secondary_y=True,
            annotation_text=f"Target PR ({target_pr:.1f}%)",
        )

    fig.update_layout(
        title="Monthly Generation (kWh) & Performance Ratio (PR %) Benchmark",
        template="plotly_white",
        height=400,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=40, r=40, t=65, b=40),
    )
    fig.update_yaxes(title_text="Monthly Energy (kWh)", secondary_y=False)
    fig.update_yaxes(title_text="Performance Ratio (%)", range=[60, 100], secondary_y=True)
    return fig


def plot_energy_loss_waterfall(waterfall_df: pd.DataFrame) -> go.Figure:
    """Plot IEC 61724 Energy & PR Loss Waterfall from STC Reference to Actual Metered Yield."""
    measures = []
    for cat in waterfall_df["Category"]:
        if cat == "Reference":
            measures.append("absolute")
        elif cat == "Total":
            measures.append("total")
        else:
            measures.append("relative")

    fig = go.Figure(
        go.Waterfall(
            name="Energy Loss Breakdown",
            orientation="v",
            measure=measures,
            x=waterfall_df["Step"],
            y=waterfall_df["Energy_kWh"],
            text=waterfall_df["Energy_kWh"].map(lambda v: f"{v:+,.1f} kWh" if v < 0 else f"{v:,.1f} kWh"),
            textposition="outside",
            connector={"line": {"color": "#64748b"}},
            decreasing={"marker": {"color": "#ef4444"}},
            increasing={"marker": {"color": "#10b981"}},
            totals={"marker": {"color": "#0284c7"}},
        )
    )
    fig.update_layout(
        title="Plant Energy & PR Loss Waterfall Breakdown (Identify Improvement Opportunities)",
        yaxis_title="Energy (kWh)",
        template="plotly_white",
        height=410,
        margin=dict(l=40, r=40, t=65, b=40),
    )
    return fig

