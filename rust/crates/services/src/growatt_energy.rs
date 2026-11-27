//! Port of `backend/app/services/growatt_energy.py` (sync half; `prune_plant_power` is in
//! `retention.rs`): Growatt's own daily energy and plant power curve → SQL
//! (docs/plans/growatt-new-endpoints.md).
//!
//! - `plant/energy`: daily kWh per plant, the last [`ENERGY_LOOKBACK_DAYS`] finished days every
//!   run (re-reads late uploads; one call per plant).
//! - `plant/power`: the plant's 5-minute AC curve for each finished day not stored yet.
//! - `device/inverter/day_energy`: each inverter's kWh for each finished day not stored yet.
//!
//! Only days before today (plant-local) are written: today's figures are realtime (rule 1). These
//! are Growatt's numbers, kept next to (never instead of) what is integrated from stored records.
//! [`MAX_RATE_LIMITED`] 10012s in a row end an account's sweep (the run is `partial`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::{py, GrowattClient, GrowattError};

/// Python `growatt_energy.RATE_LIMIT_CODE`
pub const RATE_LIMIT_CODE: i64 = 10012;
/// Python `ENERGY_LOOKBACK_DAYS`: `plant/energy` re-read window (finished days)
pub const ENERGY_LOOKBACK_DAYS: i64 = 7;
/// Python `CURVE_DAYS`: `plant/power` and `day_energy` fill up to this many missing days per run
pub const CURVE_DAYS: i64 = 2;
/// Python `ENERGY_PAUSE_S`: between calls of one account
pub const ENERGY_PAUSE_S: f64 = 1.0;
/// Python `MAX_RATE_LIMITED`
pub const MAX_RATE_LIMITED: usize = 3;
/// Python `PLANT_ENERGY_CHUNK_DAYS`: `plant/energy` days per call
pub const PLANT_ENERGY_CHUNK_DAYS: i64 = 31;
/// Python `growatt_sync.common._BATCH`: rows per INSERT of `_upsert`
const BATCH: usize = 2000;

/// The keyword arguments of `sync_growatt_energy` / `backfill_plant_energy` with their defaults.
#[derive(Debug, Clone, Copy)]
pub struct EnergyOptions {
    pub lookback_days: i64,
    pub curve_days: i64,
    pub pause_s: f64,
    pub max_rate_limited: usize,
}

impl Default for EnergyOptions {
    fn default() -> Self {
        EnergyOptions {
            lookback_days: ENERGY_LOOKBACK_DAYS,
            curve_days: CURVE_DAYS,
            pause_s: ENERGY_PAUSE_S,
            max_rate_limited: MAX_RATE_LIMITED,
        }
    }
}

/// Python `growatt_energy._RateLimited`: the account should stop (its text is the call's label).
struct RateLimited(String);

/// Python `growatt_energy._Caller`: paced calls for one account; counts errors by Growatt code
/// (in first-seen order, like the Python dict) and ends the sweep after `max_rate_limited`
/// 10012s in a row.
struct Caller {
    pause_s: f64,
    max_rate_limited: usize,
    asked: usize,
    in_a_row: usize,
    errors: Vec<(String, u64)>,
}

impl Caller {
    fn new(pause_s: f64, max_rate_limited: usize) -> Self {
        Caller { pause_s, max_rate_limited, asked: 0, in_a_row: 0, errors: Vec::new() }
    }

