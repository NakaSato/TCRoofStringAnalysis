//! The pure I-V tests of backend/tests/test_iv_and_timeseries.py and
//! backend/tests/test_string_operating.py, ported (same synthetic curves, same assertions).

use tcroof_solar_core::iv_analysis::*;
use tcroof_solar_core::iv_operating::{judge_point, string_curve_at, JudgeCriteria, JudgeOptions};
use tcroof_solar_core::iv_site_fit::{fit_site_coefficients, interpolate_procedure_3, SiteSweep};

fn spec() -> ModuleStcSpec {
    ModuleStcSpec::default()
}

fn approx(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * b.abs()
}

#[derive(Default)]
struct Synth {
    modules: i64,
    isc_scale: f64,
    voc_offset_v: f64,
    rs_mult: f64,
    rsh_ohm: Option<f64>,
    add_step: bool,
}

/// `_synth_stc_curve` of test_iv_and_timeseries.py.
fn synth(o: Synth) -> (Vec<f64>, Vec<f64>) {
    let s = spec();
    let m = o.modules.max(1);
    let isc_scale = if o.isc_scale == 0.0 { 1.0 } else { o.isc_scale };
    let rs_mult = if o.rs_mult == 0.0 { 1.0 } else { o.rs_mult };
    let mf = m as f64;
    let d = fit_desoto(
        s.vmp_stc * mf,
        s.imp_stc * isc_scale,
        s.voc_stc * mf + o.voc_offset_v,
        s.isc_stc * isc_scale,
        s.alpha_a_per_k(),
        s.beta_v_per_k(m),
        72 * m,
    );
    let v_oc = s.voc_stc * mf + o.voc_offset_v;
    let pts = simulate_single_diode_curve(
        d.i_l_ref_a,
        d.i_o_ref_a,
        d.r_s_ohm * rs_mult,
        o.rsh_ohm.unwrap_or(d.r_sh_ref_ohm),
        d.a_ref_v,
        v_oc,
        80,
    );
    let mut v = Vec::new();
    let mut i = Vec::new();
    for p in pts {
        let mut cur = p.i;
        if o.add_step && 0.45 * v_oc < p.v && p.v < 0.85 * v_oc {
            let f = 0.72 + 0.28 * ((0.55 * v_oc - p.v) / (0.10 * v_oc)).clamp(0.0, 1.0);
            cur = numpy::py_round(cur * f, 3);
        }
        v.push(p.v);
        i.push(cur);
    }
    (v, i)
}

fn m10() -> Synth {
    Synth {
        modules: 10,
        ..Default::default()
    }
}

fn run_sweep((v, i): &(Vec<f64>, Vec<f64>), opts: AnalyzeOptions) -> SweepAnalysis {
    analyze_iv_sweep(
        v,
        i,
        Some(1000.0),
        Some(25.0),
        Some("2026-11-10T12:00:00"),
        &spec(),
        &opts,
    )
    .unwrap()
}

fn opts10() -> AnalyzeOptions {
    AnalyzeOptions {
        modules: 10,
        ..Default::default()
    }
}

fn cond(g: Option<f64>, t: Option<f64>, at: Option<&str>) -> SweepConditions {
    SweepConditions {
        irradiance_wm2: g,
        module_temp_c: t,
        swept_at: at.map(str::to_string),
        ..Default::default()
    }
}

const AT: Option<&str> = Some("2026-11-10T11:30:00");

