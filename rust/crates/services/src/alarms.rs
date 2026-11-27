//! Stored Growatt alarm log, the fleet-wide DB read of the Active Alarm page (Python
//! backend/app/services/growatt_alarms.py: `alarm_day`, `next_run_at`, and `jobs.last_started`).
//!
//! DB only: never calls Growatt. The worker side (`sync_alarms`, `inverter_tiers`,
//! `store_inverter_day`, `prune_alarms`) is Phase 4 (crates/worker).

#![allow(clippy::type_complexity)] // sqlx row tuples

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, NaiveDateTime, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::common::{isoformat_utc, Result};

/// Python `growatt_alarms._TIME_FMT`
const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";
/// Python `jobs.ABANDONED`: the error of a run cut off by a worker restart
pub const ABANDONED: &str = "abandoned (worker stopped mid-run)";

/// Python `jobs.PLANT_TZ` (Asia/Bangkok: UTC+7 all year, no DST)
pub fn plant_tz() -> FixedOffset {
    FixedOffset::east_opt(7 * 3600).expect("UTC+7")
}

/// Python `growatt_alarms._iso_utc` of an aware (`timestamptz`) value
fn iso_utc(ts: Option<DateTime<Utc>>) -> Option<String> {
    ts.map(isoformat_utc)
}

/// Python `growatt_alarms._fmt`
fn fmt(ts: Option<NaiveDateTime>) -> Option<String> {
    ts.map(|t| t.format(TIME_FMT).to_string())
}

/// Python `alarm_day`'s `int(code) if code and code.isdigit() else code`
fn alarm_code(code: Option<String>) -> Value {
    match code {
        Some(c) if !c.is_empty() && c.chars().all(|ch| ch.is_ascii_digit()) => match c.parse::<i64>() {
            Ok(n) => json!(n),
            Err(_) => json!(c),
        },
        other => json!(other),
    }
}

/// Python `jobs.last_started`: when the job last started (UTC); a run cut off by a worker
/// restart (`ABANDONED`) doesn't count.
pub async fn last_started(pool: &PgPool, job: &str) -> Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar(
        "SELECT started_at FROM sync_runs WHERE job = $1 AND (error IS NULL OR error != $2) \
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(job)
    .bind(ABANDONED)
    .fetch_optional(pool)
    .await?)
}

/// Python `growatt_alarms.next_run_at`: when the worker's `alarms` job will next start (UTC),
/// from its last start, tick (`WORKER_ALARMS_TICK_MIN`) and daytime window
/// (`WORKER_ALARMS_START_H` / `_END_H`, plant-local). In the past when the run is overdue.
pub fn next_run_at(now: DateTime<Utc>, last_start: Option<DateTime<Utc>>, tick_min: i64, start_h: u32, end_h: u32) -> DateTime<Utc> {
    let cand = match last_start {
        Some(t) => t + Duration::minutes(tick_min),
        None => now,
    };
    let local = cand.with_timezone(&plant_tz());
    let at_start = |d: DateTime<FixedOffset>| {
        d.with_hour(start_h)
            .and_then(|d| d.with_minute(0))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .unwrap_or(d)
    };
    let local = if local.hour() < start_h {
        at_start(local)
    } else if local.hour() >= end_h {
        at_start(local + Duration::days(1))
    } else {
        local
    };
    local.with_timezone(&Utc)
}

