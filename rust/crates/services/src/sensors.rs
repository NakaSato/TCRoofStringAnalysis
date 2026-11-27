//! Fleet list of Growatt weather sensors from the registry and stored history (DB only), ported
//! from backend/app/services/growatt_sensors.py (`list_sensors` and the helpers it uses).
//!
//! Online state (`lost`, last upload) is realtime and never stored, so this list carries only what
//! SQL knows; a sensor's status here is `not_synced` or `unknown`.
//!
//! TODO(Phase 3, live wave): `live_status`, `live_row`, `stale_history_flag`,
//! `overlay_live_status`, `visible_sensors`, `find_sensor`, `measured_for` and the `env_list`
//! sweep behind `/growatt/live/sensors/*` belong to the live services (memory / Redis only) and
//! are not ported yet.

#![allow(clippy::type_complexity)] // sqlx row tuples

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::alarms::plant_tz;
use crate::common::{isoformat_utc, py_round, Result};

/// Python `growatt_sensors.COVERAGE_START_H` / `COVERAGE_END_H` (plant-local, end exclusive)
pub const COVERAGE_START_H: u32 = 6;
pub const COVERAGE_END_H: u32 = 18;
/// Python `SLOT_MIN`
pub const SLOT_MIN: i64 = 5;
/// Python `MEASURED_LOOKBACK` (days)
const MEASURED_LOOKBACK_DAYS: i64 = 7;
/// Python `ENV_SYNC_JOBS`
const ENV_SYNC_JOB: &str = "history";
/// Python `PROBE_FIELDS`: probes that never read exactly 0 by day when working (wind left out)
const PROBE_FIELDS: [&str; 4] = ["irradiance_wm2", "module_temp_c", "ambient_temp_c", "humidity_pct"];
/// Python `PROBE_MIDDAY_H`
const PROBE_MIDDAY_H: (u32, u32) = (9, 15);
/// Python `PROBE_MIN_SLOTS`
const PROBE_MIN_SLOTS: usize = 24;
/// Python `ZERO_IRR_H`
const ZERO_IRR_H: (u32, u32) = (10, 15);
/// Python `ZERO_IRR_MIN_SLOTS`
const ZERO_IRR_MIN_SLOTS: usize = 12;
/// Python `growatt_weather.FIELDS`
pub const WX_FIELDS: [&str; 6] = ["irradiance_wm2", "ambient_temp_c", "module_temp_c", "humidity_pct", "wind_speed_ms", "wind_dir_deg"];

/// Python `FIELD_LABEL`
fn field_label(f: &str) -> &'static str {
    match f {
        "irradiance_wm2" => "Irradiance",
        "module_temp_c" => "Module temperature",
        "ambient_temp_c" => "Ambient temperature",
        _ => "Humidity",
    }
}

type Key = (String, i32);
/// `values[field][slot]` = the day's non-null readings in that 5-min slot
type Values = HashMap<&'static str, BTreeMap<NaiveDateTime, Vec<f64>>>;

/// Python `_key`
fn key(dl: &str, addr: i32) -> String {
    format!("{dl}:{addr}")
}

/// Python `_fmt`
fn fmt(ts: Option<NaiveDateTime>) -> Option<String> {
    ts.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// Python `_slot`: floor to the 5-minute slot
pub fn slot(ts: NaiveDateTime) -> NaiveDateTime {
    let m = ts.minute() - ts.minute() % SLOT_MIN as u32;
    ts.date().and_time(NaiveTime::from_hms_opt(ts.hour(), m, 0).expect("valid time"))
}

/// Python `_hm`
fn hm(ts: NaiveDateTime) -> String {
    ts.format("%H:%M").to_string()
}

/// Python `_span`
fn span(minutes: i64) -> String {
    if minutes < 60 {
        format!("{minutes} min")
    } else {
        format!("{} h {:02} min", minutes / 60, minutes % 60)
    }
}

fn at_hour(day: NaiveDate, h: u32) -> NaiveDateTime {
    day.and_hms_opt(h, 0, 0).expect("valid hour")
}

/// Plant-local now, naive (Python `datetime.now(PLANT_TZ).replace(tzinfo=None)`)
pub fn now_local() -> NaiveDateTime {
    Utc::now().with_timezone(&plant_tz()).naive_local()
}

/// Python `last_env_sync`: start (UTC) of the newest finished `history` run.
pub async fn last_env_sync(pool: &PgPool) -> Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar(
        "SELECT started_at FROM sync_runs WHERE job = $1 AND status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1",
    )
    .bind(ENV_SYNC_JOB)
    .fetch_optional(pool)
    .await?)
}

