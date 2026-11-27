//! I-V curve analysis at string and module level. Port of `backend/solar_core/iv_analysis.py`.
//!
//! 1. Measurement-condition validation ([`validate_sweep_conditions`]): G, T and timestamp are
//!    mandatory; STC comparison needs G >= 700 W/m² and |ΔG| <= 2 %, curve shape G >= 400 W/m².
//! 2. Curve cleaning ([`rectify_iv_curve`], as `pvlib.ivtools.utils.rectify_iv_curve`).
//! 3. Translation to STC by IEC 60891 Procedures 1, 2, 4 and the dynamic procedure
//!    ([`translate_to_stc_iec60891`]).
//! 4. Single-diode fits ([`fit_sandia_simple`], [`fit_desoto`]) and the Lambert W curve
//!    ([`simulate_single_diode_curve`]).
//! 5. Parameters per curve ([`extract_iv_parameters`]).
//! 6. Fault-signature classification with a dead band ([`classify_iv_fault`]) and the full
//!    pipeline ([`analyze_iv_sweep`]).
//!
//! The NumPy routines the Python uses (`polyfit`, `lstsq`, `interp`, `gradient`, `linspace`,
//! `round`, `convolve`) are re-implemented in [`numpy`] with NumPy's semantics (index search,
//! min-norm least squares, NaN propagation of `np.maximum`), so results agree to rounding.

use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use std::fmt;

pub const G_STC: f64 = 1000.0;
pub const T_STC: f64 = 25.0;
pub const K_BOLTZMANN: f64 = 1.380649e-23;
pub const Q_ELECTRON: f64 = 1.602176634e-19;

pub const MIN_SWEEP_IRRADIANCE_WM2: f64 = 700.0;
pub const WARN_SWEEP_IRRADIANCE_WM2: f64 = 800.0;
pub const MIN_SHAPE_IRRADIANCE_WM2: f64 = 400.0;
pub const MAX_SWEEP_IRR_CHANGE_PCT: f64 = 2.0;
pub const WARN_SWEEP_IRR_CHANGE_PCT: f64 = 1.0;
pub const DEFAULT_DEAD_BAND_PCT: f64 = 5.0;
pub const SITE_REFERENCE_TEMP_C: f64 = 55.0;
pub const DEFAULT_P2_B1: f64 = 0.045;
pub const DEFAULT_P2_B2: f64 = 0.0;
pub const P2_DISAGREE_PCT: f64 = 1.0;
pub const DEFAULT_P4_EPSILON_V: f64 = 1.232;
pub const PDYN_RSH_NEGLECT_OHM_PER_MODULE: f64 = 100.0;
pub const PDYN_RSH_NEGLECTED_OHM: f64 = 1e5;
pub const MAX_TEMP_CHANGE_K_PER_MIN: f64 = 1.0;
pub const MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE: f64 = 100.0;
pub const HIGH_CAPACITANCE_TECH: [&str; 3] = ["topcon", "hjt", "ibc"];
pub const MAX_FWD_REV_PMAX_DIFF_PCT: f64 = 1.0;
pub const MAX_SENSOR_MISALIGNMENT_DEG: f64 = 2.0;
pub const WARN_SENSOR_MISALIGNMENT_DEG: f64 = 1.0;
pub const ASSUMED_IRRADIANCE_UNCERTAINTY_PCT: f64 = 2.5;
pub const ASSUMED_MODULE_TEMP_ERROR_K: f64 = 3.0;
pub const ASSUMED_TEMP_COEFF_UNCERTAINTY_FRAC: f64 = 0.10;
pub const ASSUMED_TRANSLATION_UNCERTAINTY_PCT: f64 = 1.0;
pub const DEFAULT_FIRST_YEAR_LID_PCT: f64 = 1.0;
pub const DEFAULT_ANNUAL_DEGRADATION_PCT: f64 = 0.45;
pub const DEFAULT_RS_PER_MODULE_OHM: f64 = 0.22;
pub const DEFAULT_KAPPA_PER_MODULE_OHM_K: f64 = 0.0012;

/// The Python exceptions of this module: `ValueError`, `numpy.linalg.LinAlgError` and
/// `csv.Error` (from `parse_iv_csv`). The message is Python's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IvError {
    Value(String),
    LinAlg(String),
    Csv(String),
}

impl IvError {
    /// The Python exception class name.
    pub fn kind(&self) -> &'static str {
        match self {
            IvError::Value(_) => "ValueError",
            IvError::LinAlg(_) => "LinAlgError",
            IvError::Csv(_) => "Error",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            IvError::Value(m) | IvError::LinAlg(m) | IvError::Csv(m) => m,
        }
    }
}

impl fmt::Display for IvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for IvError {}

fn value_err<T>(msg: &str) -> Result<T, IvError> {
    Err(IvError::Value(msg.to_string()))
}

// ---------------------------------------------------------------------------
// NumPy / Python numeric semantics
// ---------------------------------------------------------------------------

/// NumPy and Python numeric helpers with the exact semantics the Python code relies on.
/// Public only so the parity tests can compare them with NumPy directly.
#[doc(hidden)]
pub mod numpy {
    use super::IvError;

    /// Python's builtin `max(a, b)`: `b` only when `b > a` (so NaN in `b` gives `a`).
    pub fn pymax(a: f64, b: f64) -> f64 {
        if b > a {
            b
        } else {
            a
        }
    }

    /// Python's builtin `min(a, b)`: `b` only when `b < a`.
    pub fn pymin(a: f64, b: f64) -> f64 {
        if b < a {
            b
        } else {
            a
        }
    }

    /// `np.maximum(a, b)`: NaN propagates.
    pub fn maximum(a: f64, b: f64) -> f64 {
        if a.is_nan() || b.is_nan() {
            f64::NAN
        } else if b > a {
            b
        } else {
            a
        }
    }

    /// `np.minimum(a, b)`: NaN propagates.
    pub fn minimum(a: f64, b: f64) -> f64 {
        if a.is_nan() || b.is_nan() {
            f64::NAN
        } else if b < a {
            b
        } else {
            a
        }
    }

    /// Python's `round(x, ndigits)` for a float: correctly rounded, ties to even on the exact
    /// binary value (the same digits as `format!("{:.n$}")`).
    pub fn py_round(x: f64, ndigits: usize) -> f64 {
        if !x.is_finite() {
            return x;
        }
        format!("{x:.ndigits$}")
            .parse()
            .expect("formatted float parses")
    }

    /// NumPy's `np.round(x, decimals)`: `rint(x · 10^d) / 10^d`.
    pub fn np_round(x: f64, decimals: i32) -> f64 {
        let f = 10f64.powi(decimals);
        (x * f).round_ties_even() / f
    }

    /// `np.linspace(start, stop, num)` (endpoint included).
    pub fn linspace(start: f64, stop: f64, num: usize) -> Vec<f64> {
        let div = num as f64 - 1.0;
        let delta = stop - start;
        let mut y: Vec<f64> = (0..num).map(|k| k as f64).collect();
        if num > 1 {
            let step = delta / div;
            if step == 0.0 {
                for v in &mut y {
                    *v = *v / div * delta;
                }
            } else {
                for v in &mut y {
                    *v *= step;
                }
            }
        } else {
            for v in &mut y {
                *v *= delta;
            }
        }
        for v in &mut y {
            *v += start;
        }
        if num > 1 {
            y[num - 1] = stop;
        }
        y
    }

    /// `np.arange(start, stop, step)` for floats: `ceil((stop − start) / step)` values
    /// `start + k·(start + step − start)`.
    pub fn arange(start: f64, stop: f64, step: f64) -> Vec<f64> {
        let len = ((stop - start) / step).ceil();
        let len = if len > 0.0 { len as usize } else { 0 };
        let delta = (start + step) - start;
        (0..len)
            .map(|k| match k {
                0 => start,
                1 => start + step,
                _ => start + k as f64 * delta,
            })
            .collect()
    }

    const LIKELY_IN_CACHE_SIZE: usize = 8;

    /// NumPy's `binary_search_with_guess` (numpy/_core/src/multiarray/compiled_base.c).
    fn binary_search_with_guess(key: f64, arr: &[f64], guess: isize) -> isize {
        let len = arr.len();
        let mut imin: usize = 0;
        let mut imax: usize = len;
        if key > arr[len - 1] {
            return len as isize;
        } else if key < arr[0] {
            return -1;
        }
        if len <= 4 {
            let mut i = 1;
            while i < len && key >= arr[i] {
                i += 1;
            }
            return i as isize - 1;
        }
        let mut guess = guess;
        if guess > len as isize - 3 {
            guess = len as isize - 3;
        }
        if guess < 1 {
            guess = 1;
        }
        let g = guess as usize;
        if key < arr[g] {
            if key < arr[g - 1] {
                imax = g - 1;
                if g > LIKELY_IN_CACHE_SIZE && key >= arr[g - LIKELY_IN_CACHE_SIZE] {
                    imin = g - LIKELY_IN_CACHE_SIZE;
                }
            } else {
                return g as isize - 1;
            }
        } else if key < arr[g + 1] {
            return g as isize;
        } else if key < arr[g + 2] {
            return g as isize + 1;
        } else {
            imin = g + 2;
            if g + LIKELY_IN_CACHE_SIZE + 1 < len && key < arr[g + LIKELY_IN_CACHE_SIZE] {
                imax = g + LIKELY_IN_CACHE_SIZE;
            }
        }
        while imin < imax {
            let imid = imin + ((imax - imin) >> 1);
            if key >= arr[imid] {
                imin = imid + 1;
            } else {
                imax = imid;
            }
        }
        imin as isize - 1
    }

    /// `np.interp(x, xp, fp)`, NumPy's index search included (so a non-monotonic `xp` gives
    /// NumPy's answer). NumPy's C loop is compiled with a fused multiply-add on this platform;
    /// `mul_add` reproduces it bit for bit.
    pub fn interp(x: &[f64], xp: &[f64], fp: &[f64]) -> Vec<f64> {
        let n = xp.len();
        assert!(
            n > 0 && n == fp.len(),
            "interp needs matching, non-empty xp and fp"
        );
        let (lval, rval) = (fp[0], fp[n - 1]);
        if n == 1 {
            return x
                .iter()
                .map(|&xv| {
                    if xv.is_nan() {
                        xv
                    } else if xv < xp[0] {
                        lval
                    } else if xv > xp[0] {
                        rval
                    } else {
                        fp[0]
                    }
                })
                .collect();
        }
        let mut j: isize = 0;
        x.iter()
            .map(|&xv| {
                if xv.is_nan() {
                    return xv;
                }
                j = binary_search_with_guess(xv, xp, j);
                if j == -1 {
                    lval
                } else if j == n as isize {
                    rval
                } else if j == n as isize - 1 {
                    fp[j as usize]
                } else {
                    let k = j as usize;
                    if xp[k] == xv {
                        return fp[k];
                    }
                    let slope = (fp[k + 1] - fp[k]) / (xp[k + 1] - xp[k]);
                    let mut r = slope.mul_add(xv - xp[k], fp[k]);
                    if r.is_nan() {
                        r = slope.mul_add(xv - xp[k + 1], fp[k + 1]);
                        if r.is_nan() && fp[k] == fp[k + 1] {
                            r = fp[k];
                        }
                    }
                    r
                }
            })
            .collect()
    }

    /// `np.gradient(f, x)` with `edge_order=1` (scalar spacing when `diff(x)` is constant).
    pub fn gradient(f: &[f64], x: &[f64]) -> Vec<f64> {
        let n = f.len();
        assert!(
            n >= 2 && x.len() == n,
            "gradient needs >= 2 matching points"
        );
        let dx: Vec<f64> = x.windows(2).map(|w| w[1] - w[0]).collect();
        let uniform = dx.iter().all(|&d| d == dx[0]);
        let mut out = vec![0.0; n];
        if uniform {
            let h = dx[0];
            for k in 1..n - 1 {
                out[k] = (f[k + 1] - f[k - 1]) / (2.0 * h);
            }
            out[0] = (f[1] - f[0]) / h;
            out[n - 1] = (f[n - 1] - f[n - 2]) / h;
        } else {
            for k in 1..n - 1 {
                let (dx1, dx2) = (dx[k - 1], dx[k]);
                let a = -dx2 / (dx1 * (dx1 + dx2));
                let b = (dx2 - dx1) / (dx1 * dx2);
                let c = dx1 / (dx2 * (dx1 + dx2));
                out[k] = a * f[k - 1] + b * f[k] + c * f[k + 1];
            }
            out[0] = (f[1] - f[0]) / dx[0];
            out[n - 1] = (f[n - 1] - f[n - 2]) / dx[n - 2];
        }
        out
    }

    /// `np.convolve(a, kernel, mode="valid")` for a kernel no longer than `a`.
    pub fn convolve_valid(a: &[f64], kernel: &[f64]) -> Vec<f64> {
        let m = kernel.len();
        if a.len() < m {
            return Vec::new();
        }
        let rev: Vec<f64> = kernel.iter().rev().copied().collect();
        (0..=a.len() - m)
            .map(|k| {
                let mut s = 0.0;
                for (j, r) in rev.iter().enumerate() {
                    s += a[k + j] * r;
                }
                s
            })
            .collect()
    }

