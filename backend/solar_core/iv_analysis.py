"""I-V curve analysis at string and module level (pure NumPy engine, no SciPy/pvlib required).

Implements:
1. Measurement-condition validation (stable, high irradiance G >= 700 W/m², |ΔG| <= 2 %, with G, T
   and timestamp mandatory).
2. Curve cleaning (`rectify_iv_curve`, matching `pvlib.ivtools.utils.rectify_iv_curve`).
3. Translation to STC (1000 W/m², 25 °C) via IEC 60891 Procedure 1:
       I₂ = I₁ + Isc₁·(G₂/G₁ − 1) + α·(T₂ − T₁)
       V₂ = V₁ − Rs·(I₂ − I₁) − κ·I₂·(T₂ − T₁) + β·(T₂ − T₁)
4. Single-diode model fitting (`fit_sandia_simple` 6-region linear regression and `fit_desoto`
   via Newton/Lambert W).
5. Parameter extraction per curve: Isc, Voc, Imp, Vmp, Pmax, FF = Pmax / (Isc·Voc), slope near Voc
   (Rs indicator), slope near Isc (Rsh indicator), and step / inflection count.
6. Fault-signature classification and warranty decision rule with a configurable ±3–5 % dead band
   and two-source warranty verification (I-V + IR or I-V + time-series trend).
"""

from __future__ import annotations

import csv
import io
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

G_STC = 1000.0  # W/m²
T_STC = 25.0  # °C
K_BOLTZMANN = 1.380649e-23
Q_ELECTRON = 1.602176634e-19

MIN_SWEEP_IRRADIANCE_WM2 = 700.0
MAX_SWEEP_IRR_CHANGE_PCT = 2.0
DEFAULT_DEAD_BAND_PCT = 4.0  # within ±3–5 % field I-V uncertainty
DEFAULT_FIRST_YEAR_LID_PCT = 1.0
DEFAULT_ANNUAL_DEGRADATION_PCT = 0.45
DEFAULT_RS_PER_MODULE_OHM = 0.22
DEFAULT_KAPPA_PER_MODULE_OHM_K = 0.0012


@dataclass(frozen=True)
class ModuleStcSpec:
    """Module datasheet parameters at STC (1000 W/m², 25 °C), scaled by `modules` for a string."""

    wp: float = 570.0
    voc_stc: float = 51.10
    isc_stc: float = 14.23
    vmp_stc: float = 42.40
    imp_stc: float = 13.45
    # Temperature coefficients in %/K (as stored on `fleet_module`)
    temp_coeff_pmax_pct: float = -0.30
    temp_coeff_voc_pct: float = -0.25
    temp_coeff_isc_pct: float = 0.046
    # IEC 60891 Procedure 1 internal series resistance & curve correction factor per module
    rs_ohm: float = DEFAULT_RS_PER_MODULE_OHM
    kappa_ohm_per_k: float = DEFAULT_KAPPA_PER_MODULE_OHM_K
    # Warranty parameters
    first_year_lid_pct: float = DEFAULT_FIRST_YEAR_LID_PCT
    annual_degradation_pct: float = DEFAULT_ANNUAL_DEGRADATION_PCT
    cells_per_module: int = 72  # 144 half-cut = 72 cells in series equivalent
    substrings_per_module: int = 3  # 3 bypass diodes per standard module

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ModuleStcSpec":
        def _f(key: str, default: float) -> float:
            v = d.get(key)
            return float(v) if v is not None else default

        return cls(
            wp=_f("wp", 570.0),
            voc_stc=_f("voc_stc", 51.10),
            isc_stc=_f("isc_stc", 14.23),
            vmp_stc=_f("vmp_stc", 42.40),
            imp_stc=_f("imp_stc", 13.45),
            temp_coeff_pmax_pct=_f("temp_coeff_pmax_pct", -0.30),
            temp_coeff_voc_pct=_f("temp_coeff_voc_pct", -0.25),
            temp_coeff_isc_pct=_f("temp_coeff_isc_pct", 0.046),
            rs_ohm=_f("rs_ohm", DEFAULT_RS_PER_MODULE_OHM),
            kappa_ohm_per_k=_f("kappa_ohm_per_k", DEFAULT_KAPPA_PER_MODULE_OHM_K),
            first_year_lid_pct=_f("first_year_lid_pct", DEFAULT_FIRST_YEAR_LID_PCT),
            annual_degradation_pct=_f("annual_degradation_pct", DEFAULT_ANNUAL_DEGRADATION_PCT),
        )

    def alpha_a_per_k(self) -> float:
        """Current temperature coefficient α in A/K (series string current = module current)."""
        return (self.temp_coeff_isc_pct / 100.0) * self.isc_stc

    def beta_v_per_k(self, modules: int = 1) -> float:
        """Voltage temperature coefficient β in V/K for `modules` in series."""
        return float(max(1, modules)) * (self.temp_coeff_voc_pct / 100.0) * self.voc_stc


# ---------------------------------------------------------------------------
# 1. Measurement conditions & CSV parsing
# ---------------------------------------------------------------------------


