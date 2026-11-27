//! Port of `backend/app/services/live_string_check.py`: string status from the newest live record
//! (realtime, memory only, never stored). Each string is compared with the other strings of the
//! same inverter at the same moment; a fault is flagged only when the older records of the same
//! answer agree. See the Python module for the reasoning behind each threshold.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Map, Value};

use crate::common::{py_median, py_round};

/// Python `Layout`: (device_sn, string_no) → modules (the module rating is not used here).
pub type Layout = HashMap<(String, i64), i64>;

/// Python `MIN_MEDIAN_A`
pub const MIN_MEDIAN_A: f64 = 1.0;
/// Python `WARN_MIN_MEDIAN_A`
pub const WARN_MIN_MEDIAN_A: f64 = 3.0;
/// Python `OPEN_A`
pub const OPEN_A: f64 = 0.3;
/// Python `WARN_CURRENT_PCT`
pub const WARN_CURRENT_PCT: f64 = -15.0;
/// Python `CRIT_CURRENT_PCT`
pub const CRIT_CURRENT_PCT: f64 = -40.0;
/// Python `WARN_VOLTAGE_PCT`
pub const WARN_VOLTAGE_PCT: f64 = -8.0;
/// Python `MIN_PEERS`
pub const MIN_PEERS: usize = 3;

fn rank(status: &str) -> u8 {
    match status {
        "Warning" => 1,
        "Critical" => 2,
        _ => 0,
    }
}

/// One string of a record: (string_no, voltage_v, current_a).
#[derive(Debug, Clone, Copy)]
struct Str {
    no: i64,
    v: Option<f64>,
    i: Option<f64>,
}