    /// NumPy's pairwise summation (`np.sum` / `mean` of a contiguous 1-D float array).
    pub fn pairwise_sum(a: &[f64]) -> f64 {
        let n = a.len();
        if n < 8 {
            let mut res = 0.0;
            for &x in a {
                res += x;
            }
            res
        } else if n <= 128 {
            let mut r = [0.0f64; 8];
            r.copy_from_slice(&a[..8]);
            let mut i = 8;
            while i < n - (n % 8) {
                for k in 0..8 {
                    r[k] += a[i + k];
                }
                i += 8;
            }
            let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
            while i < n {
                res += a[i];
                i += 1;
            }
            res
        } else {
            let mut n2 = n / 2;
            n2 -= n2 % 8;
            pairwise_sum(&a[..n2]) + pairwise_sum(&a[n2..])
        }
    }

    /// `np.mean`.
    pub fn mean(a: &[f64]) -> f64 {
        pairwise_sum(a) / a.len() as f64
    }

    /// `np.std` (population, ddof = 0).
    pub fn std(a: &[f64]) -> f64 {
        let m = mean(a);
        let sq: Vec<f64> = a
            .iter()
            .map(|&x| {
                let d = x - m;
                d * d
            })
            .collect();
        (pairwise_sum(&sq) / a.len() as f64).sqrt()
    }

    /// `np.argmax`: the first maximum, or the first NaN when there is one.
    pub fn argmax(a: &[f64]) -> usize {
        let mut best = 0;
        for (k, &x) in a.iter().enumerate() {
            if x.is_nan() {
                return k;
            }
            if x > a[best] {
                best = k;
            }
        }
        best
    }

    /// `np.argmin`: the first minimum, or the first NaN when there is one.
    pub fn argmin(a: &[f64]) -> usize {
        let mut best = 0;
        for (k, &x) in a.iter().enumerate() {
            if x.is_nan() {
                return k;
            }
            if x < a[best] {
                best = k;
            }
        }
        best
    }

    /// `np.max` (NaN propagates). Panics on an empty slice, as NumPy raises.
    pub fn amax(a: &[f64]) -> f64 {
        a[argmax(a)]
    }

    /// `np.min` (NaN propagates).
    pub fn amin(a: &[f64]) -> f64 {
        a[argmin(a)]
    }

    fn svd_error() -> IvError {
        IvError::LinAlg("SVD did not converge in Linear Least Squares".to_string())
    }

    fn dot(a: &[f64], b: &[f64]) -> f64 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    /// `np.linalg.lstsq(A, b, rcond)` for `A` given by its columns: the minimum-norm least
    /// squares solution, singular values `<= rcond · s_max` treated as zero (LAPACK `gelsd`
    /// semantics; here by a one-sided Jacobi SVD). `rcond = None` is NumPy's
    /// `eps · max(M, N)`. Non-finite input raises LinAlgError as LAPACK does; no rows gives zeros.
    pub fn lstsq(cols: &[Vec<f64>], b: &[f64], rcond: Option<f64>) -> Result<Vec<f64>, IvError> {
        let n = cols.len();
        let m = b.len();
        if cols.iter().any(|c| c.len() != m) {
            return Err(IvError::LinAlg("Incompatible dimensions".to_string()));
        }
        if cols
            .iter()
            .flatten()
            .chain(b.iter())
            .any(|x| !x.is_finite())
        {
            return Err(svd_error());
        }
        if m == 0 || n == 0 {
            return Ok(vec![0.0; n]);
        }
        let rcond = rcond.unwrap_or(f64::EPSILON * m.max(n) as f64);
        let mut u: Vec<Vec<f64>> = cols.to_vec();
        let mut v: Vec<Vec<f64>> = (0..n)
            .map(|j| (0..n).map(|k| if j == k { 1.0 } else { 0.0 }).collect())
            .collect();
        for _sweep in 0..80 {
            let mut rotated = false;
            for p in 0..n {
                for q in p + 1..n {
                    let alpha = dot(&u[p], &u[p]);
                    let beta = dot(&u[q], &u[q]);
                    let gamma = dot(&u[p], &u[q]);
                    if gamma == 0.0 || gamma.abs() <= f64::EPSILON * (alpha * beta).sqrt() {
                        continue;
                    }
                    rotated = true;
                    let zeta = (beta - alpha) / (2.0 * gamma);
                    let t = zeta.signum() / (zeta.abs() + 1.0f64.hypot(zeta));
                    let c = 1.0 / (1.0 + t * t).sqrt();
                    let s = c * t;
                    for k in 0..m {
                        let (up, uq) = (u[p][k], u[q][k]);
                        u[p][k] = c * up - s * uq;
                        u[q][k] = s * up + c * uq;
                    }
                    for k in 0..n {
                        let (vp, vq) = (v[p][k], v[q][k]);
                        v[p][k] = c * vp - s * vq;
                        v[q][k] = s * vp + c * vq;
                    }
                }
            }
            if !rotated {
                break;
            }
        }
        let sigma: Vec<f64> = u.iter().map(|c| dot(c, c).sqrt()).collect();
        let smax = sigma.iter().cloned().fold(0.0, f64::max);
        let cutoff = rcond * smax;
        let mut x = vec![0.0; n];
        for j in 0..n {
            if sigma[j] > cutoff && sigma[j] > 0.0 {
                let w = dot(&u[j], b) / (sigma[j] * sigma[j]);
                for k in 0..n {
                    x[k] += w * v[j][k];
                }
            }
        }
        Ok(x)
    }

    /// `np.polyfit(x, y, deg)`: coefficients, highest power first (columns scaled to unit
    /// norm, `rcond = len(x) · eps`, as NumPy).
    pub fn polyfit(x: &[f64], y: &[f64], deg: usize) -> Result<Vec<f64>, IvError> {
        if x.is_empty() {
            return Err(IvError::Value(
                "expected non-empty vector for x".to_string(),
            ));
        }
        let order = deg + 1;
        // vander(x, order): x^deg … x^0
        let mut cols: Vec<Vec<f64>> = Vec::with_capacity(order);
        let ones = vec![1.0; x.len()];
        let mut pows = vec![ones];
        for p in 1..order {
            let prev = &pows[p - 1];
            let next: Vec<f64> = prev.iter().zip(x).map(|(a, b)| a * b).collect();
            pows.push(next);
        }
        for p in (0..order).rev() {
            cols.push(pows[p].clone());
        }
        let scale: Vec<f64> = cols
            .iter()
            .map(|c| {
                let mut s = 0.0;
                for v in c {
                    s += v * v;
                }
                s.sqrt()
            })
            .collect();
        for (c, s) in cols.iter_mut().zip(&scale) {
            for v in c.iter_mut() {
                *v /= s;
            }
        }
        let c = lstsq(&cols, y, Some(x.len() as f64 * f64::EPSILON))?;
        Ok(c.iter().zip(&scale).map(|(c, s)| c / s).collect())
    }
}

use numpy::{maximum, minimum, py_round, pymax, pymin};

// ---------------------------------------------------------------------------
// Module specification
// ---------------------------------------------------------------------------

/// Port of `iv_analysis.ModuleStcSpec`: datasheet parameters at STC (1000 W/m², 25 °C) per
/// module, scaled by `modules` for a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModuleStcSpec {
    pub wp: f64,
    pub voc_stc: f64,
    pub isc_stc: f64,
    pub vmp_stc: f64,
    pub imp_stc: f64,
    /// Temperature coefficients in %/K.
    pub temp_coeff_pmax_pct: f64,
    pub temp_coeff_voc_pct: f64,
    pub temp_coeff_isc_pct: f64,
    /// IEC 60891 Procedure 1 series resistance and curve correction factor per module.
    pub rs_ohm: f64,
    pub kappa_ohm_per_k: f64,
    pub first_year_lid_pct: f64,
    pub annual_degradation_pct: f64,
    pub cells_per_module: i64,
    pub substrings_per_module: i64,
    /// IEC 60891 Procedure 2 irradiance factors measured for this module; None = assumed.
    pub p2_b1: Option<f64>,
    pub p2_b2: Option<f64>,
}

impl Default for ModuleStcSpec {
    fn default() -> Self {
        ModuleStcSpec {
            wp: 570.0,
            voc_stc: 51.10,
            isc_stc: 14.23,
            vmp_stc: 42.40,
            imp_stc: 13.45,
            temp_coeff_pmax_pct: -0.30,
            temp_coeff_voc_pct: -0.25,
            temp_coeff_isc_pct: 0.046,
            rs_ohm: DEFAULT_RS_PER_MODULE_OHM,
            kappa_ohm_per_k: DEFAULT_KAPPA_PER_MODULE_OHM_K,
            first_year_lid_pct: DEFAULT_FIRST_YEAR_LID_PCT,
            annual_degradation_pct: DEFAULT_ANNUAL_DEGRADATION_PCT,
            cells_per_module: 72,
            substrings_per_module: 3,
            p2_b1: None,
            p2_b2: None,
        }
    }
}

/// The keys `ModuleStcSpec.from_dict` reads; a missing or null key keeps the default.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ModuleSpecDict {
    pub wp: Option<f64>,
    pub voc_stc: Option<f64>,
    pub isc_stc: Option<f64>,
    pub vmp_stc: Option<f64>,
    pub imp_stc: Option<f64>,
    pub temp_coeff_pmax_pct: Option<f64>,
    pub temp_coeff_voc_pct: Option<f64>,
    pub temp_coeff_isc_pct: Option<f64>,
    pub rs_ohm: Option<f64>,
    pub kappa_ohm_per_k: Option<f64>,
    pub first_year_lid_pct: Option<f64>,
    pub annual_degradation_pct: Option<f64>,
    pub p2_b1: Option<f64>,
    pub p2_b2: Option<f64>,
}

impl ModuleStcSpec {
    /// Port of `ModuleStcSpec.p2_factors`: (B1, B2, source), the module's own factors
    /// (`fleet_setting`), else the typical ones (`assumed`).
    pub fn p2_factors(&self) -> (f64, f64, &'static str) {
        match self.p2_b1 {
            None => (DEFAULT_P2_B1, DEFAULT_P2_B2, "assumed"),
            Some(b1) => {
                // `float(self.p2_b2 or 0.0)`
                let b2 = self.p2_b2.unwrap_or(0.0);
                (b1, b2, "fleet_setting")
            }
        }
    }

    /// Port of `ModuleStcSpec.from_dict` (cells and substrings keep their defaults).
    pub fn from_dict(d: &ModuleSpecDict) -> ModuleStcSpec {
        let def = ModuleStcSpec::default();
        ModuleStcSpec {
            wp: d.wp.unwrap_or(def.wp),
            voc_stc: d.voc_stc.unwrap_or(def.voc_stc),
            isc_stc: d.isc_stc.unwrap_or(def.isc_stc),
            vmp_stc: d.vmp_stc.unwrap_or(def.vmp_stc),
            imp_stc: d.imp_stc.unwrap_or(def.imp_stc),
            temp_coeff_pmax_pct: d.temp_coeff_pmax_pct.unwrap_or(def.temp_coeff_pmax_pct),
            temp_coeff_voc_pct: d.temp_coeff_voc_pct.unwrap_or(def.temp_coeff_voc_pct),
            temp_coeff_isc_pct: d.temp_coeff_isc_pct.unwrap_or(def.temp_coeff_isc_pct),
            rs_ohm: d.rs_ohm.unwrap_or(def.rs_ohm),
            kappa_ohm_per_k: d.kappa_ohm_per_k.unwrap_or(def.kappa_ohm_per_k),
            first_year_lid_pct: d.first_year_lid_pct.unwrap_or(def.first_year_lid_pct),
            annual_degradation_pct: d
                .annual_degradation_pct
                .unwrap_or(def.annual_degradation_pct),
            p2_b1: d.p2_b1,
            p2_b2: d.p2_b2,
            ..def
        }
    }

    /// Port of `ModuleStcSpec.alpha_a_per_k`: current temperature coefficient α in A/K.
    pub fn alpha_a_per_k(&self) -> f64 {
        (self.temp_coeff_isc_pct / 100.0) * self.isc_stc
    }

    /// Port of `ModuleStcSpec.beta_v_per_k`: voltage temperature coefficient β in V/K for
    /// `modules` in series.
    pub fn beta_v_per_k(&self, modules: i64) -> f64 {
        (modules.max(1) as f64) * (self.temp_coeff_voc_pct / 100.0) * self.voc_stc
    }
}

// ---------------------------------------------------------------------------
// 1. Measurement conditions & CSV parsing
// ---------------------------------------------------------------------------

/// The arguments of `validate_sweep_conditions` (Python keyword defaults).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct SweepConditions {
    pub irradiance_wm2: Option<f64>,
    pub module_temp_c: Option<f64>,
    pub swept_at: Option<String>,
    pub irradiance_change_pct: Option<f64>,
    pub min_irradiance_wm2: f64,
    pub max_irradiance_change_pct: f64,
    pub temp_change_k_per_min: Option<f64>,
    pub sweep_time_ms: Option<f64>,
    pub cell_technology: Option<String>,
    pub sensor_misalignment_deg: Option<f64>,
}

