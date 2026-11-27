//! Port of the call budget and the live current conditions of
//! `backend/app/services/google_weather.py` (`billing_day`, `_calls`, `calls_today`, `_month`,
//! `allowance`, `remaining`, `record_calls`, `reserve`, `fleet_cells`, `GoogleWeatherLive`,
//! `live_plant`).
//!
//! Google's values are **modelled** for the plant's grid cell, never measured: every answer says
//! `modelled: true`. Current conditions stay in memory only (mirrored in Redis when `REDIS_URL` is
//! set, same map names and keys as Python: `gweather` / `gweather-cooldown`, keyed by the cell key
//! string); SQL gets only the call count (`external_api_call_counts`), the bookkeeping Python
//! writes too. The history job and the PWA check slots (worker) are not ported here.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc, Weekday};
use serde_json::{json, Value};
use sqlx::PgPool;
use tcroof_clients::google_weather::GoogleWeatherClient;

use crate::common::{isoformat_utc, Plant, Result, ServiceError};
use crate::google_weather_stored::{cell_of, plant_cell, GoogleWeatherConfig, SOURCE};
use crate::live::round_int;
use crate::live_store::{cache_map, cooldown_map, wall_clock, CacheEntry, Clock, RedisLink, TieredMap};

/// Python `API_HISTORY`
pub const API_HISTORY: &str = "google_weather_history";
/// Python `API_CURRENT`
pub const API_CURRENT: &str = "google_weather_current";
/// Python `APIS`: the calls the monthly budget counts
pub const APIS: [&str; 2] = [API_HISTORY, API_CURRENT];
/// Python `GoogleWeatherLive.__init__` default `cooldown_s`
pub const COOLDOWN_S: f64 = 300.0;

// --------------------------------------------------------------------------- billing day

/// The `n`-th `weekday` of `month` (1-based).
fn nth_weekday(year: i32, month: u32, weekday: Weekday, n: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let shift = (7 + weekday.num_days_from_monday() - first.weekday().num_days_from_monday()) % 7;
    first + Duration::days(i64::from(shift + 7 * (n - 1)))
}

/// US/Pacific (`America/Los_Angeles`) date of a UTC instant: PDT (UTC−7) from the second Sunday of
/// March 02:00 PST (10:00 UTC) to the first Sunday of November 02:00 PDT (09:00 UTC), else PST
/// (UTC−8). The US rule since 2007; Python reads the same from the tz database.
pub fn pacific_date(t: DateTime<Utc>) -> NaiveDate {
    let y = t.year();
    let dst_start = nth_weekday(y, 3, Weekday::Sun, 2).and_time(NaiveTime::from_hms_opt(10, 0, 0).expect("valid")).and_utc();
    let dst_end = nth_weekday(y, 11, Weekday::Sun, 1).and_time(NaiveTime::from_hms_opt(9, 0, 0).expect("valid")).and_utc();
    let offset_h = if t >= dst_start && t < dst_end { -7 } else { -8 };
    (t + Duration::hours(offset_h)).date_naive()
}

/// Python `billing_day`: Google Maps Platform months and daily quotas reset in US/Pacific.
pub fn billing_day() -> NaiveDate {
    pacific_date(Utc::now())
}

/// Python `_month`: first day of `day`'s month and of the next one.
pub fn month(day: NaiveDate) -> (NaiveDate, NaiveDate) {
    let first = day.with_day(1).expect("day 1");
    let next = (first + Duration::days(32)).with_day(1).expect("day 1");
    (first, next)
}

// --------------------------------------------------------------------------- call budget (SQL)

