//! System → Logs (`/system/logs`, `/system/logs/summary`, admin only): backend/app/api/routes/system.py
//! and backend/app/services/system_logs.py. Times are stored UTC; `since` / `until` without a zone
//! are Bangkok time.

use std::collections::BTreeMap;

use axum::extract::{RawQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde_json::{json, Value};

use tcroof_db::logs::{LogFilter, LogRow};

use crate::error::ApiError;
use crate::extract::{parse_int, AdminUser};
use crate::pyfmt::repr_str;
use crate::AppState;

const LEVELS: [&str; 5] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
const SOURCES: [&str; 3] = ["api", "worker", "cli"];
const Q_MAX: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new().route("/system/logs", get(list_logs)).route("/system/logs/summary", get(logs_summary))
}

/// Python `jobs.PLANT_TZ` (Asia/Bangkok, UTC+7 all year)
fn bangkok() -> FixedOffset {
    FixedOffset::east_opt(7 * 3600).expect("UTC+7")
}

fn unprocessable(field: &str, msg: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// The query string as Starlette reads it: `+` is a space, repeated keys kept in order.
fn query_pairs(raw: Option<&str>) -> Vec<(String, String)> {
    form_urlencoded::parse(raw.unwrap_or("").as_bytes()).into_owned().collect()
}

/// A scalar query parameter: the last value wins (Starlette `QueryParams.get`).
fn last<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn int_param(pairs: &[(String, String)], key: &str) -> Result<Option<i64>, ApiError> {
    last(pairs, key)
        .map(|s| parse_int(s).ok_or_else(|| unprocessable(key, "Input should be a valid integer, unable to parse string as an integer")))
        .transpose()
}

/// pydantic v2 `datetime` from a query string: `YYYY-MM-DD[T| ]HH:MM[:SS[.ffffff]][Z|±HH[:]MM]`,
/// a bare date (midnight), or Unix seconds (milliseconds above 2e10). `None` = invalid.
/// A result without a zone is naive (`Err` side of the `Result`).
fn parse_datetime(s: &str) -> Option<Result<DateTime<Utc>, NaiveDateTime>> {
    if let Ok(x) = s.parse::<f64>() {
        if !s.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+')) || !x.is_finite() {
            return None;
        }
        let secs = if x.abs() > 2e10 { x / 1000.0 } else { x };
        let micros = (secs * 1e6).round() as i64;
        return DateTime::<Utc>::from_timestamp_micros(micros).map(Ok);
    }
    let (date_s, rest) = if s.len() >= 10 && s.is_char_boundary(10) { s.split_at(10) } else { return None };
    let date = NaiveDate::parse_from_str(date_s, "%Y-%m-%d").ok()?;
    if rest.is_empty() {
        return Some(Err(date.and_time(NaiveTime::MIN)));
    }
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    // split the zone off: Z, or the last + / - (time parts never contain one)
    let (time_s, zone) = if let Some(t) = rest.strip_suffix(['Z', 'z']) {
        (t, Some(0))
    } else if let Some(i) = rest.rfind(['+', '-']) {
        let z = &rest[i + 1..];
        let digits: String = z.chars().filter(|c| *c != ':').collect();
        if !(digits.len() == 2 || digits.len() == 4) || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let h: i32 = digits[..2].parse().ok()?;
        let m: i32 = if digits.len() == 4 { digits[2..].parse().ok()? } else { 0 };
        if h > 23 || m > 59 {
            return None;
        }
        let sign = if rest.as_bytes()[i] == b'-' { -1 } else { 1 };
        (&rest[..i], Some(sign * (h * 3600 + m * 60)))
    } else {
        (rest, None)
    };
    let time = parse_time(time_s)?;
    let naive = date.and_time(time);
    match zone {
        None => Some(Err(naive)),
        Some(off) => {
            let tz = FixedOffset::east_opt(off)?;
            Some(Ok(tz.from_local_datetime(&naive).single()?.with_timezone(&Utc)))
        }
    }
}

/// `HH:MM[:SS[.f…]]` (fraction up to microseconds; more digits are cut, as pydantic rounds down)
fn parse_time(s: &str) -> Option<NaiveTime> {
    let (hms, frac) = match s.split_once(['.', ',']) {
        Some((a, f)) => (a, Some(f)),
        None => (s, None),
    };
    let parts: Vec<&str> = hms.split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.len() != 2 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let sec: u32 = if parts.len() == 3 { parts[2].parse().ok()? } else { 0 };
    let micro = match frac {
        None => 0,
        Some(f) if parts.len() == 3 && !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
            let f6: String = f.chars().chain(std::iter::repeat('0')).take(6).collect();
            f6.parse().ok()?
        }
        Some(_) => return None,
    };
    NaiveTime::from_hms_micro_opt(h, m, sec, micro)
}

