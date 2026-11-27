//! Shared pieces of the Growatt analytics (DB only), ported from
//! backend/app/services/growatt_common.py: number and time helpers, plant lookup, capacity checks
//! and the inverter row shape. Timestamps in the reading tables are plant-local (Thai) time,
//! stored naive (`NaiveDateTime`); values that cannot be computed from stored data are `None`.
//!
//! Other Phase 3 modules may append small helpers here; keep the existing `pub` items stable.

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

/// Python `SAMPLE_H`: nominal max_data interval (5 min), in hours
pub const SAMPLE_H: f64 = 5.0 / 60.0;
/// Python `MAX_GAP_H`: longest interval credited when integrating energy
pub const MAX_GAP_H: f64 = 10.0 / 60.0;
/// Python `MAX_DC_AC_RATIO`: a plant's DC capacity is never this many times its inverters' rated
/// AC power; above it Growatt's `peak_power` is treated as unknown.
pub const MAX_DC_AC_RATIO: f64 = 3.0;
/// Python `INACTIVE_MAX_A`: a string whose current never exceeds this all day carries no PV
pub const INACTIVE_MAX_A: f64 = 0.15;

// --------------------------------------------------------------------------- errors

/// What a service answers besides data: Python `GrowattNotFound` (→ 404), `ValueError` (→ 422)
/// and database errors (→ 500).
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    /// Python `growatt_common.GrowattNotFound` (a `LookupError`): requested plant / string has no stored data
    #[error("{0}")]
    NotFound(String),
    /// Python `ValueError` raised by a service (the route answers 422 with the message)
    #[error("{0}")]
    Invalid(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

pub type Result<T> = std::result::Result<T, ServiceError>;

// --------------------------------------------------------------------------- Python number / text forms

/// Python `round(x, n)` of a float: correctly rounded, ties to even on the exact binary value.
pub fn py_round(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{x:.digits$}").parse().unwrap_or(x)
}

/// Python `growatt_common._round`: `None` stays `None`.
pub fn round_opt(v: Option<f64>, digits: usize) -> Option<f64> {
    v.map(|x| py_round(x, digits))
}

/// Python `statistics.mean` of floats: exact sum (as `fractions`), then one rounding.
pub fn py_mean(vals: &[f64]) -> Option<f64> {
    if vals.is_empty() {
        return None;
    }
    let n = vals.len() as f64;
    let q = fsum(vals) / n;
    // one correction step: the exact residual sum(vals) - q*n (q*n split exactly with an FMA)
    let p = q * n;
    let err = q.mul_add(n, -p);
    let mut all = vals.to_vec();
    all.push(-p);
    all.push(-err);
    Some(q + fsum(&all) / n)
}

/// Python `math.fsum`: the correctly rounded sum (Shewchuk's partials).
pub fn fsum(vals: &[f64]) -> f64 {
    let mut partials: Vec<f64> = Vec::new();
    for &v in vals {
        let mut x = v;
        let mut i = 0;
        for j in 0..partials.len() {
            let mut y = partials[j];
            if x.abs() < y.abs() {
                std::mem::swap(&mut x, &mut y);
            }
            let hi = x + y;
            let lo = y - (hi - x);
            if lo != 0.0 {
                partials[i] = lo;
                i += 1;
            }
            x = hi;
        }
        partials.truncate(i);
        partials.push(x);
    }
    // sum the partials from the top, with the half-way correction of CPython's fsum
    let Some(mut hi) = partials.pop() else { return 0.0 };
    let mut lo = 0.0;
    while let Some(y) = partials.pop() {
        let x = hi;
        hi = x + y;
        let yr = hi - x;
        lo = y - yr;
        if lo != 0.0 {
            break;
        }
    }
    if !partials.is_empty() && ((lo < 0.0 && partials[partials.len() - 1] < 0.0) || (lo > 0.0 && partials[partials.len() - 1] > 0.0)) {
        let y = lo * 2.0;
        let x = hi + y;
        let yr = x - hi;
        if y == yr {
            hi = x;
        }
    }
    hi
}

/// Python `growatt_common._mean`: mean of the non-null values, `None` when there are none.
pub fn mean_opt<I: IntoIterator<Item = Option<f64>>>(values: I) -> Option<f64> {
    let vals: Vec<f64> = values.into_iter().flatten().collect();
    py_mean(&vals)
}

/// Python `growatt_common._max`: max of the non-null values, `None` when there are none.
pub fn max_opt<I: IntoIterator<Item = Option<f64>>>(values: I) -> Option<f64> {
    values.into_iter().flatten().fold(None, |m: Option<f64>, v| Some(match m {
        Some(m) if m >= v => m,
        _ => v,
    }))
}

/// Python `statistics.median` of floats (the mean of the two middle values for an even count).
pub fn py_median(vals: &[f64]) -> Option<f64> {
    if vals.is_empty() {
        return None;
    }
    let mut v = vals.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 })
}

