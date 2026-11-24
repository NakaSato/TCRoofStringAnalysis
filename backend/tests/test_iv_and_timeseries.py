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
from app.services.growatt_sync import store_string_rows
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_daily, growatt_overview, growatt_rules
from solar_core.iv_site_fit import fit_site_coefficients, interpolate_procedure_3
from solar_core.iv_analysis import (
    ModuleStcSpec,
    analyze_iv_sweep,
    estimate_stc_pmax_uncertainty,
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

    ok = validate_sweep_conditions(820.0, 44.0, "2026-11-10T11:30:00", irradiance_change_pct=0.6)
    assert ok["quality_gate_passed"] is True and ok["gate_reasons"] == [] and ok["gate_warnings"] == []

    # passes, but outside best practice (G < 800 W/m², ΔG > 1 %)
    warn = validate_sweep_conditions(750.0, 44.0, "2026-11-10T11:30:00", irradiance_change_pct=1.4)
    assert warn["quality_gate_passed"] is True and warn["gate_reasons"] == []
    assert len(warn["gate_warnings"]) == 2

    low_g = validate_sweep_conditions(620.0, 40.0, "2026-11-10T11:30:00", irradiance_change_pct=2.8)
    assert low_g["quality_gate_passed"] is False
    assert len(low_g["gate_reasons"]) == 2
    assert low_g["shape_gate_passed"] is False  # irradiance moved during the sweep

    # 400–700 W/m², stable: no STC comparison, but the curve shape can be read
    shape_only = validate_sweep_conditions(520.0, 40.0, "2026-11-10T11:30:00", irradiance_change_pct=0.5)
    assert shape_only["quality_gate_passed"] is False and shape_only["shape_gate_passed"] is True

    too_low = validate_sweep_conditions(350.0, 40.0, "2026-11-10T11:30:00")
    assert too_low["quality_gate_passed"] is False and too_low["shape_gate_passed"] is False


def test_steps_are_judged_on_the_measured_curve_and_never_against_warranty():
    modules = 10
    step_pts = _synth_stc_curve(modules=modules, add_step=True)
    v = [p["v"] for p in step_pts]
    # the same shape at 520 W/m²: below the STC gate, above the shape gate
    low = analyze_iv_sweep(
        voltage=v,
        current=[p["i"] * 0.52 for p in step_pts],
        irradiance_wm2=520.0,
        module_temp_c=25.0,
        swept_at="2026-11-10T09:00:00",
        spec=SPEC,
        modules=modules,
        ir_confirmed=True,
    )
    cls = low["classification"]
    assert low["conditions"]["quality_gate_passed"] is False
    assert low["measured"]["parameters"]["steps_count"] >= 1
    assert cls["signature"] == "steps_in_curve"
    assert cls["ticket_recommended"] is True
    assert cls["stc_comparison_valid"] is False
    assert cls["warranty"]["below_warranted_power"] is False
    assert cls["warranty"]["module_test_candidate"] is False

    # below 400 W/m² nothing becomes a ticket
    dark = analyze_iv_sweep(
        voltage=v,
        current=[p["i"] * 0.3 for p in step_pts],
        irradiance_wm2=300.0,
        module_temp_c=25.0,
        swept_at="2026-11-10T07:30:00",
        spec=SPEC,
        modules=modules,
    )
    assert dark["classification"]["ticket_recommended"] is False


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

    # 0. Inside the ±5 % dead band -> normal, no ticket
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
    # A module-test candidate needs 2 sources: not without IR or time-series agreement
    assert res_pid["classification"]["warranty"]["module_test_candidate"] is False

    # With a second source (IR or time-series trend) it becomes a candidate
    res_pid_2src = _run_sweep(
        pid_pts,
        modules=modules,
        near_negative_pole=True,
        ir_confirmed=True,
    )
    assert res_pid_2src["classification"]["warranty"]["module_test_candidate"] is True
    assert res_pid_2src["classification"]["warranty"]["second_source"] == "ir"

    # 8. All parameters down uniformly -> normal_degradation
    unif_pts = _synth_stc_curve(modules=modules, isc_scale=0.93, voc_offset_v=-0.045 * SPEC.voc_stc * modules)
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
    assert body["module_test_candidate"] is True

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


def _iv_client(tmp_path, strings=(1, 2, 3, 4)):
    engine = build_engine(f"sqlite:///{tmp_path / 'iv_peer.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add(GrowattPlant(plant_id=101, name="Solar Roof 101", create_date="2026-06-01", peak_power_kwp=57.0))
        db.add(GrowattInverter(device_sn="INV101", plant_id=101, nominal_power_w=50000.0))
        for n in strings:
            db.add(GrowattStringLayout(device_sn="INV101", string_no=n, modules=10))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)
    tok = client.post("/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    return client, {"Authorization": f"Bearer {tok}"}


def _post_sweep(client, hdr, string_no, pts, swept_at, **extra):
    r = client.post(
        "/growatt/plants/101/iv-sweeps",
        headers=hdr,
        json={
            "device_sn": "INV101",
            "string_no": string_no,
            "swept_at": swept_at,
            "irradiance_wm2": 1000.0,
            "module_temp_c": 25.0,
            "points": pts,
            **extra,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_iv_peer_and_baseline_comparison_on_read(tmp_path):
    client, hdr = _iv_client(tmp_path)
    healthy = _synth_stc_curve(modules=10)
    # 4 % low in current: inside the 5 % absolute dead band, but visible against same-time peers
    weak = _synth_stc_curve(modules=10, isc_scale=0.96)

    first = _post_sweep(client, hdr, 1, weak, "2026-11-10T11:00:00")
    assert first["signature"] == "normal" and first["ticket_recommended"] is False
    # no peers yet: no verdict, with the reason
    assert first["comparison"]["peer"]["ratios"] is None and first["comparison"]["peer"]["reason"]
    assert first["comparison"]["baseline"] is None

    _post_sweep(client, hdr, 2, healthy, "2026-11-10T11:05:00")
    _post_sweep(client, hdr, 3, healthy, "2026-11-10T11:10:00")
    # outside the 30 min window: not a peer
    _post_sweep(client, hdr, 4, healthy, "2026-11-10T13:00:00")

    got = client.get("/growatt/plants/101/iv-sweeps?sn=INV101&string_no=1", headers=hdr).json()["sweeps"][0]
    peer = got["comparison"]["peer"]
    assert peer["peers"] == 2 and peer["peer_strings"] == [2, 3]
    assert 0.95 < peer["ratios"]["i_sc"] < 0.97
    assert "isc_below_peers" in peer["flags"] and "pmax_below_peers" in peer["flags"]
    assert peer["setup_error_suspected"] is False
    assert got["comparison"]["thresholds"]["status"] == "proposed"
    # a peer flag marks the sweep; it does not open a ticket
    assert got["ticket_recommended"] is False

    healthy_row = client.get("/growatt/plants/101/iv-sweeps?sn=INV101&string_no=2", headers=hdr).json()["sweeps"][0]
    assert healthy_row["comparison"]["peer"]["flags"] == []

    # a later sweep of string 1 with more series resistance: judged against its own first sweep
    later = _post_sweep(client, hdr, 1, _synth_stc_curve(modules=10, isc_scale=0.96, rs_mult=4.0), "2026-11-20T11:00:00")
    base = later["comparison"]["baseline"]
    assert base["sweep_id"] == first["id"]
    assert base["ratios"]["p_max"] < 0.97 and "pmax_below_baseline" in base["flags"]
    assert "series_resistance_up" in base["flags"]


def test_iv_all_strings_low_together_suspects_the_setup(tmp_path):
    client, hdr = _iv_client(tmp_path, strings=(1, 2, 3))
    low = _synth_stc_curve(modules=10, isc_scale=0.85)
    for n, t in ((1, "11:00"), (2, "11:04"), (3, "11:08")):
        _post_sweep(client, hdr, n, low, f"2026-11-10T{t}:00")
    got = client.get("/growatt/plants/101/iv-sweeps?sn=INV101&string_no=2", headers=hdr).json()["sweeps"][0]
    assert got["signature"] == "isc_low_normal_shape"
    assert got["comparison"]["peer"]["setup_error_suspected"] is True
    assert got["comparison"]["peer"]["flags"] == []  # equal to its peers


def test_iv_inverter_scan_is_relative_only_and_translation_extras(tmp_path):
    client, hdr = _iv_client(tmp_path)
    low = _synth_stc_curve(modules=10, isc_scale=0.84)
    scan = _post_sweep(client, hdr, 1, low, "2026-11-10T11:00:00", source="inverter_scan", ir_confirmed=True)
    # the same curve from a handheld tracer is a ticket (see the signature test); a scan is not
    assert scan["signature"] == "isc_low_normal_shape"
    assert scan["ticket_recommended"] is False
    assert scan["module_test_candidate"] is False
    assert scan["classification"]["stc_comparison_valid"] is False
    assert any("Inverter scan" in w for w in scan["classification"]["gate_warnings"])
    # a handheld sweep is not a peer of an inverter scan
    hand = _post_sweep(client, hdr, 2, low, "2026-11-10T11:05:00")
    assert hand["ticket_recommended"] is True
    assert hand["comparison"]["peer"]["peers"] == 0

    # Procedure 2 cross-check and the 55 °C site reference ride along in `iec60891`
    iec = hand["iec60891"]
    assert iec["procedure"] == 1
    assert iec["procedure_2"]["coefficients"] == "assumed"
    assert abs(iec["procedure_2"]["diff_vs_procedure_1_pct"]) < 1.0
    site = iec["site_reference"]
    assert site["t_c"] == 55.0 and site["parameters"]["p_max_w"] < hand["p_max_stc_w"]


def test_iec60891_procedure_2_matches_procedure_1_near_stc():
    modules = 10
    pts = _synth_stc_curve(modules=modules)
    v, i = [p["v"] for p in pts], [p["i"] for p in pts]
    base = extract_iv_parameters(v, i)["p_max_w"]
    for proc in (1, 2):
        # no change of conditions = the same curve
        same = translate_to_stc_iec60891(v, i, 1000.0, 25.0, SPEC, modules, procedure=proc)
        assert extract_iv_parameters(same["v_stc"], same["i_stc"])["p_max_w"] == pytest.approx(base, rel=1e-3)
    # 900 W/m², 45 °C -> STC: both procedures raise power, and agree within 1 %
    out = {}
    for proc in (1, 2):
        t = translate_to_stc_iec60891(v, i, 900.0, 45.0, SPEC, modules, r_s_ohm=modules * SPEC.rs_ohm, procedure=proc)
        out[proc] = extract_iv_parameters(t["v_stc"], t["i_stc"])["p_max_w"]
    assert out[1] > base and out[2] > base
    assert out[2] == pytest.approx(out[1], rel=0.01)
    with pytest.raises(ValueError):
        translate_to_stc_iec60891(v, i, 900.0, 45.0, SPEC, modules, procedure=3)


def test_procedure_4_and_dynamic_procedure_cross_checks():
    modules = 10
    healthy = _synth_stc_curve(modules=modules)
    v, i = [p["v"] for p in healthy], [p["i"] for p in healthy]
    base = extract_iv_parameters(v, i)["p_max_w"]
    for proc in (4, "dynamic"):
        same = translate_to_stc_iec60891(v, i, 1000.0, 25.0, SPEC, modules, procedure=proc)
        assert extract_iv_parameters(same["v_stc"], same["i_stc"])["p_max_w"] == pytest.approx(base, rel=1e-3)

    res = analyze_iv_sweep(v, i, 850.0, 58.0, "2026-11-10 12:00:00", SPEC, modules=modules)
    iec = res["iec60891"]
    assert iec["procedure"] == 1  # the judged result stays Procedure 1
    assert abs(iec["procedure_4"]["diff_vs_procedure_1_pct"]) < 1.0
    assert iec["procedure_4"]["cells_in_series"] == 720
    # a healthy curve has a high shunt resistance: neglected, so dynamic = Procedure 2
    dyn = iec["procedure_dynamic"]
    assert dyn["shunt_neglected"] is True and dyn["r_sh_ohm"] is None
    assert dyn["diff_vs_procedure_2_pct"] == pytest.approx(0.0, abs=0.05)

    # a shunted curve: the dynamic procedure uses the fitted Rsh and departs from Procedure 2
    shunted = _synth_stc_curve(modules=modules, rsh_ohm=150.0)
    res = analyze_iv_sweep(
        [p["v"] for p in shunted], [p["i"] for p in shunted], 850.0, 58.0, "2026-11-10 12:00:00", SPEC, modules=modules
    )
    dyn = res["iec60891"]["procedure_dynamic"]
    assert dyn["shunt_neglected"] is False and 100 < dyn["r_sh_ohm"] < 250
    assert abs(dyn["diff_vs_procedure_2_pct"]) > 1.0
    warnings = res["classification"]["gate_warnings"]
    assert any("dynamic procedure" in w for w in warnings)
    # the spread between procedures replaces the assumed 1 % translation component
    tr = next(c for c in res["classification"]["uncertainty"]["components"] if c["name"] == "translation")
    assert tr["source"] == "procedure_spread" and tr["pct"] > 1.0


def test_temperature_and_sweep_time_gates_and_uncertainty_estimate():
    ok = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", temp_change_k_per_min=0.5, sweep_time_ms=200.0)
    assert ok["quality_gate_passed"] and ok["gate_warnings"] == [] and ok["quality_flags"] == []

    drift = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", temp_change_k_per_min=1.8)
    assert drift["quality_gate_passed"] and drift["quality_flags"] == ["unstable_T"]
    assert "1.8 K" in drift["gate_warnings"][0]

    # under 100 ms: rejected for power on high-capacitance cells, a warning when the technology is unknown,
    # nothing on PERC
    fast = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", sweep_time_ms=20.0, cell_technology="TOPCon")
    assert fast["quality_gate_passed"] is False and fast["shape_gate_passed"] is True
    assert fast["quality_flags"] == ["capacitance_suspect"]
    unknown = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", sweep_time_ms=20.0)
    assert unknown["quality_gate_passed"] is True and unknown["quality_flags"] == ["capacitance_suspect"]
    assert len(unknown["gate_warnings"]) == 1
    perc = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", sweep_time_ms=20.0, cell_technology="perc")
    assert perc["quality_gate_passed"] and perc["gate_warnings"] == [] and perc["quality_flags"] == []

    # 2.5 % sensor (assumed), 3 K x 0.30 %/K, 10 % of 0.30 %/K over 30 K, 1 % translation
    u = estimate_stc_pmax_uncertainty(module_temp_c=55.0, spec=SPEC)
    assert u["coverage_k"] == 2 and u["lower_bound"] is True
    assert {c["name"]: c["source"] for c in u["components"]}["irradiance_sensor"] == "assumed"
    assert u["expanded_pct"] == pytest.approx((2.5**2 + 0.9**2 + 0.9**2 + 1.0**2) ** 0.5, abs=0.05)
    # a calibrated sensor lowers it; a long translation and unstable conditions raise it
    better = estimate_stc_pmax_uncertainty(module_temp_c=55.0, spec=SPEC, irradiance_uncertainty_pct=1.0)
    worse = estimate_stc_pmax_uncertainty(
        module_temp_c=70.0, spec=SPEC, irradiance_change_pct=1.8, temp_change_k_per_min=2.0, procedure_spread_pct=2.4
    )
    assert better["expanded_pct"] < u["expanded_pct"] < worse["expanded_pct"]
    assert better["components"][0] == {"name": "irradiance_sensor", "pct": 1.0, "source": "input"}


def test_iv_api_stores_optional_conditions_and_uncertainty(tmp_path):
    client, hdr = _iv_client(tmp_path)
    pts = _synth_stc_curve(modules=10, isc_scale=0.84)
    fast = _post_sweep(
        client,
        hdr,
        1,
        pts,
        "2026-11-10T11:00:00",
        sweep_time_ms=20,
        cell_technology="topcon",
        temp_change_k_per_min=1.5,
        irradiance_uncertainty_pct=6.0,
    )
    assert fast["sweep_time_ms"] == 20 and fast["cell_technology"] == "topcon"
    assert fast["temp_change_k_per_min"] == 1.5 and fast["irradiance_uncertainty_pct"] == 6.0
    # too fast for TOPCon: the power is not judged, so no ticket for the low current
    assert fast["quality_gate_passed"] is False and fast["ticket_recommended"] is False
    cls = fast["classification"]
    assert set(cls["quality_flags"]) == {"unstable_T", "capacitance_suspect"}
    assert cls["uncertainty"]["expanded_pct"] > 6.0
    assert any("larger than" in w for w in cls["gate_warnings"])

    # nothing optional given: stored as null, uncertainty from the assumed inputs
    plain = _post_sweep(client, hdr, 2, pts, "2026-11-10T11:05:00")
    assert plain["sweep_time_ms"] is None and plain["cell_technology"] is None
    assert plain["classification"]["quality_flags"] == []
    assert plain["classification"]["uncertainty"]["components"][0]["source"] == "assumed"
    # an inverter scan has no uncertainty budget
    scan = _post_sweep(client, hdr, 3, pts, "2026-11-10T11:10:00", source="inverter_scan")
    assert scan["classification"]["uncertainty"] is None
    r = client.post(
        "/growatt/plants/101/iv-sweeps",
        headers=hdr,
        json={"swept_at": "2026-11-10T11:00:00", "irradiance_wm2": 900, "module_temp_c": 40, "points": pts, "cell_technology": "cdte"},
    )
    assert r.status_code == 422


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
                    store_string_rows(db, [dict(
                            device_sn="INV1",
                            timestamp=ts,
                            string_no=sno,
                            mppt_no=(sno + 1) // 2,
                            voltage_v=v,
                            current_a=10.0,
                        )])
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


def test_forward_reverse_sensor_alignment_ect_and_fleet_factors():
    modules = 10
    pts = _synth_stc_curve(modules=modules)
    v, i = [p["v"] for p in pts], [p["i"] for p in pts]
    p_meas = extract_iv_parameters(v, i)["p_max_w"]

    # opposite-direction sweep within 1 %: fine; further apart: capacitance suspected (a warning)
    close = _run_sweep(pts, modules=modules, reverse_pmax_w=p_meas * 1.005)["classification"]
    assert close["forward_reverse"]["capacitance_suspect"] is False and close["quality_flags"] == []
    far = _run_sweep(pts, modules=modules, reverse_pmax_w=p_meas * 1.04)["classification"]
    assert far["forward_reverse"]["diff_pct"] == pytest.approx(3.92, abs=0.05)
    assert far["quality_flags"] == ["capacitance_suspect"]
    assert any("sweep directions" in w for w in far["gate_warnings"])
    assert _run_sweep(pts, modules=modules)["classification"]["forward_reverse"] is None

    # sensor off the array plane: note above 1 degree, flag above 2 degrees, never a rejection
    g = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", sensor_misalignment_deg=0.5)
    assert g["gate_warnings"] == [] and g["quality_flags"] == []
    g = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", sensor_misalignment_deg=1.5)
    assert len(g["gate_warnings"]) == 1 and g["quality_flags"] == []
    g = validate_sweep_conditions(900.0, 50.0, "2026-11-10 12:00:00", sensor_misalignment_deg=3.0)
    assert g["quality_flags"] == ["sensor_misaligned"] and g["quality_gate_passed"] is True

    # equivalent cell temperature from Voc: an STC curve reads 25 °C whatever temperature was typed in
    ect = _run_sweep(pts, modules=modules)["classification"]["equivalent_cell_temp"]
    assert ect["t_c"] == pytest.approx(25.0, abs=0.3) and ect["basis"] == "datasheet_voc"
    res = analyze_iv_sweep(v, i, 1000.0, 32.0, "2026-11-10 12:00:00", SPEC, modules=modules)
    assert res["classification"]["equivalent_cell_temp"]["diff_vs_measured_k"] == pytest.approx(-7.0, abs=0.3)
    assert res["iec60891"]["t1_c"] == 32.0  # the translation still uses the measured temperature
    # not given for a curve whose Voc is not healthy
    diode = _synth_stc_curve(modules=modules, voc_offset_v=-SPEC.voc_stc / 3)
    cls = _run_sweep(diode, modules=modules)["classification"]
    assert cls["signature"] == "bypass_diode_shorted" and cls["equivalent_cell_temp"] is None

    # Procedure 2 irradiance factors of the fleet module replace the assumed ones
    assert SPEC.p2_factors() == (0.045, 0.0, "assumed")
    own = ModuleStcSpec.from_dict({"p2_b1": 0.06, "p2_b2": 0.002})
    assert own.p2_factors() == (0.06, 0.002, "fleet_setting")
    low_g = analyze_iv_sweep(v, i, 750.0, 50.0, "2026-11-10 12:00:00", own, modules=modules)["iec60891"]["procedure_2"]
    ref = analyze_iv_sweep(v, i, 750.0, 50.0, "2026-11-10 12:00:00", SPEC, modules=modules)["iec60891"]["procedure_2"]
    assert low_g["coefficients"] == "fleet_setting" and low_g["b1"] == 0.06
    assert ref["coefficients"] == "assumed" and low_g["p_max_stc_w"] != ref["p_max_stc_w"]


def test_fleet_module_cell_technology_applies_to_every_sweep(tmp_path):
    client, hdr = _iv_client(tmp_path)
    fm = client.get("/growatt/fleet-module", headers=hdr).json()
    body = {k: fm[k] for k in ("manufacturer", "model", "wp", "voc_stc", "isc_stc", "vmp_stc", "imp_stc")}
    r = client.put("/growatt/fleet-module", headers=hdr, json={**body, "cell_technology": "topcon", "p2_b1": 0.05})
    assert r.status_code == 200, r.text
    assert r.json()["cell_technology"] == "topcon" and r.json()["p2_b1"] == 0.05
    pts = _synth_stc_curve(modules=10)
    fast = _post_sweep(client, hdr, 1, pts, "2026-11-10T11:00:00", sweep_time_ms=20, reverse_pmax_w=5500, sensor_misalignment_deg=2.5)
    assert fast["cell_technology"] == "topcon" and fast["quality_gate_passed"] is False
    assert fast["reverse_pmax_w"] == 5500 and fast["sensor_misalignment_deg"] == 2.5
    assert "sensor_misaligned" in fast["classification"]["quality_flags"]
    assert fast["iec60891"]["procedure_2"]["coefficients"] == "fleet_setting"
    # the sweep's own value wins over the fleet setting
    perc = _post_sweep(client, hdr, 2, pts, "2026-11-10T11:05:00", sweep_time_ms=20, cell_technology="perc")
    assert perc["quality_gate_passed"] is True


def _field_curve(g, t, modules=10, b1=0.06, beta_pct=-0.28):
    """An STC curve carried to (g, t) with Procedure 2 and known coefficients: a stand-in for a field sweep."""
    from dataclasses import replace

    true = replace(SPEC, p2_b1=b1, temp_coeff_voc_pct=beta_pct)
    pts = _synth_stc_curve(modules=modules)
    tr = translate_to_stc_iec60891(
        [p["v"] for p in pts], [p["i"] for p in pts], 1000.0, 25.0, true, modules,
        r_s_ohm=0.30 * modules, kappa_ohm_per_k=0.002 * modules, procedure=2,
        target_irradiance_wm2=g, target_temp_c=t,
    )
    return {"v": [float(x) for x in tr["v_stc"]], "i": [float(x) for x in tr["i_stc"]], "g": g, "t": t}


def test_site_coefficient_fit_recovers_known_values_and_says_what_it_cannot_determine():
    wide = [_field_curve(g, t) for g, t in [(450, 38), (600, 45), (780, 52), (900, 58), (980, 63)]]
    fit = fit_site_coefficients(wide, SPEC, 10)
    assert fit["reasons"] == [
        "Irradiance and temperature move together in these sweeps, so Rs and κ cannot be told apart reliably"
    ]
    assert fit["voc"]["voc_stc_per_module_v"] == pytest.approx(SPEC.voc_stc, abs=0.05)
    assert fit["voc"]["beta_rel_pct_per_k"] == pytest.approx(-0.28, abs=0.005)
    assert fit["voc"]["b1"] == pytest.approx(0.06, abs=0.002)
    assert fit["voc"]["b2"] is None
    res = fit["resistance"]
    assert res["rs_ohm_per_module"] is not None and res["pmax_spread_after_pct"] < res["pmax_spread_before_pct"]

    # narrow irradiance range: B1 and Rs stay null, with the reason; β is still fitted
    narrow = fit_site_coefficients([_field_curve(900, 40), _field_curve(920, 60), _field_curve(950, 50)], SPEC, 10)
    assert narrow["voc"]["b1"] is None and narrow["resistance"]["rs_ohm_per_module"] is None
    assert narrow["voc"]["beta_rel_pct_per_k"] == pytest.approx(-0.28, abs=0.02)
    assert any("B1 and Rs are not determined" in r for r in narrow["reasons"])
    # same temperature: β and κ stay null
    flat = fit_site_coefficients([_field_curve(500, 50), _field_curve(700, 51), _field_curve(950, 52)], SPEC, 10)
    assert flat["voc"]["beta_rel_pct_per_k"] is None and flat["resistance"]["kappa_ohm_per_k_per_module"] is None
    assert flat["voc"]["b1"] == pytest.approx(0.06, abs=0.01)
    # too few sweeps: nothing fitted
    two = fit_site_coefficients(wide[:2], SPEC, 10)
    assert two["voc"] is None and two["resistance"] is None and two["procedure_3"] is not None
    assert fit_site_coefficients(wide[:1], SPEC, 10)["procedure_3"] is None


def test_procedure_3_interpolates_between_two_curves():
    lo, hi, mid = _field_curve(600, 45), _field_curve(1000, 45), _field_curve(800, 45)
    p3 = interpolate_procedure_3(lo["v"], lo["i"], 600, 45, hi["v"], hi["i"], 1000, 45, target_irradiance_wm2=800)
    assert p3["extrapolated"] is False and p3["t_c"] == 45.0 and p3["a"] == 0.5
    want = extract_iv_parameters(mid["v"], mid["i"])
    assert p3["parameters"]["i_sc_a"] == pytest.approx(want["i_sc_a"], rel=0.005)
    assert p3["parameters"]["p_max_w"] == pytest.approx(want["p_max_w"], rel=0.01)
    out = interpolate_procedure_3(lo["v"], lo["i"], 600, 45, mid["v"], mid["i"], 800, 45)
    assert out["extrapolated"] is True
    with pytest.raises(ValueError):
        interpolate_procedure_3(lo["v"], lo["i"], 600, 45, lo["v"], lo["i"], 600, 50)


def test_site_coefficients_api_uses_only_healthy_handheld_sweeps(tmp_path):
    client, hdr = _iv_client(tmp_path)
    url = "/growatt/plants/101/iv-sweeps/site-coefficients?sn=INV101&string_no=1"
    empty = client.get(url, headers=hdr).json()
    assert empty["stored_sweeps"] == 0 and empty["voc"] is None and empty["reasons"]

    ids = []
    for n, (g, t) in enumerate([(450, 38), (600, 45), (780, 52), (900, 58), (980, 63)]):
        c = _field_curve(g, t)
        pts = [{"v": v, "i": i} for v, i in zip(c["v"], c["i"])]
        ids.append(_post_sweep(client, hdr, 1, pts, f"2026-11-10T1{n}:00:00", irradiance_wm2=g, module_temp_c=t)["id"])
    # not used: a stepped curve, an inverter scan, another string
    stepped = _synth_stc_curve(modules=10, add_step=True)
    _post_sweep(client, hdr, 1, stepped, "2026-11-10T16:00:00")
    _post_sweep(client, hdr, 1, _synth_stc_curve(modules=10), "2026-11-10T16:10:00", source="inverter_scan")
    _post_sweep(client, hdr, 2, _synth_stc_curve(modules=10), "2026-11-10T16:20:00")

    # only low-irradiance sweeps so far: nothing says the string is healthy, so no fit
    early = client.get("/growatt/plants/101/iv-sweeps/site-coefficients?sn=INV101&string_no=3", headers=hdr).json()
    assert early["voc"] is None
    c = _field_curve(500, 40)
    _post_sweep(client, hdr, 3, [{"v": v, "i": i} for v, i in zip(c["v"], c["i"])], "2026-11-10T10:00:00", irradiance_wm2=500, module_temp_c=40)
    early = client.get("/growatt/plants/101/iv-sweeps/site-coefficients?sn=INV101&string_no=3", headers=hdr).json()
    assert early["used_sweep_ids"] == [] and any("STC gate" in r for r in early["reasons"])

    out = client.get(url, headers=hdr).json()
    assert out["stored_sweeps"] == 6 and sorted(out["used_sweep_ids"]) == sorted(ids)
    assert out["status"] == "estimate" and out["modules"] == 10
    assert out["voc"]["b1"] == pytest.approx(0.06, abs=0.003)
    assert out["procedure_3"]["from_irradiance_wm2"] == [450.0, 980.0]
    assert client.get("/growatt/plants/101/iv-sweeps/site-coefficients?sn=INV101", headers=hdr).status_code == 422


def test_sweep_below_the_stc_gate_is_not_judged_except_for_steps():
    # a healthy string at 450 W/m²: the long translation alone would read as a Voc fault
    c = _field_curve(450, 38)
    cls = analyze_iv_sweep(c["v"], c["i"], 450.0, 38.0, "2026-11-10 12:00:00", SPEC, modules=10)["classification"]
    assert cls["signature"] == "not_judged" and cls["unjudged_signature"] == "miswiring_or_module_count"
    assert cls["is_finding"] is False and cls["ticket_recommended"] is False
    assert cls["stc_comparison_valid"] is False and cls["warranty"]["below_warranted_power"] is False
    # steps are read from the measured shape, so they are still judged from 400 W/m²
    stepped = _synth_stc_curve(modules=10, add_step=True)
    cls = analyze_iv_sweep(
        [p["v"] for p in stepped], [p["i"] for p in stepped], 500.0, 25.0, "2026-11-10 12:00:00", SPEC, modules=10
    )["classification"]
    assert cls["signature"] == "steps_in_curve" and cls["ticket_recommended"] is True and cls["unjudged_signature"] is None
    # a sweep that passed the gate keeps its signature
    ok = _run_sweep(_synth_stc_curve(modules=10, isc_scale=0.84), modules=10)["classification"]
    assert ok["signature"] == "isc_low_normal_shape" and ok["unjudged_signature"] is None


def test_sweep_past_voc_reads_voc_at_the_first_zero_current_point():
    pts = _synth_stc_curve(modules=10)
    voc = pts[-1]["v"]
    step = pts[-1]["v"] - pts[-2]["v"]
    # the tracer keeps sweeping 5 points past Voc, reading 0 A
    past = pts + [{"v": round(voc + k * step, 2), "i": 0.0} for k in range(1, 6)]
    assert extract_iv_parameters([p["v"] for p in past], [p["i"] for p in past])["v_oc_v"] == round(voc, 2)
    a, b = _run_sweep(pts, modules=10), _run_sweep(past, modules=10)
    assert b["stc"]["parameters"]["v_oc_v"] == a["stc"]["parameters"]["v_oc_v"]
    assert b["classification"]["signature"] == a["classification"]["signature"] == "normal"


def test_low_shunt_curve_with_lowered_voc_is_not_read_as_a_structural_fault():
    # a collapsed shunt lowers Voc by about one substring; the slope near Isc tells it apart
    pts = _synth_stc_curve(modules=10, rsh_ohm=55.0)
    cls = _run_sweep(pts, modules=10)["classification"]
    assert cls["deviations_pct"]["v_oc_vs_stc_pct"] < -2.0  # Voc really is low
    assert cls["signature"] == "low_shunt_resistance"


def test_iv_shadow_issue_is_not_a_second_source(tmp_path):
    """Audit #33: an uncalibrated shadow-mode issue must not confirm a time-series trend."""
    client, hdr = _iv_client(tmp_path, strings=(1,))
    from fastapi import FastAPI

    from app.services import growatt_iv

    app = client.app
    assert isinstance(app, FastAPI)
    with next(app.dependency_overrides[get_db]()) as db:
        db.add(
            GrowattIssue(
                plant_id=101, device_sn="INV101", string_no=1, rule="R6", tier="P2", safety=False,
                opened_day=date(2026, 11, 9), last_seen_day=date(2026, 11, 10), days_seen=2,
                status="open", shadow=True,
            )
        )
        db.commit()
        assert growatt_iv._has_timeseries_trend(db, 101, "INV101", 1) is False

    body = _post_sweep(client, hdr, 1, _synth_stc_curve(modules=10, isc_scale=0.84), "2026-11-10T11:00:00")
    assert body["timeseries_trend_confirmed"] is False
    assert body["module_test_candidate"] is False


def test_iv_unknown_module_count_is_rejected_not_inferred(tmp_path):
    """Audit #33: no String Layout and no `modules` = 422; never guess the count from Voc."""
    client, hdr = _iv_client(tmp_path, strings=(1,))
    # string 2 has no layout; a 9-module string (one missing) would be inferred as 9 and look normal
    r = client.post(
        "/growatt/plants/101/iv-sweeps",
        headers=hdr,
        json={
            "device_sn": "INV101",
            "string_no": 2,
            "swept_at": "2026-11-10T11:00:00",
            "irradiance_wm2": 1000.0,
            "module_temp_c": 25.0,
            "points": _synth_stc_curve(modules=9),
        },
    )
    assert r.status_code == 422 and "String Layout" in r.text
    # an explicit count in the request still works, and the missing module shows up
    body = _post_sweep(client, hdr, 2, _synth_stc_curve(modules=10, voc_offset_v=-SPEC.voc_stc), "2026-11-10T11:05:00", modules=10)
    assert body["modules"] == 10 and body["signature"] == "miswiring_or_module_count"


def test_iv_per_string_wp_keeps_the_datasheet_fill_factor():
    """Audit #33: a per-string module Wp scales Isc/Imp too, so the reference FF is unchanged."""
    from app.services.growatt_iv import _spec_for_wp

    fm = {"wp": 660.0, "voc_stc": 45.6, "isc_stc": 18.4, "vmp_stc": 38.1, "imp_stc": 17.33}
    base = ModuleStcSpec.from_dict(fm)
    got = ModuleStcSpec.from_dict(_spec_for_wp(fm, 550.0))
    assert got.wp == 550.0
    assert got.voc_stc == base.voc_stc and got.vmp_stc == base.vmp_stc
    assert got.isc_stc == pytest.approx(18.4 * 550 / 660)
    ff = lambda s: s.wp / (s.voc_stc * s.isc_stc)  # noqa: E731
    assert ff(got) == pytest.approx(ff(base))
    assert _spec_for_wp(fm, None) == fm


def test_epi_is_null_without_any_measured_module_temperature(tmp_path):
    """No module temperature measured all day: EPI is null, never modelled at an assumed 25 °C."""
    engine = build_engine(f"sqlite:///{tmp_path / 'epi.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    day = date(2026, 11, 10)
    with f() as db:
        db.add(GrowattPlant(plant_id=1, name="Roof", latitude=13.75, longitude=100.5, peak_power_kwp=100.0))
        db.flush()
        db.add(GrowattInverter(device_sn="INV1", plant_id=1, nominal_power_w=100000.0))
        db.add(GrowattEnvSensor(datalogger_sn="DL1", address=1, plant_id=1, device_name="POA Sensor"))
        db.flush()
        eac = 0.0
        t = datetime(2026, 11, 10, 9, 0)
        while t < datetime(2026, 11, 10, 15, 0):
            g = 800.0 + ((t.minute // 5) % 2)
            pac_w = 100.0 * (g / 1000.0) * 0.76 * 1000.0
            eac += pac_w * (5.0 / 60.0) / 1000.0
            db.add(GrowattEnvReading(datalogger_sn="DL1", address=1, timestamp=t, irradiance_wm2=g, module_temp_c=None, ambient_temp_c=34.0))
            db.add(GrowattInverterReading(device_sn="INV1", timestamp=t, status=1, pac_w=pac_w, ppv_w=pac_w / 0.96, eac_today_kwh=round(eac, 3)))
            t += timedelta(minutes=5)
        db.commit()

        kpis = growatt_overview.build_plant_overview(db, 1, day)["kpis"]
        assert kpis["iec_pr_pct"] == pytest.approx(76.0, abs=0.5)  # PR needs no module temperature
        assert kpis["epi"] is None
        growatt_daily.compute_day(db, day)
        row = db.scalar(select(GrowattPlantDaily).where(GrowattPlantDaily.plant_id == 1, GrowattPlantDaily.day == day))
        assert row is not None and row.epi is None and row.modelled_energy_kwh is None