#[test]
fn sweep_condition_validation_requires_g_t_and_timestamp() {
    assert!(
        validate_sweep_conditions(&cond(Some(850.0), Some(42.0), None))
            .unwrap_err()
            .message()
            .contains("timestamp")
    );
    assert!(validate_sweep_conditions(&cond(None, Some(42.0), AT))
        .unwrap_err()
        .message()
        .contains("irradiance"));
    assert!(validate_sweep_conditions(&cond(Some(850.0), None, AT))
        .unwrap_err()
        .message()
        .contains("temperature"));

    let ok = validate_sweep_conditions(&SweepConditions {
        irradiance_change_pct: Some(0.6),
        ..cond(Some(820.0), Some(44.0), AT)
    })
    .unwrap();
    assert!(ok.quality_gate_passed && ok.gate_reasons.is_empty() && ok.gate_warnings.is_empty());

    let warn = validate_sweep_conditions(&SweepConditions {
        irradiance_change_pct: Some(1.4),
        ..cond(Some(750.0), Some(44.0), AT)
    })
    .unwrap();
    assert!(warn.quality_gate_passed && warn.gate_reasons.is_empty());
    assert_eq!(warn.gate_warnings.len(), 2);

    let low_g = validate_sweep_conditions(&SweepConditions {
        irradiance_change_pct: Some(2.8),
        ..cond(Some(620.0), Some(40.0), AT)
    })
    .unwrap();
    assert!(!low_g.quality_gate_passed && !low_g.shape_gate_passed);
    assert_eq!(low_g.gate_reasons.len(), 2);

    let shape_only = validate_sweep_conditions(&SweepConditions {
        irradiance_change_pct: Some(0.5),
        ..cond(Some(520.0), Some(40.0), AT)
    })
    .unwrap();
    assert!(!shape_only.quality_gate_passed && shape_only.shape_gate_passed);

    let too_low = validate_sweep_conditions(&cond(Some(350.0), Some(40.0), AT)).unwrap();
    assert!(!too_low.quality_gate_passed && !too_low.shape_gate_passed);
}

#[test]
fn steps_are_judged_on_the_measured_curve_and_never_against_warranty() {
    let (v, i) = synth(Synth {
        add_step: true,
        ..m10()
    });
    let low_i: Vec<f64> = i.iter().map(|x| x * 0.52).collect();
    let low = analyze_iv_sweep(
        &v,
        &low_i,
        Some(520.0),
        Some(25.0),
        Some("2026-11-10T09:00:00"),
        &spec(),
        &AnalyzeOptions {
            ir_confirmed: true,
            ..opts10()
        },
    )
    .unwrap();
    let cls = &low.classification.base;
    assert!(!low.conditions.gate.quality_gate_passed);
    assert!(low.measured.parameters.steps_count >= 1);
    assert_eq!(cls.signature, "steps_in_curve");
    assert!(cls.ticket_recommended && !cls.stc_comparison_valid);
    assert!(!cls.warranty.below_warranted_power && !cls.warranty.module_test_candidate);

    let dark_i: Vec<f64> = i.iter().map(|x| x * 0.3).collect();
    let dark = analyze_iv_sweep(
        &v,
        &dark_i,
        Some(300.0),
        Some(25.0),
        Some("2026-11-10T07:30:00"),
        &spec(),
        &opts10(),
    )
    .unwrap();
    assert!(!dark.classification.base.ticket_recommended);
}

#[test]
fn iec60891_procedure_1_roundtrip_and_single_diode_fit() {
    let s = spec();
    let modules = 10;
    let (v_stc, i_stc) = synth(m10());
    let (g1, t1) = (800.0, 45.0);
    let alpha = s.alpha_a_per_k();
    let beta = s.beta_v_per_k(modules);
    let r_s = s.rs_ohm * 10.0;
    let kappa = s.kappa_ohm_per_k * 10.0;
    let dt = 25.0 - t1;
    let isc2 = i_stc[0];
    let isc1 = (isc2 - alpha * dt) / (1000.0 / g1);
    let (mut v1, mut i1) = (Vec::new(), Vec::new());
    for (vs, is) in v_stc.iter().zip(&i_stc) {
        let ii = is - isc1 * (1000.0 / g1 - 1.0) - alpha * dt;
        let vv = vs + r_s * (is - ii) + kappa * is * dt - beta * dt;
        if vv >= 0.0 && ii >= 0.0 {
            v1.push(vv);
            i1.push(ii);
        }
    }
    let tr = translate_to_stc_iec60891(
        &v1,
        &i1,
        g1,
        t1,
        &s,
        &TranslateOptions {
            modules,
            r_s_ohm: Some(r_s),
            kappa_ohm_per_k: Some(kappa),
            ..Default::default()
        },
    )
    .unwrap();
    let p = extract_iv_parameters(&tr.v_stc, &tr.i_stc).unwrap();
    assert!(approx(p.v_oc_v, s.voc_stc * 10.0, 0.015));
    assert!(approx(p.i_sc_a, s.isc_stc, 0.015));
    assert!(approx(p.p_max_w, s.wp * 10.0, 0.025));
    let sde = fit_sandia_simple(&tr.v_stc, &tr.i_stc, None, None).unwrap();
    assert!(approx(sde.i_l_a, s.isc_stc, 0.03));
    assert!(sde.r_s_ohm > 0.0 && sde.r_sh_ohm > 50.0);
}

