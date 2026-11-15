"""Site coefficients from several I-V sweeps of one healthy string, and IEC 60891 Procedure 3.

Pure NumPy, no I/O. Everything here is an estimate from the sweeps it is given: a value that the
sweeps cannot determine (too few, too close in irradiance or temperature, best fit on the edge of
the search range) is `None` with a reason, never a default.

- `fit_site_coefficients`: Voc at STC, β_rel and the Procedure 2 irradiance factor B₁ from the
  open-circuit voltages; then Rs and κ as the values that bring the sweeps' translated Pmax closest
  together (the idea of the IEC 60891 determination procedure, run as a search).
- `interpolate_procedure_3`: Procedure 3, linear interpolation between two measured curves; needs
  no coefficients. Formulas from the literature, not checked against the standard's text.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from solar_core.iv_analysis import (
    G_STC,
    T_STC,
    ModuleStcSpec,
    extract_iv_parameters,
    rectify_iv_curve,
    translate_to_stc_iec60891,
)

MIN_FIT_SWEEPS = 3
# IEA PVPS T13-24: curves for the Rs determination at least 300 W/m² apart.
MIN_IRRADIANCE_SPAN_WM2 = 300.0
# Our own choice (no published figure): below this spread a temperature slope is mostly noise.
MIN_TEMP_SPAN_K = 10.0

_B1_GRID = np.arange(0.0, 0.1501, 0.0005)
_RS_GRID_PER_MODULE = np.arange(0.0, 1.0001, 0.01)  # Ω
_KAPPA_GRID_PER_MODULE = np.arange(0.0, 0.00501, 0.0001)  # Ω/K


def interpolate_procedure_3(
    v1: Sequence[float],
    i1: Sequence[float],
    g1: float,
    t1: float,
    v2: Sequence[float],
    i2: Sequence[float],
    g2: float,
    t2: float,
    target_irradiance_wm2: float = G_STC,
) -> Dict[str, Any]:
    """IEC 60891 Procedure 3 between two measured curves of the same device.

    Each point (V₁, I₁) is paired with the point of curve 2 at I₂ = I₁ + (Isc₂ − Isc₁), then

        V₃ = V₁ + a·(V₂ − V₁)    I₃ = I₁ + a·(I₂ − I₁)
        G₃ = G₁ + a·(G₂ − G₁)    T₃ = T₁ + a·(T₂ − T₁)

    Two curves leave one free choice: `a` is set so that G₃ is the target irradiance, and T₃
    follows (it is returned, not chosen). `extrapolated` = the target lies outside the two curves.
    """
    if abs(g2 - g1) < 1.0:
        raise ValueError("Procedure 3 needs two curves at different irradiance")
    va, ia = rectify_iv_curve(v1, i1)
    vb, ib = rectify_iv_curve(v2, i2)
    a = (float(target_irradiance_wm2) - g1) / (g2 - g1)
    shift = float(ib[0]) - float(ia[0])
    # V of curve 2 at the paired current; current falls with voltage, so interpolate on reversed arrays
    want = ia + shift
    ok = (want >= 0.0) & (want <= float(ib[0]))
    if np.count_nonzero(ok) < 5:
        raise ValueError("The two curves overlap too little to interpolate")
    v_pair = np.interp(want[ok], ib[::-1], vb[::-1])
    v3 = va[ok] + a * (v_pair - va[ok])
    i3 = ia[ok] + a * (want[ok] - ia[ok])
    v3c, i3c = rectify_iv_curve(v3, i3)
    return {
        "v": v3c,
        "i": i3c,
        "a": round(a, 4),
        "g_wm2": float(target_irradiance_wm2),
        "t_c": round(t1 + a * (t2 - t1), 1),
        "extrapolated": bool(a < 0.0 or a > 1.0),
        "parameters": extract_iv_parameters(v3c, i3c),
    }


def _spread_pct(values: Sequence[float]) -> float:
    arr = np.asarray(values, dtype=float)
    mean = float(arr.mean())
    return float(arr.std() / mean * 100.0) if mean > 0 else float("inf")


def fit_site_coefficients(
    sweeps: Sequence[Dict[str, Any]],
    spec: ModuleStcSpec,
    modules: int,
) -> Dict[str, Any]:
    """Fit coefficients from `sweeps` = [{v, i, g, t}, …] of one string (all the same module count).

    Returns `{sweeps, irradiance_span_wm2, temp_span_k, voc, resistance, procedure_3, reasons}`;
    each fitted value is `None` when the sweeps cannot determine it (see `reasons`).
    α (Isc temperature coefficient) is not fitted: its effect over a field temperature range is
    smaller than the irradiance sensor's error.
    """
    n_mod = max(1, int(modules))
    out: Dict[str, Any] = {
        "sweeps": len(sweeps),
        "irradiance_span_wm2": None,
        "temp_span_k": None,
        "voc": None,
        "resistance": None,
        "procedure_3": None,
        "reasons": [],
        "limits": {
            "min_sweeps": MIN_FIT_SWEEPS,
            "min_irradiance_span_wm2": MIN_IRRADIANCE_SPAN_WM2,
            "min_temp_span_k": MIN_TEMP_SPAN_K,
        },
    }
    reasons: List[str] = out["reasons"]
    if len(sweeps) < 2:
        reasons.append("Needs at least 2 valid sweeps of this string (3 for the coefficient fit)")
        return out

    g = np.array([float(s["g"]) for s in sweeps])
    t = np.array([float(s["t"]) for s in sweeps])
    params = [extract_iv_parameters(s["v"], s["i"]) for s in sweeps]
    voc = np.array([float(p["v_oc_v"]) for p in params])
    g_span, t_span = float(g.max() - g.min()), float(t.max() - t.min())
    out["irradiance_span_wm2"] = round(g_span, 0)
    out["temp_span_k"] = round(t_span, 1)
    g_ok, t_ok = g_span >= MIN_IRRADIANCE_SPAN_WM2, t_span >= MIN_TEMP_SPAN_K

    # Procedure 3 between the lowest- and highest-irradiance sweeps: no coefficients needed.
    lo, hi = int(np.argmin(g)), int(np.argmax(g))
    if g[hi] - g[lo] >= 1.0:
        try:
            p3 = interpolate_procedure_3(
                sweeps[lo]["v"], sweeps[lo]["i"], g[lo], t[lo], sweeps[hi]["v"], sweeps[hi]["i"], g[hi], t[hi]
            )
            out["procedure_3"] = {
                "g_wm2": p3["g_wm2"],
                "t_c": p3["t_c"],
                "extrapolated": p3["extrapolated"],
                "p_max_w": p3["parameters"]["p_max_w"],
                "from_irradiance_wm2": [round(float(g[lo]), 0), round(float(g[hi]), 0)],
            }
        except ValueError as exc:
            reasons.append(f"Procedure 3: {exc}")

    if len(sweeps) < MIN_FIT_SWEEPS:
        reasons.append(f"The coefficient fit needs at least {MIN_FIT_SWEEPS} sweeps")
        return out
    if not g_ok:
        reasons.append(
            f"Irradiance spans only {g_span:.0f} W/m² (needs {MIN_IRRADIANCE_SPAN_WM2:.0f}): B1 and Rs are not determined"
        )
    if not t_ok:
        reasons.append(f"Module temperature spans only {t_span:.1f} K (needs {MIN_TEMP_SPAN_K:.0f}): β and κ are not determined")

    # --- Voc model: Voc = Voc_STC · [1/f(G) + β_rel · f(G) · (T − 25)],  f(G) = 1 + B1·ln(1000/G)
    b1_cur, b2_cur, _ = spec.p2_factors()
    beta_ds = spec.temp_coeff_voc_pct / 100.0
    x = np.log(G_STC / g)
    fit_beta = t_ok and len(sweeps) >= (4 if g_ok else 3)
    voc_fit: Optional[Dict[str, Any]] = None
    if g_ok or t_ok:
        best: Optional[tuple] = None
        for b1 in _B1_GRID if g_ok else np.array([b1_cur]):
            f = b2_cur * x * x + b1 * x + 1.0 if not g_ok else b1 * x + 1.0
            c1, c2 = 1.0 / f, f * (t - T_STC)
            if fit_beta:
                coef, *_ = np.linalg.lstsq(np.column_stack([c1, c2]), voc, rcond=None)
                v_ref, beta = float(coef[0]), float(coef[1] / coef[0]) if coef[0] else float("nan")
            else:
                basis = c1 + beta_ds * c2
                v_ref, beta = float(basis @ voc / (basis @ basis)), beta_ds
            rms = float(np.sqrt(np.mean((v_ref * (c1 + beta * c2) - voc) ** 2)))
            if math.isfinite(rms) and (best is None or rms < best[0]):
                best = (rms, float(b1), v_ref, beta)
        if best is not None:
            rms, b1_fit, v_ref, beta = best
            b1_edge = g_ok and (b1_fit <= _B1_GRID[0] or b1_fit >= _B1_GRID[-1])
            if b1_edge:
                reasons.append("B1: the best fit is on the edge of the search range, so it is not determined")
            voc_fit = {
                "voc_stc_per_module_v": round(v_ref / n_mod, 2),
                "datasheet_voc_stc_v": spec.voc_stc,
                "beta_rel_pct_per_k": round(beta * 100.0, 4) if fit_beta else None,
                "datasheet_beta_rel_pct_per_k": spec.temp_coeff_voc_pct,
                "b1": round(b1_fit, 4) if g_ok and not b1_edge else None,
                "b2": None,  # not fitted: needs a wider irradiance range than field sweeps give
                "fit_rms_pct": round(rms / (v_ref if v_ref else 1.0) * 100.0, 3),
            }
            out["voc"] = voc_fit

    # --- Rs and κ: the values that bring the sweeps' STC Pmax (Procedure 2) closest together
    fitted = spec
    if voc_fit:
        fitted = replace(
            spec,
            temp_coeff_voc_pct=voc_fit["beta_rel_pct_per_k"] if voc_fit["beta_rel_pct_per_k"] is not None else spec.temp_coeff_voc_pct,
            p2_b1=voc_fit["b1"] if voc_fit["b1"] is not None else spec.p2_b1,
        )

    def spread(use: ModuleStcSpec, rs_mod: float, kappa_mod: float) -> float:
        pm = []
        for s in sweeps:
            tr = translate_to_stc_iec60891(
                s["v"], s["i"], float(s["g"]), float(s["t"]), use, n_mod,
                r_s_ohm=rs_mod * n_mod, kappa_ohm_per_k=kappa_mod * n_mod, procedure=2,
            )
            pm.append(float(extract_iv_parameters(tr["v_stc"], tr["i_stc"])["p_max_w"]))
        return _spread_pct(pm)

    if g_ok or t_ok:
        try:
            before = spread(spec, spec.rs_ohm, spec.kappa_ohm_per_k)
            rs_fit: Optional[float] = None
            kappa_fit: Optional[float] = None
            rs_use, kappa_use = spec.rs_ohm, spec.kappa_ohm_per_k
            if g_ok:
                scores = [spread(fitted, float(r), kappa_use) for r in _RS_GRID_PER_MODULE]
                k = int(np.argmin(scores))
                if 0 < k < len(scores) - 1:
                    rs_fit = rs_use = round(float(_RS_GRID_PER_MODULE[k]), 3)
                else:
                    reasons.append("Rs: the best fit is on the edge of the search range, so it is not determined")
            if t_ok:
                scores = [spread(fitted, rs_use, float(kp)) for kp in _KAPPA_GRID_PER_MODULE]
                k = int(np.argmin(scores))
                if 0 < k < len(scores) - 1:
                    kappa_fit = kappa_use = round(float(_KAPPA_GRID_PER_MODULE[k]), 5)
                else:
                    reasons.append("κ: the best fit is on the edge of the search range, so it is not determined")
            if rs_fit is not None and kappa_fit is not None and abs(float(np.corrcoef(g, t)[0, 1])) > 0.9:
                reasons.append(
                    "Irradiance and temperature move together in these sweeps, so Rs and κ cannot be told apart reliably"
                )
            out["resistance"] = {
                "rs_ohm_per_module": rs_fit,
                "kappa_ohm_per_k_per_module": kappa_fit,
                "pmax_spread_before_pct": round(before, 2),
                "pmax_spread_after_pct": round(spread(fitted, rs_use, kappa_use), 2),
            }
        except (ValueError, np.linalg.LinAlgError) as exc:
            reasons.append(f"Rs and κ: translation failed ({exc})")
    return out
