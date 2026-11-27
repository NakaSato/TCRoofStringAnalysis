//! One inverter's stored day curve, raw records and daily trend (DB only), ported from
//! backend/app/services/growatt_inverter_history.py. Timestamps are plant-local (Thai) time,
//! stored naive; values that cannot be computed from stored data are `None`.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{Duration, Local, NaiveDate, NaiveDateTime, Timelike};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::{
    bucket, capacity_check, day_bounds, expected_kw, fmt_ts, get_plant, mean_opt, newest_inverter_ts, py_mean, py_round,
    round_opt, Inverter, Plant, Result, ServiceError, INACTIVE_MAX_A, INVERTER_COLS,
};
use crate::layout::load_layout;

/// Python `growatt_inverter_history.MAX_TREND_DAYS` (= raw history retention)
pub const MAX_TREND_DAYS: i64 = 90;
/// Python `growatt_inverter_history.RAW_MAX_ROWS`: a day of 5-min records is about 290
pub const RAW_MAX_ROWS: i64 = 400;

/// An inverter proven to belong to a plant (plan §4, device ownership): the only way to build one
/// is `resolve`, so a reading query keyed by it cannot reach another plant's inverter.
#[derive(Debug, Clone)]
pub struct PlantInverter {
    plant: Plant,
    inverter: Inverter,
}

impl PlantInverter {
    /// The plant (`Plant {id} not found`), then its inverter (`Inverter {sn} not found on plant
    /// {id}`), the checks of Python `build_inverter_timeseries` / `build_inverter_raw`.
    pub async fn resolve(pool: &PgPool, plant_id: i64, device_sn: &str) -> Result<PlantInverter> {
        let plant = get_plant(pool, plant_id).await?;
        let inverter: Option<Inverter> =
            sqlx::query_as(&format!("SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND device_sn = $2"))
                .bind(plant.plant_id)
                .bind(device_sn)
                .fetch_optional(pool)
                .await?;
        match inverter {
            Some(inverter) => Ok(PlantInverter { plant, inverter }),
            None => Err(ServiceError::NotFound(format!("Inverter {device_sn} not found on plant {plant_id}"))),
        }
    }

    pub fn plant(&self) -> &Plant {
        &self.plant
    }

    pub fn inverter(&self) -> &Inverter {
        &self.inverter
    }

    pub fn device_sn(&self) -> &str {
        &self.inverter.device_sn
    }
}

/// A `growatt_inverter_readings` row: (timestamp, pac_w, ppv_w, temperature_c)
type PowerRow = (NaiveDateTime, Option<f64>, Option<f64>, Option<f64>);
/// One 5-minute slot: pac (None = 0), ppv (None = 0), temperatures above 0
type PowerSlot = (Vec<f64>, Vec<f64>, Vec<f64>);

/// Python `round(inv.nominal_power_w / 1000, 1) if inv.nominal_power_w else None`
fn nominal_kw(inv: &Inverter) -> Option<f64> {
    inv.nominal_power_w.filter(|w| *w != 0.0).map(|w| py_round(w / 1000.0, 1))
}