/// Python `_calls`: calls counted on days [start, end) (ISO day strings compare in date order);
/// `api` None = every API of the monthly budget ([`APIS`]).
pub async fn calls(pool: &PgPool, start: NaiveDate, end: NaiveDate, api: Option<&str>) -> Result<i64> {
    let apis: Vec<String> = match api {
        Some(a) => vec![a.to_owned()],
        None => APIS.iter().map(|s| (*s).to_owned()).collect(),
    };
    let n: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(calls), 0)::bigint FROM external_api_call_counts WHERE day >= $1 AND day < $2 AND api = ANY($3)",
    )
    .bind(start.to_string())
    .bind(end.to_string())
    .bind(apis)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

/// Python `calls_today`
pub async fn calls_today(pool: &PgPool, api: Option<&str>, day: NaiveDate) -> Result<i64> {
    calls(pool, day, day + Duration::days(1), api).await
}

/// Python `allowance`: what is left of the monthly budget spread evenly over the days left (today
/// included), floor division as Python's `//`.
pub async fn allowance(pool: &PgPool, monthly_budget: i64, day: NaiveDate) -> Result<i64> {
    let (first, next) = month(day);
    let left = monthly_budget - calls(pool, first, day, None).await?;
    Ok(left.div_euclid((next - day).num_days()).max(0))
}

/// Python `fleet_cells`: the grid cells that hold at least one plant with coordinates (keys only).
pub async fn fleet_cells(pool: &PgPool, cell_deg: f64) -> Result<BTreeSet<String>> {
    let rows: Vec<(Option<f64>, Option<f64>)> =
        sqlx::query_as("SELECT latitude, longitude FROM growatt_plants ORDER BY plant_id").fetch_all(pool).await?;
    Ok(rows.into_iter().filter_map(|(lat, lon)| Some(cell_of(lat?, lon?, cell_deg).0)).collect())
}

/// Python `remaining`: calls `api` may still make today; live calls keep one call per cell free
/// for the history job until it has run today.
pub async fn remaining(pool: &PgPool, monthly_budget: i64, cell_deg: f64, api: &str, day: NaiveDate) -> Result<i64> {
    let mut left = allowance(pool, monthly_budget, day).await? - calls_today(pool, None, day).await?;
    if api == API_CURRENT && calls_today(pool, Some(API_HISTORY), day).await? == 0 {
        left -= fleet_cells(pool, cell_deg).await?.len() as i64;
    }
    Ok(left.max(0))
}

/// Python `record_calls`: add `n` calls to `api`'s count of `day` (an upsert; Python retries a
/// concurrent first insert as an update, which comes to the same row).
pub async fn record_calls(pool: &PgPool, api: &str, n: i64, day: NaiveDate) -> Result<()> {
    if n <= 0 {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO external_api_call_counts (api, day, calls) VALUES ($1, $2, $3) \
         ON CONFLICT (api, day) DO UPDATE SET calls = external_api_call_counts.calls + EXCLUDED.calls",
    )
    .bind(api)
    .bind(day.to_string())
    .bind(i32::try_from(n).unwrap_or(i32::MAX))
    .execute(pool)
    .await?;
    Ok(())
}

/// Python `reserve`: count one call now if today's budget allows it.
pub async fn reserve(pool: &PgPool, monthly_budget: i64, cell_deg: f64, api: &str) -> Result<bool> {
    let day = billing_day();
    if remaining(pool, monthly_budget, cell_deg, api, day).await? <= 0 {
        return Ok(false);
    }
    record_calls(pool, api, 1, day).await?;
    Ok(true)
}

// --------------------------------------------------------------------------- live (memory only)

