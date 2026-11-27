//! Grid import / export and load from the plant's energy meter (`growatt_meter_readings`), ported
//! from backend/app/services/growatt_meter.py.
//!
//! The meter at the grid connection point reports `active_power_w` as signed power: positive =
//! drawn from the grid (import), negative = fed into it (export). Import / export are **measured**;
//! load is **derived** as PV AC + grid power where both are stored, null where that sum would be
//! negative. A meter slot with no inverter record becomes a row of its own with PV null (never 0);
//! its load is derived (= grid power) only where PV is 0 without a record (sun down, or before /
//! after the day's inverter records when the nearest of them read 0 kW).
//!
//! Curve rows are JSON objects (`serde_json::Map`), the shape of the Python dicts, so the overview
//! and `/power` ports can hand their rows in as they are.
//!
//! `live_load` (the derived part of `/live/plants/{id}/meter`) is pure and ported here; reading the
//! meter itself (`GrowattLiveService.plant_meter`, `meter_last_data`) belongs to the live wave.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{NaiveDateTime, Timelike};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::{bucket, expected_kw, integrate_kwh, py_mean, py_round, py_sum, Result};

const TS_FMT: &str = "%Y-%m-%d %H:%M:%S";
/// Python `DAY_START_H`, `DAY_END_H`: outside these plant-local hours PV is 0 without a record
pub const DAY_START_H: u32 = 5;
pub const DAY_END_H: u32 = 19;
/// Python `LIVE_LOAD_MATCH_S`: an inverter record counts towards the live load only this close to the meter's
pub const LIVE_LOAD_MATCH_S: i64 = 600;

pub type Row = Map<String, Value>;

fn parse_ts(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, TS_FMT).ok()
}

fn ts_of(r: &Row) -> &str {
    r.get("timestamp").and_then(Value::as_str).unwrap_or("")
}

/// Python `plant_meters`: (datalogger SN, bus address) of each registered meter of the plant.
pub async fn plant_meters(pool: &PgPool, plant_id: i64) -> Result<Vec<(String, i32)>> {
    Ok(sqlx::query_as("SELECT datalogger_sn, address FROM growatt_meters WHERE plant_id = $1 ORDER BY datalogger_sn, address")
        .bind(plant_id as i32)
        .fetch_all(pool)
        .await?)
}

/// Python `meter_slots`: (plant has a meter, {slot "YYYY-MM-DD HH:MM:SS": grid power W}) for
/// [start, end). Each meter's records are averaged within the 5-minute slot, then summed across meters.
pub async fn meter_slots(pool: &PgPool, plant_id: i64, start: NaiveDateTime, end: NaiveDateTime) -> Result<(bool, HashMap<String, f64>)> {
    let meters: Vec<(String, i32)> =
        sqlx::query_as("SELECT datalogger_sn, address FROM growatt_meters WHERE plant_id = $1").bind(plant_id as i32).fetch_all(pool).await?;
    if meters.is_empty() {
        return Ok((false, HashMap::new()));
    }
    let keys: HashSet<(String, i32)> = meters.into_iter().collect();
    let dls: Vec<String> = keys.iter().map(|k| k.0.clone()).collect::<HashSet<_>>().into_iter().collect();
    let rows: Vec<(String, i32, NaiveDateTime, Option<f64>)> = sqlx::query_as(
        "SELECT datalogger_sn, address, timestamp, active_power_w FROM growatt_meter_readings \
         WHERE datalogger_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3",
    )
    .bind(dls)
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?;
    // insertion-ordered like the Python dict
    let mut order: Vec<(NaiveDateTime, (String, i32))> = Vec::new();
    let mut per: HashMap<(NaiveDateTime, (String, i32)), Vec<f64>> = HashMap::new();
    for (dl, addr, ts, p) in rows {
        let Some(p) = p else { continue };
        if !keys.contains(&(dl.clone(), addr)) {
            continue;
        }
        let k = (bucket(ts), (dl, addr));
        per.entry(k.clone())
            .or_insert_with(|| {
                order.push(k);
                Vec::new()
            })
            .push(p);
    }
    let mut out: HashMap<String, f64> = HashMap::new();
    for k in order {
        let key = k.0.format(TS_FMT).to_string();
        let m = py_mean(&per[&k]).unwrap_or(0.0);
        *out.entry(key).or_insert(0.0) += m;
    }
    Ok((true, out))
}

