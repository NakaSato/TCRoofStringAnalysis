"""Tests for I-V curve analysis (IEC 60891 Procedure 1, single-diode fitting, 8 fault signatures,
dead-band & two-source warranty rule) and time-series performance analytics (PR', EPI & R10,
Ya - Yf & R11, peer orientation/tilt grouping, ΔG variability gate, R4 bypass diode voltage-limit
rule, and R6 PID slope rule)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterDaily,
    GrowattInverterReading,
    GrowattIssue,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattStringDaily,
    GrowattStringLayout,
    GrowattStringReading,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_daily, growatt_overview, growatt_rules
from solar_core.iv_analysis import (
    ModuleStcSpec,
    analyze_iv_sweep,
    extract_iv_parameters,
    fit_desoto,
    fit_sandia_simple,
    parse_iv_csv,
    simulate_single_diode_curve,
    translate_to_stc_iec60891,
    validate_sweep_conditions,
)


SPEC = ModuleStcSpec(
    wp=570.0,
    voc_stc=51.10,
    isc_stc=14.23,
    vmp_stc=42.40,
    imp_stc=13.45,
    temp_coeff_pmax_pct=-0.30,
    temp_coeff_voc_pct=-0.25,
    temp_coeff_isc_pct=0.046,
    rs_ohm=0.22,
    kappa_ohm_per_k=0.0012,
    first_year_lid_pct=1.0,
    annual_degradation_pct=0.45,
)


def _synth_stc_curve(
    modules: int = 1,
    isc_scale: float = 1.0,
    voc_offset_v: float = 0.0,
    rs_mult: float = 1.0,
    rsh_ohm: float | None = None,
    add_step: bool = False,
    n_points: int = 80,
):
    """Synthesize a clean or faulted I-V curve at STC for `modules` in series."""
    desoto = fit_desoto(
        v_mp=SPEC.vmp_stc * modules,
        i_mp=SPEC.imp_stc * isc_scale,
        v_oc=SPEC.voc_stc * modules + voc_offset_v,
        i_sc=SPEC.isc_stc * isc_scale,
        alpha_sc_a_per_k=SPEC.alpha_a_per_k(),
        beta_oc_v_per_k=SPEC.beta_v_per_k(modules),
        n_cells_series=72 * modules,
    )
    r_s = desoto["r_s_ohm"] * rs_mult
    r_sh = rsh_ohm if rsh_ohm is not None else desoto["r_sh_ref_ohm"]
    v_oc = SPEC.voc_stc * modules + voc_offset_v
    pts = simulate_single_diode_curve(
        i_l=desoto["i_l_ref_a"],
        i_o=desoto["i_o_ref_a"],
        r_s=r_s,
        r_sh=r_sh,
        n_ns_vth=desoto["a_ref_v"],
        v_oc=v_oc,
        n_points=n_points,
    )
    if add_step:
        out = []
        for p in pts:
            v = p["v"]
            i = p["i"]
            if 0.45 * v_oc < v < 0.85 * v_oc:
                step_factor = 0.72 + 0.28 * max(0.0, min(1.0, (0.55 * v_oc - v) / (0.10 * v_oc)))
                i = i * step_factor
            out.append({"v": round(v, 2), "i": round(i, 3)})
        return out
    return [{"v": p["v"], "i": p["i"]} for p in pts]


def _run_sweep(pts, **kwargs):
    return analyze_iv_sweep(
        voltage=[p["v"] for p in pts],
        current=[p["i"] for p in pts],
        irradiance_wm2=1000.0,
        module_temp_c=25.0,
        swept_at="2026-11-10T12:00:00",
        spec=SPEC,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# 1. I-V curve conditions, IEC 60891 Procedure 1, fitting & fault signatures
# ---------------------------------------------------------------------------


def test_sweep_condition_validation_requires_g_t_and_timestamp():
    with pytest.raises(ValueError, match="timestamp"):
        validate_sweep_conditions(850.0, 42.0, None)
    with pytest.raises(ValueError, match="irradiance"):
        validate_sweep_conditions(None, 42.0, "2026-11-10T11:30:00")
    with pytest.raises(ValueError, match="temperature"):
        validate_sweep_conditions(850.0, None, "2026-11-10T11:30:00")

    ok = validate_sweep_conditions(820.0, 44.0, "2026-11-10T11:30:00", irradiance_change_pct=1.1)
    assert ok["quality_gate_passed"] is True and ok["gate_reasons"] == []

    low_g = validate_sweep_conditions(620.0, 40.0, "2026-11-10T11:30:00", irradiance_change_pct=2.8)
    assert low_g["quality_gate_passed"] is False
    assert len(low_g["gate_reasons"]) == 2


def test_iec60891_procedure_1_roundtrip_and_single_diode_fit():
    modules = 10
    stc_pts = _synth_stc_curve(modules=modules)
    v_stc = np.array([p["v"] for p in stc_pts])
    i_stc = np.array([p["i"] for p in stc_pts])

    g1, t1 = 800.0, 45.0
    alpha = SPEC.alpha_a_per_k()
    beta = SPEC.beta_v_per_k(modules)
    r_s = SPEC.rs_ohm * modules
    kappa = SPEC.kappa_ohm_per_k * modules
    dt = 25.0 - t1  # -20 K

    isc2 = float(i_stc[0])
    isc1 = (isc2 - alpha * dt) / (1000.0 / g1)
    i1 = i_stc - isc1 * (1000.0 / g1 - 1.0) - alpha * dt
    v1 = v_stc + r_s * (i_stc - i1) + kappa * i_stc * dt - beta * dt
    mask = (v1 >= 0) & (i1 >= 0)

    tr = translate_to_stc_iec60891(
        v1[mask], i1[mask], g1, t1, SPEC, modules=modules, r_s_ohm=r_s, kappa_ohm_per_k=kappa
    )
    params_stc = extract_iv_parameters(tr["v_stc"], tr["i_stc"])
    assert params_stc["v_oc_v"] == pytest.approx(SPEC.voc_stc * modules, rel=0.015)
    assert params_stc["i_sc_a"] == pytest.approx(SPEC.isc_stc, rel=0.015)
    assert params_stc["p_max_w"] == pytest.approx(SPEC.wp * modules, rel=0.025)

    sde = fit_sandia_simple(tr["v_stc"], tr["i_stc"])
    assert sde["i_l_a"] == pytest.approx(SPEC.isc_stc, rel=0.03)
    assert sde["r_s_ohm"] > 0 and sde["r_sh_ohm"] > 50


def test_all_eight_iv_fault_signatures_and_two_source_warranty():
    modules = 10

    # 0. Inside ±4 % dead band -> normal, no ticket
    healthy_pts = _synth_stc_curve(modules=modules, isc_scale=0.985)
    res_ok = _run_sweep(healthy_pts, modules=modules, system_age_years=1.0)
    assert res_ok["classification"]["in_dead_band"] is True
    assert res_ok["classification"]["ticket_recommended"] is False

    # 1. Isc low, curve shape normal -> isc_low_normal_shape
    soiling_pts = _synth_stc_curve(modules=modules, isc_scale=0.84)
    res_soil = _run_sweep(soiling_pts, modules=modules)
    assert res_soil["classification"]["signature"] == "isc_low_normal_shape"
    assert res_soil["classification"]["ticket_recommended"] is True

    # 2. Voc low by ~1/3 of one module's Voc -> bypass_diode_shorted
    diode_pts = _synth_stc_curve(modules=modules, voc_offset_v=-(SPEC.voc_stc / 3.0))
    res_diode = _run_sweep(diode_pts, modules=modules, dead_band_pct=2.0)
    assert res_diode["classification"]["signature"] == "bypass_diode_shorted"

    # 3. Voc low by ~1 full module -> miswiring_or_module_count
    missing_pts = _synth_stc_curve(modules=modules, voc_offset_v=-SPEC.voc_stc)
    res_miss = _run_sweep(missing_pts, modules=modules)
    assert res_miss["classification"]["signature"] == "miswiring_or_module_count"

    # 4. Steps or notches in the curve -> steps_in_curve
    step_pts = _synth_stc_curve(modules=modules, add_step=True)
    res_step = _run_sweep(step_pts, modules=modules)
    assert res_step["stc"]["parameters"]["steps_count"] >= 1
    assert res_step["classification"]["signature"] == "steps_in_curve"

    # 5. Shallower slope near Voc (Rs up), FF down -> high_series_resistance
    rs_pts = _synth_stc_curve(modules=modules, rs_mult=4.0)
    res_rs = _run_sweep(rs_pts, modules=modules)
    assert res_rs["classification"]["signature"] == "high_series_resistance"

    # 6. Steeper slope near Isc (Rsh down), FF down -> low_shunt_resistance
    rsh_pts = _synth_stc_curve(modules=modules, rsh_ohm=55.0)
    res_rsh = _run_sweep(rsh_pts, modules=modules)
    assert res_rsh["classification"]["signature"] == "low_shunt_resistance"

    # 7. Voc and FF down, worse at low irradiance / negative pole -> pid
    pid_pts = _synth_stc_curve(modules=modules, voc_offset_v=-25.0, rsh_ohm=45.0)
    res_pid = _run_sweep(
        pid_pts,
        modules=modules,
        near_negative_pole=True,
        ir_confirmed=False,
        timeseries_trend_confirmed=False,
    )
    assert res_pid["classification"]["signature"] == "pid"
    # Warranty claim requires 2 sources: without IR or time-series agreement, warranty_claim_ready is False
    assert res_pid["classification"]["warranty"]["warranty_claim_ready"] is False

    # With a second source (IR or time-series trend), warranty_claim_ready becomes True
    res_pid_2src = _run_sweep(
        pid_pts,
        modules=modules,
        near_negative_pole=True,
        ir_confirmed=True,
    )
    assert res_pid_2src["classification"]["warranty"]["warranty_claim_ready"] is True
    assert res_pid_2src["classification"]["warranty"]["second_source"] == "ir"

    # 8. All parameters down uniformly -> normal_degradation
    unif_pts = _synth_stc_curve(modules=modules, isc_scale=0.94, voc_offset_v=-0.04 * SPEC.voc_stc * modules)
    res_unif = _run_sweep(unif_pts, modules=modules, system_age_years=1.0)
    assert res_unif["classification"]["signature"] == "normal_degradation"


def test_csv_parser_and_iv_sweep_api_routes(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'iv_api.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add(GrowattPlant(plant_id=101, name="Solar Roof 101", create_date="2024-05-01", peak_power_kwp=57.0))
        db.add(GrowattInverter(device_sn="INV101", plant_id=101, nominal_power_w=50000.0))
        db.add(GrowattStringLayout(device_sn="INV101", string_no=1, modules=10))
        # Open a time-series issue on string 1 so two-source warranty check finds it automatically
        db.add(
            GrowattIssue(
                plant_id=101,
                device_sn="INV101",
                string_no=1,
                rule="R6",
                tier="P2",
                safety=False,
                opened_day=date(2026, 11, 9),
                last_seen_day=date(2026, 11, 10),
                days_seen=2,
                status="open",
                shadow=False,
            )
        )
        db.commit()

    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)
    tok = client.post("/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    hdr = {"Authorization": f"Bearer {tok}"}

    pts = _synth_stc_curve(modules=10, voc_offset_v=-25.0, rsh_ohm=45.0)
    csv_text = "Voltage (V),Current (A)\n" + "\n".join(f"{p['v']},{p['i']}" for p in pts)
    parsed = parse_iv_csv(csv_text)
    assert len(parsed) == len(pts)

    r = client.post(
        "/growatt/plants/101/iv-sweeps",
        headers=hdr,
        json={
            "device_sn": "INV101",
            "string_no": 1,
            "level": "string",
            "swept_at": "2026-11-10T11:45:00",
            "irradiance_wm2": 1000.0,
            "module_temp_c": 25.0,
            "irradiance_change_pct": 0.8,
            "near_negative_pole": True,
            "csv_text": csv_text,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["modules"] == 10
    assert body["signature"] == "pid"
    assert body["timeseries_trend_confirmed"] is True
    assert body["warranty_claim_ready"] is True

    sweep_id = body["id"]
    lst = client.get("/growatt/plants/101/iv-sweeps?sn=INV101&string_no=1", headers=hdr).json()
    assert len(lst["sweeps"]) == 1 and lst["sweeps"][0]["id"] == sweep_id

    patched = client.patch(
        f"/growatt/plants/101/iv-sweeps/{sweep_id}",
        headers=hdr,
        json={"ir_confirmed": True, "note": "Drone IR confirmed hot spots near negative end"},
    )
    assert patched.status_code == 200
    assert patched.json()["ir_confirmed"] is True
    assert patched.json()["classification"]["warranty"]["second_source"] == "ir_and_timeseries"


# ---------------------------------------------------------------------------
# 2. Time-series performance analysis (PR', EPI & R10, Ya-Yf & R11, R4, R6)
# ---------------------------------------------------------------------------


def test_temperature_corrected_pr_and_data_filters(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'ts.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    day = date(2026, 11, 10)
    with f() as db:
        db.add(GrowattPlant(plant_id=1, name="Bangkok Roof", latitude=13.75, longitude=100.5, peak_power_kwp=100.0))
        db.flush()
        db.add(GrowattInverter(device_sn="INV1", plant_id=1, nominal_power_w=100000.0))
        db.add(GrowattEnvSensor(datalogger_sn="DL1", address=1, plant_id=1, device_name="POA Sensor"))
        db.flush()
        # Seed 09:00..15:00 at G = 800 W/m², T_mod = 55 °C (Bangkok hot roof: raw PR ~ 76%, PR' ~ 83.5%)
        eac = 0.0
        t = datetime(2026, 11, 10, 9, 0)
        while t < datetime(2026, 11, 10, 15, 0):
            # Vary G slightly by 1 W/m² every slot so it is not flagged as a stale frozen sensor
            g = 800.0 + ((t.minute // 5) % 2)
            t_mod = 55.0
            pac_w = 100.0 * (g / 1000.0) * 0.76 * 1000.0  # raw PR = 76 %
            ppv_w = pac_w / 0.96
            eac += pac_w * (5.0 / 60.0) / 1000.0
            db.add(GrowattEnvReading(datalogger_sn="DL1", address=1, timestamp=t, irradiance_wm2=g, module_temp_c=t_mod, ambient_temp_c=34.0))
            db.add(GrowattInverterReading(device_sn="INV1", timestamp=t, status=1, pac_w=pac_w, ppv_w=ppv_w, eac_today_kwh=round(eac, 3)))
            t += timedelta(minutes=5)
        db.commit()

        ov = growatt_overview.build_plant_overview(db, 1, day)
        kpis = ov["kpis"]
        assert kpis["iec_pr_pct"] == pytest.approx(76.0, abs=0.5)
        # At T_mod = 55 °C and gamma = -0.30 %/K: PR' = 76 / (1 - 0.003 * 30) = 76 / 0.91 ≈ 83.5 %
        assert kpis["iec_pr_temp_corrected_pct"] == pytest.approx(76.0 / 0.91, abs=0.6)
        assert kpis["epi"] is not None and kpis["epi"] > 0.80
        assert kpis["ya_kwh_kwp"] is not None and kpis["ya_minus_yf"] is not None and kpis["ya_minus_yf"] > 0


def test_r4_voltage_limit_enforced_and_r6_pid_and_r10_epi_and_r11_ya_yf(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'rules_ext.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    base_day = date(2026, 11, 20)

    with f() as db:
        db.add(GrowattPlant(plant_id=1, name="Plant 1", latitude=13.75, longitude=100.5, peak_power_kwp=100.0))
        db.add(GrowattInverter(device_sn="INV1", plant_id=1, nominal_power_w=100000.0))
        # Layout:
        # String 1 (MPPT 1 alone -> per_string voltage sensing)
        # String 3 & String 4 (both on MPPT 2 -> shared_mppt voltage sensing)
        # String 5 (MPPT 3 alone -> per_string voltage sensing)
        for sno in (1, 3, 4, 5):
            db.add(GrowattStringLayout(device_sn="INV1", string_no=sno, modules=10, azimuth_deg=180.0, tilt_deg=10.0))
        db.commit()

        # Seed 2 days where BOTH String 1 (per_string) and String 3 (shared_mppt) have a 2 % voltage drop
        for d_off in (-1, 0):
            d = base_day + timedelta(days=d_off)
            t = datetime.combine(d, datetime.min.time()) + timedelta(hours=10)
            for slot_idx in range(20):
                ts = t + timedelta(minutes=5 * slot_idx)
                db.add(GrowattInverterReading(device_sn="INV1", timestamp=ts, status=1, pac_w=24000.0, ppv_w=24800.0, eac_today_kwh=20.0))
                for sno in (1, 3, 4, 5):
                    v = 500.0 * (0.98 if sno in (1, 3) else 1.0)
                    db.add(
                        GrowattStringReading(
                            device_sn="INV1",
                            timestamp=ts,
                            string_no=sno,
                            mppt_no=(sno + 1) // 2,
                            voltage_v=v,
                            current_a=10.0,
                            power_w=v * 10.0,
                        )
                    )
            db.commit()
            growatt_daily.compute_day(db, d)

        str_rows = {
            (r.string_no, r.day): r
            for r in db.scalars(select(GrowattStringDaily).where(GrowattStringDaily.day == base_day))
        }
        assert str_rows[(1, base_day)].voltage_sensing == "per_string"
        assert str_rows[(3, base_day)].voltage_sensing == "shared_mppt"
        assert str_rows[(4, base_day)].voltage_sensing == "shared_mppt"
        assert str_rows[(5, base_day)].voltage_sensing == "per_string"

        findings = {(x["rule"], x["device_sn"], x["string_no"]): x for x in growatt_rules.evaluate(db, base_day)}
        # String 1 is per_string -> R4 fires!
        assert ("R4", "INV1", 1) in findings
        # String 3 shares MPPT 2 with String 4 -> R4 MUST NOT fire on shared_mppt!
        assert ("R4", "INV1", 3) not in findings

        # Now seed 15 days of R6 PID decline (> 1% per month drop) on String 5,
        # R10 Plant EPI 3-sigma drop on base_day, and R11 Inverter Ya - Yf drift on INV1.
        for k in range(15, 0, -1):
            d = base_day - timedelta(days=k)
            ratio_s5 = 1.0 - (15 - k) * 0.0015
            db.merge(
                GrowattStringDaily(
                    device_sn="INV1",
                    string_no=5,
                    day=d,
                    plant_id=1,
                    gated_slots=30,
                    ratio_median=ratio_s5,
                    low_min=0,
                    severe_min=0,
                    open_min=0,
                    v_ratio_median=1.0,
                    voltage_sensing="per_string",
                    energy_kwh=15.0,
                    lost_kwh_est=0.2,
                )
            )
            db.merge(
                GrowattPlantDaily(
                    plant_id=1,
                    day=d,
                    capacity_kwp=100.0,
                    energy_kwh=450.0,
                    epi=0.96 + (0.005 if k % 2 == 0 else -0.005),
                    pr_temp_corrected_pct=85.0,
                    filtered_slots=50,
                )
            )
            gap = 0.30 if k == 1 else 0.08
            db.merge(
                GrowattInverterDaily(
                    device_sn="INV1",
                    day=d,
                    plant_id=1,
                    daylight_min=600,
                    producing_min=580,
                    energy_kwh=400.0,
                    dc_energy_kwh=400.0 + gap * 100.0,
                    kwp=100.0,
                    ya_kwh_kwp=4.0 + gap,
                    yf_kwh_kwp=4.0,
                    ya_minus_yf=gap,
                )
            )
        s5_today = db.get(GrowattStringDaily, ("INV1", 5, base_day))
        assert s5_today is not None
        s5_today.ratio_median = 1.0 - 15 * 0.0015
        p_today = db.get(GrowattPlantDaily, (1, base_day))
        assert p_today is not None
        p_today.epi = 0.82
        p_today.energy_kwh = 380.0
        inv_today = db.get(GrowattInverterDaily, ("INV1", base_day))
        assert inv_today is not None
        inv_today.kwp = 100.0
        inv_today.ya_minus_yf = 0.32
        db.commit()

        findings2 = {(x["rule"], x["device_sn"], x["string_no"]): x for x in growatt_rules.evaluate(db, base_day)}
        assert ("R6", "INV1", 5) in findings2
        assert findings2[("R6", "INV1", 5)]["evidence"]["drop_pct_per_month"] > 1.0
        assert ("R10", None, None) in findings2
        assert findings2[("R10", None, None)]["evidence"]["trigger"] == "3sigma_1d"
        assert ("R11", "INV1", None) in findings2
        assert findings2[("R11", "INV1", None)]["evidence"]["gap_increase_h"] >= 0.15
