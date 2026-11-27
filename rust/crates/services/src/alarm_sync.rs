//! The worker side of the Growatt alarm / fault log (Python backend/app/services/growatt_alarms.py:
//! `Tiers`, `inverter_tiers`, `_alarm_rows`, `store_inverter_day`, `sync_alarms`; and
//! growatt_sync/common.py `_inverters_query`). The read side (`alarm_day`, `next_run_at`) is
//! [`crate::alarms`]; the prune is [`crate::retention::prune_alarms`].
//!
//! `device/max/alarm_data` answers one inverter-day per call. The `alarms` job reads today only for
//! the inverters due by tier: **hot** (an alarm still reported at the last read, or the newest
//! stored `max_data` status is fault) every WORKER_ALARMS_HOT_MIN, **warm** (alarms today, all
//! closed) every _WARM_MIN, **cold** (no alarms today) every _COLD_MIN; `alarms_yesterday` reads the
//! previous day in full. Each successful read replaces that inverter-day's rows and stamps
//! `growatt_alarm_syncs`; a failed read keeps what was stored. Alarm times are Growatt's own
//! (plant-local, naive): source-timestamped history, not realtime values.

#![allow(clippy::type_complexity)] // sqlx row tuples

use std::collections::{HashMap, HashSet};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::py;
use tcroof_clients::growatt::GrowattClient;

use crate::alarms::plant_tz;
use crate::common::{Result, ServiceError};

/// Python `growatt_alarms.MAX_RATE_LIMITED`: consecutive 10012 answers that end an account's sweep
pub const MAX_RATE_LIMITED: usize = 3;
/// Python `growatt_alarms.FAULT_STATUS`: `max_data` status of a MAX inverter in fault
pub const FAULT_STATUS: i32 = 3;
/// Python `growatt_alarms.ONGOING_GAP`: an alarm reported within this of the last read is ongoing
pub fn ongoing_gap() -> Duration {
    Duration::minutes(10)
}
/// Python `growatt_alarms.COLD_SPREAD`
pub const COLD_SPREAD: f64 = 1.5;
/// Python `sync_alarms(pause_s=0.3)`: pause after each inverter
pub const PAUSE: StdDuration = StdDuration::from_millis(300);
/// Python `GrowattClient.max_alarms` defaults (`perpage`, `max_pages`)
const PERPAGE: u32 = 100;
const MAX_PAGES: u32 = 10;

/// Python `growatt_alarms.Tiers`: how often an inverter's alarm log of today is re-read.
#[derive(Debug, Clone, Copy)]
pub struct Tiers {
    pub hot: Duration,
    pub warm: Duration,
    pub cold: Duration,
    /// the job's tick: caps the cold reads per run at COLD_SPREAD x their fair share
    pub tick: Option<Duration>,
}

impl Tiers {
    /// Python `jobs.alarm_tiers()` (WORKER_ALARMS_HOT_MIN / _WARM_MIN / _COLD_MIN / _TICK_MIN).
    pub fn from_minutes(hot: i64, warm: i64, cold: i64, tick: i64) -> Tiers {
        Tiers {
            hot: Duration::minutes(hot),
            warm: Duration::minutes(warm),
            cold: Duration::minutes(cold),
            tick: Some(Duration::minutes(tick)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Tier {
    Hot,
    Warm,
    Cold,
}

impl Tier {
    pub fn name(self) -> &'static str {
        match self {
            Tier::Hot => "hot",
            Tier::Warm => "warm",
            Tier::Cold => "cold",
        }
    }
}

/// The two columns of a `GrowattInverter` the sync uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlarmInverter {
    pub device_sn: String,
    pub plant_id: i32,
}

/// A failure of `sync_alarms` that ends the account (Python raises it out of `sync_alarms`).
#[derive(Debug, thiserror::Error)]
pub enum AlarmSyncError {
    /// Python `ZeroDivisionError` (`tiers.tick / tiers.cold` with WORKER_ALARMS_COLD_MIN 0)
    #[error("division by zero")]
    ZeroDivision,
    #[error(transparent)]
    Service(#[from] ServiceError),
}

impl From<sqlx::Error> for AlarmSyncError {
    fn from(e: sqlx::Error) -> Self {
        AlarmSyncError::Service(ServiceError::Db(e))
    }
}

/// Python `growatt_sync.common._inverters_query(phase, include_untagged)`: installed inverters
/// ordered by plant (and serial); one phase's plants when `phase` is given, plus the plants with
/// no phase yet when `include_untagged`. Inverters marked not installed are never synced.
pub async fn inverters_query(pool: &PgPool, phase: Option<i32>, include_untagged: bool) -> Result<Vec<AlarmInverter>> {
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "SELECT i.device_sn, i.plant_id FROM growatt_inverters i \
         JOIN growatt_plants p ON p.plant_id = i.plant_id \
         WHERE i.not_installed_at IS NULL \
           AND ($1::int IS NULL OR p.phase = $1 OR ($2 AND p.phase IS NULL)) \
         ORDER BY i.plant_id, i.device_sn",
    )
    .bind(phase)
    .bind(include_untagged)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(device_sn, plant_id)| AlarmInverter { device_sn, plant_id }).collect())
}