/// Python `attach_grid`: adds `grid_import_kw` / `grid_export_kw` (measured) and `load_kw`
/// (derived) to each curve row; null where the meter has no record for the slot. A meter slot the
/// curve has no row for is added as a row with PV null; the curve stays in time order.
pub fn attach_grid(timeseries: &mut Vec<Row>, slots: &HashMap<String, f64>, cap_kwp: Option<f64>) {
    // day -> (index of its first, index of its last inverter row)
    let mut edges: HashMap<String, (usize, usize)> = HashMap::new();
    for (i, r) in timeseries.iter().enumerate() {
        let d = ts_of(r).get(..10).unwrap_or("").to_owned();
        edges.entry(d).and_modify(|e| e.1 = i).or_insert((i, i));
    }
    let known: HashSet<String> = timeseries.iter().map(|r| ts_of(r).to_owned()).collect();
    for r in timeseries.iter_mut() {
        let Some(p) = slots.get(ts_of(r)).copied() else {
            for k in ["grid_import_kw", "grid_export_kw", "load_kw"] {
                r.insert(k.into(), Value::Null);
            }
            continue;
        };
        let kw = p / 1000.0;
        r.insert("grid_import_kw".into(), json!(py_round(kw.max(0.0), 2)));
        r.insert("grid_export_kw".into(), json!(py_round((-kw).max(0.0), 2)));
        let load = r.get("pac_kw").and_then(Value::as_f64).unwrap_or(0.0) + kw;
        r.insert("load_kw".into(), if load >= 0.0 { json!(py_round(load, 2)) } else { Value::Null });
    }
    let mut extra: Vec<&String> = slots.keys().filter(|k| !known.contains(*k)).collect();
    extra.sort();
    let edge_rows: HashMap<&str, (Row, Row)> = edges.iter().map(|(d, (a, b))| (d.as_str(), (timeseries[*a].clone(), timeseries[*b].clone()))).collect();
    let mut added = Vec::new();
    for key in &extra {
        let Some(t) = parse_ts(key) else { continue };
        let kw = slots[*key] / 1000.0;
        let mut pv_off = !(DAY_START_H <= t.hour() && t.hour() < DAY_END_H);
        if !pv_off {
            if let Some((first, last)) = key.get(..10).and_then(|d| edge_rows.get(d)) {
                let zero = |r: &Row| r.get("pac_kw").and_then(Value::as_f64) == Some(0.0);
                pv_off = (key.as_str() < ts_of(first) && zero(first)) || (key.as_str() > ts_of(last) && zero(last));
            }
        }
        let mut row = Row::new();
        row.insert("timestamp".into(), json!(key));
        row.insert("pac_kw".into(), Value::Null); // no inverter record in this slot
        row.insert("ppv_kw".into(), Value::Null);
        row.insert("expected_kw".into(), json!(expected_kw(cap_kwp, f64::from(t.hour()) + f64::from(t.minute()) / 60.0)));
        row.insert("temp_c".into(), Value::Null);
        row.insert("freq_hz".into(), Value::Null);
        row.insert("inverters".into(), json!(0));
        row.insert("held".into(), json!(0));
        row.insert("grid_import_kw".into(), json!(py_round(kw.max(0.0), 2)));
        row.insert("grid_export_kw".into(), json!(py_round((-kw).max(0.0), 2)));
        row.insert("load_kw".into(), if pv_off && kw >= 0.0 { json!(py_round(kw, 2)) } else { Value::Null });
        added.push(row);
    }
    if !added.is_empty() {
        timeseries.extend(added);
        // Python list.sort is stable, as is sort_by
        timeseries.sort_by(|a, b| ts_of(a).cmp(ts_of(b)));
    }
}

