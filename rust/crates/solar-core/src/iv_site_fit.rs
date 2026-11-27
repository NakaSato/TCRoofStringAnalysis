//! Site coefficients from several I-V sweeps of one healthy string, and IEC 60891 Procedure 3.
//! Port of `backend/solar_core/iv_site_fit.py`.
//!
//! Everything is an estimate from the sweeps given: a value the sweeps cannot determine (too
//! few, too close in irradiance or temperature, best fit on the edge of the search range) is
//! `None` with a reason, never a default.

use crate::iv_analysis::numpy::{self, py_round};
use crate::iv_analysis::{
    extract_iv_parameters, rectify_iv_curve, translate_to_stc_iec60891, IvError, IvParameters,
    ModuleStcSpec, Procedure, TranslateOptions, G_STC, T_STC,
};
use serde::{Deserialize, Serialize};

pub const MIN_FIT_SWEEPS: usize = 3;
pub const MIN_IRRADIANCE_SPAN_WM2: f64 = 300.0;
pub const MIN_TEMP_SPAN_K: f64 = 10.0;

fn b1_grid() -> Vec<f64> {
    numpy::arange(0.0, 0.1501, 0.0005)
}

fn rs_grid_per_module() -> Vec<f64> {
    numpy::arange(0.0, 1.0001, 0.01)
}

fn kappa_grid_per_module() -> Vec<f64> {
    numpy::arange(0.0, 0.00501, 0.0001)
}

/// The result of [`interpolate_procedure_3`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Procedure3Curve {
    pub v: Vec<f64>,
    pub i: Vec<f64>,
    pub a: f64,
    pub g_wm2: f64,
    pub t_c: f64,
    pub extrapolated: bool,
    pub parameters: IvParameters,
}

/// Port of `iv_site_fit.interpolate_procedure_3`: IEC 60891 Procedure 3 between two measured
/// curves of the same device, `a` chosen so that G₃ is the target irradiance (T₃ follows).
#[allow(clippy::too_many_arguments)]
pub fn interpolate_procedure_3(
    v1: &[f64],
    i1: &[f64],
    g1: f64,
    t1: f64,
    v2: &[f64],
    i2: &[f64],
    g2: f64,
    t2: f64,
    target_irradiance_wm2: f64,
) -> Result<Procedure3Curve, IvError> {
    if (g2 - g1).abs() < 1.0 {
        return Err(IvError::Value(
            "Procedure 3 needs two curves at different irradiance".into(),
        ));
    }
    let (va, ia) = rectify_iv_curve(v1, i1, Some(4))?;
    let (vb, ib) = rectify_iv_curve(v2, i2, Some(4))?;
    let a = (target_irradiance_wm2 - g1) / (g2 - g1);
    let shift = ib[0] - ia[0];
    let want: Vec<f64> = ia.iter().map(|x| x + shift).collect();
    let ok: Vec<usize> = (0..want.len())
        .filter(|&k| want[k] >= 0.0 && want[k] <= ib[0])
        .collect();
    if ok.len() < 5 {
        return Err(IvError::Value(
            "The two curves overlap too little to interpolate".into(),
        ));
    }
    let ib_rev: Vec<f64> = ib.iter().rev().copied().collect();
    let vb_rev: Vec<f64> = vb.iter().rev().copied().collect();
    let want_ok: Vec<f64> = ok.iter().map(|&k| want[k]).collect();
    let v_pair = numpy::interp(&want_ok, &ib_rev, &vb_rev);
    let v3: Vec<f64> = ok
        .iter()
        .zip(&v_pair)
        .map(|(&k, vp)| va[k] + a * (vp - va[k]))
        .collect();
    let i3: Vec<f64> = ok
        .iter()
        .zip(&want_ok)
        .map(|(&k, w)| ia[k] + a * (w - ia[k]))
        .collect();
    let (v3c, i3c) = rectify_iv_curve(&v3, &i3, Some(4))?;
    let parameters = extract_iv_parameters(&v3c, &i3c)?;
    Ok(Procedure3Curve {
        v: v3c,
        i: i3c,
        a: py_round(a, 4),
        g_wm2: target_irradiance_wm2,
        t_c: py_round(t1 + a * (t2 - t1), 1),
        extrapolated: !(0.0..=1.0).contains(&a),
        parameters,
    })
}

/// Port of `iv_site_fit._spread_pct`: population std ÷ mean in %, inf when the mean is not > 0.
fn spread_pct(values: &[f64]) -> f64 {
    let mean = numpy::mean(values);
    if mean > 0.0 {
        numpy::std(values) / mean * 100.0
    } else {
        f64::INFINITY
    }
}