/// Python `GoogleWeatherUnavailable`, plus a database error of the budget bookkeeping.
#[derive(Debug, thiserror::Error)]
pub enum GoogleLiveError {
    /// No key, budget used up, outside the daytime window, or Google failed with nothing cached.
    #[error("{0}")]
    Unavailable(String),
    #[error(transparent)]
    Service(#[from] ServiceError),
}

/// The settings `GoogleWeatherLive` / `live_plant` read (Python `settings.google_weather_*`).
#[derive(Debug, Clone)]
pub struct GoogleLiveConfig {
    /// `GOOGLE_WEATHER_API_KEY` (empty = not configured)
    pub api_key: String,
    /// `GOOGLE_WEATHER_BASE_URL`
    pub base_url: String,
    /// `GOOGLE_WEATHER_LIVE_TTL_S` (1800)
    pub ttl_s: f64,
    /// `GOOGLE_WEATHER_MONTHLY_BUDGET` (30000)
    pub monthly_budget: i64,
    /// cell size and the daytime window
    pub cells: GoogleWeatherConfig,
}

type NowLocal = Arc<dyn Fn() -> NaiveDateTime + Send + Sync>;

/// Port of `GoogleWeatherLive`: current conditions per cell, cached in memory only (never SQL /
/// Firestore). A failed or over-budget call serves the last value as stale.
pub struct GoogleWeatherLive {
    cfg: GoogleLiveConfig,
    client: Option<Arc<GoogleWeatherClient>>,
    cooldown_s: f64,
    clock: Clock,
    now_local: NowLocal,
    /// cell key -> (clock_ts, wall, data) (`cache_map("gweather", ttl_index=None, fixed_ttl_s=ttl)`)
    cache: TieredMap<CacheEntry>,
    cooldown_until: TieredMap<f64>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl std::fmt::Debug for GoogleWeatherLive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleWeatherLive").field("ttl_s", &self.cfg.ttl_s).finish_non_exhaustive()
    }
}

/// Plant-local now (Asia/Bangkok, UTC+7, no DST).
pub fn plant_now() -> NaiveDateTime {
    (Utc::now() + Duration::hours(7)).naive_utc()
}

impl GoogleWeatherLive {
    /// Python `get_google_live`: wall clock (Python uses `time.time` with Redis, `time.monotonic`
    /// without; both only measure ages here).
    pub fn new(cfg: GoogleLiveConfig, redis: Option<Arc<RedisLink>>) -> GoogleWeatherLive {
        let client = GoogleWeatherClient::new(&cfg.api_key, &cfg.base_url, tcroof_clients::google_weather::DEFAULT_TIMEOUT_S).ok().map(Arc::new);
        Self::with_parts(cfg, client, wall_clock(), Arc::new(plant_now), redis)
    }

    /// With an explicit client, clock and plant-local clock (tests).
    pub fn with_parts(
        cfg: GoogleLiveConfig,
        client: Option<Arc<GoogleWeatherClient>>,
        clock: Clock,
        now_local: NowLocal,
        redis: Option<Arc<RedisLink>>,
    ) -> GoogleWeatherLive {
        let cache = cache_map("gweather", redis.clone(), cfg.ttl_s);
        let cooldown_until = cooldown_map("gweather-cooldown", redis, Arc::clone(&clock));
        GoogleWeatherLive { cfg, client, cooldown_s: COOLDOWN_S, clock, now_local, cache, cooldown_until, locks: Mutex::new(HashMap::new()) }
    }

    pub fn config(&self) -> &GoogleLiveConfig {
        &self.cfg
    }