impl Default for SweepConditions {
    fn default() -> Self {
        SweepConditions {
            irradiance_wm2: None,
            module_temp_c: None,
            swept_at: None,
            irradiance_change_pct: None,
            min_irradiance_wm2: MIN_SWEEP_IRRADIANCE_WM2,
            max_irradiance_change_pct: MAX_SWEEP_IRR_CHANGE_PCT,
            temp_change_k_per_min: None,
            sweep_time_ms: None,
            cell_technology: None,
            sensor_misalignment_deg: None,
        }
    }
}

/// The result of [`validate_sweep_conditions`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SweepGate {
    pub quality_gate_passed: bool,
    pub shape_gate_passed: bool,
    pub gate_reasons: Vec<String>,
    pub gate_warnings: Vec<String>,
    pub quality_flags: Vec<String>,
    pub min_irradiance_wm2: f64,
    pub max_irradiance_change_pct: f64,
}

/// Port of `iv_analysis.validate_sweep_conditions`. Err (ValueError) when G, T or the
/// timestamp is missing; else the STC gate, the shape gate, warnings and quality flags.
pub fn validate_sweep_conditions(c: &SweepConditions) -> Result<SweepGate, IvError> {
    let min_g = c.min_irradiance_wm2;
    let max_dg = c.max_irradiance_change_pct;
    let shape_min = pymin(MIN_SHAPE_IRRADIANCE_WM2, min_g);
    match &c.swept_at {
        None => {
            return value_err(
                "Sweep timestamp is required; a curve without its conditions cannot be interpreted",
            )
        }
        Some(s) if s.trim().is_empty() => {
            return value_err(
                "Sweep timestamp is required; a curve without its conditions cannot be interpreted",
            )
        }
        _ => {}
    }
    let g = match c.irradiance_wm2 {
        Some(g) if g.is_finite() && g > 0.0 => g,
        _ => {
            return value_err(
                "Valid plane-of-array irradiance G (W/m²) is required with every curve",
            )
        }
    };
    match c.module_temp_c {
        Some(t) if t.is_finite() && (-40.0..=120.0).contains(&t) => {}
        _ => {
            return value_err(
                "Valid back-of-module temperature T (°C) is required with every curve",
            )
        }
    }

    let mut reasons: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut flags: Vec<String> = Vec::new();
    let mut shape_ok = true;
    if g < min_g {
        flags.push("low_G".into());
    }
    if g < shape_min {
        shape_ok = false;
        reasons.push(format!(
            "Irradiance {g:.0} W/m² is below the {shape_min:.0} W/m² minimum for any diagnosis"
        ));
    } else if g < min_g {
        reasons.push(format!(
            "Irradiance {g:.0} W/m² is below the {min_g:.0} W/m² sweep gate for STC comparison (curve shape only)"
        ));
    } else if g < WARN_SWEEP_IRRADIANCE_WM2 {
        warnings.push(format!(
            "Irradiance {g:.0} W/m² is below the {WARN_SWEEP_IRRADIANCE_WM2:.0} W/m² best practice"
        ));
    }
    if let Some(dg) = c.irradiance_change_pct {
        let change = dg.abs();
        if change > max_dg {
            shape_ok = false;
            reasons.push(format!(
                "Irradiance changed by {change:.2}% during the sweep (limit {max_dg:.1}%)"
            ));
        } else if change > WARN_SWEEP_IRR_CHANGE_PCT {
            warnings.push(format!(
                "Irradiance changed by {change:.2}% during the sweep (best practice {WARN_SWEEP_IRR_CHANGE_PCT:.0}%)"
            ));
        }
        if change > WARN_SWEEP_IRR_CHANGE_PCT {
            flags.push("unstable_G".into());
        }
    }
    if let Some(dt) = c.temp_change_k_per_min {
        if dt.abs() > MAX_TEMP_CHANGE_K_PER_MIN {
            flags.push("unstable_T".into());
            warnings.push(format!(
                "Module temperature changed by {:.1} K in the minute before the sweep (best practice {MAX_TEMP_CHANGE_K_PER_MIN:.0} K)",
                dt.abs()
            ));
        }
    }
    if let Some(ms) = c.sweep_time_ms {
        if ms < MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE {
            let tech = c
                .cell_technology
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_lowercase();
            flags.push("capacitance_suspect".into());
            if HIGH_CAPACITANCE_TECH.contains(&tech.as_str()) {
                reasons.push(format!(
                    "Sweep of {ms:.0} ms is too fast for {} cells (minimum {MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE:.0} ms): power is unreliable (curve shape only)",
                    tech.to_uppercase()
                ));
            } else if tech.is_empty() {
                warnings.push(format!(
                    "Sweep of {ms:.0} ms is under {MIN_SWEEP_TIME_MS_HIGH_CAPACITANCE:.0} ms and the cell technology is not given: power is unreliable if the modules are TOPCon, HJT or IBC"
                ));
            } else if let Some(pos) = flags.iter().position(|f| f == "capacitance_suspect") {
                flags.remove(pos);
            }
        }
    }
    if let Some(mis) = c.sensor_misalignment_deg {
        let off = mis.abs();
        if off > MAX_SENSOR_MISALIGNMENT_DEG {
            flags.push("sensor_misaligned".into());
            warnings.push(format!(
                "Irradiance sensor is {off:.1}° off the array plane (IEC 60904-1 limit {MAX_SENSOR_MISALIGNMENT_DEG:.0}°): the irradiance reading, and so Isc and Pmax at STC, are less certain"
            ));
        } else if off > WARN_SENSOR_MISALIGNMENT_DEG {
            warnings.push(format!(
                "Irradiance sensor is {off:.1}° off the array plane (best practice {WARN_SENSOR_MISALIGNMENT_DEG:.0}°)"
            ));
        }
    }
    Ok(SweepGate {
        quality_gate_passed: reasons.is_empty(),
        shape_gate_passed: shape_ok,
        gate_reasons: reasons,
        gate_warnings: warnings,
        quality_flags: flags,
        min_irradiance_wm2: min_g,
        max_irradiance_change_pct: max_dg,
    })
}

/// One measured (V, I) point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct IvPoint {
    pub v: f64,
    pub i: f64,
}

/// Python's `csv.reader` (excel dialect) over `io.StringIO(content)`: records as lists of
/// fields. Lines end at `\n` only (StringIO); a `\r` inside an unquoted line raises csv.Error.
fn py_csv_rows(content: &str) -> Result<Vec<Vec<String>>, IvError> {
    #[derive(PartialEq, Clone, Copy)]
    enum St {
        StartRecord,
        StartField,
        InField,
        InQuoted,
        QuoteInQuoted,
        EatCrnl,
    }
    let mut rows = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut st = St::StartRecord;
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    for line in lines {
        // each char, then the end-of-line marker (None)
        for c in line.chars().map(Some).chain(std::iter::once(None)) {
            loop {
                match st {
                    St::StartRecord => match c {
                        None => {}
                        Some('\n') | Some('\r') => st = St::EatCrnl,
                        _ => {
                            st = St::StartField;
                            continue;
                        }
                    },
                    St::StartField => match c {
                        None | Some('\n') | Some('\r') => {
                            fields.push(std::mem::take(&mut field));
                            st = if c.is_none() { St::StartRecord } else { St::EatCrnl };
                        }
                        Some('"') => st = St::InQuoted,
                        Some(',') => fields.push(std::mem::take(&mut field)),
                        Some(ch) => {
                            field.push(ch);
                            st = St::InField;
                        }
                    },
                    St::InField => match c {
                        None | Some('\n') | Some('\r') => {
                            fields.push(std::mem::take(&mut field));
                            st = if c.is_none() { St::StartRecord } else { St::EatCrnl };
                        }
                        Some(',') => {
                            fields.push(std::mem::take(&mut field));
                            st = St::StartField;
                        }
                        Some(ch) => field.push(ch),
                    },
                    St::InQuoted => match c {
                        None => {}
                        Some('"') => st = St::QuoteInQuoted,
                        Some(ch) => field.push(ch),
                    },
                    St::QuoteInQuoted => match c {
                        Some('"') => {
                            field.push('"');
                            st = St::InQuoted;
                        }
                        Some(',') => {
                            fields.push(std::mem::take(&mut field));
                            st = St::StartField;
                        }
                        None | Some('\n') | Some('\r') => {
                            fields.push(std::mem::take(&mut field));
                            st = if c.is_none() { St::StartRecord } else { St::EatCrnl };
                        }
                        Some(ch) => {
                            field.push(ch);
                            st = St::InField;
                        }
                    },
                    St::EatCrnl => match c {
                        Some('\n') | Some('\r') => {}
                        None => st = St::StartRecord,
                        Some(_) => {
                            return Err(IvError::Csv(
                                "new-line character seen in unquoted field - do you need to open the file with newline=''?"
                                    .to_string(),
                            ))
                        }
                    },
                }
                break;
            }
        }
        if st == St::StartRecord {
            rows.push(std::mem::take(&mut fields));
        }
    }
    // end of data inside a quoted field (strict = False): the field is saved
    if !field.is_empty() || st == St::InQuoted {
        fields.push(std::mem::take(&mut field));
    }
    if !fields.is_empty() {
        rows.push(fields);
    }
    Ok(rows)
}

/// Python's `float(str)` for an already stripped string: decimal / exponent forms, `inf`,
/// `infinity`, `nan` (any case, signed) and `_` between digits. Unicode digits other than
/// ASCII are not accepted (Python accepts them).
fn py_float(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.contains('_') {
        let b = s.as_bytes();
        for (k, &ch) in b.iter().enumerate() {
            if ch == b'_'
                && !(k > 0
                    && k + 1 < b.len()
                    && b[k - 1].is_ascii_digit()
                    && b[k + 1].is_ascii_digit())
            {
                return None;
            }
        }
        return s.replace('_', "").parse().ok();
    }
    let body = s.trim_start_matches(['+', '-']);
    if s.len() - body.len() > 1 {
        return None;
    }
    let low = body.to_ascii_lowercase();
    if matches!(low.as_str(), "inf" | "infinity" | "nan") {
        return s.parse().ok().or(Some(f64::NAN));
    }
    if !body
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
    {
        return None;
    }
    s.parse().ok()
}

/// Port of `iv_analysis.parse_iv_csv`: (V, I) points from a handheld I-V tracer CSV (Seaward,
/// Fluke, Solmetric, Hioki, or plain V,I). Err (ValueError) with fewer than 5 valid points.
pub fn parse_iv_csv(content: &str) -> Result<Vec<IvPoint>, IvError> {
    let rows = py_csv_rows(content.trim())?;
    let mut points = Vec::new();
    let (mut v_col, mut i_col) = (0usize, 1usize);
    let mut header_found = false;
    const V_KEYS: [&str; 5] = ["volt", "v(", "v [", "v_v", "u(v)"];
    const V_KEYS2: [&str; 6] = ["volt", "v(", "v [", "v_v", "u(v)", "v"];
    const I_KEYS: [&str; 6] = ["curr", "amp", "i(", "i [", "i_a", "i"];
    for row in rows {
        if row.is_empty() || row.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let cells: Vec<String> = row.iter().map(|c| c.trim().to_string()).collect();
        if cells[0].starts_with('#') {
            continue;
        }
        let low: Vec<String> = cells.iter().map(|c| c.to_lowercase()).collect();
        if !header_found && low.iter().any(|c| V_KEYS.iter().any(|k| c.contains(k))) {
            if let Some(idx) = low
                .iter()
                .position(|c| V_KEYS2.iter().any(|k| c.contains(k)))
            {
                v_col = idx;
            }
            if let Some(idx) = low
                .iter()
                .enumerate()
                .position(|(idx, c)| idx != v_col && I_KEYS.iter().any(|k| c.contains(k)))
            {
                i_col = idx;
            }
            header_found = true;
            continue;
        }
        if cells.len() <= v_col.max(i_col) {
            continue;
        }
        let (Some(v), Some(i)) = (py_float(&cells[v_col]), py_float(&cells[i_col])) else {
            continue;
        };
        if v.is_finite() && i.is_finite() {
            points.push(IvPoint { v, i });
        }
    }
    if points.len() < 5 {
        return value_err("I-V curve requires at least 5 valid (V, I) points");
    }
    Ok(points)
}

// ---------------------------------------------------------------------------
// 2. Curve rectification
// ---------------------------------------------------------------------------