def validate_sweep_conditions(
    irradiance_wm2: Optional[float],
    module_temp_c: Optional[float],
    swept_at: Optional[Any],
    irradiance_change_pct: Optional[float] = None,
    min_irradiance_wm2: float = MIN_SWEEP_IRRADIANCE_WM2,
    max_irradiance_change_pct: float = MAX_SWEEP_IRR_CHANGE_PCT,
) -> Dict[str, Any]:
    """Validate sweep conditions.

    Raises ValueError if G, T, or timestamp is missing ("A curve without its conditions can't be
    interpreted"). Returns gate status for high, stable irradiance (G >= 700 W/m², ΔG <= 2 %).
    """
    if swept_at is None or (isinstance(swept_at, str) and not swept_at.strip()):
        raise ValueError("Sweep timestamp is required; a curve without its conditions cannot be interpreted")
    if irradiance_wm2 is None or not math.isfinite(irradiance_wm2) or irradiance_wm2 <= 0:
        raise ValueError("Valid plane-of-array irradiance G (W/m²) is required with every curve")
    if module_temp_c is None or not math.isfinite(module_temp_c) or module_temp_c < -40 or module_temp_c > 120:
        raise ValueError("Valid back-of-module temperature T (°C) is required with every curve")

    reasons: List[str] = []
    if irradiance_wm2 < min_irradiance_wm2:
        reasons.append(f"Irradiance {irradiance_wm2:.0f} W/m² is below the {min_irradiance_wm2:.0f} W/m² sweep gate")
    if irradiance_change_pct is not None and abs(irradiance_change_pct) > max_irradiance_change_pct:
        reasons.append(
            f"Irradiance changed by {abs(irradiance_change_pct):.2f}% during the sweep (limit {max_irradiance_change_pct:.1f}%)"
        )
    return {
        "quality_gate_passed": len(reasons) == 0,
        "gate_reasons": reasons,
        "min_irradiance_wm2": min_irradiance_wm2,
        "max_irradiance_change_pct": max_irradiance_change_pct,
    }


def parse_iv_csv(content: str) -> List[Dict[str, float]]:
    """Parse (V, I) points from a handheld I-V tracer CSV (Seaward, Fluke, Solmetric, Hioki, or plain V,I)."""
    reader = csv.reader(io.StringIO(content.strip()))
    points: List[Dict[str, float]] = []
    v_col, i_col = 0, 1
    header_found = False
    for row in reader:
        if not row or all(not c.strip() for c in row):
            continue
        cells = [c.strip() for c in row]
        if cells[0].startswith("#"):
            continue
        low = [c.lower() for c in cells]
        if not header_found and any(
            any(k in c for k in ("volt", "v(", "v [", "v_v", "u(v)")) for c in low
        ):
            for idx, c in enumerate(low):
                if any(k in c for k in ("volt", "v(", "v [", "v_v", "u(v)", "v")):
                    v_col = idx
                    break
            for idx, c in enumerate(low):
                if idx != v_col and any(k in c for k in ("curr", "amp", "i(", "i [", "i_a", "i")):
                    i_col = idx
                    break
            header_found = True
            continue
        if len(cells) <= max(v_col, i_col):
            continue
        try:
            v = float(cells[v_col])
            i = float(cells[i_col])
        except ValueError:
            continue
        if math.isfinite(v) and math.isfinite(i):
            points.append({"v": v, "i": i})
    if len(points) < 5:
        raise ValueError("I-V curve requires at least 5 valid (V, I) points")
    return points


# ---------------------------------------------------------------------------
# 2. Curve rectification (pvlib.ivtools.utils.rectify_iv_curve equivalent)
# ---------------------------------------------------------------------------


def rectify_iv_curve(
    voltage: Sequence[float] | np.ndarray, current: Sequence[float] | np.ndarray, decimals: Optional[int] = 4
) -> Tuple[np.ndarray, np.ndarray]:
    """Clean an I-V curve:
    - Restrict to the first quadrant (V >= 0, I >= 0) and finite values
    - Sort by ascending voltage and average duplicate voltage points
    - Ensure endpoints at V = 0 (Isc) and I = 0 (Voc) by linear extrapolation when missing.
    """
    v_arr = np.asarray(voltage, dtype=float)
    i_arr = np.asarray(current, dtype=float)
    mask = np.isfinite(v_arr) & np.isfinite(i_arr) & (v_arr >= 0.0) & (i_arr >= 0.0)
    v_arr = v_arr[mask]
    i_arr = i_arr[mask]
    if v_arr.size < 4:
        raise ValueError("Too few valid first-quadrant (V, I) points after filtering")

    if decimals is not None:
        v_arr = np.round(v_arr, decimals=decimals)

    order = np.argsort(v_arr)
    v_arr = v_arr[order]
    i_arr = i_arr[order]

    # Deduplicate identical voltages by averaging current
    uniq_v, inv_idx = np.unique(v_arr, return_inverse=True)
    if uniq_v.size < v_arr.size:
        sums = np.bincount(inv_idx, weights=i_arr)
        counts = np.bincount(inv_idx)
        v_arr = uniq_v
        i_arr = sums / counts

    if v_arr.size < 4:
        raise ValueError("Too few distinct voltage points in I-V curve")

    # Extrapolate to V = 0 if needed
    if v_arr[0] > 0:
        n_head = min(4, v_arr.size)
        slope, intercept = np.polyfit(v_arr[:n_head], i_arr[:n_head], 1)
        i_sc = max(float(i_arr[0]), float(intercept))
        v_arr = np.insert(v_arr, 0, 0.0)
        i_arr = np.insert(i_arr, 0, i_sc)

    # Extrapolate or clamp to I = 0 at Voc if needed
    if i_arr[-1] > 0:
        n_tail = min(4, v_arr.size)
        dv_di, v0 = np.polyfit(i_arr[-n_tail:], v_arr[-n_tail:], 1)
        v_oc = max(float(v_arr[-1]) * 1.001, float(v0))
        v_arr = np.append(v_arr, v_oc)
        i_arr = np.append(i_arr, 0.0)
    else:
        i_arr[-1] = 0.0

    return v_arr, i_arr