/// Python `growatt_alarms.alarm_day`: every stored alarm of `day` for the plants the user may see
/// (`allowed` None = all), with per-plant sync coverage. A plant with inverters not yet read for
/// the day reports that, rather than showing as "no alarms". (`meta.last_run_at` / `next_run_at`
/// are added by the route, as in Python's `fleet_alarms`.)
pub async fn alarm_day(pool: &PgPool, day: NaiveDate, allowed: Option<&HashSet<i64>>) -> Result<Value> {
    let ids: Option<Vec<i32>> = allowed.map(|a| a.iter().filter_map(|p| i32::try_from(*p).ok()).collect());
    let plant_rows: Vec<(i32, String, i64)> = sqlx::query_as(
        "SELECT p.plant_id, p.name, count(i.device_sn) FROM growatt_plants p \
         JOIN growatt_inverters i ON i.plant_id = p.plant_id \
         WHERE i.not_installed_at IS NULL AND ($1::int[] IS NULL OR p.plant_id = ANY($1)) \
         GROUP BY p.plant_id, p.name ORDER BY p.plant_id",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;

    let stamps: BTreeMap<i32, (i64, Option<DateTime<Utc>>, Option<DateTime<Utc>>)> = sqlx::query_as::<
        _,
        (i32, i64, Option<DateTime<Utc>>, Option<DateTime<Utc>>),
    >(
        "SELECT s.plant_id, count(s.device_sn), min(s.synced_at), max(s.synced_at) FROM growatt_alarm_syncs s \
         JOIN growatt_inverters i ON i.device_sn = s.device_sn \
         WHERE s.day = $1 AND i.not_installed_at IS NULL GROUP BY s.plant_id",
    )
    .bind(day)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(pid, n, lo, hi)| (pid, (n, lo, hi)))
    .collect();

    let mut out_plants = Vec::with_capacity(plant_rows.len());
    let mut newest: Option<DateTime<Utc>> = None;
    for (pid, name, n_inv) in &plant_rows {
        let (n, lo, hi) = stamps.get(pid).cloned().unwrap_or((0, None, None));
        if let Some(hi) = hi {
            if newest.is_none_or(|x| hi > x) {
                newest = Some(hi);
            }
        }
        out_plants.push(json!({
            "plant_id": pid,
            "name": name,
            "inverters": n_inv,
            "synced_inverters": n,
            // oldest read among the plant's inverters = how current the plant's log is at worst
            "synced_at": iso_utc(lo),
        }));
    }

    let pids: Vec<i32> = plant_rows.iter().map(|(p, _, _)| *p).collect();
    let rows: Vec<(
        i32,
        String,
        String,
        Option<NaiveDateTime>,
        Option<NaiveDateTime>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i32>,
        Option<DateTime<Utc>>,
    )> = sqlx::query_as(
        "SELECT a.plant_id, p.name, a.device_sn, a.start_time, a.end_time, a.alarm_code, a.alarm_message, \
                a.fault_type, a.status, s.synced_at \
         FROM growatt_alarms a JOIN growatt_plants p ON p.plant_id = a.plant_id \
         LEFT OUTER JOIN growatt_alarm_syncs s ON s.device_sn = a.device_sn AND s.day = a.day \
         WHERE a.day = $1 AND a.plant_id = ANY($2) \
         ORDER BY a.start_time DESC, a.id",
    )
    .bind(day)
    .bind(&pids)
    .fetch_all(pool)
    .await?;
    let alarms: Vec<Value> = rows
        .into_iter()
        .map(|(pid, name, sn, start, end, code, msg, fault, status, read)| {
            json!({
                "plant_id": pid,
                "plant_name": name,
                "device_sn": sn,
                "start_time": fmt(start),
                "end_time": fmt(end),
                "alarm_code": alarm_code(code),
                "alarm_message": msg,
                "fault_type": fault,
                "status": status,
                // when this inverter's log was last read (UTC): an alarm reported shortly before is ongoing
                "read_at": iso_utc(read),
            })
        })
        .collect();
    Ok(json!({
        "day": day.format("%Y-%m-%d").to_string(),
        "alarms": alarms,
        "plants": out_plants,
        "meta": {"source": "db", "synced_at": iso_utc(newest)},
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn next_run_inside_and_outside_the_window() {
        // last start 03:00 UTC = 10:00 local: + 10 min
        let last = Utc.with_ymd_and_hms(2026, 11, 27, 3, 0, 0).unwrap();
        let now = last + Duration::minutes(3);
        assert_eq!(next_run_at(now, Some(last), 10, 5, 20), last + Duration::minutes(10));
        // 19:55 local + 10 min = 20:05 local: next day 05:00 local = 22:00 UTC same day
        let last = Utc.with_ymd_and_hms(2026, 11, 27, 12, 55, 0).unwrap();
        assert_eq!(next_run_at(now, Some(last), 10, 5, 20), Utc.with_ymd_and_hms(2026, 11, 27, 22, 0, 0).unwrap());
        // never run, 02:00 local: 05:00 local the same day
        let now = Utc.with_ymd_and_hms(2026, 11, 26, 19, 0, 0).unwrap();
        assert_eq!(next_run_at(now, None, 10, 5, 20), Utc.with_ymd_and_hms(2026, 11, 26, 22, 0, 0).unwrap());
    }

    #[test]
    fn codes_are_ints_when_digits() {
        assert_eq!(alarm_code(Some("007".into())), json!(7));
        assert_eq!(alarm_code(Some("A1".into())), json!("A1"));
        assert_eq!(alarm_code(Some(String::new())), json!(""));
        assert_eq!(alarm_code(None), Value::Null);
    }
}
