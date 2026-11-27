//! Weather-sensor data from persisted history (DB only, no Growatt calls), ported from
//! backend/app/services/growatt_weather.py.
//!
//! A plant's weather sensors (`growatt_env_sensors`) report every 5 min: plane-of-array
//! irradiance, ambient and module temperature, humidity and wind. A probe the sensor is not fitted
//! with reads 0, so a field that is 0 for a sensor all day is returned as null for that day (it was
//! not measured), never as 0. With measured irradiance the plant gets a real IEC 61724-1 PR
//! (`iec_pr`).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::{bucket, py_round, py_sum, round_opt, Result};

/// Python `FIELDS`
pub const FIELDS: [&str; 6] = ["irradiance_wm2", "ambient_temp_c", "module_temp_c", "humidity_pct", "wind_speed_ms", "wind_dir_deg"];
/// Python `DAYLIGHT_WM2`: irradiance above which a slot counts as daylight
pub const DAYLIGHT_WM2: f64 = 50.0;
/// Python `POA_FILTER_MIN_WM2`
pub const POA_FILTER_MIN_WM2: f64 = 200.0;
/// Python `POA_FILTER_MAX_WM2`
pub const POA_FILTER_MAX_WM2: f64 = 1200.0;
/// Python `STALE_RUN_LEN`: >= 3 consecutive identical non-zero readings = stale sensor reading
pub const STALE_RUN_LEN: usize = 3;
/// Python `DEFAULT_GAMMA_PCT_PER_K`: default Pmax temperature coefficient (%/°C)
pub const DEFAULT_GAMMA_PCT_PER_K: f64 = -0.30;
/// Python `MIN_PR_COVERAGE`
pub const MIN_PR_COVERAGE: f64 = 0.9;
/// Python `CHECK_HOURS`: daily O&M check hours of the PWA monitoring report
pub const CHECK_HOURS: [u32; 3] = [9, 13, 17];
/// Python `CHECK_NEAREST` (minutes)
pub const CHECK_NEAREST_MIN: i64 = 10;

const TS_FMT: &str = "%Y-%m-%d %H:%M:%S";

fn fmt(ts: NaiveDateTime) -> String {
    ts.format(TS_FMT).to_string()
}

fn parse_ts(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, TS_FMT).ok()
}

/// Python `_mean` (growatt_weather): plain `sum(v) / len(v)` of the non-null values.
fn mean(vals: &[f64]) -> Option<f64> {
    if vals.is_empty() {
        return None;
    }
    Some(py_sum(vals.iter().copied()) / vals.len() as f64)
}

/// Python `max(vals)` of floats (first maximum)
fn max_of(vals: &[f64]) -> Option<f64> {
    vals.iter().copied().fold(None, |m, v| match m {
        Some(m) if m >= v => Some(m),
        _ => Some(v),
    })
}

/// Python `_circular_mean_deg`
pub fn circular_mean_deg(vals: &[f64]) -> Option<f64> {
    if vals.is_empty() {
        return None;
    }
    let s = py_sum(vals.iter().map(|v| v.to_radians().sin()));
    let c = py_sum(vals.iter().map(|v| v.to_radians().cos()));
    if s.abs() < 1e-9 && c.abs() < 1e-9 {
        return None;
    }
    Some(s.atan2(c).to_degrees().rem_euclid(360.0))
}

/// Python `_integrate_kwh_m2`: insolation (kWh/m²) from time-ordered (timestamp, W/m²) samples;
/// gaps are not credited.
fn integrate_kwh_m2(points: &[(NaiveDateTime, f64)]) -> f64 {
    let max_gap_h = 10.0 / 60.0;
    if points.is_empty() {
        return 0.0;
    }
    let dts: Vec<f64> = points.windows(2).map(|w| (w[1].0 - w[0].0).num_microseconds().unwrap_or(0) as f64 / 1e6 / 3600.0).collect();
    let mut regular: Vec<f64> = dts.iter().copied().filter(|d| *d > 0.0 && *d <= max_gap_h).collect();
    regular.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let typical = if regular.is_empty() { 5.0 / 60.0 } else { regular[regular.len() / 2] };
    let mut weights = vec![typical];
    weights.extend(dts.iter().map(|d| if *d > 0.0 && *d <= max_gap_h { *d } else { typical }));
    py_sum(points.iter().zip(weights).filter(|((_, g), _)| *g != 0.0 && *g > 0.0).map(|((_, g), w)| g * w)) / 1000.0
}