/// Python `coverage_until`: end (plant-local, exclusive) of the slots of `day` that can be judged.
pub fn coverage_until(day: NaiveDate, now_local: NaiveDateTime, synced_utc: Option<DateTime<Utc>>) -> Option<NaiveDateTime> {
    let start = at_hour(day, COVERAGE_START_H);
    let end = at_hour(day, COVERAGE_END_H);
    let cap = end.min(now_local);
    let synced = synced_utc?;
    let cap = cap.min(synced.with_timezone(&plant_tz()).naive_local());
    let cap = slot(cap);
    (cap > start).then_some(cap)
}

/// Python `sensor_status`: `not_synced` without any stored reading, else `unknown`.
fn sensor_status(last_reading_at: Option<NaiveDateTime>) -> &'static str {
    if last_reading_at.is_none() {
        "not_synced"
    } else {
        "unknown"
    }
}

/// Python `growatt_weather.measured_by_sensor`: fields that read non-zero at least once since
/// `since` (and before `until`), per sensor with stored readings in that window.
pub async fn measured_by_sensor(
    pool: &PgPool,
    since: NaiveDateTime,
    plant_ids: Option<&[i32]>,
    until: Option<NaiveDateTime>,
) -> Result<HashMap<Key, Vec<&'static str>>> {
    let aggs: Vec<String> = WX_FIELDS.iter().map(|f| format!("min(e.{f}), max(e.{f})")).collect();
    let sql = format!(
        "SELECT e.datalogger_sn, e.address, {} FROM growatt_env_readings e \
         JOIN growatt_env_sensors s ON s.datalogger_sn = e.datalogger_sn AND s.address = e.address \
         WHERE e.timestamp >= $1 AND ($2::int[] IS NULL OR s.plant_id = ANY($2)) \
         AND ($3::timestamp IS NULL OR e.timestamp < $3) \
         GROUP BY e.datalogger_sn, e.address",
        aggs.join(", ")
    );
    let rows = sqlx::query(&sql).bind(since).bind(plant_ids).bind(until).fetch_all(pool).await?;
    let mut out = HashMap::new();
    for r in rows {
        use sqlx::Row;
        let dl: String = r.try_get(0)?;
        let addr: i32 = r.try_get(1)?;
        let mut fields = Vec::new();
        for (i, f) in WX_FIELDS.iter().enumerate() {
            let lo: Option<f64> = r.try_get(2 + 2 * i)?;
            let hi: Option<f64> = r.try_get(3 + 2 * i)?;
            if lo.unwrap_or(0.0) != 0.0 || hi.unwrap_or(0.0) != 0.0 {
                fields.push(*f);
            }
        }
        out.insert((dl, addr), fields);
    }
    Ok(out)
}

/// Python `probe_flags`: `probe_missing` per probe that reported in the last 7 days but read 0
/// in every stored reading of the day's daylight (needs >= `PROBE_MIN_SLOTS` midday slots).
fn probe_flags(values: &Values, measured: Option<&Vec<&'static str>>, day_label: &str, day: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(measured) = measured else { return out };
    let (lo, hi) = PROBE_MIDDAY_H;
    let empty = BTreeMap::new();
    for f in PROBE_FIELDS {
        if !measured.contains(&f) {
            continue;
        }
        let slots = values.get(f).unwrap_or(&empty);
        let midday = slots.keys().filter(|t| lo <= t.hour() && t.hour() < hi).count();
        if midday < PROBE_MIN_SLOTS || slots.values().flatten().any(|v| *v != 0.0) {
            continue;
        }
        let (Some(first), Some(last)) = (slots.keys().next(), slots.keys().next_back()) else { continue };
        let to = *last + Duration::minutes(SLOT_MIN);
        out.push(json!({
            "code": "probe_missing",
            "field": f,
            "params": {"slots": slots.len(), "day": day, "from": hm(*first), "to": hm(to)},
            "reason": format!(
                "{} read 0 in all {} stored slots {} ({}–{}) but reported in the last 7 days: probe fault or disconnected",
                field_label(f),
                slots.len(),
                day_label,
                hm(*first),
                hm(to)
            ),
        }));
    }
    out
}

