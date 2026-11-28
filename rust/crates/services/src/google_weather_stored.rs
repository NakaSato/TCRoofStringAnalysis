//! Stored Google Maps Weather hours (DB only), ported from the "stored day" and "grid cells" parts
//! of backend/app/services/google_weather.py. Google's values are **modelled** for the plant's
//! coordinates, never measured: every answer says `modelled: true`. Only daytime hours
//! (`GOOGLE_WEATHER_DAY_START_H`–`_END_H`) are read. `google_weather_hourly.hour` is naive
//! plant-local time.
//!
//! The live current conditions, the call budget, the history job and the PWA check slots of the
//! Python module are a later wave (they call Google); nothing here calls Google.

use std::collections::BTreeMap;

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::{py_round, py_sum, Plant, Result};

/// Python `SOURCE`
pub const SOURCE: &str = "Google Maps Platform Weather API";
/// Python `STORED`: the hourly fields kept, in column order
pub const STORED: [&str; 16] = [
    "condition",
    "is_daytime",
    "temp_c",
    "feels_like_c",
    "dew_point_c",
    "humidity_pct",
    "cloud_cover_pct",
    "uv_index",
    "precip_mm",
    "precip_prob_pct",
    "thunder_prob_pct",
    "wind_speed_ms",
    "wind_gust_ms",
    "wind_dir_deg",
    "pressure_hpa",
    "visibility_km",
];
/// Python `RAIN_DAY_MM`: a day with at least this much rain counts as a rain day
pub const RAIN_DAY_MM: f64 = 1.0;
/// Python `RAIN_HOUR_MM`
pub const RAIN_HOUR_MM: f64 = 0.1;
/// Python `RAIN_LOOKBACK_DAYS`
pub const RAIN_LOOKBACK_DAYS: i64 = 60;
/// Python `SLOT_HOURS` (= growatt_weather.CHECK_HOURS)
pub const SLOT_HOURS: [u32; 3] = crate::weather::CHECK_HOURS;
/// Python `RAIN_WORDS`
pub const RAIN_WORDS: [&str; 4] = ["RAIN", "SHOWER", "THUNDER", "DRIZZLE"];

/// The settings this module reads (Python `settings.google_weather_*`).
#[derive(Debug, Clone)]
pub struct GoogleWeatherConfig {
    /// `GOOGLE_WEATHER_API_KEY` set (only whether, never the key)
    pub configured: bool,
    /// `GOOGLE_WEATHER_CELL_DEG` (0.01)
    pub cell_deg: f64,
    /// `GOOGLE_WEATHER_DAY_START_H` (6)
    pub day_start_h: i64,
    /// `GOOGLE_WEATHER_DAY_END_H` (18, exclusive)
    pub day_end_h: i64,
}

impl Default for GoogleWeatherConfig {
    fn default() -> Self {
        GoogleWeatherConfig { configured: false, cell_deg: 0.01, day_start_h: 6, day_end_h: 18 }
    }
}

impl GoogleWeatherConfig {
    /// Python `in_window`
    pub fn in_window(&self, hour: u32) -> bool {
        self.day_start_h <= i64::from(hour) && i64::from(hour) < self.day_end_h
    }

    /// Python `min_day_hours`: a stored day with fewer daytime hours is incomplete.
    pub fn min_day_hours(&self) -> usize {
        (self.day_end_h - self.day_start_h - 2).max(1) as usize
    }
}

/// Python `cell_of`: (key, lat, lon) of the grid point a plant's coordinates round to.
pub fn cell_of(lat: f64, lon: f64, deg: f64) -> (String, f64, f64) {
    let step = deg;
    let txt = format!("{step:.6}");
    let trimmed = txt.trim_end_matches('0');
    let digits = trimmed.split_once('.').map_or(0, |(_, f)| f.len());
    let clat = py_round((lat / step).round_ties_even() * step, digits);
    let clon = py_round((lon / step).round_ties_even() * step, digits);
    (format!("{clat:.digits$},{clon:.digits$}"), clat, clon)
}

