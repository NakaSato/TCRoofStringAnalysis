"""Parity fixtures for the Rust port of backend/solar_core/iv_analysis.py, iv_site_fit.py and
iv_operating.py (crate tcroof-solar-core).

Run from the repo root:

    PYTHONPATH=backend uv run python rust/crates/solar-core/tests/fixtures/iv_gen.py

Writes iv_analysis.json, iv_site_fit.json and iv_operating.json next to this script. Curves
are the synthetic ones of backend/tests/test_iv_and_timeseries.py (healthy and each fault
signature, field sweeps carried to (G, T) by Procedure 2) plus edge cases: noise, shading
steps, zero current, open circuit, few points, unsorted / duplicate / negative / NaN points,
sweeps past Voc. Non-finite floats are written as "nan" / "inf" / "-inf".
"""

from __future__ import annotations

import dataclasses
import json
import math
import random
import warnings
from pathlib import Path

import numpy as np

from solar_core import iv_analysis as iva
from solar_core import iv_operating as ivo
from solar_core import iv_site_fit as ivs
from solar_core.iv_analysis import ModuleStcSpec

HERE = Path(__file__).resolve().parent
warnings.simplefilter("ignore")


def clean(x):
    """JSON-able copy: numpy to Python, non-finite floats as strings, tuples as lists."""
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, np.ndarray):
        return [clean(v) for v in x.tolist()]
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        x = float(x)
        if math.isnan(x):
            return "nan"
        if math.isinf(x):
            return "inf" if x > 0 else "-inf"
        return x
    return x


def run(fn, *args, **kwargs):
    """{"result": …} or {"error": class name, "message": …}."""
    try:
        return {"result": clean(fn(*args, **kwargs))}
    except Exception as exc:  # noqa: BLE001 - every Python exception is part of the contract
        return {"error": type(exc).__name__, "message": str(exc)}


def write(name, data):
    path = HERE / name
    path.write_text(json.dumps(data, indent=None, separators=(",", ":"), allow_nan=False) + "\n")
    print(f"{name}: {', '.join(f'{k} {len(v)}' for k, v in data.items())}")


SPEC = ModuleStcSpec()
SPECS = {
    "default": SPEC,
    "own_p2": ModuleStcSpec.from_dict({"p2_b1": 0.06, "p2_b2": 0.002}),
    "m660": ModuleStcSpec.from_dict({"wp": 660.0, "voc_stc": 45.6, "isc_stc": 18.4, "vmp_stc": 38.1, "imp_stc": 17.33}),
    "cells60_sub2": dataclasses.replace(SPEC, cells_per_module=60, substrings_per_module=2, temp_coeff_voc_pct=-0.29),
    "flat_voc": dataclasses.replace(SPEC, temp_coeff_voc_pct=0.0, p2_b1=0.05),
    "old_lid": dataclasses.replace(SPEC, first_year_lid_pct=2.0, annual_degradation_pct=0.55, rs_ohm=0.3, kappa_ohm_per_k=0.002),
}


def spec_json(s):
    return clean(dataclasses.asdict(s))


# --------------------------------------------------------------------------- curves

def synth(modules=1, isc_scale=1.0, voc_offset_v=0.0, rs_mult=1.0, rsh_ohm=None, add_step=False, n_points=80, spec=SPEC):
    """As _synth_stc_curve in backend/tests/test_iv_and_timeseries.py."""
    desoto = iva.fit_desoto(
        v_mp=spec.vmp_stc * modules, i_mp=spec.imp_stc * isc_scale, v_oc=spec.voc_stc * modules + voc_offset_v,
        i_sc=spec.isc_stc * isc_scale, alpha_sc_a_per_k=spec.alpha_a_per_k(), beta_oc_v_per_k=spec.beta_v_per_k(modules),
        n_cells_series=72 * modules,
    )
    r_s = desoto["r_s_ohm"] * rs_mult
    r_sh = rsh_ohm if rsh_ohm is not None else desoto["r_sh_ref_ohm"]
    v_oc = spec.voc_stc * modules + voc_offset_v
    pts = iva.simulate_single_diode_curve(desoto["i_l_ref_a"], desoto["i_o_ref_a"], r_s, r_sh, desoto["a_ref_v"], v_oc, n_points)
    if add_step:
        out = []
        for p in pts:
            v, i = p["v"], p["i"]
            if 0.45 * v_oc < v < 0.85 * v_oc:
                i = i * (0.72 + 0.28 * max(0.0, min(1.0, (0.55 * v_oc - v) / (0.10 * v_oc))))
            out.append((round(v, 2), round(i, 3)))
        return [p[0] for p in out], [p[1] for p in out]
    return [p["v"] for p in pts], [p["i"] for p in pts]