/// Python `growatt_common._integrate_kwh`: energy (kWh) from time-ordered (timestamp, watts)
/// samples, each weighted by the time since the previous one; the first sample and any sample
/// after a gap longer than `MAX_GAP_H` get the series' typical interval instead.
pub fn integrate_kwh(pts: &[(NaiveDateTime, Option<f64>)]) -> f64 {
    if pts.is_empty() {
        return 0.0;
    }
    let dts: Vec<f64> = pts
        .windows(2)
        .map(|w| (w[1].0 - w[0].0).num_microseconds().unwrap_or(0) as f64 / 1e6 / 3600.0)
        .collect();
    let regular: Vec<f64> = dts.iter().copied().filter(|d| *d > 0.0 && *d <= MAX_GAP_H).collect();
    let typical = py_median(&regular).unwrap_or(SAMPLE_H);
    let mut weights = vec![typical];
    weights.extend(dts.iter().map(|d| if *d > 0.0 && *d <= MAX_GAP_H { *d } else { typical }));
    // Python sum(): left to right, starting at int 0
    let mut total = 0.0;
    for ((_, w), dt) in pts.iter().zip(weights) {
        if let Some(w) = w {
            if *w > 0.0 {
                total += w * dt;
            }
        }
    }
    total / 1000.0
}

/// Python `growatt_common._bucket`: floor to the 5-minute slot.
pub fn bucket(ts: NaiveDateTime) -> NaiveDateTime {
    let m = ts.minute() - ts.minute() % 5;
    ts.with_minute(m).and_then(|t| t.with_second(0)).and_then(|t| t.with_nanosecond(0)).unwrap_or(ts)
}