/// Python `plant_cell`
pub fn plant_cell(plant: &Plant, cfg: &GoogleWeatherConfig) -> Option<(String, f64, f64)> {
    Some(cell_of(plant.latitude?, plant.longitude?, cfg.cell_deg))
}

/// A row of `google_weather_hourly` (Python `GoogleWeatherHourly`, the columns read here).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Hour {
    pub hour: NaiveDateTime,
    pub condition: Option<String>,
    pub is_daytime: Option<bool>,
    pub temp_c: Option<f64>,
    pub feels_like_c: Option<f64>,
    pub dew_point_c: Option<f64>,
    pub humidity_pct: Option<f64>,
    pub cloud_cover_pct: Option<f64>,
    pub uv_index: Option<f64>,
    pub precip_mm: Option<f64>,
    pub precip_prob_pct: Option<f64>,
    pub thunder_prob_pct: Option<f64>,
    pub wind_speed_ms: Option<f64>,
    pub wind_gust_ms: Option<f64>,
    pub wind_dir_deg: Option<f64>,
    pub pressure_hpa: Option<f64>,
    pub visibility_km: Option<f64>,
}

/// Python `_row_out`
fn row_out(r: &Hour) -> Value {
    json!({
        "hour": r.hour.format("%Y-%m-%d %H:%M:%S").to_string(),
        "condition": r.condition,
        "is_daytime": r.is_daytime,
        "temp_c": r.temp_c,
        "feels_like_c": r.feels_like_c,
        "dew_point_c": r.dew_point_c,
        "humidity_pct": r.humidity_pct,
        "cloud_cover_pct": r.cloud_cover_pct,
        "uv_index": r.uv_index,
        "precip_mm": r.precip_mm,
        "precip_prob_pct": r.precip_prob_pct,
        "thunder_prob_pct": r.thunder_prob_pct,
        "wind_speed_ms": r.wind_speed_ms,
        "wind_gust_ms": r.wind_gust_ms,
        "wind_dir_deg": r.wind_dir_deg,
        "pressure_hpa": r.pressure_hpa,
        "visibility_km": r.visibility_km,
    })
}

fn vals(rows: &[&Value], key: &str) -> Vec<f64> {
    rows.iter().filter_map(|r| r[key].as_f64()).collect()
}

/// Python `sum(v)` of floats
fn sum(v: &[f64]) -> f64 {
    py_sum(v.iter().copied())
}

/// Python `_mean`
fn mean(v: &[f64], digits: usize) -> Option<f64> {
    (!v.is_empty()).then(|| py_round(sum(v) / v.len() as f64, digits))
}

/// Python `_max`
fn max(v: &[f64], digits: usize) -> Option<f64> {
    v.iter().copied().reduce(|a, b| if b > a { b } else { a }).map(|m| py_round(m, digits))
}

/// Python `_min`
fn min(v: &[f64], digits: usize) -> Option<f64> {
    v.iter().copied().reduce(|a, b| if b < a { b } else { a }).map(|m| py_round(m, digits))
}

/// Python `_rain`
fn rain(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| py_round(sum(v), 1))
}

/// Python `is_raining`: ≥ RAIN_HOUR_MM of rain, or a rain / shower / thunder condition (not a mere
/// "chance of"). None when Google gave neither.
pub fn is_raining(precip_mm: Option<f64>, condition: Option<&str>) -> Option<bool> {
    let cond = condition.unwrap_or("");
    if precip_mm.is_none() && cond.is_empty() {
        return None;
    }
    if precip_mm.unwrap_or(0.0) >= RAIN_HOUR_MM {
        return Some(true);
    }
    let c = cond.to_uppercase();
    Some(RAIN_WORDS.iter().any(|w| c.contains(w)) && !c.starts_with("CHANCE_OF"))
}