    fn key_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|p| p.into_inner());
        Arc::clone(locks.entry(key.to_owned()).or_default())
    }

    /// Python `_env`
    fn env(wall: DateTime<Utc>, data: &Value, stale: bool, error: Option<&str>, refresh: f64) -> Value {
        json!({
            "source": "live",
            "fetched_at": isoformat_utc(wall),
            "stale": stale,
            "error": error,
            "refresh_in_s": round_int(refresh).max(15),
            "data": data,
        })
    }

    /// Python `_until_window`: seconds until the daytime window opens; 0 while it is open.
    fn until_window(&self) -> f64 {
        let local = (self.now_local)();
        let (start, end) = (self.cfg.cells.day_start_h, self.cfg.cells.day_end_h);
        let hour = i64::from(local.hour());
        if start <= hour && hour < end {
            return 0.0;
        }
        let Some(open_t) = u32::try_from(start).ok().and_then(|h| NaiveTime::from_hms_opt(h, 0, 0)) else { return 0.0 };
        let mut opens = local.date().and_time(open_t);
        if hour >= end {
            opens += Duration::days(1);
        }
        (opens - local).num_microseconds().unwrap_or(0) as f64 / 1e6
    }

    fn fresh(&self, hit: &Option<CacheEntry>, now: f64) -> Option<Value> {
        let h = hit.as_ref()?;
        (now - h.stored_at < self.cfg.ttl_s).then(|| Self::env(h.wall, &h.data, false, None, self.cfg.ttl_s - (now - h.stored_at)))
    }

    /// Python `GoogleWeatherLive.current` with `reserve_call = reserve(db, API_CURRENT)`: the
    /// cell's current conditions, at most once per TTL. Outside the daytime window Google is not
    /// called: the last value (stale) or unavailable.
    pub async fn current(&self, pool: &PgPool, key: &str, lat: f64, lon: f64) -> std::result::Result<Value, GoogleLiveError> {
        let hit = self.cache.get(key).await;
        if let Some(env) = self.fresh(&hit, (self.clock)()) {
            return Ok(env);
        }
        let wait = self.until_window();
        if wait > 0.0 {
            let msg = format!(
                "Google Weather live runs {:02}:00–{:02}:00 (plant time)",
                self.cfg.cells.day_start_h, self.cfg.cells.day_end_h
            );
            return match hit {
                Some(h) => Ok(Self::env(h.wall, &h.data, true, Some(&msg), wait)),
                None => Err(GoogleLiveError::Unavailable(msg)),
            };
        }
        let lock = self.key_lock(key);
        let _guard = lock.lock().await;
        let hit = self.cache.get(key).await;
        let now = (self.clock)();
        if let Some(env) = self.fresh(&hit, now) {
            return Ok(env);
        }
        let mut cooldown = self.cooldown_until.get(key).await.unwrap_or(0.0) - now;
        let error: String;
        if cooldown > 0.0 {
            error = "Google Weather cooldown after an error".into();
        } else if !reserve(pool, self.cfg.monthly_budget, self.cfg.cells.cell_deg, API_CURRENT).await? {
            error = "Google Weather call budget for today used up (monthly free tier)".into();
            self.cooldown_until.set(key, now + self.cooldown_s).await;
            cooldown = self.cooldown_s;
        } else {
            let Some(client) = &self.client else {
                return Err(GoogleLiveError::Unavailable("GOOGLE_WEATHER_API_KEY is not set".into()));
            };
            match client.current(lat, lon).await {
                Err(e) => {
                    error = e.to_string();
                    self.cooldown_until.set(key, now + self.cooldown_s).await;
                    cooldown = self.cooldown_s;
                }
                Ok(cur) => {
                    let data = serde_json::to_value(&cur).unwrap_or(Value::Null);
                    let wall = Utc::now();
                    self.cache.set(key, CacheEntry { stored_at: now, wall, data: data.clone(), ttl_s: None }).await;
                    self.cooldown_until.pop(key).await;
                    return Ok(Self::env(wall, &data, false, None, self.cfg.ttl_s));
                }
            }
        }
        match hit {
            Some(h) => Ok(Self::env(h.wall, &h.data, true, Some(&error), cooldown)),
            None => Err(GoogleLiveError::Unavailable(error)),
        }
    }
}

