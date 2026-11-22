"""Live operating points of strings against the modelled string curve at the measured conditions.

Growatt reports one operating point per string (V, I) per record, not a curve. This module draws
the curve the string *should* be on at the plane-of-array irradiance G and module temperature
T_mod a weather sensor measured (single-diode model, De Soto 2006 translation of the datasheet fit)
and judges each live point against it. Everything here is **modelled**; the points are measured.

Pure functions: no FastAPI, no SQLAlchemy. Thresholds come in as a dict (the criteria file).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional

import numpy as np

from solar_core.iv_analysis import G_STC, T_STC, ModuleStcSpec, fit_desoto, lambertw_pv

# band gap of silicon at STC (eV) and its temperature slope (De Soto 2006), Boltzmann in eV/K
EG_REF_EV = 1.121
DEG_DT = -0.0002677
K_EV = 8.617333262e-5


def _current(v: np.ndarray, i_l: float, i_o: float, r_s: float, r_sh: float, a: float) -> np.ndarray:
    """Exact single-diode I(V) (Lambert W), clipped at 0 A."""
    g_sh = 1.0 / max(1e-3, r_sh)
    denom = 1.0 + r_s * g_sh
    arg_exp = (r_s * (i_l + i_o) + v) / (a * denom)
    w = lambertw_pv((i_o * r_s / (a * denom)) * np.exp(np.minimum(60.0, arg_exp)))
    return np.maximum(0.0, (i_l + i_o - v * g_sh) / denom - (a / r_s) * w)


def string_curve_at(
    spec: ModuleStcSpec,
    modules: int,
    irradiance_wm2: float,
    module_temp_c: float,
    n_points: int = 80,
) -> Optional[Dict[str, Any]]:
    """Modelled I-V / P-V curve of `modules` in series at (G, T_mod), plus its key points.

    The datasheet's STC keypoints are fitted once (De Soto), then translated to the conditions:
    a ∝ T, I_L = G/G_ref·(I_L,ref + α·ΔT), I_o from the band gap, R_sh ∝ 1/G, R_s constant.
    None when G ≤ 0 or the module count is not positive.
    """
    if modules < 1 or irradiance_wm2 is None or irradiance_wm2 <= 0 or module_temp_c is None:
        return None
    n = int(modules)
    ref = fit_desoto(
        v_mp=n * spec.vmp_stc,
        i_mp=spec.imp_stc,
        v_oc=n * spec.voc_stc,
        i_sc=spec.isc_stc,
        alpha_sc_a_per_k=spec.alpha_a_per_k(),
        beta_oc_v_per_k=spec.beta_v_per_k(n),
        n_cells_series=n * spec.cells_per_module,
    )
    g, t = float(irradiance_wm2), float(module_temp_c)
    tk, tk_ref = t + 273.15, T_STC + 273.15
    eg = EG_REF_EV * (1.0 + DEG_DT * (t - T_STC))
    a = ref["a_ref_v"] * tk / tk_ref
    i_l = g / G_STC * (ref["i_l_ref_a"] + ref["alpha_sc_a_per_k"] * (t - T_STC))
    i_o = ref["i_o_ref_a"] * (tk / tk_ref) ** 3 * math.exp(EG_REF_EV / (K_EV * tk_ref) - eg / (K_EV * tk))
    r_s = ref["r_s_ohm"]
    r_sh = ref["r_sh_ref_ohm"] * G_STC / g
    if i_l <= 0:
        return None
    # Voc: bisection on I(V) = 0 between 0 and a generous upper bound
    lo, hi = 0.0, n * spec.voc_stc * 1.3
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _current(np.array([mid]), i_l, i_o, r_s, r_sh, a)[0] > 0:
            lo = mid
        else:
            hi = mid
    v_oc = lo
    v = np.linspace(0.0, v_oc, n_points)
    i = _current(v, i_l, i_o, r_s, r_sh, a)
    # MPP on a fine grid (the drawn grid is coarse)
    vf = np.linspace(0.0, v_oc, 2000)
    pf = vf * _current(vf, i_l, i_o, r_s, r_sh, a)
    k = int(np.argmax(pf))
    return {
        "modules": n,
        "points": [{"v": round(float(vv), 1), "i": round(float(ii), 3), "p": round(float(vv * ii), 1)} for vv, ii in zip(v, i)],
        "v_oc_v": round(v_oc, 1),
        "i_sc_a": round(float(_current(np.array([0.0]), i_l, i_o, r_s, r_sh, a)[0]), 3),
        "v_mp_v": round(float(vf[k]), 1),
        "i_mp_a": round(float(pf[k] / vf[k]) if vf[k] > 0 else 0.0, 3),
        "p_mp_w": round(float(pf[k]), 1),
    }


def judge_point(
    voltage_v: Optional[float],
    current_a: Optional[float],
    curve: Optional[Mapping[str, Any]],
    irradiance_wm2: Optional[float],
    criteria: Mapping[str, Any],
    *,
    inverter_status: Optional[int] = None,
    limited: bool = False,
    record_age_s: Optional[float] = None,
    weather_gap_s: Optional[float] = None,
) -> Dict[str, Any]:
    """Ratios of one live point to the modelled curve and the gates it fails.

    `r_imp` = I ÷ Imp_model, `r_v` = V ÷ Vmp_model (the MPPT's voltage: shared by its strings).
    The point is `diagnostic` only when no gate fails. Each failed gate is a code the UI explains;
    the ratios are still given (the point is drawn hollow), except where the model is missing.
    """
    gates: List[str] = []
    g = criteria
    if voltage_v is None or current_a is None:
        return {"r_imp": None, "r_v": None, "gates": ["no_reading"], "diagnostic": False}
    if record_age_s is not None and record_age_s > g["stale_s"]:
        gates.append("stale")
    if inverter_status is not None and inverter_status != 1:
        gates.append("not_producing")
    if limited:
        gates.append("clipped_or_limited")
    if curve is None:
        gates.append("no_model")
        return {"r_imp": None, "r_v": None, "gates": gates, "diagnostic": False}
    if weather_gap_s is not None and weather_gap_s > g["weather_max_gap_s"]:
        gates.append("weather_not_aligned")
    if irradiance_wm2 is not None and irradiance_wm2 < g["irradiance_min_wm2"]:
        gates.append("low_irradiance")
    v, i = float(voltage_v), float(current_a)
    if i > g["sanity_current_max"] * curve["i_sc_a"] or v > g["sanity_voltage_max"] * curve["v_oc_v"] or v < 0 or i < 0:
        gates.append("out_of_range")
    r_v = v / curve["v_mp_v"] if curve["v_mp_v"] else None
    # zero export / curtailment: the MPPT walks towards Voc, which looks like a low-current fault
    if r_v is not None and r_v > g["off_mpp_voltage_ratio"]:
        gates.append("off_mpp")
    r_imp = i / curve["i_mp_a"] if curve["i_mp_a"] else None
    return {
        "r_imp": round(r_imp, 3) if r_imp is not None else None,
        "r_v": round(r_v, 3) if r_v is not None else None,
        "gates": gates,
        "diagnostic": not gates,
    }
