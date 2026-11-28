//! Port of backend/app/services/check_slots.py: the PWA report check slots "09" / "13" / "17",
//! each a snapshot CHECK_OFFSET_MIN before its hour (08:50 for "09") built from stored,
//! source-timestamped history only (never realtime values), frozen in `pwa_check_slots` at its
//! first build so a slot the sheet has shown never changes. See the Python module docstring for
//! every field; the comments here name the Python function each piece ports.
//!
//! Also ported here (Python `daily_checks`): `left_out`, `inverter_label`, `_sort_key`, and
//! (Python `google_weather`) `slot_current`, Google's current conditions at the slot time for the
//! freezing publish (modelled; memory only until frozen into the slot).
//!
//! Queries that Python issues without ORDER BY are issued the same way here: the order of rows
//! with equal sort keys (stable sorts below) is then the table's, as in Python.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::types::Json;
use sqlx::PgPool;
use tcroof_clients::google_weather::{Current, GoogleWeatherClient};

use crate::common::{py_round, py_sum, Inverter, Plant, Result, INVERTER_COLS};
use crate::google_weather_live::{record_calls, remaining, API_CURRENT};
use crate::google_weather_stored::{cell_of, is_raining, plant_cell, GoogleWeatherConfig};

/// Python `CHECK_HOURS`
pub const CHECK_HOURS: [u32; 3] = [9, 13, 17];
/// Python `FAULT_STATUS` (Growatt MAX inverter status 3)
pub const FAULT_STATUS: i32 = 3;
/// Python `READY_HISTORY`
const READY_HISTORY: [&str; 2] = ["ok", "partial"];

/// Python `WINDOW`: a slot takes the latest reading in [slot − WINDOW, slot]
fn window() -> Duration {
    Duration::minutes(15)
}

/// Python `PULL_SLACK`: the worker starts a scheduled job within its 60 s tick
fn pull_slack() -> Duration {
    Duration::minutes(1)
}

/// Python `ONGOING_GAP`
fn ongoing_gap() -> Duration {
    Duration::minutes(10)
}

/// The settings check slots read (Python `settings.check_offset_min`, `pwa_*`, Google Weather).
#[derive(Debug, Clone)]
pub struct CheckConfig {
    /// `CHECK_OFFSET_MIN` (10)
    pub offset_min: i64,
    /// `PWA_HISTORY_LEAD_MIN` (3)
    pub history_lead_min: i64,
    /// `PWA_FAULT_LOOKBACK_MIN` (60)
    pub fault_lookback_min: i64,
    /// `settings.pwa_ignored_warn_codes()` of `PWA_IGNORE_WARN_CODES` ("1")
    pub ignored_warn_codes: HashSet<i64>,
    /// Google Weather cells and daytime window
    pub google: GoogleWeatherConfig,
    /// `GOOGLE_WEATHER_API_KEY` (empty = no current conditions)
    pub google_api_key: String,
    /// `GOOGLE_WEATHER_BASE_URL`
    pub google_base_url: String,
    /// `GOOGLE_WEATHER_MONTHLY_BUDGET`
    pub google_monthly_budget: i64,
}

impl Default for CheckConfig {
    fn default() -> Self {
        CheckConfig {
            offset_min: 10,
            history_lead_min: 3,
            fault_lookback_min: 60,
            ignored_warn_codes: parse_warn_codes("1"),
            google: GoogleWeatherConfig::default(),
            google_api_key: String::new(),
            google_base_url: tcroof_clients::google_weather::DEFAULT_BASE_URL.into(),
            google_monthly_budget: 30000,
        }
    }
}

/// Python `Settings.pwa_ignored_warn_codes`: the comma-separated digits of `PWA_IGNORE_WARN_CODES`
pub fn parse_warn_codes(s: &str) -> HashSet<i64> {
    s.split(',').map(str::trim).filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())).filter_map(|p| p.parse().ok()).collect()
}

/// Python `hh`
pub fn hh(hour: u32) -> String {
    format!("{hour:02}")
}

/// Python `slot_time`: naive plant-local snapshot time of check `hour` on `day` (08:50 for 9).
pub fn slot_time(cfg: &CheckConfig, day: NaiveDate, hour: u32) -> NaiveDateTime {
    day.and_time(NaiveTime::from_hms_opt(hour, 0, 0).expect("check hour")) - Duration::minutes(cfg.offset_min)
}

/// Python `now_local`: plant-local (Asia/Bangkok, UTC+7) now, naive.
pub fn now_local() -> NaiveDateTime {
    (Utc::now() + Duration::hours(7)).naive_utc()
}

// --------------------------------------------------------------------------- readiness

/// Python `history_covers`: a `history` run that started at the pre-check pull or later has
/// finished (ok / partial).
pub async fn history_covers(pool: &PgPool, cfg: &CheckConfig, day: NaiveDate, hour: u32) -> Result<bool> {
    let since_local = slot_time(cfg, day, hour) - Duration::minutes(cfg.history_lead_min) - pull_slack();
    let since: DateTime<Utc> = (since_local - Duration::hours(7)).and_utc();
    let hit: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM sync_runs WHERE job = 'history' AND status = ANY($1) AND finished_at IS NOT NULL AND started_at >= $2 LIMIT 1",
    )
    .bind(&READY_HISTORY[..])
    .bind(since)
    .fetch_optional(pool)
    .await?;
    Ok(hit.is_some())
}

