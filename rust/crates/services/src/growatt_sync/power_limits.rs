//! Port of `backend/app/services/growatt_sync/power_limits.py`: each inverter's active power
//! limit read from the inverter itself (`new-api/readPower`, the `power_limits` job).


use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::{py, GrowattClient, GrowattError};

use super::{inverters_query, phase_text, SyncOptions, SyncResult};

/// Python `POWER_LIMIT_REFRESH_HOURS`: one read per inverter per day (the job runs daily)
pub const POWER_LIMIT_REFRESH_HOURS: i64 = 20;
/// Python `POWER_LIMIT_PAUSE_S`: between calls (a full account at this pace hit no 10012)
pub const POWER_LIMIT_PAUSE_S: f64 = 2.0;

/// Python `power_limits.sync_power_limits`: read each inverter's active power limit and store it
/// as `power_limit_pct` (never read / read longest ago first, skipping ones read within
/// [`POWER_LIMIT_REFRESH_HOURS`]). A refusal leaves the stored value and its read time as they
/// were (never a default). `max_rate_limited` 10012s in a row end the sweep.
#[allow(clippy::too_many_arguments)]
pub async fn sync_power_limits(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    phase: Option<i32>,
    include_untagged: bool,
    now: Option<DateTime<Utc>>,
    pause_s: f64,
    max_rate_limited: usize,
) -> SyncResult<Value> {
    let now = now.unwrap_or_else(Utc::now);
    let cutoff = now - chrono::Duration::hours(POWER_LIMIT_REFRESH_HOURS);
    let invs = inverters_query(
        pool,
        phase,
        include_untagged,
        Some("(i.power_limit_read_at IS NOT NULL), i.power_limit_read_at, i.device_sn"),
    )
    .await?;
    let (mut read, mut limited, mut unreadable) = (0u64, 0u64, 0u64);
    let mut failed: Vec<Value> = Vec::new();
    let mut errors = super::PyCounts::default();
    let mut in_a_row = 0usize;
    let mut asked = 0usize;
    for inv in &invs {
        if inv.power_limit_read_at.is_some_and(|last| last > cutoff) {
            continue;
        }
        if asked > 0 {
            opts.sleep(pause_s).await;
        }
        asked += 1;
        let pct = match client.read_power(&inv.device_sn).await {
            Ok(p) => p,
            Err(GrowattError::Api(a)) => {
                if a.is_rate_limited() {
                    in_a_row += 1;
                    if in_a_row >= max_rate_limited {
                        tracing::warn!(target: "growatt_sync", "readPower rate limited {in_a_row} times in a row; the rest wait for the next run");
                        failed.push(json!(format!("phase {}: readPower rate limited", phase_text(phase))));
                        break;
                    }
                    continue;
                }
                in_a_row = 0;
                unreadable += 1;
                let key = a.error_code.as_ref().map_or_else(|| "None".to_owned(), py::str_of);
                errors.bump(key);
                tracing::debug!(target: "growatt_sync", "inverter {} readPower refused: {}", inv.device_sn, a.message);
                continue;
            }
            Err(e) => {
                in_a_row = 0;
                unreadable += 1;
                errors.bump("error".into());
                tracing::warn!(target: "growatt_sync", "inverter {} readPower failed: {e}", inv.device_sn);
                continue;
            }
        };
        in_a_row = 0;
        if inv.power_limit_pct.is_some_and(|old| old != pct) {
            tracing::info!(target: "growatt_sync", "inverter {} power limit {} -> {} %", inv.device_sn, super::py_opt_float(inv.power_limit_pct), py::repr_float(pct));
        }
        sqlx::query("UPDATE growatt_inverters SET power_limit_pct = $1, power_limit_read_at = $2, synced_at = now() WHERE device_sn = $3")
            .bind(pct)
            .bind(now)
            .bind(&inv.device_sn)
            .execute(pool)
            .await?;
        read += 1;
        if pct < 100.0 {
            limited += 1;
        }
    }
    tracing::info!(target: "growatt_sync",
        "phase {} readPower: {read} read ({limited} below 100 %), {unreadable} refused {}",
        phase_text(phase),
        errors.repr()
    );
    Ok(json!({
        "power_limits_read": read,
        "power_limited": limited,
        "power_limit_unreadable": unreadable,
        "failed": failed,
        "power_limit_errors": errors,
    }))
}