# ---------------------------------------------------------------------------
# 3. Parameter extraction (Isc, Voc, Imp, Vmp, Pmax, FF, Rs/Rsh slopes, steps)
# ---------------------------------------------------------------------------


def _count_curve_steps(v: np.ndarray, i: np.ndarray) -> int:
    """Count bypass-diode steps or notches in a rectified I-V curve.

    In a clean single-diode curve, dI/dV is monotonically decreasing (becoming more negative) from
    Isc to Voc, and P(V) = V·I has a single peak. A bypass diode activation creates either:
    - Multiple local peaks in P(V), or
    - A sharp non-monotonic knee (local valley then plateau) in dI/dV.
    """
    if v.size < 8:
        return 0
    # Interpolate onto a uniform voltage grid so finite differences are not skewed by spacing
    v_max = float(v[-1])
    if v_max <= 0:
        return 0
    grid_n = min(80, max(25, v.size))
    vg = np.linspace(0.05 * v_max, 0.95 * v_max, grid_n)
    ig = np.interp(vg, v, i)
    pg = vg * ig

    # Smooth slightly with a 3-point kernel to suppress measurement noise
    kernel = np.array([0.25, 0.5, 0.25])
    pg_s = np.convolve(pg, kernel, mode="valid")
    p_max = float(np.max(pg_s)) if pg_s.size else 0.0
    if p_max <= 0:
        return 0

    # 1. Count distinct local maxima in P(V) above 15 % of Pmax separated by a dip >= 1.5 % of Pmax
    peaks: List[int] = []
    for k in range(1, pg_s.size - 1):
        if pg_s[k] >= pg_s[k - 1] and pg_s[k] >= pg_s[k + 1] and pg_s[k] > 0.15 * p_max:
            if not peaks:
                peaks.append(k)
            else:
                valley = float(np.min(pg_s[peaks[-1] : k + 1]))
                if min(pg_s[peaks[-1]], pg_s[k]) - valley >= 0.012 * p_max:
                    peaks.append(k)
                elif pg_s[k] > pg_s[peaks[-1]]:
                    peaks[-1] = k
    multi_peak_steps = max(0, len(peaks) - 1)

    # 2. Check for current-step inflections where dI/dV drops steeply then flattens mid-curve
    di_dv = np.gradient(ig, vg)
    di_s = np.convolve(di_dv, kernel, mode="valid")
    v_oc = v_max
    i_sc = float(i[0]) if i[0] > 0 else 1.0
    norm_slope = -di_s * (v_oc / i_sc)  # dimensionless positive slope magnitude
    slope_peaks = 0
    # Exclude the final steep rise near Voc (last 18 % of curve)
    limit_idx = int(0.82 * norm_slope.size)
    for k in range(1, max(1, limit_idx - 1)):
        if norm_slope[k] > norm_slope[k - 1] and norm_slope[k] > norm_slope[k + 1] and norm_slope[k] > 0.45:
            # Must recover to a flatter plateau after the step
            after_min = float(np.min(norm_slope[k + 1 : limit_idx + 1]))
            if norm_slope[k] - after_min > 0.30:
                slope_peaks += 1

    return max(multi_peak_steps, slope_peaks)


def extract_iv_parameters(voltage: Sequence[float] | np.ndarray, current: Sequence[float] | np.ndarray) -> Dict[str, Any]:
    """Extract key parameters from a (V, I) curve:
    Isc, Voc, Imp, Vmp, Pmax, fill factor (FF), slope near Voc (-dV/dI, indicator of Rs),
    slope near Isc (-dV/dI, indicator of Rsh), and the number of steps or inflection points.
    """
    v, i = rectify_iv_curve(voltage, current)
    i_sc = float(i[0])
    v_oc = float(v[-1])
    p = v * i

    # Refine MPP via quadratic interpolation around the discrete maximum power point
    idx_mp = int(np.argmax(p))
    v_mp = float(v[idx_mp])
    i_mp = float(i[idx_mp])
    p_max = float(p[idx_mp])
    if 0 < idx_mp < v.size - 1:
        v_sub = v[idx_mp - 1 : idx_mp + 2]
        p_sub = p[idx_mp - 1 : idx_mp + 2]
        if np.unique(v_sub).size == 3:
            a, b, c = np.polyfit(v_sub, p_sub, 2)
            if a < 0:
                v_vertex = -b / (2.0 * a)
                if v_sub[0] <= v_vertex <= v_sub[-1]:
                    v_mp = float(v_vertex)
                    i_mp = float(np.interp(v_mp, v, i))
                    p_max = v_mp * i_mp

    ff = p_max / (i_sc * v_oc) if i_sc > 0 and v_oc > 0 else 0.0

    # Slope near Voc: -dV/dI over [0.85·Voc, Voc] (indicator of Rs, Ω)
    voc_mask = v >= 0.85 * v_oc
    if np.count_nonzero(voc_mask) < 3:
        voc_mask = np.arange(v.size) >= max(0, v.size - 4)
    dv_di_voc, _ = np.polyfit(i[voc_mask], v[voc_mask], 1)
    slope_voc_ohm = max(0.001, float(-dv_di_voc))

    # Slope near Isc: -dV/dI over [0, 0.25·Voc] (indicator of Rsh, Ω)
    isc_mask = v <= 0.25 * v_oc
    if np.count_nonzero(isc_mask) < 3:
        isc_mask = np.arange(v.size) < min(v.size, 4)
    di_dv_isc, _ = np.polyfit(v[isc_mask], i[isc_mask], 1)
    # Guard against flat/slightly positive noisy current near V=0
    neg_di_dv = max(1e-5, float(-di_dv_isc))
    slope_isc_ohm = min(1e6, 1.0 / neg_di_dv)

    steps = _count_curve_steps(v, i)

    return {
        "i_sc_a": round(i_sc, 3),
        "v_oc_v": round(v_oc, 2),
        "i_mp_a": round(i_mp, 3),
        "v_mp_v": round(v_mp, 2),
        "p_max_w": round(p_max, 2),
        "fill_factor": round(ff, 4),
        "slope_voc_ohm": round(slope_voc_ohm, 4),
        "slope_isc_ohm": round(slope_isc_ohm, 1),
        "steps_count": int(steps),
    }


