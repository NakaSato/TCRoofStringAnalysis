//! Parity of `iv_analysis` with backend/solar_core/iv_analysis.py (fixtures/iv_analysis.json,
//! written by fixtures/iv_gen.py): the same results within 1e-6 (labels, flags and messages
//! exact), the same error class and message.
mod iv_common;

use iv_common::{check, compare, de, f, fvec, load, opt_f, run_all, spec};
use serde_json::Value;
use std::sync::OnceLock;
use tcroof_core::iv_analysis::numpy;
use tcroof_core::iv_analysis::*;

fn fx() -> &'static Value {
    static FX: OnceLock<Value> = OnceLock::new();
    FX.get_or_init(|| load("iv_analysis.json"))
}

fn cases(key: &str) -> &'static [Value] {
    fx()[key].as_array().unwrap_or_else(|| panic!("no {key}"))
}

fn curve_name(k: &Value) -> &'static str {
    fx()["curves"][k.as_u64().unwrap() as usize]["name"]
        .as_str()
        .unwrap()
}

fn curve(k: &Value) -> (Vec<f64>, Vec<f64>) {
    let c = &fx()["curves"][k.as_u64().unwrap() as usize];
    (fvec(&c["v"]), fvec(&c["i"]))
}

#[test]
fn numpy_polyfit() {
    run_all("polyfit", cases("polyfit"), |k, c, st| {
        let got = numpy::polyfit(
            &fvec(&c["x"]),
            &fvec(&c["y"]),
            c["deg"].as_u64().unwrap() as usize,
        );
        check(&format!("polyfit[{k}]"), got, c, st)
    });
}

#[test]
fn numpy_lstsq() {
    run_all("lstsq", cases("lstsq"), |k, c, st| {
        let cols: Vec<Vec<f64>> = c["cols"].as_array().unwrap().iter().map(fvec).collect();
        check(
            &format!("lstsq[{k}]"),
            numpy::lstsq(&cols, &fvec(&c["b"]), None),
            c,
            st,
        )
    });
}

#[test]
fn numpy_interp_gradient_linspace() {
    run_all("interp", cases("interp"), |k, c, st| {
        let got = numpy::interp(&fvec(&c["x"]), &fvec(&c["xp"]), &fvec(&c["fp"]));
        check(&format!("interp[{k}]"), Ok::<_, IvError>(got), c, st)
    });
    run_all("gradient", cases("gradient"), |k, c, st| {
        let got = numpy::gradient(&fvec(&c["f"]), &fvec(&c["x"]));
        check(&format!("gradient[{k}]"), Ok::<_, IvError>(got), c, st)
    });
    run_all("linspace", cases("linspace"), |k, c, st| {
        let got = numpy::linspace(
            f(&c["start"]),
            f(&c["stop"]),
            c["num"].as_u64().unwrap() as usize,
        );
        check(&format!("linspace[{k}]"), Ok::<_, IvError>(got), c, st)
    });
}

#[test]
fn validate_sweep_conditions_matches_python() {
    run_all("validate", cases("validate"), |k, c, st| {
        let kw = &c["kwargs"];
        let mut cond: SweepConditions = de(kw);
        // non-finite G / T are dropped by `de`; put them back
        cond.irradiance_wm2 = opt_f(&kw["irradiance_wm2"]);
        cond.module_temp_c = opt_f(&kw["module_temp_c"]);
        check(
            &format!("validate[{k}] {kw}"),
            validate_sweep_conditions(&cond),
            c,
            st,
        )
    });
}

#[test]
fn parse_iv_csv_matches_python() {
    run_all("parse_csv", cases("parse_csv"), |k, c, st| {
        check(
            &format!("parse_csv[{k}]"),
            parse_iv_csv(c["content"].as_str().unwrap()),
            c,
            st,
        )
    });
}

#[test]
fn rectify_iv_curve_matches_python() {
    run_all("rectify", cases("rectify"), |k, c, st| {
        let (v, i) = curve(&c["curve"]);
        check(
            &format!("rectify[{k}]"),
            rectify_iv_curve(&v, &i, Some(4)),
            c,
            st,
        )
    });
    run_all("rectify_raw", cases("rectify_raw"), |k, c, st| {
        let (v, i) = curve(&c["curve"]);
        check(
            &format!("rectify_raw[{k}]"),
            rectify_iv_curve(&v, &i, None),
            c,
            st,
        )
    });
}

#[test]
fn extract_iv_parameters_matches_python() {
    run_all("extract", cases("extract"), |k, c, st| {
        let (v, i) = curve(&c["curve"]);
        check(
            &format!("extract[{k}] {}", curve_name(&c["curve"])),
            extract_iv_parameters(&v, &i),
            c,
            st,
        )
    });
}

