//! Port of `backend/app/services/longdo_weather.py`: Longdo rain radar for the Plant Map (radar
//! snapshots, rain over one plant now and +15 / +30 min, rain now over the fleet).
//!
//! Memory only (mirrored in Redis when configured, same map names and keys as Python: `longdo` /
//! `longdo-cooldown`, keyed by plain strings such as `'frames'`, `'rain:13.76,100.50'`), never
//! stored; SQL gets only the call count (`external_api_call_counts`, api `longdo`, per Bangkok
//! day). Same envelope as the Growatt live service. A failed call serves the last value as stale
//! and waits `cooldown_s` before the next try.
//!
//! **Radar-derived, not measured**: every answer says `radar: true`.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{Duration, NaiveDate, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::longdo_weather::{LongdoWeatherClient, LongdoWeatherError, ATTRIBUTION, TILE_MAX_ZOOM, TILE_MIN_ZOOM};

use crate::common::{isoformat_utc, Plant, ServiceError};
use crate::google_weather_live::{calls, month, record_calls};
use crate::google_weather_stored::{plant_cell, GoogleWeatherConfig};
use crate::live::{round_int, run_bounded, BoxFut};
use crate::live_store::{cooldown_map, wall_clock, Clock, Mirrored, RedisLink, TieredMap, STALE_KEEP_S};

/// Python `SOURCE`
pub const SOURCE: &str = "Longdo Map weather radar";
/// Python `LEGEND_TTL_S` (static)
pub const LEGEND_TTL_S: f64 = 86400.0;
/// Python `SWEEP_WORKERS`
pub const SWEEP_WORKERS: usize = 8;
/// Python `API`: keyed JSON calls the backend makes (not the browser's tiles)
pub const API: &str = "longdo";
/// Python `REGION_DEG`: fleet rain asks one `area` per 1° square that holds a plant ...
pub const REGION_DEG: f64 = 1.0;
/// Python `REGION_RADIUS_KM`: ... over the circle that covers it
pub const REGION_RADIUS_KM: f64 = 80.0;
/// Python `LongdoLive.__init__` default `cooldown_s`
pub const COOLDOWN_S: f64 = 60.0;