/// Python `live_plant`: current conditions for one plant's cell (modelled).
pub async fn live_plant(pool: &PgPool, plant: &Plant, live: &GoogleWeatherLive) -> std::result::Result<Value, GoogleLiveError> {
    if live.cfg.api_key.is_empty() {
        return Err(GoogleLiveError::Unavailable("Google Weather is not configured (GOOGLE_WEATHER_API_KEY)".into()));
    }
    let Some((key, lat, lon)) = plant_cell(plant, &live.cfg.cells) else {
        return Err(GoogleLiveError::Unavailable("plant has no coordinates".into()));
    };
    let mut env = live.current(pool, &key, lat, lon).await?;
    let mut data = serde_json::Map::new();
    data.insert("plant_id".into(), json!(plant.plant_id));
    data.insert("provider".into(), json!(SOURCE));
    data.insert("modelled".into(), json!(true));
    data.insert("cell".into(), json!({"key": key, "latitude": lat, "longitude": lon}));
    if let Value::Object(cur) = env["data"].take() {
        data.extend(cur);
    }
    env["data"] = Value::Object(data);
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn pacific_date_follows_us_dst() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        // PST in winter: 07:59 UTC is still the day before
        assert_eq!(pacific_date(utc("2026-01-15T07:59:00Z")), d(2026, 1, 14));
        assert_eq!(pacific_date(utc("2026-01-15T08:00:00Z")), d(2026, 1, 15));
        // PDT in summer: 07:00 UTC is midnight
        assert_eq!(pacific_date(utc("2026-07-01T06:59:00Z")), d(2026, 6, 30));
        assert_eq!(pacific_date(utc("2026-07-01T07:00:00Z")), d(2026, 7, 1));
        // 2026: DST from Sunday 8 March 10:00 UTC to Sunday 1 November 09:00 UTC
        assert_eq!(nth_weekday(2026, 3, Weekday::Sun, 2), d(2026, 3, 8));
        assert_eq!(nth_weekday(2026, 11, Weekday::Sun, 1), d(2026, 11, 1));
        assert_eq!(pacific_date(utc("2026-11-27T07:30:00Z")), d(2026, 11, 26));
        assert_eq!(pacific_date(utc("2026-11-27T08:00:00Z")), d(2026, 11, 27));
    }

    #[test]
    fn month_bounds() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        assert_eq!(month(d(2026, 11, 27)), (d(2026, 11, 1), d(2026, 12, 1)));
        assert_eq!(month(d(2026, 12, 31)), (d(2026, 12, 1), d(2027, 1, 1)));
        assert_eq!(month(d(2028, 2, 29)), (d(2028, 2, 1), d(2028, 3, 1)));
    }

    fn live(day_start_h: i64, day_end_h: i64, local: &str) -> GoogleWeatherLive {
        let local = NaiveDateTime::parse_from_str(local, "%Y-%m-%d %H:%M:%S").unwrap();
        let cfg = GoogleLiveConfig {
            api_key: "k".into(),
            base_url: "http://127.0.0.1:1/".into(),
            ttl_s: 1800.0,
            monthly_budget: 30000,
            cells: GoogleWeatherConfig { configured: true, cell_deg: 0.01, day_start_h, day_end_h },
        };
        GoogleWeatherLive::with_parts(cfg, None, Arc::new(|| 1000.0), Arc::new(move || local), None)
    }

    #[test]
    fn until_window() {
        assert_eq!(live(6, 18, "2026-11-27 12:00:00").until_window(), 0.0);
        assert_eq!(live(6, 18, "2026-11-27 05:30:00").until_window(), 1800.0);
        assert_eq!(live(6, 18, "2026-11-27 23:00:00").until_window(), 7.0 * 3600.0);
        assert_eq!(live(0, 24, "2026-11-27 23:59:00").until_window(), 0.0);
    }

    #[test]
    fn envelope_rounding() {
        let w = utc("2026-11-27T03:04:05Z");
        let e = GoogleWeatherLive::env(w, &json!({}), true, Some("x"), 2.5);
        assert_eq!(e["refresh_in_s"], json!(15));
        assert_eq!(e["fetched_at"], json!("2026-11-27T03:04:05+00:00"));
        let e = GoogleWeatherLive::env(w, &json!({}), false, None, 100.5);
        assert_eq!(e["refresh_in_s"], json!(100));
    }
}
