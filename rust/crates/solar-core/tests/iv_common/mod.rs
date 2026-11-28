//! Shared helpers of the I-V parity tests: compare a Rust result, serialized to JSON, with
//! the fixture written by fixtures/iv_gen.py (floats within 1e-6 abs or rel, everything else
//! exact, the same keys), and compare errors by Python class name and message.
#![allow(dead_code)]

use serde::Serialize;
use serde_json::Value;
use tcroof_core::iv_analysis::{IvError, ModuleStcSpec};

/// Within 1e-6 absolute or relative.
pub fn close(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let diff = (a - b).abs();
    diff <= 1e-6 || diff <= 1e-6 * a.abs().max(b.abs())
}

/// Largest absolute difference seen between two matching floats (for the report).
#[derive(Default, Debug)]
pub struct Stats {
    pub floats: usize,
    pub max_abs: f64,
    pub max_rel: f64,
    /// Known rounding-tie differences accepted (see [`KNOWN_ROUNDING_TIES`]).
    pub ties: usize,
}

/// Cases where Python's intermediate lands on a decimal tie of the final `round()` and the
/// last-bit difference between LAPACK `gelsd` (NumPy) and the Jacobi SVD here (both ~1e-13
/// off the exact value, in opposite directions) rounds the other way: (case name part, key,
/// allowed difference = one unit of the rounded digit).
///
/// - short_circuit_only: Rsh slope −0.05 is −0.050000000000004 in NumPy, −0.049999999999994
///   here, so I_L = 9·(1 + 0.005/Rsh) ≈ 9.00225 rounds to 9.0023 vs 9.0022.
pub const KNOWN_ROUNDING_TIES: [(&str, &str, f64); 1] =
    [("short_circuit_only", ".i_l_a", 1.0001e-4)];

/// `got` (serialized Rust) against `want` (fixture). serde_json writes a non-finite f64 as
/// null, so a fixture "nan" / "inf" / "-inf" matches null.
pub fn compare(path: &str, got: &Value, want: &Value, st: &mut Stats) -> Result<(), String> {
    match (got, want) {
        (Value::Null, Value::String(s)) if matches!(s.as_str(), "nan" | "inf" | "-inf") => Ok(()),
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            st.floats += 1;
            let d = (a - b).abs();
            st.max_abs = st.max_abs.max(d);
            if b != 0.0 {
                st.max_rel = st.max_rel.max(d / b.abs());
            }
            if close(a, b) {
                Ok(())
            } else if KNOWN_ROUNDING_TIES
                .iter()
                .any(|(case, key, tol)| path.contains(case) && path.ends_with(key) && d <= *tol)
            {
                st.ties += 1;
                Ok(())
            } else {
                Err(format!("{path}: rust {a} != python {b}"))
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Err(format!(
                    "{path}: rust len {} != python len {}",
                    a.len(),
                    b.len()
                ));
            }
            for (k, (x, y)) in a.iter().zip(b).enumerate() {
                compare(&format!("{path}[{k}]"), x, y, st)?;
            }
            Ok(())
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut ka: Vec<&String> = a.keys().collect();
            let mut kb: Vec<&String> = b.keys().collect();
            ka.sort();
            kb.sort();
            if ka != kb {
                return Err(format!("{path}: rust keys {ka:?} != python keys {kb:?}"));
            }
            for k in kb {
                compare(&format!("{path}.{k}"), &a[k], &b[k], st)?;
            }
            Ok(())
        }
        (a, b) if a == b => Ok(()),
        (a, b) => Err(format!("{path}: rust {a} != python {b}")),
    }
}

/// A fixture case's expected outcome against a Rust result.
pub fn check<T: Serialize>(
    name: &str,
    got: Result<T, IvError>,
    case: &Value,
    st: &mut Stats,
) -> Result<(), String> {
    match (got, case.get("result")) {
        (Ok(r), Some(want)) => compare(name, &serde_json::to_value(r).unwrap(), want, st),
        (Err(e), None) => {
            let (kind, msg) = (
                case["error"].as_str().unwrap(),
                case["message"].as_str().unwrap(),
            );
            if e.kind() == kind && e.message() == msg {
                Ok(())
            } else {
                Err(format!(
                    "{name}: rust {}({}) != python {kind}({msg})",
                    e.kind(),
                    e.message()
                ))
            }
        }
        (Ok(r), None) => Err(format!(
            "{name}: rust Ok({}) but python {}({})",
            serde_json::to_value(r).unwrap(),
            case["error"],
            case["message"]
        )),
        (Err(e), Some(_)) => Err(format!(
            "{name}: rust {}({}) but python returned a result",
            e.kind(),
            e.message()
        )),
    }
}

/// Run every case, collect failures, panic with them all.
pub fn run_all(
    name: &str,
    cases: &[Value],
    mut f: impl FnMut(usize, &Value, &mut Stats) -> Result<(), String>,
) {
    let mut st = Stats::default();
    let fails: Vec<String> = cases
        .iter()
        .enumerate()
        .filter_map(|(k, c)| f(k, c, &mut st).err())
        .collect();
    eprintln!(
        "{name}: {} cases, {} floats compared, max abs diff {:e}, max rel diff {:e}, known ties {}",
        cases.len(),
        st.floats,
        st.max_abs,
        st.max_rel,
        st.ties
    );
    assert!(
        fails.is_empty(),
        "{name}: {} of {} cases differ:\n{}",
        fails.len(),
        cases.len(),
        fails.join("\n")
    );
}

/// A JSON value with "nan" / "inf" strings replaced by null, for serde into option structs.
pub fn finite_only(v: &Value) -> Value {
    match v {
        Value::String(s) if matches!(s.as_str(), "nan" | "inf" | "-inf") => Value::Null,
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, x)| (k.clone(), finite_only(x))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(finite_only).collect()),
        other => other.clone(),
    }
}

pub fn de<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(finite_only(v)).unwrap_or_else(|e| panic!("{v}: {e}"))
}

pub fn spec(fx: &Value, name: &str) -> ModuleStcSpec {
    de(&fx["specs"][name])
}

/// A fixture float ("nan" / "inf" / "-inf" strings for non-finite); None for null.
pub fn opt_f(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::Number(n) => n.as_f64(),
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

pub fn fvec(v: &Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(f).collect()
}

pub fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}
