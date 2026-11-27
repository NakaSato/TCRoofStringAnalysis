//! Live operating points of strings against the modelled string curve at the measured
//! conditions. Port of `backend/solar_core/iv_operating.py`.
//!
//! Growatt reports one operating point (V, I) per string per record, not a curve. This draws
//! the curve the string *should* be on at the plane-of-array irradiance G and module
//! temperature T_mod a weather sensor measured (single-diode model, De Soto 2006 translation
//! of the datasheet fit) and judges each live point against it. The curve is **modelled**; the
//! points are measured.

use crate::iv_analysis::numpy::{self, maximum, minimum, py_round, pymax};
use crate::iv_analysis::{fit_desoto, lambertw_pv, CurvePoint, ModuleStcSpec, G_STC, T_STC};
use serde::{Deserialize, Serialize};

/// Band gap of silicon at STC (eV).
pub const EG_REF_EV: f64 = 1.121;
/// Its temperature slope (De Soto 2006).
pub const DEG_DT: f64 = -0.0002677;
/// Boltzmann constant in eV/K.
pub const K_EV: f64 = 8.617333262e-5;

/// Port of `iv_operating._current` (one voltage): exact single-diode I(V), clipped at 0 A.
fn current(v: f64, i_l: f64, i_o: f64, r_s: f64, r_sh: f64, a: f64) -> f64 {
    let g_sh = 1.0 / pymax(1e-3, r_sh);
    let denom = 1.0 + r_s * g_sh;
    let arg_exp = (r_s * (i_l + i_o) + v) / (a * denom);
    let w = lambertw_pv((i_o * r_s / (a * denom)) * minimum(60.0, arg_exp).exp());
    maximum(0.0, (i_l + i_o - v * g_sh) / denom - (a / r_s) * w)
}

/// The result of [`string_curve_at`] (modelled).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StringCurve {
    pub modules: i64,
    pub points: Vec<CurvePoint>,
    pub v_oc_v: f64,
    pub i_sc_a: f64,
    pub v_mp_v: f64,
    pub i_mp_a: f64,
    pub p_mp_w: f64,
}

/// Port of `iv_operating.string_curve_at`: the modelled I-V / P-V curve of `modules` in series
/// at (G, T_mod) and its key points. None when G is missing or <= 0, T is missing, the module
/// count is below 1, or the light current is not positive.
pub fn string_curve_at(
    spec: &ModuleStcSpec,
    modules: i64,
    irradiance_wm2: Option<f64>,
    module_temp_c: Option<f64>,
    n_points: usize,
) -> Option<StringCurve> {
    if modules < 1 {
        return None;
    }
    let g = irradiance_wm2?;
    if g <= 0.0 {
        return None;
    }
    let t = module_temp_c?;
    let n = modules;
    let nf = n as f64;
    let rf = fit_desoto(
        nf * spec.vmp_stc,
        spec.imp_stc,
        nf * spec.voc_stc,
        spec.isc_stc,
        spec.alpha_a_per_k(),
        spec.beta_v_per_k(n),
        n * spec.cells_per_module,
    );
    let (tk, tk_ref) = (t + 273.15, T_STC + 273.15);
    let eg = EG_REF_EV * (1.0 + DEG_DT * (t - T_STC));
    let a = rf.a_ref_v * tk / tk_ref;
    let i_l = g / G_STC * (rf.i_l_ref_a + rf.alpha_sc_a_per_k * (t - T_STC));
    let i_o = rf.i_o_ref_a
        * (tk / tk_ref).powf(3.0)
        * (EG_REF_EV / (K_EV * tk_ref) - eg / (K_EV * tk)).exp();
    let r_s = rf.r_s_ohm;
    let r_sh = rf.r_sh_ref_ohm * G_STC / g;
    if i_l <= 0.0 {
        return None;
    }
    // Voc: bisection on I(V) = 0 between 0 and a generous upper bound
    let (mut lo, mut hi) = (0.0, nf * spec.voc_stc * 1.3);
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if current(mid, i_l, i_o, r_s, r_sh, a) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let v_oc = lo;
    let v = numpy::linspace(0.0, v_oc, n_points);
    let i: Vec<f64> = v
        .iter()
        .map(|&x| current(x, i_l, i_o, r_s, r_sh, a))
        .collect();
    // MPP on a fine grid (the drawn grid is coarse)
    let vf = numpy::linspace(0.0, v_oc, 2000);
    let pf: Vec<f64> = vf
        .iter()
        .map(|&x| x * current(x, i_l, i_o, r_s, r_sh, a))
        .collect();
    let k = numpy::argmax(&pf);
    Some(StringCurve {
        modules: n,
        points: crate::iv_analysis::curve_points(&v, &i, 1, 3, 1),
        v_oc_v: py_round(v_oc, 1),
        i_sc_a: py_round(current(0.0, i_l, i_o, r_s, r_sh, a), 3),
        v_mp_v: py_round(vf[k], 1),
        i_mp_a: py_round(if vf[k] > 0.0 { pf[k] / vf[k] } else { 0.0 }, 3),
        p_mp_w: py_round(pf[k], 1),
    })
}