def field(g, t, modules=10, b1=0.06, beta_pct=-0.28, n_points=80):
    """As _field_curve: an STC curve carried to (g, t) with Procedure 2 and known coefficients."""
    true = dataclasses.replace(SPEC, p2_b1=b1, temp_coeff_voc_pct=beta_pct)
    v, i = synth(modules=modules, n_points=n_points)
    tr = iva.translate_to_stc_iec60891(v, i, 1000.0, 25.0, true, modules, r_s_ohm=0.30 * modules,
                                       kappa_ohm_per_k=0.002 * modules, procedure=2, target_irradiance_wm2=g, target_temp_c=t)
    return [float(x) for x in tr["v_stc"]], [float(x) for x in tr["i_stc"]]


def build_curves(rng):
    curves = []

    def add(name, v, i, modules=1):
        curves.append({"name": name, "modules": modules, "v": clean(list(v)), "i": clean(list(i))})

    for m in (1, 10, 18):
        add(f"healthy_m{m}", *synth(modules=m), modules=m)
    add("healthy_m10_30pts", *synth(modules=10, n_points=30), modules=10)
    add("healthy_m10_12pts", *synth(modules=10, n_points=12), modules=10)
    add("healthy_m10_200pts", *synth(modules=10, n_points=200), modules=10)
    add("deadband_isc0985", *synth(modules=10, isc_scale=0.985), modules=10)
    add("soiling_isc084", *synth(modules=10, isc_scale=0.84), modules=10)
    add("bypass_diode", *synth(modules=10, voc_offset_v=-(SPEC.voc_stc / 3.0)), modules=10)
    add("two_substrings", *synth(modules=10, voc_offset_v=-(2 * SPEC.voc_stc / 3.0)), modules=10)
    add("missing_module", *synth(modules=10, voc_offset_v=-SPEC.voc_stc), modules=10)
    add("missing_two_modules", *synth(modules=10, voc_offset_v=-2 * SPEC.voc_stc), modules=10)
    add("step", *synth(modules=10, add_step=True), modules=10)
    add("step_m18", *synth(modules=18, add_step=True), modules=18)
    add("high_rs", *synth(modules=10, rs_mult=4.0), modules=10)
    add("high_rs_m1", *synth(modules=1, rs_mult=6.0), modules=1)
    add("low_rsh", *synth(modules=10, rsh_ohm=55.0), modules=10)
    add("shunted_150", *synth(modules=10, rsh_ohm=150.0), modules=10)
    add("pid", *synth(modules=10, voc_offset_v=-25.0, rsh_ohm=45.0), modules=10)
    add("uniform_degradation", *synth(modules=10, isc_scale=0.93, voc_offset_v=-0.045 * SPEC.voc_stc * 10), modules=10)
    add("m660_healthy", *synth(modules=12, spec=SPECS["m660"]), modules=12)
    for g, t in [(450, 38), (600, 45), (780, 52), (900, 58), (980, 63), (850, 58), (520, 30), (300, 25), (1100, 20)]:
        add(f"field_{g}_{t}", *field(g, t), modules=10)
    # stepped curve at low light (as test_steps_are_judged_on_the_measured_curve)
    v, i = synth(modules=10, add_step=True)
    add("step_low_052", v, [x * 0.52 for x in i], modules=10)
    add("step_dark_03", v, [x * 0.3 for x in i], modules=10)

    # noise on a healthy and a stepped curve
    for name, (v, i) in [("noisy_healthy", synth(modules=10)), ("noisy_step", synth(modules=10, add_step=True)),
                         ("noisy_m1", synth(modules=1))]:
        for k, (sv, si) in enumerate([(0.05, 0.01), (0.3, 0.05), (1.0, 0.15)]):
            add(f"{name}_{k}", [x + rng.gauss(0, sv) for x in v], [x + rng.gauss(0, si) for x in i],
                modules=1 if name.endswith("m1") else 10)

    # partial shading: two and three current plateaus
    v, i = synth(modules=10, n_points=120)
    voc = v[-1]
    add("shade_two_level", v, [x * (0.55 if vv > 0.4 * voc else 1.0) for vv, x in zip(v, i)], modules=10)
    add("shade_three_level", v, [x * (0.4 if vv > 0.65 * voc else 0.7 if vv > 0.35 * voc else 1.0) for vv, x in zip(v, i)],
        modules=10)
    add("shade_shallow", v, [x * (0.93 if vv > 0.5 * voc else 1.0) for vv, x in zip(v, i)], modules=10)

    # edge cases
    add("zero_current", [0, 50, 100, 150, 200, 250, 300], [0, 0, 0, 0, 0, 0, 0])
    add("open_circuit_tiny_current", [400, 420, 440, 460, 480, 500], [0.001, 0.0009, 0.0007, 0.0005, 0.0002, 0.0])
    add("open_circuit_points", [510, 511, 511.5, 512], [0.0, 0.0, 0.0, 0.0])
    add("three_points", [0, 10, 20], [5, 4, 0])
    add("four_points", [0, 10, 20, 30], [5, 4.9, 4, 0])
    add("five_points", [0, 100, 200, 300, 380], [10, 9.9, 9.6, 8, 0])
    add("seven_points", [0, 60, 120, 180, 240, 300, 340], [10, 9.95, 9.9, 9.7, 9, 6, 0])
    add("eight_points", [0, 60, 120, 180, 240, 300, 340, 360], [10, 9.95, 9.9, 9.7, 9, 6, 2, 0])
    add("no_isc_point", [100, 150, 200, 250, 300, 350, 400, 450], [9.9, 9.85, 9.8, 9.7, 9.4, 8.6, 6.5, 2.1])
    add("no_voc_point", [0, 50, 100, 150, 200, 250, 300, 350, 400], [10, 9.98, 9.95, 9.9, 9.8, 9.6, 9.1, 8.0, 5.5])
    add("constant_tail_current", [0, 10, 20, 30, 40, 50], [5, 5, 5, 5, 5, 5])
    add("short_circuit_only", [0, 0.1, 0.2, 0.3, 0.4], [9.0, 9.0, 8.99, 8.99, 8.98])
    v, i = synth(modules=10)
    order = list(range(len(v)))
    rng.shuffle(order)
    add("unsorted", [v[k] for k in order], [i[k] for k in order], modules=10)
    vd = v + v[10:20] + v[50:55]
    idup = i + [x * 1.01 for x in i[10:20]] + [x * 0.98 for x in i[50:55]]
    add("duplicates", vd, idup, modules=10)
    vn = list(v)
    in_ = list(i)
    vn[3], in_[7], vn[11] = float("nan"), float("nan"), float("inf")
    in_[20] = -0.5
    vn[30] = -2.0
    add("nan_and_negative", vn, in_, modules=10)
    step = v[-1] - v[-2]
    add("past_voc", v + [round(v[-1] + k * step, 2) for k in range(1, 6)], i + [0.0] * 5, modules=10)
    add("past_voc_negative_current", v + [round(v[-1] + k * step, 2) for k in range(1, 4)], i + [-0.05, -0.1, -0.2], modules=10)
    add("rounded_voltage_dups", [0.00001 * k for k in range(10)] + [1, 2, 3, 4, 5], [5.0] * 10 + [4.9, 4.7, 4.0, 2.0, 0.0])
    # random realistic curves
    for k in range(12):
        m = rng.choice([1, 8, 10, 14, 18])
        v, i = synth(modules=m, isc_scale=rng.uniform(0.6, 1.05), voc_offset_v=rng.uniform(-0.1, 0.02) * SPEC.voc_stc * m,
                     rs_mult=rng.uniform(0.5, 5.0), rsh_ohm=rng.choice([None, None, rng.uniform(30, 800)]),
                     add_step=rng.random() < 0.3, n_points=rng.choice([20, 40, 80, 120]))
        add(f"random_{k}", v, i, modules=m)
    return curves