# ---------------------------------------------------------------------------
# 4. Single-diode fitting (`fit_sandia_simple` and `fit_desoto` / Lambert W)
# ---------------------------------------------------------------------------


def lambertw_pv(x: np.ndarray | float) -> np.ndarray:
    """Principal branch W₀(x) for x >= 0 using Halley's method (converges to 1e-13 in <= 5 iterations)."""
    arr = np.asarray(x, dtype=float)
    arr = np.maximum(0.0, arr)
    # Initial guess: log(1 + x) for small/medium x, log(x) - log(log(x)) for large x
    w = np.where(arr < np.e, np.log1p(arr), np.log(np.maximum(arr, 1.0)) - np.log(np.maximum(np.log(np.maximum(arr, np.e)), 1.0)))
    for _ in range(6):
        ew = np.exp(w)
        wew = w * ew
        f = wew - arr
        denom = ew * (w + 1.0) - (w + 2.0) * f / (2.0 * w + 2.0)
        w = w - f / np.where(np.abs(denom) > 1e-30, denom, 1.0)
    return np.maximum(0.0, w)


def fit_sandia_simple(
    voltage: Sequence[float] | np.ndarray,
    current: Sequence[float] | np.ndarray,
    v_oc: Optional[float] = None,
    i_sc: Optional[float] = None,
) -> Dict[str, float]:
    """Fit the single-diode equation to an I-V curve using Sandia's 6-step linear regression method
    (matches `pvlib.ivtools.sde.fit_sandia_simple`, pure NumPy).

    Returns `{i_l_a, i_o_a, r_s_ohm, r_sh_ohm, n_ns_vth_v}`.
    """
    v, i = rectify_iv_curve(voltage, current)
    voc = float(v_oc) if v_oc is not None else float(v[-1])
    isc = float(i_sc) if i_sc is not None else float(i[0])

    # Step 1: Rsh from linear slope near V = 0 (V <= 0.25 * Voc)
    m1 = v <= 0.25 * voc
    if np.count_nonzero(m1) >= 3:
        slope1, _ = np.polyfit(v[m1], i[m1], 1)
        g_p = max(1e-5, float(-slope1))
    else:
        g_p = 1e-3
    r_sh = 1.0 / g_p

    # Step 2: I_L ≈ Isc (refined after Rs is found)
    # Step 3–5: fit log(I_L - I - V/Rsh) = log(I0) + (V + I·Rs) / nNsVth in the diode knee [0.55·Voc, 0.96·Voc]
    knee = (v >= 0.55 * voc) & (v <= 0.96 * voc) & (i > 0.02 * isc)
    if np.count_nonzero(knee) < 4:
        knee = (v > 0.3 * voc) & (i > 0.01 * isc)
    vk = v[knee]
    ik = i[knee]
    i_diode = np.maximum(1e-6, isc - ik - vk / r_sh)
    y = np.log(i_diode)
    # Linear system: y = c0 + c1 * V + c2 * I  where c1 = 1/a, c2 = Rs/a, c0 = log(I0)
    A = np.column_stack([np.ones_like(vk), vk, ik])
    coeffs, _, _, _ = np.linalg.lstsq(A, y, rcond=None)
    c0, c1, c2 = float(coeffs[0]), float(coeffs[1]), float(coeffs[2])

    a = 1.0 / max(0.1, c1)  # nNsVth
    a = min(max(a, 0.025 * voc), 0.15 * voc)
    r_s = max(0.005, c2 * a)
    # Bound Rs by the slope near Voc
    voc_mask = v >= 0.85 * voc
    if np.count_nonzero(voc_mask) >= 2:
        dv_di, _ = np.polyfit(i[voc_mask], v[voc_mask], 1)
        r_s = min(r_s, max(0.01, 0.75 * float(-dv_di)))

    i_l = isc * (1.0 + r_s / r_sh)
    # Recompute I0 so open-circuit condition holds exactly at Voc
    i_o = max(1e-14, (i_l - voc / r_sh) * math.exp(-voc / a))

    return {
        "i_l_a": round(float(i_l), 4),
        "i_o_a": float(i_o),
        "r_s_ohm": round(float(r_s), 4),
        "r_sh_ohm": round(float(r_sh), 2),
        "n_ns_vth_v": round(float(a), 4),
    }


