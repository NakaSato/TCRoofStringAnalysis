//! The stored daily rule / KPI rows behind the decision rules (DB only), as the two routes of
//! backend/app/api/routes/growatt/rules.py read them: `plant_rule_daily` (`growatt_string_daily`
//! / `growatt_inverter_daily` of one inverter or string) and `plant_kpi_daily`
//! (`growatt_plant_daily` with the R16 sensor verdict per day and the EPI factor in use). The
//! rows are written by the rules jobs (`growatt_daily`); nothing here computes or stores them.

use chrono::{Duration, NaiveDate};
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{Column, PgPool, Row, TypeInfo};

use crate::common::Result;
use crate::issues::id32;
use crate::overview::{epi_factor_info, r16_settings};

/// Python `rules.plant_rule_daily` columns of a string day
pub const STRING_COLS: [&str; 9] =
    ["gated_slots", "ratio_median", "low_min", "severe_min", "open_min", "v_ratio_median", "voltage_sensing", "energy_kwh", "lost_kwh_est"];

/// Python `rules.plant_rule_daily` columns of an inverter day
pub const INVERTER_COLS: [&str; 19] = [
    "daylight_min", "producing_min", "fault_min", "off_min", "standby_min", "limited_min", "no_data_min",
    "energy_kwh", "dc_energy_kwh", "kwp", "ya_kwh_kwp", "yf_kwh_kwp", "ya_minus_yf",
    "yf_vs_median_pct", "plant_kwp_share_pct",
    "lost_fault_kwh_est", "lost_off_kwh_est", "lost_standby_kwh_est", "lost_no_data_kwh_est",
];

/// Python `rules.plant_kpi_daily` columns
pub const KPI_COLS: [&str; 23] = [
    "capacity_kwp", "energy_kwh", "dc_energy_kwh", "modelled_energy_kwh", "yr_h",
    "ya_kwh_kwp", "yf_kwh_kwp", "ya_minus_yf", "pr_pct", "pr_temp_corrected_pct", "epi", "system_factor",
    "irradiance_weighted_tmod_c", "filtered_slots", "stale_masked_slots",
    "clipped_masked_slots", "curtailed_masked_slots",
    "sensor_stale_slots", "sensor_high_slots", "sensor_midday_wm2", "sensor_neighbour_ratio",
    "sensor_neighbours", "cloud_midday_pct",
];

/// One column of a row as Python's ORM attribute would serialize: ints, floats, text, null.
fn cell(row: &PgRow, name: &str) -> Value {
    let Some(col) = row.columns().iter().find(|c| c.name() == name) else { return Value::Null };
    let i = col.ordinal();
    match col.type_info().name() {
        "INT2" => row.try_get::<Option<i16>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(v)),
        "INT4" => row.try_get::<Option<i32>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(v)),
        "INT8" => row.try_get::<Option<i64>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(v)),
        "FLOAT4" => row.try_get::<Option<f32>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(f64::from(v))),
        "FLOAT8" => row.try_get::<Option<f64>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(v)),
        "BOOL" => row.try_get::<Option<bool>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(v)),
        _ => row.try_get::<Option<String>, _>(i).ok().flatten().map_or(Value::Null, |v| json!(v)),
    }
}

fn day_row(row: &PgRow, cols: &[&str]) -> Map<String, Value> {
    let mut m = Map::new();
    let day: NaiveDate = row.try_get("day").unwrap_or_default();
    m.insert("day".into(), json!(day.format("%Y-%m-%d").to_string()));
    for c in cols {
        m.insert((*c).to_owned(), cell(row, c));
    }
    m
}

fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Python `rules.plant_rule_daily`: the daily rows behind the rules for one inverter (or one of
/// its strings), the `days` days up to `end`. Lost kWh are estimates.
pub async fn rule_daily(pool: &PgPool, plant_id: i64, sn: &str, string_no: Option<i64>, days: i64, end: NaiveDate) -> Result<Value> {
    let start = end - Duration::days(days - 1);
    let (rows, cols): (Vec<PgRow>, &[&str]) = match string_no {
        Some(no) => (
            sqlx::query(&format!(
                "SELECT day, {} FROM growatt_string_daily WHERE plant_id = $1 AND device_sn = $2 AND string_no = $3 \
                 AND day >= $4 AND day <= $5 ORDER BY day",
                STRING_COLS.join(", ")
            ))
            .bind(id32(plant_id))
            .bind(sn)
            .bind(id32(no))
            .bind(start)
            .bind(end)
            .fetch_all(pool)
            .await?,
            &STRING_COLS,
        ),
        None => (
            sqlx::query(&format!(
                "SELECT day, {} FROM growatt_inverter_daily WHERE plant_id = $1 AND device_sn = $2 AND day >= $3 AND day <= $4 ORDER BY day",
                INVERTER_COLS.join(", ")
            ))
            .bind(id32(plant_id))
            .bind(sn)
            .bind(start)
            .bind(end)
            .fetch_all(pool)
            .await?,
            &INVERTER_COLS,
        ),
    };
    let data: Vec<Value> = rows.iter().map(|r| Value::Object(day_row(r, cols))).collect();
    Ok(json!({
        "plant_id": plant_id,
        "device_sn": sn,
        "string_no": string_no,
        "start": iso(start),
        "end": iso(end),
        "days": data,
        "meta": {"source": "db", "estimated": cols.iter().filter(|c| c.ends_with("_est")).collect::<Vec<_>>()},
    }))
}

/// Python `growatt_rules.sensor_verdict` → (`ok`, `flags`): None when the day has no irradiance
/// evidence to judge.
fn sensor_verdict(m: &Map<String, Value>, cfg: (f64, f64, f64, f64)) -> Option<(bool, Vec<&'static str>)> {
    let (c_stale, c_high, c_ratio, c_cloud) = cfg;
    let stale = m.get("sensor_stale_slots").and_then(Value::as_f64)?;
    let mut flags = Vec::new();
    if stale >= c_stale.trunc() {
        flags.push("stale");
    }
    if m.get("sensor_high_slots").and_then(Value::as_f64).is_some_and(|h| h >= c_high.trunc()) {
        flags.push("above_clear_sky");
    }
    let ratio = m.get("sensor_neighbour_ratio").and_then(Value::as_f64);
    let judged = ratio.is_some() && m.get("cloud_midday_pct").and_then(Value::as_f64).is_some_and(|c| c <= c_cloud);
    if judged && ratio.unwrap_or(0.0) < c_ratio {
        flags.push("below_neighbours");
    }
    Some((flags.is_empty(), flags))
}

/// Python `rules.plant_kpi_daily`: plant-level daily KPIs (PR, PR', EPI, Ya, Yf, Ya − Yf, filter
/// counts) of the `days` days up to `end`, each with the R16 verdict (`sensor_ok` null = not
/// judged), and the EPI system factor in use. EPI, modelled energy and cloud cover are modelled.
pub async fn kpi_daily(pool: &PgPool, plant_id: i64, days: i64, end: NaiveDate) -> Result<Value> {
    let start = end - Duration::days(days - 1);
    let rows: Vec<PgRow> = sqlx::query(&format!(
        "SELECT day, {} FROM growatt_plant_daily WHERE plant_id = $1 AND day >= $2 AND day <= $3 ORDER BY day",
        KPI_COLS.join(", ")
    ))
    .bind(id32(plant_id))
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?;
    let cfg = r16_settings(pool).await?;
    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut m = day_row(r, &KPI_COLS);
            let v = sensor_verdict(&m, cfg);
            m.insert("sensor_ok".into(), v.as_ref().map_or(Value::Null, |(ok, _)| json!(ok)));
            m.insert("sensor_flags".into(), json!(v.map(|(_, f)| f).unwrap_or_default()));
            Value::Object(m)
        })
        .collect();
    Ok(json!({
        "plant_id": plant_id,
        "start": iso(start),
        "end": iso(end),
        "days": data,
        "epi_factor": epi_factor_info(pool, plant_id).await?,
        "meta": {"source": "db", "modelled": ["modelled_energy_kwh", "epi", "system_factor", "cloud_midday_pct"]},
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict() {
        let cfg = (12.0, 6.0, 0.7, 20.0);
        let m = |v: Value| v.as_object().unwrap().clone();
        assert_eq!(sensor_verdict(&m(json!({"sensor_stale_slots": null})), cfg), None);
        assert_eq!(sensor_verdict(&m(json!({"sensor_stale_slots": 0, "sensor_high_slots": 2})), cfg), Some((true, vec![])));
        assert_eq!(
            sensor_verdict(&m(json!({"sensor_stale_slots": 12, "sensor_high_slots": 6, "sensor_neighbour_ratio": 0.5, "cloud_midday_pct": 20.0})), cfg),
            Some((false, vec!["stale", "above_clear_sky", "below_neighbours"]))
        );
        // cloudy: the neighbour check is not judged
        assert_eq!(
            sensor_verdict(&m(json!({"sensor_stale_slots": 0, "sensor_neighbour_ratio": 0.5, "cloud_midday_pct": 60.0})), cfg),
            Some((true, vec![]))
        );
    }
}