/// Python `day_energy`: the period's grid import (from the meters' import counters where they span
/// it, else integrated), export and load (integrated from the 5-minute series). A slot without a
/// value adds no energy; a figure is null when no slot has one. `use_counter=false` (a time-of-day
/// window): import is always integrated.
pub async fn day_energy(pool: &PgPool, plant_id: i64, start: NaiveDateTime, end: NaiveDateTime, timeseries: &[Row], use_counter: bool) -> Result<Value> {
    let pts: Vec<(NaiveDateTime, &Row)> = timeseries
        .iter()
        .filter(|r| !r.get("load_kw").unwrap_or(&Value::Null).is_null() || !r.get("grid_import_kw").unwrap_or(&Value::Null).is_null())
        .filter_map(|r| Some((parse_ts(ts_of(r))?, r)))
        .collect();
    if pts.is_empty() {
        return Ok(json!({"grid_import_kwh": null, "grid_export_kwh": null, "load_kwh": null}));
    }
    // every slot stays on the timeline (a slot without the value adds no energy)
    let integ = |key: &str| -> Option<f64> {
        let vals: Vec<(NaiveDateTime, Option<f64>)> = pts.iter().map(|(t, r)| (*t, r.get(key).and_then(Value::as_f64).map(|v| v * 1000.0))).collect();
        vals.iter().any(|(_, v)| v.is_some()).then(|| py_round(integrate_kwh(&vals), 1))
    };
    let mut imp: Option<f64> = None;
    if use_counter {
        let counter: Vec<(Option<f64>, i64)> = sqlx::query_as(
            "SELECT max(m.import_counter_kwh) - min(m.import_counter_kwh), count(*) FROM growatt_meter_readings m \
             JOIN growatt_meters g ON g.datalogger_sn = m.datalogger_sn AND g.address = m.address \
             WHERE g.plant_id = $1 AND m.timestamp >= $2 AND m.timestamp < $3 AND m.import_counter_kwh > 0 \
             GROUP BY m.datalogger_sn, m.address",
        )
        .bind(plant_id as i32)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        if !counter.is_empty() && counter.iter().all(|(span, n)| span.is_some() && *n >= 2) {
            imp = Some(py_sum(counter.iter().map(|(s, _)| s.unwrap_or(0.0))));
        }
    }
    Ok(json!({
        "grid_import_kwh": match imp { Some(i) => Some(py_round(i, 1)), None => integ("grid_import_kw") },
        "grid_export_kwh": integ("grid_export_kw"),
        "load_kwh": integ("load_kw"),
    }))
}

