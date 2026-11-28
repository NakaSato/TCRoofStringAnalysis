//! Port of the worker half of `backend/app/services/growatt_alarms.py`: the Growatt alarm / fault
//! log into SQL (`sync_alarms`, `store_inverter_day`, `inverter_tiers`; the `alarms` and
//! `alarms_yesterday` jobs). `prune_alarms` belongs to the worker's `retention` job; the DB read of
//! the Active Alarm page is `crate::alarms`.
//!
//! `device/max/alarm_data` answers one inverter-day per call. A successful read replaces that
//! inverter-day's rows and stamps `growatt_alarm_syncs`; a failed read keeps what was stored.
//! Alarms carry Growatt's own start / end times: source-timestamped history, not realtime values.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::py::{self, TimeFormat};
use tcroof_clients::growatt::{GrowattClient, GrowattError};

use crate::growatt_sync::{failed_entry, growatt_text, midnight, SyncOptions, SyncResult, RATE_LIMIT_CODE};

/// Python `MAX_RATE_LIMITED`: consecutive 10012 answers that end an account's sweep
pub const MAX_RATE_LIMITED: usize = 3;
/// Python `FAULT_STATUS`: `max_data` status of a MAX inverter in fault
pub const FAULT_STATUS: i32 = 3;
/// Python `ONGOING_GAP`: an alarm reported within this of the inverter's last read is ongoing
pub fn ongoing_gap() -> chrono::Duration {
    chrono::Duration::minutes(10)
}
/// Python `COLD_SPREAD`: cold reads per tick are capped at this × their fair share
pub const COLD_SPREAD: f64 = 1.5;

/// Python `Tiers`: how often an inverter's alarm log of today is re-read, by what is known.
#[derive(Debug, Clone, Copy)]
pub struct Tiers {
    /// alarm still being reported at the last read, or newest stored status is fault
    pub hot: chrono::Duration,
    /// alarms today, all closed
    pub warm: chrono::Duration,
    /// no alarms today
    pub cold: chrono::Duration,
    /// the job's tick: caps the cold reads per run
    pub tick: Option<chrono::Duration>,
}

/// One inverter to read (`GrowattInverter` fields `sync_alarms` uses).
#[derive(Debug, Clone)]
pub struct AlarmInverter {
    pub device_sn: String,
    pub plant_id: i32,
}

/// Python `_parse_time`
fn parse_time(v: &Value) -> Option<NaiveDateTime> {
    if !py::truthy(v) {
        return None;
    }
    let s = py::str_of(v);
    py::strptime(py::head(&s, 19), TimeFormat::Seconds)
}

/// Python `_code`: None / "" → None, else `str(v)`
fn code(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        other => Some(py::str_of(other)),
    }
}

/// `(str(v)[:n] or None) if v else None`
fn clipped(v: &Value, n: usize) -> Option<String> {
    if !py::truthy(v) {
        return None;
    }
    let s = py::str_of(v);
    let h = py::head(&s, n);
    (!h.is_empty()).then(|| h.to_owned())
}

struct AlarmRow {
    start_time: Option<NaiveDateTime>,
    end_time: Option<NaiveDateTime>,
    alarm_code: Option<String>,
    alarm_message: Option<String>,
    fault_type: Option<String>,
    status: Option<i32>,
}

/// Python `_alarm_rows`
fn alarm_rows(records: &[Value]) -> SyncResult<Vec<AlarmRow>> {
    records
        .iter()
        .map(|a| {
            let a = py::as_dict(a)?;
            Ok(AlarmRow {
                start_time: parse_time(py::get(a, "start_time")),
                end_time: parse_time(py::get(a, "end_time")),
                alarm_code: code(py::get(a, "alarm_code")),
                alarm_message: clipped(py::get(a, "alarm_message"), 255),
                fault_type: clipped(py::get(a, "fault_type"), 32),
                status: py::int(py::get(a, "status")).ok().map(|v| v as i32),
            })
        })
        .collect()
}

/// Python `store_inverter_day`: replace one inverter-day's alarms with a complete read and stamp it
/// synced (one transaction). Returns the rows written.
pub async fn store_inverter_day(
    pool: &PgPool,
    inv: &AlarmInverter,
    day: NaiveDate,
    records: &[Value],
    now: DateTime<Utc>,
) -> SyncResult<usize> {
    let rows = alarm_rows(records)?;
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM growatt_alarms WHERE device_sn = $1 AND day = $2")
        .bind(&inv.device_sn)
        .bind(day)
        .execute(&mut *tx)
        .await?;
    for r in &rows {
        sqlx::query(
            "INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, end_time, alarm_code, alarm_message, \
             fault_type, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(&inv.device_sn)
        .bind(inv.plant_id)
        .bind(day)
        .bind(r.start_time)
        .bind(r.end_time)
        .bind(&r.alarm_code)
        .bind(&r.alarm_message)
        .bind(&r.fault_type)
        .bind(r.status)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (device_sn, day) DO UPDATE SET plant_id = EXCLUDED.plant_id, synced_at = EXCLUDED.synced_at, \
         alarm_count = EXCLUDED.alarm_count",
    )
    .bind(&inv.device_sn)
    .bind(day)
    .bind(inv.plant_id)
    .bind(now)
    .bind(rows.len() as i32)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows.len())
}