/// Python `growatt_alarms._parse_time`: `strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S")`, `None` for a
/// falsy value or text that does not parse (a non-text value never parses).
fn parse_time(v: &Value) -> Option<NaiveDateTime> {
    if !py::truthy(v) {
        return None;
    }
    py::strptime(py::head(&py::str_of(v), 19), py::TimeFormat::Seconds)
}

/// Python `growatt_alarms._code`
fn code(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        other => Some(py::str_of(other)),
    }
}

/// Python `(str(v)[:n] or None) if v else None`
fn text(v: &Value, n: usize) -> Option<String> {
    if !py::truthy(v) {
        return None;
    }
    let s = py::str_of(v);
    let s = py::head(&s, n);
    (!s.is_empty()).then(|| s.to_owned())
}

/// One `growatt_alarms` row as `_alarm_rows` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct AlarmRow {
    pub start_time: Option<NaiveDateTime>,
    pub end_time: Option<NaiveDateTime>,
    pub alarm_code: Option<String>,
    pub alarm_message: Option<String>,
    pub fault_type: Option<String>,
    pub status: Option<i64>,
}

/// Python `growatt_alarms._alarm_rows`. `Err` is the `AttributeError` text Python raises for a
/// record that is not a dict (`a.get`).
pub fn alarm_rows(records: &[Value]) -> std::result::Result<Vec<AlarmRow>, String> {
    records
        .iter()
        .map(|a| {
            let Value::Object(m) = a else {
                return Err(format!("'{}' object has no attribute 'get'", py::type_name(a)));
            };
            let g = |k: &str| m.get(k).unwrap_or(&Value::Null);
            Ok(AlarmRow {
                start_time: parse_time(g("start_time")),
                end_time: parse_time(g("end_time")),
                alarm_code: code(g("alarm_code")),
                alarm_message: text(g("alarm_message"), 255),
                fault_type: text(g("fault_type"), 32),
                status: py::int(g("status")).ok(),
            })
        })
        .collect()
}

/// Python `growatt_alarms.store_inverter_day`: replace one inverter-day's alarms with a complete
/// read and stamp it synced (one transaction). Rows stored; `Err` is the failure's text.
pub async fn store_inverter_day(
    pool: &PgPool,
    inv: &AlarmInverter,
    day: NaiveDate,
    records: &[Value],
    now: DateTime<Utc>,
) -> std::result::Result<i64, String> {
    let rows = alarm_rows(records)?;
    let run = async {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM growatt_alarms WHERE device_sn = $1 AND day = $2")
            .bind(&inv.device_sn)
            .bind(day)
            .execute(&mut *tx)
            .await?;
        for r in &rows {
            sqlx::query(
                "INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, end_time, alarm_code, \
                 alarm_message, fault_type, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
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
            "INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (device_sn, day) DO UPDATE \
             SET plant_id = EXCLUDED.plant_id, synced_at = EXCLUDED.synced_at, alarm_count = EXCLUDED.alarm_count",
        )
        .bind(&inv.device_sn)
        .bind(day)
        .bind(inv.plant_id)
        .bind(now)
        .bind(rows.len() as i32)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(())
    };
    run.await.map_err(|e| e.to_string())?;
    Ok(rows.len() as i64)
}

/// Python `growatt_alarms.inverter_tiers`: `hot` / `warm` / `cold` per serial for `day`, from SQL only.
pub async fn inverter_tiers(pool: &PgPool, day: NaiveDate, sns: &[String]) -> Result<HashMap<String, Tier>> {
    if sns.is_empty() {
        return Ok(HashMap::new());
    }
    // ongoing: no end time, or last reported within ONGOING_GAP of the inverter's last read
    let read_at: HashMap<String, NaiveDateTime> = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        "SELECT device_sn, synced_at FROM growatt_alarm_syncs WHERE day = $1 AND device_sn = ANY($2)",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(sn, at)| (sn, at.with_timezone(&plant_tz()).naive_local()))
    .collect();
    let mut open: HashSet<String> = HashSet::new();
    let agg: Vec<(String, Option<NaiveDateTime>, Option<NaiveDateTime>, i64)> = sqlx::query_as(
        "SELECT device_sn, max(start_time), max(end_time), count(*) FILTER (WHERE end_time IS NULL) \
         FROM growatt_alarms WHERE day = $1 AND device_sn = ANY($2) GROUP BY device_sn",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?;
    for (sn, last_start, last_end, no_end) in agg {
        let latest = [last_start, last_end].into_iter().flatten().max();
        let at = read_at.get(&sn);
        if no_end != 0 || matches!((latest, at), (Some(l), Some(a)) if l >= *a - ongoing_gap()) {
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
    // newest stored reading of the day per inverter (plant-local timestamps): fault = hot
    let start = day.and_hms_opt(0, 0, 0).expect("midnight");
    let faulted: HashSet<String> = sqlx::query_scalar(
        "SELECT r.device_sn FROM growatt_inverter_readings r \
         JOIN (SELECT device_sn, max(timestamp) AS ts FROM growatt_inverter_readings \
               WHERE timestamp >= $1 AND timestamp < $2 AND device_sn = ANY($3) GROUP BY device_sn) n \
           ON n.device_sn = r.device_sn AND n.ts = r.timestamp \
         WHERE r.status = $4",
    )
    .bind(start)
    .bind(start + Duration::days(1))
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
                Tier::Hot
            } else if with_alarms.contains(sn) {
                Tier::Warm
            } else {
                Tier::Cold
            };
            (sn.clone(), t)
        })
        .collect())
}