/// Python `irradiance_zero_flag`: irradiance 0 in >= 1 h of 5-min slots between 10:00 and 15:00
/// in which the plant's inverters produced power.
fn irradiance_zero_flag(
    irr: Option<&BTreeMap<NaiveDateTime, Vec<f64>>>,
    measured: Option<&Vec<&'static str>>,
    producing: Option<&HashSet<NaiveDateTime>>,
) -> Option<Value> {
    if !measured?.contains(&"irradiance_wm2") {
        return None;
    }
    let (lo, hi) = ZERO_IRR_H;
    let zero: Vec<NaiveDateTime> = irr
        .map(|m| {
            m.iter()
                .filter(|(t, vs)| {
                    lo <= t.hour()
                        && t.hour() < hi
                        && !vs.is_empty()
                        && vs.iter().all(|v| *v == 0.0)
                        && producing.is_some_and(|p| p.contains(*t))
                })
                .map(|(t, _)| *t)
                .collect()
        })
        .unwrap_or_default();
    if zero.len() < ZERO_IRR_MIN_SLOTS {
        return None;
    }
    let minutes = zero.len() as i64 * SLOT_MIN;
    let from = hm(zero[0]);
    let to = hm(zero[zero.len() - 1] + Duration::minutes(SLOT_MIN));
    Some(json!({
        "code": "irradiance_zero_daylight",
        "field": "irradiance_wm2",
        "params": {
            "minutes": minutes,
            "from_h": format!("{lo:02}:00"),
            "to_h": format!("{hi:02}:00"),
            "from": from,
            "to": to,
        },
        "reason": format!(
            "Irradiance read 0 W/m² for {} between {lo:02}:00 and {hi:02}:00 ({from}–{to}) while the plant's inverters \
             produced power: shaded, dirty or faulty irradiance probe",
            span(minutes)
        ),
    }))
}

/// Python `producing_slots`: 5-min slots of `day` (10:00–15:00) in which any of each plant's
/// inverters stored pac > 0.
async fn producing_slots(pool: &PgPool, plant_ids: &[i32], day: NaiveDate) -> Result<HashMap<i32, HashSet<NaiveDateTime>>> {
    let mut out: HashMap<i32, HashSet<NaiveDateTime>> = HashMap::new();
    if plant_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(i32, NaiveDateTime)> = sqlx::query_as(
        "SELECT i.plant_id, r.timestamp FROM growatt_inverter_readings r \
         JOIN growatt_inverters i ON i.device_sn = r.device_sn \
         WHERE i.plant_id = ANY($1) AND r.timestamp >= $2 AND r.timestamp < $3 AND r.pac_w > 0",
    )
    .bind(plant_ids)
    .bind(at_hour(day, ZERO_IRR_H.0))
    .bind(at_hour(day, ZERO_IRR_H.1))
    .fetch_all(pool)
    .await?;
    for (pid, ts) in rows {
        out.entry(pid).or_default().insert(slot(ts));
    }
    Ok(out)
}

#[derive(sqlx::FromRow)]
struct SensorRow {
    datalogger_sn: String,
    address: i32,
    plant_id: i32,
    device_name: Option<String>,
    history_synced_until: Option<NaiveDateTime>,
    plant_name: String,
    phase: Option<i32>,
}

