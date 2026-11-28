//! Growatt analytics computed from persisted history (DB only, no Growatt calls), ported from
//! backend/app/services/growatt_overview.py: the plant list, a plant's inverters, the single-plant
//! overview and the plant power curve. Timestamps in the reading tables are plant-local (Thai)
//! time; values that cannot be computed from stored data are `None`.

use std::collections::{HashMap, HashSet};

use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Value};
use sqlx::PgPool;

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, NaiveTime, Timelike, Utc};

use crate::common::{
    bucket, capacity_check, day_bounds, expected_kw, fmt_ts, get_plant, integrate_kwh, inverter_out, isoformat_utc, max_opt,
    mean_opt, newest_inverter_ts, plant_rated_ac_w, plausible_capacity_kwp, py_mean, py_round, round_opt, Inverter, Plant,
    Result, ServiceError, INACTIVE_MAX_A, INVERTER_COLS, MAX_GAP_H, PLANT_COLS,
};
use crate::meter::{self, Row};
use crate::strings::{self, StringAgg};
use crate::{curtailment, fleet_settings, plant_documents, tariff, weather};

/// Python `growatt_overview.list_plants_summary`: plant registry from the DB, with inverter counts
/// and energy from stored history (`total_energy_kwh` = the sum of each installed inverter's newest
/// stored `eac_total`). `current_power_w` / `status` are realtime: always null here.
pub async fn list_plants_summary(pool: &PgPool, plant_ids: Option<&HashSet<i64>>) -> Result<Vec<Value>> {
    if plant_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }
    let mut plants: Vec<Plant> = sqlx::query_as::<_, Plant>(&format!(
        "SELECT {PLANT_COLS} FROM growatt_plants ORDER BY phase IS NULL, phase, plant_id"
    ))
    .fetch_all(pool)
    .await?;
    if let Some(ids) = plant_ids {
        plants.retain(|p| ids.contains(&i64::from(p.plant_id)));
    }

    let rated_ac = plant_rated_ac_w(pool, None).await?;
    let inv_counts: HashMap<i64, i64> = sqlx::query_as::<_, (i32, i64)>(
        "SELECT plant_id, count(*) FROM growatt_inverters WHERE not_installed_at IS NULL GROUP BY plant_id",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(p, n)| (i64::from(p), n))
    .collect();

    // newest stored value per installed inverter (primary-key order), summed per plant
    async fn per_plant(pool: &PgPool, col: &str, bounds: Option<(NaiveDateTime, NaiveDateTime)>) -> Result<HashMap<i64, f64>> {
        let window = if bounds.is_some() { " AND r.timestamp >= $1 AND r.timestamp < $2" } else { "" };
        let sql = format!(
            "SELECT i.plant_id, i.device_sn, (SELECT r.{col} FROM growatt_inverter_readings r \
             WHERE r.device_sn = i.device_sn AND r.{col} IS NOT NULL{window} \
             ORDER BY r.device_sn DESC, r.timestamp DESC LIMIT 1) \
             FROM growatt_inverters i WHERE i.not_installed_at IS NULL"
        );
        let mut q = sqlx::query_as::<_, (i32, String, Option<f64>)>(&sql);
        if let Some((a, b)) = bounds {
            q = q.bind(a).bind(b);
        }
        let mut out: HashMap<i64, f64> = HashMap::new();
        for (pid, _sn, v) in q.fetch_all(pool).await? {
            if let Some(v) = v {
                *out.entry(i64::from(pid)).or_insert(0.0) += v;
            }
        }
        Ok(out)
    }

    let latest: Option<NaiveDateTime> =
        sqlx::query_scalar("SELECT max(timestamp) FROM growatt_inverter_readings").fetch_one(pool).await?;
    let energy_date: Option<NaiveDate> = latest.map(|t| t.date());
    let day_energy = match energy_date {
        Some(d) => per_plant(pool, "eac_today_kwh", Some(day_bounds(d))).await?,
        None => HashMap::new(),
    };
    let lifetime = per_plant(pool, "eac_total_kwh", None).await?;

    Ok(plants
        .iter()
        .map(|p| {
            let id = i64::from(p.plant_id);
            let cap = plausible_capacity_kwp(p.peak_power_kwp, rated_ac.get(&id).copied());
            let reported = match p.peak_power_kwp {
                Some(v) if v != 0.0 && cap.is_none() => Some(v),
                _ => None,
            };
            json!({
                "plant_id": p.plant_id,
                "phase": p.phase,
                "name": p.name,
                "city": p.city,
                "country": p.country,
                "latitude": p.latitude,
                "longitude": p.longitude,
                "peak_power_kwp": cap,
                "reported_peak_power_kwp": reported,
                "current_power_w": null,
                "today_energy_kwh": round_opt(day_energy.get(&id).copied(), 2),
                "energy_date": match energy_date {
                    Some(d) if day_energy.contains_key(&id) => Some(d.format("%Y-%m-%d").to_string()),
                    _ => None,
                },
                "total_energy_kwh": round_opt(lifetime.get(&id).copied(), 2),
                "inverter_count": inv_counts.get(&id).copied().unwrap_or(0),
                "status": null,
                "create_date": p.create_date,
                "synced_at": isoformat_utc(p.synced_at),
            })
        })
        .collect())
}

/// Python `growatt_overview.list_plants_summary_shared`: the full list narrowed to `plant_ids`
/// (None = all). Python shares one computation between concurrent callers; here each request
/// computes its own (same rows).
pub async fn list_plants_summary_shared(pool: &PgPool, plant_ids: Option<&HashSet<i64>>) -> Result<Vec<Value>> {
    list_plants_summary(pool, plant_ids).await
}

/// Python `growatt_overview.list_inverters`: the plant's inverters by serial; those marked not
/// installed only with `include_not_installed`.
pub async fn list_inverters(pool: &PgPool, plant_id: i64, include_not_installed: bool) -> Result<Vec<Value>> {
    let Ok(pid) = i32::try_from(plant_id) else { return Ok(Vec::new()) };
    let filter = if include_not_installed { "" } else { " AND not_installed_at IS NULL" };
    let invs = sqlx::query_as::<_, Inverter>(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1{filter} ORDER BY device_sn"
    ))
    .bind(pid)
    .fetch_all(pool)
    .await?;
    Ok(invs.iter().map(inverter_out).collect())
}

/// Python `growatt_overview.not_installed_inverters`: the plant's inverters marked not installed,
/// newest mark first.
pub async fn not_installed_inverters(pool: &PgPool, plant_id: i64) -> Result<Vec<Value>> {
    let invs = sqlx::query_as::<_, Inverter>(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NOT NULL \
         ORDER BY not_installed_at DESC, device_sn"
    ))
    .bind(i32::try_from(plant_id).unwrap_or(i32::MIN))
    .fetch_all(pool)
    .await?;
    Ok(invs.iter().map(inverter_out).collect())
}


// --------------------------------------------------------------------------- the plant curve

/// One stored inverter record as the curve reads it: (sn, ts, pac_w, ppv_w, temperature_c, fac_hz,
/// eac_today_kwh), the columns Python selects.
pub type RawRecord = (String, NaiveDateTime, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);