#[test]
fn fit_sandia_simple_matches_python() {
    run_all("sandia", cases("sandia"), |k, c, st| {
        let (v, i) = curve(&c["curve"]);
        let got = fit_sandia_simple(&v, &i, opt_f(&c["v_oc"]), opt_f(&c["i_sc"]));
        check(
            &format!("sandia[{k}] {}", curve_name(&c["curve"])),
            got,
            c,
            st,
        )
    });
}

#[test]
fn lambertw_desoto_simulate_match_python() {
    run_all("lambertw", cases("lambertw"), |k, c, st| {
        check(
            &format!("lambertw[{k}]"),
            Ok::<_, IvError>(lambertw_pv(f(&c["x"]))),
            c,
            st,
        )
    });
    run_all("desoto", cases("desoto"), |k, c, st| {
        let a = &c["args"];
        let got = fit_desoto(
            f(&a["v_mp"]),
            f(&a["i_mp"]),
            f(&a["v_oc"]),
            f(&a["i_sc"]),
            f(&a["alpha_sc_a_per_k"]),
            f(&a["beta_oc_v_per_k"]),
            a["n_cells_series"].as_i64().unwrap(),
        );
        check(&format!("desoto[{k}]"), Ok::<_, IvError>(got), c, st)
    });
    run_all("simulate", cases("simulate"), |k, c, st| {
        let a = &c["args"];
        let got = simulate_single_diode_curve(
            f(&a["i_l"]),
            f(&a["i_o"]),
            f(&a["r_s"]),
            f(&a["r_sh"]),
            f(&a["n_ns_vth"]),
            f(&a["v_oc"]),
            a["n_points"].as_u64().unwrap() as usize,
        );
        check(&format!("simulate[{k}]"), Ok::<_, IvError>(got), c, st)
    });
}

#[test]
fn translate_to_stc_iec60891_matches_python() {
    run_all("translate", cases("translate"), |k, c, st| {
        let (v, i) = curve(&c["curve"]);
        let sp = spec(fx(), c["spec"].as_str().unwrap());
        let opts: TranslateOptions = de(&c["opts"]);
        let got = translate_to_stc_iec60891(&v, &i, f(&c["g"]), f(&c["t"]), &sp, &opts);
        check(
            &format!("translate[{k}] {} {}", curve_name(&c["curve"]), c["opts"]),
            got,
            c,
            st,
        )
    });
}

#[test]
fn expected_power_classify_uncertainty_match_python() {
    run_all("expected_power", cases("expected_power"), |k, c, st| {
        let sp = spec(fx(), c["spec"].as_str().unwrap());
        let got = expected_stc_power_w(&sp, c["modules"].as_i64().unwrap(), f(&c["age"]));
        check(&format!("expected[{k}]"), Ok::<_, IvError>(got), c, st)
    });
    run_all("classify", cases("classify"), |k, c, st| {
        let sp = spec(fx(), c["spec"].as_str().unwrap());
        let params: IvParameters = de(&c["params"]);
        let opts: ClassifyOptions = de(&c["kwargs"]);
        check(
            &format!("classify[{k}]"),
            Ok::<_, IvError>(classify_iv_fault(&params, &sp, &opts)),
            c,
            st,
        )
    });
    run_all("uncertainty", cases("uncertainty"), |k, c, st| {
        let sp = spec(fx(), c["spec"].as_str().unwrap());
        let opts: UncertaintyOptions = de(&c["kwargs"]);
        let got = estimate_stc_pmax_uncertainty(f(&c["module_temp_c"]), &sp, &opts);
        check(&format!("uncertainty[{k}]"), Ok::<_, IvError>(got), c, st)
    });
}

#[test]
fn analyze_iv_sweep_matches_python() {
    run_all("analyze", cases("analyze"), |k, c, st| {
        let (v, i) = curve(&c["curve"]);
        let sp = spec(fx(), c["spec"].as_str().unwrap());
        let opts: AnalyzeOptions = de(&c["kwargs"]);
        let got = analyze_iv_sweep(
            &v,
            &i,
            opt_f(&c["g"]),
            opt_f(&c["t"]),
            c["swept_at"].as_str(),
            &sp,
            &opts,
        );
        check(
            &format!("analyze[{k}] {} {}", curve_name(&c["curve"]), c["kwargs"]),
            got,
            c,
            st,
        )
    });
}

#[test]
fn signature_table_order_matches_python() {
    let names: Vec<&str> = FAULT_SIGNATURES.iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "normal",
            "not_judged",
            "isc_low_normal_shape",
            "bypass_diode_shorted",
            "miswiring_or_module_count",
            "steps_in_curve",
            "high_series_resistance",
            "low_shunt_resistance",
            "pid",
            "normal_degradation"
        ]
    );
    let _ = compare;
}
