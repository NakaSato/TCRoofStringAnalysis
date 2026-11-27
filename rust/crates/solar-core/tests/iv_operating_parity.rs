//! Parity of `iv_operating` with backend/solar_core/iv_operating.py (fixtures/iv_operating.json).
mod iv_common;

use iv_common::{check, de, load, opt_f, run_all, spec};
use tcroof_solar_core::iv_analysis::IvError;
use tcroof_solar_core::iv_operating::{
    judge_point, string_curve_at, JudgeCriteria, JudgeOptions, StringCurve,
};

#[test]
fn string_curve_at_matches_python() {
    let fx = load("iv_operating.json");
    run_all(
        "string_curve_at",
        fx["string_curve_at"].as_array().unwrap(),
        |k, c, st| {
            let sp = spec(&fx, c["spec"].as_str().unwrap());
            let got = string_curve_at(
                &sp,
                c["modules"].as_i64().unwrap(),
                opt_f(&c["g"]),
                opt_f(&c["t"]),
                c["n_points"].as_u64().unwrap() as usize,
            );
            check(
                &format!("string_curve_at[{k}]"),
                Ok::<_, IvError>(got),
                c,
                st,
            )
        },
    );
}

#[test]
fn judge_point_matches_python() {
    let fx = load("iv_operating.json");
    let criteria: JudgeCriteria = de(&fx["criteria"]);
    run_all(
        "judge_point",
        fx["judge_point"].as_array().unwrap(),
        |k, c, st| {
            let curve: Option<StringCurve> = de(&c["curve"]);
            let opts: JudgeOptions = de(&c["kwargs"]);
            let got = judge_point(
                opt_f(&c["v"]),
                opt_f(&c["i"]),
                curve.as_ref(),
                opt_f(&c["irradiance"]),
                &criteria,
                &opts,
            );
            check(&format!("judge_point[{k}]"), Ok::<_, IvError>(got), c, st)
        },
    );
}