/// Python `growatt_sensors.list_sensors`: every registered weather sensor of the plants the user
/// may see (`allowed` None = all). `day` (default today, plant-local) is the day coverage and the
/// stored-data flags are judged on. `alarm_coverage_pct` is `SENSOR_ALARM_COVERAGE_PCT`.
pub async fn list_sensors(
    pool: &PgPool,
    allowed: Option<&HashSet<i64>>,
    now: NaiveDateTime,
    day: Option<NaiveDate>,
    alarm_coverage_pct: f64,
) -> Result<Value> {
    let real_today = now.date();
    let today = day.unwrap_or(real_today);
    let is_today = today == real_today;
    let day_end = now.min(at_hour(today + Duration::days(1), 0));

    let plant_filter: Option<Vec<i32>> = allowed.map(|a| a.iter().filter_map(|p| i32::try_from(*p).ok()).collect());
    let pf = plant_filter.as_deref();
    let rows: Vec<SensorRow> = sqlx::query_as(
        "SELECT s.datalogger_sn, s.address, s.plant_id, s.device_name, s.history_synced_until, \
                p.name AS plant_name, p.phase \
         FROM growatt_env_sensors s JOIN growatt_plants p ON p.plant_id = s.plant_id \
         WHERE ($1::int[] IS NULL OR s.plant_id = ANY($1)) \
         ORDER BY p.name, s.datalogger_sn, s.address",
    )
    .bind(pf)
    .fetch_all(pool)
    .await?;

    // newest stored reading: `history_synced_until` is the stored max, so an exact key lookup
    let last_sql = format!(
        "SELECT e.datalogger_sn, e.address, {} FROM growatt_env_readings e \
         JOIN growatt_env_sensors s ON s.datalogger_sn = e.datalogger_sn AND s.address = e.address \
              AND s.history_synced_until = e.timestamp \
         WHERE ($1::int[] IS NULL OR s.plant_id = ANY($1))",
        WX_FIELDS.iter().map(|f| format!("e.{f}")).collect::<Vec<_>>().join(", ")
    );
    let mut last: HashMap<Key, Vec<Option<f64>>> = HashMap::new();
    for r in sqlx::query(&last_sql).bind(pf).fetch_all(pool).await? {
        use sqlx::Row;
        let vals = (0..WX_FIELDS.len()).map(|i| r.try_get::<Option<f64>, _>(2 + i)).collect::<std::result::Result<Vec<_>, _>>()?;
        last.insert((r.try_get(0)?, r.try_get(1)?), vals);
    }

    let measured = measured_by_sensor(pool, now - Duration::days(MEASURED_LOOKBACK_DAYS), pf, None).await?;
    // flags judge a past day by the probes reporting in the week up to that day, not later
    let measured_then_own;
    let measured_then = if is_today {
        &measured
    } else {
        measured_then_own = measured_by_sensor(pool, day_end - Duration::days(MEASURED_LOOKBACK_DAYS), pf, Some(day_end)).await?;
        &measured_then_own
    };

    let synced = last_env_sync(pool).await?;
    let until = coverage_until(today, now, synced);
    let start = at_hour(today, COVERAGE_START_H);
    let expected = until.map(|u| (u - start).num_seconds() / (SLOT_MIN * 60)).unwrap_or(0);

    let mut seen: HashMap<Key, BTreeSet<NaiveDateTime>> = HashMap::new();
    let mut values: HashMap<Key, Values> = HashMap::new();
    let day_rows: Vec<(String, i32, NaiveDateTime, Option<f64>, Option<f64>, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT e.datalogger_sn, e.address, e.timestamp, e.irradiance_wm2, e.module_temp_c, e.ambient_temp_c, e.humidity_pct \
         FROM growatt_env_readings e \
         JOIN growatt_env_sensors s ON s.datalogger_sn = e.datalogger_sn AND s.address = e.address \
         WHERE e.timestamp >= $1 AND e.timestamp < $2 AND ($3::int[] IS NULL OR s.plant_id = ANY($3))",
    )
    .bind(start)
    .bind(at_hour(today, COVERAGE_END_H))
    .bind(pf)
    .fetch_all(pool)
    .await?;
    for (dl, addr, ts, a, b, c, d) in day_rows {
        let sl = slot(ts);
        let k = (dl, addr);
        if until.is_some_and(|u| ts < u) {
            seen.entry(k.clone()).or_default().insert(sl);
        }
        let per = values.entry(k).or_default();
        for (f, v) in PROBE_FIELDS.iter().zip([a, b, c, d]) {
            if let Some(v) = v {
                per.entry(f).or_default().entry(sl).or_default().push(v);
            }
        }
    }

    // zero-irradiance candidates first, so inverter readings are read only for their plants
    let zero_irr_plants: Vec<i32> = rows
        .iter()
        .filter(|s| {
            values
                .get(&(s.datalogger_sn.clone(), s.address))
                .and_then(|v| v.get("irradiance_wm2"))
                .map(|m| {
                    m.iter()
                        .filter(|(t, vs)| ZERO_IRR_H.0 <= t.hour() && t.hour() < ZERO_IRR_H.1 && vs.iter().all(|v| *v == 0.0))
                        .count()
                })
                .unwrap_or(0)
                >= ZERO_IRR_MIN_SLOTS
        })
        .map(|s| s.plant_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let producing = producing_slots(pool, &zero_irr_plants, today).await?;

    let day_iso = today.format("%Y-%m-%d").to_string();
    let label = if is_today { "today".to_owned() } else { format!("on {day_iso}") };
    let empty = Values::new();
    let mut sensors = Vec::with_capacity(rows.len());
    for s in &rows {
        let k = (s.datalogger_sn.clone(), s.address);
        let fields = measured.get(&k);
        let vals = values.get(&k).unwrap_or(&empty);
        let cov = (expected != 0).then(|| py_round(100.0 * seen.get(&k).map_or(0, |x| x.len()) as f64 / expected as f64, 1));
        let then = measured_then.get(&k);
        let mut flags = probe_flags(vals, then, &label, (!is_today).then_some(day_iso.as_str()));
        if !flags.iter().any(|f| f["field"] == "irradiance_wm2") {
            if let Some(zf) = irradiance_zero_flag(vals.get("irradiance_wm2"), then, producing.get(&s.plant_id)) {
                flags.push(zf);
            }
        }
        let last_v = last.get(&k).map(|rec| {
            let m: serde_json::Map<String, Value> = WX_FIELDS
                .iter()
                .zip(rec)
                .map(|(f, v)| {
                    let keep = fields.is_none_or(|fs| fs.contains(f));
                    ((*f).to_owned(), if keep { json!(v) } else { Value::Null })
                })
                .collect();
            Value::Object(m)
        });
        sensors.push(json!({
            "key": key(&s.datalogger_sn, s.address),
            "datalogger_sn": s.datalogger_sn,
            "address": s.address,
            "device_name": s.device_name,
            "plant_id": s.plant_id,
            "plant_name": s.plant_name,
            "phase": s.phase,
            "status": sensor_status(s.history_synced_until),
            "last_reading_at": fmt(s.history_synced_until),
            // null = no stored reading in the last 7 days: which probes report is unknown
            "measured": fields,
            // probes that read only 0 for the week were not measured: null, never 0
            "last": last_v,
            "coverage_pct": cov,
            "coverage_today_pct": if is_today { cov } else { None },
            "flags": flags,
        }));
    }
    Ok(json!({
        "meta": {
            "source": "db",
            "day": day_iso,
            "coverage_window": {
                "start": format!("{COVERAGE_START_H:02}:00"),
                "until": until.map(|u| u.format("%H:%M").to_string()),
            },
            "synced_at": synced.map(isoformat_utc),
            "is_today": is_today,
            // Active Alarm, past day: below this stored coverage a sensor counts as a data gap
            "alarm_coverage_pct": alarm_coverage_pct,
        },
        "sensors": sensors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn dt(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 27).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn coverage_until_caps_at_sync_and_slot() {
        let day = dt(0, 0).date();
        // synced 03:12 UTC = 10:12 local; now 11:00 → 10:10
        let synced = Utc.with_ymd_and_hms(2026, 11, 27, 3, 12, 30).unwrap();
        assert_eq!(coverage_until(day, dt(11, 0), Some(synced)), Some(dt(10, 10)));
        assert_eq!(coverage_until(day, dt(11, 0), None), None);
        assert_eq!(coverage_until(day, dt(6, 3), Some(synced)), None);
    }

    #[test]
    fn spans() {
        assert_eq!(span(55), "55 min");
        assert_eq!(span(65), "1 h 05 min");
    }
}