def fit_desoto(
    v_mp: float,
    i_mp: float,
    v_oc: float,
    i_sc: float,
    alpha_sc_a_per_k: float,
    beta_oc_v_per_k: float,
    n_cells_series: int = 72,
) -> Dict[str, float]:
    """Estimate single-diode parameters at STC from datasheet keypoints (De Soto 2006)."""
    v_th = K_BOLTZMANN * (T_STC + 273.15) / Q_ELECTRON
    a_init = 1.05 * n_cells_series * v_th
    # Analytical starting point matching De Soto boundary conditions at Isc, Voc, and MPP
    r_s_max = max(0.01, (v_oc - v_mp) / max(0.1, i_mp) - a_init / max(0.1, i_mp))
    r_s = 0.45 * r_s_max
    r_sh = max(50.0, v_mp / max(0.05, i_sc - i_mp) * 4.0)
    a = a_init
    for _ in range(12):
        i_l = i_sc * (1.0 + r_s / r_sh)
        i_o = max(1e-14, (i_l - v_oc / r_sh) * math.exp(-v_oc / a))
        # Adjust Rs so that P(Vmp) matches Vmp * Imp
        arg_mp = (v_mp + i_mp * r_s) / a
        i_calc = i_l - i_o * (math.exp(min(50.0, arg_mp)) - 1.0) - (v_mp + i_mp * r_s) / r_sh
        err = i_calc - i_mp
        d_i_d_rs = -(i_o * (i_mp / a) * math.exp(min(50.0, arg_mp)) + i_mp / r_sh)
        if abs(d_i_d_rs) > 1e-9:
            r_s = min(r_s_max, max(0.005, r_s - 0.5 * err / d_i_d_rs))
    i_l = i_sc * (1.0 + r_s / r_sh)
    i_o = max(1e-14, (i_l - v_oc / r_sh) * math.exp(-v_oc / a))
    return {
        "i_l_ref_a": round(i_l, 4),
        "i_o_ref_a": float(i_o),
        "r_s_ohm": round(r_s, 4),
        "r_sh_ref_ohm": round(r_sh, 2),
        "a_ref_v": round(a, 4),
        "alpha_sc_a_per_k": round(alpha_sc_a_per_k, 5),
        "beta_oc_v_per_k": round(beta_oc_v_per_k, 5),
    }


def simulate_single_diode_curve(
    i_l: float, i_o: float, r_s: float, r_sh: float, n_ns_vth: float, v_oc: float, n_points: int = 60
) -> List[Dict[str, float]]:
    """Evaluate I(V) across 0..Voc using the exact Lambert W solution of the single-diode model."""
    v = np.linspace(0.0, max(0.1, v_oc), n_points)
    g_sh = 1.0 / max(1e-3, r_sh)
    if r_s <= 1e-6:
        i = i_l - i_o * (np.exp(np.minimum(60.0, v / n_ns_vth)) - 1.0) - v * g_sh
    else:
        denom = 1.0 + r_s * g_sh
        arg_exp = (r_s * (i_l + i_o) + v) / (n_ns_vth * denom)
        arg_w = (i_o * r_s / (n_ns_vth * denom)) * np.exp(np.minimum(60.0, arg_exp))
        w = lambertw_pv(arg_w)
        i = (i_l + i_o - v * g_sh) / denom - (n_ns_vth / r_s) * w
    i = np.maximum(0.0, i)
    return [{"v": round(float(vv), 2), "i": round(float(ii), 3), "p": round(float(vv * ii), 2)} for vv, ii in zip(v, i)]


# ---------------------------------------------------------------------------
# 5. IEC 60891 Procedure 1 STC Translation
# ---------------------------------------------------------------------------


def translate_to_stc_iec60891(
    voltage: Sequence[float] | np.ndarray,
    current: Sequence[float] | np.ndarray,
    irradiance_wm2: float,
    module_temp_c: float,
    spec: ModuleStcSpec,
    modules: int = 1,
    r_s_ohm: Optional[float] = None,
    kappa_ohm_per_k: Optional[float] = None,
) -> Dict[str, Any]:
    """Translate a measured (V₁, I₁) curve at (G₁, T₁) to STC (G₂ = 1000 W/m², T₂ = 25 °C)
    using IEC 60891 Procedure 1:

        I₂ = I₁ + Isc₁·(G₂/G₁ − 1) + α·(T₂ − T₁)
        V₂ = V₁ − Rs·(I₂ − I₁) − κ·I₂·(T₂ − T₁) + β·(T₂ − T₁)
    """
    if irradiance_wm2 <= 0:
        raise ValueError("irradiance_wm2 must be positive for IEC 60891 translation")
    n_mod = max(1, int(modules))
    v1, i1 = rectify_iv_curve(voltage, current)
    i_sc1 = float(i1[0])

    # Take α and β from datasheet; Rs and κ from fitting or module defaults scaled by N
    alpha = spec.alpha_a_per_k()
    beta = spec.beta_v_per_k(n_mod)
    if r_s_ohm is None:
        try:
            sde = fit_sandia_simple(v1, i1)
            r_s = float(sde["r_s_ohm"])
        except Exception:
            r_s = spec.rs_ohm * n_mod
    else:
        r_s = float(r_s_ohm)
    kappa = float(kappa_ohm_per_k) if kappa_ohm_per_k is not None else spec.kappa_ohm_per_k * n_mod

    dt = T_STC - float(module_temp_c)
    g_ratio = G_STC / float(irradiance_wm2) - 1.0

    i2 = i1 + i_sc1 * g_ratio + alpha * dt
    v2 = v1 - r_s * (i2 - i1) - kappa * i2 * dt + beta * dt

    v2_clean, i2_clean = rectify_iv_curve(v2, i2)
    return {
        "v_stc": v2_clean,
        "i_stc": i2_clean,
        "points_stc": [
            {"v": round(float(vv), 2), "i": round(float(ii), 3), "p": round(float(vv * ii), 2)}
            for vv, ii in zip(v2_clean, i2_clean)
        ],
        "points_measured": [
            {"v": round(float(vv), 2), "i": round(float(ii), 3), "p": round(float(vv * ii), 2)}
            for vv, ii in zip(v1, i1)
        ],
        "iec60891": {
            "procedure": 1,
            "g1_wm2": round(float(irradiance_wm2), 1),
            "t1_c": round(float(module_temp_c), 1),
            "g2_wm2": G_STC,
            "t2_c": T_STC,
            "alpha_a_per_k": round(alpha, 5),
            "beta_v_per_k": round(beta, 4),
            "r_s_ohm": round(r_s, 4),
            "kappa_ohm_per_k": round(kappa, 5),
        },
    }