#[test]
fn all_eight_iv_fault_signatures_and_two_source_warranty() {
    let s = spec();
    let ok = run_sweep(
        &synth(Synth {
            isc_scale: 0.985,
            ..m10()
        }),
        AnalyzeOptions {
            system_age_years: 1.0,
            ..opts10()
        },
    );
    assert!(ok.classification.base.in_dead_band && !ok.classification.base.ticket_recommended);

    let soil = run_sweep(
        &synth(Synth {
            isc_scale: 0.84,
            ..m10()
        }),
        opts10(),
    );
    assert_eq!(soil.classification.base.signature, "isc_low_normal_shape");
    assert!(soil.classification.base.ticket_recommended);

    let diode = run_sweep(
        &synth(Synth {
            voc_offset_v: -(s.voc_stc / 3.0),
            ..m10()
        }),
        AnalyzeOptions {
            dead_band_pct: 2.0,
            ..opts10()
        },
    );
    assert_eq!(diode.classification.base.signature, "bypass_diode_shorted");

    let miss = run_sweep(
        &synth(Synth {
            voc_offset_v: -s.voc_stc,
            ..m10()
        }),
        opts10(),
    );
    assert_eq!(
        miss.classification.base.signature,
        "miswiring_or_module_count"
    );

    let step = run_sweep(
        &synth(Synth {
            add_step: true,
            ..m10()
        }),
        opts10(),
    );
    assert!(step.stc.parameters.steps_count >= 1);
    assert_eq!(step.classification.base.signature, "steps_in_curve");

    let rs = run_sweep(
        &synth(Synth {
            rs_mult: 4.0,
            ..m10()
        }),
        opts10(),
    );
    assert_eq!(rs.classification.base.signature, "high_series_resistance");

    let rsh = run_sweep(
        &synth(Synth {
            rsh_ohm: Some(55.0),
            ..m10()
        }),
        opts10(),
    );
    assert_eq!(rsh.classification.base.signature, "low_shunt_resistance");

    let pid_pts = synth(Synth {
        voc_offset_v: -25.0,
        rsh_ohm: Some(45.0),
        ..m10()
    });
    let pid = run_sweep(
        &pid_pts,
        AnalyzeOptions {
            near_negative_pole: true,
            ..opts10()
        },
    );
    assert_eq!(pid.classification.base.signature, "pid");
    assert!(!pid.classification.base.warranty.module_test_candidate);
    let pid2 = run_sweep(
        &pid_pts,
        AnalyzeOptions {
            near_negative_pole: true,
            ir_confirmed: true,
            ..opts10()
        },
    );
    assert!(pid2.classification.base.warranty.module_test_candidate);
    assert_eq!(pid2.classification.base.warranty.second_source, Some("ir"));

    let unif = run_sweep(
        &synth(Synth {
            isc_scale: 0.93,
            voc_offset_v: -0.045 * s.voc_stc * 10.0,
            ..m10()
        }),
        AnalyzeOptions {
            system_age_years: 1.0,
            ..opts10()
        },
    );
    assert_eq!(unif.classification.base.signature, "normal_degradation");
}

#[test]
fn csv_parser_reads_the_tracer_export() {
    let (v, i) = synth(Synth {
        voc_offset_v: -25.0,
        rsh_ohm: Some(45.0),
        ..m10()
    });
    let mut text = String::from("Voltage (V),Current (A)\n");
    let rows: Vec<String> = v
        .iter()
        .zip(&i)
        .map(|(a, b)| format!("{a:?},{b:?}"))
        .collect();
    text.push_str(&rows.join("\n"));
    assert_eq!(parse_iv_csv(&text).unwrap().len(), v.len());
}