/// Python `LongdoUnavailable` (with `retry_s`), plus a database error of the budget bookkeeping.
#[derive(Debug, thiserror::Error)]
pub enum LongdoError {
    #[error("{message}")]
    Unavailable { message: String, retry_s: f64 },
    #[error(transparent)]
    Service(#[from] ServiceError),
}

impl From<sqlx::Error> for LongdoError {
    fn from(e: sqlx::Error) -> Self {
        LongdoError::Service(ServiceError::Db(e))
    }
}

fn unavailable(message: impl Into<String>, retry_s: f64) -> LongdoError {
    LongdoError::Unavailable { message: message.into(), retry_s }
}

pub type LongdoResult<T> = std::result::Result<T, LongdoError>;

/// The settings this module reads (Python `settings.longdo_*`).
#[derive(Debug, Clone)]
pub struct LongdoConfig {
    /// `LONGDO_API_KEY` (empty = off)
    pub api_key: String,
    pub base_url: String,
    pub timeout_s: f64,
    pub monthly_budget: i64,
    pub calls_per_min: i64,
    pub interactive_reserve_per_min: i64,
    pub radar_ttl_s: f64,
    pub rain_ttl_s: f64,
    pub area_radius_km: f64,
    pub fleet_rain_ttl_s: f64,
    pub rain_sweep_per_request: i64,
    /// Google Weather grid cells: plants of one ~1 km cell share a lookup
    pub cells: GoogleWeatherConfig,
}

/// Python `enabled`
pub fn enabled(cfg: &LongdoConfig) -> bool {
    !cfg.api_key.is_empty()
}

// --------------------------------------------------------------------------- cache entry

/// One cache entry of the Longdo and RainViewer maps: Python's tuple `(clock_ts, wall iso, data,
/// ttl_s)`. Unlike [`crate::live_store::CacheEntry`] the wall time is a plain ISO string (Python
/// stores `datetime.now(timezone.utc).isoformat()`), so it is packed untagged.
#[derive(Debug, Clone, PartialEq)]
pub struct StrEntry {
    pub stored_at: f64,
    pub wall: String,
    pub data: Value,
    pub ttl_s: f64,
}

impl Mirrored for StrEntry {
    fn pack(&self) -> Value {
        json!({"__t__": [self.stored_at, self.wall, self.data, self.ttl_s]})
    }
    fn unpack(v: &Value) -> Option<Self> {
        let t = v.as_object()?.get("__t__")?.as_array()?;
        if t.len() != 4 {
            return None;
        }
        Some(StrEntry {
            stored_at: t[0].as_f64()?,
            wall: t[1].as_str()?.to_owned(),
            data: crate::live_store::unpack(&t[2]),
            ttl_s: t[3].as_f64()?,
        })
    }
}

/// Python `cache_map(name, link, ttl_index=3)` for [`StrEntry`]s.
pub fn str_cache_map(name: &str, link: Option<Arc<RedisLink>>) -> TieredMap<StrEntry> {
    TieredMap::new(name, link, |e: &StrEntry| e.ttl_s + STALE_KEEP_S)
}

/// Python `_env` of `LongdoLive` / `RainViewerLive`
pub fn env(wall: &str, data: &Value, stale: bool, error: Option<&str>, refresh: f64) -> Value {
    json!({
        "source": "live",
        "fetched_at": wall,
        "stale": stale,
        "error": error,
        "refresh_in_s": round_int(refresh).max(15),
        "data": data,
    })
}

/// `datetime.now(timezone.utc).isoformat()`
pub fn now_iso() -> String {
    isoformat_utc(Utc::now())
}

// --------------------------------------------------------------------------- call budget

/// Python `_today`: plant-local (Bangkok) day.
fn today() -> NaiveDate {
    (Utc::now() + Duration::hours(7)).date_naive()
}

/// Python `used`
pub async fn used(pool: &PgPool, start: NaiveDate, end: NaiveDate) -> LongdoResult<i64> {
    Ok(calls(pool, start, end, Some(API)).await?)
}

/// Python `allowance`: what is left of `LONGDO_MONTHLY_BUDGET` spread over the days left.
pub async fn allowance(pool: &PgPool, cfg: &LongdoConfig, day: NaiveDate) -> LongdoResult<i64> {
    let (first, next) = month(day);
    Ok((cfg.monthly_budget - used(pool, first, day).await?).div_euclid((next - day).num_days()).max(0))
}

/// Python `reserve`: count up to `n` calls now; how many today's allowance still had room for.
pub async fn reserve(pool: &PgPool, cfg: &LongdoConfig, n: i64) -> LongdoResult<i64> {
    let d = today();
    let left = allowance(pool, cfg, d).await? - used(pool, d, d + Duration::days(1)).await?;
    let granted = n.min(left).max(0);
    record_calls(pool, API, granted, d).await?;
    Ok(granted)
}

/// Python `usage`
pub async fn usage(pool: &PgPool, cfg: &LongdoConfig) -> LongdoResult<Value> {
    let d = today();
    let (first, next) = month(d);
    Ok(json!({
        "monthly_budget": cfg.monthly_budget,
        "used_this_month": used(pool, first, next).await?,
        "allowance_today": allowance(pool, cfg, d).await?,
        "used_today": used(pool, d, d + Duration::days(1)).await?,
    }))
}

// --------------------------------------------------------------------------- LongdoLive

/// Port of `LongdoLive`: the memory cache, per-key cooldowns and the per-minute call limit.
pub struct LongdoLive {
    pub cfg: LongdoConfig,
    client: Option<Arc<LongdoWeatherClient>>,
    pub cooldown_s: f64,
    clock: Clock,
    /// Instants of the calls of the last minute (in-process, as Python's `deque`)
    recent: Mutex<VecDeque<Instant>>,
    cache: TieredMap<StrEntry>,
    cooldown_until: TieredMap<f64>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl std::fmt::Debug for LongdoLive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LongdoLive").field("enabled", &self.client.is_some()).finish_non_exhaustive()
    }
}

impl LongdoLive {
    /// Python `get_longdo_live`
    pub fn new(cfg: LongdoConfig, redis: Option<Arc<RedisLink>>) -> LongdoLive {
        let client = LongdoWeatherClient::new(&cfg.api_key, &cfg.base_url, cfg.timeout_s).ok().map(Arc::new);
        Self::with_parts(cfg, client, wall_clock(), redis)
    }