fn hour_of(r: &Value) -> u32 {
    r["hour"].as_str().and_then(|h| h.get(11..13)).and_then(|h| h.parse().ok()).unwrap_or(0)
}

/// Python `slots`: weather at SLOT_HOURS ("09", "13", "17"); null for an hour not stored (yet).
pub fn slots(rows: &[Value]) -> Map<String, Value> {
    let mut by_hour: BTreeMap<u32, &Value> = BTreeMap::new();
    for r in rows {
        by_hour.insert(hour_of(r), r);
    }
    let mut out = Map::new();
    for h in SLOT_HOURS {
        let v = match by_hour.get(&h) {
            None => Value::Null,
            Some(r) => {
                let raining = is_raining(r["precip_mm"].as_f64(), r["condition"].as_str());
                json!({
                    "raining": raining,
                    "status_th": raining.map(|x| if x { "ฝนตก" } else { "ไม่มีฝน" }),
                    "condition": r["condition"],
                    "precip_mm": r["precip_mm"],
                    "precip_prob_pct": r["precip_prob_pct"],
                    "cloud_cover_pct": r["cloud_cover_pct"],
                    "temp_c": r["temp_c"],
                })
            }
        };
        out.insert(format!("{h:02}"), v);
    }
    out
}

/// Python `day_kpis`
pub fn day_kpis(rows: &[Value], cfg: &GoogleWeatherConfig) -> Value {
    let all: Vec<&Value> = rows.iter().collect();
    let mut daytime: Vec<&Value> = rows.iter().filter(|r| r["is_daytime"].as_bool().unwrap_or(false)).collect();
    if daytime.is_empty() {
        daytime = rows.iter().filter(|r| (6..18).contains(&hour_of(r))).collect();
    }
    // Counter.most_common(1): the most frequent, the first seen on a tie
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for r in &daytime {
        if let Some(c) = r["condition"].as_str().filter(|c| !c.is_empty()) {
            match counts.iter_mut().find(|(k, _)| *k == c) {
                Some(e) => e.1 += 1,
                None => counts.push((c, 1)),
            }
        }
    }
    let condition = counts.iter().fold(None::<(&str, usize)>, |best, &(k, n)| match best {
        Some((_, bn)) if bn >= n => best,
        _ => Some((k, n)),
    });
    let precip: Vec<f64> = rows.iter().map(|r| r["precip_mm"].as_f64().unwrap_or(0.0)).collect();
    json!({
        "hours": rows.len(),
        "complete": rows.len() >= cfg.min_day_hours(),
        "rain_mm": rain(&vals(&all, "precip_mm")),
        "rain_hours": if rows.is_empty() { None } else { Some(precip.iter().filter(|p| **p >= RAIN_HOUR_MM).count()) },
        "temp_max_c": max(&vals(&all, "temp_c"), 1),
        "temp_min_c": min(&vals(&all, "temp_c"), 1),
        "cloud_cover_daytime_pct": mean(&vals(&daytime, "cloud_cover_pct"), 0),
        "uv_max": max(&vals(&all, "uv_index"), 0),
        "humidity_avg_pct": mean(&vals(&all, "humidity_pct"), 0),
        "wind_gust_max_ms": max(&vals(&all, "wind_gust_ms"), 1),
        "thunder_prob_max_pct": max(&vals(&all, "thunder_prob_pct"), 0),
        "condition": condition.map(|(k, _)| k),
        "rained": if rows.is_empty() {
            None
        } else {
            Some(rows.iter().any(|r| is_raining(r["precip_mm"].as_f64(), r["condition"].as_str()) == Some(true)) || sum(&precip) >= RAIN_HOUR_MM)
        },
    })
}