#[test]
fn iec60891_procedure_2_matches_procedure_1_near_stc() {
    let s = spec();
    let (v, i) = synth(m10());
    let base = extract_iv_parameters(&v, &i).unwrap().p_max_w;
    for proc in [Procedure::P1, Procedure::P2] {
        let same = translate_to_stc_iec60891(
            &v,
            &i,
            1000.0,
            25.0,
            &s,
            &TranslateOptions {
                modules: 10,
                procedure: proc,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(approx(
            extract_iv_parameters(&same.v_stc, &same.i_stc)
                .unwrap()
                .p_max_w,
            base,
            1e-3
        ));
    }
    let mut out = Vec::new();
    for proc in [Procedure::P1, Procedure::P2] {
        let t = translate_to_stc_iec60891(
            &v,
            &i,
            900.0,
            45.0,
            &s,
            &TranslateOptions {
                modules: 10,
                r_s_ohm: Some(10.0 * s.rs_ohm),
                procedure: proc,
                ..Default::default()
            },
        )
        .unwrap();
        out.push(extract_iv_parameters(&t.v_stc, &t.i_stc).unwrap().p_max_w);
    }
    assert!(out[0] > base && out[1] > base);
    assert!(approx(out[1], out[0], 0.01));
    assert!(Procedure::from_int(3).is_err());
}

#[test]
fn procedure_4_and_dynamic_procedure_cross_checks() {
    let s = spec();
    let (v, i) = synth(m10());
    let base = extract_iv_parameters(&v, &i).unwrap().p_max_w;
    for proc in [Procedure::P4, Procedure::Dynamic] {
        let same = translate_to_stc_iec60891(
            &v,
            &i,
            1000.0,
            25.0,
            &s,
            &TranslateOptions {
                modules: 10,
                procedure: proc,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(approx(
            extract_iv_parameters(&same.v_stc, &same.i_stc)
                .unwrap()
                .p_max_w,
            base,
            1e-3
        ));
    }
    let res = analyze_iv_sweep(
        &v,
        &i,
        Some(850.0),
        Some(58.0),
        Some("2026-11-10 12:00:00"),
        &s,
        &opts10(),
    )
    .unwrap();
    let iec = &res.iec60891;
    assert_eq!(iec.base.procedure, Procedure::P1);
    let p4 = iec.procedure_4.as_ref().unwrap();
    assert!(p4.diff_vs_procedure_1_pct.abs() < 1.0 && p4.cells_in_series == 720);
    let dynp = iec.procedure_dynamic.as_ref().unwrap();
    assert!(dynp.shunt_neglected && dynp.r_sh_ohm.is_none());
    assert!(dynp.diff_vs_procedure_2_pct.unwrap().abs() <= 0.05);

    let (vs, is) = synth(Synth {
        rsh_ohm: Some(150.0),
        ..m10()
    });
    let res = analyze_iv_sweep(
        &vs,
        &is,
        Some(850.0),
        Some(58.0),
        Some("2026-11-10 12:00:00"),
        &s,
        &opts10(),
    )
    .unwrap();
    let dynp = res.iec60891.procedure_dynamic.as_ref().unwrap();
    assert!(!dynp.shunt_neglected && (100.0..250.0).contains(&dynp.r_sh_ohm.unwrap()));
    assert!(dynp.diff_vs_procedure_2_pct.unwrap().abs() > 1.0);
    assert!(res
        .classification
        .gate_warnings
        .iter()
        .any(|w| w.contains("dynamic procedure")));
    let tr = res
        .classification
        .uncertainty
        .as_ref()
        .unwrap()
        .components
        .iter()
        .find(|c| c.name == "translation")
        .unwrap();
    assert!(tr.source == "procedure_spread" && tr.pct > 1.0);
}

#[test]
fn temperature_and_sweep_time_gates_and_uncertainty_estimate() {
    let at = Some("2026-11-10 12:00:00");
    let ok = validate_sweep_conditions(&SweepConditions {
        temp_change_k_per_min: Some(0.5),
        sweep_time_ms: Some(200.0),
        ..cond(Some(900.0), Some(50.0), at)
    })
    .unwrap();
    assert!(ok.quality_gate_passed && ok.gate_warnings.is_empty() && ok.quality_flags.is_empty());
    let drift = validate_sweep_conditions(&SweepConditions {
        temp_change_k_per_min: Some(1.8),
        ..cond(Some(900.0), Some(50.0), at)
    })
    .unwrap();
    assert!(drift.quality_gate_passed && drift.quality_flags == ["unstable_T"]);
    assert!(drift.gate_warnings[0].contains("1.8 K"));
    let fast = validate_sweep_conditions(&SweepConditions {
        sweep_time_ms: Some(20.0),
        cell_technology: Some("TOPCon".into()),
        ..cond(Some(900.0), Some(50.0), at)
    })
    .unwrap();
    assert!(
        !fast.quality_gate_passed
            && fast.shape_gate_passed
            && fast.quality_flags == ["capacitance_suspect"]
    );
    let unknown = validate_sweep_conditions(&SweepConditions {
        sweep_time_ms: Some(20.0),
        ..cond(Some(900.0), Some(50.0), at)
    })
    .unwrap();
    assert!(
        unknown.quality_gate_passed
            && unknown.quality_flags == ["capacitance_suspect"]
            && unknown.gate_warnings.len() == 1
    );
    let perc = validate_sweep_conditions(&SweepConditions {
        sweep_time_ms: Some(20.0),
        cell_technology: Some("perc".into()),
        ..cond(Some(900.0), Some(50.0), at)
    })
    .unwrap();
    assert!(
        perc.quality_gate_passed && perc.gate_warnings.is_empty() && perc.quality_flags.is_empty()
    );

    let s = spec();
    let u = estimate_stc_pmax_uncertainty(55.0, &s, &UncertaintyOptions::default());
    assert!(u.coverage_k == 2 && u.lower_bound);
    assert_eq!(
        u.components
            .iter()
            .find(|c| c.name == "irradiance_sensor")
            .unwrap()
            .source,
        "assumed"
    );
    let want = (2.5f64.powi(2) + 0.9f64.powi(2) + 0.9f64.powi(2) + 1.0).sqrt();
    assert!((u.expanded_pct - want).abs() <= 0.05);
    let better = estimate_stc_pmax_uncertainty(
        55.0,
        &s,
        &UncertaintyOptions {
            irradiance_uncertainty_pct: Some(1.0),
            ..Default::default()
        },
    );
    let worse = estimate_stc_pmax_uncertainty(
        70.0,
        &s,
        &UncertaintyOptions {
            irradiance_change_pct: Some(1.8),
            temp_change_k_per_min: Some(2.0),
            procedure_spread_pct: Some(2.4),
            ..Default::default()
        },
    );
    assert!(better.expanded_pct < u.expanded_pct && u.expanded_pct < worse.expanded_pct);
    assert_eq!(
        better.components[0],
        UncertaintyComponent {
            name: "irradiance_sensor",
            pct: 1.0,
            source: "input"
        }
    );
}

#[test]
fn forward_reverse_sensor_alignment_ect_and_fleet_factors() {
    let s = spec();
    let pts = synth(m10());
    let p_meas = extract_iv_parameters(&pts.0, &pts.1).unwrap().p_max_w;
    let close = run_sweep(
        &pts,
        AnalyzeOptions {
            reverse_pmax_w: Some(p_meas * 1.005),
            ..opts10()
        },
    )
    .classification;
    assert!(
        !close.forward_reverse.as_ref().unwrap().capacitance_suspect
            && close.quality_flags.is_empty()
    );
    let far = run_sweep(
        &pts,
        AnalyzeOptions {
            reverse_pmax_w: Some(p_meas * 1.04),
            ..opts10()
        },
    )
    .classification;
    assert!((far.forward_reverse.as_ref().unwrap().diff_pct - 3.92).abs() <= 0.05);
    assert_eq!(far.quality_flags, ["capacitance_suspect"]);
    assert!(far
        .gate_warnings
        .iter()
        .any(|w| w.contains("sweep directions")));
    assert!(run_sweep(&pts, opts10())
        .classification
        .forward_reverse
        .is_none());

    let at = Some("2026-11-10 12:00:00");
    let mis = |d: f64| {
        validate_sweep_conditions(&SweepConditions {
            sensor_misalignment_deg: Some(d),
            ..cond(Some(900.0), Some(50.0), at)
        })
        .unwrap()
    };
    let g = mis(0.5);
    assert!(g.gate_warnings.is_empty() && g.quality_flags.is_empty());
    let g = mis(1.5);
    assert!(g.gate_warnings.len() == 1 && g.quality_flags.is_empty());
    let g = mis(3.0);
    assert!(g.quality_flags == ["sensor_misaligned"] && g.quality_gate_passed);

    let ect = run_sweep(&pts, opts10())
        .classification
        .equivalent_cell_temp
        .unwrap();
    assert!((ect.t_c - 25.0).abs() <= 0.3 && ect.basis == "datasheet_voc");
    let res =
        analyze_iv_sweep(&pts.0, &pts.1, Some(1000.0), Some(32.0), at, &s, &opts10()).unwrap();
    assert!(
        (res.classification
            .equivalent_cell_temp
            .as_ref()
            .unwrap()
            .diff_vs_measured_k
            + 7.0)
            .abs()
            <= 0.3
    );
    assert_eq!(res.iec60891.base.t1_c, 32.0);
    let diode = run_sweep(
        &synth(Synth {
            voc_offset_v: -s.voc_stc / 3.0,
            ..m10()
        }),
        opts10(),
    )
    .classification;
    assert!(diode.base.signature == "bypass_diode_shorted" && diode.equivalent_cell_temp.is_none());

    assert_eq!(s.p2_factors(), (0.045, 0.0, "assumed"));
    let own = ModuleStcSpec::from_dict(&ModuleSpecDict {
        p2_b1: Some(0.06),
        p2_b2: Some(0.002),
        ..Default::default()
    });
    assert_eq!(own.p2_factors(), (0.06, 0.002, "fleet_setting"));
    let low_g = analyze_iv_sweep(&pts.0, &pts.1, Some(750.0), Some(50.0), at, &own, &opts10())
        .unwrap()
        .iec60891
        .procedure_2
        .unwrap();
    let rf = analyze_iv_sweep(&pts.0, &pts.1, Some(750.0), Some(50.0), at, &s, &opts10())
        .unwrap()
        .iec60891
        .procedure_2
        .unwrap();
    assert!(low_g.coefficients == "fleet_setting" && low_g.b1 == 0.06);
    assert!(rf.coefficients == "assumed" && low_g.p_max_stc_w != rf.p_max_stc_w);
}

/// `_field_curve`: an STC curve carried to (g, t) with Procedure 2 and known coefficients.
fn field(g: f64, t: f64) -> SiteSweep {
    let truth = ModuleStcSpec {
        p2_b1: Some(0.06),
        temp_coeff_voc_pct: -0.28,
        ..spec()
    };
    let (v, i) = synth(m10());
    let tr = translate_to_stc_iec60891(
        &v,
        &i,
        1000.0,
        25.0,
        &truth,
        &TranslateOptions {
            modules: 10,
            r_s_ohm: Some(3.0),
            kappa_ohm_per_k: Some(0.02),
            procedure: Procedure::P2,
            target_irradiance_wm2: g,
            target_temp_c: t,
            ..Default::default()
        },
    )
    .unwrap();
    SiteSweep {
        v: tr.v_stc,
        i: tr.i_stc,
        g,
        t,
    }
}

#[test]
fn site_coefficient_fit_recovers_known_values_and_says_what_it_cannot_determine() {
    let s = spec();
    let wide: Vec<SiteSweep> = [
        (450.0, 38.0),
        (600.0, 45.0),
        (780.0, 52.0),
        (900.0, 58.0),
        (980.0, 63.0),
    ]
    .iter()
    .map(|&(g, t)| field(g, t))
    .collect();
    let fit = fit_site_coefficients(&wide, &s, 10).unwrap();
    assert_eq!(fit.reasons, ["Irradiance and temperature move together in these sweeps, so Rs and κ cannot be told apart reliably"]);
    let voc = fit.voc.as_ref().unwrap();
    assert!((voc.voc_stc_per_module_v - s.voc_stc).abs() <= 0.05);
    assert!((voc.beta_rel_pct_per_k.unwrap() + 0.28).abs() <= 0.005);
    assert!((voc.b1.unwrap() - 0.06).abs() <= 0.002);
    assert!(voc.b2.is_none());
    let res = fit.resistance.as_ref().unwrap();
    assert!(
        res.rs_ohm_per_module.is_some() && res.pmax_spread_after_pct < res.pmax_spread_before_pct
    );

    let narrow = fit_site_coefficients(
        &[field(900.0, 40.0), field(920.0, 60.0), field(950.0, 50.0)],
        &s,
        10,
    )
    .unwrap();
    assert!(
        narrow.voc.as_ref().unwrap().b1.is_none()
            && narrow
                .resistance
                .as_ref()
                .unwrap()
                .rs_ohm_per_module
                .is_none()
    );
    assert!((narrow.voc.as_ref().unwrap().beta_rel_pct_per_k.unwrap() + 0.28).abs() <= 0.02);
    assert!(narrow
        .reasons
        .iter()
        .any(|r| r.contains("B1 and Rs are not determined")));
    let flat = fit_site_coefficients(
        &[field(500.0, 50.0), field(700.0, 51.0), field(950.0, 52.0)],
        &s,
        10,
    )
    .unwrap();
    assert!(flat.voc.as_ref().unwrap().beta_rel_pct_per_k.is_none());
    assert!(flat
        .resistance
        .as_ref()
        .unwrap()
        .kappa_ohm_per_k_per_module
        .is_none());
    assert!((flat.voc.as_ref().unwrap().b1.unwrap() - 0.06).abs() <= 0.01);
    let two = fit_site_coefficients(&wide[..2], &s, 10).unwrap();
    assert!(two.voc.is_none() && two.resistance.is_none() && two.procedure_3.is_some());
    assert!(fit_site_coefficients(&wide[..1], &s, 10)
        .unwrap()
        .procedure_3
        .is_none());
}

#[test]
fn procedure_3_interpolates_between_two_curves() {
    let (lo, hi, mid) = (field(600.0, 45.0), field(1000.0, 45.0), field(800.0, 45.0));
    let p3 = interpolate_procedure_3(&lo.v, &lo.i, 600.0, 45.0, &hi.v, &hi.i, 1000.0, 45.0, 800.0)
        .unwrap();
    assert!(!p3.extrapolated && p3.t_c == 45.0 && p3.a == 0.5);
    let want = extract_iv_parameters(&mid.v, &mid.i).unwrap();
    assert!(approx(p3.parameters.i_sc_a, want.i_sc_a, 0.005));
    assert!(approx(p3.parameters.p_max_w, want.p_max_w, 0.01));
    let out = interpolate_procedure_3(
        &lo.v, &lo.i, 600.0, 45.0, &mid.v, &mid.i, 800.0, 45.0, 1000.0,
    )
    .unwrap();
    assert!(out.extrapolated);
    assert!(
        interpolate_procedure_3(&lo.v, &lo.i, 600.0, 45.0, &lo.v, &lo.i, 600.0, 50.0, 1000.0)
            .is_err()
    );
}

#[test]
fn sweep_below_the_stc_gate_is_not_judged_except_for_steps() {
    let s = spec();
    let at = Some("2026-11-10 12:00:00");
    let c = field(450.0, 38.0);
    let cls = analyze_iv_sweep(&c.v, &c.i, Some(450.0), Some(38.0), at, &s, &opts10())
        .unwrap()
        .classification
        .base;
    assert!(
        cls.signature == "not_judged"
            && cls.unjudged_signature == Some("miswiring_or_module_count")
    );
    assert!(!cls.is_finding && !cls.ticket_recommended);
    assert!(!cls.stc_comparison_valid && !cls.warranty.below_warranted_power);
    let (v, i) = synth(Synth {
        add_step: true,
        ..m10()
    });
    let cls = analyze_iv_sweep(&v, &i, Some(500.0), Some(25.0), at, &s, &opts10())
        .unwrap()
        .classification
        .base;
    assert!(
        cls.signature == "steps_in_curve"
            && cls.ticket_recommended
            && cls.unjudged_signature.is_none()
    );
    let ok = run_sweep(
        &synth(Synth {
            isc_scale: 0.84,
            ..m10()
        }),
        opts10(),
    )
    .classification
    .base;
    assert!(ok.signature == "isc_low_normal_shape" && ok.unjudged_signature.is_none());
}

#[test]
fn sweep_past_voc_reads_voc_at_the_first_zero_current_point() {
    let (v, i) = synth(m10());
    let voc = v[v.len() - 1];
    let step = v[v.len() - 1] - v[v.len() - 2];
    let mut vp = v.clone();
    let mut ip = i.clone();
    for k in 1..6 {
        vp.push(numpy::py_round(voc + k as f64 * step, 2));
        ip.push(0.0);
    }
    assert_eq!(
        extract_iv_parameters(&vp, &ip).unwrap().v_oc_v,
        numpy::py_round(voc, 2)
    );
    let (a, b) = (run_sweep(&(v, i), opts10()), run_sweep(&(vp, ip), opts10()));
    assert_eq!(b.stc.parameters.v_oc_v, a.stc.parameters.v_oc_v);
    assert!(
        b.classification.base.signature == "normal" && a.classification.base.signature == "normal"
    );
}

#[test]
fn low_shunt_curve_with_lowered_voc_is_not_read_as_a_structural_fault() {
    let cls = run_sweep(
        &synth(Synth {
            rsh_ohm: Some(55.0),
            ..m10()
        }),
        opts10(),
    )
    .classification
    .base;
    assert!(cls.deviations_pct.v_oc_vs_stc_pct < -2.0);
    assert_eq!(cls.signature, "low_shunt_resistance");
}

// ----------------------------------------------------------- test_string_operating.py

fn gates() -> JudgeCriteria {
    // backend/app/services/string_live_criteria.json "gates"
    JudgeCriteria {
        stale_s: 600.0,
        weather_max_gap_s: 300.0,
        irradiance_min_wm2: 400.0,
        sanity_current_max: 1.25,
        sanity_voltage_max: 1.1,
        off_mpp_voltage_ratio: 1.05,
    }
}

#[test]
fn curve_matches_the_datasheet_at_stc_and_scales_with_conditions() {
    let s = spec();
    let c = string_curve_at(&s, 18, Some(1000.0), Some(25.0), 80).unwrap();
    assert!(approx(c.p_mp_w, 18.0 * s.wp, 0.01));
    assert!(approx(c.v_oc_v, 18.0 * s.voc_stc, 0.01));
    assert!(approx(c.i_sc_a, s.isc_stc, 0.01));
    assert!(approx(c.v_mp_v, 18.0 * s.vmp_stc, 0.01));
    let hot = string_curve_at(&s, 18, Some(800.0), Some(58.0), 80).unwrap();
    assert!(approx(hot.i_sc_a, 0.8 * s.isc_stc, 0.03));
    assert!(hot.v_oc_v < c.v_oc_v && hot.p_mp_w < 0.8 * c.p_mp_w);
    assert!(c.points[0].v == 0.0 && c.points[c.points.len() - 1].i.abs() <= 0.05);
    assert!(string_curve_at(&s, 0, Some(800.0), Some(50.0), 80).is_none());
    assert!(string_curve_at(&s, 18, Some(0.0), Some(50.0), 80).is_none());
}

#[test]
fn judge_point_gates() {
    let g = gates();
    let curve = string_curve_at(&spec(), 18, Some(800.0), Some(55.0), 80).unwrap();
    let ok = judge_point(
        Some(curve.v_mp_v),
        Some(curve.i_mp_a * 0.95),
        Some(&curve),
        Some(800.0),
        &g,
        &JudgeOptions {
            inverter_status: Some(1),
            record_age_s: Some(60.0),
            weather_gap_s: Some(60.0),
            ..Default::default()
        },
    );
    assert!(ok.diagnostic && ok.gates.is_empty());
    assert!((ok.r_imp.unwrap() - 0.95).abs() <= 0.002 && (ok.r_v.unwrap() - 1.0).abs() <= 0.002);
    let off = judge_point(
        Some(curve.v_oc_v * 0.97),
        Some(1.0),
        Some(&curve),
        Some(800.0),
        &g,
        &JudgeOptions {
            inverter_status: Some(1),
            ..Default::default()
        },
    );
    assert!(off.gates.contains(&"off_mpp") && !off.diagnostic);
    let d = JudgeOptions::default();
    assert!(
        judge_point(Some(700.0), Some(4.0), Some(&curve), Some(300.0), &g, &d)
            .gates
            .contains(&"low_irradiance")
    );
    assert!(judge_point(
        Some(700.0),
        Some(9.0),
        Some(&curve),
        Some(800.0),
        &g,
        &JudgeOptions {
            record_age_s: Some(3600.0),
            ..Default::default()
        }
    )
    .gates
    .contains(&"stale"));
    assert!(judge_point(
        Some(700.0),
        Some(9.0),
        Some(&curve),
        Some(800.0),
        &g,
        &JudgeOptions {
            weather_gap_s: Some(900.0),
            ..Default::default()
        }
    )
    .gates
    .contains(&"weather_not_aligned"));
    assert!(judge_point(
        Some(700.0),
        Some(9.0),
        Some(&curve),
        Some(800.0),
        &g,
        &JudgeOptions {
            limited: true,
            ..Default::default()
        }
    )
    .gates
    .contains(&"clipped_or_limited"));
    assert!(
        judge_point(Some(700.0), Some(40.0), Some(&curve), Some(800.0), &g, &d)
            .gates
            .contains(&"out_of_range")
    );
    let none = judge_point(Some(700.0), Some(9.0), None, Some(800.0), &g, &d);
    assert!(none.r_imp.is_none() && none.gates == ["no_model"]);
}