    pub fn with_parts(cfg: LongdoConfig, client: Option<Arc<LongdoWeatherClient>>, clock: Clock, redis: Option<Arc<RedisLink>>) -> LongdoLive {
        LongdoLive {
            cfg,
            client,
            cooldown_s: COOLDOWN_S,
            cache: str_cache_map("longdo", redis.clone()),
            cooldown_until: cooldown_map("longdo-cooldown", redis, Arc::clone(&clock)),
            clock,
            recent: Mutex::new(VecDeque::new()),
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn calls_per_min(&self) -> i64 {
        self.cfg.calls_per_min
    }

    /// The client (None without a key; every route checks [`enabled`] first).
    pub fn client(&self) -> Option<&Arc<LongdoWeatherClient>> {
        self.client.as_ref()
    }

    fn key_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|p| p.into_inner());
        Arc::clone(locks.entry(key.to_owned()).or_default())
    }

    /// Python `take`: up to `n` call slots of this minute's rate limit; how many were free.
    /// `keep` slots are left untouched (the fleet sweep leaves them for what the user looks at).
    pub fn take(&self, n: i64, keep: i64) -> i64 {
        let mut recent = self.recent.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        while recent.front().is_some_and(|t| now.duration_since(*t).as_secs_f64() >= 60.0) {
            recent.pop_front();
        }
        let granted = n.min(self.cfg.calls_per_min - keep - recent.len() as i64).max(0);
        for _ in 0..granted {
            recent.push_back(now);
        }
        granted
    }

    /// Python `peek`: (age_s, fetched_at, data) of a cached key, however old; never calls Longdo.
    pub async fn peek(&self, key: &str) -> Option<(f64, String, Value)> {
        let hit = self.cache.get(key).await?;
        Some(((self.clock)() - hit.stored_at, hit.wall, hit.data))
    }

    async fn fresh(&self, key: &str, ttl_s: f64) -> Option<Value> {
        let hit = self.cache.get(key).await?;
        let age = (self.clock)() - hit.stored_at;
        (age < ttl_s).then(|| env(&hit.wall, &hit.data, false, None, ttl_s - age))
    }