/// Python `_day_hours`: stored daytime hours of [start, end] (plant-local dates), by date.
pub async fn day_hours(pool: &PgPool, cfg: &GoogleWeatherConfig, cell_key: &str, start: NaiveDate, end: NaiveDate) -> Result<BTreeMap<NaiveDate, Vec<Hour>>> {
    let rows: Vec<Hour> = sqlx::query_as(
        "SELECT hour, condition, is_daytime, temp_c, feels_like_c, dew_point_c, humidity_pct, cloud_cover_pct, uv_index, \
         precip_mm, precip_prob_pct, thunder_prob_pct, wind_speed_ms, wind_gust_ms, wind_dir_deg, pressure_hpa, visibility_km \
         FROM google_weather_hourly WHERE cell_key = $1 AND hour >= $2 AND hour < $3 ORDER BY hour",
    )
    .bind(cell_key)
    .bind(start.and_time(NaiveTime::MIN))
    .bind((end + Duration::days(1)).and_time(NaiveTime::MIN))
    .fetch_all(pool)
    .await?;
    let mut out: BTreeMap<NaiveDate, Vec<Hour>> = BTreeMap::new();
    for r in rows {
        if !cfg.in_window(r.hour.hour()) {
            continue;
        }
        out.entry(r.hour.date()).or_default().push(r);
    }
    Ok(out)
}

/// Python `latest_day`: newest stored day with at least `min_day_hours()` daytime hours (else the
/// newest day at all).
pub async fn latest_day(pool: &PgPool, cfg: &GoogleWeatherConfig, cell_key: &str) -> Result<Option<NaiveDate>> {
    let last: Option<NaiveDateTime> = sqlx::query_scalar("SELECT max(hour) FROM google_weather_hourly WHERE cell_key = $1")
        .bind(cell_key)
        .fetch_one(pool)
        .await?;
    let Some(last) = last else { return Ok(None) };
    let by_day = day_hours(pool, cfg, cell_key, last.date() - Duration::days(3), last.date()).await?;
    let full = by_day.iter().filter(|(_, rows)| rows.len() >= cfg.min_day_hours()).map(|(d, _)| *d).max();
    Ok(Some(full.unwrap_or(last.date())))
}

/// Python `days_since_rain`: days from the last complete day with ≥ RAIN_DAY_MM of rain up to
/// `day` (0 = rained that day); null when a day without complete data lies in between or no rain
/// day is stored within RAIN_LOOKBACK_DAYS.
pub async fn days_since_rain(pool: &PgPool, cfg: &GoogleWeatherConfig, cell_key: &str, day: NaiveDate) -> Result<Value> {
    let floor = day - Duration::days(RAIN_LOOKBACK_DAYS);
    let by_day = day_hours(pool, cfg, cell_key, floor, day).await?;
    let mut d = day;
    let empty = Vec::new();
    while d >= floor {
        let rows = by_day.get(&d).unwrap_or(&empty);
        let rain = py_sum(rows.iter().map(|r| r.precip_mm.unwrap_or(0.0)));
        if rain >= RAIN_DAY_MM {
            return Ok(json!({"days_since_rain": (day - d).num_days(), "last_rain_day": d.to_string(), "last_rain_mm": py_round(rain, 1)}));
        }
        if rows.len() < cfg.min_day_hours() && d != day {
            break;
        }
        d -= Duration::days(1);
    }
    Ok(json!({"days_since_rain": null, "last_rain_day": null, "last_rain_mm": null}))
}

