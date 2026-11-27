//! String analytics from stored history (DB only), ported from backend/app/services/growatt_strings.py:
//! classification against peers, inactive / dead strings, and one string's day detail with its
//! modelled I-V / P-V curve. Timestamps are plant-local (Thai) time, stored naive; values that
//! cannot be computed from stored data are `None`.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::common::{
    bucket, day_bounds, fmt_ts, integrate_kwh, mean_opt, py_mean, py_median, py_round, round_opt, Result, ServiceError,
    SAMPLE_H,
};
use crate::inverter_history::PlantInverter;

/// Python `growatt_strings.MAX_RANGE_DAYS`
pub const MAX_RANGE_DAYS: i64 = 31;
/// Python `growatt_strings.SCATTER_MAX_POINTS`: measured points sent for the I-V / P-V chart
pub const SCATTER_MAX_POINTS: usize = 200;
/// Python `growatt_strings.DEAD_LOOKBACK`
pub const DEAD_LOOKBACK_DAYS: i64 = 7;
/// Python `growatt_strings.DEAD_PEER_MIN_A`: peers must produce this much before a silent string counts as a fault
pub const DEAD_PEER_MIN_A: f64 = 1.0;

pub use crate::layout::{newest_string_ts, Layout};

/// Python `growatt_layout.load_layout(db, sns)` (fleet Wp filled in): `crate::layout::load_layout`
/// with `fleet_wp = true`, the form the string analyses use.
pub async fn load_layout(pool: &PgPool, sns: &[String]) -> Result<Layout> {
    crate::layout::load_layout(pool, sns, true).await
}

// --------------------------------------------------------------------------- modelled curve

/// One point of a modelled curve (`{"v", "i", "p"}`).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct CurvePoint {
    pub v: f64,
    pub i: f64,
    pub p: f64,
}

/// Python `growatt_strings._synthesize_iv_pv_curve`: a smooth single-diode-like I-V and P-V curve
/// from key parameters (modelled, not measured).
pub fn synthesize_iv_pv_curve(v_oc: f64, i_sc: f64, v_mpp: f64, i_mpp: f64, n_points: usize) -> Vec<CurvePoint> {
    if v_oc <= 1.0 || i_sc <= 0.05 {
        return Vec::new();
    }
    let v_ratio = 0.95f64.min(0.55f64.max(v_mpp / v_oc));
    let i_ratio = 0.97f64.min(0.55f64.max(i_mpp / i_sc));
    let m = (0.02f64.max(1.0 - i_ratio)).ln() / v_ratio.ln();
    let m = if m.is_finite() { 4.5f64.max(22.0f64.min(m)) } else { 10.5 };
    (0..=n_points)
        .map(|k| {
            let v = (v_oc * k as f64) / n_points as f64;
            let frac = 1.0f64.min(0.0f64.max(v / v_oc));
            let i = 0.0f64.max(i_sc * (1.0 - frac.powf(m)));
            CurvePoint { v: py_round(v, 2), i: py_round(i, 3), p: py_round(v * i, 1) }
        })
        .collect()
}

// --------------------------------------------------------------------------- classification

/// One string's day aggregate, the dict `_classify_strings` / `_split_inactive` pass around.
#[derive(Debug, Clone, PartialEq)]
pub struct StringAgg {
    pub device_sn: String,
    pub string_no: i32,
    pub mppt_no: i32,
    pub samples: i64,
    pub v_avg: f64,
    pub v_max: f64,
    pub i_avg: f64,
    pub i_max: f64,
    pub p_max_w: f64,
    pub energy_kwh: f64,
}

/// What `_classify_strings` returns: (strings_summary, anomalies, inv_string_counts, inv_pr_list),
/// the per-inverter maps in first-seen order (Python dict order).
#[derive(Debug, Clone, Default)]
pub struct Classified {
    pub summary: Vec<Value>,
    pub anomalies: Vec<Value>,
    pub inv_string_counts: Vec<(String, usize)>,
    pub inv_pr_list: Vec<(String, Vec<f64>)>,
}

fn truthy(v: Option<f64>) -> Option<f64> {
    v.filter(|x| *x != 0.0)
}