/// Python `growatt_inverter_history.build_inverter_timeseries`: 5-minute AC / DC power and
/// temperature of one inverter for one day (stored history), the string-current heatmap, and the
/// modelled `expected_kw` envelope from the inverter's share of the plant kWp (its strings' modules
/// × Wp when every string that carried current has a layout entry, else plant kWp / inverters).
pub async fn build_inverter_timeseries(pool: &PgPool, inv: &PlantInverter, day: Option<NaiveDate>) -> Result<Value> {
    let plant = inv.plant();
    let device_sn = inv.device_sn();
    let sns = [device_sn.to_owned()];
    let day = match day {
        Some(d) => Some(d),
        None => newest_inverter_ts(pool, &sns, None).await?.map(|t| t.date()),
    };

    let mut cap_kwp: Option<f64> = None;
    let mut cap_basis: Option<&str> = None;
    if let Some(day) = day {
        let (d_start, d_end) = day_bounds(day);
        let seen: BTreeSet<i32> = sqlx::query_scalar::<_, i32>(
            "SELECT DISTINCT string_no FROM growatt_string_readings \
             WHERE device_sn = $1 AND timestamp >= $2 AND timestamp < $3 AND current_a > $4",
        )
        .bind(device_sn)
        .bind(d_start)
        .bind(d_end)
        .bind(INACTIVE_MAX_A)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
        let layout = load_layout(pool, &sns, true).await?;
        let key = |n: i32| (device_sn.to_owned(), n);
        if !seen.is_empty() && seen.iter().all(|n| layout.get(&key(*n)).is_some_and(|l| l.1.is_some_and(|w| w != 0.0))) {
            let w = seen.iter().fold(0.0, |acc, n| {
                let (m, wp) = layout[&key(*n)];
                acc + f64::from(m) * wp.unwrap_or(0.0)
            });
            cap_kwp = Some(py_round(w / 1000.0, 2));
            cap_basis = Some("string_layout");
        }
    }
    let plant_cap_kwp = if cap_kwp.is_none() { capacity_check(pool, plant).await?.0 } else { None };
    if let Some(pc) = plant_cap_kwp.filter(|c| *c != 0.0) {
        let n_inv: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL",
        )
        .bind(plant.plant_id)
        .fetch_one(pool)
        .await?;
        if n_inv != 0 {
            cap_kwp = Some(py_round(pc / n_inv as f64, 2));
            cap_basis = Some("plant_share");
        }
    }

    let mut timeseries: Vec<Value> = Vec::new();
    let mut strings_heat = json!({"string_nos": [], "timestamps": [], "current_a": []});
    if let Some(day) = day {
        let (start, end) = day_bounds(day);
        let rows: Vec<PowerRow> = sqlx::query_as(
            "SELECT timestamp, pac_w, ppv_w, temperature_c FROM growatt_inverter_readings \
             WHERE device_sn = $1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp",
        )
        .bind(device_sn)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        // per slot: pac (None = 0), ppv (None = 0), temperatures > 0
        let mut slots: BTreeMap<NaiveDateTime, PowerSlot> = BTreeMap::new();
        for (ts, pac, ppv, temp) in rows {
            let b = slots.entry(bucket(ts)).or_default();
            b.0.push(pac.unwrap_or(0.0));
            b.1.push(ppv.unwrap_or(0.0));
            if let Some(t) = temp.filter(|t| *t > 0.0) {
                b.2.push(t);
            }
        }
        // string current per 5-min slot (rows exist only while the inverter produces)
        let srows: Vec<(NaiveDateTime, i32, Option<f64>)> = sqlx::query_as(
            "SELECT timestamp, string_no, current_a FROM growatt_string_readings \
             WHERE device_sn = $1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp",
        )
        .bind(device_sn)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        let mut str_slots: HashMap<(NaiveDateTime, i32), Vec<f64>> = HashMap::new();
        for (ts, n, a) in srows {
            if let Some(a) = a {
                str_slots.entry((bucket(ts), n)).or_default().push(a);
            }
        }
        let string_nos: BTreeSet<i32> = str_slots.keys().map(|k| k.1).collect();
        let str_times: BTreeSet<NaiveDateTime> = str_slots.keys().map(|k| k.0).collect();
        let current_a: Vec<Vec<Option<f64>>> = string_nos
            .iter()
            .map(|n| {
                str_times
                    .iter()
                    .map(|t| str_slots.get(&(*t, *n)).and_then(|v| py_mean(v)).map(|m| py_round(m, 2)))
                    .collect()
            })
            .collect();
        strings_heat = json!({
            "string_nos": string_nos,
            "timestamps": str_times.iter().map(|t| fmt_ts(Some(*t))).collect::<Vec<_>>(),
            // [string][slot]; null = no record for that string in that slot
            "current_a": current_a,
        });
        for (ts, (pac, ppv, temp)) in &slots {
            timeseries.push(json!({
                "timestamp": fmt_ts(Some(*ts)),
                "pac_kw": py_mean(pac).map(|m| py_round(m / 1000.0, 3)),
                "ppv_kw": py_mean(ppv).map(|m| py_round(m / 1000.0, 3)),
                "expected_kw": expected_kw(cap_kwp, f64::from(ts.hour()) + f64::from(ts.minute()) / 60.0),
                "temp_c": round_opt(mean_opt(temp.iter().map(|t| Some(*t))), 1),
            }));
        }
    }

    Ok(json!({
        "meta": {"source": "db", "day": day.map(|d| d.to_string())},
        "plant_id": plant.plant_id,
        "device_sn": device_sn,
        "capacity_kwp": cap_kwp,
        // "string_layout": modules × Wp of its strings; "plant_share": plant kWp / inverters (modelled)
        "capacity_basis": cap_basis,
        // rated AC power from Growatt (max_data_info); null until the fleet job has read it
        "nominal_power_kw": nominal_kw(inv.inverter()),
        "timeseries": timeseries,
        "strings": strings_heat,
    }))
}