# ------------------------------------------------------------------- iv_analysis

def gen_iv_analysis():
    rng = random.Random(60891)
    curves = build_curves(rng)

    # NumPy helpers (the Rust port re-implements them)
    npx = {"polyfit": [], "lstsq": [], "interp": [], "gradient": [], "linspace": []}
    for _ in range(150):
        n = rng.randint(1, 12)
        deg = rng.choice([1, 1, 2])
        x = [rng.uniform(-5, 600) for _ in range(n)]
        if rng.random() < 0.15:
            x = [x[0]] * n
        y = [rng.uniform(-20, 20) for _ in range(n)]
        npx["polyfit"].append({"x": x, "y": y, "deg": deg, **run(np.polyfit, x, y, deg)})
    for _ in range(100):
        m, n = rng.randint(0, 10), rng.choice([2, 3])
        cols = [[rng.uniform(-3, 3) for _ in range(m)] for _ in range(n)]
        if rng.random() < 0.2 and m:
            cols[1] = [2 * c for c in cols[0]]
        b = [rng.uniform(-3, 3) for _ in range(m)]
        A = np.array(cols).T.reshape(m, n)
        out = run(lambda: np.linalg.lstsq(A, np.array(b), rcond=None)[0])
        npx["lstsq"].append({"cols": cols, "b": b, **out})
    for _ in range(150):
        n = rng.randint(1, 30)
        xp = sorted(rng.uniform(0, 10) for _ in range(n))
        if rng.random() < 0.5:
            for _ in range(rng.randint(1, 4)):
                a, c = rng.randrange(n), rng.randrange(n)
                xp[a], xp[c] = xp[c], xp[a]
        fp = [rng.uniform(-5, 5) for _ in range(n)]
        x = [rng.uniform(-1, 11) for _ in range(rng.randint(1, 40))]
        npx["interp"].append({"x": x, "xp": xp, "fp": fp, "result": clean(np.interp(x, xp, fp))})
    for _ in range(60):
        n = rng.randint(2, 30)
        x = np.linspace(rng.uniform(0, 5), rng.uniform(6, 600), n) if rng.random() < 0.6 else np.cumsum(
            [rng.uniform(0.1, 2) for _ in range(n)])
        fvals = [rng.uniform(-5, 5) for _ in range(n)]
        npx["gradient"].append({"f": fvals, "x": clean(x), "result": clean(np.gradient(fvals, x))})
    for _ in range(60):
        a, b, n = rng.uniform(-10, 600), rng.uniform(-10, 600), rng.randint(1, 100)
        npx["linspace"].append({"start": a, "stop": b, "num": n, "result": clean(np.linspace(a, b, n))})

    validate = []
    base = {"irradiance_wm2": 900.0, "module_temp_c": 50.0, "swept_at": "2026-11-10 12:00:00"}
    variants = [
        {}, {"swept_at": None}, {"swept_at": "   "}, {"irradiance_wm2": None}, {"irradiance_wm2": 0.0},
        {"irradiance_wm2": -5.0}, {"irradiance_wm2": float("nan")}, {"irradiance_wm2": float("inf")},
        {"module_temp_c": None}, {"module_temp_c": -40.0}, {"module_temp_c": 120.0}, {"module_temp_c": 120.5},
        {"module_temp_c": -41.0}, {"module_temp_c": float("nan")},
        {"irradiance_wm2": 820.0, "module_temp_c": 44.0, "irradiance_change_pct": 0.6},
        {"irradiance_wm2": 750.0, "irradiance_change_pct": 1.4},
        {"irradiance_wm2": 620.0, "irradiance_change_pct": 2.8},
        {"irradiance_wm2": 520.0, "irradiance_change_pct": 0.5}, {"irradiance_wm2": 350.0},
        {"irradiance_wm2": 399.5}, {"irradiance_wm2": 400.0}, {"irradiance_wm2": 699.5}, {"irradiance_wm2": 700.0},
        {"irradiance_wm2": 799.5}, {"irradiance_wm2": 800.0}, {"irradiance_change_pct": -2.0},
        {"irradiance_change_pct": -2.005}, {"irradiance_change_pct": 1.0}, {"irradiance_change_pct": 1.005},
        {"temp_change_k_per_min": 0.5, "sweep_time_ms": 200.0}, {"temp_change_k_per_min": 1.8},
        {"temp_change_k_per_min": -1.25}, {"sweep_time_ms": 20.0, "cell_technology": "TOPCon"},
        {"sweep_time_ms": 20.0}, {"sweep_time_ms": 20.0, "cell_technology": "perc"},
        {"sweep_time_ms": 99.5, "cell_technology": " HJT "}, {"sweep_time_ms": 50.0, "cell_technology": "  "},
        {"sweep_time_ms": 50.0, "cell_technology": "ibc"}, {"sweep_time_ms": 100.0, "cell_technology": "ibc"},
        {"sensor_misalignment_deg": 0.5}, {"sensor_misalignment_deg": 1.5}, {"sensor_misalignment_deg": -3.0},
        {"sensor_misalignment_deg": 2.0},
        {"min_irradiance_wm2": 300.0, "irradiance_wm2": 350.0}, {"min_irradiance_wm2": 500.0, "irradiance_wm2": 450.0},
        {"max_irradiance_change_pct": 3.0, "irradiance_change_pct": 2.5},
        {"irradiance_wm2": 380.0, "irradiance_change_pct": 3.1, "temp_change_k_per_min": 2.0, "sweep_time_ms": 10.0,
         "cell_technology": "topcon", "sensor_misalignment_deg": 4.25},
        {"irradiance_wm2": 2.5, "irradiance_change_pct": 0.125}, {"irradiance_wm2": 712.5, "irradiance_change_pct": 1.125},
    ]
    for v in variants:
        kw = {**base, **v}
        validate.append({"kwargs": clean(kw), **run(iva.validate_sweep_conditions, **kw)})

    csvs = [
        "V,I\n0,10\n100,9.9\n200,9.7\n300,9\n400,6\n450,0\n",
        "Voltage (V),Current (A)\n0,10\n100,9.9\n200,9.7\n300,9\n400,6\n",
        "# Seaward export\n# string 3\nIndex,Voltage [V],Current [A],Power\n1,0,10,0\n2,100,9.9,990\n3,200,9.7,1940\n4,300,9,2700\n5,400,6,2400\n",
        "Current (A),Voltage (V)\n10,0\n9.9,100\n9.7,200\n9,300\n6,400\n",
        "u(v);i(a)\n0;10\n",
        "V,I\n0,10\n100,9.9\n",
        "\n\n  V,I  \n 0 , 10 \n\n100,9.9\n200,9.7\n,,\n300,abc\n300,9\nnan,5\n400,inf\n400,6\n450,0\n",
        '"V","I"\n"0","10"\n"100","9.9"\n"200","9.7"\n"300","9"\n"400","6"\n',
        "V,I\r\n0,10\r\n100,9.9\r\n200,9.7\r\n300,9\r\n400,6\r\n",
        "V,I\r0,10\r100,9.9\r200,9.7\r300,9\r400,6\r",
        "0,10\n100,9.9\n200,9.7\n300,9\n400,6\n",
        "1_0,10\n100,9.9\n200,9.7\n300,9\n400,6\n1__0,5\n_1,5\n",
        "V,I\n0,1e1\n1E2,9.9\n2.0e+2,9.7\n.3e3,9\n400.,6\n+450,-0\n",
        "volt,amp,temp\n0,10,40\n100,9.9,40\n200,9.7,41\n300\n300,9,41\n400,6,41\n",
        "x,y\n0,10\n100,9.9\n200,9.7\n300,9\n400,6\n",
        "",
        "V,I\n0,10\n100,9.9\n200,9.7\n300,\"9\"\"\"\n400,6\n500,1\n600,0\n",
    ]
    parse = [{"content": c, **run(iva.parse_iv_csv, c)} for c in csvs]

    per_curve = {"rectify": [], "rectify_raw": [], "extract": [], "sandia": []}
    for k, c in enumerate(curves):
        per_curve["rectify"].append({"curve": k, **run(iva.rectify_iv_curve, c["v"], c["i"])})
        per_curve["rectify_raw"].append({"curve": k, **run(iva.rectify_iv_curve, c["v"], c["i"], decimals=None)})
        per_curve["extract"].append({"curve": k, **run(iva.extract_iv_parameters, c["v"], c["i"])})
        per_curve["sandia"].append({"curve": k, "v_oc": None, "i_sc": None, **run(iva.fit_sandia_simple, c["v"], c["i"])})
        ex = per_curve["extract"][-1].get("result")
        if ex:
            per_curve["sandia"].append({"curve": k, "v_oc": ex["v_oc_v"], "i_sc": ex["i_sc_a"],
                                        **run(iva.fit_sandia_simple, c["v"], c["i"], v_oc=ex["v_oc_v"], i_sc=ex["i_sc_a"])})

    lam = [0.0, -1.0, 1e-300, 1e-12, 1e-6, 0.1, 1.0, 2.0, math.e, math.e + 1e-9, 10.0, 1e3, 1e8, 1e20, 1e26,
           float("nan"), float("inf")] + [10 ** rng.uniform(-15, 27) for _ in range(60)]
    lambert = [{"x": clean(x), "result": clean(float(iva.lambertw_pv(x)))} for x in lam]

    desoto = []
    for spec_name, spec in SPECS.items():
        for m in (1, 2, 10, 18, 30):
            args = dict(v_mp=m * spec.vmp_stc, i_mp=spec.imp_stc, v_oc=m * spec.voc_stc, i_sc=spec.isc_stc,
                        alpha_sc_a_per_k=spec.alpha_a_per_k(), beta_oc_v_per_k=spec.beta_v_per_k(m),
                        n_cells_series=m * spec.cells_per_module)
            desoto.append({"args": clean(args), **run(iva.fit_desoto, **args)})
    for _ in range(30):
        m = rng.randint(1, 20)
        args = dict(v_mp=m * rng.uniform(30, 45), i_mp=rng.uniform(0.01, 18), v_oc=m * rng.uniform(40, 55),
                    i_sc=rng.uniform(0.01, 19), alpha_sc_a_per_k=rng.uniform(0, 0.01), beta_oc_v_per_k=-rng.uniform(0, 3),
                    n_cells_series=m * rng.choice([60, 72, 66]))
        desoto.append({"args": clean(args), **run(iva.fit_desoto, **args)})

    simulate = []
    for d in desoto[:20]:
        r = d["result"]
        for n_points in (2, 60, 80):
            args = dict(i_l=r["i_l_ref_a"], i_o=r["i_o_ref_a"], r_s=r["r_s_ohm"], r_sh=r["r_sh_ref_ohm"],
                        n_ns_vth=r["a_ref_v"], v_oc=d["args"]["v_oc"], n_points=n_points)
            simulate.append({"args": clean(args), **run(iva.simulate_single_diode_curve, **args)})
    for args in [dict(i_l=10, i_o=1e-10, r_s=0.0, r_sh=300, n_ns_vth=1.9, v_oc=50, n_points=30),
                 dict(i_l=10, i_o=1e-10, r_s=1e-7, r_sh=0.0, n_ns_vth=1.9, v_oc=0.05, n_points=10),
                 dict(i_l=10, i_o=1e-9, r_s=0.5, r_sh=1e-6, n_ns_vth=1.9, v_oc=-1.0, n_points=5),
                 dict(i_l=0.0, i_o=1e-12, r_s=0.3, r_sh=500, n_ns_vth=19.0, v_oc=500, n_points=40)]:
        simulate.append({"args": clean(args), **run(iva.simulate_single_diode_curve, **args)})

    translate = []
    tr_opts = [
        {}, {"procedure": 2}, {"procedure": 4}, {"procedure": "dynamic"},
        {"r_s_ohm": 2.2, "kappa_ohm_per_k": 0.012}, {"r_s_ohm": 2.2, "procedure": 2},
        {"r_s_ohm": 2.2, "procedure": 4, "epsilon_v": 1.1}, {"r_s_ohm": 2.2, "procedure": "dynamic", "r_sh_ohm": 150.0},
        {"r_s_ohm": 2.2, "procedure": "dynamic", "r_sh_ohm": 5000.0},
        {"procedure": 2, "b1": 0.07}, {"procedure": 2, "b1": 0.07, "b2": 0.01}, {"procedure": 2, "b2": 0.01},
        {"target_temp_c": 55.0}, {"target_irradiance_wm2": 800.0, "target_temp_c": 45.0, "procedure": 2},
    ]
    conds = [(1000.0, 25.0), (900.0, 45.0), (850.0, 58.0), (450.0, 38.0), (1100.0, 15.0), (0.0, 25.0), (-5.0, 25.0)]
    for k, c in enumerate(curves):
        for j in range(4 if k % 3 else 8):
            g, t = conds[(k + j) % len(conds)] if j < 7 else (rng.uniform(300, 1100), rng.uniform(10, 75))
            opts = dict(tr_opts[(k * 5 + j) % len(tr_opts)])
            spec_name = list(SPECS)[(k + j) % len(SPECS)]
            translate.append({"curve": k, "g": g, "t": t, "spec": spec_name,
                              "opts": clean({"modules": c["modules"], **opts}),
                              **run(iva.translate_to_stc_iec60891, c["v"], c["i"], g, t, SPECS[spec_name],
                                    modules=c["modules"], **opts)})

    expected = []
    for spec_name, spec in SPECS.items():
        for m in (-1, 0, 1, 10, 18):
            for age in (-1.0, 0.0, 0.004, 1.0, 5.5, 30.0, 200.0):
                expected.append({"spec": spec_name, "modules": m, "age": age, **run(iva.expected_stc_power_w, spec, m, age)})

    classify = []
    for _ in range(400):
        m = rng.choice([1, 10, 18])
        spec_name = rng.choice(list(SPECS))
        spec = SPECS[spec_name]
        params = {
            "p_max_w": round(m * spec.wp * rng.uniform(0.6, 1.08), 2),
            "v_oc_v": round(m * spec.voc_stc * rng.choice([1.0, rng.uniform(0.75, 1.03)]) - rng.choice(
                [0, 0, spec.voc_stc / 3, 2 * spec.voc_stc / 3, spec.voc_stc, 2 * spec.voc_stc]), 2),
            "i_sc_a": round(spec.isc_stc * rng.uniform(0.75, 1.06), 3),
            "i_mp_a": round(spec.imp_stc * rng.uniform(0.75, 1.06), 3),
            "v_mp_v": round(m * spec.vmp_stc * rng.uniform(0.8, 1.03), 2),
            "fill_factor": round(rng.uniform(0.6, 0.82), 4),
            "slope_voc_ohm": round(m * rng.uniform(0.1, 2.0), 4),
            "slope_isc_ohm": round(m * rng.uniform(5, 400), 1),
            "steps_count": rng.choice([0, 0, 0, 0, 1, 2]),
        }
        kw = {
            "modules": m, "system_age_years": rng.choice([0.0, 1.0, 3.5, 12.0]),
            "dead_band_pct": rng.choice([2.0, 3.5, 5.0, 5.0, 8.0]),
            "near_negative_pole": rng.random() < 0.2, "low_irradiance_worse": rng.random() < 0.2,
            "quality_gate_passed": rng.random() < 0.8, "ir_confirmed": rng.random() < 0.3,
            "timeseries_trend_confirmed": rng.random() < 0.3,
            "steps_measured": rng.choice([None, None, 0, 1]), "shape_gate_passed": rng.choice([None, True, False]),
            "absolute_comparison_ok": rng.random() < 0.8,
        }
        classify.append({"params": params, "spec": spec_name, "kwargs": kw, **run(iva.classify_iv_fault, params, spec, **kw)})

    uncertainty = []
    for _ in range(80):
        kw = {
            "irradiance_uncertainty_pct": rng.choice([None, 1.0, -1.5, 3.25]),
            "irradiance_change_pct": rng.choice([None, 0.4, -1.8, 2.0]),
            "temp_change_k_per_min": rng.choice([None, 0.5, 2.0, -3.0]),
            "procedure_spread_pct": rng.choice([None, 0.5, 1.0, 2.4, -3.1]),
            "target_temp_c": rng.choice([25.0, 55.0]),
        }
        t = rng.choice([25.0, 32.0, 55.0, 70.0, -10.0])
        spec_name = rng.choice(list(SPECS))
        uncertainty.append({"module_temp_c": t, "spec": spec_name, "kwargs": kw,
                            **run(iva.estimate_stc_pmax_uncertainty, t, SPECS[spec_name], **kw)})

    analyze = []
    an_conds = [(1000.0, 25.0), (850.0, 58.0), (750.0, 50.0), (520.0, 25.0), (450.0, 38.0), (300.0, 25.0),
                (1000.0, 32.0), (900.0, 45.0)]
    an_kwargs = [
        {}, {"system_age_years": 1.0}, {"dead_band_pct": 2.0}, {"near_negative_pole": True},
        {"near_negative_pole": True, "ir_confirmed": True}, {"timeseries_trend_confirmed": True, "ir_confirmed": True},
        {"absolute_comparison_ok": False}, {"reverse_pmax_w": 5600.0}, {"irradiance_change_pct": 1.4},
        {"temp_change_k_per_min": 1.8, "sweep_time_ms": 20.0}, {"sweep_time_ms": 20.0, "cell_technology": "topcon"},
        {"sensor_misalignment_deg": 2.5, "irradiance_uncertainty_pct": 1.0}, {"low_irradiance_worse": True},
        {"dead_band_pct": 0.5},
    ]
    for k, c in enumerate(curves):
        for j in range(3):
            g, t = an_conds[(k * 3 + j) % len(an_conds)]
            kw = dict(an_kwargs[(k * 7 + j) % len(an_kwargs)])
            spec_name = list(SPECS)[(k + 2 * j) % len(SPECS)] if j else "default"
            if j == 0:
                g, t = (1000.0, 25.0) if k % 2 == 0 else an_conds[k % len(an_conds)]
            if "reverse_pmax_w" in kw:
                kw["reverse_pmax_w"] = rng.choice([0.0, -5.0, 500.0 * c["modules"], 560.0 * c["modules"]])
            kw["modules"] = c["modules"]
            analyze.append({"curve": k, "g": g, "t": t, "swept_at": "2026-11-10T12:00:00", "spec": spec_name,
                            "kwargs": clean(kw),
                            **run(iva.analyze_iv_sweep, c["v"], c["i"], g, t, "2026-11-10T12:00:00", SPECS[spec_name], **kw)})
    # errors: conditions missing
    for g, t, ts in [(None, 25.0, "x"), (900.0, None, "x"), (900.0, 25.0, None), (900.0, 25.0, " ")]:
        analyze.append({"curve": 0, "g": g, "t": t, "swept_at": ts, "spec": "default", "kwargs": {},
                        **run(iva.analyze_iv_sweep, curves[0]["v"], curves[0]["i"], g, t, ts, SPEC)})

    write("iv_analysis.json", {
        "specs": {k: spec_json(v) for k, v in SPECS.items()},
        "curves": curves, **npx, "validate": validate, "parse_csv": parse, **per_curve, "lambertw": lambert,
        "desoto": desoto, "simulate": simulate, "translate": translate, "expected_power": expected,
        "classify": classify, "uncertainty": uncertainty, "analyze": analyze,
    })


