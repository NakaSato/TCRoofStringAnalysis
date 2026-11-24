"""Decision rules: daily string / inverter / plant rows, I-V sweeps, the Issues queue and site events."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import Boolean, Date, DateTime, Float, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class GrowattStringDaily(Base):
    """One wired string's day, computed from stored 5-min readings by `services/growatt_daily.py`
    (decision rules, docs/plans/decision-rules.md §3.1). Kept indefinitely (`retention` skips it).

    Ratios compare the string with the median current of its matched peer group (same orientation,
    tilt and module count on the inverter) in the same 5-min slot, only in **gated** slots
    (inverter normal, median ≥ 3 A, not clipped or limited, irradiance ≥ 400 W/m² with low
    irradiance variability where the plant's sensor reads). Fewer than `MIN_GATED_SLOTS` gated
    slots = no verdict: the ratio columns stay null.
    """

    __tablename__ = "growatt_string_daily"
    __table_args__ = (Index("ix_growatt_str_daily_plant_day", "plant_id", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    gated_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ratio_median: Mapped[Optional[float]] = mapped_column(Float)
    low_min: Mapped[Optional[int]] = mapped_column(Integer)  # gated minutes with ratio < 0.80
    severe_min: Mapped[Optional[int]] = mapped_column(Integer)  # gated minutes with ratio < 0.60
    open_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # ≤ 0.3 A while median ≥ 2 A
    v_ratio_median: Mapped[Optional[float]] = mapped_column(Float)  # per module; null without a full layout
    voltage_sensing: Mapped[Optional[str]] = mapped_column(String(16))  # "per_string" | "shared_mppt"
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    lost_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # estimated, vs the peer median
    lost_on_peak_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # part of it in the tariff's on-peak hours
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattInverterDaily(Base):
    """One inverter's day: minutes per state over the plant's daylight, energy, specific yield
    vs the plant's other inverters, BOS/inverter loss (Ya − Yf) and estimated lost energy by cause
    (`services/growatt_daily.py`, docs/plans/decision-rules.md §3.2). Kept indefinitely
    (`retention` skips it).

    Lost kWh is **estimated** from the specific yield of the plant's producing inverters in the
    same slots; null where no other inverter of the plant produced (nothing to compare with).
    """

    __tablename__ = "growatt_inverter_daily"
    __table_args__ = (Index("ix_growatt_inv_daily_plant_day", "plant_id", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    daylight_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    producing_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    fault_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    off_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    standby_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # record, no power, no fault, peers produce
    limited_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    no_data_min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)  # last eac_today of the day
    dc_energy_kwh: Mapped[Optional[float]] = mapped_column(Float)  # integrated ppv_w over filtered slots
    kwp: Mapped[Optional[float]] = mapped_column(Float)  # DC capacity used for the specific yield
    ya_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # array yield Ya = E_DC / P0
    yf_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # final yield Yf = E_AC / P0
    ya_minus_yf: Mapped[Optional[float]] = mapped_column(Float)  # BOS & inverter conversion loss (Ya − Yf)
    yf_vs_median_pct: Mapped[Optional[float]] = mapped_column(Float)  # vs median of the plant's other inverters
    plant_kwp_share_pct: Mapped[Optional[float]] = mapped_column(Float)  # this inverter's share of the plant kWp
    lost_fault_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_off_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_standby_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_no_data_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # only what eac_today did not recover
    # on-peak part (tariff on-peak hours at compute time) of fault + off + standby, and of no data
    lost_down_on_peak_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    lost_no_data_on_peak_kwh_est: Mapped[Optional[float]] = mapped_column(Float)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattPlantDaily(Base):
    """One plant's daily time-series performance KPIs over quality-filtered 5-min slots
    (POA 200–1200 W/m², with stale-value, clipping and curtailment masks applied):
    raw PR, temperature-corrected PR', EPI (measured ÷ modelled energy), and Ya − Yf.
    Kept indefinitely (`retention` skips it).
    """

    __tablename__ = "growatt_plant_daily"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    capacity_kwp: Mapped[Optional[float]] = mapped_column(Float)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    dc_energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    modelled_energy_kwh: Mapped[Optional[float]] = mapped_column(Float)  # modelled from filtered POA & T_mod
    yr_h: Mapped[Optional[float]] = mapped_column(Float)  # reference yield Yr (kWh/m²)
    ya_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # array yield Ya = E_DC / P0
    yf_kwh_kwp: Mapped[Optional[float]] = mapped_column(Float)  # final yield Yf = E_AC / P0
    ya_minus_yf: Mapped[Optional[float]] = mapped_column(Float)  # Ya − Yf (inverter + BOS loss)
    pr_pct: Mapped[Optional[float]] = mapped_column(Float)  # raw IEC 61724-1 PR (reporting only)
    pr_temp_corrected_pct: Mapped[Optional[float]] = mapped_column(Float)  # PR' = PR / [1 + γ(T_mod − 25 °C)]
    epi: Mapped[Optional[float]] = mapped_column(Float)  # E_measured / E_modelled over filtered slots
    system_factor: Mapped[Optional[float]] = mapped_column(Float)  # model factor behind epi / modelled_energy_kwh (null = 0.985)
    irradiance_weighted_tmod_c: Mapped[Optional[float]] = mapped_column(Float)
    filtered_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stale_masked_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clipped_masked_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    curtailed_masked_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # R16 sensor-health evidence (null = no irradiance that day / cannot be judged); the rule's
    # thresholds judge it (`growatt_rules.sensor_verdict`), so they can change without a recompute
    sensor_stale_slots: Mapped[Optional[int]] = mapped_column(Integer)  # daylight slots in a run of >= 3 identical non-zero readings
    sensor_high_slots: Mapped[Optional[int]] = mapped_column(Integer)  # slots above clear-sky GHI × SENSOR_CLEAR_SKY_FACTOR
    sensor_midday_wm2: Mapped[Optional[float]] = mapped_column(Float)  # mean irradiance 10:00–14:00 (measured)
    sensor_midday_slots: Mapped[Optional[int]] = mapped_column(Integer)
    cloud_midday_pct: Mapped[Optional[float]] = mapped_column(Float)  # Google Weather (modelled) mean cloud cover 10:00–14:00
    sensor_neighbour_ratio: Mapped[Optional[float]] = mapped_column(Float)  # midday irradiance ÷ median of neighbouring plants' sensors
    sensor_neighbours: Mapped[Optional[int]] = mapped_column(Integer)
    # curtailment of the day (estimated, services/growatt_curtailment.py; null = no slot judged)
    curtailed_kwh: Mapped[Optional[float]] = mapped_column(Float)
    curtailed_slots: Mapped[Optional[int]] = mapped_column(Integer)
    curtail_judged_slots: Mapped[Optional[int]] = mapped_column(Integer)
    curtailed_export_kwh: Mapped[Optional[float]] = mapped_column(Float)  # zero export: PV followed the load
    curtailed_limit_kwh: Mapped[Optional[float]] = mapped_column(Float)  # at the power-limit setting
    curtail_ratio: Mapped[Optional[float]] = mapped_column(Float)  # model scale used (calibration of the 14 days before; null = plain model)
    curtail_ratio_slots: Mapped[Optional[int]] = mapped_column(Integer)  # the plant's own free slots in that window
    curtail_ratio_source: Mapped[Optional[str]] = mapped_column(String(8))  # plant | fleet (null = plain model)
    free_ratio: Mapped[Optional[float]] = mapped_column(Float)  # median AC ÷ plain model over the day's free slots (measured ÷ modelled)
    free_slots: Mapped[Optional[int]] = mapped_column(Integer)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)



class GrowattPlantEpiFit(Base):
    """A plant's fitted EPI system factor (services/epi_fit.py, docs/plans/decision-rules.md §5.1):
    the median of measured ÷ modelled-without-factor over its clearest good days. Only a `fitted`
    row's factor is used; otherwise the plant keeps `DEFAULT_SYSTEM_FACTOR`. Modelled, kept
    indefinitely; fitted once, refitted only by the `epi_refit` job."""

    __tablename__ = "growatt_plant_epi_fit"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # fitted | too_few_days | rejected
    factor: Mapped[Optional[float]] = mapped_column(Float)  # the median found (also when rejected)
    spread_pct: Mapped[Optional[float]] = mapped_column(Float)  # median absolute deviation of the days ÷ factor
    days_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    candidate_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    start_day: Mapped[Optional[date]] = mapped_column(Date)  # first / last day used
    end_day: Mapped[Optional[date]] = mapped_column(Date)
    min_clearness: Mapped[Optional[float]] = mapped_column(Float)  # clearness of the least clear day used
    reason: Mapped[Optional[str]] = mapped_column(String(255))
    fitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

class GrowattIvSweep(Base):
    """Measured I-V curve sweep (string or module level) from a field tracer or inverter smart scan,
    translated to STC via IEC 60891 Procedure 1 and classified against fault signatures.
    """

    __tablename__ = "growatt_iv_sweeps"
    __table_args__ = (Index("ix_growatt_iv_sweeps_plant_sn", "plant_id", "device_sn", "string_no"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    module_no: Mapped[Optional[int]] = mapped_column(Integer)
    level: Mapped[str] = mapped_column(String(16), nullable=False, default="string")  # "string" | "module"
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="upload")  # "upload" | "inverter_scan"
    swept_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # naive plant-local time
    irradiance_wm2: Mapped[float] = mapped_column(Float, nullable=False)
    module_temp_c: Mapped[float] = mapped_column(Float, nullable=False)
    irradiance_change_pct: Mapped[Optional[float]] = mapped_column(Float)
    reference_cell_tech: Mapped[Optional[str]] = mapped_column(String(64))
    # optional measurement conditions (null = not recorded with the sweep)
    temp_change_k_per_min: Mapped[Optional[float]] = mapped_column(Float)  # module T change, minute before
    sweep_time_ms: Mapped[Optional[float]] = mapped_column(Float)
    cell_technology: Mapped[Optional[str]] = mapped_column(String(16))  # perc | topcon | hjt | ibc
    irradiance_uncertainty_pct: Mapped[Optional[float]] = mapped_column(Float)  # sensor calibration, k = 2
    reverse_pmax_w: Mapped[Optional[float]] = mapped_column(Float)  # measured Pmax of the opposite-direction sweep
    sensor_misalignment_deg: Mapped[Optional[float]] = mapped_column(Float)  # irradiance sensor vs array plane
    modules: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    quality_gate_passed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    gate_reasons_json: Mapped[Optional[Any]] = mapped_column(JSON)
    iec60891_json: Mapped[Optional[Any]] = mapped_column(JSON)
    measured_json: Mapped[Optional[Any]] = mapped_column(JSON)
    stc_json: Mapped[Optional[Any]] = mapped_column(JSON)
    classification_json: Mapped[Optional[Any]] = mapped_column(JSON)
    p_max_stc_w: Mapped[float] = mapped_column(Float, nullable=False)
    expected_pmax_stc_w: Mapped[float] = mapped_column(Float, nullable=False)
    pmax_dev_pct: Mapped[float] = mapped_column(Float, nullable=False)
    signature: Mapped[str] = mapped_column(String(48), nullable=False)
    is_finding: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ticket_recommended: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ir_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    timeseries_trend_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    warranty_claim_ready: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class GrowattIssue(Base):
    """One problem found by a decision rule on one entity (plant inverter or string), from the day
    it first fired until it closes (docs/plans/decision-rules.md §4.2, `services/growatt_issues.py`).

    At most one open issue per (plant, inverter, string, rule): `status` open / acknowledged. It
    closes itself (`close_reason = auto`) when its rule has a verdict and does not fire for 2 days
    in a row; engineers resolve or dismiss it. `daily` holds each day it fired: {day: {kwh, thb}},
    estimated. `shadow` issues (rule still being calibrated) are shown to admins only.
    """

    __tablename__ = "growatt_issues"
    __table_args__ = (
        Index("ix_growatt_issues_plant_status", "plant_id", "status"),
        Index("ix_growatt_issues_key", "plant_id", "device_sn", "string_no", "rule"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    rule: Mapped[str] = mapped_column(String(8), nullable=False)
    tier: Mapped[str] = mapped_column(String(8), nullable=False)
    safety: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    parent_id: Mapped[Optional[int]] = mapped_column(Integer)  # the inverter's open issue, for string issues
    opened_day: Mapped[date] = mapped_column(Date, nullable=False)
    last_seen_day: Mapped[date] = mapped_column(Date, nullable=False)
    days_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    lost_kwh_est: Mapped[Optional[float]] = mapped_column(Float)  # mean of the last 3 days it fired
    thb_per_day_est: Mapped[Optional[float]] = mapped_column(Float)  # mean of the last 3 days it fired
    lost_kwh_total_est: Mapped[Optional[float]] = mapped_column(Float)
    thb_total_est: Mapped[Optional[float]] = mapped_column(Float)
    evidence: Mapped[Optional[dict]] = mapped_column(JSON)  # the last day's finding evidence
    daily: Mapped[Optional[dict]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    ack_by: Mapped[Optional[str]] = mapped_column(String(64))
    ack_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    note: Mapped[Optional[str]] = mapped_column(Text)
    feedback: Mapped[Optional[str]] = mapped_column(String(16))  # confirmed / false_alarm
    shadow: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[Optional[str]] = mapped_column(String(64))
    close_reason: Mapped[Optional[str]] = mapped_column(String(16))  # auto / resolved / dismissed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class SiteEvent(Base):
    """Work done on a Growatt plant, entered by an engineer or admin (docs/plans/decision-rules.md
    §6, `services/site_events.py`): cleaning, repair, module or inverter replaced, IR flight,
    curtailment. Optional inverter / string. `day` (to `end_day` when it took several days) is
    the plant-local date of the work. `cost_thb` is what was paid, null when not entered.
    `issue_id` links the decision-rule issue the work answered. Kept indefinitely: the cleaning
    steps and the soiling rate are measured from these dates.
    """

    __tablename__ = "site_events"
    __table_args__ = (Index("ix_site_events_plant_day", "plant_id", "day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(24), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    end_day: Mapped[Optional[date]] = mapped_column(Date)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    cost_thb: Mapped[Optional[float]] = mapped_column(Float)
    issue_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)