/// Python `growatt_inverter_history.build_inverter_daily`: daily yield, peak AC and max temperature
/// of one inverter over `days` days ending at `end`, with the plant's per-inverter average yield.
/// Yield is `eac_today` of each day's last record carrying one (not MAX(): the counter carries
/// yesterday's total for a few minutes after midnight). Days without records are null. Python runs
/// two queries per day; here one query per kind covers the window, with the same per-day result.
pub async fn build_inverter_daily(pool: &PgPool, inv: &PlantInverter, end: Option<NaiveDate>, days: i64) -> Result<Value> {
    let plant = inv.plant();
    let device_sn = inv.device_sn();
    // every inverter of the plant, as Python (not-installed ones included; they have no records)
    let sns: Vec<String> = sqlx::query_scalar("SELECT device_sn FROM growatt_inverters WHERE plant_id = $1")
        .bind(plant.plant_id)
        .fetch_all(pool)
        .await?;
    let days = days.clamp(1, MAX_TREND_DAYS);
    let end = match end {
        Some(e) => e,
        None => newest_inverter_ts(pool, &[device_sn.to_owned()], None)
            .await?
            .map(|t| t.date())
            .unwrap_or_else(|| Local::now().date_naive()),
    };
    let first = end - Duration::days(days - 1);
    let (lo, _) = day_bounds(first);
    let (_, hi) = day_bounds(end);

    let last_eac: Vec<(String, NaiveDate, f64)> = sqlx::query_as(
        // (the output columns are aliased: a bare `timestamp` in ORDER BY would name the date column)
        "SELECT DISTINCT ON (r.device_sn, r.timestamp::date) r.device_sn AS sn, r.timestamp::date AS d, r.eac_today_kwh AS kwh \
         FROM growatt_inverter_readings r \
         WHERE r.device_sn = ANY($1) AND r.timestamp >= $2 AND r.timestamp < $3 AND r.eac_today_kwh IS NOT NULL \
         ORDER BY r.device_sn, r.timestamp::date, r.timestamp DESC",
    )
    .bind(&sns)
    .bind(lo)
    .bind(hi)
    .fetch_all(pool)
    .await?;
    let mut yields: HashMap<NaiveDate, Vec<(String, f64)>> = HashMap::new();
    for (sn, d, kwh) in last_eac {
        yields.entry(d).or_default().push((sn, kwh));
    }
    let peaks: Vec<(NaiveDate, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT r.timestamp::date AS d, max(r.pac_w), max(r.temperature_c) FROM growatt_inverter_readings r \
         WHERE r.device_sn = $1 AND r.timestamp >= $2 AND r.timestamp < $3 GROUP BY 1",
    )
    .bind(device_sn)
    .bind(lo)
    .bind(hi)
    .fetch_all(pool)
    .await?;
    let peaks: HashMap<NaiveDate, (Option<f64>, Option<f64>)> = peaks.into_iter().map(|(d, p, t)| (d, (p, t))).collect();

    let mut out: Vec<Value> = Vec::with_capacity(days as usize);
    for k in (0..days).rev() {
        let d = end - Duration::days(k);
        let day_yields = yields.get(&d).map(Vec::as_slice).unwrap_or(&[]);
        let own = day_yields.iter().find(|(sn, _)| sn == device_sn).map(|y| y.1);
        let vals: Vec<f64> = day_yields.iter().map(|y| y.1).collect();
        let avg = py_mean(&vals);
        let (peak_ac, max_temp) = peaks.get(&d).copied().unwrap_or((None, None));
        out.push(json!({
            "day": d.to_string(),
            "yield_kwh": round_opt(own, 2),
            "plant_avg_yield_kwh": round_opt(avg, 2),
            "inverters_reporting": vals.len(),
            // own yield / plant average × 100; null when either is missing or the average is 0
            "vs_plant_pct": match (own, avg.filter(|a| *a != 0.0)) {
                (Some(o), Some(a)) => Some(py_round(o / a * 100.0, 1)),
                _ => None,
            },
            "peak_ac_kw": peak_ac.map(|p| py_round(p / 1000.0, 2)),
            "max_temp_c": max_temp.filter(|t| *t > 0.0).map(|t| py_round(t, 1)),
        }));
    }
    Ok(json!({
        "meta": {"source": "db", "from": out[0]["day"], "to": out[out.len() - 1]["day"], "days": days},
        "plant_id": plant.plant_id,
        "device_sn": device_sn,
        "nominal_power_kw": nominal_kw(inv.inverter()),
        "daily": out,
    }))
}