/// One sweep of the string: `{v, i, g, t}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SiteSweep {
    pub v: Vec<f64>,
    pub i: Vec<f64>,
    pub g: f64,
    pub t: f64,
}

/// The Voc-model fit.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VocFit {
    pub voc_stc_per_module_v: f64,
    pub datasheet_voc_stc_v: f64,
    pub beta_rel_pct_per_k: Option<f64>,
    pub datasheet_beta_rel_pct_per_k: f64,
    pub b1: Option<f64>,
    /// Never fitted (needs a wider irradiance range than field sweeps give).
    pub b2: Option<f64>,
    pub fit_rms_pct: f64,
}

/// The Rs / κ search.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResistanceFit {
    pub rs_ohm_per_module: Option<f64>,
    pub kappa_ohm_per_k_per_module: Option<f64>,
    pub pmax_spread_before_pct: f64,
    pub pmax_spread_after_pct: f64,
}

/// Procedure 3 between the lowest- and highest-irradiance sweeps.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Procedure3Summary {
    pub g_wm2: f64,
    pub t_c: f64,
    pub extrapolated: bool,
    pub p_max_w: f64,
    pub from_irradiance_wm2: [f64; 2],
}

/// The fit limits.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FitLimits {
    pub min_sweeps: usize,
    pub min_irradiance_span_wm2: f64,
    pub min_temp_span_k: f64,
}

/// The result of [`fit_site_coefficients`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SiteFit {
    pub sweeps: usize,
    pub irradiance_span_wm2: Option<f64>,
    pub temp_span_k: Option<f64>,
    pub voc: Option<VocFit>,
    pub resistance: Option<ResistanceFit>,
    pub procedure_3: Option<Procedure3Summary>,
    pub reasons: Vec<String>,
    pub limits: FitLimits,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// `np.corrcoef(a, b)[0, 1]` (NaN when either is constant).
fn corrcoef(a: &[f64], b: &[f64]) -> f64 {
    let (ma, mb) = (numpy::mean(a), numpy::mean(b));
    let da: Vec<f64> = a.iter().map(|x| x - ma).collect();
    let db: Vec<f64> = b.iter().map(|x| x - mb).collect();
    let n1 = a.len() as f64 - 1.0;
    let (caa, cbb, cab) = (dot(&da, &da) / n1, dot(&db, &db) / n1, dot(&da, &db) / n1);
    let r = cab / caa.sqrt() / cbb.sqrt();
    if r.is_nan() {
        r
    } else {
        r.clamp(-1.0, 1.0)
    }
}

