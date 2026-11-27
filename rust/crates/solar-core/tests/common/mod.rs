//! Shared helpers of the parity tests: load a fixture written by fixtures/gen.py, read its
//! floats ("nan" / "inf" / "-inf" strings for non-finite values) and compare within 1e-6.
#![allow(dead_code)]

use chrono::NaiveDate;
use serde_json::Value;

pub fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A fixture float; None for JSON null.
pub fn opt_f(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::Number(n) => Some(n.as_f64().expect("f64")),
        Value::String(s) => Some(match s.as_str() {
            "nan" => f64::NAN,
            "inf" => f64::INFINITY,
            "-inf" => f64::NEG_INFINITY,
            other => panic!("not a float: {other}"),
        }),
        other => panic!("not a float: {other}"),
    }
}

pub fn f(v: &Value) -> f64 {
    opt_f(v).expect("float, not null")
}

pub fn date(v: &Value) -> NaiveDate {
    NaiveDate::parse_from_str(v.as_str().expect("date string"), "%Y-%m-%d").expect("ISO date")
}

pub fn dates(v: &Value) -> Vec<NaiveDate> {
    v.as_array().expect("array").iter().map(date).collect()
}

/// Within 1e-6 absolute or relative (both NaN, or equal infinities, also match).
pub fn close(a: f64, b: f64) -> bool {
    if a.is_nan() || b.is_nan() {
        return a.is_nan() && b.is_nan();
    }
    if a == b {
        return true;
    }
    let diff = (a - b).abs();
    diff <= 1e-6 || diff <= 1e-6 * a.abs().max(b.abs())
}

pub fn close_opt(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => close(x, y),
        _ => false,
    }
}