/// Python `growatt_strings._classify_strings`: peer-relative string diagnostics per inverter
/// (same-inverter median as reference), energy per module / per kWp when every string of the
/// inverter has a module count (and rating) in `layout`, else raw (`peer_basis`).
pub fn classify_strings(string_aggs: &[StringAgg], inv_cap_kwp: Option<f64>, layout: &Layout) -> Classified {
    let mut order: Vec<String> = Vec::new();
    let mut by_inv: HashMap<String, Vec<&StringAgg>> = HashMap::new();
    for x in string_aggs {
        if !by_inv.contains_key(&x.device_sn) {
            order.push(x.device_sn.clone());
        }
        by_inv.entry(x.device_sn.clone()).or_default().push(x);
    }
    let mut out = Classified::default();
    let mut pr_index: HashMap<String, usize> = HashMap::new();

    for sn in &order {
        let s_list = &by_inv[sn];
        out.inv_string_counts.push((sn.clone(), s_list.len()));
        let spec: HashMap<i32, Option<(i32, Option<f64>)>> =
            s_list.iter().map(|x| (x.string_no, layout.get(&(sn.clone(), x.string_no)).copied())).collect();
        let per_module = spec.values().all(Option::is_some);
        let per_kwp = per_module && spec.values().flatten().all(|v| truthy(v.1).is_some());
        let peer_basis = if per_kwp { "per_kwp" } else if per_module { "per_module" } else { "raw" };
        let size = |x: &StringAgg| -> f64 {
            match spec[&x.string_no] {
                Some((m, wp)) if per_module => {
                    if per_kwp {
                        f64::from(m) * truthy(wp).unwrap_or(1.0)
                    } else {
                        f64::from(m)
                    }
                }
                _ => 1.0,
            }
        };
        let n_mod = |x: &StringAgg| -> f64 {
            match spec[&x.string_no] {
                Some((m, _)) if per_module => f64::from(m),
                _ => 1.0,
            }
        };
        let active_energies: Vec<f64> = s_list.iter().filter(|x| x.energy_kwh > 0.5).map(|x| x.energy_kwh / size(x)).collect();
        let active_currents: Vec<f64> = s_list.iter().filter(|x| x.i_avg > 0.2).map(|x| x.i_avg).collect();
        let active_voltages: Vec<f64> = s_list.iter().filter(|x| x.v_avg > 50.0).map(|x| x.v_avg / n_mod(x)).collect();
        let med_energy = py_median(&active_energies);
        let med_current = py_median(&active_currents);
        let med_voltage = py_median(&active_voltages);
        let total_modules: i64 =
            if per_module { spec.values().flatten().map(|v| i64::from(v.0)).sum() } else { 0 };

        for x in s_list {
            let sno = x.string_no;
            let sid = format!("{sn} · STR-{sno:02}");
            let own = spec[&sno];
            let str_cap_kwp = match own {
                Some((m, Some(wp))) if wp != 0.0 => Some(py_round(f64::from(m) * wp / 1000.0, 2)),
                _ => match (own, truthy(inv_cap_kwp)) {
                    (Some((m, _)), Some(cap)) if per_module && total_modules != 0 => {
                        Some(py_round(cap * f64::from(m) / total_modules as f64, 2))
                    }
                    (_, cap) => cap.map(|c| py_round(c / s_list.len() as f64, 2)),
                },
            };
            let expected = med_energy.map(|m| m * size(x));
            let e_ratio = truthy(expected).map(|e| x.energy_kwh / e);
            let i_dev_pct = truthy(med_current).map(|m| (x.i_avg - m) / m * 100.0);
            let v_norm = x.v_avg / n_mod(x);
            let v_basis = if per_module { " per module" } else { "" };
            let v_dev_pct = truthy(med_voltage).map(|m| (v_norm - m) / m * 100.0);
            let i_dev = truthy(i_dev_pct).unwrap_or(0.0);
            let v_dev = truthy(v_dev_pct).unwrap_or(0.0);

            // Peer-relative performance index (88.5 % nominal for top peers), not IEC 61724 PR
            let pr_pct = e_ratio.map(|e| 96.5f64.min(0.0f64.max(88.5 * 1.08f64.min(e))));
            let health_score =
                e_ratio.map(|e| 100.0f64.min(10.0f64.max(92.0 * 1.08f64.min(e) - 0.0f64.max(v_dev.abs() * 0.5))));

            let (status, diagnosis) = if x.i_max < 0.3 || pr_pct.is_some_and(|p| p < 68.0) {
                let d = if x.i_max < 0.3 {
                    "Zero/Near-Zero String Current (Open Circuit / Fuse / Disconnected String)".to_owned()
                } else if v_dev < -8.0 {
                    format!("Severe Voltage Drop ({v_dev:+.1}% vs peer{v_basis}) — Possible Bypass Diode / Module Fault")
                } else {
                    format!("Severe String Underperformance ({i_dev:+.1}% current vs peer median)")
                };
                ("Critical", d)
            } else if pr_pct.is_some_and(|p| p < 81.0) || i_dev < -12.0 || v_dev < -5.0 {
                let d = if v_dev < -5.0 {
                    format!("Voltage Mismatch ({v_dev:+.1}% vs MPPT peer{v_basis}) — Partial Shading or Diode Bypass")
                } else {
                    format!("Current Mismatch ({i_dev:+.1}% vs peer) — Soiling or Localized Shading")
                };
                ("Warning", d)
            } else {
                ("Healthy", "Operating within nominal MPPT envelope".to_owned())
            };

            if let Some(p) = pr_pct {
                let idx = *pr_index.entry(sn.clone()).or_insert_with(|| {
                    out.inv_pr_list.push((sn.clone(), Vec::new()));
                    out.inv_pr_list.len() - 1
                });
                out.inv_pr_list[idx].1.push(p);
            }
            let loss = expected.map(|e| py_round(0.0f64.max(e - x.energy_kwh), 2));

            out.summary.push(json!({
                "string_id": sid,
                "short_label": format!("STR-{sno:02}"),
                "inverter_id": sn,
                "device_sn": sn,
                "string_no": sno,
                "mppt_id": format!("MPPT-{}", x.mppt_no),
                "mppt_no": x.mppt_no,
                "capacity_kwp": str_cap_kwp,
                "modules": own.map(|o| o.0),
                "module_wp": own.and_then(|o| o.1),
                "peer_basis": peer_basis,
                "actual_energy_kwh": x.energy_kwh,
                "expected_energy_kwh": round_opt(expected, 2),
                "energy_loss_kwh": loss,
                "pr_pct": round_opt(pr_pct, 1),
                "v_avg": x.v_avg,
                "v_max": x.v_max,
                "i_avg": x.i_avg,
                "i_max": x.i_max,
                "p_max_w": x.p_max_w,
                "current_mismatch_pct": round_opt(i_dev_pct, 1),
                "voltage_mismatch_pct": round_opt(v_dev_pct, 1),
                "underperf_pct": e_ratio.map(|e| py_round(0.0f64.max((1.0 - e) * 100.0), 1)),
                "availability_pct": if x.i_max >= 0.3 { 100.0 } else { 0.0 },
                "health_score": round_opt(health_score, 1),
                "status": status,
                "diagnosis": diagnosis,
            }));

            if status == "Critical" || status == "Warning" {
                out.anomalies.push(json!({
                    "string_id": sid,
                    "inverter_id": sn,
                    "device_sn": sn,
                    "string_no": sno,
                    "severity": status,
                    "category": if x.i_max >= 0.3 { "String Mismatch / Underperformance" } else { "Open String Fault" },
                    "description": diagnosis,
                    "pr_pct": round_opt(pr_pct, 1),
                    "energy_loss_kwh": loss,
                    "recommended_action": if status == "Critical" {
                        "Inspect string connector, fuse holder, and module surface / I-V curve."
                    } else {
                        "Monitor MPPT current balance and schedule module cleaning."
                    },
                }));
            }
        }
    }
    // Python: sort by (0 if Critical else 1, pr_pct or -1), stable
    out.anomalies.sort_by(|a, b| {
        let key = |x: &Value| (if x["severity"] == "Critical" { 0 } else { 1 }, x["pr_pct"].as_f64().unwrap_or(-1.0));
        let (ka, kb) = (key(a), key(b));
        ka.0.cmp(&kb.0).then(ka.1.partial_cmp(&kb.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    out
}

/// Python `growatt_strings._split_inactive`: string inputs without current today, one per input
/// slot 1..2 x highest MPPT seen. An input that carried current in the last `DEAD_LOOKBACK` while
/// its inverter's other strings produce today is a fault (returned as a zero aggregate, for
/// `classify_strings` → Critical); the rest are "Not Active" (`no_current` / `no_data`).
/// `idle` = (device_sn, string_no) → that input's `v_max` today.
pub async fn split_inactive(
    pool: &PgPool,
    active: &[StringAgg],
    idle: &HashMap<(String, i32), f64>,
    mppt_max: &BTreeMap<String, i32>,
    day_start: NaiveDateTime,
) -> Result<(Vec<StringAgg>, Vec<Value>)> {
    let mut present: HashSet<(String, i32)> = active.iter().map(|x| (x.device_sn.clone(), x.string_no)).collect();
    present.extend(idle.keys().cloned());
    let peer_ok: HashSet<&str> = active.iter().filter(|x| x.i_max >= DEAD_PEER_MIN_A).map(|x| x.device_sn.as_str()).collect();
    let slots: Vec<(String, i32)> = mppt_max
        .iter()
        .flat_map(|(sn, m)| (1..=2 * m).map(move |n| (sn.clone(), n)))
        .filter(|k| !present.contains(k) || idle.contains_key(k))
        .collect();
    let check: Vec<String> = slots
        .iter()
        .filter(|(sn, _)| peer_ok.contains(sn.as_str()))
        .map(|(sn, _)| sn.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut recent: HashSet<(String, i32)> = HashSet::new();
    if !check.is_empty() {
        let rows: Vec<(String, i32)> = sqlx::query_as(
            "SELECT device_sn, string_no FROM growatt_string_readings WHERE device_sn = ANY($1) \
             AND timestamp >= $2 AND timestamp < $3 AND current_a >= 0.3 GROUP BY device_sn, string_no",
        )
        .bind(&check)
        .bind(day_start - Duration::days(DEAD_LOOKBACK_DAYS))
        .bind(day_start)
        .fetch_all(pool)
        .await?;
        recent.extend(rows);
    }
    let mut dead = Vec::new();
    let mut inactive = Vec::new();
    for (sn, n) in slots {
        let mppt_no = (n + 1) / 2;
        let row = idle.get(&(sn.clone(), n)).copied();
        if recent.contains(&(sn.clone(), n)) {
            let v = row.unwrap_or(0.0);
            dead.push(StringAgg {
                device_sn: sn,
                string_no: n,
                mppt_no,
                samples: 0,
                v_avg: v,
                v_max: v,
                i_avg: 0.0,
                i_max: 0.0,
                p_max_w: 0.0,
                energy_kwh: 0.0,
            });
            continue;
        }
        inactive.push(json!({
            "string_id": format!("{sn} · STR-{n:02}"),
            "short_label": format!("STR-{n:02}"),
            "device_sn": sn,
            "string_no": n,
            "mppt_no": mppt_no,
            "mppt_id": format!("MPPT-{mppt_no}"),
            "status": "Not Active",
            "reason": if row.is_some() { "no_current" } else { "no_data" },
            "v_max": row,
        }));
    }
    Ok((dead, inactive))
}

// --------------------------------------------------------------------------- one string's detail

/// Options of `build_string_detail` (the route's query parameters).
#[derive(Debug, Clone, Default)]
pub struct StringDetailQuery {
    pub day: Option<NaiveDate>,
    pub start_time: Option<NaiveTime>,
    pub end_time: Option<NaiveTime>,
    pub end_day: Option<NaiveDate>,
}

/// A `timeseries` row (compared by value, as Python compares the dicts).
#[derive(Debug, Clone, PartialEq)]
struct Pt {
    timestamp: String,
    voltage_v: f64,
    current_a: f64,
    power_w: f64,
    peer: Option<(f64, f64, f64)>,
}

/// A string reading with its power: (timestamp, mppt_no, voltage_v, current_a, power_w = v × i)
type StringRow = (NaiveDateTime, i32, Option<f64>, Option<f64>, Option<f64>);
/// Peer voltages, currents and powers collected in one 5-minute slot
type PeerSlot = (Vec<f64>, Vec<f64>, Vec<f64>);

/// Python `time.max`
fn time_max() -> NaiveTime {
    NaiveTime::from_hms_micro_opt(23, 59, 59, 999_999).expect("23:59:59.999999")
}

/// Python `growatt_strings.build_string_detail`: stored telemetry for one string on one day (or
/// `day`..`end_day`, at most `MAX_RANGE_DAYS`), plus modelled I-V / P-V curves and per-day energy.
/// `start_time` / `end_time` (plant-local, inclusive, matched on the 5-minute slot) narrow
/// everything to a time-of-day window on every day. The inverter is a validated `PlantInverter`
/// (Python does not check that `device_sn` belongs to the plant).
pub async fn build_string_detail(pool: &PgPool, inv: &PlantInverter, string_no: i32, q: &StringDetailQuery) -> Result<Value> {
    let plant = inv.plant();
    let device_sn = inv.device_sn();
    let sns = [device_sn.to_owned()];

    let day = match q.day {
        Some(d) => Some(d),
        None => newest_string_ts(pool, &sns, Some(string_no)).await?.map(|t| t.date()),
    };
    let Some(day) = day else {
        return Err(ServiceError::NotFound(format!("No telemetry found for {device_sn} string {string_no}")));
    };
    let last_day = match q.end_day {
        Some(e) if e > day => e,
        _ => day,
    };
    if (last_day - day).num_days() + 1 > MAX_RANGE_DAYS {
        return Err(ServiceError::Invalid(format!("A day range covers at most {MAX_RANGE_DAYS} days")));
    }
    let (start, _) = day_bounds(day);
    let (_, end) = day_bounds(last_day);

    let rows: Vec<(NaiveDateTime, i32, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT timestamp, mppt_no, voltage_v, current_a FROM growatt_string_readings \
         WHERE device_sn = $1 AND timestamp >= $2 AND timestamp < $3 AND string_no = $4 ORDER BY timestamp",
    )
    .bind(device_sn)
    .bind(start)
    .bind(end)
    .bind(string_no)
    .fetch_all(pool)
    .await?;
    let windowed = q.start_time.is_some() || q.end_time.is_some();
    let lo = q.start_time.unwrap_or(NaiveTime::MIN);
    let hi = q.end_time.unwrap_or_else(time_max);
    let in_window = |ts: NaiveDateTime| !windowed || (lo <= bucket(ts).time() && bucket(ts).time() <= hi);
    // (ts, mppt, v, i, p = v × i as the view's power_w)
    let rows: Vec<StringRow> = rows
        .into_iter()
        .filter(|r| in_window(r.0))
        .map(|(t, m, v, i)| (t, m, v, i, v.zip(i).map(|(v, i)| v * i)))
        .collect();
    if rows.is_empty() {
        let where_ = if windowed { format!(" between {} and {}", lo.format("%H:%M"), hi.format("%H:%M")) } else { String::new() };
        let when = if last_day != day { format!("{day} to {last_day}") } else { day.to_string() };
        return Err(ServiceError::NotFound(format!(
            "No telemetry found for {device_sn} string {string_no} on {when}{where_}"
        )));
    }

    // Peer (other strings, same inverter) mean per 5-minute slot, in the order the rows come
    // (Python's query has no ORDER BY; the dict keeps first-seen order).
    let peer_rows: Vec<(NaiveDateTime, i32, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT timestamp, string_no, voltage_v, current_a FROM growatt_string_readings \
         WHERE device_sn = $1 AND timestamp >= $2 AND timestamp < $3 AND string_no != $4 AND current_a > 0.1",
    )
    .bind(device_sn)
    .bind(start)
    .bind(end)
    .bind(string_no)
    .fetch_all(pool)
    .await?;
    let peer_rows: Vec<(NaiveDateTime, i32, f64, f64)> = peer_rows
        .into_iter()
        .filter(|r| in_window(r.0))
        .filter_map(|(t, n, v, i)| Some((t, n, v?, i?)))
        .collect();
    let layout = load_layout(pool, &sns).await?;
    let own = layout.get(&(device_sn.to_owned(), string_no)).copied();
    let peer_nos: HashSet<i32> = peer_rows.iter().map(|r| r.1).collect();
    let per_module = own.is_some() && peer_nos.iter().all(|n| layout.contains_key(&(device_sn.to_owned(), *n)));
    let per_kwp = per_module
        && own.is_some_and(|o| truthy(o.1).is_some())
        && peer_nos.iter().all(|n| truthy(layout[&(device_sn.to_owned(), *n)].1).is_some());
    let peer_basis = if per_kwp { "per_kwp" } else if per_module { "per_module" } else { "raw" };

    // (voltage factor, power factor) mapping peer string `n` onto this string
    let scale = |n: i32| -> (f64, f64) {
        let Some(o) = own.filter(|_| per_module) else { return (1.0, 1.0) };
        let (m, wp) = layout[&(device_sn.to_owned(), n)];
        let v_f = f64::from(o.0) / f64::from(m);
        let p_f = if per_kwp {
            (f64::from(o.0) * truthy(o.1).unwrap_or(1.0)) / (f64::from(m) * truthy(wp).unwrap_or(1.0))
        } else {
            v_f
        };
        (v_f, p_f)
    };
    let mut peer_keys: Vec<NaiveDateTime> = Vec::new();
    let mut peer_acc: HashMap<NaiveDateTime, PeerSlot> = HashMap::new();
    for (ts, n, v, i) in &peer_rows {
        let (v_f, p_f) = scale(*n);
        let b = bucket(*ts);
        let e = peer_acc.entry(b).or_insert_with(|| {
            peer_keys.push(b);
            Default::default()
        });
        e.0.push(v * v_f);
        e.1.push(*i);
        e.2.push(v * i * p_f);
    }
    let peer_map: Vec<(NaiveDateTime, (f64, f64, f64))> = peer_keys
        .iter()
        .map(|k| {
            let (v, i, p) = &peer_acc[k];
            (*k, (py_mean(v).unwrap_or(0.0), py_mean(i).unwrap_or(0.0), py_mean(p).unwrap_or(0.0)))
        })
        .collect();
    let peer_at: HashMap<NaiveDateTime, (f64, f64, f64)> = peer_map.iter().copied().collect();

    let mppt_no = rows[0].1;
    let mut timeseries: Vec<Pt> = Vec::with_capacity(rows.len());
    let mut voltages: Vec<f64> = Vec::new();
    let mut currents: Vec<f64> = Vec::new();
    for (ts, _m, v, i, p) in &rows {
        let (v, i, p) = (v.unwrap_or(0.0), i.unwrap_or(0.0), p.unwrap_or(0.0));
        if v > 50.0 {
            voltages.push(v);
        }
        if i > 0.05 {
            currents.push(i);
        }
        // Python ts.replace(second=0, microsecond=0)
        let minute = ts.with_second(0).and_then(|t| t.with_nanosecond(0)).unwrap_or(*ts);
        timeseries.push(Pt {
            timestamp: fmt_ts(Some(minute)).unwrap_or_default(),
            voltage_v: py_round(v, 2),
            current_a: py_round(i, 3),
            power_w: py_round(p, 1),
            peer: peer_at.get(&bucket(*ts)).map(|pe| (py_round(pe.0, 2), py_round(pe.1, 3), py_round(pe.2, 1))),
        });
    }
    let v_max = voltages.iter().copied().reduce(f64::max);
    let i_max = currents.iter().copied().reduce(f64::max);

    // Operating point at peak measured power (first of equal maxima, as Python's max)
    let mut best = &timeseries[0];
    for pt in &timeseries[1..] {
        if pt.power_w > best.power_w {
            best = pt;
        }
    }
    let best = best.clone();
    let (mut v_mpp_actual, mut i_mpp_actual, mut p_max_w, mut v_oc_actual, mut i_sc_actual) = (None, None, None, None, None);
    let mut actual_curve = Vec::new();
    if best.voltage_v > 0.0 && best.current_a > 0.0 {
        let (vm, im) = (best.voltage_v, best.current_a);
        v_mpp_actual = Some(vm);
        i_mpp_actual = Some(im);
        p_max_w = Some(py_round(vm * im, 1));
        let voc = py_round((v_max.unwrap_or(0.0) * 1.08).max(vm * 1.18), 1);
        let isc = py_round((i_max.unwrap_or(0.0) * 1.07).max(im * 1.08), 2);
        v_oc_actual = Some(voc);
        i_sc_actual = Some(isc);
        actual_curve = synthesize_iv_pv_curve(voc, isc, vm, im, 45);
    }

    // Reference: the best of this string and its peers (peer values scaled as above)
    let peer_v_max = peer_map.iter().map(|p| p.1 .0).filter(|v| *v > 100.0).reduce(f64::max);
    let peer_i_max = peer_map.iter().map(|p| p.1 .1).filter(|i| *i > 0.2).reduce(f64::max);
    let v_nom_src: Vec<f64> = [v_mpp_actual, peer_v_max.map(|v| v * 0.98)].into_iter().flatten().filter(|x| *x != 0.0).collect();
    let i_nom_src: Vec<f64> = [i_mpp_actual, peer_i_max].into_iter().flatten().filter(|x| *x != 0.0).collect();
    let mut mpp_nominal = Value::Null;
    let mut nominal_curve = Vec::new();
    if !v_nom_src.is_empty() && !i_nom_src.is_empty() {
        let v_mpp_nom = py_round(v_nom_src.iter().copied().fold(f64::MIN, f64::max), 1);
        let i_mpp_nom = py_round(i_nom_src.iter().copied().fold(f64::MIN, f64::max), 2);
        let v_oc_nom = py_round(v_oc_actual.unwrap_or(0.0).max(v_mpp_nom * 1.19), 1);
        let i_sc_nom = py_round(i_sc_actual.unwrap_or(0.0).max(i_mpp_nom * 1.08), 2);
        nominal_curve = synthesize_iv_pv_curve(v_oc_nom, i_sc_nom, v_mpp_nom, i_mpp_nom, 45);
        mpp_nominal = json!({"v": v_mpp_nom, "i": i_mpp_nom, "p": py_round(v_mpp_nom * i_mpp_nom, 1)});
    }

    // Measured operating points: at most SCATTER_MAX_POINTS, thinned evenly, peak always kept
    let active_pts: Vec<&Pt> = timeseries.iter().filter(|p| p.voltage_v > 100.0 && p.current_a > 0.1).collect();
    let step = 1usize.max(active_pts.len().div_ceil(SCATTER_MAX_POINTS));
    let mut picked: Vec<&Pt> = active_pts.iter().step_by(step).copied().collect();
    if !active_pts.is_empty() && !picked.iter().any(|p| **p == best) && active_pts.iter().any(|p| **p == best) {
        picked.push(&best);
        picked.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    }
    let scatter: Vec<Value> = picked
        .iter()
        .map(|p| json!({"v": p.voltage_v, "i": p.current_a, "p": p.power_w, "timestamp": p.timestamp}))
        .collect();

    let pts: Vec<(NaiveDateTime, Option<f64>)> = rows.iter().map(|r| (r.0, r.4)).collect();
    let energy_kwh = py_round(integrate_kwh(&pts), 2);
    // mean peer power per 5-minute slot × slot length ≈ energy of an average peer string
    let py_sum = |vals: &mut dyn Iterator<Item = f64>| vals.fold(0.0, |a, b| a + b);
    let peer_energy_kwh = if peer_map.is_empty() {
        None
    } else {
        Some(py_round(py_sum(&mut peer_map.iter().map(|p| p.1 .2)) * SAMPLE_H / 1000.0, 2))
    };
    let pr = |e: f64, pe: Option<f64>| truthy(pe).map(|pe| py_round(96.5f64.min(0.0f64.max(88.5 * 1.08f64.min(e / pe))), 1));
    let pr_pct = pr(energy_kwh, peer_energy_kwh);

    let mut daily = Vec::new();
    let mut d = day;
    while d <= last_day {
        let d_rows: Vec<(NaiveDateTime, Option<f64>)> = rows.iter().filter(|r| r.0.date() == d).map(|r| (r.0, r.4)).collect();
        let d_peer: Vec<f64> = peer_map.iter().filter(|p| p.0.date() == d).map(|p| p.1 .2).collect();
        let e = if d_rows.is_empty() { None } else { Some(py_round(integrate_kwh(&d_rows), 2)) };
        let pe = if d_peer.is_empty() { None } else { Some(py_round(py_sum(&mut d_peer.into_iter()) * SAMPLE_H / 1000.0, 2)) };
        daily.push(json!({
            "day": d.to_string(),
            "energy_kwh": e,
            "peer_energy_kwh": pe,
            "pr_pct": e.and_then(|e| pr(e, pe)),
        }));
        d += Duration::days(1);
    }

    let ts_json: Vec<Value> = timeseries
        .iter()
        .map(|p| {
            json!({
                "timestamp": p.timestamp,
                "voltage_v": p.voltage_v,
                "current_a": p.current_a,
                "power_w": p.power_w,
                "peer_voltage_v": p.peer.map(|x| x.0),
                "peer_current_a": p.peer.map(|x| x.1),
                "peer_power_w": p.peer.map(|x| x.2),
            })
        })
        .collect();

    Ok(json!({
        "meta": {
            "source": "db",
            "day": day.to_string(),
            "end_day": if last_day != day { Some(last_day.to_string()) } else { None },
            "window": if windowed {
                json!({
                    "start": q.start_time.map(|t| t.format("%H:%M").to_string()),
                    "end": q.end_time.map(|t| t.format("%H:%M").to_string()),
                })
            } else { Value::Null },
        },
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        "device_sn": device_sn,
        "string_no": string_no,
        "mppt_no": mppt_no,
        "string_id": format!("{device_sn} · STR-{string_no:02}"),
        "modules": own.map(|o| o.0),
        "module_wp": own.and_then(|o| o.1),
        "peer_basis": peer_basis,
        "summary": {
            "v_avg": round_opt(mean_opt(voltages.iter().map(|v| Some(*v))), 1),
            "v_max": round_opt(v_max, 1),
            "v_mpp": round_opt(v_mpp_actual, 1),
            "v_oc_est": v_oc_actual,
            "i_avg": round_opt(mean_opt(currents.iter().map(|v| Some(*v))), 2),
            "i_max": round_opt(i_max, 2),
            "i_mpp": round_opt(i_mpp_actual, 2),
            "i_sc_est": i_sc_actual,
            "p_max_w": p_max_w,
            "energy_kwh": energy_kwh,
            "peer_energy_kwh": peer_energy_kwh,
            "pr_pct": pr_pct,
        },
        "timeseries": ts_json,
        "daily": daily,
        "iv_pv_curve": {
            "nominal_points": nominal_curve,
            "actual_points": actual_curve,
            "measured_scatter": scatter,
            "mpp_nominal": mpp_nominal,
            "mpp_actual": match (v_mpp_actual, i_mpp_actual, p_max_w) {
                (Some(v), Some(i), Some(p)) => json!({"v": py_round(v, 1), "i": py_round(i, 2), "p": p}),
                _ => Value::Null,
            },
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_shape() {
        assert!(synthesize_iv_pv_curve(1.0, 5.0, 0.8, 4.0, 45).is_empty());
        let c = synthesize_iv_pv_curve(800.0, 14.0, 650.0, 13.0, 45);
        assert_eq!(c.len(), 46);
        assert_eq!(c[0], CurvePoint { v: 0.0, i: 14.0, p: 0.0 });
        assert_eq!(c[45].i, 0.0);
    }

    fn agg(sn: &str, n: i32, e: f64, i: f64, v: f64) -> StringAgg {
        StringAgg { device_sn: sn.into(), string_no: n, mppt_no: (n + 1) / 2, samples: 10, v_avg: v, v_max: v, i_avg: i, i_max: i, p_max_w: v * i, energy_kwh: e }
    }

    #[test]
    fn classify_flags_weak_and_open_strings() {
        let aggs = [agg("A", 1, 10.0, 9.0, 700.0), agg("A", 2, 10.0, 9.0, 700.0), agg("A", 3, 5.0, 4.5, 700.0), agg("A", 4, 0.0, 0.0, 0.0)];
        let c = classify_strings(&aggs, Some(40.0), &Layout::new());
        assert_eq!(c.summary.len(), 4);
        assert_eq!(c.summary[0]["status"], "Healthy");
        assert_eq!(c.summary[2]["status"], "Critical");
        assert_eq!(c.summary[3]["diagnosis"], "Zero/Near-Zero String Current (Open Circuit / Fuse / Disconnected String)");
        assert_eq!(c.summary[0]["capacity_kwp"], 10.0);
        assert_eq!(c.anomalies.len(), 2);
        assert_eq!(c.inv_string_counts, vec![("A".to_owned(), 4)]);
    }
}