# ---------------------------------------------------------------------------
# 6. Fault-signature classification & Warranty Decision Rule
# ---------------------------------------------------------------------------

FAULT_SIGNATURES: Dict[str, Dict[str, str]] = {
    "normal": {
        "observation": "Within STC expected dead band",
        "likely_cause": "Operating within normal STC uncertainty band",
        "recommended_action": "No action required.",
    },
    "isc_low_normal_shape": {
        "observation": "Isc low, curve shape normal",
        "likely_cause": "Uniform soiling, optical degradation, or an irradiance sensor error. Check the sensor first.",
        "recommended_action": "Verify reference cell / irradiance sensor calibration and mounting plane first, then inspect array for uniform soiling.",
    },
    "bypass_diode_shorted": {
        "observation": "Voc low by about ⅓ of one module’s Voc",
        "likely_cause": "Shorted bypass diode, one substring bypassed",
        "recommended_action": "Perform IR thermography (look for patchwork hot substring) and module-level Voc check to replace faulty junction box / diode.",
    },
    "miswiring_or_module_count": {
        "observation": "Voc low by about one full module",
        "likely_cause": "Miswiring or wrong module count",
        "recommended_action": "Verify physical string module count against as-built String Layout and inspect jumper connections.",
    },
    "steps_in_curve": {
        "observation": "Steps or notches in the curve",
        "likely_cause": "Partial shading, cell mismatch, or cracked cells forcing a bypass diode on",
        "recommended_action": "Check array for localized shading, bird droppings, or cracked cells via Drone IR / EL inspection.",
    },
    "high_series_resistance": {
        "observation": "Shallower slope near Voc (Rs up), FF down",
        "likely_cause": "Solder-bond or ribbon corrosion, a bad connector, or a cable problem",
        "recommended_action": "Inspect MC4 connectors, combiner fuse holders, string cables, and module interconnect ribbons with IR camera under load.",
    },
    "low_shunt_resistance": {
        "observation": "Steeper slope near Isc (Rsh down), FF down",
        "likely_cause": "Shunting, PID, cell cracks",
        "recommended_action": "Conduct EL / IR inspection for cell cracks or shunting paths across cells.",
    },
    "pid": {
        "observation": "Voc and FF down, worse at low irradiance, strings near the negative pole affected",
        "likely_cause": "PID (Potential Induced Degradation)",
        "recommended_action": "Verify inverter anti-PID night recovery module status, check insulation resistance (Riso), and inspect negative-end modules with IR.",
    },
    "normal_degradation": {
        "observation": "All parameters down a little, uniformly",
        "likely_cause": "Normal degradation. Compare the size of the drop against the warranty slope.",
        "recommended_action": "Track annual performance loss rate (PLR) against module linear warranty curve.",
    },
}


def expected_stc_power_w(
    spec: ModuleStcSpec,
    modules: int = 1,
    system_age_years: float = 0.0,
) -> Dict[str, float]:
    """Expected STC Pmax: nameplate × (1 − first-year LID − years × warranted degradation)."""
    n_mod = max(1, int(modules))
    nameplate_w = n_mod * spec.wp
    age = max(0.0, float(system_age_years))
    lid_frac = (spec.first_year_lid_pct / 100.0) if age > 0 else 0.0
    deg_frac = age * (spec.annual_degradation_pct / 100.0)
    retention = max(0.50, 1.0 - lid_frac - deg_frac)
    return {
        "nameplate_w": round(nameplate_w, 2),
        "expected_pmax_stc_w": round(nameplate_w * retention, 2),
        "warranted_retention_pct": round(retention * 100.0, 2),
        "first_year_lid_pct": spec.first_year_lid_pct if age > 0 else 0.0,
        "annual_degradation_pct": spec.annual_degradation_pct,
        "system_age_years": round(age, 2),
    }