/// The installed inverters' records over [start, end), by serial then time.
async fn raw_records(pool: &PgPool, sns: &[String], start: NaiveDateTime, end: NaiveDateTime) -> Result<Vec<RawRecord>> {
    Ok(sqlx::query_as::<_, RawRecord>(
        "SELECT device_sn, timestamp, pac_w, ppv_w, temperature_c, fac_hz, eac_today_kwh FROM growatt_inverter_readings \
         WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3 ORDER BY device_sn, timestamp",
    )
    .bind(sns)
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?)
}

/// (timestamp, watts) samples of one inverter or string, in time order
type Series = Vec<(NaiveDateTime, Option<f64>)>;

#[derive(Default)]
struct InvSlot {
    pac: Vec<f64>,
    ppv: Vec<f64>,
    temp: Vec<f64>,
    fac: Vec<f64>,
}

#[derive(Default)]
struct PlantSlot {
    pac: Vec<f64>,
    ppv: Vec<f64>,
    temp: Vec<f64>,
    fac: Vec<f64>,
    held: usize,
}

fn mean(v: &[f64]) -> f64 {
    py_mean(v).unwrap_or(0.0)
}

/// Python `growatt_overview._plant_curve`: the plant's 5-minute curve from stored records ordered
/// by inverter then time. Each inverter's samples are averaged within the slot, then summed across
/// inverters; a missing inverter keeps its own last slot value for up to `MAX_GAP_H` (`held`).
pub fn plant_curve(raw: &[RawRecord], cap_kwp: Option<f64>) -> Vec<Row> {
    // per (slot, sn), in first-seen order (Python dict order)
    let mut keys: Vec<(NaiveDateTime, String)> = Vec::new();
    let mut per_inv: HashMap<(NaiveDateTime, String), InvSlot> = HashMap::new();
    for (sn, ts, pac, ppv, temp, fac, _eac) in raw {
        let k = (bucket(*ts), sn.clone());
        let b = per_inv.entry(k.clone()).or_insert_with(|| {
            keys.push(k.clone());
            InvSlot::default()
        });
        b.pac.push(pac.unwrap_or(0.0));
        b.ppv.push(ppv.unwrap_or(0.0));
        if let Some(t) = temp.filter(|t| *t > 0.0) {
            b.temp.push(t);
        }
        if let Some(f) = fac.filter(|f| *f > 40.0) {
            b.fac.push(f);
        }
    }
    let mut buckets: BTreeMap<NaiveDateTime, PlantSlot> = BTreeMap::new();
    let mut by_slot: HashMap<NaiveDateTime, BTreeSet<String>> = HashMap::new();
    for k in &keys {
        let b = &per_inv[k];
        let slot = buckets.entry(k.0).or_default();
        slot.pac.push(mean(&b.pac));
        slot.ppv.push(mean(&b.ppv));
        slot.temp.extend(&b.temp);
        slot.fac.extend(&b.fac);
        by_slot.entry(k.0).or_default().insert(k.1.clone());
    }
    let hold = chrono::Duration::microseconds((MAX_GAP_H * 3600.0 * 1e6).round() as i64);
    // last slot value per inverter, in first-seen order
    let mut last_order: Vec<String> = Vec::new();
    let mut last: HashMap<String, (NaiveDateTime, f64, f64)> = HashMap::new();
    let slots: Vec<NaiveDateTime> = buckets.keys().copied().collect();
    for ts in &slots {
        let present = &by_slot[ts];
        for sn in present {
            let b = &per_inv[&(*ts, sn.clone())];
            if !last.contains_key(sn) {
                last_order.push(sn.clone());
            }
            last.insert(sn.clone(), (*ts, mean(&b.pac), mean(&b.ppv)));
        }
        let slot = buckets.get_mut(ts).expect("slot");
        for sn in &last_order {
            let (t, pac, ppv) = last[sn];
            if !present.contains(sn) && *ts - t <= hold {
                slot.pac.push(pac);
                slot.ppv.push(ppv);
                slot.held += 1;
            }
        }
    }
    buckets
        .iter()
        .map(|(ts, b)| {
            let hr = ts.hour() as f64 + ts.minute() as f64 / 60.0;
            let mut r = Row::new();
            r.insert("timestamp".into(), json!(fmt_ts(Some(*ts))));
            r.insert("pac_kw".into(), json!(py_round(b.pac.iter().sum::<f64>() / 1000.0, 2)));
            r.insert("ppv_kw".into(), json!(py_round(b.ppv.iter().sum::<f64>() / 1000.0, 2)));
            r.insert("expected_kw".into(), json!(expected_kw(cap_kwp, hr)));
            r.insert("temp_c".into(), json!(round_opt(py_mean(&b.temp), 1)));
            r.insert("freq_hz".into(), json!(round_opt(py_mean(&b.fac), 2)));
            r.insert("inverters".into(), json!(b.pac.len()));
            r.insert("held".into(), json!(b.held));
            r
        })
        .collect()
}

// --------------------------------------------------------------------------- small readers

/// Python `float(fleet_settings.get_fleet_module(db).get("temp_coeff_pmax_pct") or
/// growatt_weather.DEFAULT_GAMMA_PCT_PER_K)`
async fn fleet_gamma_pct(pool: &PgPool) -> Result<f64> {
    let m = fleet_settings::get_fleet_module(pool).await?;
    Ok(truthy(&m["temp_coeff_pmax_pct"]).unwrap_or(weather::DEFAULT_GAMMA_PCT_PER_K))
}

/// Python `growatt_overview._day_rate`: THB/kWh of the day's generation, each slot's tariff rate
/// weighted by its AC power (`pac_kw or 0`); with no generation the rate at noon (of `day`, else
/// today).
async fn day_rate(pool: &PgPool, plant_id: i64, day: Option<NaiveDate>, timeseries: &[Row]) -> Result<f64> {
    let pr = tariff::pricer(pool).await?;
    let pts: Vec<(NaiveDateTime, f64)> = timeseries
        .iter()
        .filter_map(|r| {
            let t = NaiveDateTime::parse_from_str(r.get("timestamp")?.as_str()?, "%Y-%m-%d %H:%M:%S").ok()?;
            Some((t, num(r, "pac_kw").unwrap_or(0.0)))
        })
        .collect();
    let rate = match pr.energy_weighted_rate(plant_id, &pts) {
        Some(r) => r,
        None => {
            let d = day.unwrap_or_else(|| chrono::Local::now().date_naive());
            pr.rate_at(plant_id, d.and_hms_opt(12, 0, 0).expect("noon"))
        }
    };
    Ok(py_round(rate, 4))
}

/// Python `growatt_overview._documents`: {kind: {url, title, revision}} of the plant's document
/// links, {} when none.
async fn documents(pool: &PgPool, plant_id: i64) -> Result<Value> {
    let docs = plant_documents::for_plant(pool, plant_id).await?;
    Ok(Value::Object(
        docs.into_iter()
            .map(|(k, d)| (k, json!({"url": d["url"], "title": d["title"], "revision": d["revision"]})))
            .collect(),
    ))
}