/// A row of `growatt_env_sensors` (Python `GrowattEnvSensor`, the columns read here).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EnvSensor {
    pub datalogger_sn: String,
    pub address: i32,
    pub plant_id: i32,
    pub device_name: Option<String>,
}

/// Python `plant_sensors`: the plant's sensors by datalogger SN, address.
pub async fn plant_sensors(pool: &PgPool, plant_id: i64) -> Result<Vec<EnvSensor>> {
    Ok(sqlx::query_as::<_, EnvSensor>(
        "SELECT datalogger_sn, address, plant_id, device_name FROM growatt_env_sensors WHERE plant_id = $1 \
         ORDER BY datalogger_sn, address",
    )
    .bind(plant_id as i32)
    .fetch_all(pool)
    .await?)
}

/// Python `measured_by_sensor`: fields that read non-zero at least once since `since` (and before
/// `until`), per sensor with stored readings in that window (`plant_ids` None = every plant).
pub async fn measured_by_sensor(
    pool: &PgPool,
    since: NaiveDateTime,
    plant_ids: Option<&[i64]>,
    until: Option<NaiveDateTime>,
) -> Result<HashMap<(String, i32), Vec<&'static str>>> {
    let aggs: Vec<String> = FIELDS.iter().map(|f| format!("min(e.{f}), max(e.{f})")).collect();
    let mut sql = format!(
        "SELECT e.datalogger_sn, e.address, {} FROM growatt_env_readings e JOIN growatt_env_sensors s \
         ON s.datalogger_sn = e.datalogger_sn AND s.address = e.address WHERE e.timestamp >= $1",
        aggs.join(", ")
    );
    if plant_ids.is_some() {
        sql.push_str(" AND s.plant_id = ANY($2)");
    }
    if until.is_some() {
        sql.push_str(if plant_ids.is_some() { " AND e.timestamp < $3" } else { " AND e.timestamp < $2" });
    }
    sql.push_str(" GROUP BY e.datalogger_sn, e.address");
    let mut q = sqlx::query(&sql).bind(since);
    if let Some(ids) = plant_ids {
        let ids: Vec<i32> = if ids.is_empty() { vec![-1] } else { ids.iter().map(|&i| i as i32).collect() };
        q = q.bind(ids);
    }
    if let Some(u) = until {
        q = q.bind(u);
    }
    use sqlx::Row;
    let mut out = HashMap::new();
    for row in q.fetch_all(pool).await? {
        let dl: String = row.try_get(0)?;
        let addr: i32 = row.try_get(1)?;
        let mut fields = Vec::new();
        for (i, f) in FIELDS.iter().enumerate() {
            let lo: Option<f64> = row.try_get(2 + 2 * i)?;
            let hi: Option<f64> = row.try_get(3 + 2 * i)?;
            if lo.unwrap_or(0.0) != 0.0 || hi.unwrap_or(0.0) != 0.0 {
                fields.push(*f);
            }
        }
        out.insert((dl, addr), fields);
    }
    Ok(out)
}

/// Python `measured_fields`: per sensor of the plant, the fields that read non-zero since `since`;
/// None for a sensor with no stored readings in that window (unknown: keep every field).
pub async fn measured_fields(pool: &PgPool, plant_id: i64, since: NaiveDateTime) -> Result<Vec<((String, i32), Option<Vec<&'static str>>)>> {
    let seen = measured_by_sensor(pool, since, Some(&[plant_id]), None).await?;
    Ok(plant_sensors(pool, plant_id)
        .await?
        .into_iter()
        .map(|s| {
            let k = (s.datalogger_sn, s.address);
            let v = seen.get(&k).cloned();
            (k, v)
        })
        .collect())
}

/// Python `latest_day`: date of the plant's newest stored sensor reading.
pub async fn latest_day(pool: &PgPool, plant_id: i64) -> Result<Option<NaiveDate>> {
    let ts: Option<NaiveDateTime> = sqlx::query_scalar(
        "SELECT max(e.timestamp) FROM growatt_env_readings e JOIN growatt_env_sensors s \
         ON s.datalogger_sn = e.datalogger_sn AND s.address = e.address WHERE s.plant_id = $1",
    )
    .bind(plant_id as i32)
    .fetch_one(pool)
    .await?;
    Ok(ts.map(|t| t.date()))
}