/// Port of `iv_analysis.rectify_iv_curve` (`decimals = 4` in Python's default; None = no
/// rounding): first quadrant and finite only, sorted by voltage with duplicate voltages
/// averaged, endpoints at V = 0 (Isc) and I = 0 (Voc) by linear extrapolation when missing; a
/// sweep past Voc ends at its first zero-current point.
///
/// Duplicate voltages are ordered by a stable sort (NumPy's quicksort is not stable), so an
/// average of duplicates may differ from Python in the last bit.
pub fn rectify_iv_curve(
    voltage: &[f64],
    current: &[f64],
    decimals: Option<i32>,
) -> Result<(Vec<f64>, Vec<f64>), IvError> {
    if voltage.len() != current.len() {
        return value_err("operands could not be broadcast together");
    }
    let mut pts: Vec<(f64, f64)> = voltage
        .iter()
        .zip(current)
        .filter(|(v, i)| v.is_finite() && i.is_finite() && **v >= 0.0 && **i >= 0.0)
        .map(|(v, i)| (*v, *i))
        .collect();
    if pts.len() < 4 {
        return value_err("Too few valid first-quadrant (V, I) points after filtering");
    }
    if let Some(d) = decimals {
        for p in &mut pts {
            p.0 = numpy::np_round(p.0, d);
        }
    }
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("finite voltages"));
    let n_before = pts.len();
    let mut v_arr: Vec<f64> = Vec::with_capacity(n_before);
    let mut sums: Vec<f64> = Vec::with_capacity(n_before);
    let mut counts: Vec<f64> = Vec::with_capacity(n_before);
    for &(v, i) in &pts {
        if let Some(last) = v_arr.last() {
            if *last == v {
                *sums.last_mut().unwrap() += i;
                *counts.last_mut().unwrap() += 1.0;
                continue;
            }
        }
        v_arr.push(v);
        sums.push(0.0 + i);
        counts.push(1.0);
    }
    let mut i_arr: Vec<f64> = if v_arr.len() < n_before {
        sums.iter().zip(&counts).map(|(s, c)| s / c).collect()
    } else {
        pts.iter().map(|p| p.1).collect()
    };
    if v_arr.len() < 4 {
        return value_err("Too few distinct voltage points in I-V curve");
    }

    // Extrapolate to V = 0 if needed
    if v_arr[0] > 0.0 {
        let n_head = 4.min(v_arr.len());
        let c = numpy::polyfit(&v_arr[..n_head], &i_arr[..n_head], 1)?;
        let i_sc = pymax(i_arr[0], c[1]);
        v_arr.insert(0, 0.0);
        i_arr.insert(0, i_sc);
    }

    // A sweep that runs past Voc ends in several points at I = 0; Voc is the first of them
    if let Some(last_pos) = i_arr.iter().rposition(|&x| x > 0.0) {
        if last_pos + 2 < i_arr.len() {
            v_arr.truncate(last_pos + 2);
            i_arr.truncate(last_pos + 2);
        }
    }

    // Extrapolate or clamp to I = 0 at Voc if needed
    let n = v_arr.len();
    if i_arr[n - 1] > 0.0 {
        let n_tail = 4.min(n);
        let c = numpy::polyfit(&i_arr[n - n_tail..], &v_arr[n - n_tail..], 1)?;
        let v_oc = pymax(v_arr[n - 1] * 1.001, c[1]);
        v_arr.push(v_oc);
        i_arr.push(0.0);
    } else {
        i_arr[n - 1] = 0.0;
    }
    Ok((v_arr, i_arr))
}

// ---------------------------------------------------------------------------
// 3. Parameter extraction
// ---------------------------------------------------------------------------

/// Port of `iv_analysis._count_curve_steps`: bypass-diode steps or notches in a rectified
/// curve (several P(V) peaks, or a steep-then-flat knee in dI/dV mid-curve).
fn count_curve_steps(v: &[f64], i: &[f64]) -> i64 {
    if v.len() < 8 {
        return 0;
    }
    let v_max = v[v.len() - 1];
    if v_max <= 0.0 {
        return 0;
    }
    let grid_n = 80.min(25.max(v.len()));
    let vg = numpy::linspace(0.05 * v_max, 0.95 * v_max, grid_n);
    let ig = numpy::interp(&vg, v, i);
    let pg: Vec<f64> = vg.iter().zip(&ig).map(|(a, b)| a * b).collect();
    let kernel = [0.25, 0.5, 0.25];
    let pg_s = numpy::convolve_valid(&pg, &kernel);
    let p_max = if pg_s.is_empty() {
        0.0
    } else {
        numpy::amax(&pg_s)
    };
    if p_max <= 0.0 {
        return 0;
    }

    let mut peaks: Vec<usize> = Vec::new();
    for k in 1..pg_s.len().saturating_sub(1) {
        if pg_s[k] >= pg_s[k - 1] && pg_s[k] >= pg_s[k + 1] && pg_s[k] > 0.15 * p_max {
            match peaks.last().copied() {
                None => peaks.push(k),
                Some(last) => {
                    let valley = numpy::amin(&pg_s[last..k + 1]);
                    if pymin(pg_s[last], pg_s[k]) - valley >= 0.012 * p_max {
                        peaks.push(k);
                    } else if pg_s[k] > pg_s[last] {
                        *peaks.last_mut().unwrap() = k;
                    }
                }
            }
        }
    }
    let multi_peak_steps = peaks.len().saturating_sub(1) as i64;

    let di_dv = numpy::gradient(&ig, &vg);
    let di_s = numpy::convolve_valid(&di_dv, &kernel);
    let v_oc = v_max;
    let i_sc = if i[0] > 0.0 { i[0] } else { 1.0 };
    let factor = v_oc / i_sc;
    let norm_slope: Vec<f64> = di_s.iter().map(|d| -d * factor).collect();
    let mut slope_peaks = 0i64;
    let limit_idx = (0.82 * norm_slope.len() as f64) as usize;
    let end = 1.max(limit_idx as isize - 1) as usize;
    for k in 1..end {
        if norm_slope[k] > norm_slope[k - 1]
            && norm_slope[k] > norm_slope[k + 1]
            && norm_slope[k] > 0.45
        {
            let hi = (limit_idx + 1).min(norm_slope.len());
            let after_min = numpy::amin(&norm_slope[k + 1..hi]);
            if norm_slope[k] - after_min > 0.30 {
                slope_peaks += 1;
            }
        }
    }
    multi_peak_steps.max(slope_peaks)
}

/// The result of [`extract_iv_parameters`] (rounded as in Python).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IvParameters {
    pub i_sc_a: f64,
    pub v_oc_v: f64,
    pub i_mp_a: f64,
    pub v_mp_v: f64,
    pub p_max_w: f64,
    pub fill_factor: f64,
    pub slope_voc_ohm: f64,
    pub slope_isc_ohm: f64,
    pub steps_count: i64,
}

/// Port of `iv_analysis.extract_iv_parameters`: Isc, Voc, Imp, Vmp, Pmax (quadratic refinement
/// around the discrete MPP), FF, −dV/dI near Voc (Rs indicator) and near Isc (Rsh indicator),
/// and the step count.
pub fn extract_iv_parameters(voltage: &[f64], current: &[f64]) -> Result<IvParameters, IvError> {
    let (v, i) = rectify_iv_curve(voltage, current, Some(4))?;
    let n = v.len();
    let i_sc = i[0];
    let v_oc = v[n - 1];
    let p: Vec<f64> = v.iter().zip(&i).map(|(a, b)| a * b).collect();

    let idx_mp = numpy::argmax(&p);
    let mut v_mp = v[idx_mp];
    let mut i_mp = i[idx_mp];
    let mut p_max = p[idx_mp];
    if 0 < idx_mp && idx_mp < n - 1 {
        let v_sub = &v[idx_mp - 1..idx_mp + 2];
        let p_sub = &p[idx_mp - 1..idx_mp + 2];
        let distinct = v_sub[0] != v_sub[1] && v_sub[1] != v_sub[2] && v_sub[0] != v_sub[2];
        if distinct {
            let c = numpy::polyfit(v_sub, p_sub, 2)?;
            let (a, b) = (c[0], c[1]);
            if a < 0.0 {
                let v_vertex = -b / (2.0 * a);
                if v_sub[0] <= v_vertex && v_vertex <= v_sub[2] {
                    v_mp = v_vertex;
                    i_mp = numpy::interp(&[v_mp], &v, &i)[0];
                    p_max = v_mp * i_mp;
                }
            }
        }
    }

    let ff = if i_sc > 0.0 && v_oc > 0.0 {
        p_max / (i_sc * v_oc)
    } else {
        0.0
    };

    // Slope near Voc: -dV/dI over [0.85·Voc, Voc]
    let mut voc_idx: Vec<usize> = (0..n).filter(|&k| v[k] >= 0.85 * v_oc).collect();
    if voc_idx.len() < 3 {
        voc_idx = (n.saturating_sub(4)..n).collect();
    }
    let iv: Vec<f64> = voc_idx.iter().map(|&k| i[k]).collect();
    let vv: Vec<f64> = voc_idx.iter().map(|&k| v[k]).collect();
    let dv_di_voc = numpy::polyfit(&iv, &vv, 1)?[0];
    let slope_voc_ohm = pymax(0.001, -dv_di_voc);

    // Slope near Isc: -dV/dI over [0, 0.25·Voc]
    let mut isc_idx: Vec<usize> = (0..n).filter(|&k| v[k] <= 0.25 * v_oc).collect();
    if isc_idx.len() < 3 {
        isc_idx = (0..n.min(4)).collect();
    }
    let vi: Vec<f64> = isc_idx.iter().map(|&k| v[k]).collect();
    let ii: Vec<f64> = isc_idx.iter().map(|&k| i[k]).collect();
    let di_dv_isc = numpy::polyfit(&vi, &ii, 1)?[0];
    let neg_di_dv = pymax(1e-5, -di_dv_isc);
    let slope_isc_ohm = pymin(1e6, 1.0 / neg_di_dv);

    let steps = count_curve_steps(&v, &i);
    Ok(IvParameters {
        i_sc_a: py_round(i_sc, 3),
        v_oc_v: py_round(v_oc, 2),
        i_mp_a: py_round(i_mp, 3),
        v_mp_v: py_round(v_mp, 2),
        p_max_w: py_round(p_max, 2),
        fill_factor: py_round(ff, 4),
        slope_voc_ohm: py_round(slope_voc_ohm, 4),
        slope_isc_ohm: py_round(slope_isc_ohm, 1),
        steps_count: steps,
    })
}

// ---------------------------------------------------------------------------
// 4. Single-diode fitting
// ---------------------------------------------------------------------------

/// Port of `iv_analysis.lambertw_pv` (one value): principal branch W₀(x) for x >= 0 by
/// Halley's method (6 iterations); negative x is taken as 0, NaN stays NaN.
pub fn lambertw_pv(x: f64) -> f64 {
    let arr = maximum(0.0, x);
    let e = std::f64::consts::E;
    let mut w = if arr < e {
        arr.ln_1p()
    } else {
        maximum(arr, 1.0).ln() - maximum(maximum(arr, e).ln(), 1.0).ln()
    };
    for _ in 0..6 {
        let ew = w.exp();
        let wew = w * ew;
        let f = wew - arr;
        let denom = ew * (w + 1.0) - (w + 2.0) * f / (2.0 * w + 2.0);
        let d = if denom.abs() > 1e-30 { denom } else { 1.0 };
        w -= f / d;
    }
    maximum(0.0, w)
}

/// The result of [`fit_sandia_simple`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SandiaFit {
    pub i_l_a: f64,
    pub i_o_a: f64,
    pub r_s_ohm: f64,
    pub r_sh_ohm: f64,
    pub n_ns_vth_v: f64,
}

/// Port of `iv_analysis.fit_sandia_simple`: the single-diode equation fitted by Sandia's
/// linear regressions (Rsh near V = 0, the diode knee by least squares, Rs bounded by the
/// slope near Voc). `v_oc` / `i_sc` override the curve's own values.
pub fn fit_sandia_simple(
    voltage: &[f64],
    current: &[f64],
    v_oc: Option<f64>,
    i_sc: Option<f64>,
) -> Result<SandiaFit, IvError> {
    let (v, i) = rectify_iv_curve(voltage, current, Some(4))?;
    let n = v.len();
    let voc = v_oc.unwrap_or(v[n - 1]);
    let isc = i_sc.unwrap_or(i[0]);

    let m1: Vec<usize> = (0..n).filter(|&k| v[k] <= 0.25 * voc).collect();
    let g_p = if m1.len() >= 3 {
        let x: Vec<f64> = m1.iter().map(|&k| v[k]).collect();
        let y: Vec<f64> = m1.iter().map(|&k| i[k]).collect();
        let slope1 = numpy::polyfit(&x, &y, 1)?[0];
        pymax(1e-5, -slope1)
    } else {
        1e-3
    };
    let r_sh = 1.0 / g_p;

    let mut knee: Vec<usize> = (0..n)
        .filter(|&k| v[k] >= 0.55 * voc && v[k] <= 0.96 * voc && i[k] > 0.02 * isc)
        .collect();
    if knee.len() < 4 {
        knee = (0..n)
            .filter(|&k| v[k] > 0.3 * voc && i[k] > 0.01 * isc)
            .collect();
    }
    let vk: Vec<f64> = knee.iter().map(|&k| v[k]).collect();
    let ik: Vec<f64> = knee.iter().map(|&k| i[k]).collect();
    let y: Vec<f64> = vk
        .iter()
        .zip(&ik)
        .map(|(vv, ii)| maximum(1e-6, isc - ii - vv / r_sh).ln())
        .collect();
    let cols = vec![vec![1.0; vk.len()], vk.clone(), ik.clone()];
    let coeffs = numpy::lstsq(&cols, &y, None)?;
    let (c1, c2) = (coeffs[1], coeffs[2]);

    let mut a = 1.0 / pymax(0.1, c1);
    a = pymin(pymax(a, 0.025 * voc), 0.15 * voc);
    let mut r_s = pymax(0.005, c2 * a);
    let voc_idx: Vec<usize> = (0..n).filter(|&k| v[k] >= 0.85 * voc).collect();
    if voc_idx.len() >= 2 {
        let x: Vec<f64> = voc_idx.iter().map(|&k| i[k]).collect();
        let yv: Vec<f64> = voc_idx.iter().map(|&k| v[k]).collect();
        let dv_di = numpy::polyfit(&x, &yv, 1)?[0];
        r_s = pymin(r_s, pymax(0.01, 0.75 * -dv_di));
    }
    let i_l = isc * (1.0 + r_s / r_sh);
    let i_o = pymax(1e-14, (i_l - voc / r_sh) * (-voc / a).exp());
    Ok(SandiaFit {
        i_l_a: py_round(i_l, 4),
        i_o_a: i_o,
        r_s_ohm: py_round(r_s, 4),
        r_sh_ohm: py_round(r_sh, 2),
        n_ns_vth_v: py_round(a, 4),
    })
}