# ------------------------------------------------------------------- iv_site_fit

def gen_iv_site_fit():
    rng = random.Random(250)

    def sw(g, t, **kw):
        v, i = field(g, t, **kw)
        return {"v": v, "i": i, "g": float(g), "t": float(t)}

    def noisy(s, sv=0.2, si=0.02):
        return {**s, "v": [x + rng.gauss(0, sv) for x in s["v"]], "i": [max(0.0, x + rng.gauss(0, si)) for x in s["i"]]}

    wide = [sw(g, t) for g, t in [(450, 38), (600, 45), (780, 52), (900, 58), (980, 63)]]
    sets = {
        "wide": wide,
        "narrow": [sw(900, 40), sw(920, 60), sw(950, 50)],
        "flat": [sw(500, 50), sw(700, 51), sw(950, 52)],
        "two": wide[:2],
        "one": wide[:1],
        "none": [],
        "wide_uncorrelated": [sw(g, t) for g, t in [(450, 60), (980, 38), (600, 52), (780, 63), (900, 45)]],
        "wide_four": [sw(g, t) for g, t in [(400, 35), (650, 60), (800, 42), (1000, 55)]],
        "three_g_and_t": [sw(400, 35), sw(750, 60), sw(1000, 45)],
        "noisy_wide": [noisy(s) for s in wide],
        "same_g": [sw(800, 40), sw(800, 50), sw(800, 60)],
        "other_coeffs": [sw(g, t, b1=0.03, beta_pct=-0.35) for g, t in [(420, 30), (640, 48), (860, 61), (1000, 66)]],
        "with_bad_curve": wide[:3] + [{"v": [0, 1, 2], "i": [1, 1, 0], "g": 700.0, "t": 50.0}],
        "flat_far_edge": [sw(g, t, b1=0.149) for g, t in [(450, 50), (650, 50.5), (980, 51)]],
    }
    fits = []
    for name, sweeps in sets.items():
        for spec_name in ("default", "own_p2") if name in ("wide", "narrow", "flat") else ("default",):
            fits.append({"name": name, "spec": spec_name, "modules": 10, "sweeps": clean(sweeps),
                         **run(ivs.fit_site_coefficients, sweeps, SPECS[spec_name], 10)})

    p3 = []
    lo, hi, mid = sw(600, 45), sw(1000, 45), sw(800, 45)
    hot = sw(900, 62)
    cases = [
        (lo, hi, 800.0), (lo, mid, 1000.0), (lo, hi, 1000.0), (lo, hi, 600.0), (lo, hi, 1200.0), (mid, hot, 1000.0),
        (hot, lo, 1000.0), (lo, lo, 1000.0), (noisy(lo), noisy(hi), 1000.0), (lo, {**hi, "g": 600.5}, 1000.0),
        ({"v": [0, 1, 2, 3, 4], "i": [1, 0.9, 0.8, 0.5, 0], "g": 500.0, "t": 30.0},
         {"v": [0, 1, 2, 3, 4], "i": [9, 8.9, 8.8, 8.5, 0], "g": 1000.0, "t": 40.0}, 1000.0),
    ]
    for a, b, target in cases:
        p3.append({"a": clean(a), "b": clean(b), "target": target,
                   **run(ivs.interpolate_procedure_3, a["v"], a["i"], a["g"], a["t"], b["v"], b["i"], b["g"], b["t"],
                         target_irradiance_wm2=target)})
    write("iv_site_fit.json", {"specs": {k: spec_json(v) for k, v in SPECS.items()}, "fit": fits, "procedure_3": p3})