/// Errors of `build_weather_day` besides the database.
#[derive(Debug, thiserror::Error)]
pub enum WeatherError {
    /// Python `KeyError`: the plant has no such sensor (the route answers 404)
    #[error("no weather sensor {0}#{1} at plant {2}")]
    NoSuchSensor(String, i32, i64),
    #[error(transparent)]
    Service(#[from] crate::common::ServiceError),
}

impl From<sqlx::Error> for WeatherError {
    fn from(e: sqlx::Error) -> Self {
        WeatherError::Service(e.into())
    }
}

type Reading = (NaiveDateTime, [Option<f64>; 6]);
/// one `growatt_env_readings` row: timestamp + FIELDS
type EnvRow = (NaiveDateTime, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);

/// Python `build_weather_day`: 5-minute weather series and daily KPIs for one plant-local day.
///
/// `sensor` = (datalogger SN, address) limits the series and KPIs to that sensor (every sensor is
/// still listed); `start_time` / `end_time` (inclusive) narrow the series and KPIs. `day=None` =
/// the latest day with weather data (or none when `latest_if_none` is false).
pub async fn build_weather_day(
    pool: &PgPool,
    plant_id: i64,
    day: Option<NaiveDate>,
    latest_if_none: bool,
    start_time: Option<NaiveTime>,
    end_time: Option<NaiveTime>,
    sensor: Option<(String, i32)>,
) -> std::result::Result<Value, WeatherError> {
    let sensors = plant_sensors(pool, plant_id).await?;
    if let Some((sn, addr)) = &sensor {
        if sensors.iter().all(|s| (&s.datalogger_sn, &s.address) != (sn, addr)) {
            return Err(WeatherError::NoSuchSensor(sn.clone(), *addr, plant_id));
        }
    }
    let mut day = day;
    if day.is_none() && latest_if_none {
        day = latest_day(pool, plant_id).await?;
    }
    let mut out_sensors: Vec<Value> = Vec::new();
    let Some(d) = day.filter(|_| !sensors.is_empty()) else {
        return Ok(result(day, &sensors, out_sensors, Vec::new(), Map::new(), None, None, sensor.as_ref()));
    };

    let start = d.and_time(NaiveTime::MIN);
    let end = start + chrono::Duration::days(1);
    let mut slots: BTreeMap<NaiveDateTime, [Vec<f64>; 6]> = BTreeMap::new();
    let cols = FIELDS.join(", ");
    for s in &sensors {
        let rows: Vec<EnvRow> = sqlx::query_as(&format!(
            "SELECT timestamp, {cols} FROM growatt_env_readings WHERE datalogger_sn = $1 AND address = $2 \
             AND timestamp >= $3 AND timestamp < $4 ORDER BY timestamp"
        ))
        .bind(&s.datalogger_sn)
        .bind(s.address)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        let rows: Vec<Reading> = rows.into_iter().map(|r| (r.0, [r.1, r.2, r.3, r.4, r.5, r.6])).collect();
        // A field that never leaves 0 all day was not measured (probe not fitted / broken).
        let measured: [bool; 6] = std::array::from_fn(|i| rows.iter().any(|r| r.1[i].unwrap_or(0.0) != 0.0));
        out_sensors.push(json!({
            "datalogger_sn": s.datalogger_sn,
            "address": s.address,
            "device_name": s.device_name,
            "samples": rows.len(),
            "first_reading": rows.first().map(|r| fmt(r.0)),
            "last_reading": rows.last().map(|r| fmt(r.0)),
            "measured": FIELDS.iter().zip(measured).filter(|(_, m)| *m).map(|(f, _)| *f).collect::<Vec<_>>(),
        }));
        if let Some((sn, addr)) = &sensor {
            if (&s.datalogger_sn, &s.address) != (sn, addr) {
                continue; // listed above, but not part of the series
            }
        }
        // per 5-min slot of this sensor, in first-seen (time) order
        let mut per_sensor: Vec<(NaiveDateTime, [Vec<f64>; 6])> = Vec::new();
        for (ts, vals) in &rows {
            let b = bucket(*ts);
            if per_sensor.last().is_none_or(|(t, _)| *t != b) {
                per_sensor.push((b, Default::default()));
            }
            let slot = &mut per_sensor.last_mut().expect("pushed").1;
            for i in 0..6 {
                if let (true, Some(v)) = (measured[i], vals[i]) {
                    slot[i].push(v);
                }
            }
        }
        for (ts, b) in per_sensor {
            let slot = slots.entry(ts).or_default();
            for i in 0..6 {
                // average within the slot per sensor first, then across sensors
                let v = if i == 5 { circular_mean_deg(&b[i]) } else { mean(&b[i]) };
                if let Some(v) = v {
                    slot[i].push(v);
                }
            }
        }
    }

    let mut series: Vec<Value> = slots
        .iter()
        .map(|(ts, b)| {
            json!({
                "timestamp": fmt(*ts),
                "irradiance_wm2": round_opt(mean(&b[0]), 1),
                "ambient_temp_c": round_opt(mean(&b[1]), 1),
                "module_temp_c": round_opt(mean(&b[2]), 1),
                "humidity_pct": round_opt(mean(&b[3]), 1),
                "wind_speed_ms": round_opt(mean(&b[4]), 1),
                "wind_dir_deg": round_opt(circular_mean_deg(&b[5]), 0),
            })
        })
        .collect();
    if start_time.is_some() || end_time.is_some() {
        let lo = start_time.unwrap_or(NaiveTime::MIN);
        let hi = end_time.unwrap_or(NaiveTime::from_hms_micro_opt(23, 59, 59, 999_999).expect("time.max"));
        series.retain(|p| p["timestamp"].as_str().and_then(parse_ts).is_some_and(|t| lo <= t.time() && t.time() <= hi));
    }
    let k = kpis(&series);
    Ok(result(day, &sensors, out_sensors, series, k, start_time, end_time, sensor.as_ref()))
}

fn f(p: &Value, key: &str) -> Option<f64> {
    p.get(key).and_then(Value::as_f64)
}

/// Python `_stale_timestamps`: timestamps where `field` is non-zero and identical for
/// `STALE_RUN_LEN` or more consecutive samples (logger forward-fill / frozen sensor).
pub fn stale_timestamps(series: &[Value], field: &str) -> HashSet<String> {
    let mut stale = HashSet::new();
    let mut run: Vec<String> = Vec::new();
    let mut last_val: Option<f64> = None;
    for p in series {
        let v = f(p, field);
        let ts = p.get("timestamp").and_then(Value::as_str).filter(|t| !t.is_empty());
        let (Some(v), Some(ts)) = (v.filter(|v| *v > 0.0), ts) else {
            if run.len() >= STALE_RUN_LEN {
                stale.extend(run.drain(..));
            }
            run.clear();
            last_val = None;
            continue;
        };
        let fv = py_round(v, 2);
        if last_val == Some(fv) {
            run.push(ts.to_owned());
        } else {
            if run.len() >= STALE_RUN_LEN {
                stale.extend(run.drain(..));
            }
            run = vec![ts.to_owned()];
            last_val = Some(fv);
        }
    }
    if run.len() >= STALE_RUN_LEN {
        stale.extend(run);
    }
    stale
}

/// Python `_kpis`: the day's (or window's) weather KPIs from the series.
pub fn kpis(series: &[Value]) -> Map<String, Value> {
    let irr: Vec<(NaiveDateTime, f64)> = series
        .iter()
        .filter_map(|p| Some((parse_ts(p["timestamp"].as_str()?)?, f(p, "irradiance_wm2")?)))
        .collect();
    let day_pts: Vec<&Value> = series.iter().filter(|p| f(p, "irradiance_wm2").unwrap_or(0.0) >= DAYLIGHT_WM2).collect();
    let stale_ts = stale_timestamps(series, "irradiance_wm2");
    let filtered_pts: Vec<&Value> = series
        .iter()
        .filter(|p| {
            f(p, "irradiance_wm2").is_some_and(|g| (POA_FILTER_MIN_WM2..=POA_FILTER_MAX_WM2).contains(&g))
                && !stale_ts.contains(p["timestamp"].as_str().unwrap_or(""))
        })
        .collect();
    // Irradiance-weighted module temperature: sum(G * T_mod) / sum(G)
    let base = if filtered_pts.is_empty() { &day_pts } else { &filtered_pts };
    let pairs: Vec<(f64, f64)> = base
        .iter()
        .filter_map(|p| {
            let g = f(p, "irradiance_wm2").filter(|g| *g != 0.0)?;
            Some((g, f(p, "module_temp_c")?))
        })
        .collect();
    let sum_g = py_sum(pairs.iter().map(|(g, _)| *g));
    let irr_weighted = if !pairs.is_empty() && sum_g > 0.0 { Some(py_sum(pairs.iter().map(|(g, t)| g * t)) / sum_g) } else { None };
    let col = |name: &str, pts: &[&Value]| -> Vec<f64> { pts.iter().filter_map(|p| f(p, name)).collect() };
    let all: Vec<&Value> = series.iter().collect();
    let g_vals: Vec<f64> = irr.iter().map(|(_, g)| *g).collect();
    let mut m = Map::new();
    m.insert("insolation_kwh_m2".into(), json!(if irr.is_empty() { None } else { Some(py_round(integrate_kwh_m2(&irr), 3)) }));
    m.insert("peak_irradiance_wm2".into(), json!(round_opt(max_of(&g_vals), 0)));
    m.insert("avg_ambient_temp_c".into(), json!(round_opt(mean(&col("ambient_temp_c", &all)), 1)));
    m.insert("max_ambient_temp_c".into(), json!(round_opt(max_of(&col("ambient_temp_c", &all)), 1)));
    m.insert("avg_module_temp_daylight_c".into(), json!(round_opt(mean(&col("module_temp_c", &day_pts)), 1)));
    m.insert("irradiance_weighted_module_temp_c".into(), json!(round_opt(irr_weighted, 1)));
    m.insert("max_module_temp_c".into(), json!(round_opt(max_of(&col("module_temp_c", &all)), 1)));
    m.insert("avg_humidity_pct".into(), json!(round_opt(mean(&col("humidity_pct", &all)), 0)));
    m.insert("avg_wind_speed_ms".into(), json!(round_opt(mean(&col("wind_speed_ms", &all)), 1)));
    m.insert("max_wind_speed_ms".into(), json!(round_opt(max_of(&col("wind_speed_ms", &all)), 1)));
    m.insert("stale_irradiance_slots".into(), json!(stale_ts.len()));
    m.insert("poa_filtered_slots".into(), json!(filtered_pts.len()));
    m
}

/// Python `_result`: the answer of `build_weather_day`.
#[allow(clippy::too_many_arguments)]
fn result(
    day: Option<NaiveDate>,
    sensors: &[EnvSensor],
    out_sensors: Vec<Value>,
    series: Vec<Value>,
    kpis: Map<String, Value>,
    start_time: Option<NaiveTime>,
    end_time: Option<NaiveTime>,
    sensor: Option<&(String, i32)>,
) -> Value {
    let mut all_kpis: Map<String, Value> = [
        "insolation_kwh_m2",
        "peak_irradiance_wm2",
        "avg_ambient_temp_c",
        "max_ambient_temp_c",
        "avg_module_temp_daylight_c",
        "irradiance_weighted_module_temp_c",
        "max_module_temp_c",
        "avg_humidity_pct",
        "avg_wind_speed_ms",
        "max_wind_speed_ms",
    ]
    .iter()
    .map(|k| ((*k).to_owned(), Value::Null))
    .collect();
    all_kpis.insert("stale_irradiance_slots".into(), json!(0));
    all_kpis.insert("poa_filtered_slots".into(), json!(0));
    all_kpis.extend(kpis);
    let data_until = out_sensors.iter().filter_map(|s| s["last_reading"].as_str()).max().map(str::to_owned);
    let window = if start_time.is_none() && end_time.is_none() {
        Value::Null
    } else {
        json!({
            "start": start_time.map(|t| t.format("%H:%M").to_string()),
            "end": end_time.map(|t| t.format("%H:%M").to_string()),
        })
    };
    // without a day the sensors are still listed, with no readings
    let listed = if out_sensors.is_empty() {
        sensors
            .iter()
            .map(|s| {
                json!({
                    "datalogger_sn": s.datalogger_sn,
                    "address": s.address,
                    "device_name": s.device_name,
                    "samples": 0,
                    "first_reading": null,
                    "last_reading": null,
                    "measured": [],
                })
            })
            .collect()
    } else {
        out_sensors
    };
    json!({
        "meta": {
            "source": "db",
            "day": day.map(|d| d.to_string()),
            "data_until": data_until,
            // the one sensor the series covers (None = average of all sensors)
            "sensor": sensor.map(|(sn, a)| json!({"datalogger_sn": sn, "address": a})),
            "window": window,
        },
        "has_sensor": !sensors.is_empty(),
        "sensors": listed,
        "kpis": all_kpis,
        "series": series,
    })
}

/// Python `check_slots`: sensor reading at each `CHECK_HOURS` time ("09", "13", "17"): the slot
/// nearest hh:00 within `CHECK_NEAREST`, or None.
pub fn check_slots(series: &[Value], day: Option<NaiveDate>) -> Map<String, Value> {
    let points: Vec<(NaiveDateTime, &Value)> = series
        .iter()
        .filter(|p| f(p, "irradiance_wm2").is_some())
        .filter_map(|p| Some((parse_ts(p["timestamp"].as_str()?)?, p)))
        .collect();
    let mut out = Map::new();
    for h in CHECK_HOURS {
        let mut hit = Value::Null;
        if let Some(d) = day {
            let at = d.and_hms_opt(h, 0, 0).expect("check hour");
            // min(): the first of equally near points
            let mut best: Option<(i64, NaiveDateTime, &Value)> = None;
            for (ts, p) in &points {
                let gap = (*ts - at).num_microseconds().unwrap_or(i64::MAX).abs();
                if best.is_none_or(|(g, _, _)| gap < g) {
                    best = Some((gap, *ts, p));
                }
            }
            if let Some((gap, ts, p)) = best {
                if gap <= CHECK_NEAREST_MIN * 60_000_000 {
                    hit = json!({"at": format!("{:02}:{:02}", ts.hour(), ts.minute()), "irradiance_wm2": p["irradiance_wm2"], "module_temp_c": p["module_temp_c"]});
                }
            }
        }
        out.insert(format!("{h:02}"), hit);
    }
    out
}

/// Python `iec_pr`: IEC 61724-1 performance ratio from measured irradiance, with the coverage it
/// rests on; null with a `reason` when it cannot be judged. Also PR' (temperature-corrected).
pub fn iec_pr(yield_kwh: Option<f64>, capacity_kwp: Option<f64>, weather: &Value, producing_slots: &[String], gamma_pct_per_k: f64) -> Value {
    let irr_slots: HashSet<&str> = weather["series"]
        .as_array()
        .map(|s| s.iter().filter(|p| f(p, "irradiance_wm2").is_some()).filter_map(|p| p["timestamp"].as_str()).collect())
        .unwrap_or_default();
    let coverage = if producing_slots.is_empty() {
        None
    } else {
        Some(producing_slots.iter().filter(|t| irr_slots.contains(t.as_str())).count() as f64 / producing_slots.len() as f64)
    };
    let h = f(&weather["kpis"], "insolation_kwh_m2");
    let t_mod_w = f(&weather["kpis"], "irradiance_weighted_module_temp_c");
    let cap = capacity_kwp.filter(|c| *c != 0.0);
    let reason: Option<String> = if !weather["has_sensor"].as_bool().unwrap_or(false) {
        Some("no weather sensor".into())
    } else if h.is_none_or(|h| h == 0.0) {
        Some("no irradiance measured".into())
    } else if cap.is_none() {
        Some("plant capacity unknown".into())
    } else if yield_kwh.is_none() {
        Some("no yield".into())
    } else if coverage.is_none_or(|c| c < MIN_PR_COVERAGE) {
        let pct = coverage.map_or(0.0, |c| (c * 100.0).round_ties_even());
        Some(format!("irradiance covers {}% of producing time", pct as i64))
    } else {
        None
    };
    let mut pr = None;
    let mut pr_temp = None;
    if let (None, Some(y), Some(c), Some(h)) = (&reason, yield_kwh, cap, h.filter(|h| *h != 0.0)) {
        let raw = y / c / h * 100.0;
        pr = Some(py_round(raw, 1));
        if let Some(t) = t_mod_w {
            let factor = 1.0 + (gamma_pct_per_k / 100.0) * (t - 25.0);
            if factor > 0.2 {
                pr_temp = Some(py_round(raw / factor, 1));
            }
        }
    }
    json!({
        "pr_pct": pr,
        "pr_temp_corrected_pct": pr_temp,
        "irradiance_weighted_module_temp_c": weather["kpis"].get("irradiance_weighted_module_temp_c").cloned().unwrap_or(Value::Null),
        "reference_yield_h": round_opt(h, 3),
        "final_yield_h": match (yield_kwh, cap) { (Some(y), Some(c)) => Some(py_round(y / c, 3)), _ => None },
        "coverage_pct": round_opt(coverage.map(|c| c * 100.0), 0),
        "reason": reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(ts: &str, g: Option<f64>, t: Option<f64>) -> Value {
        json!({"timestamp": ts, "irradiance_wm2": g, "ambient_temp_c": null, "module_temp_c": t, "humidity_pct": null, "wind_speed_ms": null, "wind_dir_deg": null})
    }

    #[test]
    fn circular() {
        assert!((circular_mean_deg(&[350.0, 10.0]).unwrap() - 0.0).abs() < 1e-9 || (circular_mean_deg(&[350.0, 10.0]).unwrap() - 360.0).abs() < 1e-9);
        assert_eq!(circular_mean_deg(&[]), None);
        assert_eq!(circular_mean_deg(&[0.0, 180.0]), None);
        assert!((circular_mean_deg(&[270.0]).unwrap() - 270.0).abs() < 1e-9);
    }

    #[test]
    fn stale_runs() {
        let s: Vec<Value> = (0..5).map(|i| p(&format!("2026-11-27 10:{:02}:00", i * 5), Some(500.0), None)).collect();
        assert_eq!(stale_timestamps(&s, "irradiance_wm2").len(), 5);
        let s2 = vec![p("2026-11-27 10:00:00", Some(500.0), None), p("2026-11-27 10:05:00", Some(500.0), None)];
        assert!(stale_timestamps(&s2, "irradiance_wm2").is_empty());
    }

    #[test]
    fn kpis_and_slots() {
        let s = vec![
            p("2026-11-27 08:55:00", Some(300.0), Some(30.0)),
            p("2026-11-27 09:05:00", Some(400.0), Some(40.0)),
            p("2026-11-27 09:10:00", Some(0.0), None),
        ];
        let k = kpis(&s);
        assert_eq!(k["peak_irradiance_wm2"], json!(400.0));
        assert_eq!(k["poa_filtered_slots"], json!(2));
        // (300*30 + 400*40) / 700 = 35.714…
        assert_eq!(k["irradiance_weighted_module_temp_c"], json!(35.7));
        let c = check_slots(&s, NaiveDate::from_ymd_opt(2026, 11, 27));
        assert_eq!(c["09"]["at"], json!("08:55"));
        assert_eq!(c["13"], Value::Null);
        let empty = kpis(&[]);
        assert_eq!(empty["insolation_kwh_m2"], Value::Null);
    }

    #[test]
    fn pr_reasons() {
        let w = json!({"has_sensor": false, "series": [], "kpis": {"insolation_kwh_m2": null}});
        assert_eq!(iec_pr(Some(1.0), Some(1.0), &w, &[], DEFAULT_GAMMA_PCT_PER_K)["reason"], json!("no weather sensor"));
        let w = json!({"has_sensor": true, "series": [{"timestamp": "a", "irradiance_wm2": 500.0}], "kpis": {"insolation_kwh_m2": 5.0, "irradiance_weighted_module_temp_c": 45.0}});
        let r = iec_pr(Some(400.0), Some(100.0), &w, &["a".into()], DEFAULT_GAMMA_PCT_PER_K);
        assert_eq!(r["pr_pct"], json!(80.0));
        assert_eq!(r["coverage_pct"], json!(100.0));
        let r = iec_pr(Some(400.0), Some(100.0), &w, &["a".into(), "b".into(), "c".into()], DEFAULT_GAMMA_PCT_PER_K);
        assert_eq!(r["reason"], json!("irradiance covers 33% of producing time"));
    }
}