/// The result of [`fit_desoto`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesotoFit {
    pub i_l_ref_a: f64,
    pub i_o_ref_a: f64,
    pub r_s_ohm: f64,
    pub r_sh_ref_ohm: f64,
    pub a_ref_v: f64,
    pub alpha_sc_a_per_k: f64,
    pub beta_oc_v_per_k: f64,
}

/// Port of `iv_analysis.fit_desoto`: single-diode parameters at STC from datasheet keypoints
/// (De Soto 2006; Rs adjusted so the curve passes through the MPP).
pub fn fit_desoto(
    v_mp: f64,
    i_mp: f64,
    v_oc: f64,
    i_sc: f64,
    alpha_sc_a_per_k: f64,
    beta_oc_v_per_k: f64,
    n_cells_series: i64,
) -> DesotoFit {
    let v_th = K_BOLTZMANN * (T_STC + 273.15) / Q_ELECTRON;
    let a_init = 1.05 * n_cells_series as f64 * v_th;
    let r_s_max = pymax(
        0.01,
        (v_oc - v_mp) / pymax(0.1, i_mp) - a_init / pymax(0.1, i_mp),
    );
    let mut r_s = 0.45 * r_s_max;
    let r_sh = pymax(50.0, v_mp / pymax(0.05, i_sc - i_mp) * 4.0);
    let a = a_init;
    for _ in 0..12 {
        let i_l = i_sc * (1.0 + r_s / r_sh);
        let i_o = pymax(1e-14, (i_l - v_oc / r_sh) * (-v_oc / a).exp());
        let arg_mp = (v_mp + i_mp * r_s) / a;
        let e = pymin(50.0, arg_mp).exp();
        let i_calc = i_l - i_o * (e - 1.0) - (v_mp + i_mp * r_s) / r_sh;
        let err = i_calc - i_mp;
        let d_i_d_rs = -(i_o * (i_mp / a) * e + i_mp / r_sh);
        if d_i_d_rs.abs() > 1e-9 {
            r_s = pymin(r_s_max, pymax(0.005, r_s - 0.5 * err / d_i_d_rs));
        }
    }
    let i_l = i_sc * (1.0 + r_s / r_sh);
    let i_o = pymax(1e-14, (i_l - v_oc / r_sh) * (-v_oc / a).exp());
    DesotoFit {
        i_l_ref_a: py_round(i_l, 4),
        i_o_ref_a: i_o,
        r_s_ohm: py_round(r_s, 4),
        r_sh_ref_ohm: py_round(r_sh, 2),
        a_ref_v: py_round(a, 4),
        alpha_sc_a_per_k: py_round(alpha_sc_a_per_k, 5),
        beta_oc_v_per_k: py_round(beta_oc_v_per_k, 5),
    }
}

/// One point of a drawn curve (V, I, P rounded as in Python).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CurvePoint {
    pub v: f64,
    pub i: f64,
    pub p: f64,
}

pub(crate) fn curve_points(
    v: &[f64],
    i: &[f64],
    dv: usize,
    di: usize,
    dp: usize,
) -> Vec<CurvePoint> {
    v.iter()
        .zip(i)
        .map(|(&vv, &ii)| CurvePoint {
            v: py_round(vv, dv),
            i: py_round(ii, di),
            p: py_round(vv * ii, dp),
        })
        .collect()
}

/// Port of `iv_analysis.simulate_single_diode_curve`: I(V) across 0..Voc by the exact Lambert
/// W solution of the single-diode model, clipped at 0 A.
pub fn simulate_single_diode_curve(
    i_l: f64,
    i_o: f64,
    r_s: f64,
    r_sh: f64,
    n_ns_vth: f64,
    v_oc: f64,
    n_points: usize,
) -> Vec<CurvePoint> {
    let v = numpy::linspace(0.0, pymax(0.1, v_oc), n_points);
    let g_sh = 1.0 / pymax(1e-3, r_sh);
    let i: Vec<f64> = v
        .iter()
        .map(|&vv| {
            let cur = if r_s <= 1e-6 {
                i_l - i_o * (minimum(60.0, vv / n_ns_vth).exp() - 1.0) - vv * g_sh
            } else {
                let denom = 1.0 + r_s * g_sh;
                let arg_exp = (r_s * (i_l + i_o) + vv) / (n_ns_vth * denom);
                let arg_w = (i_o * r_s / (n_ns_vth * denom)) * minimum(60.0, arg_exp).exp();
                let w = lambertw_pv(arg_w);
                (i_l + i_o - vv * g_sh) / denom - (n_ns_vth / r_s) * w
            };
            maximum(0.0, cur)
        })
        .collect();
    curve_points(&v, &i, 2, 3, 2)
}

// ---------------------------------------------------------------------------
// 5. IEC 60891 translation
// ---------------------------------------------------------------------------

/// The `procedure` argument of `translate_to_stc_iec60891`: 1, 2, 4 or `"dynamic"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Procedure {
    #[default]
    P1,
    P2,
    P4,
    Dynamic,
}

impl Procedure {
    /// Python's check `procedure not in (1, 2, 4, "dynamic")` for an integer.
    pub fn from_int(p: i64) -> Result<Procedure, IvError> {
        match p {
            1 => Ok(Procedure::P1),
            2 => Ok(Procedure::P2),
            4 => Ok(Procedure::P4),
            _ => value_err("procedure must be 1, 2, 4 or 'dynamic'"),
        }
    }
}

impl Serialize for Procedure {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Procedure::P1 => s.serialize_i64(1),
            Procedure::P2 => s.serialize_i64(2),
            Procedure::P4 => s.serialize_i64(4),
            Procedure::Dynamic => s.serialize_str("dynamic"),
        }
    }
}

impl<'de> Deserialize<'de> for Procedure {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Int(i64),
            Str(String),
        }
        match Raw::deserialize(d)? {
            Raw::Int(p) => Procedure::from_int(p).map_err(de::Error::custom),
            Raw::Str(s) if s == "dynamic" => Ok(Procedure::Dynamic),
            Raw::Str(_) => Err(de::Error::custom("procedure must be 1, 2, 4 or 'dynamic'")),
        }
    }
}

/// The keyword arguments of `translate_to_stc_iec60891` (Python defaults).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct TranslateOptions {
    pub modules: i64,
    pub r_s_ohm: Option<f64>,
    pub kappa_ohm_per_k: Option<f64>,
    pub target_irradiance_wm2: f64,
    pub target_temp_c: f64,
    pub procedure: Procedure,
    pub b1: Option<f64>,
    pub b2: Option<f64>,
    pub r_sh_ohm: Option<f64>,
    pub epsilon_v: f64,
}

impl Default for TranslateOptions {
    fn default() -> Self {
        TranslateOptions {
            modules: 1,
            r_s_ohm: None,
            kappa_ohm_per_k: None,
            target_irradiance_wm2: G_STC,
            target_temp_c: T_STC,
            procedure: Procedure::P1,
            b1: None,
            b2: None,
            r_sh_ohm: None,
            epsilon_v: DEFAULT_P4_EPSILON_V,
        }
    }
}

/// The `iec60891` block of a translation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Iec60891Info {
    pub procedure: Procedure,
    pub g1_wm2: f64,
    pub t1_c: f64,
    pub g2_wm2: f64,
    pub t2_c: f64,
    pub alpha_a_per_k: f64,
    pub beta_v_per_k: f64,
    pub r_s_ohm: f64,
    pub kappa_ohm_per_k: f64,
    /// Only for the dynamic procedure (the key is absent otherwise).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r_sh_ohm: Option<f64>,
}

/// The result of [`translate_to_stc_iec60891`]: the curve at the target (`*_stc`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StcTranslation {
    pub v_stc: Vec<f64>,
    pub i_stc: Vec<f64>,
    pub points_stc: Vec<CurvePoint>,
    pub points_measured: Vec<CurvePoint>,
    pub iec60891: Iec60891Info,
}

/// Port of `iv_analysis.translate_to_stc_iec60891`: a measured (V₁, I₁) curve at (G₁, T₁)
/// translated to (G₂, T₂) (default STC) by IEC 60891 Procedure 1, 2, 4 or the dynamic
/// procedure (Li et al. 2024). Rs (and Rsh for the dynamic procedure) come from the options,
/// else a Sandia fit of the measured curve, else the module defaults × modules.
pub fn translate_to_stc_iec60891(
    voltage: &[f64],
    current: &[f64],
    irradiance_wm2: f64,
    module_temp_c: f64,
    spec: &ModuleStcSpec,
    opts: &TranslateOptions,
) -> Result<StcTranslation, IvError> {
    let procedure = opts.procedure;
    let (mut b1, mut b2) = (opts.b1, opts.b2);
    if b1.is_none() {
        let (sb1, sb2, _) = spec.p2_factors();
        b1 = Some(sb1);
        if b2.is_none() {
            b2 = Some(sb2);
        }
    }
    let b1 = b1.expect("set above");
    let b2 = b2.unwrap_or(0.0);
    if irradiance_wm2 <= 0.0 {
        return value_err("irradiance_wm2 must be positive for IEC 60891 translation");
    }
    let n_mod = opts.modules.max(1);
    let (v1, i1) = rectify_iv_curve(voltage, current, Some(4))?;
    let i_sc1 = i1[0];

    let alpha = spec.alpha_a_per_k();
    let beta = spec.beta_v_per_k(n_mod);
    let mut sde: Option<SandiaFit> = None;
    if opts.r_s_ohm.is_none() || (procedure == Procedure::Dynamic && opts.r_sh_ohm.is_none()) {
        sde = fit_sandia_simple(&v1, &i1, None, None).ok();
    }
    let r_s = match opts.r_s_ohm {
        Some(r) => r,
        None => match &sde {
            Some(s) => s.r_s_ohm,
            None => spec.rs_ohm * n_mod as f64,
        },
    };
    let mut r_sh: Option<f64> = None;
    if procedure == Procedure::Dynamic {
        let mut r = match (opts.r_sh_ohm, &sde) {
            (Some(r), _) => r,
            (None, Some(s)) => s.r_sh_ohm,
            (None, None) => {
                return value_err(
                    "The dynamic procedure needs a shunt resistance from the measured curve",
                )
            }
        };
        if r > PDYN_RSH_NEGLECT_OHM_PER_MODULE * n_mod as f64 {
            r = PDYN_RSH_NEGLECTED_OHM;
        }
        r_sh = Some(r);
    }
    let kappa = opts
        .kappa_ohm_per_k
        .unwrap_or(spec.kappa_ohm_per_k * n_mod as f64);

    let (g1, t1) = (irradiance_wm2, module_temp_c);
    let (g2, t2) = (opts.target_irradiance_wm2, opts.target_temp_c);
    let dt = t2 - t1;

    let (v2, i2): (Vec<f64>, Vec<f64>) = match procedure {
        Procedure::P1 => {
            let s1 = i_sc1 * (g2 / g1 - 1.0);
            let s2 = alpha * dt;
            let i2: Vec<f64> = i1.iter().map(|x| x + s1 + s2).collect();
            let v2 = v1
                .iter()
                .zip(i1.iter().zip(&i2))
                .map(|(v, (a, b))| v - r_s * (b - a) - kappa * b * dt + beta * dt)
                .collect();
            (v2, i2)
        }
        Procedure::P4 => {
            let s1 = i_sc1 * (g2 / g1 - 1.0);
            let i_tmp: Vec<f64> = i1.iter().map(|x| x + s1).collect();
            let v_tmp: Vec<f64> = v1
                .iter()
                .zip(i_tmp.iter().zip(&i1))
                .map(|(v, (it, i))| v - r_s * (it - i))
                .collect();
            let i2 = i_tmp.iter().map(|x| x + alpha * dt).collect();
            let s = dt / (t1 + 273.15);
            let c = opts.epsilon_v * n_mod as f64 * spec.cells_per_module as f64;
            let v2 = v_tmp.iter().map(|vt| vt + s * (vt - c)).collect();
            (v2, i2)
        }
        Procedure::P2 | Procedure::Dynamic => {
            let a_rel = spec.temp_coeff_isc_pct / 100.0;
            let b_rel = spec.temp_coeff_voc_pct / 100.0;
            let voc_stc = n_mod as f64 * spec.voc_stc;
            let f = |g: f64| {
                let x = (G_STC / g).ln();
                b2 * x * x + b1 * x + 1.0
            };
            let i_src: Vec<f64> = match r_sh {
                Some(rsh) => i1.iter().zip(&v1).map(|(i, v)| i + v / rsh).collect(),
                None => i1.clone(),
            };
            let gr = g2 / g1;
            let num = 1.0 + a_rel * (t2 - T_STC);
            let den = 1.0 + a_rel * (t1 - T_STC);
            let mut i2: Vec<f64> = i_src.iter().map(|x| x * gr * num / den).collect();
            let r_s1 = r_s + kappa * (t1 - T_STC);
            let (f1, f2) = (f(g1), f(g2));
            let k =
                voc_stc * (b_rel * (f2 * (t2 - T_STC) - f1 * (t1 - T_STC)) + 1.0 / f2 - 1.0 / f1);
            let v2: Vec<f64> = v1
                .iter()
                .zip(i2.iter().zip(&i_src))
                .map(|(v, (b, s))| v - r_s1 * (b - s) - kappa * b * dt + k)
                .collect();
            if let Some(rsh) = r_sh {
                for (b, v) in i2.iter_mut().zip(&v2) {
                    *b -= v / rsh;
                }
            }
            (v2, i2)
        }
    };

    let (v2c, i2c) = rectify_iv_curve(&v2, &i2, Some(4))?;
    Ok(StcTranslation {
        points_stc: curve_points(&v2c, &i2c, 2, 3, 2),
        points_measured: curve_points(&v1, &i1, 2, 3, 2),
        v_stc: v2c,
        i_stc: i2c,
        iec60891: Iec60891Info {
            procedure,
            g1_wm2: py_round(g1, 1),
            t1_c: py_round(t1, 1),
            g2_wm2: g2,
            t2_c: t2,
            alpha_a_per_k: py_round(alpha, 5),
            beta_v_per_k: py_round(beta, 4),
            r_s_ohm: py_round(r_s, 4),
            kappa_ohm_per_k: py_round(kappa, 5),
            r_sh_ohm: r_sh.map(|r| py_round(r, 2)),
        },
    })
}