/// The `gates` of the criteria file (`app/services/string_live_criteria.json`) that
/// [`judge_point`] reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JudgeCriteria {
    pub stale_s: f64,
    pub weather_max_gap_s: f64,
    pub irradiance_min_wm2: f64,
    pub sanity_current_max: f64,
    pub sanity_voltage_max: f64,
    pub off_mpp_voltage_ratio: f64,
}

/// The keyword-only arguments of `judge_point`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct JudgeOptions {
    pub inverter_status: Option<i64>,
    pub limited: bool,
    pub record_age_s: Option<f64>,
    pub weather_gap_s: Option<f64>,
}

/// The result of [`judge_point`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PointJudgement {
    pub r_imp: Option<f64>,
    pub r_v: Option<f64>,
    pub gates: Vec<&'static str>,
    pub diagnostic: bool,
}

/// Port of `iv_operating.judge_point`: `r_imp` = I ÷ Imp(model), `r_v` = V ÷ Vmp(model), and
/// the gates the point fails (in Python's order). Diagnostic only when no gate fails; no
/// ratio without a reading or a model.
pub fn judge_point(
    voltage_v: Option<f64>,
    current_a: Option<f64>,
    curve: Option<&StringCurve>,
    irradiance_wm2: Option<f64>,
    criteria: &JudgeCriteria,
    opts: &JudgeOptions,
) -> PointJudgement {
    let mut gates: Vec<&'static str> = Vec::new();
    let (Some(v), Some(i)) = (voltage_v, current_a) else {
        return PointJudgement {
            r_imp: None,
            r_v: None,
            gates: vec!["no_reading"],
            diagnostic: false,
        };
    };
    if opts.record_age_s.is_some_and(|age| age > criteria.stale_s) {
        gates.push("stale");
    }
    if opts.inverter_status.is_some_and(|s| s != 1) {
        gates.push("not_producing");
    }
    if opts.limited {
        gates.push("clipped_or_limited");
    }
    let Some(curve) = curve else {
        gates.push("no_model");
        return PointJudgement {
            r_imp: None,
            r_v: None,
            gates,
            diagnostic: false,
        };
    };
    if opts
        .weather_gap_s
        .is_some_and(|gap| gap > criteria.weather_max_gap_s)
    {
        gates.push("weather_not_aligned");
    }
    if irradiance_wm2.is_some_and(|g| g < criteria.irradiance_min_wm2) {
        gates.push("low_irradiance");
    }
    if i > criteria.sanity_current_max * curve.i_sc_a
        || v > criteria.sanity_voltage_max * curve.v_oc_v
        || v < 0.0
        || i < 0.0
    {
        gates.push("out_of_range");
    }
    // Python truthiness: 0.0 is false, NaN is true
    let r_v = if curve.v_mp_v != 0.0 {
        Some(v / curve.v_mp_v)
    } else {
        None
    };
    if r_v.is_some_and(|r| r > criteria.off_mpp_voltage_ratio) {
        gates.push("off_mpp");
    }
    let r_imp = if curve.i_mp_a != 0.0 {
        Some(i / curve.i_mp_a)
    } else {
        None
    };
    PointJudgement {
        r_imp: r_imp.map(|x| py_round(x, 3)),
        r_v: r_v.map(|x| py_round(x, 3)),
        diagnostic: gates.is_empty(),
        gates,
    }
}
