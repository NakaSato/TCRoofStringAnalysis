"""I-V curve analysis at string and module level (pure NumPy engine, no SciPy/pvlib required).

Implements:
1. Measurement-condition validation (G, T and timestamp mandatory). STC comparison needs
   G >= 700 W/m² (IEC 61829) and |ΔG| <= 2 %; a curve at G >= 400 W/m² (IEC 62446-1) can still be
   read for its shape (steps). 700–800 W/m² and |ΔG| 1–2 % pass with a warning.
2. Curve cleaning (`rectify_iv_curve`, matching `pvlib.ivtools.utils.rectify_iv_curve`).
3. Translation to STC (1000 W/m², 25 °C) via IEC 60891 Procedure 1:
       I₂ = I₁ + Isc₁·(G₂/G₁ − 1) + α·(T₂ − T₁)
       V₂ = V₁ − Rs·(I₂ − I₁) − κ·I₂·(T₂ − T₁) + β·(T₂ − T₁)
4. Single-diode model fitting (`fit_sandia_simple` 6-region linear regression and `fit_desoto`
   via Newton/Lambert W).
5. Parameter extraction per curve: Isc, Voc, Imp, Vmp, Pmax, FF = Pmax / (Isc·Voc), slope near Voc
   (Rs indicator), slope near Isc (Rsh indicator), and step / inflection count.
6. Fault-signature classification with a configurable dead band (default 5 %, the expanded
   uncertainty of field STC Pmax). Steps are counted on the measured curve, not the translated one.
   A string below warranted power with a second source (IR or time-series trend) is a candidate
   for module-level testing: a string sweep alone is not warranty evidence.
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

MIN_SWEEP_IRRADIANCE_WM2 = 700.0  # IEC 61829: minimum for translation to STC
WARN_SWEEP_IRRADIANCE_WM2 = 800.0  # IEA PVPS T13-24 best practice
MIN_SHAPE_IRRADIANCE_WM2 = 400.0  # IEC 62446-1: minimum for any diagnostic curve
MAX_SWEEP_IRR_CHANGE_PCT = 2.0  # engineering practice (reject level)
WARN_SWEEP_IRR_CHANGE_PCT = 1.0  # IEA PVPS T13-24 best practice
# Expanded uncertainty of field STC Pmax is ±3.5–5 % (IEA PVPS T13-24); 3 % is only justified with
# a primary-calibrated reference cell and equivalent cell temperature.
DEFAULT_DEAD_BAND_PCT = 5.0
# Second translation target for trending: closer to operating temperature on Thai roofs, so the
# temperature extrapolation (and the error from the coefficients) is smaller than to 25 °C.
SITE_REFERENCE_TEMP_C = 55.0
# IEC 60891:2021 Procedure 2 irradiance factors for Voc. Typical c-Si values, not measured for the
# fleet module: results that use them are labelled `assumed`.
DEFAULT_P2_B1 = 0.045
DEFAULT_P2_B2 = 0.0
P2_DISAGREE_PCT = 1.0  # Procedure 1 vs 2 Pmax difference worth a warning
# IEC 60891:2021 Procedure 4 device constant ε (V per cell), default for crystalline silicon.
DEFAULT_P4_EPSILON_V = 1.232
# Dynamic procedure (Li et al. 2024, DuraMAT/IVcorrection): a shunt resistance above this per
# module is neglected, as in the reference implementation.
PDYN_RSH_NEGLECT_OHM_PER_MODULE = 100.0
PDYN_RSH_NEGLECTED_OHM = 1e5
# IEA PVPS T13-24 best practice: module temperature changes < 1 K over the minute before the sweep.
MAX_TEMP_CHANGE_K_PER_MIN = 1.0
# High-capacitance cells (TOPCon, HJT, IBC) need a sweep of at least 100 ms; a faster sweep can
# mis-measure Pmax by more than 20 % (JRC guidelines).
MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE = 100.0
HIGH_CAPACITANCE_TECH = ("topcon", "hjt", "ibc")
# Forward and reverse sweeps of one string should give the same Pmax; a larger difference points
# at cell capacitance (proposed level, not from a standard).
MAX_FWD_REV_PMAX_DIFF_PCT = 1.0
# Irradiance sensor against the array plane: IEC 60904-1 allows ±2°, best practice is ±1°.
MAX_SENSOR_MISALIGNMENT_DEG = 2.0
WARN_SENSOR_MISALIGNMENT_DEG = 1.0
# Assumed inputs of the Pmax uncertainty estimate (expanded, k = 2), used when nothing is measured.
ASSUMED_IRRADIANCE_UNCERTAINTY_PCT = 2.5  # factory-calibrated reference cell (IEA PVPS T13-24)
ASSUMED_MODULE_TEMP_ERROR_K = 3.0  # backsheet-to-cell gradient plus non-uniformity along the string
ASSUMED_TEMP_COEFF_UNCERTAINTY_FRAC = 0.10  # ±10 % on the temperature coefficient (IEA PVPS T13-24)
ASSUMED_TRANSLATION_UNCERTAINTY_PCT = 1.0  # IEC 60891 translation above 800 W/m² (IEA PVPS T13-24)
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
    # IEC 60891 Procedure 2 irradiance factors measured for this module; None = use the assumed defaults
    p2_b1: Optional[float] = None
    p2_b2: Optional[float] = None

    def p2_factors(self) -> Tuple[float, float, str]:
        """(B1, B2, source): the module's own factors (`fleet_setting`), else the typical ones (`assumed`)."""
        if self.p2_b1 is None:
            return DEFAULT_P2_B1, DEFAULT_P2_B2, "assumed"
        return float(self.p2_b1), float(self.p2_b2 or 0.0), "fleet_setting"

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
            p2_b1=float(d["p2_b1"]) if d.get("p2_b1") is not None else None,
            p2_b2=float(d["p2_b2"]) if d.get("p2_b2") is not None else None,
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
    temp_change_k_per_min: Optional[float] = None,
    sweep_time_ms: Optional[float] = None,
    cell_technology: Optional[str] = None,
    sensor_misalignment_deg: Optional[float] = None,
) -> Dict[str, Any]:
    """Validate sweep conditions.

    Raises ValueError if G, T, or timestamp is missing ("A curve without its conditions can't be
    interpreted"). Returns:
    - `quality_gate_passed`: G >= 700 W/m² and ΔG <= 2 %, so the STC comparison may be judged
    - `shape_gate_passed`: G >= 400 W/m² and ΔG <= 2 %, so the curve shape (steps) may be judged
    - `gate_warnings`: passed, but outside best practice (G < 800 W/m², ΔG > 1 %, module
      temperature changing by more than 1 K/min, sweep under 100 ms on an unknown cell technology)
    - `quality_flags`: `low_G`, `unstable_G`, `unstable_T`, `capacitance_suspect`, `sensor_misaligned`
      (irradiance sensor more than 2° off the array plane, IEC 60904-1: a warning)

    A sweep under 100 ms on high-capacitance cells (TOPCon, HJT, IBC) fails the quality gate: its
    power is unreliable, but steps in the curve can still be judged.
    """
    shape_min = min(MIN_SHAPE_IRRADIANCE_WM2, min_irradiance_wm2)
    if swept_at is None or (isinstance(swept_at, str) and not swept_at.strip()):
        raise ValueError("Sweep timestamp is required; a curve without its conditions cannot be interpreted")
    if irradiance_wm2 is None or not math.isfinite(irradiance_wm2) or irradiance_wm2 <= 0:
        raise ValueError("Valid plane-of-array irradiance G (W/m²) is required with every curve")
    if module_temp_c is None or not math.isfinite(module_temp_c) or module_temp_c < -40 or module_temp_c > 120:
        raise ValueError("Valid back-of-module temperature T (°C) is required with every curve")

    reasons: List[str] = []
    warnings: List[str] = []
    flags: List[str] = []
    shape_ok = True
    if irradiance_wm2 < min_irradiance_wm2:
        flags.append("low_G")
    if irradiance_wm2 < shape_min:
        shape_ok = False
        reasons.append(f"Irradiance {irradiance_wm2:.0f} W/m² is below the {shape_min:.0f} W/m² minimum for any diagnosis")
    elif irradiance_wm2 < min_irradiance_wm2:
        reasons.append(
            f"Irradiance {irradiance_wm2:.0f} W/m² is below the {min_irradiance_wm2:.0f} W/m² sweep gate for STC comparison (curve shape only)"
        )
    elif irradiance_wm2 < WARN_SWEEP_IRRADIANCE_WM2:
        warnings.append(f"Irradiance {irradiance_wm2:.0f} W/m² is below the {WARN_SWEEP_IRRADIANCE_WM2:.0f} W/m² best practice")
    if irradiance_change_pct is not None:
        change = abs(irradiance_change_pct)
        if change > max_irradiance_change_pct:
            shape_ok = False
            reasons.append(f"Irradiance changed by {change:.2f}% during the sweep (limit {max_irradiance_change_pct:.1f}%)")
        elif change > WARN_SWEEP_IRR_CHANGE_PCT:
            warnings.append(f"Irradiance changed by {change:.2f}% during the sweep (best practice {WARN_SWEEP_IRR_CHANGE_PCT:.0f}%)")
        if change > WARN_SWEEP_IRR_CHANGE_PCT:
            flags.append("unstable_G")
    if temp_change_k_per_min is not None and abs(temp_change_k_per_min) > MAX_TEMP_CHANGE_K_PER_MIN:
        flags.append("unstable_T")
        warnings.append(
            f"Module temperature changed by {abs(temp_change_k_per_min):.1f} K in the minute before the sweep "
            f"(best practice {MAX_TEMP_CHANGE_K_PER_MIN:.0f} K)"
        )
    if sweep_time_ms is not None and sweep_time_ms < MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE:
        tech = (cell_technology or "").strip().lower()
        flags.append("capacitance_suspect")
        if tech in HIGH_CAPACITANCE_TECH:
            reasons.append(
                f"Sweep of {sweep_time_ms:.0f} ms is too fast for {tech.upper()} cells "
                f"(minimum {MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE:.0f} ms): power is unreliable (curve shape only)"
            )
        elif not tech:
            warnings.append(
                f"Sweep of {sweep_time_ms:.0f} ms is under {MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE:.0f} ms and the cell "
                "technology is not given: power is unreliable if the modules are TOPCon, HJT or IBC"
            )
        else:
            flags.remove("capacitance_suspect")
    if sensor_misalignment_deg is not None:
        off = abs(sensor_misalignment_deg)
        if off > MAX_SENSOR_MISALIGNMENT_DEG:
            flags.append("sensor_misaligned")
            warnings.append(
                f"Irradiance sensor is {off:.1f}° off the array plane (IEC 60904-1 limit {MAX_SENSOR_MISALIGNMENT_DEG:.0f}°): "
                "the irradiance reading, and so Isc and Pmax at STC, are less certain"
            )
        elif off > WARN_SENSOR_MISALIGNMENT_DEG:
            warnings.append(
                f"Irradiance sensor is {off:.1f}° off the array plane (best practice {WARN_SENSOR_MISALIGNMENT_DEG:.0f}°)"
            )
    return {
        "quality_gate_passed": len(reasons) == 0,
        "shape_gate_passed": shape_ok,
        "gate_reasons": reasons,
        "gate_warnings": warnings,
        "quality_flags": flags,
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

    # A sweep that runs past Voc ends in several points at I = 0; Voc is the first of them
    pos = np.flatnonzero(i_arr > 0.0)
    if pos.size and pos[-1] + 2 < i_arr.size:
        v_arr, i_arr = v_arr[: pos[-1] + 2], i_arr[: pos[-1] + 2]

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
    target_irradiance_wm2: float = G_STC,
    target_temp_c: float = T_STC,
    procedure: int | str = 1,
    b1: Optional[float] = None,
    b2: Optional[float] = None,
    r_sh_ohm: Optional[float] = None,
    epsilon_v: float = DEFAULT_P4_EPSILON_V,
) -> Dict[str, Any]:
    """Translate a measured (V₁, I₁) curve at (G₁, T₁) to (G₂, T₂), by default STC
    (1000 W/m², 25 °C). The `*_stc` keys of the result hold the curve at the target.

    IEC 60891 Procedure 1 (default):

        I₂ = I₁ + Isc₁·(G₂/G₁ − 1) + α·(T₂ − T₁)
        V₂ = V₁ − Rs·(I₂ − I₁) − κ·I₂·(T₂ − T₁) + β·(T₂ − T₁)

    IEC 60891:2021 Procedure 2 (`procedure=2`), with relative coefficients and
    f(G) = B₂·ln²(1000/G) + B₁·ln(1000/G) + 1:

        I₂ = I₁·(G₂/G₁)·[1 + α_rel·(T₂ − 25)] / [1 + α_rel·(T₁ − 25)]
        V₂ = V₁ − Rs₁·(I₂ − I₁) − κ·I₂·(T₂ − T₁)
             + Voc_STC·{β_rel·[f(G₂)·(T₂ − 25) − f(G₁)·(T₁ − 25)] + 1/f(G₂) − 1/f(G₁)}
        Rs₁ = Rs + κ·(T₁ − 25)

    IEC 60891:2021 Procedure 4 (`procedure=4`), for c-Si without Rs/κ/β; T₁ in kelvin in the
    divisor, Ns = cells in series, ε = 1.232 V:

        I₁′ = I₁ + Isc₁·(G₂/G₁ − 1)          V₁′ = V₁ − Rs·(I₁′ − I₁)
        I₂ = I₁′ + α·(T₂ − T₁)               V₂ = V₁′ + (T₂ − T₁)/T₁·(V₁′ − Ns·ε)

    Dynamic procedure (`procedure="dynamic"`, Li et al. 2024): Procedure 2 applied to the curve
    without its shunt current, which is put back afterwards, so a low shunt resistance does not
    distort the translation. Rs and Rsh come from the measured curve (`r_s_ohm`, `r_sh_ohm`, or a
    Sandia fit); Rsh above 100 Ω per module is neglected:

        I′ = (I₁ + V₁/Rsh)·(G₂/G₁)·[1 + α_rel·(T₂ − 25)] / [1 + α_rel·(T₁ − 25)]
        V₂ = Procedure 2 voltage with (I′ − I₁ − V₁/Rsh) as the current step and I′ in the κ term
        I₂ = I′ − V₂/Rsh

    Procedures 2, 4 and dynamic follow the open-source reference implementation of Li et al.
    (DuraMAT/IVcorrection), which corrects to STC; the general target (G₂, T₂) for Procedure 2 is
    from the literature. None was checked against the standard's text. Voc_STC is the datasheet
    value × modules.
    """
    if procedure not in (1, 2, 4, "dynamic"):
        raise ValueError("procedure must be 1, 2, 4 or 'dynamic'")
    if b1 is None:
        b1, b2_spec, _ = spec.p2_factors()
        b2 = b2_spec if b2 is None else b2
    b2 = 0.0 if b2 is None else b2
    if irradiance_wm2 <= 0:
        raise ValueError("irradiance_wm2 must be positive for IEC 60891 translation")
    n_mod = max(1, int(modules))
    v1, i1 = rectify_iv_curve(voltage, current)
    i_sc1 = float(i1[0])

    # Take α and β from datasheet; Rs and κ from fitting or module defaults scaled by N
    alpha = spec.alpha_a_per_k()
    beta = spec.beta_v_per_k(n_mod)
    sde: Optional[Dict[str, float]] = None
    if r_s_ohm is None or (procedure == "dynamic" and r_sh_ohm is None):
        try:
            sde = fit_sandia_simple(v1, i1)
        except Exception:
            sde = None
    if r_s_ohm is not None:
        r_s = float(r_s_ohm)
    else:
        r_s = float(sde["r_s_ohm"]) if sde else spec.rs_ohm * n_mod
    r_sh: Optional[float] = None
    if procedure == "dynamic":
        if r_sh_ohm is not None:
            r_sh = float(r_sh_ohm)
        elif sde:
            r_sh = float(sde["r_sh_ohm"])
        else:
            raise ValueError("The dynamic procedure needs a shunt resistance from the measured curve")
        if r_sh > PDYN_RSH_NEGLECT_OHM_PER_MODULE * n_mod:
            r_sh = PDYN_RSH_NEGLECTED_OHM
    kappa = float(kappa_ohm_per_k) if kappa_ohm_per_k is not None else spec.kappa_ohm_per_k * n_mod

    g1, t1 = float(irradiance_wm2), float(module_temp_c)
    g2, t2 = float(target_irradiance_wm2), float(target_temp_c)
    dt = t2 - t1

    if procedure == 1:
        i2 = i1 + i_sc1 * (g2 / g1 - 1.0) + alpha * dt
        v2 = v1 - r_s * (i2 - i1) - kappa * i2 * dt + beta * dt
    elif procedure == 4:
        i_tmp = i1 + i_sc1 * (g2 / g1 - 1.0)
        v_tmp = v1 - r_s * (i_tmp - i1)
        i2 = i_tmp + alpha * dt
        v2 = v_tmp + dt / (t1 + 273.15) * (v_tmp - epsilon_v * n_mod * spec.cells_per_module)
    else:
        a_rel = spec.temp_coeff_isc_pct / 100.0
        b_rel = spec.temp_coeff_voc_pct / 100.0
        voc_stc = n_mod * spec.voc_stc

        def f(g: float) -> float:
            x = math.log(G_STC / g)
            return b2 * x * x + b1 * x + 1.0

        # dynamic: translate the curve without its shunt current, then put that current back
        i_src = i1 + v1 / r_sh if r_sh is not None else i1
        i2 = i_src * (g2 / g1) * (1.0 + a_rel * (t2 - T_STC)) / (1.0 + a_rel * (t1 - T_STC))
        r_s1 = r_s + kappa * (t1 - T_STC)
        v2 = (
            v1
            - r_s1 * (i2 - i_src)
            - kappa * i2 * dt
            + voc_stc * (b_rel * (f(g2) * (t2 - T_STC) - f(g1) * (t1 - T_STC)) + 1.0 / f(g2) - 1.0 / f(g1))
        )
        if r_sh is not None:
            i2 = i2 - v2 / r_sh

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
            "procedure": procedure,
            "g1_wm2": round(g1, 1),
            "t1_c": round(t1, 1),
            "g2_wm2": g2,
            "t2_c": t2,
            "alpha_a_per_k": round(alpha, 5),
            "beta_v_per_k": round(beta, 4),
            "r_s_ohm": round(r_s, 4),
            "kappa_ohm_per_k": round(kappa, 5),
            **({"r_sh_ohm": round(r_sh, 2)} if r_sh is not None else {}),
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
    "not_judged": {
        "observation": "Sweep conditions do not allow a comparison at STC; only steps in the curve are judged",
        "likely_cause": "Not judged: irradiance below 700 W/m², unstable irradiance, or a sweep too fast for the cells",
        "recommended_action": "Repeat the sweep at 700 W/m² or more with stable irradiance.",
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
    steps_measured: Optional[int] = None,
    shape_gate_passed: Optional[bool] = None,
    absolute_comparison_ok: bool = True,
) -> Dict[str, Any]:
    """Classify an STC-translated I-V curve against the fault signature table and apply the
    decision rule.

    `steps_measured` is the step count of the measured (untranslated) curve; when given it is used
    instead of the translated curve's, because translating a stepped curve can distort it.
    `shape_gate_passed` (default: `quality_gate_passed`) allows a ticket for steps on a sweep that
    is good enough for its shape but not for STC comparison.
    `absolute_comparison_ok = False` (inverter scan: irradiance and temperature come from a plant
    sensor, not a reference cell at the string): the signatures that rest on absolute current or
    power (`isc_low_normal_shape`, `normal_degradation`) raise no ticket and the power is not
    judged against warranty. Such sweeps are judged against their same-time peers instead."""
    shape_ok = quality_gate_passed if shape_gate_passed is None else bool(shape_gate_passed)
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
    steps = int(params_stc["steps_count"]) if steps_measured is None else int(steps_measured)

    p_dev_pct = (p_stc - p_exp) / p_exp * 100.0 if p_exp > 0 else 0.0
    voc_dev_pct = (voc_stc - voc_exp) / voc_exp * 100.0 if voc_exp > 0 else 0.0
    isc_dev_pct = (isc_stc - isc_exp) / isc_exp * 100.0 if isc_exp > 0 else 0.0
    ff_dev_pct = (ff_stc - ff_exp) / ff_exp * 100.0 if ff_exp > 0 else 0.0

    # Expected nominal slopes (-dV/dI) near Voc and Isc
    rs_nom = max(0.05, (voc_exp - vmp_exp) / max(0.5, imp_exp) * 0.95)
    rsh_nom = max(50.0, vmp_exp / max(0.1, isc_exp - imp_exp) * 3.0)

    voc_drop_v = voc_exp - voc_stc
    # A collapsed shunt lowers Voc too; a missing module or a shorted bypass diode leaves the
    # slope near Isc normal, so a Voc drop is read as structural only while that slope is.
    shunt_ok = slope_isc >= 0.55 * rsh_nom
    one_mod_voc = spec.voc_stc
    one_sub_voc = spec.voc_stc / max(1, spec.substrings_per_module)

    # Check specific physical signatures
    signature = "normal"
    # 1. Steps or notches in the curve
    if steps >= 1:
        signature = "steps_in_curve"
    # 2. Voc low by about 1 or more full modules (while Isc is normal)
    elif (
        shunt_ok
        and abs(isc_dev_pct) <= dead_band_pct
        and voc_drop_v >= 0.75 * one_mod_voc
        and abs(voc_drop_v / one_mod_voc - round(voc_drop_v / one_mod_voc)) <= 0.25
    ):
        signature = "miswiring_or_module_count"
    # 3. Voc low by about 1/3 (or 2/3) of one module's Voc (shorted bypass diode, while Isc is normal)
    elif (
        shunt_ok
        and abs(isc_dev_pct) <= dead_band_pct
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

    # A sweep that failed the quality gate is translated over a long distance (or its power is
    # unreliable), so a signature read from its STC values can be an artefact of the translation.
    # Only steps, read from the measured shape, are judged; the rest is reported as not judged.
    unjudged_signature: Optional[str] = None
    if not quality_gate_passed and signature != "steps_in_curve":
        unjudged_signature = signature
        signature = "not_judged"

    # Decision rule:
    # - Deviation inside ±dead_band_pct (without structural steps/module-count/bypass faults) is not a finding.
    in_dead_band = abs(p_dev_pct) <= dead_band_pct and signature in ("normal", "normal_degradation", "isc_low_normal_shape")
    if in_dead_band:
        signature = "normal"
        is_finding = False
    else:
        is_finding = signature not in ("normal", "not_judged")

    # A deviation outside the dead band that matches a signature in the table becomes a ticket
    # (only when the sweep passed the measurement condition gate).
    stepped = signature == "steps_in_curve"
    ticket_recommended = bool(is_finding and quality_gate_passed and signature != "normal_degradation")
    if signature == "normal_degradation" and p_dev_pct < -dead_band_pct and quality_gate_passed:
        # Exceeds warranted degradation slope beyond the uncertainty dead band
        ticket_recommended = True
    if not absolute_comparison_ok and signature in ("isc_low_normal_shape", "normal_degradation"):
        ticket_recommended = False
    if stepped and shape_ok:
        # Steps are read from the measured shape: valid from 400 W/m², no STC comparison needed
        ticket_recommended = True

    # A string sweep gives the average of its modules, so it cannot prove a warranty case. Below
    # warranted power + a second source (IR or time-series trend) = test the modules one by one.
    # The STC power of a stepped curve is for comparison only and is not judged against warranty.
    below_warranty = p_dev_pct < -dead_band_pct and quality_gate_passed and not stepped and absolute_comparison_ok
    second_source: Optional[str] = None
    if ir_confirmed and timeseries_trend_confirmed:
        second_source = "ir_and_timeseries"
    elif ir_confirmed:
        second_source = "ir"
    elif timeseries_trend_confirmed:
        second_source = "timeseries_trend"
    module_test_candidate = bool(below_warranty and second_source is not None)

    sig_meta = FAULT_SIGNATURES[signature]
    return {
        "signature": signature,
        "observation": sig_meta["observation"],
        "likely_cause": sig_meta["likely_cause"],
        "recommended_action": sig_meta["recommended_action"],
        # what the STC values would have been read as, had the conditions allowed it; for information
        "unjudged_signature": unjudged_signature,
        "is_finding": is_finding,
        "in_dead_band": in_dead_band,
        "dead_band_pct": dead_band_pct,
        "ticket_recommended": ticket_recommended,
        "stc_comparison_valid": bool(quality_gate_passed and not stepped and absolute_comparison_ok),
        "warranty": {
            "below_warranted_power": below_warranty,
            "ir_confirmed": ir_confirmed,
            "timeseries_trend_confirmed": timeseries_trend_confirmed,
            "second_source": second_source,
            "module_test_candidate": module_test_candidate,
            **exp,
        },
        "deviations_pct": {
            "p_max_vs_expected_pct": round(p_dev_pct, 2),
            "v_oc_vs_stc_pct": round(voc_dev_pct, 2),
            "i_sc_vs_stc_pct": round(isc_dev_pct, 2),
            "ff_vs_stc_pct": round(ff_dev_pct, 2),
        },
    }


def estimate_stc_pmax_uncertainty(
    module_temp_c: float,
    spec: ModuleStcSpec,
    irradiance_uncertainty_pct: Optional[float] = None,
    irradiance_change_pct: Optional[float] = None,
    temp_change_k_per_min: Optional[float] = None,
    procedure_spread_pct: Optional[float] = None,
    target_temp_c: float = T_STC,
) -> Dict[str, Any]:
    """Expanded uncertainty (k = 2) of the translated Pmax, in % of Pmax: the components below
    combined as a root sum of squares (uncorrelated, GUM). It is an estimate from stated
    assumptions, and a lower bound: `not_included` lists what it leaves out.

    - irradiance sensor: the given calibration uncertainty, else 2.5 % (assumed)
    - irradiance change during the sweep: the measured ΔG, when given
    - module temperature: ±3 K (assumed; plus the measured change per minute) × |γ|
    - temperature coefficient: ±10 % of γ over the translation distance |T₂ − T₁|
    - translation: 1 %, or the spread between the IEC 60891 procedures when that is larger
    """
    gamma = abs(spec.temp_coeff_pmax_pct)
    comps: List[Dict[str, Any]] = []

    def add(name: str, pct: float, source: str) -> None:
        comps.append({"name": name, "pct": round(float(pct), 2), "source": source})

    if irradiance_uncertainty_pct is not None:
        add("irradiance_sensor", abs(irradiance_uncertainty_pct), "input")
    else:
        add("irradiance_sensor", ASSUMED_IRRADIANCE_UNCERTAINTY_PCT, "assumed")
    if irradiance_change_pct is not None:
        add("irradiance_change", abs(irradiance_change_pct), "input")
    t_err = ASSUMED_MODULE_TEMP_ERROR_K
    if temp_change_k_per_min is not None:
        t_err = math.hypot(t_err, abs(temp_change_k_per_min))
    add("module_temperature", t_err * gamma, "assumed")
    add("temperature_coefficient", ASSUMED_TEMP_COEFF_UNCERTAINTY_FRAC * gamma * abs(target_temp_c - module_temp_c), "assumed")
    spread = abs(procedure_spread_pct) if procedure_spread_pct is not None else 0.0
    if spread > ASSUMED_TRANSLATION_UNCERTAINTY_PCT:
        add("translation", spread, "procedure_spread")
    else:
        add("translation", ASSUMED_TRANSLATION_UNCERTAINTY_PCT, "assumed")
    total = math.sqrt(sum(c["pct"] ** 2 for c in comps))
    return {
        "expanded_pct": round(total, 1),
        "coverage_k": 2,
        "lower_bound": True,
        "components": comps,
        "not_included": ["tracer_voltage_current_accuracy", "repeatability", "spectral_mismatch", "sensor_alignment"],
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
    absolute_comparison_ok: bool = True,
    temp_change_k_per_min: Optional[float] = None,
    sweep_time_ms: Optional[float] = None,
    cell_technology: Optional[str] = None,
    irradiance_uncertainty_pct: Optional[float] = None,
    reverse_pmax_w: Optional[float] = None,
    sensor_misalignment_deg: Optional[float] = None,
) -> Dict[str, Any]:
    """Full pipeline for one string or module I-V sweep:
    1. Validate conditions (G, T, timestamp mandatory; STC gate G >= 700 W/m² and ΔG <= 2 %,
       shape gate G >= 400 W/m²)
    2. Rectify curve & extract measured parameters + Sandia single-diode fit
    3. Translate to STC via IEC 60891 Procedure 1
    4. Extract STC parameters
    5. Classify fault signature and evaluate the dead band & two-source module-test rule.
    6. Cross-check STC Pmax with Procedure 2, Procedure 4 and the dynamic procedure, and translate
       to the site reference (1000 W/m², 55 °C).
    7. Estimate the expanded uncertainty of STC Pmax (not for inverter scans).
    8. Compare with the opposite-direction sweep's Pmax when given, and work out the equivalent
       cell temperature from Voc (shown next to the measured temperature, never used to translate).
    """
    gate = validate_sweep_conditions(
        irradiance_wm2=irradiance_wm2,
        module_temp_c=module_temp_c,
        swept_at=swept_at,
        irradiance_change_pct=irradiance_change_pct,
        temp_change_k_per_min=temp_change_k_per_min,
        sweep_time_ms=sweep_time_ms,
        cell_technology=cell_technology,
        sensor_misalignment_deg=sensor_misalignment_deg,
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
        steps_measured=params_meas["steps_count"],
        shape_gate_passed=gate["shape_gate_passed"],
        absolute_comparison_ok=absolute_comparison_ok,
    )
    warnings = list(gate["gate_warnings"])
    if not absolute_comparison_ok:
        warnings.append("Inverter scan: irradiance and temperature are not from a reference cell at the string, so absolute STC power is not judged")

    # Cross-checks with the other procedures and the site reference. All are modelled from the
    # same measured curve; a translation that fails is left out (null), never replaced.
    p1_pmax = float(params_stc["p_max_w"])
    iec = dict(stc["iec60891"])
    iec["procedure_2"] = None
    iec["procedure_4"] = None
    iec["procedure_dynamic"] = None
    iec["site_reference"] = None
    r_s_fit = float(sde_meas["r_s_ohm"])
    b1, b2, b_source = spec.p2_factors()

    def cross_check(procedure: int | str, **kw: Any) -> Optional[Dict[str, Any]]:
        try:
            tr = translate_to_stc_iec60891(
                voltage, current, irradiance_wm2, module_temp_c, spec, modules, r_s_ohm=r_s_fit, procedure=procedure, **kw
            )
            pmax = float(extract_iv_parameters(tr["v_stc"], tr["i_stc"])["p_max_w"])
        except (ValueError, np.linalg.LinAlgError):
            return None
        diff = (pmax - p1_pmax) / p1_pmax * 100.0 if p1_pmax > 0 else 0.0
        return {"p_max_stc_w": round(pmax, 2), "diff_vs_procedure_1_pct": round(diff, 2), "_tr": tr}

    p2 = cross_check(2)
    if p2:
        p2.pop("_tr")
        iec["procedure_2"] = {**p2, "b1": b1, "b2": b2, "coefficients": b_source}
        if abs(p2["diff_vs_procedure_1_pct"]) > P2_DISAGREE_PCT:
            warnings.append(
                f"IEC 60891 Procedures 1 and 2 differ by {abs(p2['diff_vs_procedure_1_pct']):.1f}% in STC Pmax: translation uncertainty is high"
            )
    p4 = cross_check(4)
    if p4:
        p4.pop("_tr")
        iec["procedure_4"] = {**p4, "epsilon_v": DEFAULT_P4_EPSILON_V, "cells_in_series": n_mod * spec.cells_per_module}
    pdyn = cross_check("dynamic", r_sh_ohm=float(sde_meas["r_sh_ohm"]))
    if pdyn:
        r_sh_used = pdyn.pop("_tr")["iec60891"]["r_sh_ohm"]
        shunt_neglected = r_sh_used >= PDYN_RSH_NEGLECTED_OHM
        diff_p2 = None
        if p2 and p2["p_max_stc_w"] > 0:
            diff_p2 = round((pdyn["p_max_stc_w"] - p2["p_max_stc_w"]) / p2["p_max_stc_w"] * 100.0, 2)
        iec["procedure_dynamic"] = {
            **pdyn,
            "diff_vs_procedure_2_pct": diff_p2,
            "r_sh_ohm": None if shunt_neglected else r_sh_used,
            "shunt_neglected": shunt_neglected,
            "b1": b1,
            "b2": b2,
            "coefficients": b_source,
        }
        if diff_p2 is not None and abs(diff_p2) > P2_DISAGREE_PCT:
            warnings.append(
                f"The dynamic procedure differs from Procedure 2 by {abs(diff_p2):.1f}% in STC Pmax: "
                "the shunt current of this curve distorts the standard translation"
            )
    try:
        v_m, i_m = rectify_iv_curve(voltage, current)  # ends at the first I = 0 point
        site = translate_to_stc_iec60891(
            v_m, i_m, irradiance_wm2, module_temp_c, spec, modules, r_s_ohm=r_s_fit, target_temp_c=SITE_REFERENCE_TEMP_C
        )
        sp = extract_iv_parameters(site["v_stc"], site["i_stc"])
        iec["site_reference"] = {
            "g_wm2": G_STC,
            "t_c": SITE_REFERENCE_TEMP_C,
            "procedure": 1,
            "parameters": {k: sp[k] for k in ("p_max_w", "i_sc_a", "v_oc_v", "fill_factor")},
        }
    except (ValueError, np.linalg.LinAlgError):
        pass

    # Uncertainty of the judged (Procedure 1) STC Pmax. Not for inverter scans: their irradiance
    # and temperature are not measured at the string, so no budget can be stated.
    uncertainty: Optional[Dict[str, Any]] = None
    if absolute_comparison_ok:
        diffs = [abs(x["diff_vs_procedure_1_pct"]) for x in (iec["procedure_2"], iec["procedure_dynamic"]) if x]
        uncertainty = estimate_stc_pmax_uncertainty(
            module_temp_c=module_temp_c,
            spec=spec,
            irradiance_uncertainty_pct=irradiance_uncertainty_pct,
            irradiance_change_pct=irradiance_change_pct,
            temp_change_k_per_min=temp_change_k_per_min,
            procedure_spread_pct=max(diffs) if diffs else None,
        )
        if uncertainty["expanded_pct"] > dead_band_pct:
            warnings.append(
                f"Estimated uncertainty of STC Pmax (±{uncertainty['expanded_pct']:.1f}%) is larger than the "
                f"±{dead_band_pct:.1f}% dead band used: a shortfall inside it is not significant"
            )

    quality_flags = list(gate["quality_flags"])
    # Forward vs reverse sweep: the same string should give the same Pmax in both directions.
    fwd_rev: Optional[Dict[str, Any]] = None
    p_meas = float(params_meas["p_max_w"])
    if reverse_pmax_w is not None and reverse_pmax_w > 0 and p_meas > 0:
        diff = abs(p_meas - reverse_pmax_w) / ((p_meas + reverse_pmax_w) / 2.0) * 100.0
        suspect = diff > MAX_FWD_REV_PMAX_DIFF_PCT
        fwd_rev = {
            "reverse_pmax_w": round(float(reverse_pmax_w), 2),
            "diff_pct": round(diff, 2),
            "limit_pct": MAX_FWD_REV_PMAX_DIFF_PCT,
            "limit_status": "proposed",
            "capacitance_suspect": suspect,
        }
        if suspect:
            if "capacitance_suspect" not in quality_flags:
                quality_flags.append("capacitance_suspect")
            warnings.append(
                f"Pmax of the two sweep directions differs by {diff:.1f}% (limit {MAX_FWD_REV_PMAX_DIFF_PCT:.0f}%): "
                "cell capacitance is distorting the curve, use a slower sweep"
            )

    # Equivalent cell temperature from Voc (the Procedure 2 Voc model solved for T). It is right
    # only when the string's Voc is healthy, so it is left out for stepped curves and Voc faults,
    # and it is never used to translate: that would hide a Voc fault.
    ect: Optional[Dict[str, Any]] = None
    voc_faults = ("bypass_diode_shorted", "miswiring_or_module_count", "steps_in_curve", "pid")
    b_rel = spec.temp_coeff_voc_pct / 100.0
    if gate["shape_gate_passed"] and classification["signature"] not in voc_faults and b_rel != 0:
        x = math.log(G_STC / irradiance_wm2)
        f_g = b2 * x * x + b1 * x + 1.0
        t_ect = T_STC + (float(params_meas["v_oc_v"]) / (n_mod * spec.voc_stc) - 1.0 / f_g) / (b_rel * f_g)
        if -40.0 <= t_ect <= 120.0:
            ect = {
                "t_c": round(t_ect, 1),
                "diff_vs_measured_k": round(t_ect - module_temp_c, 1),
                "basis": "datasheet_voc",
                "coefficients": b_source,
            }

    classification["shape_gate_passed"] = gate["shape_gate_passed"]
    classification["gate_warnings"] = warnings
    classification["quality_flags"] = quality_flags
    classification["forward_reverse"] = fwd_rev
    classification["equivalent_cell_temp"] = ect
    classification["uncertainty"] = uncertainty

    return {
        "conditions": {
            "swept_at": str(swept_at),
            "irradiance_wm2": round(float(irradiance_wm2), 1),
            "module_temp_c": round(float(module_temp_c), 1),
            "irradiance_change_pct": round(float(irradiance_change_pct), 2) if irradiance_change_pct is not None else None,
            "temp_change_k_per_min": temp_change_k_per_min,
            "sweep_time_ms": sweep_time_ms,
            "cell_technology": cell_technology,
            "irradiance_uncertainty_pct": irradiance_uncertainty_pct,
            "reverse_pmax_w": reverse_pmax_w,
            "sensor_misalignment_deg": sensor_misalignment_deg,
            **gate,
        },
        "iec60891": iec,
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