/// Port of `iv_site_fit.fit_site_coefficients`: Voc at STC, β_rel and the Procedure 2 factor
/// B₁ from the open-circuit voltages; Rs and κ as the values that bring the sweeps' Procedure 2
/// STC Pmax closest together; Procedure 3 between the lowest and highest irradiance. α is not
/// fitted. Err when a sweep's parameters cannot be extracted (Python raises there too).
pub fn fit_site_coefficients(
    sweeps: &[SiteSweep],
    spec: &ModuleStcSpec,
    modules: i64,
) -> Result<SiteFit, IvError> {
    let n_mod = modules.max(1);
    let mut out = SiteFit {
        sweeps: sweeps.len(),
        irradiance_span_wm2: None,
        temp_span_k: None,
        voc: None,
        resistance: None,
        procedure_3: None,
        reasons: Vec::new(),
        limits: FitLimits {
            min_sweeps: MIN_FIT_SWEEPS,
            min_irradiance_span_wm2: MIN_IRRADIANCE_SPAN_WM2,
            min_temp_span_k: MIN_TEMP_SPAN_K,
        },
    };
    if sweeps.len() < 2 {
        out.reasons.push(
            "Needs at least 2 valid sweeps of this string (3 for the coefficient fit)".into(),
        );
        return Ok(out);
    }

    let g: Vec<f64> = sweeps.iter().map(|s| s.g).collect();
    let t: Vec<f64> = sweeps.iter().map(|s| s.t).collect();
    let mut voc: Vec<f64> = Vec::with_capacity(sweeps.len());
    for s in sweeps {
        voc.push(extract_iv_parameters(&s.v, &s.i)?.v_oc_v);
    }
    let g_span = numpy::amax(&g) - numpy::amin(&g);
    let t_span = numpy::amax(&t) - numpy::amin(&t);
    out.irradiance_span_wm2 = Some(py_round(g_span, 0));
    out.temp_span_k = Some(py_round(t_span, 1));
    let (g_ok, t_ok) = (g_span >= MIN_IRRADIANCE_SPAN_WM2, t_span >= MIN_TEMP_SPAN_K);

    let (lo, hi) = (numpy::argmin(&g), numpy::argmax(&g));
    if g[hi] - g[lo] >= 1.0 {
        let (a, b) = (&sweeps[lo], &sweeps[hi]);
        match interpolate_procedure_3(&a.v, &a.i, g[lo], t[lo], &b.v, &b.i, g[hi], t[hi], G_STC) {
            Ok(p3) => {
                out.procedure_3 = Some(Procedure3Summary {
                    g_wm2: p3.g_wm2,
                    t_c: p3.t_c,
                    extrapolated: p3.extrapolated,
                    p_max_w: p3.parameters.p_max_w,
                    from_irradiance_wm2: [py_round(g[lo], 0), py_round(g[hi], 0)],
                })
            }
            // `except ValueError` (numpy's LinAlgError is a ValueError too)
            Err(e) => out.reasons.push(format!("Procedure 3: {e}")),
        }
    }

    if sweeps.len() < MIN_FIT_SWEEPS {
        out.reasons.push(format!(
            "The coefficient fit needs at least {MIN_FIT_SWEEPS} sweeps"
        ));
        return Ok(out);
    }
    if !g_ok {
        out.reasons.push(format!(
            "Irradiance spans only {g_span:.0} W/m² (needs {MIN_IRRADIANCE_SPAN_WM2:.0}): B1 and Rs are not determined"
        ));
    }
    if !t_ok {
        out.reasons.push(format!(
            "Module temperature spans only {t_span:.1} K (needs {MIN_TEMP_SPAN_K:.0}): β and κ are not determined"
        ));
    }

    // Voc model: Voc = Voc_STC · [1/f(G) + β_rel · f(G) · (T − 25)],  f(G) = 1 + B1·ln(1000/G)
    let (b1_cur, b2_cur, _) = spec.p2_factors();
    let beta_ds = spec.temp_coeff_voc_pct / 100.0;
    let x: Vec<f64> = g.iter().map(|gg| (G_STC / gg).ln()).collect();
    let fit_beta = t_ok && sweeps.len() >= if g_ok { 4 } else { 3 };
    let grid = b1_grid();
    let mut voc_fit: Option<VocFit> = None;
    if g_ok || t_ok {
        let mut best: Option<(f64, f64, f64, f64)> = None;
        let candidates: Vec<f64> = if g_ok { grid.clone() } else { vec![b1_cur] };
        for b1 in candidates {
            let f: Vec<f64> = x
                .iter()
                .map(|xx| {
                    if !g_ok {
                        b2_cur * xx * xx + b1 * xx + 1.0
                    } else {
                        b1 * xx + 1.0
                    }
                })
                .collect();
            let c1: Vec<f64> = f.iter().map(|ff| 1.0 / ff).collect();
            let c2: Vec<f64> = f.iter().zip(&t).map(|(ff, tt)| ff * (tt - T_STC)).collect();
            let (v_ref, beta) = if fit_beta {
                let coef = numpy::lstsq(&[c1.clone(), c2.clone()], &voc, None)?;
                let beta = if coef[0] != 0.0 {
                    coef[1] / coef[0]
                } else {
                    f64::NAN
                };
                (coef[0], beta)
            } else {
                let basis: Vec<f64> = c1.iter().zip(&c2).map(|(a, b)| a + beta_ds * b).collect();
                (dot(&basis, &voc) / dot(&basis, &basis), beta_ds)
            };
            let sq: Vec<f64> = c1
                .iter()
                .zip(&c2)
                .zip(&voc)
                .map(|((a, b), vo)| {
                    let d = v_ref * (a + beta * b) - vo;
                    d * d
                })
                .collect();
            let rms = numpy::mean(&sq).sqrt();
            if rms.is_finite() && best.is_none_or(|b| rms < b.0) {
                best = Some((rms, b1, v_ref, beta));
            }
        }
        if let Some((rms, b1_fit, v_ref, beta)) = best {
            let b1_edge = g_ok && (b1_fit <= grid[0] || b1_fit >= grid[grid.len() - 1]);
            if b1_edge {
                out.reasons.push(
                    "B1: the best fit is on the edge of the search range, so it is not determined"
                        .into(),
                );
            }
            let fit = VocFit {
                voc_stc_per_module_v: py_round(v_ref / n_mod as f64, 2),
                datasheet_voc_stc_v: spec.voc_stc,
                beta_rel_pct_per_k: if fit_beta {
                    Some(py_round(beta * 100.0, 4))
                } else {
                    None
                },
                datasheet_beta_rel_pct_per_k: spec.temp_coeff_voc_pct,
                b1: if g_ok && !b1_edge {
                    Some(py_round(b1_fit, 4))
                } else {
                    None
                },
                b2: None,
                fit_rms_pct: py_round(rms / (if v_ref != 0.0 { v_ref } else { 1.0 }) * 100.0, 3),
            };
            voc_fit = Some(fit.clone());
            out.voc = Some(fit);
        }
    }

    // Rs and κ: the values that bring the sweeps' STC Pmax (Procedure 2) closest together
    let mut fitted = spec.clone();
    if let Some(vf) = &voc_fit {
        fitted.temp_coeff_voc_pct = vf.beta_rel_pct_per_k.unwrap_or(spec.temp_coeff_voc_pct);
        fitted.p2_b1 = vf.b1.or(spec.p2_b1);
    }
    let nf = n_mod as f64;
    let spread = |use_spec: &ModuleStcSpec, rs_mod: f64, kappa_mod: f64| -> Result<f64, IvError> {
        let mut pm = Vec::with_capacity(sweeps.len());
        for s in sweeps {
            let tr = translate_to_stc_iec60891(
                &s.v,
                &s.i,
                s.g,
                s.t,
                use_spec,
                &TranslateOptions {
                    modules: n_mod,
                    r_s_ohm: Some(rs_mod * nf),
                    kappa_ohm_per_k: Some(kappa_mod * nf),
                    procedure: Procedure::P2,
                    ..Default::default()
                },
            )?;
            pm.push(extract_iv_parameters(&tr.v_stc, &tr.i_stc)?.p_max_w);
        }
        Ok(spread_pct(&pm))
    };

    if g_ok || t_ok {
        // reasons added before a failure stay, as in Python
        let mut reasons: Vec<String> = Vec::new();
        let res = (|reasons: &mut Vec<String>| -> Result<ResistanceFit, IvError> {
            let before = spread(spec, spec.rs_ohm, spec.kappa_ohm_per_k)?;
            let mut rs_fit: Option<f64> = None;
            let mut kappa_fit: Option<f64> = None;
            let (mut rs_use, mut kappa_use) = (spec.rs_ohm, spec.kappa_ohm_per_k);
            if g_ok {
                let grid = rs_grid_per_module();
                let mut scores = Vec::with_capacity(grid.len());
                for &r in &grid {
                    scores.push(spread(&fitted, r, kappa_use)?);
                }
                let k = numpy::argmin(&scores);
                if 0 < k && k < scores.len() - 1 {
                    rs_use = py_round(grid[k], 3);
                    rs_fit = Some(rs_use);
                } else {
                    reasons.push("Rs: the best fit is on the edge of the search range, so it is not determined".into());
                }
            }
            if t_ok {
                let grid = kappa_grid_per_module();
                let mut scores = Vec::with_capacity(grid.len());
                for &kp in &grid {
                    scores.push(spread(&fitted, rs_use, kp)?);
                }
                let k = numpy::argmin(&scores);
                if 0 < k && k < scores.len() - 1 {
                    kappa_use = py_round(grid[k], 5);
                    kappa_fit = Some(kappa_use);
                } else {
                    reasons.push("κ: the best fit is on the edge of the search range, so it is not determined".into());
                }
            }
            if rs_fit.is_some() && kappa_fit.is_some() && corrcoef(&g, &t).abs() > 0.9 {
                reasons.push(
                    "Irradiance and temperature move together in these sweeps, so Rs and κ cannot be told apart reliably"
                        .into(),
                );
            }
            let after = spread(&fitted, rs_use, kappa_use)?;
            Ok(ResistanceFit {
                rs_ohm_per_module: rs_fit,
                kappa_ohm_per_k_per_module: kappa_fit,
                pmax_spread_before_pct: py_round(before, 2),
                pmax_spread_after_pct: py_round(after, 2),
            })
        })(&mut reasons);
        out.reasons.extend(reasons);
        match res {
            Ok(r) => out.resistance = Some(r),
            Err(e) => out
                .reasons
                .push(format!("Rs and κ: translation failed ({e})")),
        }
    }
    Ok(out)
}