# ------------------------------------------------------------------- iv_operating

def gen_iv_operating():
    rng = random.Random(144)
    criteria = json.loads((Path(__file__).resolve().parents[5] / "backend/app/services/string_live_criteria.json")
                          .read_text(encoding="utf-8"))["gates"]
    curves = []
    for spec_name in SPECS:
        for m in (-1, 0, 1, 10, 18, 24):
            for g, t in [(1000, 25), (800, 58), (800, 55), (200, 30), (1200, 10), (0, 25), (-10, 25), (None, 25),
                         (800, None), (50, 70), (1, 25)]:
                n_points = rng.choice([80, 80, 2, 10])
                curves.append({"spec": spec_name, "modules": m, "g": g, "t": t, "n_points": n_points,
                               **run(ivo.string_curve_at, SPECS[spec_name], m, g, t, n_points)})
    judge = []
    usable = [c["result"] for c in curves if c.get("result")]
    for _ in range(400):
        curve = rng.choice(usable + [None])
        if curve is not None and rng.random() < 0.05:
            curve = {**curve, rng.choice(["v_mp_v", "i_mp_a"]): 0.0}
        vmp = curve["v_mp_v"] if curve else 700.0
        imp = curve["i_mp_a"] if curve else 9.0
        v = rng.choice([None, vmp, vmp * rng.uniform(0.5, 1.2), -1.0, 1e4])
        i = rng.choice([None, imp, imp * rng.uniform(0.0, 1.4), -0.1, 40.0])
        kw = {
            "inverter_status": rng.choice([None, 1, 0, 3]), "limited": rng.random() < 0.15,
            "record_age_s": rng.choice([None, 60.0, 600.0, 601.0, 3600.0]),
            "weather_gap_s": rng.choice([None, 60.0, 300.0, 900.0]),
        }
        irr = rng.choice([None, 800.0, 300.0, 400.0, 399.9])
        judge.append({"v": v, "i": i, "curve": curve, "irradiance": irr, "kwargs": kw,
                      **run(ivo.judge_point, v, i, curve, irr, criteria, **kw)})
    write("iv_operating.json", {"specs": {k: spec_json(v) for k, v in SPECS.items()}, "criteria": criteria,
                                "string_curve_at": curves, "judge_point": judge})


if __name__ == "__main__":
    gen_iv_analysis()
    gen_iv_site_fit()
    gen_iv_operating()