/// Python `growatt_alarms.sync_alarms`: read `day`'s alarm log of `inverters` (one account),
/// never-read and oldest-read first. With `tiers`, only the inverters whose tier interval has
/// passed since their last read (never-read ones always) are read, hot ones first.
///
/// Detail: `alarm_inverters`, `alarm_read`, `alarm_rows`, `failed` (`[serial, error]` pairs), and
/// with tiers `alarm_hot` / `alarm_warm` / `alarm_cold` / `alarm_due`.
pub async fn sync_alarms(
    pool: &PgPool,
    client: &GrowattClient,
    day: NaiveDate,
    inverters: &[AlarmInverter],
    pause: StdDuration,
    tiers: Option<Tiers>,
    now: Option<DateTime<Utc>>,
) -> std::result::Result<Map<String, Value>, AlarmSyncError> {
    let synced: HashMap<String, DateTime<Utc>> =
        sqlx::query_as::<_, (String, DateTime<Utc>)>("SELECT device_sn, synced_at FROM growatt_alarm_syncs WHERE day = $1")
            .bind(day)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    // None = never read (Python: datetime.min), sorts first
    let last = |i: &AlarmInverter| synced.get(&i.device_sn).copied();

    let mut totals = Map::new();
    totals.insert("alarm_inverters".into(), json!(inverters.len()));
    let mut failed: Vec<Value> = Vec::new();
    let order: Vec<&AlarmInverter> = match tiers {
        None => {
            let mut o: Vec<&AlarmInverter> = inverters.iter().collect();
            o.sort_by(|a, b| (last(a), a.plant_id, &a.device_sn).cmp(&(last(b), b.plant_id, &b.device_sn)));
            o
        }
        Some(tiers) => {
            let now = now.unwrap_or_else(Utc::now);
            let sns: Vec<String> = inverters.iter().map(|i| i.device_sn.clone()).collect();
            let tier_of = inverter_tiers(pool, day, &sns).await?;
            let every = |t: Tier| match t {
                Tier::Hot => tiers.hot,
                Tier::Warm => tiers.warm,
                Tier::Cold => tiers.cold,
            };
            // a little slack, so an interval equal to the tick does not slip a tick on run-time jitter
            let slack = Duration::minutes(1);
            let tier = |i: &AlarmInverter| tier_of[&i.device_sn];
            let mut order: Vec<&AlarmInverter> = inverters
                .iter()
                .filter(|i| match last(i) {
                    None => true,
                    Some(at) => now - at + slack >= every(tier(i)),
                })
                .collect();
            order.sort_by(|a, b| {
                (tier(a), last(a), a.plant_id, &a.device_sn).cmp(&(tier(b), last(b), b.plant_id, &b.device_sn))
            });
            if let Some(tick) = tiers.tick.filter(|t| !t.is_zero()) {
                let n_cold = tier_of.values().filter(|t| **t == Tier::Cold).count();
                let cold_us = tiers.cold.num_microseconds().unwrap_or(i64::MAX);
                if cold_us == 0 {
                    return Err(AlarmSyncError::ZeroDivision);
                }
                let ratio = tick.num_microseconds().unwrap_or(i64::MAX) as f64 / cold_us as f64;
                let mut cap = (COLD_SPREAD * n_cold as f64 * ratio).ceil() as i64;
                let mut kept = Vec::with_capacity(order.len());
                for i in order {
                    // never-read cold inverters are not capped
                    if tier(i) == Tier::Cold && synced.contains_key(&i.device_sn) {
                        if cap <= 0 {
                            continue;
                        }
                        cap -= 1;
                    }
                    kept.push(i);
                }
                order = kept;
            }
            for t in [Tier::Hot, Tier::Warm, Tier::Cold] {
                // flat ints, so the per-account totals add up
                totals.insert(format!("alarm_{}", t.name()), json!(tier_of.values().filter(|v| **v == t).count()));
            }
            totals.insert("alarm_due".into(), json!(order.len()));
            order
        }
    };
    let (mut read, mut stored) = (0i64, 0i64);
    let mut limited = 0usize;
    for (idx, inv) in order.iter().enumerate() {
        let records = match client.max_alarms(&inv.device_sn, day, PERPAGE, MAX_PAGES).await {
            Ok(r) => r,
            Err(e) => {
                if e.is_rate_limited() {
                    limited += 1;
                    if limited >= MAX_RATE_LIMITED {
                        let left = order.len() - idx;
                        failed.push(json!(["rate limited", format!("{left} inverters left for the next run")]));
                        tracing::warn!(target: "growatt_alarms", "alarm_data rate limited; {} inverters wait for the next run", left);
                        break;
                    }
                }
                // network trouble etc. keeps going too
                failed.push(json!([inv.device_sn, e.to_string()]));
                tokio::time::sleep(pause).await;
                continue;
            }
        };
        limited = 0;
        match store_inverter_day(pool, inv, day, &records, Utc::now()).await {
            Ok(n) => {
                stored += n;
                read += 1;
            }
            Err(e) => {
                failed.push(json!([inv.device_sn, format!("store: {e}")]));
                tracing::error!(target: "growatt_alarms", "{} alarms {} store failed: {}", inv.device_sn, day, e);
            }
        }
        tokio::time::sleep(pause).await;
    }
    totals.insert("alarm_read".into(), json!(read));
    totals.insert("alarm_rows".into(), json!(stored));
    totals.insert("failed".into(), Value::Array(failed));
    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_parse_like_python() {
        let recs = vec![
            json!({"start_time": "2026-11-27 09:00:00.5", "end_time": "", "alarm_code": 202,
                   "alarm_message": "PV isolation low", "fault_type": 3, "status": "1"}),
            json!({"start_time": "2026-11-27T09:00:00", "end_time": "2026-2-30 1:2:3", "alarm_code": "",
                   "alarm_message": 0, "fault_type": "", "status": "1.0"}),
            json!({"start_time": "2026-1-2  3:04:05", "alarm_code": 1.5, "status": 2.9}),
        ];
        let rows = alarm_rows(&recs).unwrap();
        let t = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok();
        assert_eq!(rows[0].start_time, t("2026-11-27 09:00:00"));
        assert_eq!(rows[0].end_time, None);
        assert_eq!(rows[0].alarm_code.as_deref(), Some("202"));
        assert_eq!(rows[0].fault_type.as_deref(), Some("3"));
        assert_eq!(rows[0].status, Some(1));
        assert_eq!(rows[1].start_time, None);
        assert_eq!(rows[1].end_time, None);
        assert_eq!(rows[1].alarm_code, None);
        assert_eq!(rows[1].alarm_message, None);
        assert_eq!(rows[1].fault_type, None);
        assert_eq!(rows[1].status, None);
        assert_eq!(rows[2].start_time, t("2026-01-02 03:04:05"));
        assert_eq!(rows[2].alarm_code.as_deref(), Some("1.5"));
        assert_eq!(rows[2].status, Some(2));
        assert_eq!(alarm_rows(&[json!("x")]).unwrap_err(), "'str' object has no attribute 'get'");
    }

    #[test]
    fn long_text_is_cut_by_characters() {
        let msg: String = "ก".repeat(300);
        let rows = alarm_rows(&[json!({"alarm_message": msg, "fault_type": "x".repeat(40)})]).unwrap();
        assert_eq!(rows[0].alarm_message.as_ref().unwrap().chars().count(), 255);
        assert_eq!(rows[0].fault_type.as_ref().unwrap().len(), 32);
    }

    #[test]
    fn tiers_sort_hot_first() {
        assert!(Tier::Hot < Tier::Warm && Tier::Warm < Tier::Cold);
    }
}