/// Python `slot_ready`: whether check `hour` of `day` may be built now (`now_local` naive).
pub async fn slot_ready(pool: &PgPool, cfg: &CheckConfig, day: NaiveDate, hour: u32, now_local: NaiveDateTime) -> Result<bool> {
    if now_local < slot_time(cfg, day, hour) {
        return Ok(false);
    }
    if day < now_local.date() {
        return Ok(true);
    }
    history_covers(pool, cfg, day, hour).await
}

/// Python `ready_hours`
pub async fn ready_hours(pool: &PgPool, cfg: &CheckConfig, day: NaiveDate, now_local: NaiveDateTime) -> Result<Vec<u32>> {
    let mut out = Vec::new();
    for h in CHECK_HOURS {
        if slot_ready(pool, cfg, day, h, now_local).await? {
            out.push(h);
        }
    }
    Ok(out)
}

// --------------------------------------------------------------------------- inverter names (daily_checks)

fn re_replaced() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\bold\b|เก่า").expect("regex"))
}

fn re_inv_no() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)inv(?:erter)?[\s.]*(?:no\.?)?\s*(\d+)").expect("regex"))
}

fn re_paren_no() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\s*\(\s*(\d+)\s*\)").expect("regex"))
}

/// Python `int()` of a `\d+` match: ASCII and Thai digits (other scripts' digits: None)
fn digits_value(s: &str) -> Option<u128> {
    let mut n: u128 = 0;
    for c in s.chars() {
        let d = match c {
            '0'..='9' => c as u32 - '0' as u32,
            '\u{0E50}'..='\u{0E59}' => c as u32 - 0x0E50,
            _ => c.to_digit(10)?,
        };
        n = n.checked_mul(10)?.checked_add(u128::from(d))?;
    }
    Some(n)
}

/// Python `daily_checks.is_replaced`: named as replaced in Growatt ("INV 1 old", "(เก่า)")
pub fn is_replaced(inv: &Inverter) -> bool {
    inv.alias.as_deref().is_some_and(|a| !a.is_empty() && re_replaced().is_match(a))
}

/// Python `daily_checks.left_out`: named as replaced, or marked not installed.
pub fn left_out(inv: &Inverter) -> bool {
    is_replaced(inv) || inv.not_installed_at.is_some()
}

/// Python `daily_checks.inverter_label`: "INV3" from the inverter number in the Growatt alias;
/// an alias that is the serial is no number: "INV1" for the plant's only inverter, else the serial.
pub fn inverter_label(inv: &Inverter, sole: bool) -> String {
    let alias = inv.alias.as_deref().unwrap_or("").trim();
    if !alias.is_empty() && alias.to_uppercase() != inv.device_sn.to_uppercase() {
        let m = re_inv_no().captures(alias).or_else(|| re_paren_no().captures(alias));
        if let Some(n) = m.and_then(|c| digits_value(c.get(1)?.as_str())) {
            return format!("INV{n}");
        }
    }
    if sole {
        "INV1".into()
    } else {
        inv.device_sn.clone()
    }
}

/// Python `daily_checks._sort_key`: (n, "") for "INVn", else (10**6, label)
pub fn sort_key(label: &str) -> (u128, String) {
    if let Some(rest) = label.strip_prefix("INV") {
        if !rest.is_empty() && rest.chars().all(|c| c.is_numeric()) {
            if let Some(n) = digits_value(rest) {
                return (n, String::new());
            }
        }
    }
    (1_000_000, label.to_owned())
}

/// Python `_labels`: {device_sn: label} of the plant's inverters not left out, in table order
/// (Python's query has no ORDER BY).
pub async fn labels(pool: &PgPool, plant_id: i32) -> Result<Vec<(String, String)>> {
    let invs: Vec<Inverter> = sqlx::query_as(&format!("SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1"))
        .bind(plant_id)
        .fetch_all(pool)
        .await?;
    let invs: Vec<&Inverter> = invs.iter().filter(|i| !left_out(i)).collect();
    let sole = invs.len() == 1;
    let mut out: Vec<(String, String)> = Vec::new();
    for i in invs {
        let l = inverter_label(i, sole);
        match out.iter_mut().find(|(sn, _)| *sn == i.device_sn) {
            Some(e) => e.1 = l,
            None => out.push((i.device_sn.clone(), l)),
        }
    }
    Ok(out)
}

/// Python `has_inverters`
pub async fn has_inverters(pool: &PgPool, plant_id: i32) -> Result<bool> {
    Ok(!labels(pool, plant_id).await?.is_empty())
}

// --------------------------------------------------------------------------- one slot

/// Python `fault_since`: start of check `hour`'s fault look-back (07:50 for 9).
pub fn fault_since(cfg: &CheckConfig, day: NaiveDate, hour: u32) -> NaiveDateTime {
    slot_time(cfg, day, hour) - Duration::minutes(cfg.fault_lookback_min.max(0))
}

/// A row of `growatt_alarms` (the columns check slots read).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AlarmRow {
    pub device_sn: String,
    pub start_time: Option<NaiveDateTime>,
    pub end_time: Option<NaiveDateTime>,
    pub alarm_code: Option<String>,
    pub alarm_message: Option<String>,
    pub fault_type: Option<String>,
}