def classify_iv_fault(
    params_stc: Dict[str, Any],
    spec: ModuleStcSpec,
    modules: int = 1,
    system_age_years: float = 0.0,
    dead_band_pct: float = DEFAULT_DEAD_BAND_PCT,
    near_negative_pole: bool = False,
    low_irradiance_worse: bool = False,
    quality_gate_passed: bool = True,
    ir_confirmed: bool = False,
    timeseries_trend_confirmed: bool = False,
) -> Dict[str, Any]:
    """Classify an STC-translated I-V curve against the fault signature table and apply the
    warranty decision rule."""
    n_mod = max(1, int(modules))
    exp = expected_stc_power_w(spec, n_mod, system_age_years)
    p_exp = exp["expected_pmax_stc_w"]
    voc_exp = n_mod * spec.voc_stc
    isc_exp = spec.isc_stc
    vmp_exp = n_mod * spec.vmp_stc
    imp_exp = spec.imp_stc
    ff_exp = (vmp_exp * imp_exp) / (voc_exp * isc_exp) if voc_exp > 0 and isc_exp > 0 else 0.78

    p_stc = float(params_stc["p_max_w"])
    voc_stc = float(params_stc["v_oc_v"])
    isc_stc = float(params_stc["i_sc_a"])
    ff_stc = float(params_stc["fill_factor"])
    slope_voc = float(params_stc["slope_voc_ohm"])
    slope_isc = float(params_stc["slope_isc_ohm"])
    steps = int(params_stc["steps_count"])

    p_dev_pct = (p_stc - p_exp) / p_exp * 100.0 if p_exp > 0 else 0.0
    voc_dev_pct = (voc_stc - voc_exp) / voc_exp * 100.0 if voc_exp > 0 else 0.0
    isc_dev_pct = (isc_stc - isc_exp) / isc_exp * 100.0 if isc_exp > 0 else 0.0
    ff_dev_pct = (ff_stc - ff_exp) / ff_exp * 100.0 if ff_exp > 0 else 0.0

    # Expected nominal slopes (-dV/dI) near Voc and Isc
    rs_nom = max(0.05, (voc_exp - vmp_exp) / max(0.5, imp_exp) * 0.95)
    rsh_nom = max(50.0, vmp_exp / max(0.1, isc_exp - imp_exp) * 3.0)

    voc_drop_v = voc_exp - voc_stc
    one_mod_voc = spec.voc_stc
    one_sub_voc = spec.voc_stc / max(1, spec.substrings_per_module)

    # Check specific physical signatures
    signature = "normal"
    # 1. Steps or notches in the curve
    if steps >= 1:
        signature = "steps_in_curve"
    # 2. Voc low by about 1 or more full modules (while Isc is normal)
    elif (
        abs(isc_dev_pct) <= dead_band_pct
        and voc_drop_v >= 0.75 * one_mod_voc
        and abs(voc_drop_v / one_mod_voc - round(voc_drop_v / one_mod_voc)) <= 0.25
    ):
        signature = "miswiring_or_module_count"
    # 3. Voc low by about 1/3 (or 2/3) of one module's Voc (shorted bypass diode, while Isc is normal)
    elif (
        abs(isc_dev_pct) <= dead_band_pct
        and voc_drop_v >= 0.70 * one_sub_voc
        and (
            abs(voc_drop_v - one_sub_voc) <= 0.25 * one_sub_voc
            or abs(voc_drop_v - 2.0 * one_sub_voc) <= 0.25 * one_sub_voc
        )
    ):
        signature = "bypass_diode_shorted"
    # 4. PID: Voc and FF both down, worse at low irradiance or near negative pole (or combined Rsh collapse)
    elif voc_dev_pct < -3.0 and ff_dev_pct < -4.0 and (near_negative_pole or low_irradiance_worse or slope_isc < 0.45 * rsh_nom):
        signature = "pid"
    # 5. Steeper slope near Isc (Rsh down), FF down
    elif slope_isc < 0.55 * rsh_nom and ff_dev_pct < -3.5:
        signature = "low_shunt_resistance"
    # 6. Shallower slope near Voc (Rs up), FF down
    elif slope_voc > 1.30 * rs_nom and ff_dev_pct < -3.5:
        signature = "high_series_resistance"
    # 7. Isc low, curve shape (FF and Voc) normal
    elif isc_dev_pct < -dead_band_pct and abs(ff_dev_pct) <= 3.5 and abs(voc_dev_pct) <= 3.0:
        signature = "isc_low_normal_shape"
    # 8. All parameters down uniformly outside dead band
    elif p_dev_pct < -dead_band_pct:
        signature = "normal_degradation"

    # Decision rule:
    # - Deviation inside ±dead_band_pct (without structural steps/module-count/bypass faults) is not a finding.
    in_dead_band = abs(p_dev_pct) <= dead_band_pct and signature in ("normal", "normal_degradation", "isc_low_normal_shape")
    if in_dead_band:
        signature = "normal"
        is_finding = False
    else:
        is_finding = signature != "normal"

    # A deviation outside the dead band that matches a signature in the table becomes a ticket
    # (only when the sweep passed the measurement condition gate).
    ticket_recommended = bool(is_finding and quality_gate_passed and signature != "normal_degradation")
    if signature == "normal_degradation" and p_dev_pct < -dead_band_pct and quality_gate_passed:
        # Exceeds warranted degradation slope beyond the uncertainty dead band
        ticket_recommended = True

    # Warranty claim needs agreement from two sources: I-V + IR, or I-V + time-series trend
    below_warranty = p_dev_pct < -dead_band_pct and quality_gate_passed
    second_source: Optional[str] = None
    if ir_confirmed and timeseries_trend_confirmed:
        second_source = "ir_and_timeseries"
    elif ir_confirmed:
        second_source = "ir"
    elif timeseries_trend_confirmed:
        second_source = "timeseries_trend"
    warranty_claim_ready = bool(below_warranty and second_source is not None)

    sig_meta = FAULT_SIGNATURES[signature]
    return {
        "signature": signature,
        "observation": sig_meta["observation"],
        "likely_cause": sig_meta["likely_cause"],
        "recommended_action": sig_meta["recommended_action"],
        "is_finding": is_finding,
        "in_dead_band": in_dead_band,
        "dead_band_pct": dead_band_pct,
        "ticket_recommended": ticket_recommended,
        "warranty": {
            "below_warranted_power": below_warranty,
            "ir_confirmed": ir_confirmed,
            "timeseries_trend_confirmed": timeseries_trend_confirmed,
            "second_source": second_source,
            "warranty_claim_ready": warranty_claim_ready,
            **exp,
        },
        "deviations_pct": {
            "p_max_vs_expected_pct": round(p_dev_pct, 2),
            "v_oc_vs_stc_pct": round(voc_dev_pct, 2),
            "i_sc_vs_stc_pct": round(isc_dev_pct, 2),
            "ff_vs_stc_pct": round(ff_dev_pct, 2),
        },
    }