/// Python `growatt_common._fmt_ts`: `%Y-%m-%d %H:%M:%S`.
pub fn fmt_ts(ts: Option<NaiveDateTime>) -> Option<String> {
    ts.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// Python `growatt_common._day_bounds`: [midnight, next midnight) of a plant-local day.
pub fn day_bounds(day: NaiveDate) -> (NaiveDateTime, NaiveDateTime) {
    let start = day.and_hms_opt(0, 0, 0).expect("midnight");
    (start, start + chrono::Duration::days(1))
}

/// Python `datetime.isoformat()` of an aware datetime read from a `timestamptz` column (psycopg
/// hands it back in the session time zone, UTC): microseconds only when non-zero, `+00:00`.
pub fn isoformat_utc(t: DateTime<Utc>) -> String {
    let fmt = if t.timestamp_subsec_micros() == 0 { SecondsFormat::Secs } else { SecondsFormat::Micros };
    t.to_rfc3339_opts(fmt, false)
}

/// Python `datetime.isoformat()` of a naive datetime (`2026-11-27T08:50:00`, microseconds only when non-zero).
pub fn isoformat_naive(t: NaiveDateTime) -> String {
    if t.and_utc().timestamp_subsec_micros() == 0 {
        t.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        t.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

// --------------------------------------------------------------------------- readings

/// Python `growatt_common.newest_inverter_ts` (and `_latest_reading`): newest stored inverter
/// record of these inverters (strictly before `before` when given), one index lookup per inverter.
pub async fn newest_inverter_ts(pool: &PgPool, sns: &[String], before: Option<NaiveDateTime>) -> Result<Option<NaiveDateTime>> {
    let mut best: Option<NaiveDateTime> = None;
    let mut seen = std::collections::HashSet::new();
    for sn in sns {
        if !seen.insert(sn) {
            continue;
        }
        let ts: Option<NaiveDateTime> = match before {
            Some(b) => sqlx::query_scalar(
                "SELECT timestamp FROM growatt_inverter_readings WHERE device_sn = $1 AND timestamp < $2 \
                 ORDER BY device_sn DESC, timestamp DESC LIMIT 1",
            )
            .bind(sn)
            .bind(b)
            .fetch_optional(pool)
            .await?,
            None => sqlx::query_scalar(
                "SELECT timestamp FROM growatt_inverter_readings WHERE device_sn = $1 \
                 ORDER BY device_sn DESC, timestamp DESC LIMIT 1",
            )
            .bind(sn)
            .fetch_optional(pool)
            .await?,
        };
        if let Some(t) = ts {
            if best.is_none_or(|b| t > b) {
                best = Some(t);
            }
        }
    }
    Ok(best)
}

/// Python `growatt_common.oldest_string_reading`: oldest per-string reading, one lookup per inverter.
pub async fn oldest_string_reading(pool: &PgPool) -> Result<Option<NaiveDateTime>> {
    let sns: Vec<String> = sqlx::query_scalar("SELECT device_sn FROM growatt_inverters").fetch_all(pool).await?;
    let mut best: Option<NaiveDateTime> = None;
    for sn in sns {
        let t: Option<NaiveDateTime> = sqlx::query_scalar("SELECT min(timestamp) FROM growatt_string_readings WHERE device_sn = $1")
            .bind(&sn)
            .fetch_one(pool)
            .await?;
        if let Some(t) = t {
            if best.is_none_or(|b| t < b) {
                best = Some(t);
            }
        }
    }
    Ok(best)
}

// --------------------------------------------------------------------------- plants

/// A row of `growatt_plants` (Python `GrowattPlant`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Plant {
    pub plant_id: i32,
    pub phase: Option<i32>,
    pub name: String,
    pub city: Option<String>,
    pub country: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub peak_power_kwp: Option<f64>,
    pub create_date: Option<String>,
    pub timezone: Option<String>,
    pub address: Option<String>,
    pub growatt_inverter_count: Option<i32>,
    pub growatt_datalogger_count: Option<i32>,
    pub details_synced_at: Option<DateTime<Utc>>,
    pub synced_at: DateTime<Utc>,
}

pub const PLANT_COLS: &str = "plant_id, phase, name, city, country, latitude, longitude, peak_power_kwp, create_date, \
     timezone, address, growatt_inverter_count, growatt_datalogger_count, details_synced_at, synced_at";

/// Python `growatt_common._get_plant`: the plant, or `NotFound("Plant {id} not found")`.
pub async fn get_plant(pool: &PgPool, plant_id: i64) -> Result<Plant> {
    let Ok(id) = i32::try_from(plant_id) else {
        return Err(ServiceError::NotFound(format!("Plant {plant_id} not found")));
    };
    sqlx::query_as::<_, Plant>(&format!("SELECT {PLANT_COLS} FROM growatt_plants WHERE plant_id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| ServiceError::NotFound(format!("Plant {plant_id} not found")))
}

/// Python `growatt_common.plant_phase`: project phase (Growatt account) of a plant; None if unknown.
pub async fn plant_phase(pool: &PgPool, plant_id: i64) -> Result<Option<i32>> {
    let Ok(id) = i32::try_from(plant_id) else { return Ok(None) };
    Ok(sqlx::query_scalar::<_, Option<i32>>("SELECT phase FROM growatt_plants WHERE plant_id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .flatten())
}

/// Python `growatt_common.plant_coords`: (lat, lon) of one plant, or of every plant; plants
/// without coordinates are left out.
pub async fn plant_coords(pool: &PgPool, plant_id: Option<i64>) -> Result<Vec<(f64, f64)>> {
    let rows: Vec<(f64, f64)> = match plant_id {
        Some(id) => sqlx::query_as(
            "SELECT latitude, longitude FROM growatt_plants WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND plant_id = $1",
        )
        .bind(id)
        .fetch_all(pool)
        .await?,
        None => sqlx::query_as("SELECT latitude, longitude FROM growatt_plants WHERE latitude IS NOT NULL AND longitude IS NOT NULL")
            .fetch_all(pool)
            .await?,
    };
    Ok(rows)
}

/// Python `growatt_common.plant_rated_ac_w`: summed rated AC power (W) per plant, only for plants
/// where every installed inverter has one (`None` plant_ids = every plant).
pub async fn plant_rated_ac_w(pool: &PgPool, plant_ids: Option<&[i64]>) -> Result<std::collections::HashMap<i64, f64>> {
    let base = "SELECT plant_id, sum(nominal_power_w), count(nominal_power_w), count(*) FROM growatt_inverters \
                WHERE not_installed_at IS NULL";
    let rows: Vec<(i32, Option<f64>, i64, i64)> = match plant_ids {
        Some(ids) => sqlx::query_as(&format!("{base} AND plant_id = ANY($1::bigint[]) GROUP BY plant_id"))
            .bind(ids.to_vec())
            .fetch_all(pool)
            .await?,
        None => sqlx::query_as(&format!("{base} GROUP BY plant_id")).fetch_all(pool).await?,
    };
    Ok(rows
        .into_iter()
        .filter_map(|(pid, w, known, n)| match w {
            Some(w) if w != 0.0 && known == n => Some((i64::from(pid), w)),
            _ => None,
        })
        .collect())
}

/// Python `growatt_common.plausible_capacity_kwp`: Growatt's peak power, or None when missing or
/// more than `MAX_DC_AC_RATIO` x the inverters' rated AC power. Unknown rating: kept as reported.
pub fn plausible_capacity_kwp(peak_kwp: Option<f64>, rated_ac_w: Option<f64>) -> Option<f64> {
    let peak = peak_kwp.filter(|p| *p != 0.0 && *p > 0.0)?;
    if let Some(r) = rated_ac_w.filter(|r| *r != 0.0) {
        if peak > MAX_DC_AC_RATIO * r / 1000.0 {
            return None;
        }
    }
    Some(peak)
}

/// Python `growatt_common.capacity_check`: (capacity used, Growatt's value when it was rejected as
/// implausible, else None).
pub async fn capacity_check(pool: &PgPool, plant: &Plant) -> Result<(Option<f64>, Option<f64>)> {
    let id = i64::from(plant.plant_id);
    let rated = plant_rated_ac_w(pool, Some(&[id])).await?.get(&id).copied();
    let cap = plausible_capacity_kwp(plant.peak_power_kwp, rated);
    let rejected = if cap.is_none() { plant.peak_power_kwp.filter(|p| *p != 0.0) } else { None };
    Ok((cap, rejected))
}

// --------------------------------------------------------------------------- inverters

/// A row of `growatt_inverters` (Python `GrowattInverter`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Inverter {
    pub device_sn: String,
    pub plant_id: i32,
    pub datalogger_sn: Option<String>,
    pub model: Option<String>,
    pub device_types: Option<String>,
    pub alias: Option<String>,
    pub nominal_power_w: Option<f64>,
    pub fw_version: Option<String>,
    pub inner_version: Option<String>,
    pub active_rate_pct: Option<f64>,
    pub reactive_rate_pct: Option<f64>,
    pub pf_setting: Option<f64>,
    pub pf_model: Option<i32>,
    pub export_limit: Option<i32>,
    pub export_limit_rate_pct: Option<f64>,
    pub on_off: Option<i32>,
    pub info_synced_at: Option<DateTime<Utc>>,
    pub power_limit_pct: Option<f64>,
    pub power_limit_read_at: Option<DateTime<Utc>>,
    pub device_model: Option<String>,
    pub datalogger_model: Option<String>,
    pub rated_power_w: Option<f64>,
    pub param_synced_at: Option<DateTime<Utc>>,
    pub growatt_created_at: Option<NaiveDateTime>,
    pub history_synced_until: Option<NaiveDateTime>,
    pub not_installed_at: Option<DateTime<Utc>>,
    pub not_installed_by: Option<String>,
    pub not_installed_note: Option<String>,
    pub synced_at: DateTime<Utc>,
}

pub const INVERTER_COLS: &str = "device_sn, plant_id, datalogger_sn, model, device_types, alias, nominal_power_w, \
     fw_version, inner_version, active_rate_pct, reactive_rate_pct, pf_setting, pf_model, export_limit, \
     export_limit_rate_pct, on_off, info_synced_at, power_limit_pct, power_limit_read_at, device_model, \
     datalogger_model, rated_power_w, param_synced_at, growatt_created_at, history_synced_until, \
     not_installed_at, not_installed_by, not_installed_note, synced_at";

impl Inverter {
    /// Python `GrowattInverter.active_limit_pct`: `readPower` when read, else max_data_info's activeRate.
    pub fn active_limit_pct(&self) -> Option<f64> {
        self.power_limit_pct.or(self.active_rate_pct)
    }

    /// Python `GrowattInverter.installed`
    pub fn installed(&self) -> bool {
        self.not_installed_at.is_none()
    }
}

/// Python `round(w / 1000, 1) if w else None` (0 = unknown)
fn kw_1(w: Option<f64>) -> Option<f64> {
    w.filter(|w| *w != 0.0).map(|w| py_round(w / 1000.0, 1))
}

/// Python `growatt_common.inverter_out`: registry fields. Status, lost and last upload time are
/// realtime: null here (the UI gets them live).
pub fn inverter_out(inv: &Inverter) -> Value {
    let device_types: Vec<String> = match inv.device_types.as_deref() {
        Some(s) if !s.is_empty() => s.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let active_rate_source = if inv.power_limit_pct.is_some() {
        Some("read_power")
    } else if inv.active_rate_pct.is_some() {
        Some("max_data_info")
    } else {
        None
    };
    json!({
        "device_sn": inv.device_sn,
        "model": inv.model.clone().unwrap_or_default(),
        "datalogger_sn": inv.datalogger_sn.clone().unwrap_or_default(),
        "manufacturer": "Growatt",
        "status": null,
        "status_label": null,
        "lost": null,
        "last_update_time": null,
        "device_types": device_types,
        "alias": inv.alias,
        "nominal_power_kw": kw_1(inv.nominal_power_w),
        "fw_version": inv.fw_version,
        "inner_version": inv.inner_version,
        "device_model": inv.device_model,
        "datalogger_model": inv.datalogger_model,
        "rated_power_kw": kw_1(inv.rated_power_w),
        "growatt_created_at": inv.growatt_created_at.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()),
        "settings": {
            "active_rate_pct": inv.active_limit_pct(),
            "active_rate_source": active_rate_source,
            "power_limit_read_at": inv.power_limit_read_at.map(isoformat_utc),
            "reactive_rate_pct": inv.reactive_rate_pct,
            "pf_setting": inv.pf_setting,
            "pf_model": inv.pf_model,
            "export_limit": inv.export_limit,
            "export_limit_rate_pct": inv.export_limit_rate_pct,
            "on_off": inv.on_off,
            "read_at": inv.info_synced_at.map(isoformat_utc),
        },
        "synced_at": isoformat_utc(inv.synced_at),
        "not_installed": inv.not_installed_at.map(|at| json!({
            "at": isoformat_utc(at),
            "by": inv.not_installed_by,
            "note": inv.not_installed_note,
        })),
    })
}

/// Python `growatt_common._expected_kw`: modelled clear-sky envelope (not measured), 82 % of kWp at
/// solar noon.
pub fn expected_kw(cap_kwp: Option<f64>, hr: f64) -> Option<f64> {
    let cap = cap_kwp.filter(|c| *c != 0.0)?;
    if !(6.0..=18.0).contains(&hr) {
        return Some(0.0);
    }
    let x = (hr - 12.15) / 5.85;
    Some(py_round(cap * 0.82 * (x * std::f64::consts::PI / 2.0).cos().max(0.0).powf(1.3), 2))
}

/// Python's builtin `sum()` of floats (CPython ≥ 3.12): Neumaier-compensated, the compensation
/// added once at the end (only when finite). Not plain left-to-right addition, which can differ
/// by an ulp and flip a later `round()`. (Appended by the stored-weather port.)
pub fn py_sum<I: IntoIterator<Item = f64>>(vals: I) -> f64 {
    let mut s = 0.0f64;
    let mut c = 0.0f64;
    for x in vals {
        let t = s + x;
        if s.abs() >= x.abs() {
            c += (s - t) + x;
        } else {
            c += (x - t) + s;
        }
        s = t;
    }
    if c != 0.0 && c.is_finite() {
        s += c;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn rounding_and_mean() {
        assert_eq!(py_round(2.675, 2), 2.67); // binary value below the tie, as Python
        assert_eq!(py_round(0.125, 2), 0.12); // exact tie: to even
        assert_eq!(py_mean(&[0.1, 0.2, 0.3]), Some(0.2)); // statistics.mean, not sum/n (0.20000000000000004)
        assert_eq!(fsum(&[0.1; 10]), 1.0);
        assert_eq!(py_median(&[3.0, 1.0, 2.0, 4.0]), Some(2.5));
        assert_eq!(max_opt([None, Some(1.0), Some(3.0)]), Some(3.0));
        assert_eq!(mean_opt([None, None]), None);
    }

    #[test]
    fn integrate_and_bucket() {
        // 3 samples 5 min apart at 1000 W: 3 x 5 min = 0.25 kWh
        let pts = [(ts("2026-11-27 10:00:00"), Some(1000.0)), (ts("2026-11-27 10:05:00"), Some(1000.0)), (ts("2026-11-27 10:10:00"), Some(1000.0))];
        assert!((integrate_kwh(&pts) - 0.25).abs() < 1e-12);
        assert_eq!(integrate_kwh(&[]), 0.0);
        assert_eq!(bucket(ts("2026-11-27 10:07:42")), ts("2026-11-27 10:05:00"));
    }

    #[test]
    fn capacity() {
        assert_eq!(plausible_capacity_kwp(Some(100.0), Some(80_000.0)), Some(100.0));
        assert_eq!(plausible_capacity_kwp(Some(1000.0), Some(80_000.0)), None);
        assert_eq!(plausible_capacity_kwp(Some(0.0), None), None);
        assert_eq!(plausible_capacity_kwp(Some(5.0), None), Some(5.0));
        assert_eq!(expected_kw(Some(100.0), 5.0), Some(0.0));
        assert_eq!(expected_kw(None, 12.0), None);
    }
}