    fn count(&mut self, key: String) {
        match self.errors.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => self.errors.push((key, 1)),
        }
    }

    /// Python `_Caller.__call__`: `Ok(Some(value))`, `Ok(None)` when the call failed, or
    /// `Err(RateLimited)` when the account should stop.
    async fn call<T, Fut>(&mut self, label: &str, fut: Fut) -> Result<Option<T>, RateLimited>
    where
        Fut: Future<Output = Result<T, GrowattError>>,
    {
        if self.asked > 0 && self.pause_s > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(self.pause_s)).await;
        }
        self.asked += 1;
        match fut.await {
            Ok(v) => {
                self.in_a_row = 0;
                Ok(Some(v))
            }
            Err(GrowattError::Api(a)) => {
                let key = a.error_code.as_ref().map_or_else(|| "error".to_owned(), py::str_of);
                self.count(key);
                if a.code() == Some(RATE_LIMIT_CODE) {
                    self.in_a_row += 1;
                    if self.in_a_row >= self.max_rate_limited {
                        return Err(RateLimited(label.to_owned()));
                    }
                } else {
                    self.in_a_row = 0;
                }
                tracing::debug!(target: "growatt_energy", "{label} failed: {}", a.message);
                Ok(None)
            }
            Err(e) => {
                // network etc.: skip this one
                self.in_a_row = 0;
                self.count("error".into());
                tracing::warn!(target: "growatt_energy", "{label} failed: {e}");
                Ok(None)
            }
        }
    }

    /// The errors as JSON (detail) ...
    fn errors_json(&self) -> Value {
        Value::Object(self.errors.iter().map(|(k, n)| (k.clone(), json!(n))).collect())
    }

    /// ... and as Python's `%s` of the dict prints them in the log line (`{'10012': 3}`).
    fn errors_repr(&self) -> String {
        let parts: Vec<String> = self.errors.iter().map(|(k, n)| format!("'{k}': {n}")).collect();
        format!("{{{}}}", parts.join(", "))
    }
}

/// Python's `%s` of an `Optional[int]` phase
fn phase_text(phase: Option<i32>) -> String {
    phase.map_or_else(|| "None".to_owned(), |p| p.to_string())
}

fn midnight(d: NaiveDate) -> NaiveDateTime {
    d.and_hms_opt(0, 0, 0).expect("valid midnight")
}

/// Python `growatt_energy._plants_query`
async fn plant_ids(pool: &PgPool, phase: Option<i32>, include_untagged: bool) -> sqlx::Result<Vec<i32>> {
    match phase {
        None => sqlx::query_scalar("SELECT plant_id FROM growatt_plants ORDER BY plant_id").fetch_all(pool).await,
        Some(p) => {
            let sql = if include_untagged {
                "SELECT plant_id FROM growatt_plants WHERE phase = $1 OR phase IS NULL ORDER BY plant_id"
            } else {
                "SELECT plant_id FROM growatt_plants WHERE phase = $1 ORDER BY plant_id"
            };
            sqlx::query_scalar(sql).bind(p).fetch_all(pool).await
        }
    }
}

/// Python `growatt_energy._finished_days`: the `n` days before `today`, oldest first.
fn finished_days(today: NaiveDate, n: i64) -> Vec<NaiveDate> {
    (1..=n).rev().map(|k| today - chrono::Duration::days(k)).collect()
}