/// Python `system_logs.to_utc`: aware → UTC; naive = Bangkok (plant-local) time.
fn to_utc(v: Result<DateTime<Utc>, NaiveDateTime>) -> DateTime<Utc> {
    match v {
        Ok(t) => t,
        Err(naive) => bangkok().from_local_datetime(&naive).single().expect("fixed offset").with_timezone(&Utc),
    }
}

fn datetime_param(pairs: &[(String, String)], key: &str) -> Result<Option<DateTime<Utc>>, ApiError> {
    match last(pairs, key) {
        None => Ok(None),
        Some(s) => parse_datetime(s).map(|v| Some(to_utc(v))).ok_or_else(|| unprocessable(key, "Input should be a valid datetime")),
    }
}

/// Python `system_logs._iso`: UTC, whole seconds, `Z`
fn iso(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Python `system_logs.row_out`
fn row_out(r: &LogRow) -> Value {
    json!({
        "id": r.id,
        "ts": iso(r.ts),
        "level": r.level,
        "source": r.source,
        "host": r.host,
        "logger": r.logger,
        "message": r.message,
        "exc_text": r.exc_text,
        "run_id": r.run_id,
        "job": r.job,
        "request_id": r.request_id,
        "extra": r.extra_json,
    })
}

/// Python `system_logs.level_no`: `INFO` → 20; other names are a 422.
fn level_no(level: &str) -> Result<i16, ApiError> {
    let name = level.trim().to_uppercase();
    match LEVELS.iter().position(|l| *l == name) {
        Some(i) => Ok(10 * (i as i16 + 1)),
        None => Err(ApiError::Unprocessable(format!(
            "Unknown level {}; choose one of {}",
            repr_str(level),
            LEVELS.join(", ")
        ))),
    }
}

/// GET /system/logs: Python `routes/system.list_logs` + `system_logs.list_logs`. Newest first;
/// `before_id` pages back, `after_id` returns only newer rows (polling). Without `since` the window
/// is the last 24 h, unless a `run_id` is given (the whole run).
async fn list_logs(State(st): State<AppState>, AdminUser(_): AdminUser, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    // FastAPI checks every parameter before the handler runs
    let level = last(&p, "level").unwrap_or("INFO").to_owned();
    let sources: Vec<String> = p.iter().filter(|(k, _)| k == "source").map(|(_, v)| v.clone()).collect();
    let logger = last(&p, "logger").map(str::to_owned);
    let job = last(&p, "job").map(str::to_owned);
    let run_id = int_param(&p, "run_id")?;
    let q = last(&p, "q").map(str::to_owned);
    if q.as_ref().is_some_and(|s| s.chars().count() > Q_MAX) {
        return Err(unprocessable("q", format!("String should have at most {Q_MAX} characters")));
    }
    let since = datetime_param(&p, "since")?;
    let until = datetime_param(&p, "until")?;
    let before_id = int_param(&p, "before_id")?;
    let after_id = int_param(&p, "after_id")?;
    let limit = int_param(&p, "limit")?.unwrap_or(200);
    if limit < 1 {
        return Err(unprocessable("limit", "Input should be greater than or equal to 1"));
    }
    if limit > 1000 {
        return Err(unprocessable("limit", "Input should be less than or equal to 1000"));
    }

    // the service (ValueError → 422)
    let min_level_no = level_no(&level)?;
    if !sources.is_empty() {
        let mut bad: Vec<&String> = sources.iter().filter(|s| !SOURCES.contains(&s.as_str())).collect();
        bad.sort();
        if let Some(b) = bad.first() {
            return Err(ApiError::Unprocessable(format!(
                "Unknown source {}; choose one of {}",
                repr_str(b),
                SOURCES.join(", ")
            )));
        }
    }
    let since_utc = since.or_else(|| if run_id.is_some() { None } else { Some(Utc::now() - Duration::hours(24)) });
    let filter = LogFilter {
        min_level_no,
        sources: (!sources.is_empty()).then_some(sources),
        logger_prefix: logger.filter(|s| !s.is_empty()),
        job: job.filter(|s| !s.is_empty()),
        run_id,
        text: q.filter(|s| !s.is_empty()).map(|s| s.chars().take(Q_MAX).collect::<String>().to_lowercase()),
        since: since_utc,
        until,
        before_id,
        after_id,
    };
    let rows = tcroof_db::logs::list_logs(&st.pool, &filter, limit).await?;
    let s = &st.settings;
    Ok(Json(json!({
        "items": rows.iter().map(row_out).collect::<Vec<_>>(),
        // a full page may have older rows; a short one is the end of the window
        "next_before_id": if rows.len() as i64 == limit { rows.last().map(|r| r.id) } else { None },
        "meta": {
            "source": "db",
            "since": since_utc.map(iso),
            "retention_days": s.log_retention_days,
            "enabled": s.log_db_enabled,
            "level": s.log_db_level.to_uppercase(),
        },
    })))
}

/// GET /system/logs/summary: Python `system_logs.summary`: counts per level and per source since
/// `since` (default 24 h ago), the newest ERROR+ record in the window and the newest id overall.
async fn logs_summary(State(st): State<AppState>, AdminUser(_): AdminUser, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let since = datetime_param(&p, "since")?.unwrap_or_else(|| Utc::now() - Duration::hours(24));
    let mut by_level: BTreeMap<String, i64> = LEVELS.iter().map(|l| (l.to_string(), 0)).collect();
    for (lvl, n) in tcroof_db::logs::count_by_level(&st.pool, since).await? {
        *by_level.entry(lvl).or_default() += n;
    }
    let mut by_source: BTreeMap<String, i64> = SOURCES.iter().map(|s| (s.to_string(), 0)).collect();
    for (src, n) in tcroof_db::logs::count_by_source(&st.pool, since).await? {
        *by_source.entry(src).or_default() += n;
    }
    let last = tcroof_db::logs::last_error(&st.pool, since).await?;
    Ok(Json(json!({
        "since": iso(since),
        "total": by_level.values().sum::<i64>(),
        "by_level": by_level,
        "by_source": by_source,
        "last_error": last.as_ref().map(row_out),
        "newest_id": tcroof_db::logs::newest_id(&st.pool).await?,
        "enabled": st.settings.log_db_enabled,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn datetimes_like_pydantic_naive_is_bangkok() {
        let got = |s: &str| parse_datetime(s).map(to_utc);
        assert_eq!(got("2026-11-27T10:00:00"), Some(utc("2026-11-27T03:00:00Z")));
        assert_eq!(got("2026-11-27 10:00"), Some(utc("2026-11-27T03:00:00Z")));
        assert_eq!(got("2026-11-27"), Some(utc("2026-11-26T17:00:00Z")));
        assert_eq!(got("2026-11-27T10:00:00Z"), Some(utc("2026-11-27T10:00:00Z")));
        assert_eq!(got("2026-11-27T10:00:00+07:00"), Some(utc("2026-11-27T03:00:00Z")));
        assert_eq!(got("2026-11-27T10:00:00-0130"), Some(utc("2026-11-27T11:30:00Z")));
        assert_eq!(got("2026-11-27T10:00:00.5Z"), Some(utc("2026-11-27T10:00:00.5Z")));
        assert_eq!(got("1764000000"), Some(utc("2025-11-24T16:00:00Z")));
        assert_eq!(got("1764000000000"), Some(utc("2025-11-24T16:00:00Z")));
        for bad in ["", "yesterday", "2026-13-01", "2026-11-27T25:00", "2026-11-27T10", "2026-11-27X10:00", "2026-11-27T10:00:00+7"] {
            assert_eq!(got(bad), None, "{bad}");
        }
    }

    #[test]
    fn levels() {
        assert_eq!(level_no(" warning ").unwrap(), 30);
        assert_eq!(level_no("critical").unwrap(), 50);
        match level_no("loud") {
            Err(ApiError::Unprocessable(m)) => {
                assert_eq!(m, "Unknown level 'loud'; choose one of DEBUG, INFO, WARNING, ERROR, CRITICAL")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn query_last_wins_and_plus_is_space() {
        let p = query_pairs(Some("level=INFO&level=ERROR&q=a+b%2Bc&source=api&source=cli"));
        assert_eq!(last(&p, "level"), Some("ERROR"));
        assert_eq!(last(&p, "q"), Some("a b+c"));
        assert_eq!(p.iter().filter(|(k, _)| k == "source").count(), 2);
    }
}