def analyze_iv_sweep(
    voltage: Sequence[float],
    current: Sequence[float],
    irradiance_wm2: Optional[float],
    module_temp_c: Optional[float],
    swept_at: Optional[Any],
    spec: ModuleStcSpec,
    modules: int = 1,
    system_age_years: float = 0.0,
    irradiance_change_pct: Optional[float] = None,
    dead_band_pct: float = DEFAULT_DEAD_BAND_PCT,
    near_negative_pole: bool = False,
    low_irradiance_worse: bool = False,
    ir_confirmed: bool = False,
    timeseries_trend_confirmed: bool = False,
) -> Dict[str, Any]:
    """Full pipeline for one string or module I-V sweep:
    1. Validate conditions (G, T, timestamp mandatory; gate on G >= 700 W/m² and ΔG <= 2 %)
    2. Rectify curve & extract measured parameters + Sandia single-diode fit
    3. Translate to STC via IEC 60891 Procedure 1
    4. Extract STC parameters
    5. Classify fault signature and evaluate dead-band & two-source warranty rule.
    """
    gate = validate_sweep_conditions(
        irradiance_wm2=irradiance_wm2,
        module_temp_c=module_temp_c,
        swept_at=swept_at,
        irradiance_change_pct=irradiance_change_pct,
    )
    assert irradiance_wm2 is not None and module_temp_c is not None
    params_meas = extract_iv_parameters(voltage, current)
    sde_meas = fit_sandia_simple(voltage, current, v_oc=params_meas["v_oc_v"], i_sc=params_meas["i_sc_a"])

    stc = translate_to_stc_iec60891(
        voltage=voltage,
        current=current,
        irradiance_wm2=irradiance_wm2,
        module_temp_c=module_temp_c,
        spec=spec,
        modules=modules,
        r_s_ohm=sde_meas["r_s_ohm"],
    )
    params_stc = extract_iv_parameters(stc["v_stc"], stc["i_stc"])
    sde_stc = fit_sandia_simple(stc["v_stc"], stc["i_stc"], v_oc=params_stc["v_oc_v"], i_sc=params_stc["i_sc_a"])

    # Reference ideal STC curve for comparison on the chart
    n_mod = max(1, int(modules))
    desoto_ref = fit_desoto(
        v_mp=n_mod * spec.vmp_stc,
        i_mp=spec.imp_stc,
        v_oc=n_mod * spec.voc_stc,
        i_sc=spec.isc_stc,
        alpha_sc_a_per_k=spec.alpha_a_per_k(),
        beta_oc_v_per_k=spec.beta_v_per_k(n_mod),
        n_cells_series=n_mod * spec.cells_per_module,
    )
    reference_stc_points = simulate_single_diode_curve(
        i_l=desoto_ref["i_l_ref_a"],
        i_o=desoto_ref["i_o_ref_a"],
        r_s=desoto_ref["r_s_ohm"],
        r_sh=desoto_ref["r_sh_ref_ohm"],
        n_ns_vth=desoto_ref["a_ref_v"],
        v_oc=n_mod * spec.voc_stc,
    )

    classification = classify_iv_fault(
        params_stc=params_stc,
        spec=spec,
        modules=n_mod,
        system_age_years=system_age_years,
        dead_band_pct=dead_band_pct,
        near_negative_pole=near_negative_pole,
        low_irradiance_worse=low_irradiance_worse,
        quality_gate_passed=gate["quality_gate_passed"],
        ir_confirmed=ir_confirmed,
        timeseries_trend_confirmed=timeseries_trend_confirmed,
    )

    return {
        "conditions": {
            "swept_at": str(swept_at),
            "irradiance_wm2": round(float(irradiance_wm2), 1),
            "module_temp_c": round(float(module_temp_c), 1),
            "irradiance_change_pct": round(float(irradiance_change_pct), 2) if irradiance_change_pct is not None else None,
            **gate,
        },
        "iec60891": stc["iec60891"],
        "measured": {
            "parameters": params_meas,
            "single_diode_fit": sde_meas,
            "points": stc["points_measured"],
        },
        "stc": {
            "parameters": params_stc,
            "single_diode_fit": sde_stc,
            "points": stc["points_stc"],
            "reference_points": reference_stc_points,
        },
        "classification": classification,
    }
