//! Parity of `visit_route` with backend/solar_core/visit_route.py (fixtures/visit_route.json):
//! the same order exactly, times within 1e-6, the same error kind.
mod common;

use common::{close, close_opt, f, load, opt_f};
use serde_json::Value;
use tcroof_solar_core::visit_route::{
    evaluate, internals, solve, EndMode, RouteError, Solution, StopSpec,
};

fn matrix(v: &Value) -> Vec<Vec<Option<f64>>> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_array().unwrap().iter().map(opt_f).collect())
        .collect()
}

fn stops(v: &Value) -> Vec<StopSpec> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| StopSpec {
            service_min: f(&s[0]),
            window: s[1].as_array().map(|w| (f(&w[0]), f(&w[1]))),
        })
        .collect()
}

fn usizes(v: &Value) -> Vec<usize> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap() as usize)
        .collect()
}

fn run(c: &Value) -> Result<Solution, RouteError> {
    let end_mode = EndMode::parse(c["end_mode"].as_str().unwrap())?;
    let m = matrix(&c["matrix"]);
    let st = stops(&c["stops"]);
    let leave = f(&c["leave_min"]);
    if c["kind"] == "evaluate" {
        evaluate(&m, &st, &usizes(&c["order"]), leave, end_mode)
    } else {
        solve(&m, &st, leave, end_mode, c["keep_order"].as_bool().unwrap())
    }
}

fn assert_solution(got: &Solution, want: &Value, c: &Value) {
    assert_eq!(got.order, usizes(&want["order"]), "order differs: {c}");
    assert_eq!(got.method.as_str(), want["method"].as_str().unwrap(), "{c}");
    let ws = want["stops"].as_array().unwrap();
    assert_eq!(got.stops.len(), ws.len());
    for (g, w) in got.stops.iter().zip(ws) {
        assert_eq!(g.index as u64, w[0].as_u64().unwrap());
        for (x, y) in [
            g.leg_drive_min,
            g.arrive_min,
            g.wait_min,
            g.depart_min,
            g.late_min,
        ]
        .iter()
        .zip(&w.as_array().unwrap()[1..])
        {
            assert!(close(*x, f(y)), "stop times differ: {g:?} vs {w}");
        }
    }
    assert!(
        close_opt(got.end_leg_drive_min, opt_f(&want["end_leg_drive_min"])),
        "{c}"
    );
    assert!(
        close_opt(got.end_arrive_min, opt_f(&want["end_arrive_min"])),
        "{c}"
    );
    for (x, k) in [
        (got.finish_min, "finish_min"),
        (got.drive_min, "drive_min"),
        (got.wait_min, "wait_min"),
        (got.late_min, "late_min"),
    ] {
        assert!(close(x, f(&want[k])), "{k}: {x} vs {}", want[k]);
    }
}

#[test]
fn solve_and_evaluate_match_python() {
    let fx = load("visit_route.json");
    let cases = fx["cases"].as_array().unwrap();
    let mut by_method = std::collections::BTreeMap::<String, usize>::new();
    for c in cases {
        let got = run(c);
        match c.get("error").and_then(Value::as_str) {
            Some("TooManyStops") => assert!(
                matches!(got, Err(RouteError::TooManyStops(_))),
                "{c} -> {got:?}"
            ),
            Some(_) => assert!(matches!(got, Err(RouteError::Invalid(_))), "{c} -> {got:?}"),
            None => {
                let got = got.unwrap_or_else(|e| panic!("{e}: {c}"));
                assert_solution(&got, &c["result"], c);
                *by_method
                    .entry(got.method.as_str().to_string())
                    .or_default() += 1;
            }
        }
    }
    assert!(
        by_method["exact"] > 300 && by_method["heuristic"] > 50,
        "{by_method:?}"
    );
}

#[test]
fn heuristic_internals_match_python() {
    let fx = load("visit_route.json");
    for c in fx["internals"].as_array().unwrap() {
        let m: Vec<Vec<f64>> = matrix(&c["matrix"])
            .into_iter()
            .map(|r| r.into_iter().map(Option::unwrap).collect())
            .collect();
        let (near, randomised, heur, exact) = internals::starts_and_orders(
            &m,
            &stops(&c["stops"]),
            f(&c["leave_min"]),
            EndMode::Return,
        )
        .unwrap();
        assert_eq!(near, usizes(&c["nearest"]));
        let want_r: Vec<Vec<usize>> = c["nearest_random"]
            .as_array()
            .unwrap()
            .iter()
            .map(usizes)
            .collect();
        assert_eq!(randomised, want_r);
        assert_eq!(heur, usizes(&c["heuristic"]));
        assert_eq!(exact, usizes(&c["exact"]));
    }
}

#[test]
fn python_random_stream_matches() {
    let fx = load("visit_route.json");
    let s = fx["randrange_seed7"].as_array().unwrap();
    let ks: Vec<u32> = s.iter().map(|p| p[0].as_u64().unwrap() as u32).collect();
    let want: Vec<u32> = s.iter().map(|p| p[1].as_u64().unwrap() as u32).collect();
    assert_eq!(internals::randrange_stream(7, &ks), want);
}