/// The curtailment calls of the overview and `/power` (Python `growatt_curtailment.inverters`,
/// `plant_limit_kw`, `calibration`, `annotate`, `per_day`).
mod curtail {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub async fn annotate_plant(
        pool: &PgPool,
        plant_id: i64,
        rows: &mut [Row],
        kwp: Option<f64>,
        rated_w: Option<f64>,
        gamma_pct: f64,
        factor: f64,
        stale: &HashSet<String>,
        tmod_fallback: Option<HashMap<String, Option<f64>>>,
        days: Option<Vec<NaiveDate>>,
    ) -> Result<Value> {
        let invs = curtailment::inverters(pool, plant_id).await?;
        let calibration = match days {
            Some(d) => curtailment::calibration(pool, plant_id, &d).await?,
            None => HashMap::new(),
        };
        let args = curtailment::AnnotateArgs {
            kwp,
            rated_ac_kw: rated_w.filter(|w| *w != 0.0).map(|w| w / 1000.0),
            limit_kw: curtailment::plant_limit_kw(&invs),
            gamma_pct,
            factor,
            inverter_count: invs.len() as i64,
            stale: stale.clone(),
            tmod_fallback: tmod_fallback.unwrap_or_default(),
            calibration,
        };
        Ok(curtailment::annotate(rows, &args))
    }

    pub fn per_day(rows: &[Row]) -> HashMap<String, Value> {
        curtailment::per_day(rows).into_iter().map(|(k, v)| (k, json!(v))).collect()
    }
}

/// Python `epi_fit.DEFAULT_SYSTEM_FACTOR`
pub const DEFAULT_SYSTEM_FACTOR: f64 = 0.985;

/// Python `epi_fit.factor_info`: the EPI system factor in use for a plant and how it came about.
pub async fn epi_factor_info(pool: &PgPool, plant_id: i64) -> Result<Value> {
    type FitRow = (String, Option<f64>, Option<f64>, i32, i32, Option<NaiveDate>, Option<NaiveDate>, Option<String>, Option<DateTime<Utc>>);
    let row: Option<FitRow> = sqlx::query_as(
        "SELECT status, factor, spread_pct, days_used, candidate_days, start_day, end_day, reason, fitted_at \
         FROM growatt_plant_epi_fit WHERE plant_id = $1",
    )
    .bind(plant_id)
    .fetch_optional(pool)
    .await?;
    let iso_d = |d: Option<NaiveDate>| d.map(|d| d.format("%Y-%m-%d").to_string());
    Ok(match row {
        None => json!({
            "factor": DEFAULT_SYSTEM_FACTOR, "basis": "default", "status": null, "fit_factor": null,
            "days_used": 0, "candidate_days": 0, "start_day": null, "end_day": null, "spread_pct": null,
            "reason": null, "fitted_at": null, "modelled": true,
        }),
        Some((status, factor, spread, used, cand, start, end, reason, fitted_at)) => {
            let fitted = status == "fitted" && factor.is_some();
            json!({
                "factor": if fitted { factor.unwrap_or(DEFAULT_SYSTEM_FACTOR) } else { DEFAULT_SYSTEM_FACTOR },
                "basis": if fitted { "fitted" } else { "default" },
                "status": status,
                "fit_factor": factor,
                "days_used": used,
                "candidate_days": cand,
                "start_day": iso_d(start),
                "end_day": iso_d(end),
                "spread_pct": spread,
                "reason": reason,
                "fitted_at": fitted_at.map(isoformat_utc),
                "modelled": true,
            })
        }
    })
}

/// Python `growatt_rules.DEFAULT_RULES` r16_* thresholds, overridden by `app_settings`
/// `decision_rules` (Python `rule_settings`; only the keys the R16 verdict reads).
pub async fn r16_settings(pool: &PgPool) -> Result<(f64, f64, f64, f64)> {
    let row: Option<Value> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'decision_rules'").fetch_optional(pool).await?;
    let get = |k: &str, d: f64| match &row {
        Some(Value::Object(m)) => m.get(k).and_then(Value::as_f64).unwrap_or(d),
        _ => d,
    };
    Ok((get("r16_stale_slots", 12.0), get("r16_high_slots", 6.0), get("r16_neighbour_ratio", 0.7), get("r16_clear_cloud_pct", 20.0)))
}

/// Python `growatt_overview._sensor_health` (+ `growatt_rules.sensor_verdict`): the R16 verdict on
/// the day's stored sensor evidence, `{ok, flags, reasons}`; None without a day or evidence.
async fn sensor_health(pool: &PgPool, plant_id: i64, day: Option<NaiveDate>) -> Result<Value> {
    let Some(day) = day else { return Ok(Value::Null) };
    type Evidence = (Option<i32>, Option<i32>, Option<f64>, Option<f64>);
    let row: Option<Evidence> = sqlx::query_as(
        "SELECT sensor_stale_slots, sensor_high_slots, sensor_neighbour_ratio, cloud_midday_pct \
         FROM growatt_plant_daily WHERE plant_id = $1 AND day = $2",
    )
    .bind(plant_id)
    .bind(day)
    .fetch_optional(pool)
    .await?;
    let Some((Some(stale), high, ratio, cloud)) = row else { return Ok(Value::Null) };
    let (c_stale, c_high, c_ratio, c_cloud) = r16_settings(pool).await?;
    let mut flags: Vec<(&str, &str)> = Vec::new();
    if f64::from(stale) >= c_stale.trunc() {
        flags.push(("stale", "irradiance frozen at one value"));
    }
    if high.is_some_and(|h| f64::from(h) >= c_high.trunc()) {
        flags.push(("above_clear_sky", "irradiance above the clear-sky value"));
    }
    let judged = ratio.is_some() && cloud.is_some_and(|c| c <= c_cloud);
    if judged && ratio.unwrap_or(0.0) < c_ratio {
        flags.push(("below_neighbours", "irradiance far below nearby plants' sensors on a clear day"));
    }
    Ok(json!({
        "ok": flags.is_empty(),
        "flags": flags.iter().map(|f| f.0).collect::<Vec<_>>(),
        "reasons": flags.iter().map(|f| f.1).collect::<Vec<_>>(),
    }))
}

/// Python `growatt_overview._sunrise`: plant-local sunrise of `day` (NOAA, from the plant's
/// coordinates), else 06:00.
fn sunrise(plant: &Plant, day: NaiveDate) -> NaiveDateTime {
    if let (Some(lat), Some(lon)) = (plant.latitude, plant.longitude) {
        if let Some((rise, _)) = tcroof_solar_core::sun::sun_times(day, lat, lon, 7.0) {
            return rise;
        }
    }
    day.and_hms_opt(6, 0, 0).expect("06:00")
}

/// Python truthiness of a JSON number (`x or y`): null and 0 are false.
fn truthy(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| *x != 0.0)
}

fn num(r: &Row, k: &str) -> Option<f64> {
    r.get(k).and_then(Value::as_f64)
}

/// Python `CompactMppt.process_result_value`: `[[n, v, i, p], …]` read back as
/// `[{"mppt", "v", "i", "p"}, …]` (rows in the old dict form unchanged); empty → `[]`.
fn mppt_dicts(v: Option<Value>) -> Value {
    match v {
        Some(Value::Array(items)) if !items.is_empty() => Value::Array(
            items
                .into_iter()
                .map(|m| match m {
                    Value::Array(xs) => Value::Object(
                        ["mppt", "v", "i", "p"].iter().zip(xs).map(|(k, x)| ((*k).to_owned(), x)).collect(),
                    ),
                    other => other,
                })
                .collect(),
        ),
        _ => json!([]),
    }
}