/// Python `_active`. With `since`: the record falls in [`since`, `t`]; without: active at `t`.
pub fn active(a: &AlarmRow, t: NaiveDateTime, read_at: Option<NaiveDateTime>, since: Option<NaiveDateTime>) -> bool {
    let Some(start) = a.start_time.filter(|s| *s <= t) else { return false };
    let Some(end) = a.end_time else { return true };
    if let Some(since) = since {
        return (if end > start { end } else { start }) >= since.min(t);
    }
    if end > start {
        return end >= t;
    }
    let reference = read_at.map_or(t, |r| t.min(r));
    start >= reference - ongoing_gap()
}

/// Python `str.strip() or None`
fn stripped(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Python `_item`: (code, message) of an alarm-log entry; None when it has neither.
fn item(a: &AlarmRow) -> Option<(Option<String>, Option<String>)> {
    let code = stripped(a.alarm_code.as_deref());
    let msg = stripped(a.alarm_message.as_deref());
    (code.is_some() || msg.is_some()).then_some((code, msg))
}

/// Python `_is_error`
fn is_error(a: &AlarmRow) -> bool {
    a.fault_type.as_deref().unwrap_or("").trim().to_lowercase() == "error"
}

/// Python `SKIP_ALARMS` membership (`"undown error"`)
fn is_skip(msg: &str) -> bool {
    msg.to_lowercase() == "undown error"
}

fn hm(t: NaiveDateTime) -> String {
    t.format("%H:%M").to_string()
}

fn hour_of(t: NaiveDateTime) -> NaiveDateTime {
    t.date().and_time(NaiveTime::from_hms_opt(t.hour(), 0, 0).expect("hour"))
}

/// Python `_last_seen`: {device_sn: its latest stored reading of `day` earlier than `before`}.
async fn last_seen(pool: &PgPool, sns: &[String], day: NaiveDate, before: NaiveDateTime) -> Result<HashMap<String, NaiveDateTime>> {
    if sns.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<NaiveDateTime>)> = sqlx::query_as(
        "SELECT device_sn, max(timestamp) FROM growatt_inverter_readings \
         WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp < $3 GROUP BY device_sn",
    )
    .bind(sns)
    .bind(day.and_time(NaiveTime::MIN))
    .bind(before)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(sn, t)| Some((sn, t?))).collect())
}

/// A stored Google hour (the columns a slot's `google` takes).
#[derive(Debug, Clone, sqlx::FromRow)]
struct GoogleHour {
    hour: NaiveDateTime,
    condition: Option<String>,
    precip_mm: Option<f64>,
    cloud_cover_pct: Option<f64>,
}

/// Python `_hourly_google`: a slot's `google` from the stored hour that contains the slot time.
fn hourly_google(g: &GoogleHour) -> Value {
    json!({
        "source": "hourly",
        "hour": hm(g.hour),
        "modelled": true,
        "condition": g.condition,
        "raining": is_raining(g.precip_mm, g.condition.as_deref()),
        "precip_mm": g.precip_mm,
        "cloud_cover_pct": g.cloud_cover_pct,
    })
}

async fn google_hours(pool: &PgPool, cell_key: &str, hours: &[NaiveDateTime]) -> Result<HashMap<NaiveDateTime, GoogleHour>> {
    let rows: Vec<GoogleHour> = sqlx::query_as(
        "SELECT hour, condition, precip_mm, cloud_cover_pct FROM google_weather_hourly WHERE cell_key = $1 AND hour = ANY($2)",
    )
    .bind(cell_key)
    .bind(hours)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|g| (g.hour, g)).collect())
}

/// Python truthiness of a JSON value
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// A frozen slot row (`pwa_check_slots`)
#[derive(Debug, Clone)]
struct SlotRow {
    hour: i32,
    slot: Value,
}

/// Python `_fill_google`: frozen slots that got no Google weather at their publish take the
/// stored hour once Google's hours are in. Only the missing `google` is filled.
async fn fill_google(pool: &PgPool, cfg: &CheckConfig, plant: &Plant, day: NaiveDate, rows: &mut [SlotRow]) -> Result<()> {
    let missing: Vec<usize> = (0..rows.len()).filter(|i| !truthy(rows[*i].slot.get("google"))).collect();
    let Some((cell, _, _)) = plant_cell(plant, &cfg.google) else { return Ok(()) };
    if missing.is_empty() {
        return Ok(());
    }
    let at: HashMap<usize, NaiveDateTime> =
        missing.iter().map(|i| (*i, hour_of(slot_time(cfg, day, u32::try_from(rows[*i].hour).unwrap_or(0))))).collect();
    let want: Vec<NaiveDateTime> = at.values().copied().collect::<HashSet<_>>().into_iter().collect();
    let stored = google_hours(pool, &cell, &want).await?;
    let mut tx = pool.begin().await?;
    let mut changed = false;
    for i in &missing {
        if let Some(g) = stored.get(&at[i]) {
            if let Value::Object(m) = &mut rows[*i].slot {
                m.insert("google".into(), hourly_google(g));
            }
            sqlx::query("UPDATE pwa_check_slots SET slot_json = $1 WHERE day = $2 AND plant_id = $3 AND hour = $4")
                .bind(Json(&rows[*i].slot))
                .bind(day)
                .bind(plant.plant_id)
                .bind(rows[*i].hour)
                .execute(&mut *tx)
                .await?;
            changed = true;
        }
    }
    if changed {
        tx.commit().await?;
    }
    Ok(())
}