// ---------------------------------------------------------------------------
// 6. Fault-signature classification & warranty decision rule
// ---------------------------------------------------------------------------

/// One row of `iv_analysis.FAULT_SIGNATURES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FaultSignature {
    pub name: &'static str,
    pub observation: &'static str,
    pub likely_cause: &'static str,
    pub recommended_action: &'static str,
}

/// Port of `iv_analysis.FAULT_SIGNATURES`, in the same order.
pub const FAULT_SIGNATURES: [FaultSignature; 10] = [
    FaultSignature {
        name: "normal",
        observation: "Within STC expected dead band",
        likely_cause: "Operating within normal STC uncertainty band",
        recommended_action: "No action required.",
    },
    FaultSignature {
        name: "not_judged",
        observation: "Sweep conditions do not allow a comparison at STC; only steps in the curve are judged",
        likely_cause: "Not judged: irradiance below 700 W/m², unstable irradiance, or a sweep too fast for the cells",
        recommended_action: "Repeat the sweep at 700 W/m² or more with stable irradiance.",
    },
    FaultSignature {
        name: "isc_low_normal_shape",
        observation: "Isc low, curve shape normal",
        likely_cause: "Uniform soiling, optical degradation, or an irradiance sensor error. Check the sensor first.",
        recommended_action: "Verify reference cell / irradiance sensor calibration and mounting plane first, then inspect array for uniform soiling.",
    },
    FaultSignature {
        name: "bypass_diode_shorted",
        observation: "Voc low by about ⅓ of one module’s Voc",
        likely_cause: "Shorted bypass diode, one substring bypassed",
        recommended_action: "Perform IR thermography (look for patchwork hot substring) and module-level Voc check to replace faulty junction box / diode.",
    },
    FaultSignature {
        name: "miswiring_or_module_count",
        observation: "Voc low by about one full module",
        likely_cause: "Miswiring or wrong module count",
        recommended_action: "Verify physical string module count against as-built String Layout and inspect jumper connections.",
    },
    FaultSignature {
        name: "steps_in_curve",
        observation: "Steps or notches in the curve",
        likely_cause: "Partial shading, cell mismatch, or cracked cells forcing a bypass diode on",
        recommended_action: "Check array for localized shading, bird droppings, or cracked cells via Drone IR / EL inspection.",
    },
    FaultSignature {
        name: "high_series_resistance",
        observation: "Shallower slope near Voc (Rs up), FF down",
        likely_cause: "Solder-bond or ribbon corrosion, a bad connector, or a cable problem",
        recommended_action: "Inspect MC4 connectors, combiner fuse holders, string cables, and module interconnect ribbons with IR camera under load.",
    },
    FaultSignature {
        name: "low_shunt_resistance",
        observation: "Steeper slope near Isc (Rsh down), FF down",
        likely_cause: "Shunting, PID, cell cracks",
        recommended_action: "Conduct EL / IR inspection for cell cracks or shunting paths across cells.",
    },
    FaultSignature {
        name: "pid",
        observation: "Voc and FF down, worse at low irradiance, strings near the negative pole affected",
        likely_cause: "PID (Potential Induced Degradation)",
        recommended_action: "Verify inverter anti-PID night recovery module status, check insulation resistance (Riso), and inspect negative-end modules with IR.",
    },
    FaultSignature {
        name: "normal_degradation",
        observation: "All parameters down a little, uniformly",
        likely_cause: "Normal degradation. Compare the size of the drop against the warranty slope.",
        recommended_action: "Track annual performance loss rate (PLR) against module linear warranty curve.",
    },
];

/// The row of [`FAULT_SIGNATURES`] named `name`.
pub fn fault_signature(name: &str) -> Option<&'static FaultSignature> {
    FAULT_SIGNATURES.iter().find(|s| s.name == name)
}

/// The result of [`expected_stc_power_w`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExpectedPower {
    pub nameplate_w: f64,
    pub expected_pmax_stc_w: f64,
    pub warranted_retention_pct: f64,
    pub first_year_lid_pct: f64,
    pub annual_degradation_pct: f64,
    pub system_age_years: f64,
}

/// Port of `iv_analysis.expected_stc_power_w`: nameplate × (1 − first-year LID − years ×
/// warranted degradation), at least 50 %.
pub fn expected_stc_power_w(
    spec: &ModuleStcSpec,
    modules: i64,
    system_age_years: f64,
) -> ExpectedPower {
    let n_mod = modules.max(1);
    let nameplate_w = n_mod as f64 * spec.wp;
    let age = pymax(0.0, system_age_years);
    let lid_frac = if age > 0.0 {
        spec.first_year_lid_pct / 100.0
    } else {
        0.0
    };
    let deg_frac = age * (spec.annual_degradation_pct / 100.0);
    let retention = pymax(0.50, 1.0 - lid_frac - deg_frac);
    ExpectedPower {
        nameplate_w: py_round(nameplate_w, 2),
        expected_pmax_stc_w: py_round(nameplate_w * retention, 2),
        warranted_retention_pct: py_round(retention * 100.0, 2),
        first_year_lid_pct: if age > 0.0 {
            spec.first_year_lid_pct
        } else {
            0.0
        },
        annual_degradation_pct: spec.annual_degradation_pct,
        system_age_years: py_round(age, 2),
    }
}

/// The keyword arguments of `classify_iv_fault` (Python defaults).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct ClassifyOptions {
    pub modules: i64,
    pub system_age_years: f64,
    pub dead_band_pct: f64,
    pub near_negative_pole: bool,
    pub low_irradiance_worse: bool,
    pub quality_gate_passed: bool,
    pub ir_confirmed: bool,
    pub timeseries_trend_confirmed: bool,
    pub steps_measured: Option<i64>,
    pub shape_gate_passed: Option<bool>,
    pub absolute_comparison_ok: bool,
}

impl Default for ClassifyOptions {
    fn default() -> Self {
        ClassifyOptions {
            modules: 1,
            system_age_years: 0.0,
            dead_band_pct: DEFAULT_DEAD_BAND_PCT,
            near_negative_pole: false,
            low_irradiance_worse: false,
            quality_gate_passed: true,
            ir_confirmed: false,
            timeseries_trend_confirmed: false,
            steps_measured: None,
            shape_gate_passed: None,
            absolute_comparison_ok: true,
        }
    }
}

/// The `warranty` block of a classification.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Warranty {
    pub below_warranted_power: bool,
    pub ir_confirmed: bool,
    pub timeseries_trend_confirmed: bool,
    pub second_source: Option<&'static str>,
    pub module_test_candidate: bool,
    #[serde(flatten)]
    pub expected: ExpectedPower,
}

/// The `deviations_pct` block of a classification.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Deviations {
    pub p_max_vs_expected_pct: f64,
    pub v_oc_vs_stc_pct: f64,
    pub i_sc_vs_stc_pct: f64,
    pub ff_vs_stc_pct: f64,
}

/// The result of [`classify_iv_fault`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FaultClassification {
    pub signature: &'static str,
    pub observation: &'static str,
    pub likely_cause: &'static str,
    pub recommended_action: &'static str,
    pub unjudged_signature: Option<&'static str>,
    pub is_finding: bool,
    pub in_dead_band: bool,
    pub dead_band_pct: f64,
    pub ticket_recommended: bool,
    pub stc_comparison_valid: bool,
    pub warranty: Warranty,
    pub deviations_pct: Deviations,
}

/// Port of `iv_analysis.classify_iv_fault`: an STC-translated curve against the fault
/// signature table (checked in Python's order), then the dead band, ticket and two-source
/// module-test rules.
pub fn classify_iv_fault(
    params_stc: &IvParameters,
    spec: &ModuleStcSpec,
    opts: &ClassifyOptions,
) -> FaultClassification {
    let quality_gate_passed = opts.quality_gate_passed;
    let dead_band_pct = opts.dead_band_pct;
    let shape_ok = opts.shape_gate_passed.unwrap_or(quality_gate_passed);
    let n_mod = opts.modules.max(1);
    let exp = expected_stc_power_w(spec, n_mod, opts.system_age_years);
    let p_exp = exp.expected_pmax_stc_w;
    let voc_exp = n_mod as f64 * spec.voc_stc;
    let isc_exp = spec.isc_stc;
    let vmp_exp = n_mod as f64 * spec.vmp_stc;
    let imp_exp = spec.imp_stc;
    let ff_exp = if voc_exp > 0.0 && isc_exp > 0.0 {
        (vmp_exp * imp_exp) / (voc_exp * isc_exp)
    } else {
        0.78
    };

    let p_stc = params_stc.p_max_w;
    let voc_stc = params_stc.v_oc_v;
    let isc_stc = params_stc.i_sc_a;
    let ff_stc = params_stc.fill_factor;
    let slope_voc = params_stc.slope_voc_ohm;
    let slope_isc = params_stc.slope_isc_ohm;
    let steps = opts.steps_measured.unwrap_or(params_stc.steps_count);

    let dev = |x: f64, e: f64| if e > 0.0 { (x - e) / e * 100.0 } else { 0.0 };
    let p_dev_pct = dev(p_stc, p_exp);
    let voc_dev_pct = dev(voc_stc, voc_exp);
    let isc_dev_pct = dev(isc_stc, isc_exp);
    let ff_dev_pct = dev(ff_stc, ff_exp);

    let rs_nom = pymax(0.05, (voc_exp - vmp_exp) / pymax(0.5, imp_exp) * 0.95);
    let rsh_nom = pymax(50.0, vmp_exp / pymax(0.1, isc_exp - imp_exp) * 3.0);

    let voc_drop_v = voc_exp - voc_stc;
    let shunt_ok = slope_isc >= 0.55 * rsh_nom;
    let one_mod_voc = spec.voc_stc;
    let one_sub_voc = spec.voc_stc / spec.substrings_per_module.max(1) as f64;

    let ratio = voc_drop_v / one_mod_voc;
    let mut signature: &'static str = "normal";
    if steps >= 1 {
        signature = "steps_in_curve";
    } else if shunt_ok
        && isc_dev_pct.abs() <= dead_band_pct
        && voc_drop_v >= 0.75 * one_mod_voc
        && (ratio - ratio.round_ties_even()).abs() <= 0.25
    {
        signature = "miswiring_or_module_count";
    } else if shunt_ok
        && isc_dev_pct.abs() <= dead_band_pct
        && voc_drop_v >= 0.70 * one_sub_voc
        && ((voc_drop_v - one_sub_voc).abs() <= 0.25 * one_sub_voc
            || (voc_drop_v - 2.0 * one_sub_voc).abs() <= 0.25 * one_sub_voc)
    {
        signature = "bypass_diode_shorted";
    } else if voc_dev_pct < -3.0
        && ff_dev_pct < -4.0
        && (opts.near_negative_pole || opts.low_irradiance_worse || slope_isc < 0.45 * rsh_nom)
    {
        signature = "pid";
    } else if slope_isc < 0.55 * rsh_nom && ff_dev_pct < -3.5 {
        signature = "low_shunt_resistance";
    } else if slope_voc > 1.30 * rs_nom && ff_dev_pct < -3.5 {
        signature = "high_series_resistance";
    } else if isc_dev_pct < -dead_band_pct && ff_dev_pct.abs() <= 3.5 && voc_dev_pct.abs() <= 3.0 {
        signature = "isc_low_normal_shape";
    } else if p_dev_pct < -dead_band_pct {
        signature = "normal_degradation";
    }

    let mut unjudged_signature: Option<&'static str> = None;
    if !quality_gate_passed && signature != "steps_in_curve" {
        unjudged_signature = Some(signature);
        signature = "not_judged";
    }

    let in_dead_band = p_dev_pct.abs() <= dead_band_pct
        && matches!(
            signature,
            "normal" | "normal_degradation" | "isc_low_normal_shape"
        );
    let is_finding = if in_dead_band {
        signature = "normal";
        false
    } else {
        !matches!(signature, "normal" | "not_judged")
    };

    let stepped = signature == "steps_in_curve";
    let mut ticket_recommended =
        is_finding && quality_gate_passed && signature != "normal_degradation";
    if signature == "normal_degradation" && p_dev_pct < -dead_band_pct && quality_gate_passed {
        ticket_recommended = true;
    }
    if !opts.absolute_comparison_ok
        && matches!(signature, "isc_low_normal_shape" | "normal_degradation")
    {
        ticket_recommended = false;
    }
    if stepped && shape_ok {
        ticket_recommended = true;
    }

    let below_warranty = p_dev_pct < -dead_band_pct
        && quality_gate_passed
        && !stepped
        && opts.absolute_comparison_ok;
    let second_source = match (opts.ir_confirmed, opts.timeseries_trend_confirmed) {
        (true, true) => Some("ir_and_timeseries"),
        (true, false) => Some("ir"),
        (false, true) => Some("timeseries_trend"),
        (false, false) => None,
    };
    let module_test_candidate = below_warranty && second_source.is_some();

    let meta = fault_signature(signature).expect("signature is in the table");
    FaultClassification {
        signature: meta.name,
        observation: meta.observation,
        likely_cause: meta.likely_cause,
        recommended_action: meta.recommended_action,
        unjudged_signature,
        is_finding,
        in_dead_band,
        dead_band_pct,
        ticket_recommended,
        stc_comparison_valid: quality_gate_passed && !stepped && opts.absolute_comparison_ok,
        warranty: Warranty {
            below_warranted_power: below_warranty,
            ir_confirmed: opts.ir_confirmed,
            timeseries_trend_confirmed: opts.timeseries_trend_confirmed,
            second_source,
            module_test_candidate,
            expected: exp,
        },
        deviations_pct: Deviations {
            p_max_vs_expected_pct: py_round(p_dev_pct, 2),
            v_oc_vs_stc_pct: py_round(voc_dev_pct, 2),
            i_sc_vs_stc_pct: py_round(isc_dev_pct, 2),
            ff_vs_stc_pct: py_round(ff_dev_pct, 2),
        },
    }
}

