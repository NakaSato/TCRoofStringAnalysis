//! Parity of the weather parsers with Python (`backend/solar_core/{google_weather,longdo_weather,
//! rainviewer}.py`) over the fixtures written by `tests/fixtures/weather_gen.py`.
//!
//! Cases where Python raises (a malformed shape it calls `.get` on, ...) are not compared: Rust
//! treats the malformed part as missing, and the test checks only that it does not panic
//! (RainViewer's own `RainViewerError`s are compared, message included).
//!
//! One known, intended difference is normalised before comparing: the Google passthrough fields
//! (`condition`, `condition_text`, `icon_uri`, `precip_type`, `time_zone`; `is_daytime`) keep only
//! a string (bool), where Python passes any JSON type through.

use serde_json::Value;
use tcroof_clients::google_weather::{self as gw, py};
use tcroof_clients::{longdo_weather as lw, rainviewer as rv};

fn fixtures() -> Value {
    let path = format!("{}/tests/fixtures/weather.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).expect("JSON")
}

fn cases<'a>(fx: &'a Value, key: &str) -> &'a [Value] {
    fx[key].as_array().unwrap_or_else(|| panic!("fixture {key}"))
}

/// A fixture float: numbers, or "nan" / "inf" / "-inf".
fn fx_f(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(match s.as_str() {
            "nan" => f64::NAN,
            "inf" => f64::INFINITY,
            "-inf" => f64::NEG_INFINITY,
            o => panic!("not a float: {o}"),
        }),
        v => Some(v.as_f64().expect("number")),
    }
}

fn same_f(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => (a.is_nan() && b.is_nan()) || a == b || (a - b).abs() <= 1e-6,
        _ => false,
    }
}

/// Deep JSON equality, numbers within 1e-6.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => same_f(a.as_f64(), b.as_f64()),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

struct Tally {
    name: &'static str,
    compared: usize,
    raises: usize,
    failures: Vec<String>,
}

impl Tally {
    fn new(name: &'static str) -> Self {
        Self { name, compared: 0, raises: 0, failures: vec![] }
    }
    fn check(&mut self, case: &Value, got: Value, expected: &Value) {
        self.compared += 1;
        if !same(&got, expected) {
            self.failures.push(format!("{} {}: in {}\n  python {}\n  rust   {}", self.name, case["name"], case["in"], expected, got));
        }
    }
    fn finish(self) {
        eprintln!("{}: {} compared, {} Python-raises skipped", self.name, self.compared, self.raises);
        assert!(self.failures.is_empty(), "{} mismatches:\n{}", self.failures.len(), self.failures.join("\n"));
    }
}

/// Run `f` over every case of `key`; cases where Python raised only have to not panic.
fn parity(fx: &Value, key: &'static str, f: impl Fn(&Value) -> Value, normalise: impl Fn(&mut Value)) {
    let mut t = Tally::new(key);
    for case in cases(fx, key) {
        let got = f(&case["in"]);
        if case.get("raises").is_some() {
            t.raises += 1;
            continue;
        }
        let mut expected = case["out"].clone();
        normalise(&mut expected);
        t.check(case, got, &expected);
    }
    t.finish();
}

fn json<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).expect("serialize")
}

/// The Google passthrough fields: a non-string (non-bool) Python value is None in Rust.
fn normalise_google(v: &mut Value) {
    let Some(o) = v.as_object_mut() else { return };
    for k in ["condition", "condition_text", "icon_uri", "precip_type", "time_zone"] {
        if o.get(k).is_some_and(|x| !x.is_string()) {
            o.insert(k.into(), Value::Null);
        }
    }
    if o.get("is_daytime").is_some_and(|x| !x.is_boolean()) {
        o.insert("is_daytime".into(), Value::Null);
    }
}

#[test]
fn scalars() {
    let fx = fixtures();
    let mut failures = vec![];
    for (key, f) in [
        ("g_num", (|v: &Value| py::float_value(v, true)) as fn(&Value) -> Option<f64>),
        ("l_float", |v: &Value| lw::float(Some(v))),
    ] {
        for c in cases(&fx, key) {
            let got = f(&c["in"]);
            if !same_f(got, fx_f(&c["out"])) {
                failures.push(format!("{key} {}: python {} rust {got:?}", c["in"], c["out"]));
            }
        }
    }
    for c in cases(&fx, "l_int") {
        let got = lw::int(Some(&c["in"]));
        if got != c["out"].as_i64() {
            failures.push(format!("l_int {}: python {} rust {got:?}", c["in"], c["out"]));
        }
    }
    for c in cases(&fx, "round") {
        let (x, d) = (c["x"].as_f64().unwrap(), c["d"].as_u64().unwrap() as usize);
        let got = py::round(x, d);
        if got != c["out"].as_f64().unwrap() {
            failures.push(format!("round({x}, {d}): python {} rust {got}", c["out"]));
        }
    }
    for c in cases(&fx, "repr") {
        let got = py::repr_f64(c["x"].as_f64().unwrap());
        if got != c["out"].as_str().unwrap() {
            failures.push(format!("repr({}): python {} rust {got}", c["x"], c["out"]));
        }
    }
    for c in cases(&fx, "fmt5") {
        let x = c["x"].as_f64().unwrap();
        let got = format!("{x:.5}");
        if got != c["out"].as_str().unwrap() {
            failures.push(format!("{x}:.5f: python {} rust {got}", c["out"]));
        }
    }
    for c in cases(&fx, "utc") {
        let got = gw::utc(Some(&c["in"])).map(|t| py::isoformat_utc(&t));
        if got.as_deref() != c["out"].as_str() {
            failures.push(format!("_utc({}): python {} rust {got:?}", c["in"], c["out"]));
        }
    }
    for c in cases(&fx, "local_naive") {
        let got = gw::local_naive(Some(&c["in"])).map(|t| py::isoformat_naive(&t));
        if got.as_deref() != c["out"].as_str() {
            failures.push(format!("_local_naive({}): python {} rust {got:?}", c["in"], c["out"]));
        }
    }
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn google_parse_current() {
    parity(&fixtures(), "parse_current", |v| json(gw::parse_current(v)), normalise_google);
}

#[test]
fn google_parse_history_hour() {
    parity(&fixtures(), "parse_history_hour", |v| json(gw::parse_history_hour(v)), normalise_google);
}

#[test]
fn longdo_parsers() {
    let fx = fixtures();
    let none = |_: &mut Value| {};
    parity(&fx, "parse_frames", |v| json(lw::parse_frames(v)), none);
    parity(&fx, "parse_rain", |v| json(lw::parse_rain(Some(v))), none);
    parity(&fx, "parse_forecast", |v| json(lw::parse_forecast(v)), none);
    parity(&fx, "parse_area_stats", |v| json(lw::parse_area_stats(Some(v))), none);
    parity(&fx, "parse_forecast_area", |v| json(lw::parse_forecast_area(v)), none);
    parity(&fx, "parse_legend", |v| json(lw::parse_legend(v)), none);
}

#[test]
fn rainviewer_parse_maps() {
    let fx = fixtures();
    let mut t = Tally::new("parse_maps");
    for case in cases(&fx, "parse_maps") {
        let got = rv::parse_maps(&case["in"]);
        match (case["raises"].as_str(), got) {
            (Some("RainViewerError"), got) => {
                let msg = case["msg"].as_str().unwrap();
                t.check(case, json(got.err().map(|e| e.0)), &Value::from(msg));
            }
            (Some(_), _) => t.raises += 1,
            (None, got) => t.check(case, json(got.ok()), &case["out"]),
        }
    }
    t.finish();
}
