//! Port of the sync half of `backend/app/services/growatt_energy.py`: Growatt's own daily energy
//! and plant power curve → SQL (docs/plans/growatt-new-endpoints.md). `prune_plant_power` belongs
//! to the worker's `retention` job and is not here.
//!
//! - `plant/energy`: daily kWh per plant, the last [`ENERGY_LOOKBACK_DAYS`] finished days every run.
//! - `plant/power`: the plant's 5-minute AC curve for each finished day not stored yet.
//! - `device/inverter/day_energy`: each inverter's kWh for each finished day not stored yet.
//!
//! Only days before today (plant-local) are written: today's figures are realtime. These are
//! Growatt's numbers, kept next to (never instead of) what is integrated from stored records.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;

use chrono::{NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::{py, GrowattClient, GrowattError};

use crate::growatt_sync::{midnight, phase_text, upsert, SyncOptions, SyncResult, B, BATCH, RATE_LIMIT_CODE};

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

/// Python `growatt_energy._RateLimited`: the account should stop (its text is the call's label).
struct RateLimited(String);

/// Python `growatt_energy._Caller`: paced calls for one account; counts errors by Growatt code
/// and ends the sweep after `max_rate_limited` 10012s in a row.
struct Caller<'a> {
    opts: &'a SyncOptions,
    pause_s: f64,
    max_rate_limited: usize,
    asked: usize,
    in_a_row: usize,
    errors: BTreeMap<String, u64>,
}

impl<'a> Caller<'a> {
    fn new(opts: &'a SyncOptions, pause_s: f64, max_rate_limited: usize) -> Self {
        Caller { opts, pause_s, max_rate_limited, asked: 0, in_a_row: 0, errors: BTreeMap::new() }
    }

    /// `(ok, value)`, or `RateLimited` when the account should stop.
    async fn call<T, Fut>(&mut self, label: &str, fut: Fut) -> Result<Option<T>, RateLimited>
    where
        Fut: Future<Output = Result<T, GrowattError>>,
    {
        if self.asked > 0 {
            self.opts.sleep(self.pause_s).await;
        }
        self.asked += 1;
        match fut.await {
            Ok(v) => {
                self.in_a_row = 0;
                Ok(Some(v))
            }
            Err(GrowattError::Api(a)) => {
                let key = a.error_code.as_ref().map_or_else(|| "error".to_owned(), py::str_of);
                *self.errors.entry(key).or_default() += 1;
                if a.code() == Some(RATE_LIMIT_CODE) {
                    self.in_a_row += 1;
                    if self.in_a_row >= self.max_rate_limited {
                        return Err(RateLimited(label.to_owned()));
                    }
                } else {
                    self.in_a_row = 0;
                }
                tracing::debug!("{label} failed: {}", a.message);
                Ok(None)
            }
            Err(e) => {
                self.in_a_row = 0;
                *self.errors.entry("error".into()).or_default() += 1;
                tracing::warn!("{label} failed: {e}");
                Ok(None)
            }
        }
    }
}

/// Python `growatt_energy._plants_query`
async fn plant_ids(pool: &PgPool, phase: Option<i32>, include_untagged: bool) -> SyncResult<Vec<i32>> {
    let sql = match phase {
        None => "SELECT plant_id FROM growatt_plants ORDER BY plant_id".to_owned(),
        Some(_) => format!(
            "SELECT plant_id FROM growatt_plants WHERE (phase = $1{}) ORDER BY plant_id",
            if include_untagged { " OR phase IS NULL" } else { "" }
        ),
    };
    let mut q = sqlx::query_scalar::<_, i32>(&sql);
    if let Some(p) = phase {
        q = q.bind(p);
    }
    Ok(q.fetch_all(pool).await?)
}

/// Python `growatt_energy._finished_days`: the `n` days before `today`, oldest first.
fn finished_days(today: NaiveDate, n: i64) -> Vec<NaiveDate> {
    (1..=n).rev().map(|k| today - chrono::Duration::days(k)).collect()
}