    /// Python `cached`: `fetch(client)`'s answer, at most once per `ttl_s`. `calls` = keyed HTTP
    /// calls `fetch` makes: they must fit this minute's rate limit and, with `budget`, today's
    /// budget; else the last value is served as stale. `calls = 0`: the caller took its slots.
    pub async fn cached<F, Fut>(&self, key: &str, ttl_s: f64, fetch: F, calls: i64, budget: Option<&PgPool>) -> LongdoResult<Value>
    where
        F: FnOnce(Arc<LongdoWeatherClient>) -> Fut,
        Fut: Future<Output = Result<Value, LongdoWeatherError>>,
    {
        if let Some(env) = self.fresh(key, ttl_s).await {
            return Ok(env);
        }
        let lock = self.key_lock(key);
        let _guard = lock.lock().await;
        if let Some(env) = self.fresh(key, ttl_s).await {
            return Ok(env);
        }
        let now = (self.clock)();
        let mut wait = self.cooldown_until.get(key).await.unwrap_or(0.0) - now;
        let error: String;
        if wait > 0.0 {
            error = "Longdo cooldown after an error".into();
        } else if calls != 0 && self.take(calls, 0) < calls {
            error = format!("Longdo rate limit ({} calls/min) reached, retrying shortly", self.cfg.calls_per_min);
            wait = 20.0;
        } else if calls != 0 && budget.is_some() && reserve(budget.expect("checked"), &self.cfg, calls).await? < calls {
            error = "Longdo call budget for today used up (monthly limit)".into();
            wait = 600.0;
        } else {
            let res = match &self.client {
                Some(c) => fetch(Arc::clone(c)).await,
                None => Err(LongdoWeatherError { message: "LONGDO_API_KEY is not set".into(), status: None }),
            };
            match res {
                Err(e) => {
                    error = e.to_string();
                    wait = self.cooldown_s;
                    self.cooldown_until.set(key, now + wait).await;
                }
                Ok(data) => {
                    let wall = now_iso();
                    self.cache.set(key, StrEntry { stored_at: now, wall: wall.clone(), data: data.clone(), ttl_s }).await;
                    self.cooldown_until.pop(key).await;
                    return Ok(env(&wall, &data, false, None, ttl_s));
                }
            }
        }
        match self.cache.get(key).await {
            Some(hit) => Ok(env(&hit.wall, &hit.data, true, Some(&error), wait)),
            None => Err(unavailable(error, wait)),
        }
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// Python `_require`
fn require(cfg: &LongdoConfig) -> LongdoResult<()> {
    if enabled(cfg) {
        Ok(())
    } else {
        Err(unavailable("Longdo rain radar is not configured (LONGDO_API_KEY)", 60.0))
    }
}

/// Python `radar`: radar snapshots (Unix times, oldest first), the tile URL template and the legend.
pub async fn radar(pool: &PgPool, live: &LongdoLive) -> LongdoResult<Value> {
    require(&live.cfg)?;
    let mut env =
        live.cached("frames", live.cfg.radar_ttl_s, |c| async move { c.frames().await.map(to_value) }, 1, Some(pool)).await?;
    let legend = match live.cached("legend", LEGEND_TTL_S, |c| async move { c.legend().await.map(to_value) }, 0, None).await {
        Ok(e) => e["data"].clone(),
        Err(LongdoError::Unavailable { .. }) => json!([]), // no legend rather than made-up colours
        Err(e) => return Err(e),
    };
    let tile_url = live.client().map(|c| c.tile_url()).unwrap_or_default();
    let frames = env["data"].take();
    env["data"] = json!({
        "provider": SOURCE,
        "radar": true,
        "frames": frames,
        // carries the key: a Longdo Map key is a browser key, restricted by domain at Longdo
        "tile_url": tile_url,
        "min_zoom": TILE_MIN_ZOOM,
        "max_zoom": TILE_MAX_ZOOM,
        "attribution": ATTRIBUTION,
        "legend": legend,
        "point_rain": true,
        "fallback_reason": null,
    });
    Ok(env)
}

/// `"; ".join(dict.fromkeys(items))`: joined, duplicates dropped, first order kept.
fn join_unique(items: &[String]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for i in items {
        if !seen.contains(&i.as_str()) {
            seen.push(i);
        }
    }
    seen.join("; ")
}

/// Python `plant_rain`: radar rain class over the plant now and the +15 / +30 min nowcast, plus
/// rain within `LONGDO_AREA_RADIUS_KM`. Two cached parts of 2 calls each (point, area); a part the
/// rate limit, a cooldown or the budget holds back gives `stale` with the reason in `error` and
/// null values. While the point part waits, "now" comes from the fleet sweep (`now_via: "sweep"`).
pub async fn plant_rain(pool: &PgPool, plant: &Plant, live: &LongdoLive) -> LongdoResult<Value> {
    require(&live.cfg)?;
    let Some((key, lat, lon)) = plant_cell(plant, &live.cfg.cells) else {
        return Err(unavailable("plant has no coordinates", 60.0));
    };
    let radius = live.cfg.area_radius_km;
    let ttl = live.cfg.rain_ttl_s;

    let mut held: Vec<String> = Vec::new();
    let mut waits: Vec<f64> = Vec::new();
    let mut part = |res: LongdoResult<Value>, held: &mut Vec<String>| -> LongdoResult<Option<Value>> {
        match res {
            Ok(env) => {
                if let Some(e) = env["error"].as_str() {
                    held.push(e.to_owned());
                }
                waits.push(env["refresh_in_s"].as_f64().unwrap_or(15.0));
                Ok(Some(env))
            }
            Err(LongdoError::Unavailable { message, retry_s }) => {
                held.push(message);
                waits.push(retry_s);
                Ok(None)
            }
            Err(e) => Err(e),
        }
    };

    let fetch_point = move |c: Arc<LongdoWeatherClient>| async move {
        let now = c.rain_at(lat, lon).await?;
        let (forecast, forecast_error) = match c.forecast_at(lat, lon).await {
            Ok(f) => (to_value(f), Value::Null),
            // the nowcast is optional: "now" is still served
            Err(e) => (json!([]), json!(e.to_string())),
        };
        Ok(json!({"now": now, "forecast": forecast, "forecast_error": forecast_error}))
    };
    let fetch_area = move |c: Arc<LongdoWeatherClient>| async move {
        let now = c.area_at(lat, lon, radius).await?;
        let forecast = c.forecast_area_at(lat, lon, radius).await?;
        Ok(json!({"now": now, "forecast": forecast}))
    };
    let point = part(live.cached(&format!("rain:{key}"), ttl, fetch_point, 2, Some(pool)).await, &mut held)?;
    let area = part(live.cached(&format!("rain-area:{key}"), ttl, fetch_area, 2, Some(pool)).await, &mut held)?;

    let (mut fetched_at, mut via) = match &point {
        Some(p) => (p["fetched_at"].clone(), json!("point")),
        None => (Value::Null, Value::Null),
    };
    let mut values: Map<String, Value> = match &point {
        Some(p) => p["data"].as_object().cloned().unwrap_or_default(),
        None => [("now".to_owned(), Value::Null), ("forecast".to_owned(), json!([])), ("forecast_error".to_owned(), Value::Null)]
            .into_iter()
            .collect(),
    };
    if point.is_none() {
        if let Some((wall, rain)) = swept_now(live, &key, lat, lon).await {
            fetched_at = json!(wall);
            values.insert("now".into(), rain);
            via = json!("sweep");
        }
    }
    if !held.is_empty() {
        tracing::info!("Longdo rain for plant {} (cell {}) held back: {}", plant.plant_id, key, join_unique(&held));
    }
    let min_wait = waits.iter().copied().fold(f64::INFINITY, f64::min);
    let mut data = Map::new();
    data.insert("plant_id".into(), json!(plant.plant_id));
    data.insert("provider".into(), json!(SOURCE));
    data.insert("radar".into(), json!(true));
    data.insert("cell".into(), json!({"key": key, "latitude": lat, "longitude": lon}));
    data.extend(values);
    data.insert("now_via".into(), via);
    data.insert(
        "area".into(),
        json!({
            "radius_km": radius,
            "now": area.as_ref().map_or(Value::Null, |a| a["data"]["now"].clone()),
            "forecast": area.as_ref().map_or(json!([]), |a| a["data"]["forecast"].clone()),
            "error": if area.is_some() { Value::Null } else { json!(held.last()) },
        }),
    );
    let error = join_unique(&held);
    Ok(json!({
        "source": "live",
        "fetched_at": fetched_at,
        "stale": !held.is_empty(),
        "error": if error.is_empty() { Value::Null } else { json!(error) },
        "refresh_in_s": round_int(min_wait).max(15),
        "data": data,
    }))
}

/// Python `DRY`: "no rain" from a region with no rain pixel.
fn dry() -> Value {
    json!({"intensity": 0, "description": null})
}

/// Python truthiness of a cached JSON value (`point[2]`).
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python `_swept_now`: (fetched_at, rain) the fleet sweep holds for a cell, if not older than its
/// TTL: the cell's own `location` answer, or "no rain" from a region with no rain pixel.
async fn swept_now(live: &LongdoLive, cell_key: &str, lat: f64, lon: f64) -> Option<(String, Value)> {
    let ttl = live.cfg.fleet_rain_ttl_s;
    let point = live.peek(&format!("now:{cell_key}")).await;
    let region = live.peek(&format!("region:{}", region_of(lat, lon).0)).await;
    if let Some((age, wall, stats)) = &region {
        if *age < ttl && !wet(stats) && point.as_ref().is_none_or(|p| *age <= p.0) {
            return Some((wall.clone(), dry()));
        }
    }
    match point {
        Some((age, wall, rain)) if age < ttl && truthy(&rain) => Some((wall, rain)),
        _ => None,
    }
}

// --------------------------------------------------------------------------- fleet rain (swept)

/// Python `_region`: (key, lat, lon) of the 1° square a point rounds to.
pub fn region_of(lat: f64, lon: f64) -> (String, f64, f64) {
    let rlat = (lat / REGION_DEG).round_ties_even() * REGION_DEG;
    let rlon = (lon / REGION_DEG).round_ties_even() * REGION_DEG;
    (format!("{rlat:.0},{rlon:.0}"), rlat, rlon)
}

/// Python `_wet`: rain somewhere in the region's circle; unknown stats count as wet.
pub fn wet(stats: &Value) -> bool {
    let Some(max) = stats.get("max_intensity").filter(|v| !v.is_null()) else { return true };
    let cov = stats.get("coverage_pct").and_then(Value::as_f64).unwrap_or(0.0);
    max.as_f64().unwrap_or(0.0) > 0.0 || cov > 0.0
}

/// An insertion-ordered map (Python dict) of string keys.
struct Ordered<V> {
    keys: Vec<String>,
    map: HashMap<String, V>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Ordered { keys: Vec::new(), map: HashMap::new() }
    }
    fn insert(&mut self, k: String, v: V) {
        if !self.map.contains_key(&k) {
            self.keys.push(k.clone());
        }
        self.map.insert(k, v);
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.keys.iter().map(|k| (k, &self.map[k]))
    }
}

/// Python `fleet_rain`: radar rain class now over every plant the user may see (`allowed` None =
/// all). One `area` call per 1° region; a region with no rain pixel answers 0 for its plants
/// (`via: "area"`), only plants in a region with rain get a `location` call per cell
/// (`via: "point"`). At most `LONGDO_RAIN_SWEEP_PER_REQUEST` calls per request, due regions first,
/// oldest first. A plant not checked yet has `checked: false` and `rain: null`, never "no rain".
pub async fn fleet_rain(pool: &PgPool, live: &Arc<LongdoLive>, allowed: Option<&std::collections::HashSet<i64>>) -> LongdoResult<Value> {
    require(&live.cfg)?;
    let ttl = live.cfg.fleet_rain_ttl_s;
    let rows: Vec<(i32, Option<f64>, Option<f64>)> =
        sqlx::query_as("SELECT plant_id, latitude, longitude FROM growatt_plants ORDER BY plant_id").fetch_all(pool).await?;
    let mut plants: Vec<(i64, Option<String>, Option<String>)> = Vec::new();
    let mut regions: Ordered<(f64, f64)> = Ordered::new();
    let mut cells: Ordered<(f64, f64, String)> = Ordered::new();
    for (pid, lat, lon) in rows {
        let pid = i64::from(pid);
        if allowed.is_some_and(|a| !a.contains(&pid)) {
            continue;
        }
        let cell = match (lat, lon) {
            (Some(la), Some(lo)) => Some(crate::google_weather_stored::cell_of(la, lo, live.cfg.cells.cell_deg)),
            _ => None,
        };
        // 0,0 is Growatt's "not set"
        let Some((ck, clat, clon)) = cell.filter(|c| !(c.1 == 0.0 && c.2 == 0.0)) else {
            plants.push((pid, None, None));
            continue;
        };
        let (rk, rlat, rlon) = region_of(clat, clon);
        regions.insert(rk.clone(), (rlat, rlon));
        cells.insert(ck.clone(), (clat, clon, rk.clone()));
        plants.push((pid, Some(rk), Some(ck)));
    }

    let mut slots = live.cfg.rain_sweep_per_request.max(1);
    let mut blocked: Vec<String> = Vec::new();
    let region_keys: Vec<String> = {
        let mut out = Vec::new();
        for (rk, _) in regions.iter() {
            let k = format!("region:{rk}");
            if age(live, &k).await >= ttl {
                out.push(k);
            }
        }
        out
    };
    run(pool, live, &regions, &cells, region_keys, &mut blocked, &mut slots).await?;
    let cell_keys = due_cells(live, &cells, ttl).await;
    run(pool, live, &regions, &cells, cell_keys, &mut blocked, &mut slots).await?;

    let mut out_rows = Vec::new();
    let (mut checked, mut raining, mut oldest) = (0i64, 0i64, 0.0f64);
    for (plant_id, rk, ck) in &plants {
        let region = match rk {
            Some(rk) => live.peek(&format!("region:{rk}")).await,
            None => None,
        };
        let point = match ck {
            Some(ck) => live.peek(&format!("now:{ck}")).await,
            None => None,
        };
        let mut hit: Option<(f64, String, Value)> = None;
        let mut via = Value::Null;
        match (&region, &point) {
            (Some(r), _) if !wet(&r.2) && point.as_ref().is_none_or(|p| r.0 <= p.0) => {
                hit = Some((r.0, r.1.clone(), dry()));
                via = json!("area");
            }
            (_, Some(p)) => {
                hit = Some(p.clone());
                via = json!("point");
            }
            _ => {}
        }
        let rain = hit.as_ref().map_or(Value::Null, |h| h.2.clone());
        if let Some(h) = &hit {
            checked += 1;
            oldest = oldest.max(h.0);
            if truthy(&rain) && rain.get("intensity").and_then(Value::as_f64).unwrap_or(0.0) > 0.0 {
                raining += 1;
            }
        }
        out_rows.push(json!({
            "plant_id": plant_id,
            "checked": hit.is_some(),
            "rain": rain,
            "via": via,
            "fetched_at": hit.as_ref().map(|h| h.1.clone()),
        }));
    }
    let mut pending = 0usize;
    for (rk, _) in regions.iter() {
        if age(live, &format!("region:{rk}")).await >= ttl {
            pending += 1;
        }
    }
    pending += due_cells(live, &cells, ttl).await.len();
    let error = join_unique(&blocked);
    let refresh = if pending > 0 {
        if blocked.is_empty() {
            15
        } else {
            60
        }
    } else {
        round_int(ttl - oldest).max(15)
    };
    Ok(json!({
        "source": "live",
        "fetched_at": now_iso(),
        "stale": !blocked.is_empty(),
        "error": if error.is_empty() { Value::Null } else { json!(error) },
        "refresh_in_s": refresh,
        "data": {
            "provider": SOURCE,
            "radar": true,
            "plants": out_rows,
            "located": plants.iter().filter(|p| p.1.is_some()).count(),
            "checked": checked,
            "raining": raining,
            "usage": usage(pool, &live.cfg).await?,
        },
    }))
}

/// `fleet_rain.age`: seconds since the key was fetched, infinite when never.
async fn age(live: &LongdoLive, key: &str) -> f64 {
    live.peek(key).await.map_or(f64::INFINITY, |h| h.0)
}

/// `fleet_rain.due_cells`: cells of a fresh, wet region whose own answer is due.
async fn due_cells(live: &LongdoLive, cells: &Ordered<(f64, f64, String)>, ttl: f64) -> Vec<String> {
    let mut out = Vec::new();
    for (ck, (_, _, rk)) in cells.iter() {
        if let Some((a, _, stats)) = live.peek(&format!("region:{rk}")).await {
            let k = format!("now:{ck}");
            if a < ttl && wet(&stats) && age(live, &k).await >= ttl {
                out.push(k);
            }
        }
    }
    out
}

/// `fleet_rain.run`: fetch the oldest of `keys` that the rate limit and the budget leave room for.
async fn run(
    pool: &PgPool,
    live: &Arc<LongdoLive>,
    regions: &Ordered<(f64, f64)>,
    cells: &Ordered<(f64, f64, String)>,
    keys: Vec<String>,
    blocked: &mut Vec<String>,
    slots: &mut i64,
) -> LongdoResult<()> {
    let mut aged: Vec<(f64, String)> = Vec::new();
    for k in keys {
        aged.push((age(live, &k).await, k));
    }
    // sorted(keys, key=age, reverse=True): stable, oldest (never fetched = inf) first
    aged.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut keys: Vec<String> = aged.into_iter().map(|(_, k)| k).take((*slots).max(0) as usize).collect();
    if keys.is_empty() {
        return Ok(());
    }
    let n = keys.len() as i64;
    let free = live.take(n, live.cfg.interactive_reserve_per_min.min(live.cfg.calls_per_min - 1));
    if free < n {
        blocked.push(format!("Longdo rate limit ({} calls/min) reached", live.cfg.calls_per_min));
    }
    let granted = if free > 0 { reserve(pool, &live.cfg, free).await? } else { 0 };
    if granted < free {
        blocked.push("Longdo call budget for today used up (monthly limit)".into());
    }
    keys.truncate(granted.max(0) as usize);
    *slots -= keys.len() as i64;
    if keys.is_empty() {
        return Ok(());
    }
    let ttl = live.cfg.fleet_rain_ttl_s;
    let mut futs: Vec<BoxFut<()>> = Vec::new();
    for key in keys {
        let live = Arc::clone(live);
        let (kind, name) = key.split_once(':').map(|(a, b)| (a.to_owned(), b.to_owned())).unwrap_or_default();
        if kind == "region" {
            let Some(&(lat, lon)) = regions.map.get(&name) else { continue };
            futs.push(Box::pin(async move {
                // stays unchecked (or keeps its old value) on failure; the cooldown spaces retries
                let _ = live.cached(&key, ttl, |c| async move { c.area_at(lat, lon, REGION_RADIUS_KM).await.map(to_value) }, 0, None).await;
            }));
        } else {
            let Some((lat, lon)) = cells.map.get(&name).map(|c| (c.0, c.1)) else { continue };
            futs.push(Box::pin(async move {
                let _ = live.cached(&key, ttl, |c| async move { c.rain_at(lat, lon).await.map(to_value) }, 0, None).await;
            }));
        }
    }
    let n = futs.len();
    run_bounded(SWEEP_WORKERS.min(n), futs).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_and_wet() {
        assert_eq!(region_of(13.76, 100.5).0, "14,100"); // round half to even: 100.5 -> 100
        assert_eq!(region_of(14.5, 101.49).0, "14,101");
        assert!(wet(&Value::Null));
        assert!(wet(&json!({"coverage_pct": 0.0, "max_intensity": null})));
        assert!(!wet(&json!({"coverage_pct": 0.0, "max_intensity": 0})));
        assert!(!wet(&json!({"coverage_pct": null, "max_intensity": 0})));
        assert!(wet(&json!({"coverage_pct": 0.5, "max_intensity": 0})));
        assert!(wet(&json!({"coverage_pct": 0.0, "max_intensity": 2})));
    }

    #[test]
    fn str_entry_in_python_encoding() {
        let e = StrEntry { stored_at: 12.5, wall: "2026-11-27T03:04:05+00:00".into(), data: json!([1, 2]), ttl_s: 300.0 };
        let text = crate::live_store::dumps(&e).unwrap();
        assert_eq!(text, r#"{"__t__":[12.5,"2026-11-27T03:04:05+00:00",[1,2],300.0]}"#);
        assert_eq!(crate::live_store::loads::<StrEntry>(&text), Some(e));
    }

    #[test]
    fn join_unique_keeps_first_order() {
        let v: Vec<String> = ["a", "b", "a"].iter().map(|s| s.to_string()).collect();
        assert_eq!(join_unique(&v), "a; b");
    }

    fn cfg() -> LongdoConfig {
        LongdoConfig {
            api_key: "k".into(),
            base_url: "http://127.0.0.1:1/".into(),
            timeout_s: 1.0,
            monthly_budget: 60000,
            calls_per_min: 5,
            interactive_reserve_per_min: 2,
            radar_ttl_s: 300.0,
            rain_ttl_s: 300.0,
            area_radius_km: 10.0,
            fleet_rain_ttl_s: 1800.0,
            rain_sweep_per_request: 20,
            cells: GoogleWeatherConfig::default(),
        }
    }

    #[test]
    fn take_counts_the_minute() {
        let live = LongdoLive::with_parts(cfg(), None, wall_clock(), None);
        assert_eq!(live.take(2, 2), 2);
        assert_eq!(live.take(5, 2), 1); // 5 - 2 kept - 2 taken
        assert_eq!(live.take(3, 0), 2); // 5 - 3 taken
        assert_eq!(live.take(1, 0), 0);
    }

    #[tokio::test]
    async fn cached_serves_stale_after_an_error() {
        let t = Arc::new(Mutex::new(1000.0f64));
        let tc = Arc::clone(&t);
        let live = LongdoLive::with_parts(cfg(), None, Arc::new(move || *tc.lock().unwrap()), None);
        // no client: the fetch fails -> cooldown, nothing cached -> unavailable
        let r = live.cached("frames", 300.0, |_c| async { Ok(json!([1])) }, 0, None).await;
        assert!(matches!(r, Err(LongdoError::Unavailable { retry_s, .. }) if retry_s == 60.0));
        // during the cooldown: still unavailable with the cooldown's wait
        let r = live.cached("frames", 300.0, |_c| async { Ok(json!([1])) }, 0, None).await;
        match r {
            Err(LongdoError::Unavailable { message, .. }) => assert_eq!(message, "Longdo cooldown after an error"),
            other => panic!("{other:?}"),
        }
        // a cached value is served stale
        live.cache.set("frames", StrEntry { stored_at: 0.0, wall: "w".into(), data: json!([9]), ttl_s: 300.0 }).await;
        let e = live.cached("frames", 300.0, |_c| async { Ok(json!([1])) }, 0, None).await.unwrap();
        assert_eq!(e["stale"], json!(true));
        assert_eq!(e["data"], json!([9]));
        assert_eq!(e["refresh_in_s"], json!(60));
        // the rate limit holds back a counted call
        *t.lock().unwrap() = 5000.0;
        live.cache.pop("frames").await;
        assert_eq!(live.take(5, 0), 5);
        let r = live.cached("frames", 300.0, |_c| async { Ok(json!([1])) }, 1, None).await;
        match r {
            Err(LongdoError::Unavailable { message, retry_s }) => {
                assert!(message.starts_with("Longdo rate limit (5 calls/min)"), "{message}");
                assert_eq!(retry_s, 20.0);
            }
            other => panic!("{other:?}"),
        }
    }
}