/// Python `compute_slots`: check slots `hours` of one plant, built from stored history (nothing
/// frozen, nothing read from `pwa_check_slots`). `live_google`: take Google's current
/// conditions for a check whose slot time just passed (the freezing publish only).
pub async fn compute_slots(
    pool: &PgPool,
    cfg: &CheckConfig,
    plant: &Plant,
    day: NaiveDate,
    hours: &[u32],
    live_google: bool,
) -> Result<BTreeMap<String, Value>> {
    let mut out = BTreeMap::new();
    if hours.is_empty() {
        return Ok(out);
    }
    let times: Vec<(u32, NaiveDateTime)> = hours.iter().map(|h| (*h, slot_time(cfg, day, *h))).collect();
    let label_list = labels(pool, plant.plant_id).await?;
    let label: HashMap<&str, &str> = label_list.iter().map(|(s, l)| (s.as_str(), l.as_str())).collect();
    let sns: Vec<String> = label_list.iter().map(|(s, _)| s.clone()).collect();
    let in_windows = |ts: NaiveDateTime| times.iter().any(|(_, t)| *t - window() <= ts && ts <= *t);
    let lo = times.iter().map(|(_, t)| *t - window()).min().expect("hours");
    let hi = times.iter().map(|(_, t)| *t).max().expect("hours");

    // inverter readings in the windows: (sn, ts, status, pac_w, fault_code, warn_code)
    type InvRow = (String, NaiveDateTime, Option<i32>, Option<f64>, Option<i32>, Option<i32>);
    let inv_rows: Vec<InvRow> = if sns.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, InvRow>(
            "SELECT device_sn, timestamp, status, pac_w, fault_code, warn_code FROM growatt_inverter_readings \
             WHERE device_sn = ANY($1) AND timestamp >= $2 AND timestamp <= $3",
        )
        .bind(&sns)
        .bind(lo)
        .bind(hi)
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter(|r| in_windows(r.1))
        .collect()
    };
    // Python `_latest`: {(hour, key): latest row in that slot's window}
    let mut inv: HashMap<(u32, &str), &InvRow> = HashMap::new();
    for r in &inv_rows {
        for (h, t) in &times {
            if *t - window() <= r.1 && r.1 <= *t {
                let e = inv.entry((*h, r.0.as_str())).or_insert(r);
                if r.1 > e.1 {
                    *e = r;
                }
            }
        }
    }

    let alarms: Vec<AlarmRow> = sqlx::query_as(
        "SELECT device_sn, start_time, end_time, alarm_code, alarm_message, fault_type FROM growatt_alarms \
         WHERE plant_id = $1 AND day = $2 AND start_time IS NOT NULL",
    )
    .bind(plant.plant_id)
    .bind(day)
    .fetch_all(pool)
    .await?;

    // when each inverter's alarm log of the day was last read (naive plant-local)
    let alarm_read: HashMap<String, NaiveDateTime> = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        "SELECT device_sn, synced_at FROM growatt_alarm_syncs WHERE plant_id = $1 AND day = $2",
    )
    .bind(plant.plant_id)
    .bind(day)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(sn, at)| (sn, (at + Duration::hours(7)).naive_utc()))
    .collect();

    let sensors: Vec<(String, i32)> = sqlx::query_as("SELECT datalogger_sn, address FROM growatt_env_sensors WHERE plant_id = $1")
        .bind(plant.plant_id)
        .fetch_all(pool)
        .await?;
    // ((dl, addr), ts, irradiance, module temperature)
    type EnvRow = ((String, i32), NaiveDateTime, f64, Option<f64>);
    let mut env_rows: Vec<EnvRow> = Vec::new();
    for (dl, addr) in &sensors {
        let rows: Vec<(NaiveDateTime, f64, Option<f64>)> = sqlx::query_as(
            "SELECT timestamp, irradiance_wm2, module_temp_c FROM growatt_env_readings \
             WHERE datalogger_sn = $1 AND address = $2 AND irradiance_wm2 IS NOT NULL AND timestamp >= $3 AND timestamp <= $4",
        )
        .bind(dl)
        .bind(addr)
        .bind(lo)
        .bind(hi)
        .fetch_all(pool)
        .await?;
        env_rows.extend(rows.into_iter().filter(|r| in_windows(r.0)).map(|(ts, irr, m)| ((dl.clone(), *addr), ts, irr, m)));
    }
    let mut env: HashMap<(u32, (String, i32)), &EnvRow> = HashMap::new();
    for r in &env_rows {
        for (h, t) in &times {
            if *t - window() <= r.1 && r.1 <= *t {
                let e = env.entry((*h, r.0.clone())).or_insert(r);
                if r.1 > e.1 {
                    *e = r;
                }
            }
        }
    }

    let cell = plant_cell(plant, &cfg.google);
    let google_rows = match &cell {
        Some((key, _, _)) => {
            let want: Vec<NaiveDateTime> = times.iter().map(|(_, t)| hour_of(*t)).collect::<HashSet<_>>().into_iter().collect();
            google_hours(pool, key, &want).await?
        }
        None => HashMap::new(),
    };

    for (h, t) in &times {
        let (h, t) = (*h, *t);
        let lab = |sn: &str| label.get(sn).map_or_else(|| sn.to_owned(), |l| (*l).to_owned());
        let hits: Vec<(&str, &InvRow)> = sns.iter().filter_map(|sn| inv.get(&(h, sn.as_str())).map(|r| (sn.as_str(), *r))).collect();
        let hit = |sn: &str| hits.iter().find(|(s, _)| *s == sn).map(|(_, r)| *r);
        let mut offline: Vec<String> =
            sns.iter().filter(|sn| hit(sn).is_none()).map(|sn| lab(sn)).collect::<HashSet<_>>().into_iter().collect();
        offline.sort_by_key(|l| sort_key(l));
        let mut fault: Vec<String> =
            hits.iter().filter(|(_, r)| r.2 == Some(FAULT_STATUS)).map(|(sn, _)| lab(sn)).collect::<HashSet<_>>().into_iter().collect();
        fault.sort_by_key(|l| sort_key(l));
        let pac: Vec<f64> = hits.iter().filter_map(|(_, r)| r.3).collect();
        let since = fault_since(cfg, day, h);
        // every alarm field of the slot takes only the alarm-log records of the look-back
        let in_window: Vec<usize> =
            (0..alarms.len()).filter(|i| active(&alarms[*i], t, alarm_read.get(&alarms[*i].device_sn).copied(), Some(since))).collect();
        let in_set: HashSet<usize> = in_window.iter().copied().collect();
        let mut ordered = in_window.clone();
        ordered.sort_by_key(|i| (sort_key(&lab(&alarms[*i].device_sn)), alarms[*i].start_time.unwrap_or(t)));
        let mut open_now: Vec<String> = Vec::new();
        let mut errors: Vec<(String, i64)> = Vec::new();
        for i in ordered {
            let a = &alarms[i];
            if is_error(a) {
                let mut err = a.alarm_message.as_deref().unwrap_or("").trim().to_owned();
                if err.is_empty() || is_skip(&err) {
                    err = match a.alarm_code.as_deref().filter(|c| !c.is_empty()) {
                        Some(c) => format!("Error {c}"),
                        None => String::new(),
                    };
                }
                if !err.is_empty() {
                    let key = format!("{} {err}", lab(&a.device_sn));
                    match errors.iter_mut().find(|(k, _)| *k == key) {
                        Some(e) => e.1 += 1,
                        None => errors.push((key, 1)),
                    }
                }
            }
            // Python `(a.alarm_message or a.alarm_code or "").strip()`
            let raw = a.alarm_message.as_deref().filter(|m| !m.is_empty()).or(a.alarm_code.as_deref()).unwrap_or("");
            let mut msg = raw.trim().to_owned();
            if msg.is_empty() {
                continue;
            }
            if let Some(code) = a.alarm_code.as_deref().filter(|c| !c.is_empty() && is_skip(&msg)) {
                msg = format!("{code} {msg}");
            }
            let text = format!("{} {msg}", lab(&a.device_sn));
            if !open_now.contains(&text) {
                open_now.push(text);
            }
        }

        // DATA LOG: what is wrong with each inverter at the check
        let mut issues: Vec<Value> = Vec::new();
        let missing: Vec<String> = sns.iter().filter(|sn| hit(sn).is_none()).cloned().collect();
        let seen = last_seen(pool, &missing, day, t - window()).await?;
        let mut by_label: Vec<&String> = sns.iter().collect();
        by_label.sort_by_key(|sn| sort_key(label[sn.as_str()]));
        for sn in by_label {
            let l = label[sn.as_str()];
            let Some(r) = hit(sn) else {
                issues.push(json!({"inv": l, "state": "Offline", "items": [], "last": seen.get(sn).map(|s| hm(*s))}));
                continue;
            };
            let mut mine: Vec<usize> = (0..alarms.len()).filter(|i| alarms[*i].device_sn == *sn).collect();
            mine.sort_by_key(|i| alarms[*i].start_time.unwrap_or(t));
            let present: Vec<usize> = mine.iter().copied().filter(|i| in_set.contains(i)).collect();
            type Key = (bool, Option<String>, Option<String>);
            let mut reports: Vec<(Key, Vec<NaiveDateTime>)> = Vec::new();
            for i in &present {
                let a = &alarms[*i];
                if let (Some((code, msg)), Some(st)) = (item(a), a.start_time) {
                    let key = (is_error(a), code, msg);
                    match reports.iter_mut().find(|(k, _)| *k == key) {
                        Some(e) => e.1.push(st),
                        None => reports.push((key, vec![st])),
                    }
                }
            }
            let mut items: Vec<Value> = Vec::new();
            let mut seen_keys: Vec<Key> = Vec::new();
            // errors before warnings, each in start order
            let mut by_kind = present.clone();
            by_kind.sort_by_key(|i| !is_error(&alarms[*i]));
            for i in by_kind {
                let a = &alarms[i];
                let Some((code, msg)) = item(a) else { continue };
                let key = (is_error(a), code.clone(), msg.clone());
                if !seen_keys.contains(&key) {
                    let times_ = &reports.iter().find(|(k, _)| *k == key).expect("reported").1;
                    let first = times_.iter().min().expect("one report");
                    items.push(json!({"code": code, "message": msg, "since": hm(*first), "count": times_.len()}));
                    seen_keys.push(key);
                }
            }
            if items.is_empty() {
                // the alarm log has nothing active: the reading's own codes, the log's text only
                // for the same kind
                for (code, err_kind) in [(r.4, true), (r.5, false)] {
                    let Some(code) = code.filter(|c| *c != 0) else { continue };
                    if !err_kind && cfg.ignored_warn_codes.contains(&i64::from(code)) {
                        continue;
                    }
                    let code_s = code.to_string();
                    let text = mine.iter().find_map(|i| {
                        let a = &alarms[*i];
                        if is_error(a) != err_kind {
                            return None;
                        }
                        match item(a) {
                            Some((Some(c), Some(m))) if c == code_s => Some(m),
                            _ => None,
                        }
                    });
                    items.push(json!({"code": code_s, "message": text}));
                }
            }
            if r.2 == Some(FAULT_STATUS) {
                issues.push(json!({"inv": l, "state": "Fault", "items": items}));
            } else if !items.is_empty() {
                issues.push(json!({"inv": l, "state": "Alarm", "items": items}));
            }
        }

        let sens: Vec<&EnvRow> = sensors.iter().filter_map(|s| env.get(&(h, s.clone())).copied()).collect();
        let irr: Vec<f64> = sens.iter().map(|r| r.2).collect();
        let module: Vec<f64> = sens.iter().filter_map(|r| r.3).collect();

        let cur = match (&cell, live_google) {
            (Some((key, _, _)), true) => slot_current(pool, cfg, day, h, t, now_local()).await?.get(key).cloned(),
            _ => None,
        };
        let google = if let Some(cur) = cur {
            let at = cur
                .time_utc
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| hm((d.with_timezone(&Utc) + Duration::hours(7)).naive_utc()));
            let c = &cur.conditions;
            json!({
                "source": "current",
                "at": at,
                "modelled": true,
                "condition": c.condition,
                "raining": is_raining(c.precip_mm, c.condition.as_deref()),
                "precip_mm": c.precip_mm,
                "cloud_cover_pct": c.cloud_cover_pct,
            })
        } else if let Some(g) = google_rows.get(&hour_of(t)) {
            hourly_google(g)
        } else {
            Value::Null
        };

        let mut slot = Map::new();
        slot.insert("at".into(), json!(hm(t)));
        slot.insert("inverters".into(), json!(sns.len()));
        slot.insert("offline".into(), json!(offline));
        slot.insert("fault".into(), json!(fault));
        slot.insert("alarms".into(), json!(open_now));
        slot.insert(
            "errors".into(),
            json!(errors.iter().map(|(k, n)| if *n == 1 { k.clone() } else { format!("{k} (×{n})") }).collect::<Vec<_>>()),
        );
        slot.insert("issues".into(), Value::Array(issues));
        slot.insert("kw".into(), json!((!pac.is_empty()).then(|| py_round(py_sum(pac.iter().copied()) / 1000.0, 2))));
        slot.insert("reading_at".into(), json!(hits.iter().map(|(_, r)| r.1).max().map(hm)));
        slot.insert(
            "irradiance_wm2".into(),
            json!((!irr.is_empty()).then(|| py_round(py_sum(irr.iter().copied()) / irr.len() as f64, 1))),
        );
        slot.insert(
            "module_temp_c".into(),
            json!((!module.is_empty()).then(|| py_round(py_sum(module.iter().copied()) / module.len() as f64, 1))),
        );
        slot.insert("sensor_at".into(), json!(sens.iter().map(|r| r.1).max().map(hm)));
        slot.insert("google".into(), google);
        out.insert(hh(h), Value::Object(slot));
    }
    Ok(out)
}