async fn upsert_plant_energy(
    pool: &PgPool,
    pid: i32,
    rows: &[(NaiveDate, Option<f64>)],
    now: chrono::DateTime<Utc>,
) -> SyncResult<()> {
    let binds = rows.iter().map(|(d, kwh)| vec![B::I32(Some(pid)), B::Date(Some(*d)), B::F64(*kwh), B::Tz(Some(now))]).collect();
    let mut conn = pool.acquire().await?;
    upsert(&mut conn, "growatt_plant_energy_days", &["plant_id", "day", "energy_kwh", "synced_at"], &["plant_id", "day"], binds, BATCH)
        .await
}

/// Python `growatt_energy.sync_growatt_energy`: one account's plants: `plant/energy` for the last
/// `lookback_days` finished days, then `plant/power` and every inverter's `day_energy` for the
/// last `curve_days` finished days not stored yet. `today` is plant-local; nothing on or after it
/// is written.
#[allow(clippy::too_many_arguments)]
pub async fn sync_growatt_energy(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    today: NaiveDate,
    phase: Option<i32>,
    include_untagged: bool,
    lookback_days: i64,
    curve_days: i64,
    pause_s: f64,
    max_rate_limited: usize,
) -> SyncResult<Value> {
    let now = Utc::now();
    let pids = plant_ids(pool, phase, include_untagged).await?;
    let (mut energy_days, mut power_days, mut power_points, mut inv_days) = (0usize, 0usize, 0usize, 0usize);
    let mut failed: Vec<Value> = Vec::new();
    if pids.is_empty() {
        return Ok(json!({
            "plants": 0, "plant_energy_days": 0, "plant_power_days": 0, "plant_power_points": 0,
            "inverter_energy_days": 0, "failed": [],
        }));
    }
    let mut call = Caller::new(opts, pause_s, max_rate_limited);
    let days = finished_days(today, lookback_days.max(1));
    let curve = finished_days(today, curve_days.max(0));
    let mut have_power: HashSet<(i32, NaiveDate)> = HashSet::new();
    let mut have_inv: HashSet<(String, NaiveDate)> = HashSet::new();
    if let Some(&first) = curve.first() {
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

    let res: Result<SyncResult<()>, RateLimited> = async {
        for &pid in &pids {
            let label = format!("plant {pid} plant/energy");
            if let Some(rows) = call.call(&label, client.plant_energy_days(i64::from(pid), days[0], days[days.len() - 1])).await? {
                let keep: Vec<(NaiveDate, Option<f64>)> =
                    rows.into_iter().filter(|(d, _)| days[0] <= *d && *d < today).collect();
                if let Err(e) = upsert_plant_energy(pool, pid, &keep, now).await {
                    return Ok(Err(e));
                }
                energy_days += keep.len();
            }
            for &d in &curve {
                if !have_power.contains(&(pid, d)) {
                    let label = format!("plant {pid} plant/power {d}");
                    if let Some(pts) = call.call(&label, client.plant_power_day(i64::from(pid), d)).await? {
                        if !pts.is_empty() {
                            let lo = midnight(d);
                            let hi = lo + chrono::Duration::days(1);
                            let kept: Vec<(NaiveDateTime, f64)> = pts.into_iter().filter(|(ts, _)| lo <= *ts && *ts < hi).collect();
                            let binds = kept.iter().map(|(ts, w)| vec![B::I32(Some(pid)), B::Ts(Some(*ts)), B::F64(Some(*w))]).collect();
                            let r = async {
                                let mut conn = pool.acquire().await?;
                                upsert(&mut conn, "growatt_plant_power", &["plant_id", "timestamp", "power_w"], &["plant_id", "timestamp"], binds, BATCH).await
                            }
                            .await;
                            if let Err(e) = r {
                                return Ok(Err(e));
                            }
                            power_days += 1;
                            power_points += kept.len();
                        }
                    }
                }
                for sn in invs.get(&pid).cloned().unwrap_or_default() {
                    if have_inv.contains(&(sn.clone(), d)) {
                        continue;
                    }
                    let label = format!("inverter {sn} day_energy {d}");
                    if let Some(kwh) = call.call(&label, client.inverter_day_energy(&sn, d)).await? {
                        let binds = vec![vec![B::Text(Some(sn.clone())), B::Date(Some(d)), B::I32(Some(pid)), B::F64(kwh), B::Tz(Some(now))]];
                        let r = async {
                            let mut conn = pool.acquire().await?;
                            upsert(
                                &mut conn,
                                "growatt_inverter_energy_days",
                                &["device_sn", "day", "plant_id", "energy_kwh", "synced_at"],
                                &["device_sn", "day"],
                                binds,
                                BATCH,
                            )
                            .await
                        }
                        .await;
                        if let Err(e) = r {
                            return Ok(Err(e));
                        }
                        inv_days += 1;
                    }
                }
            }
        }
        Ok(Ok(()))
    }
    .await;
    match res {
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
        Err(RateLimited(label)) => {
            tracing::warn!(
                "phase {}: rate limited {max_rate_limited} times in a row at {label}; the rest wait for the next run",
                phase_text(phase)
            );
            failed.push(json!(format!("phase {}: rate limited at {label}", phase_text(phase))));
        }
    }
    tracing::info!(
        "phase {} Growatt energy: {energy_days} plant days, {power_days} curves ({power_points} points), {inv_days} inverter days, {} calls, errors {:?}",
        phase_text(phase),
        call.asked,
        call.errors
    );
    Ok(json!({
        "plants": pids.len(),
        "plant_energy_days": energy_days,
        "plant_power_days": power_days,
        "plant_power_points": power_points,
        "inverter_energy_days": inv_days,
        "failed": failed,
        "errors": call.errors,
        "calls": call.asked,
    }))
}

/// Python `growatt_energy.backfill_plant_energy`: `plant/energy` for the `days` finished days
/// before `today`, [`PLANT_ENERGY_CHUNK_DAYS`] per call, for plants missing any of them.
#[allow(clippy::too_many_arguments)]
pub async fn backfill_plant_energy(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    today: NaiveDate,
    days: i64,
    phase: Option<i32>,
    include_untagged: bool,
    pause_s: f64,
    max_rate_limited: usize,
) -> SyncResult<Value> {
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
    let mut call = Caller::new(opts, pause_s, max_rate_limited);
    let res: Result<SyncResult<()>, RateLimited> = async {
        for &pid in &pids {
            if stored.get(&pid).copied().unwrap_or(0) >= days {
                continue;
            }
            let mut lo = start;
            while lo < today {
                let hi = (lo + chrono::Duration::days(PLANT_ENERGY_CHUNK_DAYS - 1)).min(today - chrono::Duration::days(1));
                let label = format!("plant {pid} plant/energy {lo}..{hi}");
                if let Some(rows) = call.call(&label, client.plant_energy_days(i64::from(pid), lo, hi)).await? {
                    let keep: Vec<(NaiveDate, Option<f64>)> = rows.into_iter().filter(|(d, _)| lo <= *d && *d <= hi).collect();
                    if let Err(e) = upsert_plant_energy(pool, pid, &keep, now).await {
                        return Ok(Err(e));
                    }
                    energy_days += keep.len();
                }
                lo = hi + chrono::Duration::days(1);
            }
        }
        Ok(Ok(()))
    }
    .await;
    match res {
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
        Err(RateLimited(label)) => {
            tracing::warn!("phase {}: plant/energy backfill rate limited at {label}", phase_text(phase));
            failed.push(json!(format!("phase {}: rate limited at {label}", phase_text(phase))));
        }
    }
    tracing::info!(
        "phase {} plant/energy backfill: {energy_days} days, {} calls, errors {:?}",
        phase_text(phase),
        call.asked,
        call.errors
    );
    Ok(json!({
        "plants": pids.len(),
        "plant_energy_days": energy_days,
        "failed": failed,
        "errors": call.errors,
        "calls": call.asked,
    }))
}