/// Python `_upsert(db, GrowattPlantEnergyDay, rows)`: INSERT .. ON CONFLICT (plant_id, day) DO
/// UPDATE every other column (`synced_at` is in the rows, so the ORM's onupdate adds nothing).
async fn upsert_plant_energy(
    pool: &PgPool,
    pid: i32,
    rows: &[(NaiveDate, Option<f64>)],
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    for chunk in rows.chunks(BATCH) {
        let days: Vec<NaiveDate> = chunk.iter().map(|r| r.0).collect();
        let kwh: Vec<Option<f64>> = chunk.iter().map(|r| r.1).collect();
        sqlx::query(
            "INSERT INTO growatt_plant_energy_days (plant_id, day, energy_kwh, synced_at) \
             SELECT $1, d, e, $4 FROM UNNEST($2::date[], $3::float8[]) AS u(d, e) \
             ON CONFLICT (plant_id, day) DO UPDATE SET energy_kwh = EXCLUDED.energy_kwh, synced_at = EXCLUDED.synced_at",
        )
        .bind(pid)
        .bind(&days)
        .bind(&kwh)
        .bind(now)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Python `_upsert(db, GrowattPlantPower, rows)`
async fn upsert_plant_power(pool: &PgPool, pid: i32, rows: &[(NaiveDateTime, f64)]) -> sqlx::Result<()> {
    for chunk in rows.chunks(BATCH) {
        let ts: Vec<NaiveDateTime> = chunk.iter().map(|r| r.0).collect();
        let w: Vec<f64> = chunk.iter().map(|r| r.1).collect();
        sqlx::query(
            "INSERT INTO growatt_plant_power (plant_id, timestamp, power_w) \
             SELECT $1, t, w FROM UNNEST($2::timestamp[], $3::float8[]) AS u(t, w) \
             ON CONFLICT (plant_id, timestamp) DO UPDATE SET power_w = EXCLUDED.power_w",
        )
        .bind(pid)
        .bind(&ts)
        .bind(&w)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Python `_upsert(db, GrowattInverterEnergyDay, [row])`
async fn upsert_inverter_energy(
    pool: &PgPool,
    sn: &str,
    day: NaiveDate,
    pid: i32,
    kwh: Option<f64>,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO growatt_inverter_energy_days (device_sn, day, plant_id, energy_kwh, synced_at) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (device_sn, day) DO UPDATE SET \
         plant_id = EXCLUDED.plant_id, energy_kwh = EXCLUDED.energy_kwh, synced_at = EXCLUDED.synced_at",
    )
    .bind(sn)
    .bind(day)
    .bind(pid)
    .bind(kwh)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// How a sweep ended: done, stopped by 10012s, or a database error (which fails the account).
enum Sweep {
    Done,
    Stopped(String),
}

/// Python `growatt_energy.sync_growatt_energy`: one account's plants: `plant/energy` for the last
/// `lookback_days` finished days, then `plant/power` and every inverter's `day_energy` for the
/// last `curve_days` finished days not stored yet. `today` is plant-local; nothing on or after it
/// is written. A database error fails the account (Python raises out of it).
pub async fn sync_growatt_energy(
    pool: &PgPool,
    client: &GrowattClient,
    today: NaiveDate,
    phase: Option<i32>,
    include_untagged: bool,
    o: EnergyOptions,
) -> sqlx::Result<Map<String, Value>> {
    let now = Utc::now();
    let pids = plant_ids(pool, phase, include_untagged).await?;
    let mut out = Map::new();
    out.insert("plants".into(), json!(pids.len()));
    let (mut energy_days, mut power_days, mut power_points, mut inv_days) = (0usize, 0usize, 0usize, 0usize);
    let mut failed: Vec<Value> = Vec::new();
    if pids.is_empty() {
        for k in ["plant_energy_days", "plant_power_days", "plant_power_points", "inverter_energy_days"] {
            out.insert(k.into(), json!(0));
        }
        out.insert("failed".into(), json!([]));
        return Ok(out);
    }
    let mut call = Caller::new(o.pause_s, o.max_rate_limited);
    let days = finished_days(today, o.lookback_days.max(1));
    let curve = finished_days(today, o.curve_days.max(0));
    let mut have_power: HashSet<(i32, NaiveDate)> = HashSet::new();
    let mut have_inv: HashSet<(String, NaiveDate)> = HashSet::new();
    if let Some(&first) = curve.first() {
        // Python: min(timestamp) grouped by plant and date(timestamp), then .date()
        let rows: Vec<(i32, NaiveDate)> = sqlx::query_as(
            "SELECT DISTINCT plant_id, timestamp::date FROM growatt_plant_power \
             WHERE plant_id = ANY($1) AND timestamp >= $2 AND timestamp < $3",
        )
        .bind(&pids)
        .bind(midnight(first))
        .bind(midnight(today))
        .fetch_all(pool)
        .await?;
        have_power.extend(rows);
        let rows: Vec<(String, NaiveDate)> =
            sqlx::query_as("SELECT device_sn, day FROM growatt_inverter_energy_days WHERE plant_id = ANY($1) AND day >= $2")
                .bind(&pids)
                .bind(first)
                .fetch_all(pool)
                .await?;
        have_inv.extend(rows);
    }
    // installed inverters only (`inverter_installed()`)
    let mut invs: HashMap<i32, Vec<String>> = HashMap::new();
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "SELECT device_sn, plant_id FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY plant_id, device_sn",
    )
    .bind(&pids)
    .fetch_all(pool)
    .await?;
    for (sn, pid) in rows {
        invs.entry(pid).or_default().push(sn);
    }

    let sweep: sqlx::Result<Sweep> = async {
        let (first, last) = (days[0], days[days.len() - 1]);
        for &pid in &pids {
            let label = format!("plant {pid} plant/energy");
            match call.call(&label, client.plant_energy_days(i64::from(pid), first, last)).await {
                Err(RateLimited(at)) => return Ok(Sweep::Stopped(at)),
                Ok(Some(rows)) => {
                    let keep: Vec<(NaiveDate, Option<f64>)> =
                        rows.into_iter().filter(|(d, _)| first <= *d && *d < today).collect();
                    upsert_plant_energy(pool, pid, &keep, now).await?;
                    energy_days += keep.len();
                }
                Ok(None) => {}
            }
            for &d in &curve {
                if !have_power.contains(&(pid, d)) {
                    let label = format!("plant {pid} plant/power {d}");
                    match call.call(&label, client.plant_power_day(i64::from(pid), d)).await {
                        Err(RateLimited(at)) => return Ok(Sweep::Stopped(at)),
                        Ok(Some(pts)) if !pts.is_empty() => {
                            let lo = midnight(d);
                            let hi = lo + chrono::Duration::days(1);
                            let kept: Vec<(NaiveDateTime, f64)> =
                                pts.into_iter().filter(|(ts, _)| lo <= *ts && *ts < hi).collect();
                            upsert_plant_power(pool, pid, &kept).await?;
                            power_days += 1;
                            power_points += kept.len();
                        }
                        Ok(_) => {}
                    }
                }
                for sn in invs.get(&pid).map(Vec::as_slice).unwrap_or_default() {
                    if have_inv.contains(&(sn.clone(), d)) {
                        continue;
                    }
                    let label = format!("inverter {sn} day_energy {d}");
                    match call.call(&label, client.inverter_day_energy(sn, d)).await {
                        Err(RateLimited(at)) => return Ok(Sweep::Stopped(at)),
                        Ok(Some(kwh)) => {
                            upsert_inverter_energy(pool, sn, d, pid, kwh, now).await?;
                            inv_days += 1;
                        }
                        Ok(None) => {}
                    }
                }
            }
        }
        Ok(Sweep::Done)
    }
    .await;
    if let Sweep::Stopped(at) = sweep? {
        tracing::warn!(
            target: "growatt_energy",
            "phase {}: rate limited {} times in a row at {at}; the rest wait for the next run",
            phase_text(phase),
            o.max_rate_limited
        );
        failed.push(json!(format!("phase {}: rate limited at {at}", phase_text(phase))));
    }
    out.insert("plant_energy_days".into(), json!(energy_days));
    out.insert("plant_power_days".into(), json!(power_days));
    out.insert("plant_power_points".into(), json!(power_points));
    out.insert("inverter_energy_days".into(), json!(inv_days));
    out.insert("failed".into(), Value::Array(failed));
    out.insert("errors".into(), call.errors_json());
    out.insert("calls".into(), json!(call.asked));
    tracing::info!(
        target: "growatt_energy",
        "phase {} Growatt energy: {energy_days} plant days, {power_days} curves ({power_points} points), {inv_days} inverter days, {} calls, errors {}",
        phase_text(phase),
        call.asked,
        call.errors_repr()
    );
    Ok(out)
}

/// Python `growatt_energy.backfill_plant_energy`: `plant/energy` for the `days` finished days
/// before `today`, [`PLANT_ENERGY_CHUNK_DAYS`] per call, for plants missing any of them.
pub async fn backfill_plant_energy(
    pool: &PgPool,
    client: &GrowattClient,
    today: NaiveDate,
    days: i64,
    phase: Option<i32>,
    include_untagged: bool,
    o: EnergyOptions,
) -> sqlx::Result<Map<String, Value>> {
    let now = Utc::now();
    let start = today - chrono::Duration::days(days);
    let pids = plant_ids(pool, phase, include_untagged).await?;
    let stored: HashMap<i32, i64> = if pids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (i32, i64)>(
            "SELECT plant_id, count(*) FROM growatt_plant_energy_days WHERE plant_id = ANY($1) AND day >= $2 AND day < $3 \
             GROUP BY plant_id",
        )
        .bind(&pids)
        .bind(start)
        .bind(today)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect()
    };
    let mut energy_days = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    let mut call = Caller::new(o.pause_s, o.max_rate_limited);
    let sweep: sqlx::Result<Sweep> = async {
        for &pid in &pids {
            if stored.get(&pid).copied().unwrap_or(0) >= days {
                continue;
            }
            let mut lo = start;
            while lo < today {
                let hi = (lo + chrono::Duration::days(PLANT_ENERGY_CHUNK_DAYS - 1)).min(today - chrono::Duration::days(1));
                let label = format!("plant {pid} plant/energy {lo}..{hi}");
                match call.call(&label, client.plant_energy_days(i64::from(pid), lo, hi)).await {
                    Err(RateLimited(at)) => return Ok(Sweep::Stopped(at)),
                    Ok(Some(rows)) => {
                        let keep: Vec<(NaiveDate, Option<f64>)> =
                            rows.into_iter().filter(|(d, _)| lo <= *d && *d <= hi).collect();
                        upsert_plant_energy(pool, pid, &keep, now).await?;
                        energy_days += keep.len();
                    }
                    Ok(None) => {}
                }
                lo = hi + chrono::Duration::days(1);
            }
        }
        Ok(Sweep::Done)
    }
    .await;
    if let Sweep::Stopped(at) = sweep? {
        tracing::warn!(target: "growatt_energy", "phase {}: plant/energy backfill rate limited at {at}", phase_text(phase));
        failed.push(json!(format!("phase {}: rate limited at {at}", phase_text(phase))));
    }
    let mut out = Map::new();
    out.insert("plants".into(), json!(pids.len()));
    out.insert("plant_energy_days".into(), json!(energy_days));
    out.insert("failed".into(), Value::Array(failed));
    out.insert("errors".into(), call.errors_json());
    out.insert("calls".into(), json!(call.asked));
    tracing::info!(
        target: "growatt_energy",
        "phase {} plant/energy backfill: {energy_days} days, {} calls, errors {}",
        phase_text(phase),
        call.asked,
        call.errors_repr()
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_days_are_before_today_oldest_first() {
        let t = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let d = finished_days(t, 3);
        assert_eq!(d, [t - chrono::Duration::days(3), t - chrono::Duration::days(2), t - chrono::Duration::days(1)]);
        assert!(finished_days(t, 0).is_empty());
    }

    #[test]
    fn errors_print_like_a_python_dict_in_first_seen_order() {
        let mut c = Caller::new(0.0, 3);
        assert_eq!(c.errors_repr(), "{}");
        c.count("10012".into());
        c.count("error".into());
        c.count("10012".into());
        assert_eq!(c.errors_repr(), "{'10012': 2, 'error': 1}");
        assert_eq!(c.errors_json(), json!({"10012": 2, "error": 1}));
    }
}
