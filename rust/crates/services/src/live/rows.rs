//! Port of `backend/app/services/growatt_live/rows.py`: one Growatt answer → the fields a live
//! feature serves. Realtime, never stored.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};
use tcroof_clients::growatt::py::{self, TimeFormat};
use tcroof_clients::growatt::{
    self as gw, parse_max_diagnostics, parse_max_grid, parse_max_mppt_energy, parse_max_records, GrowattClient,
    GrowattError, Record, ENV_FIELDS, METER_FIELDS,
};

use super::{MAX_INTERVAL_S, MIN_INTERVAL_S, PLANT_UTC_OFFSET_H};

/// Python `SNAPSHOT_CHUNK`: `maxs_data` answers about 50 serials per page; one call per chunk.
pub const SNAPSHOT_CHUNK: usize = 50;
/// Python `PREVIOUS_RECORDS`: with the newest, 6 records ≈ 30 min a string fault must last.
pub const PREVIOUS_RECORDS: usize = 5;
/// Python `POWER_TAIL_RECORDS`: the first page of `max_data` (today's newest ≈ 8 h).
pub const POWER_TAIL_RECORDS: usize = 100;
/// Python `GROWATT_SERVER_TZ` (Asia/Shanghai, UTC+8, no DST): `env_list` `lastUpdateTime`.
const GROWATT_SERVER_OFFSET_H: i64 = 8;

const TS_FMT: &str = "%Y-%m-%d %H:%M:%S";

fn get<'a>(r: &'a Map<String, Value>, k: &str) -> &'a Value {
    py::get(r, k)
}

/// Python `rows._f`: a number as float; None, "" or anything `float()` refuses = None.
pub fn f(v: &Value) -> Option<f64> {
    gw::f(v)
}