/// Python `build_day`: stored Google hourly weather for one plant-local day (default: the latest
/// complete day). Modelled values.
pub async fn build_day(pool: &PgPool, cfg: &GoogleWeatherConfig, plant: &Plant, day: Option<NaiveDate>) -> Result<Value> {
    let cell = plant_cell(plant, cfg);
    let mut base = json!({
        "meta": {"source": "db", "provider": SOURCE, "modelled": true, "day": null, "cell": null},
        "configured": cfg.configured,
        "has_location": cell.is_some(),
        "hours": [],
        "kpis": day_kpis(&[], cfg),
        "slots": slots(&[]),
        "rain": {"days_since_rain": null, "last_rain_day": null, "last_rain_mm": null},
    });
    let Some((key, lat, lon)) = cell else { return Ok(base) };
    base["meta"]["cell"] = json!({"key": key, "latitude": lat, "longitude": lon});
    let day = match day {
        Some(d) => d,
        None => match latest_day(pool, cfg, &key).await? {
            Some(d) => d,
            None => return Ok(base),
        },
    };
    let rows: Vec<Value> = day_hours(pool, cfg, &key, day, day).await?.get(&day).map(|v| v.iter().map(row_out).collect()).unwrap_or_default();
    base["meta"]["day"] = json!(day.to_string());
    base["kpis"] = day_kpis(&rows, cfg);
    base["slots"] = Value::Object(slots(&rows));
    base["rain"] = days_since_rain(pool, cfg, &key, day).await?;
    base["hours"] = Value::Array(rows);
    Ok(base)
}

/// Python `day_summary`: compact daily fields for the Firestore daily plant doc (modelled); None
/// without coordinates or stored hours.
pub async fn day_summary(pool: &PgPool, cfg: &GoogleWeatherConfig, plant: &Plant, day: NaiveDate) -> Result<Value> {
    let Some((key, _, _)) = plant_cell(plant, cfg) else { return Ok(Value::Null) };
    let rows: Vec<Value> = day_hours(pool, cfg, &key, day, day).await?.get(&day).map(|v| v.iter().map(row_out).collect()).unwrap_or_default();
    if rows.is_empty() {
        return Ok(Value::Null);
    }
    let k = day_kpis(&rows, cfg);
    Ok(json!({
        "modelled": true,
        "hours": k["hours"],
        "rain_mm": k["rain_mm"],
        "cloud_cover_daytime_pct": k["cloud_cover_daytime_pct"],
        "temp_max_c": k["temp_max_c"],
        "temp_min_c": k["temp_min_c"],
        "uv_max": k["uv_max"],
        "condition": k["condition"],
        "rained": k["rained"],
        "days_since_rain": days_since_rain(pool, cfg, &key, day).await?["days_since_rain"],
        "slots": Value::Object(slots(&rows)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells() {
        assert_eq!(cell_of(13.7563, 100.5018, 0.01).0, "13.76,100.50");
        assert_eq!(cell_of(13.7563, 100.5018, 1.0).0, "14,101");
        assert_eq!(cell_of(13.7563, 100.5018, 0.25).0, "13.75,100.50");
    }

    #[test]
    fn raining() {
        assert_eq!(is_raining(None, None), None);
        assert_eq!(is_raining(Some(0.2), None), Some(true));
        assert_eq!(is_raining(Some(0.0), Some("LIGHT_RAIN")), Some(true));
        assert_eq!(is_raining(None, Some("CHANCE_OF_SHOWERS")), Some(false));
        assert_eq!(is_raining(Some(0.0), Some("CLEAR")), Some(false));
    }

    #[test]
    fn kpis_empty_and_ties() {
        let cfg = GoogleWeatherConfig::default();
        let k = day_kpis(&[], &cfg);
        assert_eq!(k["complete"], json!(false));
        assert_eq!(k["rained"], Value::Null);
        assert_eq!(k["rain_hours"], Value::Null);
        let rows = vec![
            json!({"hour": "2026-11-27 09:00:00", "is_daytime": true, "condition": "CLOUDY", "precip_mm": 0.0}),
            json!({"hour": "2026-11-27 10:00:00", "is_daytime": true, "condition": "CLEAR", "precip_mm": null}),
        ];
        let k = day_kpis(&rows, &cfg);
        assert_eq!(k["condition"], json!("CLOUDY"));
        assert_eq!(k["rained"], json!(false));
        assert_eq!(k["rain_mm"], json!(0.0));
        let s = slots(&rows);
        assert_eq!(s["09"]["status_th"], json!("ไม่มีฝน"));
        assert_eq!(s["13"], Value::Null);
    }
}