/// Python `growatt_inverter_history.build_inverter_raw`: every stored field of one inverter's
/// `max_data` records for one day, exactly as Growatt reported them (`growatt_inverter_raw`).
/// `fields` = every field name seen that day. Empty for days older than
/// `HISTORY_RAW_RETENTION_DAYS` or stored before raw records were kept.
pub async fn build_inverter_raw(pool: &PgPool, inv: &PlantInverter, day: Option<NaiveDate>) -> Result<Value> {
    let device_sn = inv.device_sn();
    let day = match day {
        Some(d) => Some(d),
        None => sqlx::query_scalar::<_, Option<NaiveDateTime>>("SELECT max(timestamp) FROM growatt_inverter_raw WHERE device_sn = $1")
            .bind(device_sn)
            .fetch_one(pool)
            .await?
            .map(|t| t.date()),
    };
    let mut rows: Vec<(NaiveDateTime, Option<Value>)> = Vec::new();
    if let Some(day) = day {
        let (s, e) = day_bounds(day);
        rows = sqlx::query_as(
            "SELECT timestamp, data FROM growatt_inverter_raw WHERE device_sn = $1 AND timestamp >= $2 AND timestamp < $3 \
             ORDER BY timestamp LIMIT $4",
        )
        .bind(device_sn)
        .bind(s)
        .bind(e)
        .bind(RAW_MAX_ROWS)
        .fetch_all(pool)
        .await?;
    }
    let mut fields: BTreeSet<String> = BTreeSet::new();
    let mut records: Vec<Value> = Vec::with_capacity(rows.len());
    for (ts, data) in &rows {
        // Python {"time": ..., **(data or {})}: a field named "time" in the record wins
        let mut rec = Map::new();
        rec.insert("time".into(), Value::String(ts.format("%Y-%m-%d %H:%M:%S").to_string()));
        if let Some(Value::Object(m)) = data {
            for (k, v) in m {
                fields.insert(k.clone());
                rec.insert(k.clone(), v.clone());
            }
        }
        records.push(Value::Object(rec));
    }
    Ok(json!({
        "meta": {
            "plant_id": inv.plant().plant_id,
            "device_sn": device_sn,
            "day": day.map(|d| d.to_string()),
            "source": "growatt max_data, as reported",
            "records": rows.len(),
        },
        "fields": fields,
        "records": records,
    }))
}