// --------------------------------------------------------------------------- frozen slots

/// Python `day_slots`: the plant's check slots of `day`: every frozen slot, plus the `ready`
/// hours not frozen yet, built now (and frozen when `freeze`). Hours neither frozen nor ready
/// are absent.
pub async fn day_slots(
    pool: &PgPool,
    cfg: &CheckConfig,
    plant: &Plant,
    day: NaiveDate,
    ready: &[u32],
    freeze: bool,
) -> Result<BTreeMap<String, Value>> {
    let mut rows: Vec<SlotRow> =
        sqlx::query_as::<_, (i32, Json<Value>)>("SELECT hour, slot_json FROM pwa_check_slots WHERE day = $1 AND plant_id = $2")
            .bind(day)
            .bind(plant.plant_id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(hour, j)| SlotRow { hour, slot: j.0 })
            .collect();
    if freeze {
        fill_google(pool, cfg, plant, day, &mut rows).await?;
    }
    let frozen: HashMap<u32, Value> = rows.into_iter().filter_map(|r| Some((u32::try_from(r.hour).ok()?, r.slot))).collect();
    let todo: Vec<u32> = ready.iter().copied().filter(|h| !frozen.contains_key(h)).collect();
    let built = compute_slots(pool, cfg, plant, day, &todo, freeze).await?;
    if freeze && !built.is_empty() {
        let mut tx = pool.begin().await?;
        for h in &todo {
            sqlx::query("INSERT INTO pwa_check_slots (day, plant_id, hour, slot_json, built_at) VALUES ($1, $2, $3, $4, $5)")
                .bind(day)
                .bind(plant.plant_id)
                .bind(i32::try_from(*h).unwrap_or(0))
                .bind(Json(&built[&hh(*h)]))
                .bind(Utc::now())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    let mut out = BTreeMap::new();
    for h in CHECK_HOURS {
        if let Some(v) = frozen.get(&h) {
            out.insert(hh(h), v.clone());
        } else if let Some(v) = built.get(&hh(h)) {
            out.insert(hh(h), v.clone());
        }
    }
    Ok(out)
}

// --------------------------------------------------------------------------- Google current at the slot time

/// Python `google_weather.SLOT_CURRENT_LATE`: current conditions count for a check only this
/// soon after its slot time
fn slot_current_late() -> Duration {
    Duration::minutes(20)
}

/// Python `google_weather.FETCH_WORKERS`
const FETCH_WORKERS: usize = 8;

type SlotMemo = Mutex<HashMap<(NaiveDate, u32), Arc<HashMap<String, Current>>>>;

fn slot_memo() -> &'static SlotMemo {
    static M: OnceLock<SlotMemo> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serialises the first build of a check's memo (Python `_slot_lock`)
fn slot_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Python `google_weather.fleet_cells`: every cell holding a plant with coordinates, sorted by
/// key, with the first plant's (rounded) point.
async fn fleet_cell_points(pool: &PgPool, cell_deg: f64) -> Result<BTreeMap<String, (f64, f64)>> {
    let rows: Vec<(Option<f64>, Option<f64>)> =
        sqlx::query_as("SELECT latitude, longitude FROM growatt_plants ORDER BY plant_id").fetch_all(pool).await?;
    let mut cells = BTreeMap::new();
    for (lat, lon) in rows {
        if let (Some(lat), Some(lon)) = (lat, lon) {
            let (k, la, lo) = cell_of(lat, lon, cell_deg);
            cells.entry(k).or_insert((la, lo));
        }
    }
    Ok(cells)
}

/// Python `google_weather.slot_current`: Google current conditions (modelled) of every fleet
/// cell for PWA check `hour` of `day`, taken at the slot time. One call per cell, once per check
/// (memoized in this process), within today's call budget. Empty without a key, or when
/// `now_local` is not in [slot_at, slot_at + 20 min].
pub async fn slot_current(
    pool: &PgPool,
    cfg: &CheckConfig,
    day: NaiveDate,
    hour: u32,
    slot_at: NaiveDateTime,
    now_local: NaiveDateTime,
) -> Result<Arc<HashMap<String, Current>>> {
    if cfg.google_api_key.is_empty() || !(slot_at <= now_local && now_local <= slot_at + slot_current_late()) {
        return Ok(Arc::new(HashMap::new()));
    }
    let key = (day, hour);
    let _guard = slot_lock().lock().await;
    {
        let mut memo = slot_memo().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(hit) = memo.get(&key) {
            return Ok(Arc::clone(hit));
        }
        memo.retain(|k, _| k.0 == day); // keep today's checks only
    }
    let cells = fleet_cell_points(pool, cfg.google.cell_deg).await?;
    let budget_day = crate::google_weather_live::billing_day();
    let left = remaining(pool, cfg.google_monthly_budget, cfg.google.cell_deg, API_CURRENT, budget_day).await?;
    let todo: Vec<(String, (f64, f64))> = cells.iter().take(usize::try_from(left.max(0)).unwrap_or(0)).map(|(k, p)| (k.clone(), *p)).collect();
    let skipped = cells.len() - todo.len();
    let client = match GoogleWeatherClient::new(&cfg.google_api_key, &cfg.google_base_url, tcroof_clients::google_weather::DEFAULT_TIMEOUT_S) {
        Ok(c) => Arc::new(c),
        Err(_) => return Ok(Arc::new(HashMap::new())),
    };
    let quota_hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sem = Arc::new(tokio::sync::Semaphore::new(FETCH_WORKERS));
    let mut set = tokio::task::JoinSet::new();
    for (idx, (k, (lat, lon))) in todo.into_iter().enumerate() {
        let (client, quota_hit, sem) = (Arc::clone(&client), Arc::clone(&quota_hit), Arc::clone(&sem));
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            if quota_hit.load(std::sync::atomic::Ordering::SeqCst) {
                return (idx, k, Err("skipped: Google daily quota exceeded (HTTP 429)".to_owned()));
            }
            match client.current(lat, lon).await {
                Ok(c) => (idx, k, Ok(c)),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("HTTP 429") {
                        quota_hit.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    (idx, k, Err(msg))
                }
            }
        });
    }
    let mut results = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok(r) = r {
            results.push(r);
        }
    }
    results.sort_by_key(|r| r.0);
    record_calls(pool, API_CURRENT, i64::try_from(client.calls()).unwrap_or(i64::MAX), budget_day).await?;
    let mut out = HashMap::new();
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    for (_, k, r) in results {
        match r {
            Ok(c) => {
                out.insert(k, c);
            }
            Err(e) => {
                failed += 1;
                first_error.get_or_insert_with(|| e.chars().take(300).collect());
            }
        }
    }
    if failed > 0 || skipped > 0 {
        let reason = first_error.map(|e| format!("; first error: {e}")).unwrap_or_default();
        tracing::warn!(target: "google_weather", "google weather check {hour:02}: {failed} cells failed, {skipped} skipped (call budget){reason}");
    }
    let out = Arc::new(out);
    slot_memo().lock().unwrap_or_else(|p| p.into_inner()).insert(key, Arc::clone(&out));
    Ok(out)
}