/// Plant-local (Bangkok, UTC+7) wall time of a UTC instant (`jobs.PLANT_TZ`).
fn plant_local(t: DateTime<Utc>) -> NaiveDateTime {
    t.with_timezone(&FixedOffset::east_opt(7 * 3600).expect("UTC+7")).naive_local()
}

/// Python `inverter_tiers`: `hot` / `warm` / `cold` per serial for `day`, from SQL only.
pub async fn inverter_tiers(pool: &PgPool, day: NaiveDate, sns: &[String]) -> SyncResult<HashMap<String, &'static str>> {
    if sns.is_empty() {
        return Ok(HashMap::new());
    }
    let read_at: HashMap<String, NaiveDateTime> = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        "SELECT device_sn, synced_at FROM growatt_alarm_syncs WHERE day = $1 AND device_sn = ANY($2)",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(sn, at)| (sn, plant_local(at)))
    .collect();
    let mut open: HashSet<String> = HashSet::new();
    let rows: Vec<(String, Option<NaiveDateTime>, Option<NaiveDateTime>, i64)> = sqlx::query_as(
        "SELECT device_sn, max(start_time), max(end_time), count(*) FILTER (WHERE end_time IS NULL) FROM growatt_alarms \
         WHERE day = $1 AND device_sn = ANY($2) GROUP BY device_sn",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?;
    for (sn, last_start, last_end, no_end) in rows {
        let latest = [last_start, last_end].into_iter().flatten().max();
        let at = read_at.get(&sn);
        if no_end > 0 || matches!((latest, at), (Some(l), Some(a)) if l >= *a - ongoing_gap()) {
            open.insert(sn);
        }
    }
    let with_alarms: HashSet<String> = sqlx::query_scalar(
        "SELECT device_sn FROM growatt_alarm_syncs WHERE day = $1 AND alarm_count > 0 AND device_sn = ANY($2)",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let start = midnight(day);
    let faulted: HashSet<String> = sqlx::query_scalar(
        "SELECT r.device_sn FROM growatt_inverter_readings r JOIN (SELECT device_sn, max(timestamp) AS ts \
         FROM growatt_inverter_readings WHERE timestamp >= $1 AND timestamp < $2 AND device_sn = ANY($3) \
         GROUP BY device_sn) n ON n.device_sn = r.device_sn AND n.ts = r.timestamp WHERE r.status = $4",
    )
    .bind(start)
    .bind(start + chrono::Duration::days(1))
    .bind(sns)
    .bind(FAULT_STATUS)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    Ok(sns
        .iter()
        .map(|sn| {
            let t = if open.contains(sn) || faulted.contains(sn) {
                "hot"
            } else if with_alarms.contains(sn) {
                "warm"
            } else {
                "cold"
            };
            (sn.clone(), t)
        })
        .collect())
}

fn tier_rank(t: &str) -> u8 {
    match t {
        "hot" => 0,
        "warm" => 1,
        _ => 2,
    }
}

/// Python `sync_alarms`: read `day`'s alarm log of `inverters` (one account), never-read and
/// oldest-read first. With `tiers`, only the inverters whose tier interval has passed since their
/// last read (never-read ones always) are read, hot ones first, cold reads capped per tick.
#[allow(clippy::too_many_arguments)]
pub async fn sync_alarms(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    day: NaiveDate,
    inverters: &[AlarmInverter],
    pause_s: f64,
    tiers: Option<Tiers>,
    now: Option<DateTime<Utc>>,
) -> SyncResult<Value> {
    let synced: HashMap<String, DateTime<Utc>> =
        sqlx::query_as::<_, (String, DateTime<Utc>)>("SELECT device_sn, synced_at FROM growatt_alarm_syncs WHERE day = $1")
            .bind(day)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    // None = never read (Python's `datetime.min`), which sorts first
    let last = |inv: &AlarmInverter| synced.get(&inv.device_sn).copied();
    let mut totals = Map::new();
    totals.insert("alarm_inverters".into(), json!(inverters.len()));
    let order: Vec<&AlarmInverter> = match tiers {
        None => {
            let mut o: Vec<&AlarmInverter> = inverters.iter().collect();
            o.sort_by(|a, b| (last(a), a.plant_id, &a.device_sn).cmp(&(last(b), b.plant_id, &b.device_sn)));
            o
        }
        Some(t) => {
            let now = now.unwrap_or_else(Utc::now);
            let sns: Vec<String> = inverters.iter().map(|i| i.device_sn.clone()).collect();
            let tier_of = inverter_tiers(pool, day, &sns).await?;
            let every = |tier: &str| match tier {
                "hot" => t.hot,
                "warm" => t.warm,
                _ => t.cold,
            };
            // a little slack, so an interval equal to the tick does not slip a tick on run-time jitter
            let slack = chrono::Duration::minutes(1);
            let mut due: Vec<&AlarmInverter> = inverters
                .iter()
                .filter(|i| last(i).is_none_or(|l| now - l + slack >= every(tier_of[&i.device_sn])))
                .collect();
            due.sort_by(|a, b| {
                (tier_rank(tier_of[&a.device_sn]), last(a), a.plant_id, &a.device_sn).cmp(&(
                    tier_rank(tier_of[&b.device_sn]),
                    last(b),
                    b.plant_id,
                    &b.device_sn,
                ))
            });
            if let Some(tick) = t.tick {
                let n_cold = tier_of.values().filter(|v| **v == "cold").count() as f64;
                let ratio = tick.num_microseconds().unwrap_or(0) as f64 / t.cold.num_microseconds().unwrap_or(1) as f64;
                let mut cap = (COLD_SPREAD * n_cold * ratio).ceil() as i64;
                due.retain(|i| {
                    // never-read cold inverters are not capped
                    if tier_of[&i.device_sn] == "cold" && synced.contains_key(&i.device_sn) {
                        if cap <= 0 {
                            return false;
                        }
                        cap -= 1;
                    }
                    true
                });
            }
            for tier in ["hot", "warm", "cold"] {
                totals.insert(format!("alarm_{tier}"), json!(tier_of.values().filter(|v| **v == tier).count()));
            }
            totals.insert("alarm_due".into(), json!(due.len()));
            due
        }
    };
    let (mut read, mut rows) = (0usize, 0usize);
    let mut failed: Vec<Value> = Vec::new();
    let mut limited = 0usize;
    for (idx, inv) in order.iter().enumerate() {
        let records = match client.max_alarms(&inv.device_sn, day, 100, 10).await {
            Ok(r) => r,
            Err(e) => {
                if let GrowattError::Api(a) = &e {
                    if a.code() == Some(RATE_LIMIT_CODE) {
                        limited += 1;
                        if limited >= MAX_RATE_LIMITED {
                            let left = order.len() - idx;
                            failed.push(failed_entry("rate limited", format!("{left} inverters left for the next run")));
                            tracing::warn!(target: "growatt_alarms", "alarm_data rate limited; {left} inverters wait for the next run");
                            break;
                        }
                    }
                }
                failed.push(failed_entry(inv.device_sn.clone(), growatt_text(&e)));
                opts.sleep(pause_s).await;
                continue;
            }
        };
        limited = 0;
        match store_inverter_day(pool, inv, day, &records, Utc::now()).await {
            Ok(n) => {
                rows += n;
                read += 1;
            }
            Err(e) => {
                let msg = e.py_str();
                tracing::error!(target: "growatt_alarms", "{} alarms {day} store failed: {msg}", inv.device_sn);
                failed.push(failed_entry(inv.device_sn.clone(), format!("store: {msg}")));
            }
        }
        opts.sleep(pause_s).await;
    }
    totals.insert("alarm_read".into(), json!(read));
    totals.insert("alarm_rows".into(), json!(rows));
    totals.insert("failed".into(), Value::Array(failed));
    Ok(Value::Object(totals))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alarm_fields_as_python() {
        let rows = alarm_rows(&[json!({
            "start_time": "2026-11-27 09:00:00.0", "end_time": "", "alarm_code": 202,
            "alarm_message": "PV isolation low", "fault_type": 0, "status": "1"
        })])
        .unwrap();
        let r = &rows[0];
        assert_eq!(r.start_time.map(|t| t.to_string()), Some("2026-11-27 09:00:00".into()));
        assert_eq!(r.end_time, None);
        assert_eq!(r.alarm_code.as_deref(), Some("202"));
        assert_eq!(r.fault_type, None); // 0 is falsy
        assert_eq!(r.status, Some(1));
        assert_eq!(code(&json!("")), None);
    }
}