/// `{"<day>": weighted module temperature or the daylight mean}` (Python `wk.get(a) or wk.get(b)`).
fn tmod_of(wk: &Value) -> Option<f64> {
    truthy(&wk["irradiance_weighted_module_temp_c"]).or_else(|| wk["avg_module_temp_daylight_c"].as_f64())
}

fn weather_err(e: weather::WeatherError) -> ServiceError {
    match e {
        weather::WeatherError::Service(s) => s,
        other => ServiceError::NotFound(other.to_string()),
    }
}

// --------------------------------------------------------------------------- overview

/// Python `growatt_overview.build_plant_overview`: single-plant overview for one day (default: the
/// latest day with data, or the day before when that day holds only records before sunrise), from
/// persisted max_data history. Values that cannot be computed from stored data are null.
pub async fn build_plant_overview(pool: &PgPool, plant_id: i64, day: Option<NaiveDate>) -> Result<Value> {
    let plant = get_plant(pool, plant_id).await?;
    let inverters: Vec<Inverter> = sqlx::query_as::<_, Inverter>(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL ORDER BY device_sn"
    ))
    .bind(plant.plant_id)
    .fetch_all(pool)
    .await?;
    let sns: Vec<String> = inverters.iter().map(|i| i.device_sn.clone()).collect();
    let (cap_kwp, rejected_kwp) = capacity_check(pool, &plant).await?;
    let inv_cap_kwp = match cap_kwp {
        Some(c) if c != 0.0 && !sns.is_empty() => Some(c / sns.len() as f64),
        _ => None,
    };

    let mut day = day;
    let mut data_until = newest_inverter_ts(pool, &sns, None).await?;
    if day.is_none() {
        if let Some(until) = data_until {
            let mut d = until.date();
            // only night records on the newest day: open the last day with records before it
            if until < sunrise(&plant, d) {
                if let Some(prev) = newest_inverter_ts(pool, &sns, Some(day_bounds(d).0)).await? {
                    d = prev.date();
                    data_until = Some(prev);
                }
            }
            day = Some(d);
        }
    }

    struct Metrics {
        peak_ac_kw: Option<f64>,
        peak_dc_kw: Option<f64>,
        period_energy_kwh: f64,
        dc_energy_kwh: f64,
        yield_today_kwh: Option<f64>,
        total_yield_kwh: Option<f64>,
        avg_temp_c: Option<f64>,
        max_temp_c: Option<f64>,
        avg_freq_hz: Option<f64>,
        efficiency_pct: Option<f64>,
    }
    let mut inv_metrics: HashMap<String, Metrics> = HashMap::new();
    let mut latest_mppt: HashMap<String, (Option<f64>, Value)> = HashMap::new();
    let mut timeseries: Vec<Row> = Vec::new();
    let mut string_aggs: Vec<StringAgg> = Vec::new();
    let mut inactive_strings: Vec<Value> = Vec::new();

    if let (false, Some(d)) = (sns.is_empty(), day) {
        let (start, end) = day_bounds(d);
        let raw = raw_records(pool, &sns, start, end).await?;
        let mut by_sn: HashMap<&str, Vec<&RawRecord>> = HashMap::new();
        for r in &raw {
            by_sn.entry(r.0.as_str()).or_default().push(r);
        }

        // 1. per-inverter aggregates
        type Agg = (String, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);
        let agg: Vec<Agg> = sqlx::query_as(
            "SELECT device_sn, max(pac_w), max(ppv_w), max(eac_total_kwh), \
             avg(CASE WHEN pac_w > 0 THEN temperature_c ELSE NULL END), max(temperature_c), \
             avg(CASE WHEN fac_hz > 40 THEN fac_hz ELSE NULL END) \
             FROM growatt_inverter_readings WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3 GROUP BY device_sn",
        )
        .bind(&sns)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        for (sn, pac_max, ppv_max, eac_total, t_avg, t_max, f_avg) in agg {
            let rows_sn: &[&RawRecord] = by_sn.get(sn.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            // eac_today from the day's last record (the counter carries yesterday's total after midnight)
            let eac_today = rows_sn.iter().rev().find_map(|r| r.6);
            let ac_kwh = integrate_kwh(&rows_sn.iter().map(|r| (r.1, r.2)).collect::<Vec<_>>());
            let dc_kwh = integrate_kwh(&rows_sn.iter().map(|r| (r.1, r.3)).collect::<Vec<_>>());
            inv_metrics.insert(
                sn,
                Metrics {
                    peak_ac_kw: pac_max.map(|w| py_round(w / 1000.0, 2)),
                    peak_dc_kw: ppv_max.map(|w| py_round(w / 1000.0, 2)),
                    period_energy_kwh: py_round(ac_kwh, 2),
                    dc_energy_kwh: py_round(dc_kwh, 2),
                    yield_today_kwh: Some(py_round(eac_today.unwrap_or(ac_kwh), 2)),
                    total_yield_kwh: round_opt(eac_total, 2),
                    avg_temp_c: round_opt(t_avg, 1),
                    max_temp_c: round_opt(t_max, 1),
                    avg_freq_hz: round_opt(f_avg, 2),
                    efficiency_pct: if dc_kwh > 0.0 { Some(py_round(ac_kwh / dc_kwh * 100.0, 2)) } else { None },
                },
            );
        }

        // latest producing record per inverter (MPPT snapshot)
        let latest: Vec<(String, Option<f64>, Option<Value>)> = sqlx::query_as(
            "SELECT r.device_sn, r.pac_w, r.mppt_json FROM growatt_inverter_readings r JOIN \
             (SELECT device_sn, max(timestamp) AS ts FROM growatt_inverter_readings \
              WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3 AND pac_w > 0 GROUP BY device_sn) l \
             ON r.device_sn = l.device_sn AND r.timestamp = l.ts",
        )
        .bind(&sns)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        for (sn, pac, mppt) in latest {
            latest_mppt.insert(sn, (Some(py_round(pac.unwrap_or(0.0) / 1000.0, 2)), mppt_dicts(mppt)));
        }

        timeseries = plant_curve(&raw, cap_kwp);

        // 2. per-string aggregates
        let mut mppt_max: BTreeMap<String, i32> = BTreeMap::new();
        let mut idle: HashMap<(String, i32), f64> = HashMap::new();
        let mut str_series: HashMap<(String, i32), Series> = HashMap::new();
        let pts: Vec<(String, i32, NaiveDateTime, Option<f64>)> = sqlx::query_as(
            "SELECT device_sn, string_no, timestamp, voltage_v * current_a FROM growatt_string_readings \
             WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3 ORDER BY device_sn, string_no, timestamp",
        )
        .bind(&sns)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        for (sn, sno, ts, p) in pts {
            str_series.entry((sn, sno)).or_default().push((ts, p));
        }
        type SAgg = (String, i32, i32, i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);
        let saggs: Vec<SAgg> = sqlx::query_as(
            "SELECT device_sn, string_no, mppt_no, count(*), avg(voltage_v), max(voltage_v), avg(current_a), max(current_a), \
             max(voltage_v * current_a) FROM growatt_string_readings \
             WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3 \
             GROUP BY device_sn, string_no, mppt_no ORDER BY device_sn, string_no",
        )
        .bind(&sns)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
        for (sn, sno, mppt_no, n, v_avg, v_max, i_avg, i_max, p_max) in saggs {
            let m = mppt_max.entry(sn.clone()).or_insert(0);
            *m = (*m).max(mppt_no);
            if i_max.unwrap_or(0.0) <= INACTIVE_MAX_A {
                idle.insert((sn, sno), py_round(v_max.unwrap_or(0.0), 1));
                continue;
            }
            let energy = integrate_kwh(str_series.get(&(sn.clone(), sno)).map(Vec::as_slice).unwrap_or(&[]));
            string_aggs.push(StringAgg {
                device_sn: sn,
                string_no: sno,
                mppt_no,
                samples: n,
                v_avg: py_round(v_avg.unwrap_or(0.0), 1),
                v_max: py_round(v_max.unwrap_or(0.0), 1),
                i_avg: py_round(i_avg.unwrap_or(0.0), 2),
                i_max: py_round(i_max.unwrap_or(0.0), 2),
                p_max_w: py_round(p_max.unwrap_or(0.0), 1),
                energy_kwh: py_round(energy, 2),
            });
        }
        let (dead, inactive) = strings::split_inactive(pool, &string_aggs, &idle, &mppt_max, start).await?;
        inactive_strings = inactive;
        string_aggs.extend(dead);
        string_aggs.sort_by(|a, b| (a.device_sn.as_str(), a.string_no).cmp(&(b.device_sn.as_str(), b.string_no)));
    }

    let layout = strings::load_layout(pool, &sns).await?;
    let classified = strings::classify_strings(&string_aggs, inv_cap_kwp, &layout);
    let strings_summary = &classified.summary;
    let string_counts: HashMap<&str, usize> = classified.inv_string_counts.iter().map(|(s, n)| (s.as_str(), *n)).collect();
    let pr_lists: HashMap<&str, &Vec<f64>> = classified.inv_pr_list.iter().map(|(s, v)| (s.as_str(), v)).collect();

    // 3. inverter list
    let mut inverters_out: Vec<Value> = Vec::new();
    for inv in &inverters {
        let sn = inv.device_sn.as_str();
        let m = inv_metrics.get(sn);
        let (latest_pac, mppt) = latest_mppt.get(sn).cloned().unwrap_or((None, json!([])));
        let yield_kwh = m.and_then(|m| m.yield_today_kwh);
        let dc_kwh = m.map(|m| m.dc_energy_kwh);
        let cap = inv_cap_kwp.filter(|c| *c != 0.0);
        let yf = match (yield_kwh, cap) {
            (Some(y), Some(c)) => Some(py_round(y / c, 2)),
            _ => None,
        };
        let ya = match (dc_kwh, cap) {
            (Some(d), Some(c)) => Some(py_round(d / c, 2)),
            _ => None,
        };
        let ya_minus_yf = match (dc_kwh, yield_kwh, cap) {
            (Some(d), Some(y), Some(c)) if d >= y => Some(py_round((d - y) / c, 3)),
            _ => None,
        };
        let mut o = inverter_out(inv);
        let obj = o.as_object_mut().expect("object");
        let extra = json!({
            "model": inv.model.clone().unwrap_or_default(),
            "capacity_kwp": round_opt(inv_cap_kwp, 2),
            "current_ac_kw": latest_pac,
            "peak_ac_kw": m.and_then(|m| m.peak_ac_kw),
            "peak_dc_kw": m.and_then(|m| m.peak_dc_kw),
            "yield_today_kwh": yield_kwh,
            "period_energy_kwh": m.map(|m| m.period_energy_kwh),
            "dc_energy_kwh": dc_kwh,
            "total_yield_kwh": m.and_then(|m| m.total_yield_kwh),
            "specific_yield": yf,
            "ya_kwh_kwp": ya,
            "ya_minus_yf": ya_minus_yf,
            "efficiency_pct": m.and_then(|m| m.efficiency_pct),
            "pr_pct": round_opt(pr_lists.get(sn).and_then(|v| py_mean(v)), 1),
            "avg_temp_c": m.and_then(|m| m.avg_temp_c),
            "max_temp_c": m.and_then(|m| m.max_temp_c),
            "avg_freq_hz": m.and_then(|m| m.avg_freq_hz),
            "string_count": string_counts.get(sn).copied().unwrap_or(0),
            "mppt_latest": mppt,
        });
        for (k, v) in extra.as_object().expect("object") {
            obj.insert(k.clone(), v.clone());
        }
        inverters_out.push(o);
    }

    // 4. plant KPIs
    let count_status = |st: &str| strings_summary.iter().filter(|s| s["status"] == st).count();
    let (healthy_cnt, warning_cnt, critical_cnt) = (count_status("Healthy"), count_status("Warning"), count_status("Critical"));
    let plant_pr_pct = round_opt(mean_opt(strings_summary.iter().map(|s| s["pr_pct"].as_f64())), 1);
    let avg_health = round_opt(mean_opt(strings_summary.iter().map(|s| s["health_score"].as_f64())), 1);
    let inv_f = |k: &str| inverters_out.iter().map(move |i| i[k].as_f64()).collect::<Vec<_>>();
    let sum_some = |v: Vec<Option<f64>>| {
        let xs: Vec<f64> = v.into_iter().flatten().collect();
        if xs.is_empty() { None } else { Some(xs.iter().sum::<f64>()) }
    };
    let yield_today_kwh = sum_some(inv_f("yield_today_kwh")).map(|s| py_round(s, 2));
    let dc_yield_today_kwh = sum_some(inv_f("dc_energy_kwh")).map(|s| py_round(s, 2));
    let cap = cap_kwp.filter(|c| *c != 0.0);
    let yf_kwh_kwp = yield_today_kwh.zip(cap).map(|(y, c)| py_round(y / c, 2));
    let ya_kwh_kwp = dc_yield_today_kwh.zip(cap).map(|(d, c)| py_round(d / c, 2));
    let ya_minus_yf = match (dc_yield_today_kwh, yield_today_kwh, cap) {
        (Some(d), Some(y), Some(c)) if d >= y => Some(py_round((d - y) / c, 3)),
        _ => None,
    };
    let total_yield_kwh = round_opt(sum_some(inv_f("total_yield_kwh")), 2);
    let peak_power_kw = round_opt(max_opt(timeseries.iter().map(|r| num(r, "pac_kw"))), 2);
    let avg_temp_c = round_opt(mean_opt(inv_f("avg_temp_c")), 1);
    let max_temp_c = round_opt(max_opt(inv_f("max_temp_c")), 1);
    let avg_freq_hz = round_opt(mean_opt(inv_f("avg_freq_hz")), 2);
    let avg_eff_pct = round_opt(mean_opt(inv_f("efficiency_pct")), 2);

    let gamma_pct = fleet_gamma_pct(pool).await?;

    // energy meter at the grid connection point: import / export measured, load derived
    let mut grid_energy = json!({"grid_import_kwh": null, "grid_export_kwh": null, "load_kwh": null});
    let has_meter = match day {
        Some(d) => {
            let (m_start, m_end) = day_bounds(d);
            let (has, gslots) = meter::meter_slots(pool, plant_id, m_start, m_end).await?;
            meter::attach_grid(&mut timeseries, &gslots, cap_kwp);
            if !gslots.is_empty() {
                grid_energy = meter::day_energy(pool, plant_id, m_start, m_end, &timeseries, true).await?;
            }
            has
        }
        None => !meter::plant_meters(pool, plant_id).await?.is_empty(),
    };
    // weather sensor (measured irradiance / temperatures) merged onto the curve
    let weather = weather::build_weather_day(pool, plant_id, day, false, None, None, None).await.map_err(weather_err)?;
    let series: Vec<Value> = weather["series"].as_array().cloned().unwrap_or_default();
    let wx_by_ts: HashMap<&str, &Value> = series.iter().filter_map(|p| Some((p["timestamp"].as_str()?, p))).collect();
    for r in timeseries.iter_mut() {
        let wx = r.get("timestamp").and_then(Value::as_str).and_then(|t| wx_by_ts.get(t).copied());
        let pick = |k: &str| wx.and_then(|w| w.get(k)).cloned().unwrap_or(Value::Null);
        let (g, tm, ta) = (pick("irradiance_wm2"), pick("module_temp_c"), pick("ambient_temp_c"));
        r.insert("irradiance_wm2".into(), g);
        r.insert("module_temp_c".into(), tm);
        r.insert("ambient_temp_c".into(), ta);
    }
    let producing: Vec<String> = timeseries
        .iter()
        .filter(|r| num(r, "pac_kw").unwrap_or(0.0) > 0.0)
        .filter_map(|r| r.get("timestamp").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let mut pr = weather::iec_pr(yield_today_kwh, cap_kwp, &weather, &producing, gamma_pct);
    let wk = weather["kpis"].clone();

    let epi_factor = epi_factor_info(pool, plant_id).await?;
    let factor = epi_factor["factor"].as_f64().unwrap_or(DEFAULT_SYSTEM_FACTOR);
    let rated_w = plant_rated_ac_w(pool, Some(&[plant_id])).await?.get(&plant_id).copied();
    let stale = weather::stale_timestamps(&series, "irradiance_wm2");
    let curtailment = curtail::annotate_plant(
        pool,
        plant_id,
        &mut timeseries,
        cap_kwp,
        rated_w,
        gamma_pct,
        factor,
        &stale,
        day.map(|d| HashMap::from([(d.format("%Y-%m-%d").to_string(), tmod_of(&wk))])),
        day.map(|d| vec![d]),
    )
    .await?;

    // EPI: measured AC energy / modelled AC energy from POA & T_mod over filtered slots
    let mut epi: Option<f64> = None;
    if let (Some(_), Some(cap)) = (pr["pr_pct"].as_f64(), cap) {
        let rated_ac_kw = rated_w.unwrap_or(0.0) / 1000.0;
        let fallback_tmod = tmod_of(&wk);
        let (mut meas, mut modl, mut n) = (0.0, 0.0, 0usize);
        for r in &timeseries {
            let ts = r.get("timestamp").and_then(Value::as_str).unwrap_or("");
            let (Some(g), Some(pac_kw)) = (num(r, "irradiance_wm2"), num(r, "pac_kw")) else { continue };
            if stale.contains(ts)
                || !(weather::POA_FILTER_MIN_WM2..=weather::POA_FILTER_MAX_WM2).contains(&g)
                || (rated_ac_kw > 0.0 && pac_kw >= 0.98 * rated_ac_kw)
                || r.get("curtailed_by").is_some_and(json_truthy)
            {
                continue;
            }
            let Some(t_mod) = num(r, "module_temp_c").or(fallback_tmod) else { continue };
            let temp_factor = (1.0 + (gamma_pct / 100.0) * (t_mod - 25.0)).max(0.5);
            let p_mod_kw = cap * (g / 1000.0) * temp_factor * factor;
            if p_mod_kw > 0.0 {
                meas += pac_kw;
                modl += p_mod_kw;
                n += 1;
            }
        }
        if n >= 3 && modl > 0.0 {
            epi = Some(py_round(meas / modl, 3));
        }
    }
    if let Some(o) = pr.as_object_mut() {
        o.insert("epi".into(), json!(epi));
    }

    // loss waterfall: a modelled breakdown, only when every input is measured
    let mut loss_waterfall: Vec<Value> = Vec::new();
    let insolation = wk["insolation_kwh_m2"].as_f64();
    let reference_kwh = match (pr["pr_pct"].as_f64(), cap, insolation.filter(|x| *x != 0.0)) {
        (Some(_), Some(c), Some(h)) => Some(py_round(c * h, 1)),
        _ => None,
    };
    let reference_measured = reference_kwh.is_some();
    let module_temp_c = if reference_measured { wk["avg_module_temp_daylight_c"].as_f64() } else { None };
    if let (Some(y), Some(avg_t), Some(eff)) = (yield_today_kwh.filter(|y| *y != 0.0), avg_temp_c, avg_eff_pct) {
        if reference_measured || plant_pr_pct.is_some_and(|p| p != 0.0) {
            let nominal = reference_kwh.unwrap_or_else(|| py_round(y / 0.65f64.max(plant_pr_pct.unwrap_or(0.0) / 100.0), 1));
            let cell = module_temp_c.unwrap_or(avg_t);
            let thermal = py_round(nominal * 0.015f64.max((cell - 25.0) * 0.0034), 1);
            let mismatch = py_round(strings_summary.iter().map(|s| s["energy_loss_kwh"].as_f64().unwrap_or(0.0)).sum::<f64>(), 1);
            let conv = py_round(y * 0.0f64.max(100.0 - eff) / 100.0, 1);
            let optical = py_round(0.0f64.max(nominal - y - thermal - mismatch - conv), 1);
            loss_waterfall = vec![
                json!({"stage": if reference_measured { "POA Insolation × kWp (measured)" } else { "Nominal DC Reference" }, "kwh": nominal, "type": "base"}),
                json!({"stage": "Optical & Soiling Loss", "kwh": -optical, "type": "loss"}),
                json!({"stage": "Thermal Derating Loss", "kwh": -thermal, "type": "loss"}),
                json!({"stage": "String & MPPT Mismatch", "kwh": -mismatch, "type": "loss"}),
                json!({"stage": "Inverter Conversion Loss", "kwh": -conv, "type": "loss"}),
                json!({"stage": "Net AC Grid Export", "kwh": y, "type": "net"}),
            ];
        }
    }

    let tariff_rate = day_rate(pool, plant_id, day, &timeseries).await?;
    let mut kpis = json!({
        "capacity_kwp": cap_kwp,
        "current_power_kw": null,
        "peak_power_kw": peak_power_kw,
        "yield_today_kwh": yield_today_kwh,
        "dc_yield_today_kwh": dc_yield_today_kwh,
        "total_yield_kwh": total_yield_kwh,
        "specific_yield_kwh_per_kwp": yf_kwh_kwp,
        "ya_kwh_kwp": ya_kwh_kwp,
        "ya_minus_yf": ya_minus_yf,
        "plant_pr_pct": plant_pr_pct,
        "iec_pr_pct": pr["pr_pct"],
        "iec_pr_temp_corrected_pct": pr.get("pr_temp_corrected_pct").cloned().unwrap_or(Value::Null),
        "epi": epi,
        "epi_factor": epi_factor,
        "curtailment": curtailment,
        "sensor_health": sensor_health(pool, plant_id, day).await?,
        "insolation_kwh_m2": wk["insolation_kwh_m2"],
        "peak_irradiance_wm2": wk["peak_irradiance_wm2"],
        "avg_module_temp_c": wk["avg_module_temp_daylight_c"],
        "irradiance_weighted_module_temp_c": wk.get("irradiance_weighted_module_temp_c").cloned().unwrap_or(Value::Null),
        "avg_ambient_temp_c": wk["avg_ambient_temp_c"],
        "target_pr_pct": 85.0,
        "conversion_efficiency_pct": avg_eff_pct,
        "avg_temp_c": avg_temp_c,
        "max_temp_c": max_temp_c,
        "avg_freq_hz": avg_freq_hz,
        "inverter_count": inverters_out.len(),
        "online_inverters": null,
        "string_count": strings_summary.len(),
        "healthy_strings": healthy_cnt,
        "warning_strings": warning_cnt,
        "critical_strings": critical_cnt,
        "inactive_strings": inactive_strings.len(),
        "strings_with_module_count": strings_summary.iter().filter(|s| !s["modules"].is_null()).count(),
        "strings_normalized": strings_summary.iter().filter(|s| s["peer_basis"] != "raw").count(),
        "avg_health_score": avg_health,
        "tariff_thb_per_kwh": tariff_rate,
        "has_meter": has_meter,
    });
    if let (Some(k), Some(g)) = (kpis.as_object_mut(), grid_energy.as_object()) {
        for (key, v) in g {
            k.insert(key.clone(), v.clone());
        }
    }

    let anomalies: Vec<Value> = classified.anomalies.iter().take(40).cloned().collect();
    Ok(json!({
        "meta": {
            "source": "db",
            "day": day.map(|d| d.format("%Y-%m-%d").to_string()),
            "data_until": fmt_ts(data_until),
            "synced_at": isoformat_utc(plant.synced_at),
        },
        "plant": {
            "plant_id": plant.plant_id,
            "name": plant.name,
            "city": plant.city,
            "country": plant.country,
            "latitude": plant.latitude,
            "longitude": plant.longitude,
            "peak_power_kwp": cap_kwp,
            "reported_peak_power_kwp": rejected_kwp,
            "current_power_w": null,
            "total_energy_kwh": total_yield_kwh,
            "status": null,
            "create_date": plant.create_date,
            "timezone": plant.timezone,
            "address": plant.address,
            "growatt_inverter_count": plant.growatt_inverter_count,
            "growatt_datalogger_count": plant.growatt_datalogger_count,
            "documents": documents(pool, plant_id).await?,
        },
        "kpis": kpis,
        "inverters": inverters_out,
        "not_installed_inverters": not_installed_inverters(pool, plant_id).await?,
        "timeseries": timeseries,
        "weather": {
            "has_sensor": weather["has_sensor"],
            "sensors": weather["sensors"],
            "data_until": weather["meta"]["data_until"],
            "kpis": wk,
            "iec_pr": pr,
            "check_slots": weather::check_slots(&series, day),
        },
        "loss_waterfall": loss_waterfall,
        "strings": classified.summary,
        "inactive_strings": inactive_strings,
        "anomalies": anomalies,
    }))
}

/// Python truthiness of a JSON value (`if r.get("curtailed_by")`).
fn json_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

// --------------------------------------------------------------------------- power curve

/// Python `growatt_overview.MAX_GROWATT_KWH_PER_KWP_DAY`: above this a Growatt day figure is a glitch
pub const MAX_GROWATT_KWH_PER_KWP_DAY: f64 = 10.0;

/// Python `growatt_overview.build_plant_power`: the plant's stored 5-minute AC / DC curve for
/// `day`..`end_day` (both inclusive, at most `MAX_RANGE_DAYS`), optionally narrowed to a
/// plant-local time-of-day window on every day, with per-day energy, the meter's grid / load
/// figures, POA irradiance, curtailment (estimated) and Growatt's own figures. DB only.
#[allow(clippy::too_many_arguments)]
pub async fn build_plant_power(
    pool: &PgPool,
    plant_id: i64,
    day: NaiveDate,
    end_day: Option<NaiveDate>,
    start_time: Option<NaiveTime>,
    end_time: Option<NaiveTime>,
    include_records: bool,
) -> Result<Value> {
    let plant = get_plant(pool, plant_id).await?;
    let last_day = match end_day {
        Some(e) if e > day => e,
        _ => day,
    };
    if (last_day - day).num_days() + 1 > strings::MAX_RANGE_DAYS {
        return Err(ServiceError::Invalid(format!("A day range covers at most {} days", strings::MAX_RANGE_DAYS)));
    }
    let sns: Vec<String> =
        sqlx::query_scalar("SELECT device_sn FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL")
            .bind(plant.plant_id)
            .fetch_all(pool)
            .await?;
    let (cap_kwp, _) = capacity_check(pool, &plant).await?;
    let rated_w = plant_rated_ac_w(pool, Some(&[plant_id])).await?.get(&plant_id).copied();
    let (g_start, _) = day_bounds(day);
    let (_, g_end) = day_bounds(last_day);
    let raw_all: Vec<RawRecord> =
        if !sns.is_empty() && include_records { raw_records(pool, &sns, g_start, g_end).await? } else { Vec::new() };
    let windowed = start_time.is_some() || end_time.is_some();
    let lo = start_time.unwrap_or(NaiveTime::MIN);
    let hi = end_time.unwrap_or_else(|| NaiveTime::from_hms_micro_opt(23, 59, 59, 999_999).expect("time.max"));
    // inclusive 5-min slots: a record at 10:04 belongs to the 10:00 slot
    let raw: Vec<&RawRecord> =
        raw_all.iter().filter(|r| !windowed || (lo <= bucket(r.1).time() && bucket(r.1).time() <= hi)).collect();
    // day -> (serials in first-seen order, serial -> (ts, pac_w) samples)
    let mut per_day: BTreeMap<NaiveDate, (Vec<String>, HashMap<String, Series>)> = BTreeMap::new();
    for r in &raw {
        let (order, m) = per_day.entry(r.1.date()).or_default();
        if !m.contains_key(&r.0) {
            order.push(r.0.clone());
        }
        m.entry(r.0.clone()).or_default().push((r.1, r.2));
    }
    let g_raw: Vec<(NaiveDateTime, f64)> = sqlx::query_as::<_, (NaiveDateTime, f64)>(
        "SELECT timestamp, power_w FROM growatt_plant_power WHERE plant_id = $1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp",
    )
    .bind(plant.plant_id)
    .bind(g_start)
    .bind(g_end)
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter(|(ts, _)| !windowed || (lo <= ts.time() && ts.time() <= hi))
    .collect();
    let g_energy: HashMap<NaiveDate, Option<f64>> = sqlx::query_as::<_, (NaiveDate, Option<f64>)>(
        "SELECT day, energy_kwh FROM growatt_plant_energy_days WHERE plant_id = $1 AND day >= $2 AND day <= $3",
    )
    .bind(plant.plant_id)
    .bind(day)
    .bind(last_day)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let mut g_inv: HashMap<NaiveDate, (f64, i64)> = HashMap::new();
    for (d, kwh, n) in sqlx::query_as::<_, (NaiveDate, Option<f64>, i64)>(
        "SELECT day, sum(energy_kwh), count(energy_kwh) FROM growatt_inverter_energy_days \
         WHERE plant_id = $1 AND day >= $2 AND day <= $3 GROUP BY day",
    )
    .bind(plant.plant_id)
    .bind(day)
    .bind(last_day)
    .fetch_all(pool)
    .await?
    {
        if let (true, Some(k)) = (n != 0, kwh) {
            g_inv.insert(d, (k, n));
        }
    }
    // Growatt's day figures are shown only when physically possible
    let max_day_kwh = cap_kwp.filter(|c| *c != 0.0).map(|c| c * MAX_GROWATT_KWH_PER_KWP_DAY);
    let plausible = |v: Option<f64>| v.filter(|x| max_day_kwh.is_none_or(|m| *x <= m));

    let mut daily: Vec<Row> = Vec::new();
    let mut d = day;
    while d <= last_day {
        let gi = g_inv.get(&d);
        let g_raw_day = g_energy.get(&d).copied().flatten();
        let gi_raw = gi.map(|g| g.0);
        let energy = per_day.get(&d).map(|(order, m)| py_round(order.iter().map(|sn| integrate_kwh(&m[sn])).sum::<f64>(), 2));
        let mut row = Row::new();
        row.insert("day".into(), json!(d.format("%Y-%m-%d").to_string()));
        row.insert("energy_kwh".into(), json!(energy));
        row.insert("growatt_energy_kwh".into(), json!(round_opt(plausible(g_raw_day), 2)));
        row.insert("growatt_inverters_kwh".into(), json!(round_opt(plausible(gi_raw), 2)));
        row.insert("growatt_inverters_reported".into(), json!(gi.map(|g| g.1).unwrap_or(0)));
        row.insert("growatt_implausible".into(), json!(plausible(g_raw_day) != g_raw_day || plausible(gi_raw) != gi_raw));
        daily.push(row);
        d += chrono::Duration::days(1);
    }

    // built on the whole days and windowed after the meter is attached
    let mut curve = plant_curve(&raw_all, cap_kwp);
    let (has_meter, mut gslots) = meter::meter_slots(pool, plant_id, g_start, g_end).await?;
    if !include_records {
        gslots = HashMap::new();
    }
    meter::attach_grid(&mut curve, &gslots, cap_kwp);
    if windowed {
        let w_lo = lo.format("%H:%M:%S").to_string();
        let w_hi = hi.format("%H:%M:%S").to_string();
        let inside = |ts: &str| {
            let t = ts.get(11..).unwrap_or("");
            w_lo.as_str() <= t && t <= w_hi.as_str()
        };
        curve.retain(|r| inside(r.get("timestamp").and_then(Value::as_str).unwrap_or("")));
        gslots.retain(|k, _| inside(k));
    }
    let mut grid_energy = json!({"grid_import_kwh": null, "grid_export_kwh": null, "load_kwh": null});
    if !gslots.is_empty() {
        grid_energy = meter::day_energy(pool, plant_id, g_start, g_end, &curve, !windowed).await?;
    }
    // weather sensor POA irradiance (measured) per slot, built day by day as the day view does
    let mut irr: HashMap<String, Value> = HashMap::new();
    let mut tmod: HashMap<String, Value> = HashMap::new();
    let mut stale: HashSet<String> = HashSet::new();
    let mut tmod_day: HashMap<String, Option<f64>> = HashMap::new();
    if !weather::plant_sensors(pool, plant_id).await?.is_empty() {
        let mut d = day;
        while d <= last_day {
            let wday = weather::build_weather_day(pool, plant_id, Some(d), false, None, None, None).await.map_err(weather_err)?;
            let series: Vec<Value> = wday["series"].as_array().cloned().unwrap_or_default();
            for p in &series {
                if let Some(ts) = p["timestamp"].as_str() {
                    irr.insert(ts.to_owned(), p.get("irradiance_wm2").cloned().unwrap_or(Value::Null));
                    tmod.insert(ts.to_owned(), p.get("module_temp_c").cloned().unwrap_or(Value::Null));
                }
            }
            stale.extend(weather::stale_timestamps(&series, "irradiance_wm2"));
            tmod_day.insert(d.format("%Y-%m-%d").to_string(), tmod_of(&wday["kpis"]));
            d += chrono::Duration::days(1);
        }
    }
    for r in curve.iter_mut() {
        let ts = r.get("timestamp").and_then(Value::as_str).unwrap_or("").to_owned();
        r.insert("irradiance_wm2".into(), irr.get(&ts).cloned().unwrap_or(Value::Null));
        r.insert("module_temp_c".into(), tmod.get(&ts).cloned().unwrap_or(Value::Null));
    }
    // curtailment per slot and day (estimated)
    let gamma_pct = fleet_gamma_pct(pool).await?;
    let factor = epi_factor_info(pool, plant_id).await?["factor"].as_f64().unwrap_or(DEFAULT_SYSTEM_FACTOR);
    let days: Vec<NaiveDate> = (0..=(last_day - day).num_days()).map(|i| day + chrono::Duration::days(i)).collect();
    let curtailment =
        curtail::annotate_plant(pool, plant_id, &mut curve, cap_kwp, rated_w, gamma_pct, factor, &stale, Some(tmod_day), Some(days))
            .await?;
    let c_days = curtail::per_day(&curve);
    for row in daily.iter_mut() {
        let k = row["day"].as_str().unwrap_or("").to_owned();
        row.insert("curtailed_kwh".into(), c_days.get(&k).cloned().unwrap_or(Value::Null));
    }
    let mut out = json!({
        "meta": {
            "source": "db",
            "day": day.format("%Y-%m-%d").to_string(),
            "end_day": last_day.format("%Y-%m-%d").to_string(),
            "window": [start_time.map(|t| t.format("%H:%M").to_string()), end_time.map(|t| t.format("%H:%M").to_string())],
        },
        "plant_id": plant_id,
        "inverter_count": sns.len(),
        "rated_ac_kw": rated_w.filter(|w| *w != 0.0).map(|w| py_round(w / 1000.0, 1)),
        "timeseries": curve,
        "has_meter": has_meter,
        "curtailment": curtailment,
        "growatt_timeseries": g_raw.iter().map(|(ts, w)| json!({"timestamp": fmt_ts(Some(*ts)), "pac_kw": py_round(w / 1000.0, 2)})).collect::<Vec<_>>(),
        "daily": daily,
    });
    if let (Some(o), Some(g)) = (out.as_object_mut(), grid_energy.as_object()) {
        for (k, v) in g {
            o.insert(k.clone(), v.clone());
        }
    }
    Ok(out)
}
