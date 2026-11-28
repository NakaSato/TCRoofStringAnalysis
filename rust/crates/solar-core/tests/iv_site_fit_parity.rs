//! Parity of `iv_site_fit` with backend/solar_core/iv_site_fit.py (fixtures/iv_site_fit.json).
mod iv_common;

use iv_common::{check, de, f, fvec, load, run_all, spec};
use tcroof_core::iv_site_fit::{fit_site_coefficients, interpolate_procedure_3, SiteSweep};

#[test]
fn fit_site_coefficients_matches_python() {
    let fx = load("iv_site_fit.json");
    run_all("site_fit", fx["fit"].as_array().unwrap(), |k, c, st| {
        let sweeps: Vec<SiteSweep> = de(&c["sweeps"]);
        let sp = spec(&fx, c["spec"].as_str().unwrap());
        let got = fit_site_coefficients(&sweeps, &sp, c["modules"].as_i64().unwrap());
        check(&format!("fit[{k}] {}", c["name"]), got, c, st)
    });
}

#[test]
fn interpolate_procedure_3_matches_python() {
    let fx = load("iv_site_fit.json");
    run_all(
        "procedure_3",
        fx["procedure_3"].as_array().unwrap(),
        |k, c, st| {
            let (a, b) = (&c["a"], &c["b"]);
            let got = interpolate_procedure_3(
                &fvec(&a["v"]),
                &fvec(&a["i"]),
                f(&a["g"]),
                f(&a["t"]),
                &fvec(&b["v"]),
                &fvec(&b["i"]),
                f(&b["g"]),
                f(&b["t"]),
                f(&c["target"]),
            );
            check(&format!("procedure_3[{k}]"), got, c, st)
        },
    );
}