/// Python `live_load`: live load = PV AC + grid power at the meter's newest record (**derived**,
/// never measured). An inverter counts 0 W with no record today (unless its read failed) or an
/// older 0 W record; any other inverter without a record within `LIVE_LOAD_MATCH_S` of the
/// meter's leaves PV and load null with a `reason`, never a partial sum.
pub fn live_load(grid: &Value, device_sns: &[String], inverters: &[Value], errors: &BTreeMap<String, String>) -> Value {
    let ts = grid.get("timestamp").cloned().unwrap_or(Value::Null);
    let mut out = json!({"timestamp": ts, "pv_kw": null, "load_kw": null, "reason": null});
    let kw = grid.get("grid_power_kw").and_then(Value::as_f64);
    let t_meter = grid.get("timestamp").and_then(Value::as_str).filter(|s| !s.is_empty());
    let (Some(kw), Some(t_meter)) = (kw, t_meter) else {
        out["reason"] = json!("no complete meter record");
        return out;
    };
    let Some(t_meter) = parse_ts(t_meter) else {
        out["reason"] = json!("no complete meter record");
        return out;
    };
    let by_sn: HashMap<&str, &Value> = inverters.iter().filter_map(|r| Some((r.get("device_sn")?.as_str()?, r))).collect();
    let mut pv_w = 0.0;
    let mut unknown = 0usize;
    for sn in device_sns {
        let Some(r) = by_sn.get(sn.as_str()) else {
            if errors.contains_key(sn) {
                unknown += 1; // not read: may be producing
            }
            continue; // no record today: off
        };
        let Some(t) = r.get("timestamp").and_then(Value::as_str).and_then(parse_ts) else {
            unknown += 1;
            continue;
        };
        let pac = r.get("pac_w").and_then(Value::as_f64);
        if (t - t_meter).num_seconds().abs() <= LIVE_LOAD_MATCH_S && pac.is_some() {
            pv_w += pac.unwrap_or(0.0);
        } else if t < t_meter && pac == Some(0.0) {
            continue; // shut down before the meter's record
        } else {
            unknown += 1;
        }
    }
    if unknown > 0 {
        out["reason"] = json!(format!("no inverter record near the meter's for {unknown} of {} inverters", device_sns.len()));
        return out;
    }
    out["pv_kw"] = json!(py_round(pv_w / 1000.0, 2));
    let load = pv_w / 1000.0 + kw;
    if load < 0.0 {
        out["reason"] = json!("export above PV (inconsistent records)");
        return out;
    }
    out["load_kw"] = json!(py_round(load, 2));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: &str, pac: Option<f64>) -> Row {
        json!({"timestamp": ts, "pac_kw": pac}).as_object().unwrap().clone()
    }

    #[test]
    fn grid_rows() {
        let mut ts = vec![row("2026-11-27 07:00:00", Some(0.0)), row("2026-11-27 12:00:00", Some(50.0))];
        let slots: HashMap<String, f64> = [
            ("2026-11-27 12:00:00".to_owned(), -10_000.0),
            ("2026-11-27 06:00:00".to_owned(), 20_000.0),
            ("2026-11-27 03:00:00".to_owned(), 5_000.0),
            ("2026-11-27 13:00:00".to_owned(), 5_000.0),
        ]
        .into();
        attach_grid(&mut ts, &slots, Some(100.0));
        let t: Vec<&str> = ts.iter().map(ts_of).collect();
        assert_eq!(t, ["2026-11-27 03:00:00", "2026-11-27 06:00:00", "2026-11-27 07:00:00", "2026-11-27 12:00:00", "2026-11-27 13:00:00"]);
        assert_eq!(ts[0]["load_kw"], json!(5.0)); // night: PV 0
        assert_eq!(ts[1]["load_kw"], json!(20.0)); // before the first row, which read 0 kW
        assert_eq!(ts[2]["load_kw"], Value::Null); // inverter row without a meter slot
        assert_eq!(ts[3]["grid_export_kw"], json!(10.0));
        assert_eq!(ts[3]["load_kw"], json!(40.0));
        assert_eq!(ts[4]["load_kw"], Value::Null); // after a producing row: unknown
        assert_eq!(ts[4]["pac_kw"], Value::Null);
    }

    #[test]
    fn live() {
        let grid = json!({"timestamp": "2026-11-27 12:00:00", "grid_power_kw": 5.0});
        let inv = vec![json!({"device_sn": "A", "timestamp": "2026-11-27 11:58:00", "pac_w": 10000.0})];
        let r = live_load(&grid, &["A".into(), "B".into()], &inv, &BTreeMap::new());
        assert_eq!(r["load_kw"], json!(15.0));
        let errs: BTreeMap<String, String> = [("B".to_owned(), "x".to_owned())].into();
        let r = live_load(&grid, &["A".into(), "B".into()], &inv, &errs);
        assert_eq!(r["reason"], json!("no inverter record near the meter's for 1 of 2 inverters"));
        assert_eq!(live_load(&json!({}), &[], &[], &BTreeMap::new())["reason"], json!("no complete meter record"));
    }
}