fn strings_of(v: &Value) -> Vec<Str> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some(Str {
                        no: s.get("string_no")?.as_i64()?,
                        v: s.get("voltage_v").and_then(Value::as_f64),
                        i: s.get("current_a").and_then(Value::as_f64),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Python `_pct`
fn pct(v: f64, r: f64) -> f64 {
    (v - r) / r * 100.0
}

/// Python `_none`
fn none(reason: &str) -> Value {
    json!({"status": null, "current_dev_pct": null, "voltage_dev_pct": null, "reason": reason})
}

/// Python `f"{x:+.0f}"`
fn signed0(x: f64) -> String {
    format!("{x:+.0}")
}

/// Python `_judge`: per-string status from one record.
fn judge(sn: &str, strings: &[Str], layout: &Layout, wired: Option<&BTreeSet<i64>>) -> Map<String, Value> {
    let strings: Vec<Str> = match wired {
        Some(w) => strings.iter().copied().filter(|s| w.contains(&s.no)).collect(),
        None => strings.to_vec(),
    };
    let rows: Vec<Str> = strings.iter().copied().filter(|s| s.i.is_some_and(|i| wired.is_some() || i > OPEN_A)).collect();
    let mut out = Map::new();
    out.insert("median_current_a".into(), Value::Null);
    out.insert("voltage_basis".into(), Value::Null);
    let all_none = |reason: &str| -> Value {
        Value::Object(strings.iter().map(|s| (s.no.to_string(), none(reason))).collect())
    };
    if rows.len() < MIN_PEERS {
        out.insert("status".into(), json!("too_few_strings"));
        out.insert("strings".into(), all_none("fewer than 3 strings reporting"));
        return out;
    }
    let cur = |s: &Str| s.i.expect("rows have a current");
    let carrying: Vec<f64> = rows.iter().map(cur).filter(|i| *i > OPEN_A).collect();
    let basis = if carrying.len() >= MIN_PEERS { carrying } else { rows.iter().map(cur).collect() };
    let med_i = py_median(&basis).expect("at least 3 values");
    out.insert("median_current_a".into(), json!(py_round(med_i, 2)));
    if med_i < MIN_MEDIAN_A {
        out.insert("status".into(), json!("low_light"));
        out.insert("strings".into(), all_none("too little light to compare"));
        return out;
    }
    out.insert("status".into(), json!("ok"));

    let modules = |no: i64| layout.get(&(sn.to_owned(), no)).copied();
    let per_module = rows.iter().all(|s| modules(s.no).is_some_and(|m| m > 0));
    let mut med_v: Option<f64> = None;
    if per_module {
        let vols: Vec<f64> = rows
            .iter()
            .filter(|s| s.v.is_some_and(|v| v != 0.0))
            .map(|s| s.v.unwrap_or(0.0) / modules(s.no).unwrap_or(1) as f64)
            .collect();
        med_v = if vols.len() >= MIN_PEERS { py_median(&vols) } else { None };
        // `"per_module" if med_v else None`: a median of 0 is falsy
        if med_v.is_some_and(|m| m != 0.0) {
            out.insert("voltage_basis".into(), json!("per_module"));
        }
    }
    let med_v = med_v.filter(|m| *m != 0.0);

    let mut per = Map::new();
    for s in &strings {
        let key = s.no.to_string();
        let Some(i) = s.i else {
            per.insert(key, none("no current reported"));
            continue;
        };
        if wired.is_none() && i <= OPEN_A {
            per.insert(key, none("0 A, and not known to be wired (enter it on String Layout)"));
            continue;
        }
        let strong = med_i >= WARN_MIN_MEDIAN_A;
        let i_dev = pct(i, med_i);
        let v_dev = match (med_v, s.v.filter(|v| *v != 0.0)) {
            (Some(mv), Some(v)) => Some(pct(v / modules(s.no).unwrap_or(1) as f64, mv)),
            _ => None,
        };
        let (status, reason) = if i <= OPEN_A {
            ("Critical", format!("No current now ({i:.2} A) while peers carry {med_i:.1} A: open string, fuse or connector"))
        } else if strong && i_dev <= CRIT_CURRENT_PCT {
            ("Critical", format!("Current {}% vs inverter median now", signed0(i_dev)))
        } else if strong && i_dev <= WARN_CURRENT_PCT {
            ("Warning", format!("Current {}% vs inverter median now: soiling, shading or a weak module", signed0(i_dev)))
        } else if strong && v_dev.is_some_and(|d| d <= WARN_VOLTAGE_PCT) {
            (
                "Warning",
                format!("Voltage per module {}% vs median now: possible bypass diode / module fault", signed0(v_dev.unwrap_or(0.0))),
            )
        } else {
            ("Healthy", if strong { "Within peers now".to_owned() } else { "No open string (light too weak to judge mismatch)".to_owned() })
        };
        per.insert(
            key,
            json!({
                "status": status,
                "current_dev_pct": py_round(i_dev, 1),
                "voltage_dev_pct": v_dev.map(|d| py_round(d, 1)),
                "reason": reason,
            }),
        );
    }
    out.insert("strings".into(), Value::Object(per));
    out
}

/// Python `check_inverter`: the newest record judged, a Warning / Critical kept only if each
/// older record in `previous` (newest first) agrees; the mildest verdict wins.
pub fn check_inverter(
    sn: &str,
    strings: &Value,
    layout: &Layout,
    wired: Option<&BTreeSet<i64>>,
    previous: &[Value],
) -> Map<String, Value> {
    let mut out = judge(sn, &strings_of(strings), layout, wired);
    let older: Vec<Map<String, Value>> = previous
        .iter()
        .filter(|p| p.as_array().is_some_and(|a| !a.is_empty()))
        .map(|p| match judge(sn, &strings_of(p), layout, wired).remove("strings") {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        })
        .collect();
    out.insert("records_judged".into(), json!(1 + older.len()));
    if let Some(Value::Object(per)) = out.get_mut("strings") {
        for (no, v) in per.iter_mut() {
            let status = v.get("status").and_then(Value::as_str).unwrap_or("").to_owned();
            if status != "Warning" && status != "Critical" {
                continue;
            }
            let mild = older
                .iter()
                .map(|o| rank(o.get(no).and_then(|x| x.get("status")).and_then(Value::as_str).unwrap_or("Healthy")))
                .min()
                .unwrap_or(rank(&status));
            if mild < rank(&status) {
                let cut = if mild == 1 { "Warning" } else { "Healthy" };
                let reason = v.get("reason").and_then(Value::as_str).unwrap_or("").to_owned();
                v["reason"] = json!(format!("{reason} (in the newest record only: not yet confirmed)"));
                v["status"] = json!(cut);
            }
        }
    }
    out
}

/// Python `check_plant`: the live string check for every inverter of a `/latest` payload.
pub fn check_plant(inverters: &[Value], layout: &Layout, wired: &HashMap<String, BTreeSet<i64>>) -> Value {
    let mut per = Map::new();
    let mut counts: BTreeMap<&str, i64> = [("healthy", 0), ("warning", 0), ("critical", 0), ("unknown", 0)].into_iter().collect();
    let mut times: Vec<String> = Vec::new();
    let mut checked = 0;
    for inv in inverters {
        let sn = inv.get("device_sn").and_then(Value::as_str).unwrap_or("").to_owned();
        let prev: Vec<Value> = inv
            .get("previous_strings")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|p| p.get("strings").filter(|s| !s.is_null()).cloned().unwrap_or(json!([]))).collect())
            .unwrap_or_default();
        let strings = inv.get("strings").cloned().unwrap_or(json!([]));
        let mut r = check_inverter(&sn, &strings, layout, wired.get(&sn), &prev);
        let ts = inv.get("timestamp").cloned().unwrap_or(Value::Null);
        let ok = r.get("status").and_then(Value::as_str) == Some("ok");
        if ok {
            checked += 1;
            if let Some(t) = ts.as_str().filter(|t| !t.is_empty()) {
                times.push(t.to_owned());
            }
        }
        if let Some(Value::Object(strs)) = r.get("strings") {
            for v in strs.values() {
                let bucket = match v.get("status").and_then(Value::as_str) {
                    Some("Healthy") => "healthy",
                    Some("Warning") => "warning",
                    Some("Critical") => "critical",
                    _ => "unknown",
                };
                *counts.get_mut(bucket).expect("bucket") += 1;
            }
        }
        r.insert("timestamp".into(), ts);
        r.insert("stale".into(), json!(inv.get("stale").and_then(Value::as_bool).unwrap_or(false)));
        per.insert(sn, Value::Object(r));
    }
    let mut summary: Map<String, Value> = counts.into_iter().map(|(k, v)| (k.to_owned(), json!(v))).collect();
    summary.insert("checked_inverters".into(), json!(checked));
    summary.insert("at".into(), json!(times.into_iter().max()));
    json!({"inverters": per, "summary": summary})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(cur: &[f64]) -> Value {
        Value::Array(
            cur.iter().enumerate().map(|(n, i)| json!({"string_no": n + 1, "voltage_v": 600.0, "current_a": i})).collect(),
        )
    }

    #[test]
    fn open_string_is_critical_only_when_confirmed() {
        let layout = Layout::new();
        let now = strs(&[8.0, 8.1, 7.9, 0.0]);
        let wired: BTreeSet<i64> = [1, 2, 3, 4].into_iter().collect();
        let r = check_inverter("SN", &now, &layout, Some(&wired), &[strs(&[8.0, 8.0, 8.0, 0.1])]);
        assert_eq!(r["status"], json!("ok"));
        assert_eq!(r["records_judged"], json!(2));
        assert_eq!(r["strings"]["4"]["status"], json!("Critical"));
        assert!(r["strings"]["4"]["reason"].as_str().unwrap().starts_with("No current now (0.00 A) while peers carry 8.0 A"));
        // the older record has the string healthy: not confirmed
        let r = check_inverter("SN", &now, &layout, Some(&wired), &[strs(&[8.0, 8.0, 8.0, 8.0])]);
        assert_eq!(r["strings"]["4"]["status"], json!("Healthy"));
        assert!(r["strings"]["4"]["reason"].as_str().unwrap().ends_with("(in the newest record only: not yet confirmed)"));
    }

    #[test]
    fn low_light_and_unwired() {
        let layout = Layout::new();
        let r = check_inverter("SN", &strs(&[0.5, 0.6, 0.5]), &layout, None, &[]);
        assert_eq!(r["status"], json!("low_light"));
        let r = check_inverter("SN", &strs(&[8.0, 8.0, 8.0, 0.0]), &layout, None, &[]);
        assert_eq!(r["strings"]["4"]["status"], Value::Null);
        let r = check_inverter("SN", &strs(&[8.0, 6.0, 8.0, 8.0]), &layout, None, &[]);
        assert_eq!(r["strings"]["2"]["status"], json!("Warning"));
        assert_eq!(r["strings"]["2"]["current_dev_pct"], json!(-25.0));
        assert_eq!(r["strings"]["2"]["reason"], json!("Current -25% vs inverter median now: soiling, shading or a weak module"));
    }

    #[test]
    fn plant_summary() {
        let inv = json!({"device_sn": "A", "timestamp": "2026-11-27 10:00:00", "stale": false,
            "strings": strs(&[8.0, 8.0, 8.0]), "previous_strings": []});
        let out = check_plant(&[inv], &Layout::new(), &HashMap::new());
        assert_eq!(out["summary"]["healthy"], json!(3));
        assert_eq!(out["summary"]["checked_inverters"], json!(1));
        assert_eq!(out["summary"]["at"], json!("2026-11-27 10:00:00"));
        assert_eq!(out["inverters"]["A"]["stale"], json!(false));
    }
}