/// Python `rows._flag`: "1" / "true" → true, "0" / "false" → false (any case, trimmed), else None.
pub fn flag(v: &Value) -> Option<bool> {
    let t = py::str_of(v).trim().to_lowercase();
    match t.as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

/// `x or None`: the value when truthy, else null.
fn or_none(v: &Value) -> Value {
    if py::truthy(v) {
        v.clone()
    } else {
        Value::Null
    }
}

/// `dict(...)` of a JSON value: a non-object answer is an error (Python raises `AttributeError`).
fn as_record(v: &Value) -> Result<&Record, GrowattError> {
    py::as_dict(v).map_err(GrowattError::from)
}

/// Python `rows._alarm_row`
pub fn alarm_row(sn: &str, a: &Value) -> Result<Value, GrowattError> {
    let a = as_record(a)?;
    Ok(json!({
        "device_sn": sn,
        "start_time": or_none(get(a, "start_time")),
        "end_time": or_none(get(a, "end_time")),
        "alarm_code": get(a, "alarm_code"),
        "alarm_message": or_none(get(a, "alarm_message")),
        "fault_type": or_none(get(a, "fault_type")),
        "status": get(a, "status"),
    }))
}

/// Python `rows._maxs_rows`: `maxs_data` → {serial: the fields the fleet views use}; realtime,
/// never stored. A serial Growatt does not answer is absent (unknown), never filled in.
pub async fn maxs_rows(client: &GrowattClient, sns: &[String]) -> Result<Value, GrowattError> {
    let mut out = Map::new();
    for (sn, rec) in client.maxs_latest(sns, 10).await? {
        let t = get(&rec, "time");
        let status = match get(&rec, "status") {
            Value::Bool(b) => json!(i64::from(*b)),
            Value::Number(n) => match n.as_i64() {
                Some(i) => json!(i),
                None => n.as_f64().filter(|x| x.is_finite()).map_or(Value::Null, |x| json!(x.trunc() as i64)),
            },
            _ => Value::Null,
        };
        let datalogger = if py::truthy(get(&rec, "dataloggerSn")) {
            get(&rec, "dataloggerSn").clone()
        } else {
            or_none(get(&rec, "dataLogSn"))
        };
        out.insert(
            sn,
            json!({
                "record_time": if py::truthy(t) { json!(py::head(&py::str_of(t), 19)) } else { Value::Null },
                "status": status,
                "status_label": or_none(get(&rec, "statusText")),
                "pac_w": f(get(&rec, "pac")),
                "ppv_w": f(get(&rec, "ppv")),
                "eac_today_kwh": f(get(&rec, "eacToday")),
                "temperature_c": f(get(&rec, "temperature")),
                "fault_type": f(get(&rec, "faultType")),
                "warn_code": f(get(&rec, "warnCode")),
                "lost": flag(get(&rec, "lost")),
                "datalogger_sn": datalogger,
            }),
        );
    }
    Ok(Value::Object(out))
}

/// Python `rows._plant_data_row`: the `plant/data` fields the plant directory uses.
pub async fn plant_data_row(client: &GrowattClient, plant_id: i64) -> Result<Value, GrowattError> {
    let d = client.plant_data(plant_id).await?;
    let d = as_record(&d)?;
    let upd = get(d, "last_update_time");
    Ok(json!({
        "today_energy_kwh": f(get(d, "today_energy")),
        "last_update_time": if py::truthy(upd) { json!(py::str_of(upd)) } else { Value::Null },
    }))
}

/// Python `rows._env_row`: newest weather-sensor record (`env_last_data`), or null.
pub async fn env_row(client: &GrowattClient, datalogger_sn: &str, address: i64) -> Result<Value, GrowattError> {
    let Some(rec) = client.env_latest(datalogger_sn, address).await? else {
        return Ok(Value::Null);
    };
    let mut row = json!({
        "datalogger_sn": datalogger_sn,
        "address": address,
        "timestamp": py::str_of(get(&rec, "timeText")),
        "interval_s": null,
    });
    let m = row.as_object_mut().expect("object");
    for (key, col) in ENV_FIELDS {
        m.insert(col.into(), json!(f(get(&rec, key))));
    }
    // the record as reported, for the sensor Info view's "Raw record" (admin only; memory only)
    let raw: Map<String, Value> = rec
        .iter()
        .filter(|(_, v)| matches!(v, Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    m.insert("raw".into(), Value::Object(raw));
    Ok(row)
}

/// Python `rows._record_gap`: seconds between two consecutive records of one sensor / meter.
pub fn record_gap(prev: &Value, row: &Value) -> Value {
    let ts = |v: &Value| v.get("timestamp").and_then(|t| py::strptime(&py::str_of(t), TimeFormat::Seconds));
    let (Some(a), Some(b)) = (ts(prev), ts(row)) else {
        return Value::Null;
    };
    let gap = (b - a).num_microseconds().map_or(f64::NAN, |us| us as f64 / 1e6);
    if gap < 0.0 {
        return Value::Null; // an older record than the cached one: measure again next time
    }
    if (MIN_INTERVAL_S..=MAX_INTERVAL_S).contains(&gap) {
        return json!(gap);
    }
    prev.get("interval_s").cloned().unwrap_or(Value::Null)
}

/// Python `rows._meter_row`: newest energy-meter record (`meter_last_data`), or null.
pub async fn meter_row(client: &GrowattClient, datalogger_sn: &str, address: i64) -> Result<Value, GrowattError> {
    let Some(rec) = client.meter_latest(datalogger_sn, address).await? else {
        return Ok(Value::Null);
    };
    let mut row = json!({
        "datalogger_sn": datalogger_sn,
        "address": address,
        "timestamp": py::str_of(get(&rec, "timeText")),
        "interval_s": null,
        "lost": flag(get(&rec, "lost")),
    });
    let m = row.as_object_mut().expect("object");
    for (key, col) in METER_FIELDS {
        m.insert(col.into(), json!(f(get(&rec, key))));
    }
    Ok(row)
}

/// Python `rows._env_status_rows`: `env_list` → [{address, lost, last_update_time}].
pub async fn env_status_rows(client: &GrowattClient, datalogger_sn: &str) -> Result<Value, GrowattError> {
    let mut rows = Vec::new();
    for e in client.list_env_sensors(datalogger_sn, true).await? {
        let e = as_record(&e)?;
        let Ok(addr) = py::str_of(get(e, "address")).trim().parse::<i64>() else { continue };
        rows.push(json!({
            "address": addr,
            "lost": flag(get(e, "lost")),
            "last_update_time": local_ts(get(e, "lastUpdateTime")),
        }));
    }
    Ok(Value::Array(rows))
}

/// Python `rows._datalogger_rows`: `device/datalogger/list` → [{datalogger_sn, model, lost,
/// last_update_time}], by serial.
pub async fn datalogger_rows(client: &GrowattClient, plant_id: i64) -> Result<Value, GrowattError> {
    let text = |v: &Value| if py::truthy(v) { py::strip(&py::str_of(v)).to_owned() } else { String::new() };
    let mut rows = Vec::new();
    for d in client.list_dataloggers(plant_id).await? {
        let sn = text(get(&d, "sn"));
        if sn.is_empty() {
            continue;
        }
        let model = text(get(&d, "model"));
        rows.push((
            sn.clone(),
            json!({
                "datalogger_sn": sn,
                "model": if model.is_empty() { Value::Null } else { json!(model) },
                "lost": flag(get(&d, "lost")),
                "last_update_time": epoch_local(get(&d, "last_update_time")),
            }),
        ));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Value::Array(rows.into_iter().map(|(_, r)| r).collect()))
}

/// Python `rows._epoch_local`: a Java date object (`{"time": epoch ms}`) → plant-local text; any
/// other shape is None.
pub fn epoch_local(v: &Value) -> Option<String> {
    let ms = v.as_object()?.get("time")?;
    let Value::Number(n) = ms else { return None };
    let ms = n.as_f64()?;
    if ms.is_nan() || ms <= 0.0 || !ms.is_finite() {
        return None;
    }
    let secs = ms / 1000.0;
    let whole = secs.floor();
    let t = DateTime::from_timestamp(whole as i64, ((secs - whole) * 1e9) as u32)?;
    let local = t.naive_utc() + Duration::seconds((PLANT_UTC_OFFSET_H * 3600.0) as i64);
    Some(local.format(TS_FMT).to_string())
}

/// Python `rows._local_ts`: `env_list`'s `lastUpdateTime` (China time, UTC+8) → plant-local text.
pub fn local_ts(v: &Value) -> Option<String> {
    let s = py::str_of(v);
    let at = py::strptime(py::head(&s, 19), TimeFormat::Seconds)?;
    let shift = (PLANT_UTC_OFFSET_H * 3600.0) as i64 - GROWATT_SERVER_OFFSET_H * 3600;
    Some((at + Duration::seconds(shift)).format(TS_FMT).to_string())
}

/// Python `rows._record_ts`: `strptime(str(rec.get("time")))`, None when unreadable.
pub fn record_ts(rec: &Value) -> Option<NaiveDateTime> {
    let t = rec.as_object().map_or(&Value::Null, |r| get(r, "time"));
    py::strptime(&py::str_of(t), TimeFormat::Seconds)
}

fn fmt_ts(t: NaiveDateTime) -> String {
    t.format(TS_FMT).to_string()
}

/// Python `rows._power_tail`: today's power from the page, oldest first: [timestamp, pac_w, ppv_w].
pub fn power_tail(recs: &[Value]) -> Value {
    let mut out: Vec<(String, Value)> = Vec::new();
    for rec in recs {
        if let Some(ts) = record_ts(rec) {
            let r = rec.as_object().expect("record_ts read a dict");
            let s = fmt_ts(ts);
            out.push((s.clone(), json!([s, f(get(r, "pac")), f(get(r, "ppv"))])));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0)); // stable, as Python's sort
    Value::Array(out.into_iter().map(|(_, v)| v).collect())
}

/// Python `rows._newest_records`: today's newest records of one inverter, newest first, and the
/// call that gave them (`max_data`; when it refuses, `max_last_data`, then `queryLastData`).
pub async fn newest_records(client: &GrowattClient, sn: &str, day: NaiveDate) -> Result<(Vec<Value>, &'static str), GrowattError> {
    match gw::newest_max_records(client, sn, day, POWER_TAIL_RECORDS).await {
        Ok(page) => Ok((page, "max_data")),
        Err(first @ GrowattError::Api(_)) => {
            for source in ["max_last_data", "queryLastData"] {
                let rec = match source {
                    "max_last_data" => client.max_last_record(sn).await,
                    _ => client.device_last_record(sn).await,
                };
                // refused as well (any error): try the next one
                let Ok(Some(rec)) = rec else { continue };
                let rec = Value::Object(rec);
                let Some(ts) = record_ts(&rec) else { continue };
                return Ok((if ts.date() == day { vec![rec] } else { Vec::new() }, source));
            }
            Err(first)
        }
        Err(other) => Err(other),
    }
}

/// Python `rows._latest_row`: the newest record of one inverter (power, MPPT, per-string V / I,
/// the older records for the live string check and today's power tail), or null.
pub async fn latest_row(client: &GrowattClient, sn: &str, day: NaiveDate) -> Result<Value, GrowattError> {
    let (page, source) = newest_records(client, sn, day).await?;
    if page.is_empty() {
        return Ok(Value::Null);
    }
    let recs = &page[..page.len().min(1 + PREVIOUS_RECORDS)];
    let (inv_rows, str_rows) = parse_max_records(sn, &recs[..1], 32, 16)?;
    let mut previous = Vec::new();
    for rec in &recs[1..] {
        let (_, older) = parse_max_records(sn, std::slice::from_ref(rec), 32, 16)?;
        previous.push(json!({
            "timestamp": record_ts(rec).map(fmt_ts),
            "strings": older.iter().map(|r| json!({
                "string_no": r.string_no, "voltage_v": r.voltage_v, "current_a": r.current_a,
            })).collect::<Vec<_>>(),
        }));
    }
    let Some(row) = inv_rows.first() else {
        // Python: `inv_rows[0]` raises IndexError for a record without a time
        return Err(GrowattError::Unexpected(py::PyError("IndexError: list index out of range".into())));
    };
    let first = as_record(&recs[0])?;
    let prev = recs.get(1).and_then(record_ts);
    let interval = prev.map(|p| (row.timestamp - p).num_microseconds().unwrap_or(0) as f64 / 1e6);
    Ok(json!({
        "device_sn": sn,
        "record_source": source,
        "timestamp": fmt_ts(row.timestamp),
        "interval_s": interval,
        "status": row.status,
        "pac_w": row.pac_w,
        "ppv_w": row.ppv_w,
        "eac_today_kwh": row.eac_today_kwh,
        "temperature_c": row.temperature_c,
        "fac_hz": row.fac_hz,
        "mppt": row.mppt_json,
        "grid": parse_max_grid(first),
        "diagnostics": parse_max_diagnostics(first)?,
        "mppt_energy": parse_max_mppt_energy(first, 16),
        "strings": str_rows.iter().map(|r| json!({
            "string_no": r.string_no, "mppt_no": r.mppt_no, "voltage_v": r.voltage_v,
            "current_a": r.current_a, "power_w": r.power_w,
        })).collect::<Vec<_>>(),
        "previous_strings": previous,
        "power": power_tail(&page),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_and_times() {
        assert_eq!(flag(&json!("1")), Some(true));
        assert_eq!(flag(&json!(" TRUE ")), Some(true));
        assert_eq!(flag(&json!(true)), Some(true));
        assert_eq!(flag(&json!(0)), Some(false));
        assert_eq!(flag(&json!(1.0)), None);
        assert_eq!(flag(&Value::Null), None);
        assert_eq!(local_ts(&json!("2026-11-13 10:05:00")).as_deref(), Some("2026-11-13 09:05:00"));
        assert_eq!(local_ts(&json!("bad")), None);
        // 2026-11-13 03:00:00 UTC = 10:00 plant-local
        assert_eq!(epoch_local(&json!({"time": 1_763_002_800_000_i64})).as_deref(), Some("2025-11-13 10:00:00"));
        assert_eq!(epoch_local(&json!({"time": true})), None);
        assert_eq!(epoch_local(&json!({"time": 0})), None);
        assert_eq!(epoch_local(&json!(5)), None);
    }

    #[test]
    fn gaps_and_tail() {
        let prev = json!({"timestamp": "2026-11-27 10:00:00", "interval_s": 300.0});
        assert_eq!(record_gap(&prev, &json!({"timestamp": "2026-11-27 10:05:00"})), json!(300.0));
        assert_eq!(record_gap(&prev, &json!({"timestamp": "2026-11-27 10:00:00"})), json!(300.0)); // same record
        assert_eq!(record_gap(&prev, &json!({"timestamp": "2026-11-27 09:55:00"})), Value::Null);
        assert_eq!(record_gap(&prev, &json!({"timestamp": "x"})), Value::Null);
        let tail = power_tail(&[
            json!({"time": "2026-11-27 10:05:00", "pac": "1.5", "ppv": 2}),
            json!({"time": "bad"}),
            json!({"time": "2026-11-27 10:00:00", "pac": "", "ppv": null}),
        ]);
        assert_eq!(tail, json!([["2026-11-27 10:00:00", null, null], ["2026-11-27 10:05:00", 1.5, 2.0]]));
    }
}