/// The keyword arguments of `estimate_stc_pmax_uncertainty` (Python defaults).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct UncertaintyOptions {
    pub irradiance_uncertainty_pct: Option<f64>,
    pub irradiance_change_pct: Option<f64>,
    pub temp_change_k_per_min: Option<f64>,
    pub procedure_spread_pct: Option<f64>,
    pub target_temp_c: f64,
}

impl Default for UncertaintyOptions {
    fn default() -> Self {
        UncertaintyOptions {
            irradiance_uncertainty_pct: None,
            irradiance_change_pct: None,
            temp_change_k_per_min: None,
            procedure_spread_pct: None,
            target_temp_c: T_STC,
        }
    }
}

/// One component of the uncertainty budget.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UncertaintyComponent {
    pub name: &'static str,
    pub pct: f64,
    pub source: &'static str,
}

/// The result of [`estimate_stc_pmax_uncertainty`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PmaxUncertainty {
    pub expanded_pct: f64,
    pub coverage_k: i64,
    pub lower_bound: bool,
    pub components: Vec<UncertaintyComponent>,
    pub not_included: [&'static str; 4],
}

/// Port of `iv_analysis.estimate_stc_pmax_uncertainty`: expanded uncertainty (k = 2) of the
/// translated Pmax in %, the root sum of squares of the (rounded) components; a lower bound.
pub fn estimate_stc_pmax_uncertainty(
    module_temp_c: f64,
    spec: &ModuleStcSpec,
    opts: &UncertaintyOptions,
) -> PmaxUncertainty {
    let gamma = spec.temp_coeff_pmax_pct.abs();
    let mut comps: Vec<UncertaintyComponent> = Vec::new();
    let mut add = |name: &'static str, pct: f64, source: &'static str| {
        comps.push(UncertaintyComponent {
            name,
            pct: py_round(pct, 2),
            source,
        });
    };
    match opts.irradiance_uncertainty_pct {
        Some(u) => add("irradiance_sensor", u.abs(), "input"),
        None => add(
            "irradiance_sensor",
            ASSUMED_IRRADIANCE_UNCERTAINTY_PCT,
            "assumed",
        ),
    }
    if let Some(dg) = opts.irradiance_change_pct {
        add("irradiance_change", dg.abs(), "input");
    }
    let mut t_err = ASSUMED_MODULE_TEMP_ERROR_K;
    if let Some(dt) = opts.temp_change_k_per_min {
        t_err = t_err.hypot(dt.abs());
    }
    add("module_temperature", t_err * gamma, "assumed");
    add(
        "temperature_coefficient",
        ASSUMED_TEMP_COEFF_UNCERTAINTY_FRAC * gamma * (opts.target_temp_c - module_temp_c).abs(),
        "assumed",
    );
    let spread = opts.procedure_spread_pct.map(f64::abs).unwrap_or(0.0);
    if spread > ASSUMED_TRANSLATION_UNCERTAINTY_PCT {
        add("translation", spread, "procedure_spread");
    } else {
        add(
            "translation",
            ASSUMED_TRANSLATION_UNCERTAINTY_PCT,
            "assumed",
        );
    }
    let mut total_sq = 0.0;
    for c in &comps {
        total_sq += c.pct.powf(2.0);
    }
    PmaxUncertainty {
        expanded_pct: py_round(total_sq.sqrt(), 1),
        coverage_k: 2,
        lower_bound: true,
        components: comps,
        not_included: [
            "tracer_voltage_current_accuracy",
            "repeatability",
            "spectral_mismatch",
            "sensor_alignment",
        ],
    }
}

/// The keyword arguments of `analyze_iv_sweep` after `spec` (Python defaults).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct AnalyzeOptions {
    pub modules: i64,
    pub system_age_years: f64,
    pub irradiance_change_pct: Option<f64>,
    pub dead_band_pct: f64,
    pub near_negative_pole: bool,
    pub low_irradiance_worse: bool,
    pub ir_confirmed: bool,
    pub timeseries_trend_confirmed: bool,
    pub absolute_comparison_ok: bool,
    pub temp_change_k_per_min: Option<f64>,
    pub sweep_time_ms: Option<f64>,
    pub cell_technology: Option<String>,
    pub irradiance_uncertainty_pct: Option<f64>,
    pub reverse_pmax_w: Option<f64>,
    pub sensor_misalignment_deg: Option<f64>,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        AnalyzeOptions {
            modules: 1,
            system_age_years: 0.0,
            irradiance_change_pct: None,
            dead_band_pct: DEFAULT_DEAD_BAND_PCT,
            near_negative_pole: false,
            low_irradiance_worse: false,
            ir_confirmed: false,
            timeseries_trend_confirmed: false,
            absolute_comparison_ok: true,
            temp_change_k_per_min: None,
            sweep_time_ms: None,
            cell_technology: None,
            irradiance_uncertainty_pct: None,
            reverse_pmax_w: None,
            sensor_misalignment_deg: None,
        }
    }
}

/// The `conditions` block of [`analyze_iv_sweep`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SweepConditionsOut {
    pub swept_at: String,
    pub irradiance_wm2: f64,
    pub module_temp_c: f64,
    pub irradiance_change_pct: Option<f64>,
    pub temp_change_k_per_min: Option<f64>,
    pub sweep_time_ms: Option<f64>,
    pub cell_technology: Option<String>,
    pub irradiance_uncertainty_pct: Option<f64>,
    pub reverse_pmax_w: Option<f64>,
    pub sensor_misalignment_deg: Option<f64>,
    #[serde(flatten)]
    pub gate: SweepGate,
}

/// Procedure 2 cross-check.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Procedure2Check {
    pub p_max_stc_w: f64,
    pub diff_vs_procedure_1_pct: f64,
    pub b1: f64,
    pub b2: f64,
    pub coefficients: &'static str,
}

/// Procedure 4 cross-check.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Procedure4Check {
    pub p_max_stc_w: f64,
    pub diff_vs_procedure_1_pct: f64,
    pub epsilon_v: f64,
    pub cells_in_series: i64,
}

/// Dynamic-procedure cross-check.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DynamicCheck {
    pub p_max_stc_w: f64,
    pub diff_vs_procedure_1_pct: f64,
    pub diff_vs_procedure_2_pct: Option<f64>,
    pub r_sh_ohm: Option<f64>,
    pub shunt_neglected: bool,
    pub b1: f64,
    pub b2: f64,
    pub coefficients: &'static str,
}

/// Parameters at the site reference.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SiteReferenceParams {
    pub p_max_w: f64,
    pub i_sc_a: f64,
    pub v_oc_v: f64,
    pub fill_factor: f64,
}

/// Translation to the site reference (1000 W/m², 55 °C, Procedure 1).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SiteReference {
    pub g_wm2: f64,
    pub t_c: f64,
    pub procedure: i64,
    pub parameters: SiteReferenceParams,
}

/// The `iec60891` block of [`analyze_iv_sweep`]: Procedure 1 plus the cross-checks (null when
/// that translation failed).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SweepIec {
    #[serde(flatten)]
    pub base: Iec60891Info,
    pub procedure_2: Option<Procedure2Check>,
    pub procedure_4: Option<Procedure4Check>,
    pub procedure_dynamic: Option<DynamicCheck>,
    pub site_reference: Option<SiteReference>,
}

/// Measured curve block.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MeasuredBlock {
    pub parameters: IvParameters,
    pub single_diode_fit: SandiaFit,
    pub points: Vec<CurvePoint>,
}

/// STC curve block.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StcBlock {
    pub parameters: IvParameters,
    pub single_diode_fit: SandiaFit,
    pub points: Vec<CurvePoint>,
    pub reference_points: Vec<CurvePoint>,
}

/// Forward vs reverse sweep comparison.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ForwardReverse {
    pub reverse_pmax_w: f64,
    pub diff_pct: f64,
    pub limit_pct: f64,
    pub limit_status: &'static str,
    pub capacitance_suspect: bool,
}

/// Equivalent cell temperature from Voc.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EquivalentCellTemp {
    pub t_c: f64,
    pub diff_vs_measured_k: f64,
    pub basis: &'static str,
    pub coefficients: &'static str,
}

/// The `classification` block of [`analyze_iv_sweep`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SweepClassification {
    #[serde(flatten)]
    pub base: FaultClassification,
    pub shape_gate_passed: bool,
    pub gate_warnings: Vec<String>,
    pub quality_flags: Vec<String>,
    pub forward_reverse: Option<ForwardReverse>,
    pub equivalent_cell_temp: Option<EquivalentCellTemp>,
    pub uncertainty: Option<PmaxUncertainty>,
}

/// The result of [`analyze_iv_sweep`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SweepAnalysis {
    pub conditions: SweepConditionsOut,
    pub iec60891: SweepIec,
    pub measured: MeasuredBlock,
    pub stc: StcBlock,
    pub classification: SweepClassification,
}

