//! Each inverter's active power limit, read from the inverter (`power_limits` job), ported from
//! backend/app/services/growatt_sync/power_limits.py. A configured setting with its read time, not
//! a measurement; a refusal never writes a default.

use std::time::Duration;

use chrono::{DateTime, Duration as Span, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::{py, GrowattClient, GrowattError};

use crate::sync_registry::{Result, SyncError};

const LOG: &str = "growatt_sync";

/// Python `POWER_LIMIT_REFRESH_HOURS`: one read per inverter per day (the job runs daily)
pub const POWER_LIMIT_REFRESH_HOURS: i64 = 20;
/// Python `POWER_LIMIT_PAUSE_S`: between calls (a full account at this pace hit no 10012)
pub const POWER_LIMIT_PAUSE_S: f64 = 2.0;
/// Python `sync_power_limits(max_rate_limited=3)`
pub const POWER_LIMIT_MAX_RATE_LIMITED: u32 = 3;

/// Python `repr` of a `{str: int}` dict in insertion order (`{'5': 2, 'error': 1}`).
fn dict_repr(items: &[(String, i64)]) -> String {
    let parts: Vec<String> = items.iter().map(|(k, v)| format!("{}: {v}", py::repr_str(k))).collect();
    format!("{{{}}}", parts.join(", "))
}

/// Python `sync_power_limits`: read each installed inverter's active power limit (`readPower`)
/// and store it as `power_limit_pct`, never read / read longest ago first, skipping ones read
/// within POWER_LIMIT_REFRESH_HOURS. Restricted to one phase's plants when `phase` is given
/// (`include_untagged` also takes plants with no phase yet: `common._inverters_query`).
/// Refusals (offline inverter, a datalogger that doesn't pass it on) leave the stored value and
/// its read time as they were. `max_rate_limited` 10012s in a row end the sweep (listed in
/// `failed`, so the run is `partial`).
pub async fn sync_power_limits(
    pool: &PgPool,
    client: &GrowattClient,
    phase: Option<i32>,
    include_untagged: bool,
    now: Option<DateTime<Utc>>,
    pause_s: f64,
    max_rate_limited: u32,
) -> Result<Map<String, Value>> {
    let now = now.unwrap_or_else(Utc::now);
    let cutoff = now - Span::hours(POWER_LIMIT_REFRESH_HOURS);
    let order = "ORDER BY i.power_limit_read_at IS NOT NULL, i.power_limit_read_at, i.device_sn";
    let rows: Vec<(String, Option<f64>, Option<DateTime<Utc>>)> = match phase {
        None => {
            sqlx::query_as(&format!(
                "SELECT i.device_sn, i.power_limit_pct, i.power_limit_read_at FROM growatt_inverters i \
                 WHERE i.not_installed_at IS NULL {order}"
            ))
            .fetch_all(pool)
            .await?
        }
        Some(p) => {
            sqlx::query_as(&format!(
                "SELECT i.device_sn, i.power_limit_pct, i.power_limit_read_at FROM growatt_inverters i \
                 JOIN growatt_plants g ON g.plant_id = i.plant_id \
                 WHERE i.not_installed_at IS NULL AND (g.phase = $1 OR ($2 AND g.phase IS NULL)) {order}"
            ))
            .bind(p)
            .bind(include_untagged)
            .fetch_all(pool)
            .await?
        }
    };
    let ph = phase.map_or_else(|| "None".to_owned(), |p| p.to_string());
    let (mut read, mut limited, mut unreadable) = (0i64, 0i64, 0i64);
    let mut failed: Vec<Value> = Vec::new();
    let mut errors: Vec<(String, i64)> = Vec::new();
    let count = |errors: &mut Vec<(String, i64)>, key: String| match errors.iter_mut().find(|(k, _)| *k == key) {
        Some((_, n)) => *n += 1,
        None => errors.push((key, 1)),
    };
    let mut in_a_row = 0u32;
    let mut asked = 0u32;
    for (sn, old, last) in rows {
        if last.is_some_and(|l| l > cutoff) {
            continue;
        }
        if asked > 0 && pause_s > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(pause_s)).await;
        }
        asked += 1;
        let pct = match client.read_power(&sn).await {
            Ok(p) => p,
            Err(e) if e.is_rate_limited() => {
                in_a_row += 1;
                if in_a_row >= max_rate_limited {
                    tracing::warn!(target: LOG, "readPower rate limited {in_a_row} times in a row; the rest wait for the next run");
                    failed.push(json!(format!("phase {ph}: readPower rate limited")));
                    break;
                }
                continue;
            }
            Err(GrowattError::Api(e)) => {
                in_a_row = 0;
                unreadable += 1;
                // str(exc.error_code)
                let key = e.error_code.as_ref().map_or_else(|| "None".to_owned(), py::str_of);
                count(&mut errors, key);
                tracing::debug!(target: LOG, "inverter {sn} readPower refused: {e}");
                continue;
            }
            Err(e) => {
                // network etc.: skip this inverter
                in_a_row = 0;
                unreadable += 1;
                count(&mut errors, "error".into());
                tracing::warn!(target: LOG, "inverter {sn} readPower failed: {}", SyncError::from(e).message());
                continue;
            }
        };
        in_a_row = 0;
        // a change of a known limit is worth a line; the first read of each inverter is not
        if let Some(o) = old {
            if o != pct {
                tracing::info!(target: LOG, "inverter {sn} power limit {} -> {} %", py::repr_float(o), py::repr_float(pct));
            }
        }
        sqlx::query("UPDATE growatt_inverters SET power_limit_pct = $2, power_limit_read_at = $3, synced_at = $4 WHERE device_sn = $1")
            .bind(&sn)
            .bind(pct)
            .bind(now)
            .bind(Utc::now())
            .execute(pool)
            .await?;
        read += 1;
        if pct < 100.0 {
            limited += 1;
        }
    }
    tracing::info!(
        target: LOG,
        "phase {ph} readPower: {read} read ({limited} below 100 %), {unreadable} refused {}",
        dict_repr(&errors)
    );
    let mut out = Map::new();
    out.insert("power_limits_read".into(), json!(read));
    out.insert("power_limited".into(), json!(limited));
    out.insert("power_limit_unreadable".into(), json!(unreadable));
    out.insert("failed".into(), Value::Array(failed));
    out.insert(
        "power_limit_errors".into(),
        Value::Object(errors.into_iter().map(|(k, v)| (k, json!(v))).collect()),
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_print_like_a_python_dict() {
        assert_eq!(dict_repr(&[]), "{}");
        assert_eq!(dict_repr(&[("5".into(), 2), ("error".into(), 1)]), "{'5': 2, 'error': 1}");
    }
}