// --------------------------------------------------------------------------- prune

/// Python `prune` (the `retention` job uses `retention::prune_check_slots`, the same delete)
pub async fn prune(pool: &PgPool, today: NaiveDate, keep_days: i64) -> Result<u64> {
    let n = sqlx::query("DELETE FROM pwa_check_slots WHERE day < $1").bind(today - Duration::days(keep_days)).execute(pool).await?;
    Ok(n.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv(sn: &str, alias: Option<&str>) -> Inverter {
        Inverter {
            device_sn: sn.into(),
            plant_id: 1,
            datalogger_sn: None,
            model: None,
            device_types: None,
            alias: alias.map(Into::into),
            nominal_power_w: None,
            fw_version: None,
            inner_version: None,
            active_rate_pct: None,
            reactive_rate_pct: None,
            pf_setting: None,
            pf_model: None,
            export_limit: None,
            export_limit_rate_pct: None,
            on_off: None,
            info_synced_at: None,
            power_limit_pct: None,
            power_limit_read_at: None,
            device_model: None,
            datalogger_model: None,
            rated_power_w: None,
            param_synced_at: None,
            growatt_created_at: None,
            history_synced_until: None,
            not_installed_at: None,
            not_installed_by: None,
            not_installed_note: None,
            synced_at: Utc::now(),
        }
    }

    #[test]
    fn labels_like_daily_checks() {
        // backend/tests/test_daily_checks.py cases
        for (alias, want) in [
            ("INVERTER 3", "INV3"),
            ("Inverter no.3", "INV3"),
            ("Inverter03", "INV3"),
            ("INV No.05_ST2", "INV5"),
            ("INV1 MYHSF12345", "INV1"),
            ("(2) GKLRF0001", "INV2"),
            ("inv ๓", "INV3"),
        ] {
            assert_eq!(inverter_label(&inv("SN1", Some(alias)), false), want, "{alias}");
        }
        assert_eq!(inverter_label(&inv("MYHSF12345", Some("myhsf12345")), false), "MYHSF12345");
        assert_eq!(inverter_label(&inv("MYHSF12345", Some("myhsf12345")), true), "INV1");
        assert_eq!(inverter_label(&inv("SN9", None), false), "SN9");
        assert!(is_replaced(&inv("A", Some("INV 1 old"))));
        assert!(is_replaced(&inv("A", Some("INVERTER 1 (เก่า)"))));
        assert!(is_replaced(&inv("A", Some("GKLNF3901P(old)"))));
        assert!(!is_replaced(&inv("A", Some("INV 1 golden"))));
    }

    #[test]
    fn sort_keys() {
        assert_eq!(sort_key("INV12"), (12, String::new()));
        assert_eq!(sort_key("SN1"), (1_000_000, "SN1".into()));
        assert_eq!(sort_key("INV"), (1_000_000, "INV".into()));
        let mut v = vec!["INV10", "SNX", "INV2"];
        v.sort_by_key(|l| sort_key(l));
        assert_eq!(v, ["INV2", "INV10", "SNX"]);
    }

    #[test]
    fn active_in_the_look_back() {
        let t = |h, m| NaiveDate::from_ymd_opt(2026, 11, 27).unwrap().and_hms_opt(h, m, 0).unwrap();
        let a = |s, e| AlarmRow {
            device_sn: "A".into(),
            start_time: Some(s),
            end_time: e,
            alarm_code: None,
            alarm_message: None,
            fault_type: None,
        };
        let (slot, since) = (t(8, 50), Some(t(7, 50)));
        assert!(active(&a(t(8, 0), None), slot, None, since));
        assert!(!active(&a(t(8, 55), None), slot, None, since)); // started after the slot
        assert!(active(&a(t(7, 0), Some(t(8, 0))), slot, None, since)); // cleared within the look-back
        assert!(!active(&a(t(7, 0), Some(t(7, 40))), slot, None, since)); // cleared before 07:50
        assert!(active(&a(t(7, 55), Some(t(7, 55))), slot, None, since)); // one report at 07:55
        assert!(!active(&a(t(7, 45), Some(t(7, 45))), slot, None, since));
        // without `since`: active at t
        assert!(active(&a(t(8, 45), Some(t(8, 45))), slot, None, None));
        assert!(!active(&a(t(8, 30), Some(t(8, 30))), slot, None, None));
    }

    #[test]
    fn slot_times() {
        let cfg = CheckConfig::default();
        let d = NaiveDate::from_ymd_opt(2026, 11, 27).unwrap();
        assert_eq!(slot_time(&cfg, d, 9).to_string(), "2026-11-27 08:50:00");
        assert_eq!(fault_since(&cfg, d, 13).to_string(), "2026-11-27 11:50:00");
        assert_eq!(parse_warn_codes(" 1, 2,x,"), HashSet::from([1, 2]));
    }
}