/// Port of `iv_analysis.analyze_iv_sweep`: the full pipeline for one string or module sweep
/// (conditions gate, measured parameters and Sandia fit, Procedure 1 to STC, classification,
/// Procedure 2 / 4 / dynamic cross-checks and the site reference, uncertainty, forward vs
/// reverse, equivalent cell temperature).
pub fn analyze_iv_sweep(
    voltage: &[f64],
    current: &[f64],
    irradiance_wm2: Option<f64>,
    module_temp_c: Option<f64>,
    swept_at: Option<&str>,
    spec: &ModuleStcSpec,
    opts: &AnalyzeOptions,
) -> Result<SweepAnalysis, IvError> {
    let gate = validate_sweep_conditions(&SweepConditions {
        irradiance_wm2,
        module_temp_c,
        swept_at: swept_at.map(str::to_string),
        irradiance_change_pct: opts.irradiance_change_pct,
        temp_change_k_per_min: opts.temp_change_k_per_min,
        sweep_time_ms: opts.sweep_time_ms,
        cell_technology: opts.cell_technology.clone(),
        sensor_misalignment_deg: opts.sensor_misalignment_deg,
        ..SweepConditions::default()
    })?;
    let g = irradiance_wm2.expect("validated");
    let t = module_temp_c.expect("validated");
    let modules = opts.modules;
    let params_meas = extract_iv_parameters(voltage, current)?;
    let sde_meas = fit_sandia_simple(
        voltage,
        current,
        Some(params_meas.v_oc_v),
        Some(params_meas.i_sc_a),
    )?;

    let stc = translate_to_stc_iec60891(
        voltage,
        current,
        g,
        t,
        spec,
        &TranslateOptions {
            modules,
            r_s_ohm: Some(sde_meas.r_s_ohm),
            ..Default::default()
        },
    )?;
    let params_stc = extract_iv_parameters(&stc.v_stc, &stc.i_stc)?;
    let sde_stc = fit_sandia_simple(
        &stc.v_stc,
        &stc.i_stc,
        Some(params_stc.v_oc_v),
        Some(params_stc.i_sc_a),
    )?;

    let n_mod = modules.max(1);
    let nf = n_mod as f64;
    let desoto_ref = fit_desoto(
        nf * spec.vmp_stc,
        spec.imp_stc,
        nf * spec.voc_stc,
        spec.isc_stc,
        spec.alpha_a_per_k(),
        spec.beta_v_per_k(n_mod),
        n_mod * spec.cells_per_module,
    );
    let reference_stc_points = simulate_single_diode_curve(
        desoto_ref.i_l_ref_a,
        desoto_ref.i_o_ref_a,
        desoto_ref.r_s_ohm,
        desoto_ref.r_sh_ref_ohm,
        desoto_ref.a_ref_v,
        nf * spec.voc_stc,
        60,
    );

    let classification = classify_iv_fault(
        &params_stc,
        spec,
        &ClassifyOptions {
            modules: n_mod,
            system_age_years: opts.system_age_years,
            dead_band_pct: opts.dead_band_pct,
            near_negative_pole: opts.near_negative_pole,
            low_irradiance_worse: opts.low_irradiance_worse,
            quality_gate_passed: gate.quality_gate_passed,
            ir_confirmed: opts.ir_confirmed,
            timeseries_trend_confirmed: opts.timeseries_trend_confirmed,
            steps_measured: Some(params_meas.steps_count),
            shape_gate_passed: Some(gate.shape_gate_passed),
            absolute_comparison_ok: opts.absolute_comparison_ok,
        },
    );
    let mut warnings = gate.gate_warnings.clone();
    if !opts.absolute_comparison_ok {
        warnings.push("Inverter scan: irradiance and temperature are not from a reference cell at the string, so absolute STC power is not judged".to_string());
    }

    let p1_pmax = params_stc.p_max_w;
    let r_s_fit = sde_meas.r_s_ohm;
    let (b1, b2, b_source) = spec.p2_factors();

    // a translation that fails (ValueError / LinAlgError) is left out, never replaced
    let cross_check =
        |procedure: Procedure, r_sh_ohm: Option<f64>| -> Option<(f64, f64, StcTranslation)> {
            let tr = translate_to_stc_iec60891(
                voltage,
                current,
                g,
                t,
                spec,
                &TranslateOptions {
                    modules,
                    r_s_ohm: Some(r_s_fit),
                    procedure,
                    r_sh_ohm,
                    ..Default::default()
                },
            )
            .ok()?;
            let pmax = extract_iv_parameters(&tr.v_stc, &tr.i_stc).ok()?.p_max_w;
            let diff = if p1_pmax > 0.0 {
                (pmax - p1_pmax) / p1_pmax * 100.0
            } else {
                0.0
            };
            Some((py_round(pmax, 2), py_round(diff, 2), tr))
        };

    let p2 = cross_check(Procedure::P2, None).map(|(p, d, _)| Procedure2Check {
        p_max_stc_w: p,
        diff_vs_procedure_1_pct: d,
        b1,
        b2,
        coefficients: b_source,
    });
    if let Some(p2) = &p2 {
        if p2.diff_vs_procedure_1_pct.abs() > P2_DISAGREE_PCT {
            warnings.push(format!(
                "IEC 60891 Procedures 1 and 2 differ by {:.1}% in STC Pmax: translation uncertainty is high",
                p2.diff_vs_procedure_1_pct.abs()
            ));
        }
    }
    let p4 = cross_check(Procedure::P4, None).map(|(p, d, _)| Procedure4Check {
        p_max_stc_w: p,
        diff_vs_procedure_1_pct: d,
        epsilon_v: DEFAULT_P4_EPSILON_V,
        cells_in_series: n_mod * spec.cells_per_module,
    });
    let pdyn = cross_check(Procedure::Dynamic, Some(sde_meas.r_sh_ohm)).map(|(p, d, tr)| {
        let r_sh_used = tr.iec60891.r_sh_ohm.expect("dynamic has r_sh");
        let shunt_neglected = r_sh_used >= PDYN_RSH_NEGLECTED_OHM;
        let diff_p2 = match &p2 {
            Some(p2) if p2.p_max_stc_w > 0.0 => {
                Some(py_round((p - p2.p_max_stc_w) / p2.p_max_stc_w * 100.0, 2))
            }
            _ => None,
        };
        DynamicCheck {
            p_max_stc_w: p,
            diff_vs_procedure_1_pct: d,
            diff_vs_procedure_2_pct: diff_p2,
            r_sh_ohm: if shunt_neglected {
                None
            } else {
                Some(r_sh_used)
            },
            shunt_neglected,
            b1,
            b2,
            coefficients: b_source,
        }
    });
    if let Some(dp2) = pdyn.as_ref().and_then(|d| d.diff_vs_procedure_2_pct) {
        if dp2.abs() > P2_DISAGREE_PCT {
            warnings.push(format!(
                "The dynamic procedure differs from Procedure 2 by {:.1}% in STC Pmax: the shunt current of this curve distorts the standard translation",
                dp2.abs()
            ));
        }
    }
    let site_reference = (|| -> Result<SiteReference, IvError> {
        let (v_m, i_m) = rectify_iv_curve(voltage, current, Some(4))?;
        let site = translate_to_stc_iec60891(
            &v_m,
            &i_m,
            g,
            t,
            spec,
            &TranslateOptions {
                modules,
                r_s_ohm: Some(r_s_fit),
                target_temp_c: SITE_REFERENCE_TEMP_C,
                ..Default::default()
            },
        )?;
        let sp = extract_iv_parameters(&site.v_stc, &site.i_stc)?;
        Ok(SiteReference {
            g_wm2: G_STC,
            t_c: SITE_REFERENCE_TEMP_C,
            procedure: 1,
            parameters: SiteReferenceParams {
                p_max_w: sp.p_max_w,
                i_sc_a: sp.i_sc_a,
                v_oc_v: sp.v_oc_v,
                fill_factor: sp.fill_factor,
            },
        })
    })()
    .ok();

    let mut uncertainty: Option<PmaxUncertainty> = None;
    if opts.absolute_comparison_ok {
        let diffs: Vec<f64> = [
            p2.as_ref().map(|x| x.diff_vs_procedure_1_pct.abs()),
            pdyn.as_ref().map(|x| x.diff_vs_procedure_1_pct.abs()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let spread = diffs.iter().copied().reduce(pymax);
        let u = estimate_stc_pmax_uncertainty(
            t,
            spec,
            &UncertaintyOptions {
                irradiance_uncertainty_pct: opts.irradiance_uncertainty_pct,
                irradiance_change_pct: opts.irradiance_change_pct,
                temp_change_k_per_min: opts.temp_change_k_per_min,
                procedure_spread_pct: spread,
                ..Default::default()
            },
        );
        if u.expanded_pct > opts.dead_band_pct {
            warnings.push(format!(
                "Estimated uncertainty of STC Pmax (±{:.1}%) is larger than the ±{:.1}% dead band used: a shortfall inside it is not significant",
                u.expanded_pct, opts.dead_band_pct
            ));
        }
        uncertainty = Some(u);
    }

    let mut quality_flags = gate.quality_flags.clone();
    let mut fwd_rev: Option<ForwardReverse> = None;
    let p_meas = params_meas.p_max_w;
    if let Some(rev) = opts.reverse_pmax_w {
        if rev > 0.0 && p_meas > 0.0 {
            let diff = (p_meas - rev).abs() / ((p_meas + rev) / 2.0) * 100.0;
            let suspect = diff > MAX_FWD_REV_PMAX_DIFF_PCT;
            fwd_rev = Some(ForwardReverse {
                reverse_pmax_w: py_round(rev, 2),
                diff_pct: py_round(diff, 2),
                limit_pct: MAX_FWD_REV_PMAX_DIFF_PCT,
                limit_status: "proposed",
                capacitance_suspect: suspect,
            });
            if suspect {
                if !quality_flags.iter().any(|f| f == "capacitance_suspect") {
                    quality_flags.push("capacitance_suspect".to_string());
                }
                warnings.push(format!(
                    "Pmax of the two sweep directions differs by {diff:.1}% (limit {MAX_FWD_REV_PMAX_DIFF_PCT:.0}%): cell capacitance is distorting the curve, use a slower sweep"
                ));
            }
        }
    }

    let mut ect: Option<EquivalentCellTemp> = None;
    let voc_faults = [
        "bypass_diode_shorted",
        "miswiring_or_module_count",
        "steps_in_curve",
        "pid",
    ];
    let b_rel = spec.temp_coeff_voc_pct / 100.0;
    if gate.shape_gate_passed && !voc_faults.contains(&classification.signature) && b_rel != 0.0 {
        let x = (G_STC / g).ln();
        let f_g = b2 * x * x + b1 * x + 1.0;
        let t_ect = T_STC + (params_meas.v_oc_v / (nf * spec.voc_stc) - 1.0 / f_g) / (b_rel * f_g);
        if (-40.0..=120.0).contains(&t_ect) {
            ect = Some(EquivalentCellTemp {
                t_c: py_round(t_ect, 1),
                diff_vs_measured_k: py_round(t_ect - t, 1),
                basis: "datasheet_voc",
                coefficients: b_source,
            });
        }
    }

    let shape_gate_passed = gate.shape_gate_passed;
    Ok(SweepAnalysis {
        conditions: SweepConditionsOut {
            swept_at: swept_at.expect("validated").to_string(),
            irradiance_wm2: py_round(g, 1),
            module_temp_c: py_round(t, 1),
            irradiance_change_pct: opts.irradiance_change_pct.map(|x| py_round(x, 2)),
            temp_change_k_per_min: opts.temp_change_k_per_min,
            sweep_time_ms: opts.sweep_time_ms,
            cell_technology: opts.cell_technology.clone(),
            irradiance_uncertainty_pct: opts.irradiance_uncertainty_pct,
            reverse_pmax_w: opts.reverse_pmax_w,
            sensor_misalignment_deg: opts.sensor_misalignment_deg,
            gate,
        },
        iec60891: SweepIec {
            base: stc.iec60891.clone(),
            procedure_2: p2,
            procedure_4: p4,
            procedure_dynamic: pdyn,
            site_reference,
        },
        measured: MeasuredBlock {
            parameters: params_meas,
            single_diode_fit: sde_meas,
            points: stc.points_measured,
        },
        stc: StcBlock {
            parameters: params_stc,
            single_diode_fit: sde_stc,
            points: stc.points_stc,
            reference_points: reference_stc_points,
        },
        classification: SweepClassification {
            base: classification,
            shape_gate_passed,
            gate_warnings: warnings,
            quality_flags,
            forward_reverse: fwd_rev,
            equivalent_cell_temp: ect,
            uncertainty,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::numpy::*;

    #[test]
    fn python_round_is_half_even_on_the_binary_value() {
        assert_eq!(py_round(2.675, 2), 2.67);
        assert_eq!(py_round(0.125, 2), 0.12);
        assert_eq!(py_round(0.375, 2), 0.38);
        assert_eq!(np_round(2.675, 2), 2.68);
        assert!(py_round(f64::NAN, 2).is_nan());
    }

    #[test]
    fn python_max_min_keep_the_first_on_nan_and_ties() {
        assert_eq!(pymax(0.001, f64::NAN), 0.001);
        assert_eq!(pymin(1e6, f64::NAN), 1e6);
        assert!(maximum(0.0, f64::NAN).is_nan());
    }

    #[test]
    fn lstsq_gives_the_minimum_norm_solution_when_rank_deficient() {
        // np.polyfit([2, 2, 2, 2], [1, 2, 3, 4], 1) == [0.625, 1.25]
        let c = polyfit(&[2.0, 2.0, 2.0, 2.0], &[1.0, 2.0, 3.0, 4.0], 1).unwrap();
        assert!(
            (c[0] - 0.625).abs() < 1e-12 && (c[1] - 1.25).abs() < 1e-12,
            "{c:?}"
        );
        // a zero column is NaN after scaling: NumPy raises LinAlgError
        assert!(polyfit(&[0.0; 4], &[1.0, 2.0, 3.0, 4.0], 1).is_err());
        assert_eq!(
            lstsq(&[vec![], vec![], vec![]], &[], None).unwrap(),
            vec![0.0; 3]
        );
    }

    #[test]
    fn arange_lengths_match_numpy() {
        assert_eq!(arange(0.0, 0.1501, 0.0005).len(), 301);
        assert_eq!(arange(0.0, 1.0001, 0.01).len(), 101);
        assert_eq!(arange(0.0, 0.00501, 0.0001).len(), 51);
    }
}
