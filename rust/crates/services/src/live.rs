//! Port of `backend/app/services/growatt_live/` (`core.py`, `rows.py`, `service.py`): realtime
//! Growatt data, held in process memory only (mirrored in Redis when `REDIS_URL` is set,
//! [`crate::live_store`]).
//!
//! Nothing here touches SQL or Firestore (master plan §4 rule 6: this module has no database
//! handle at all): realtime values are superseded every few minutes, so persisting them would only
//! burn write quota. The routes read the registry (which inverters / sensors a plant has) and pass
//! plain lists in.
//!
//! Every feature returns an envelope ([`envelope`]):
//!
//! ```text
//! {"source": "live", "fetched_at": iso8601, "stale": bool, "error": str | null,
//!  "refresh_in_s": int, "data": ...}
//! ```
//!
//! `stale` means Growatt failed (offline / rate-limited) and the last good value is served;
//! `refresh_in_s` is how long until asking again can return anything new (cache expiry or the end
//! of a cooldown), never below [`MIN_REFRESH_S`].
//!
//! Each project phase is its own Growatt account and token. Plant-level calls use the token of the
//! plant's phase; [`LiveService::plants`] asks every account and merges the lists.
//!
//! The building blocks are public so later live features (Google Weather, Longdo, …) and the
//! routes of the next wave can be added without touching this core: [`LiveService::get`] (TTL
//! cache + single-flight + per-key cooldown + stale fallback), [`LiveService::sweep`] (incremental
//! refresh of many keys), [`LiveService::night`] (night TTL stretching), [`LiveService::latest_ttl`]
//! (upload-rhythm expiry), [`LiveService::interval_fetch`] and [`envelope`].

pub mod rows;
pub mod string_check;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, SubsecRound, Utc};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use tcroof_clients::growatt::{
    parse_env_records, py, EnvRow, GrowattClient, GrowattClientOptions, GrowattError, ENV_FIELDS,
};
use tcroof_solar_core::sun::sun_times;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::common::isoformat_utc;
use crate::key;
use crate::live_store::{cache_map, cooldown_map, wall_clock, CacheEntry, Clock, Key, RedisLink, TieredMap};

// --------------------------------------------------------------------------- constants (core.py)

/// Python `RATE_LIMIT_CODE`
pub const RATE_LIMIT_CODE: i64 = 10012;
/// Python `MIN_REFRESH_S`: floor for `refresh_in_s`, so an expired key never invites a tight loop.
pub const MIN_REFRESH_S: i64 = 15;
/// Python `PAST_DAY_ALARM_TTL_S`: a closed day's alarm log no longer changes.
pub const PAST_DAY_ALARM_TTL_S: f64 = 6.0 * 3600.0;
/// Python `ALARM_WORKERS`: parallel `alarm_data` calls for one request.
pub const ALARM_WORKERS: usize = 8;
/// Python `LIVE_WORKERS`: parallel `max_data` calls for one plant's latest records.
pub const LIVE_WORKERS: usize = 8;
/// Python `SENSOR_DAY_TTL_S`: today's `env_data` records of one sensor.
pub const SENSOR_DAY_TTL_S: f64 = 300.0;
/// Python `SWEEP_REFRESH_S`: sweep not complete yet, ask again this soon for the next batch.
pub const SWEEP_REFRESH_S: f64 = 15.0;
/// Python `DEFAULT_INTERVAL_S`: when the upload interval can't be measured.
pub const DEFAULT_INTERVAL_S: f64 = 300.0;
/// Python `MIN_INTERVAL_S`: measured gaps outside `MIN..MAX` are outages, not the rhythm.
pub const MIN_INTERVAL_S: f64 = 30.0;
/// Python `MAX_INTERVAL_S`
pub const MAX_INTERVAL_S: f64 = 900.0;
/// Python `UPLOAD_GRACE_S`: a record reaches the Growatt cloud a little after its timestamp.
pub const UPLOAD_GRACE_S: f64 = 60.0;
/// Python `LATE_RETRY_S`: next record overdue, check again soon.
pub const LATE_RETRY_S: f64 = 60.0;
/// Python `PLANT_UTC_OFFSET_H` (Asia/Bangkok, no DST)
pub const PLANT_UTC_OFFSET_H: f64 = 7.0;
/// Python `DAYLIGHT_MARGIN_S`
pub const DAYLIGHT_MARGIN_S: f64 = 1800.0;
/// Python `FALLBACK_COORDS`: Bangkok, when no plant has coordinates.
pub const FALLBACK_COORDS: [(f64, f64); 1] = [(13.7563, 100.5018)];

/// Python `GrowattLiveService.cooldown_s` default (any refused key backs off this long; 10012 needs it).
pub const COOLDOWN_S: f64 = 60.0;

/// The plant-local (Bangkok) wall clock, naive (Python `datetime.now(PLANT_TZ).replace(tzinfo=None)`).
pub fn plant_now() -> NaiveDateTime {
    Utc::now().naive_utc() + Duration::seconds((PLANT_UTC_OFFSET_H * 3600.0) as i64)
}

/// Python `round(x)` of a float: an int, half to even.
pub fn round_int(x: f64) -> i64 {
    x.round_ties_even() as i64
}

// --------------------------------------------------------------------------- result types

/// A boxed `Send` future.
pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// One upstream call for a cache key: given the account's client, the data to cache.
pub type Fetch = Box<dyn FnOnce(GrowattClient) -> BoxFut<Result<Value, GrowattError>> + Send>;

/// `fetch(|c| async move { ... })` as a [`Fetch`].
pub fn fetch<F, Fut>(f: F) -> Fetch
where
    F: FnOnce(GrowattClient) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, GrowattError>> + Send + 'static,
{
    Box::new(move |c| Box::pin(f(c)))
}

/// Python `Ttl`: fixed seconds, or computed from the fetched data.
#[derive(Clone)]
pub enum Ttl {
    Fixed(f64),
    Of(Arc<dyn Fn(&Value) -> f64 + Send + Sync>),
}

impl Ttl {
    pub fn of(f: impl Fn(&Value) -> f64 + Send + Sync + 'static) -> Ttl {
        Ttl::Of(Arc::new(f))
    }
    fn seconds(&self, data: &Value) -> f64 {
        match self {
            Ttl::Fixed(s) => *s,
            Ttl::Of(f) => f(data),
        }
    }
}

/// What a live feature fails with.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LiveError {
    /// Python `LiveUnavailable`: Growatt failed and there is no cached value to fall back on (503).
    #[error("{0}")]
    Unavailable(String),
    /// Anything Python lets propagate (an unreadable Growatt reply, …): a 500.
    #[error("{0}")]
    Internal(String),
}

/// Python `_Result`
#[derive(Debug, Clone)]
pub struct LiveResult {
    pub wall: DateTime<Utc>,
    pub data: Value,
    pub stale: bool,
    pub error: Option<String>,
    pub refresh_in: f64,
}

/// Python `LiveCache._envelope`
pub fn envelope(r: &LiveResult) -> Value {
    json!({
        "source": "live",
        "fetched_at": isoformat_utc(r.wall),
        "stale": r.stale,
        "error": r.error,
        "refresh_in_s": MIN_REFRESH_S.max(round_int(r.refresh_in)),
        "data": r.data,
    })
}

/// `"; ".join(f"{k}: {e}" for k, e in errors.items()) or None`
pub fn join_errors(errors: &[(String, String)]) -> Option<String> {
    let s = errors.iter().map(|(k, e)| format!("{k}: {e}")).collect::<Vec<_>>().join("; ");
    (!s.is_empty()).then_some(s)
}

fn errors_obj(errors: &[(String, String)]) -> Value {
    Value::Object(errors.iter().map(|(k, e)| (k.clone(), json!(e))).collect())
}

/// Python `_Sweep`: `hits` = (id, fetched wall time, data, fresh), in item order.
#[derive(Debug, Clone)]
pub struct Sweep {
    pub hits: Vec<(String, DateTime<Utc>, Value, bool)>,
    pub errors: Vec<(String, String)>,
    pub stats: Map<String, Value>,
    pub stale: bool,
    pub refresh: f64,
    pub wall: DateTime<Utc>,
}

impl Sweep {
    /// Python `_Sweep.error`
    pub fn error(&self) -> Option<String> {
        join_errors(&self.errors)
    }
}

/// Run `futs` with at most `n` at a time (Python `ThreadPoolExecutor(max_workers=n)`); results in
/// input order.
pub async fn run_bounded<T: Send + 'static>(n: usize, futs: Vec<BoxFut<T>>) -> Vec<T> {
    let sem = Arc::new(Semaphore::new(n.max(1)));
    let mut set = JoinSet::new();
    let len = futs.len();
    for (idx, f) in futs.into_iter().enumerate() {
        let sem = Arc::clone(&sem);
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (idx, f.await)
        });
    }
    let mut out: Vec<Option<T>> = (0..len).map(|_| None).collect();
    while let Some(res) = set.join_next().await {
        match res {
            Ok((idx, v)) => out[idx] = Some(v),
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(e) => panic!("live task cancelled: {e}"),
        }
    }
    out.into_iter().map(|v| v.expect("every task finished")).collect()
}

// --------------------------------------------------------------------------- configuration

/// The settings of `get_live_service` (Python `LiveCache.__init__` keyword arguments).
#[derive(Debug, Clone)]
pub struct LiveConfig {
    /// `GROWATT_LIVE_TTL_S`
    pub ttl_s: f64,
    /// `GROWATT_LIVE_LATEST_TTL_S`: per-inverter cap when no upload rhythm applies
    pub latest_ttl_s: f64,
    pub cooldown_s: f64,
    /// `GROWATT_LIVE_NIGHT_TTL_S`: max cache life at night (0 = off); always ends at dawn
    pub night_ttl_s: f64,
    /// `GROWATT_LIVE_DEVICE_GAP_S`: min seconds between successful `max_data` calls per inverter
    pub device_gap_s: f64,
    /// `SENSOR_STATUS_TTL_S`
    pub sensor_ttl_s: f64,
    /// `SENSOR_SWEEP_PER_REQUEST`
    pub sensor_sweep: usize,
    /// `PLANT_TODAY_TTL_S`
    pub plant_today_ttl_s: f64,
    /// `PLANT_TODAY_SWEEP_PER_REQUEST`
    pub plant_today_sweep: usize,
    /// `INVERTER_SNAPSHOT_TTL_S`
    pub snapshot_ttl_s: f64,
    /// `INVERTER_SNAPSHOT_SWEEP_PER_REQUEST`
    pub snapshot_sweep: usize,
}

impl Default for LiveConfig {
    /// Python `LiveCache.__init__` defaults (not the app settings: see `LiveConfig` built from Settings).
    fn default() -> Self {
        LiveConfig {
            ttl_s: 120.0,
            latest_ttl_s: 120.0,
            cooldown_s: COOLDOWN_S,
            night_ttl_s: 0.0,
            device_gap_s: 0.0,
            sensor_ttl_s: 300.0,
            sensor_sweep: 12,
            plant_today_ttl_s: 300.0,
            plant_today_sweep: 40,
            snapshot_ttl_s: 300.0,
            snapshot_sweep: 4,
        }
    }
}

/// The Growatt accounts (`Settings.growatt_accounts()`, {phase: token}), the base URL and the
/// blocked plants. The tokens never leave the backend and are never printed.
#[derive(Clone)]
pub struct GrowattAccounts {
    pub tokens: BTreeMap<i32, String>,
    pub base_url: String,
    pub blocked_plant_ids: Vec<i64>,
}

impl fmt::Debug for GrowattAccounts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GrowattAccounts")
            .field("phases", &self.tokens.keys().collect::<Vec<_>>())
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

type ClientFactory = Box<dyn Fn(i32) -> Result<GrowattClient, GrowattError> + Send + Sync>;

// --------------------------------------------------------------------------- the service

struct Inner {
    cfg: LiveConfig,
    phases: Vec<i32>,
    factory: ClientFactory,
    clients: Mutex<HashMap<i32, GrowattClient>>,
    clock: Clock,
    now_local: Arc<dyn Fn() -> NaiveDateTime + Send + Sync>,
    cache: TieredMap<CacheEntry>,
    cooldown: TieredMap<f64>,
    key_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// Port of `LiveCache` + `GrowattLiveService`: TTL cache + single-flight + stale fallback in front
/// of the Growatt client. Cooldowns are per cache key (Growatt rate-limits per endpoint and per
/// device / plant), so one refused inverter never blocks the others. Cheap to clone (shared).
#[derive(Clone)]
pub struct LiveService(Arc<Inner>);

impl fmt::Debug for LiveService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveService").field("phases", &self.0.phases).field("cfg", &self.0.cfg).finish_non_exhaustive()
    }
}

impl LiveService {
    /// Python `get_live_service`: one client per configured account, the cache mirrored in Redis
    /// when `redis` is set.
    pub fn new(cfg: LiveConfig, accounts: GrowattAccounts, redis: Option<Arc<RedisLink>>) -> LiveService {
        let phases: Vec<i32> = accounts.tokens.keys().copied().collect();
        let factory: ClientFactory = Box::new(move |phase| {
            let token = accounts.tokens.get(&phase).map(String::as_str).unwrap_or("");
            GrowattClient::new(
                token,
                GrowattClientOptions {
                    base_url: accounts.base_url.clone(),
                    blocked_plant_ids: accounts.blocked_plant_ids.clone(),
                    ..GrowattClientOptions::default()
                },
            )
        });
        Self::with_parts(cfg, phases, factory, wall_clock(), Arc::new(plant_now), redis)
    }

    /// Python `LiveCache(client_factory, …, clock, now_local, redis)`: everything injectable (tests).
    pub fn with_parts(
        cfg: LiveConfig,
        mut phases: Vec<i32>,
        factory: ClientFactory,
        clock: Clock,
        now_local: Arc<dyn Fn() -> NaiveDateTime + Send + Sync>,
        redis: Option<Arc<RedisLink>>,
    ) -> LiveService {
        phases.sort_unstable();
        phases.dedup();
        let cfg = LiveConfig { sensor_sweep: cfg.sensor_sweep.max(1), plant_today_sweep: cfg.plant_today_sweep.max(1), snapshot_sweep: cfg.snapshot_sweep.max(1), ..cfg };
        LiveService(Arc::new(Inner {
            cache: cache_map("growatt", redis.clone(), 0.0),
            cooldown: cooldown_map("growatt-cooldown", redis, Arc::clone(&clock)),
            cfg,
            phases,
            factory,
            clients: Mutex::new(HashMap::new()),
            clock,
            now_local,
            key_locks: Mutex::new(HashMap::new()),
        }))
    }

    pub fn config(&self) -> &LiveConfig {
        &self.0.cfg
    }

    /// The configured accounts (Python `LiveCache.phases`), ascending.
    pub fn phases(&self) -> &[i32] {
        &self.0.phases
    }

    /// The clock time (seconds) the cache uses.
    pub fn clock(&self) -> f64 {
        (self.0.clock)()
    }

    /// Plant-local now (Python `LiveCache._now_local`).
    pub fn now_local(&self) -> NaiveDateTime {
        (self.0.now_local)()
    }

    /// The shared cache, for features of the next wave that read entries directly.
    pub fn cache(&self) -> &TieredMap<CacheEntry> {
        &self.0.cache
    }

    /// The per-key cooldowns.
    pub fn cooldowns(&self) -> &TieredMap<f64> {
        &self.0.cooldown
    }

    /// Python `LiveCache._get_client`
    fn client(&self, phase: i32) -> Result<GrowattClient, GrowattError> {
        let mut clients = self.0.clients.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = clients.get(&phase) {
            return Ok(c.clone());
        }
        let c = (self.0.factory)(phase)?;
        clients.insert(phase, c.clone());
        Ok(c)
    }

    /// Python `LiveCache.resolve_phase`: a plant's account; untagged plants (None) use the first.
    pub fn resolve_phase(&self, phase: Option<i32>) -> Result<i32, LiveError> {
        let Some(first) = self.0.phases.first() else {
            return Err(LiveError::Unavailable("no Growatt token configured".into()));
        };
        match phase {
            None => Ok(*first),
            Some(p) if self.0.phases.contains(&p) => Ok(p),
            Some(p) => Err(LiveError::Unavailable(format!("no Growatt token configured for phase {p}"))),
        }
    }

    fn require_accounts(&self) -> Result<(), LiveError> {
        if self.0.phases.is_empty() {
            return Err(LiveError::Unavailable("no Growatt token configured".into()));
        }
        Ok(())
    }

    fn key_lock(&self, key: &Key) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.0.key_locks.lock().unwrap_or_else(|p| p.into_inner());
        Arc::clone(locks.entry(key.repr()).or_default())
    }

    fn fresh(&self, hit: &CacheEntry, now: f64) -> bool {
        now - hit.stored_at < hit.ttl_s.unwrap_or(0.0)
    }

    /// Python `LiveCache._refresh_in`: seconds until `key` can give something new (end of its
    /// cooldown, else its cache expiry).
    pub async fn refresh_in(&self, key: &Key) -> f64 {
        let now = self.clock();
        let cooldown = self.0.cooldown.get(key).await.unwrap_or(0.0) - now;
        if cooldown > 0.0 {
            return cooldown;
        }
        match self.0.cache.get(key).await {
            Some(hit) => (hit.ttl_s.unwrap_or(0.0) - (now - hit.stored_at)).max(0.0),
            None => 0.0,
        }
    }

    /// Python `LiveCache._until_daylight`: seconds until the daylight window of `coords` opens; 0
    /// while it is open.
    pub fn until_daylight(&self, coords: &[(f64, f64)]) -> f64 {
        let coords: &[(f64, f64)] = if coords.is_empty() { &FALLBACK_COORDS } else { coords };
        let now = self.now_local();
        let secs = |d: Duration| d.num_microseconds().map_or(0.0, |us| us as f64 / 1e6);
        let Some((dawn, dusk)) = daylight(now.date(), coords) else { return 0.0 };
        if dawn <= now && now <= dusk {
            return 0.0;
        }
        if now < dawn {
            return secs(dawn - now);
        }
        match now.date().succ_opt().and_then(|d| daylight(d, coords)) {
            Some((dawn, _)) => secs(dawn - now),
            None => 0.0,
        }
    }

    /// Python `LiveCache._night`: at night, stretch `ttl_s` up to `night_ttl_s`, never past dawn.
    pub fn night(&self, ttl_s: f64, coords: &[(f64, f64)]) -> f64 {
        if self.0.cfg.night_ttl_s <= 0.0 {
            return ttl_s;
        }
        let wait = self.until_daylight(coords);
        if wait > 0.0 {
            ttl_s.max(self.0.cfg.night_ttl_s.min(wait))
        } else {
            ttl_s
        }
    }

    /// A [`Ttl`] of `ttl_s` night-stretched over `coords`.
    pub fn night_ttl(&self, ttl_s: f64, coords: &[(f64, f64)]) -> Ttl {
        let me = self.clone();
        let coords = coords.to_vec();
        Ttl::of(move |_| me.night(ttl_s, &coords))
    }

    /// The per-device [`Ttl`] (`plant_latest`, `plant_weather`, `plant_meter`, `sensor_live`):
    /// until the next record is due, never sooner than `device_gap_s`, night-stretched.
    pub fn device_ttl(&self, coords: &[(f64, f64)]) -> Ttl {
        let me = self.clone();
        let coords = coords.to_vec();
        Ttl::of(move |row| me.night(me.0.cfg.device_gap_s.max(me.latest_ttl(row)), &coords))
    }

    /// Python `LiveCache._get`: the cached value while fresh; else one upstream call per key at a
    /// time (concurrent callers wait and reuse its result). A refused call puts the key in
    /// cooldown (`cooldown_s`, and at least until `gap_s` after the last success) and serves the
    /// last value as stale; with nothing cached it is [`LiveError::Unavailable`].
    pub async fn get(&self, key: &Key, fetch: Fetch, ttl: &Ttl, phase: i32, gap_s: f64) -> Result<LiveResult, LiveError> {
        if let Some(hit) = self.0.cache.get(key).await {
            if self.fresh(&hit, self.clock()) {
                let refresh_in = self.refresh_in(key).await;
                return Ok(LiveResult { wall: hit.wall, data: hit.data, stale: false, error: None, refresh_in });
            }
        }
        let lock = self.key_lock(key);
        let _guard = lock.lock().await;
        let hit = self.0.cache.get(key).await;
        let now = self.clock();
        if let Some(hit) = &hit {
            if self.fresh(hit, now) {
                let refresh_in = self.refresh_in(key).await;
                return Ok(LiveResult { wall: hit.wall, data: hit.data.clone(), stale: false, error: None, refresh_in });
            }
        }
        let error = if now < self.0.cooldown.get(key).await.unwrap_or(0.0) {
            "Growatt rate limit cooldown".to_owned()
        } else {
            let res = match self.client(phase) {
                Ok(c) => fetch(c).await,
                Err(e) => Err(e),
            };
            match res {
                Ok(data) => {
                    let wall = Utc::now().trunc_subsecs(6);
                    let ttl_s = ttl.seconds(&data);
                    self.0.cache.set(key, CacheEntry { stored_at: now, wall, data: data.clone(), ttl_s: Some(ttl_s) }).await;
                    self.0.cooldown.pop(key).await;
                    return Ok(LiveResult { wall, data, stale: false, error: None, refresh_in: ttl_s });
                }
                // back off this key on any Growatt error: 10012 needs it, and an offline device or
                // network failure would otherwise be retried on every request
                Err(GrowattError::Api(e)) => {
                    let mut until = now + self.0.cfg.cooldown_s;
                    if let Some(hit) = &hit {
                        until = until.max(hit.stored_at + gap_s);
                    }
                    self.0.cooldown.set(key, until).await;
                    e.message
                }
                Err(other) => return Err(LiveError::Internal(other.to_string())),
            }
        };
        match hit {
            Some(hit) => {
                let refresh_in = self.refresh_in(key).await;
                Ok(LiveResult { wall: hit.wall, data: hit.data, stale: true, error: Some(error), refresh_in })
            }
            None => Err(LiveError::Unavailable(error)),
        }
    }

    /// Python `LiveCache._sweep`: refresh at most `batch_n` of `items` ((id, phase), in order)
    /// whose entry has expired (never fetched / oldest first, skipping those cooling down), then
    /// report every cached one. While any item is due, `refresh` is [`SWEEP_REFRESH_S`]; afterwards
    /// the first expiry / cooldown end.
    pub async fn sweep(
        &self,
        items: &[(String, Option<i32>)],
        key: impl Fn(&str) -> Key,
        fetch: impl Fn(&str) -> Fetch,
        ttl: Ttl,
        batch_n: usize,
        idle_ttl_s: f64,
    ) -> Result<Sweep, LiveError> {
        let items = dedup_items(items);
        let keys: Vec<Key> = items.iter().map(|(i, _)| key(i)).collect();

        // (index, age) of the items due now
        let due = |now: f64| {
            let keys = &keys;
            async move {
                let mut out = Vec::new();
                for (n, k) in keys.iter().enumerate() {
                    let hit = self.0.cache.get(k).await;
                    if hit.as_ref().is_some_and(|h| self.fresh(h, now)) {
                        continue;
                    }
                    if now < self.0.cooldown.get(k).await.unwrap_or(0.0) {
                        continue;
                    }
                    out.push((n, hit.map_or(f64::INFINITY, |h| now - h.stored_at)));
                }
                out
            }
        };

        let now = self.clock();
        let mut batch = due(now).await;
        batch.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| items[a.0].0.cmp(&items[b.0].0)));
        batch.truncate(batch_n.max(1));

        let futs: Vec<BoxFut<Result<LiveResult, LiveError>>> = batch
            .iter()
            .map(|(n, _)| {
                let me = self.clone();
                let k = keys[*n].clone();
                let f = fetch(&items[*n].0);
                let ttl = ttl.clone();
                let phase = self.resolve_phase(items[*n].1);
                Box::pin(async move { me.get(&k, f, &ttl, phase?, 0.0).await }) as BoxFut<_>
            })
            .collect();
        let mut errors = Vec::new();
        for ((n, _), r) in batch.iter().zip(run_bounded(LIVE_WORKERS, futs).await) {
            match r {
                Ok(r) => {
                    if let Some(e) = r.error {
                        errors.push((items[*n].0.clone(), e));
                    }
                }
                Err(LiveError::Unavailable(e)) => errors.push((items[*n].0.clone(), e)),
                Err(e) => return Err(e),
            }
        }

        let now = self.clock();
        let mut hits = Vec::new();
        let (mut n_fresh, mut oldest, mut stale) = (0i64, 0.0f64, false);
        for ((id, _), k) in items.iter().zip(&keys) {
            let Some(hit) = self.0.cache.get(k).await else { continue };
            let is_fresh = self.fresh(&hit, now);
            n_fresh += i64::from(is_fresh);
            // refresh failed
            stale = stale || (!is_fresh && now < self.0.cooldown.get(k).await.unwrap_or(0.0));
            oldest = oldest.max(now - hit.stored_at);
            hits.push((id.clone(), hit.wall, hit.data, is_fresh));
        }
        let refresh = if !due(now).await.is_empty() {
            SWEEP_REFRESH_S
        } else if keys.is_empty() {
            idle_ttl_s
        } else {
            // everything fresh or cooling down: the first expiry / cooldown end
            let mut m = f64::INFINITY;
            for k in &keys {
                m = m.min(self.refresh_in(k).await);
            }
            m
        };
        let wall = hits.iter().map(|h| h.1).min().unwrap_or_else(|| Utc::now().trunc_subsecs(6));
        let mut stats = Map::new();
        stats.insert("fresh".into(), json!(n_fresh));
        stats.insert("checked".into(), json!(hits.len()));
        stats.insert("total".into(), json!(items.len()));
        stats.insert("oldest_age_s".into(), json!(round_int(oldest)));
        Ok(Sweep { hits, errors, stats, stale, refresh, wall })
    }

    /// Python `GrowattLiveService._latest_ttl`: cache one device's newest record until its next
    /// record should be on Growatt (record time + measured upload interval + grace). Overdue by
    /// less than two intervals: [`LATE_RETRY_S`]; silent for longer or no record: `latest_ttl_s`.
    pub fn latest_ttl(&self, row: &Value) -> f64 {
        let cap = self.0.cfg.latest_ttl_s;
        let Some(ts) = row.get("timestamp").and_then(Value::as_str) else { return cap };
        let Some(ts) = py::strptime(ts, py::TimeFormat::Seconds) else { return cap };
        let interval = row
            .get("interval_s")
            .and_then(Value::as_f64)
            .filter(|i| (MIN_INTERVAL_S..=MAX_INTERVAL_S).contains(i))
            .unwrap_or(DEFAULT_INTERVAL_S);
        let ahead = (ts - self.now_local()).num_microseconds().map_or(0.0, |us| us as f64 / 1e6);
        let left = ahead + interval + UPLOAD_GRACE_S;
        if left > 0.0 {
            return left.min(interval + UPLOAD_GRACE_S); // cap: record time ahead of our clock
        }
        if -left < 2.0 * interval {
            return LATE_RETRY_S;
        }
        cap
    }

    /// Python `GrowattLiveService._interval_fetch` / `_env_fetch`: `row_fn` with `interval_s`
    /// measured from the record cached before it under `key` (memory / Redis only).
    pub fn interval_fetch(&self, key: &Key, row_fn: Fetch) -> Fetch {
        let me = self.clone();
        let key = key.clone();
        fetch(move |c| async move {
            let mut row = row_fn(c).await?;
            let prev = me.0.cache.get(&key).await.map(|h| h.data);
            if let (true, Some(prev @ Value::Object(_))) = (row.is_object(), prev.as_ref()) {
                let gap = rows::record_gap(prev, &row);
                row["interval_s"] = gap;
            }
            Ok(row)
        })
    }

    // ----------------------------------------------------------------------- features (service.py)

    /// Python `GrowattLiveService.plants`: the realtime plant list of every account, merged. Each
    /// account is cached separately; the envelope is `stale` when any account is stale or missing;
    /// [`LiveError::Unavailable`] only when all fail. `coords`: the fleet (night mode).
    pub async fn plants(&self, coords: &[(f64, f64)]) -> Result<Value, LiveError> {
        self.require_accounts()?;
        let ttl = self.night_ttl(self.0.cfg.ttl_s, coords);
        let futs: Vec<BoxFut<Result<LiveResult, LiveError>>> = self
            .0
            .phases
            .iter()
            .map(|&phase| {
                let me = self.clone();
                let ttl = ttl.clone();
                Box::pin(async move {
                    let f = fetch(move |c: GrowattClient| async move {
                        let mut out = Vec::new();
                        for p in c.list_plants(true).await? {
                            let g = |k: &str| py::get(&p, k).clone();
                            let pid = p.get("plant_id").ok_or_else(|| py::PyError("KeyError: 'plant_id'".into()))?;
                            out.push(json!({
                                "plant_id": py::int(pid)?,
                                "phase": phase,
                                "name": g("name"),
                                "current_power_w": rows::f(&g("current_power")),
                                "total_energy_kwh": rows::f(&g("total_energy")),
                                "peak_power_kwp": rows::f(&g("peak_power")),
                                "status": g("status"),
                            }));
                        }
                        Ok(Value::Array(out))
                    });
                    me.get(&key!("plants", phase), f, &ttl, phase, 0.0).await
                }) as BoxFut<_>
            })
            .collect();
        let n = self.0.phases.len();
        let mut data = Vec::new();
        let mut errors = Vec::new();
        let (mut walls, mut refresh) = (Vec::new(), Vec::new());
        let mut stale = false;
        for (&phase, r) in self.0.phases.iter().zip(run_bounded(n, futs).await) {
            let label = format!("phase {phase}");
            match r {
                Ok(r) => {
                    refresh.push(r.refresh_in);
                    if let Value::Array(a) = r.data {
                        data.extend(a);
                    }
                    walls.push(r.wall);
                    stale = stale || r.stale;
                    if let Some(e) = r.error {
                        errors.push((label, e));
                    }
                }
                Err(LiveError::Unavailable(e)) => {
                    errors.push((label, e));
                    stale = true;
                    refresh.push(self.refresh_in(&key!("plants", phase)).await);
                }
                Err(e) => return Err(e),
            }
        }
        let Some(wall) = walls.iter().min().copied() else {
            return Err(LiveError::Unavailable(join_errors(&errors).unwrap_or_default()));
        };
        // oldest account fetch = how fresh the merged list is at worst; ask again as soon as any
        // account can change
        Ok(envelope(&LiveResult {
            wall,
            data: Value::Array(data),
            stale,
            error: join_errors(&errors),
            refresh_in: refresh.into_iter().fold(f64::INFINITY, f64::min),
        }))
    }

    /// Python `GrowattLiveService.plant_dataloggers`: online state of one plant's dataloggers
    /// (`device/datalogger/list`) as (rows, error). Rides on `/latest` and never fails it: any
    /// failure answers (None, reason).
    pub async fn plant_dataloggers(&self, plant_id: i64, phase: Option<i32>, coords: &[(f64, f64)]) -> (Option<Value>, Option<String>) {
        let ph = match self.resolve_phase(phase) {
            Ok(p) => p,
            Err(e) => return (None, Some(e.to_string())),
        };
        let f = fetch(move |c: GrowattClient| async move { rows::datalogger_rows(&c, plant_id).await });
        let r = match self.get(&key!("dataloggers", ph, plant_id), f, &self.night_ttl(self.0.cfg.ttl_s, coords), ph, 0.0).await {
            Ok(r) => r,
            Err(e) => return (None, Some(e.to_string())),
        };
        let fetched_at = isoformat_utc(r.wall);
        let rows = r
            .data
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|d| {
                        let mut d = d.clone();
                        d["stale"] = json!(r.stale);
                        d["fetched_at"] = json!(fetched_at);
                        d
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        (Some(Value::Array(rows)), r.error)
    }

    /// Per-device results (`plant_latest`, `plant_weather`, `plant_meter`) folded the Python way:
    /// a device that failed with nothing cached is in `errors`; the envelope is stale only when no
    /// device is fresh; fetched_at = the newest fresh fetch (else the newest of all).
    async fn fold_devices(
        &self,
        results: Vec<(String, Key, Result<LiveResult, LiveError>)>,
        mut push: impl FnMut(&LiveResult),
        none_msg: &str,
    ) -> Result<(DateTime<Utc>, bool, Vec<(String, String)>, f64), LiveError> {
        let mut errors = Vec::new();
        let (mut fresh_walls, mut all_walls, mut refresh) = (Vec::new(), Vec::new(), Vec::new());
        for (label, k, r) in results {
            match r {
                Ok(r) => {
                    refresh.push(r.refresh_in);
                    all_walls.push(r.wall);
                    if let Some(e) = &r.error {
                        errors.push((label, e.clone()));
                    }
                    if !r.stale {
                        fresh_walls.push(r.wall);
                    }
                    push(&r);
                }
                Err(LiveError::Unavailable(e)) => {
                    errors.push((label, e));
                    refresh.push(self.refresh_in(&k).await);
                }
                Err(e) => return Err(e),
            }
        }
        if all_walls.is_empty() {
            return Err(LiveError::Unavailable(join_errors(&errors).unwrap_or_else(|| none_msg.to_owned())));
        }
        let stale = fresh_walls.is_empty();
        let wall = *if stale { &all_walls } else { &fresh_walls }.iter().max().expect("non-empty");
        Ok((wall, stale, errors, refresh.into_iter().fold(f64::INFINITY, f64::min)))
    }

    /// Python `GrowattLiveService.plant_latest`: newest record per inverter of one plant (power,
    /// MPPT, per-string V / I). Each inverter is cached separately until its next record is due
    /// ([`Self::latest_ttl`]), so a refused inverter falls back to its own last value while the
    /// others stay fresh. The envelope is `stale` only when no inverter is fresh.
    pub async fn plant_latest(
        &self,
        plant_id: i64,
        device_sns: &[String],
        day: NaiveDate,
        phase: Option<i32>,
        coords: &[(f64, f64)],
    ) -> Result<Value, LiveError> {
        let ph = self.resolve_phase(phase)?;
        // never ask before Growatt would answer: >= device_gap_s since the last success
        let ttl = self.device_ttl(coords);
        let gap = self.0.cfg.device_gap_s;
        let keys: Vec<Key> = device_sns.iter().map(|sn| key!("latest", sn, day)).collect();
        let futs: Vec<BoxFut<Result<LiveResult, LiveError>>> = device_sns
            .iter()
            .zip(&keys)
            .map(|(sn, k)| {
                let (me, k, ttl, sn) = (self.clone(), k.clone(), ttl.clone(), sn.clone());
                Box::pin(async move {
                    let f = fetch(move |c: GrowattClient| async move { rows::latest_row(&c, &sn, day).await });
                    me.get(&k, f, &ttl, ph, gap).await
                }) as BoxFut<_>
            })
            .collect();
        let results = run_bounded(LIVE_WORKERS, futs).await;
        let mut inverters = Vec::new();
        let folded = self
            .fold_devices(
                device_sns.iter().cloned().zip(keys).zip(results).map(|((s, k), r)| (s, k, r)).collect(),
                |r| {
                    // null = no record today (offline inverter)
                    if let Value::Object(m) = &r.data {
                        let mut m = m.clone();
                        m.insert("stale".into(), json!(r.stale));
                        m.insert("fetched_at".into(), json!(isoformat_utc(r.wall)));
                        inverters.push(Value::Object(m));
                    }
                },
                "no inverters",
            )
            .await?;
        let (wall, stale, errors, refresh_in) = folded;
        Ok(envelope(&LiveResult {
            wall,
            data: json!({"plant_id": plant_id, "day": day.to_string(), "inverters": inverters, "errors": errors_obj(&errors)}),
            stale,
            error: join_errors(&errors),
            refresh_in, // as soon as any inverter can change
        }))
    }

    /// Python `GrowattLiveService.plant_weather`: newest weather-sensor record per sensor of one
    /// plant (`env_last_data`). `sensors` = (datalogger_sn, address, measured fields or None);
    /// fields outside `measured` are null.
    pub async fn plant_weather(
        &self,
        plant_id: i64,
        sensors: &[(String, i64, Option<Vec<String>>)],
        phase: Option<i32>,
        coords: &[(f64, f64)],
    ) -> Result<Value, LiveError> {
        let ph = self.resolve_phase(phase)?;
        let ttl = self.device_ttl(coords);
        let mut results = Vec::new();
        for (dl, addr, _) in sensors {
            let k = key!("env", dl, *addr);
            let f = self.env_fetch(&k, dl, *addr);
            results.push((format!("{dl}/{addr}"), k.clone(), self.get(&k, f, &ttl, ph, self.0.cfg.device_gap_s).await));
        }
        // `measured` of each sensor that answered, in order (fold_devices pushes only those)
        let mut ok_measured = sensors.iter().zip(&results).filter(|(_, r)| r.2.is_ok()).map(|(s, _)| s.2.clone()).collect::<Vec<_>>().into_iter();
        let mut out = Vec::new();
        let folded = self
            .fold_devices(
                results,
                |r| {
                    let m = ok_measured.next().flatten();
                    if let Value::Object(row) = &r.data {
                        let mut row = row.clone();
                        null_unmeasured(&mut row, m.as_deref());
                        row.remove("raw"); // the full record is only for the sensor Info view
                        row.insert("stale".into(), json!(r.stale));
                        row.insert("fetched_at".into(), json!(isoformat_utc(r.wall)));
                        out.push(Value::Object(row));
                    }
                },
                "no weather sensors",
            )
            .await?;
        let (wall, stale, errors, refresh_in) = folded;
        Ok(envelope(&LiveResult {
            wall,
            data: json!({"plant_id": plant_id, "sensors": out, "errors": errors_obj(&errors)}),
            stale,
            error: join_errors(&errors),
            refresh_in,
        }))
    }

    /// Python `GrowattLiveService._env_fetch`: `env_last_data` for one sensor, with `interval_s`.
    pub fn env_fetch(&self, key: &Key, datalogger_sn: &str, address: i64) -> Fetch {
        let dl = datalogger_sn.to_owned();
        self.interval_fetch(key, fetch(move |c: GrowattClient| async move { rows::env_row(&c, &dl, address).await }))
    }

    /// Python `GrowattLiveService.sensor_status`: online state of the weather sensors on
    /// `dataloggers` ((datalogger_sn, plant phase)) from `env_list`, swept incrementally (at most
    /// `sensor_sweep` dataloggers per request). A datalogger never fetched is absent.
    pub async fn sensor_status(&self, dataloggers: &[(String, Option<i32>)], coords: &[(f64, f64)]) -> Result<Value, LiveError> {
        self.require_accounts()?;
        let sw = self
            .sweep(
                dataloggers,
                |dl| key!("envlist", dl),
                |dl| {
                    let dl = dl.to_owned();
                    fetch(move |c: GrowattClient| async move { rows::env_status_rows(&c, &dl).await })
                },
                self.night_ttl(self.0.cfg.sensor_ttl_s, coords),
                self.0.cfg.sensor_sweep,
                self.0.cfg.sensor_ttl_s,
            )
            .await?;
        let out: Map<String, Value> = sw
            .hits
            .iter()
            .map(|(dl, wall, data, fresh)| (dl.clone(), json!({"fetched_at": isoformat_utc(*wall), "stale": !fresh, "sensors": data})))
            .collect();
        Ok(envelope(&LiveResult {
            wall: sw.wall,
            data: json!({"dataloggers": out, "errors": errors_obj(&sw.errors), "sweep": sw.stats}),
            stale: sw.stale,
            error: sw.error(),
            refresh_in: sw.refresh,
        }))
    }

    /// Python `GrowattLiveService.plant_today`: today's energy of each plant ((plant_id, phase))
    /// from `plant/data`, swept like `sensor_status`. `today_energy_kwh` is null when the plant's
    /// last upload is not from today (judged at request time).
    pub async fn plant_today(&self, plants: &[(i64, Option<i32>)], coords: &[(f64, f64)]) -> Result<Value, LiveError> {
        self.require_accounts()?;
        let items: Vec<(String, Option<i32>)> = plants.iter().map(|(p, ph)| (p.to_string(), *ph)).collect();
        let sw = self
            .sweep(
                &items,
                |pid| key!("pdata", pid),
                |pid| {
                    let pid: i64 = pid.parse().unwrap_or_default();
                    fetch(move |c: GrowattClient| async move { rows::plant_data_row(&c, pid).await })
                },
                self.night_ttl(self.0.cfg.plant_today_ttl_s, coords),
                self.0.cfg.plant_today_sweep,
                self.0.cfg.plant_today_ttl_s,
            )
            .await?;
        let today = self.now_local().date().to_string();
        let mut out = Map::new();
        for (pid, wall, row, fresh) in &sw.hits {
            let upd = row.get("last_update_time").cloned().unwrap_or(Value::Null);
            let is_today = upd.as_str().is_some_and(|u| !u.is_empty() && py::head(u, 10) == today);
            out.insert(
                pid.clone(),
                json!({
                    "fetched_at": isoformat_utc(*wall),
                    "stale": !fresh,
                    "last_update_time": upd,
                    "today_energy_kwh": if is_today { row.get("today_energy_kwh").cloned().unwrap_or(Value::Null) } else { Value::Null },
                }),
            );
        }
        Ok(envelope(&LiveResult {
            wall: sw.wall,
            data: json!({"day": today, "plants": out, "errors": errors_obj(&sw.errors), "sweep": sw.stats}),
            stale: sw.stale,
            error: sw.error(),
            refresh_in: sw.refresh,
        }))
    }

    /// Python `GrowattLiveService.inverter_snapshot`: newest record of every inverter in
    /// `inverters` ((serial, plant phase)) from `maxs_data`, [`rows::SNAPSHOT_CHUNK`] serials per
    /// call: each account's serials in fixed sorted chunks, one cache key per chunk, swept (at most
    /// `snapshot_sweep` chunks per request). `wanted` limits the reply (and the chunks swept).
    pub async fn inverter_snapshot(
        &self,
        inverters: &[(String, Option<i32>)],
        wanted: Option<&HashSet<String>>,
        coords: &[(f64, f64)],
    ) -> Result<Value, LiveError> {
        self.require_accounts()?;
        let first = self.0.phases[0];
        // untagged plants go with the first account; an account without a token keeps its phase,
        // so its chunks fail one by one (reported in `errors`)
        let mut by_phase: BTreeMap<i32, Vec<String>> = BTreeMap::new();
        for (sn, ph) in inverters {
            by_phase.entry(ph.unwrap_or(first)).or_default().push(sn.clone());
        }
        let mut chunks: Vec<(String, Option<i32>)> = Vec::new();
        let mut members: HashMap<String, Vec<String>> = HashMap::new();
        for (ph, mut sns) in by_phase {
            sns.sort();
            sns.dedup();
            for (k, part) in sns.chunks(rows::SNAPSHOT_CHUNK).enumerate() {
                if wanted.is_none_or(|w| part.iter().any(|s| w.contains(s))) {
                    let digest = Sha1::digest(part.join(",").as_bytes());
                    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
                    // "p<phase>#<n>:<digest>": the digest keeps a cached chunk from being reused for
                    // a different set after a registry change
                    let cid = format!("p{ph}#{}:{}", k + 1, &hex[..10]);
                    chunks.push((cid.clone(), Some(ph)));
                    members.insert(cid, part.to_vec());
                }
            }
        }
        let members = Arc::new(members);
        let sw = self
            .sweep(
                &chunks,
                |cid| key!("maxs", cid),
                |cid| {
                    let sns = members.get(cid).cloned().unwrap_or_default();
                    fetch(move |c: GrowattClient| async move { rows::maxs_rows(&c, &sns).await })
                },
                self.night_ttl(self.0.cfg.snapshot_ttl_s, coords),
                self.0.cfg.snapshot_sweep,
                self.0.cfg.snapshot_ttl_s,
            )
            .await?;
        let today = self.now_local().date().to_string();
        let mut out = Map::new();
        for (_cid, wall, rows, fresh) in &sw.hits {
            let Some(rows) = rows.as_object() else { continue };
            for (sn, row) in rows {
                if wanted.is_some_and(|w| !w.contains(sn)) {
                    continue;
                }
                let mut row = row.as_object().cloned().unwrap_or_default();
                let is_today = row.get("record_time").and_then(Value::as_str).is_some_and(|t| !t.is_empty() && py::head(t, 10) == today);
                if !is_today {
                    row.insert("eac_today_kwh".into(), Value::Null);
                }
                row.insert("fetched_at".into(), json!(isoformat_utc(*wall)));
                row.insert("stale".into(), json!(!fresh));
                out.insert(sn.clone(), Value::Object(row));
            }
        }
        let n_inv = inverters.iter().filter(|(sn, _)| wanted.is_none_or(|w| w.contains(sn))).count();
        let mut sweep = sw.stats.clone();
        sweep.insert("inverters".into(), json!(n_inv));
        sweep.insert("answered".into(), json!(out.len()));
        Ok(envelope(&LiveResult {
            wall: sw.wall,
            data: json!({"day": today, "inverters": out, "errors": errors_obj(&sw.errors), "sweep": sweep}),
            stale: sw.stale,
            error: sw.error(),
            refresh_in: sw.refresh,
        }))
    }

    /// Python `GrowattLiveService.sensor_live`: one weather sensor for its Info view: online state
    /// from its datalogger's `env_list` (the fleet sweep's cache) and its newest `env_last_data`
    /// record (the `plant_weather` cache). Unavailable only when both parts fail.
    pub async fn sensor_live(
        &self,
        datalogger_sn: &str,
        address: i64,
        phase: Option<i32>,
        measured: Option<&[String]>,
        coords: &[(f64, f64)],
    ) -> Result<Value, LiveError> {
        let ph = self.resolve_phase(phase)?;
        let mut errors: Vec<(String, String)> = Vec::new();
        let status_env = match self.sensor_status(&[(datalogger_sn.to_owned(), phase)], coords).await {
            Ok(env) => Some(env),
            Err(LiveError::Unavailable(e)) => {
                errors.push(("status".into(), e));
                None
            }
            Err(e) => return Err(e),
        };
        let entry = status_env.as_ref().and_then(|e| e["data"]["dataloggers"].get(datalogger_sn)).cloned();
        if let Some(Value::Object(errs)) = status_env.as_ref().map(|e| &e["data"]["errors"]) {
            if !errs.is_empty() {
                let joined = errs.values().map(py::str_of).collect::<Vec<_>>().join("; ");
                set_error(&mut errors, "status", joined);
            }
        }
        let k = key!("env", datalogger_sn, address);
        let f = self.env_fetch(&k, datalogger_sn, address);
        let r = match self.get(&k, f, &self.device_ttl(coords), ph, self.0.cfg.device_gap_s).await {
            Ok(r) => Some(r),
            Err(LiveError::Unavailable(e)) => {
                set_error(&mut errors, "reading", e);
                None
            }
            Err(e) => return Err(e),
        };
        let (mut reading, mut raw) = (Value::Null, Value::Null);
        if let Some(r) = &r {
            if let Some(e) = &r.error {
                set_error(&mut errors, "reading", e.clone());
            }
            if let Value::Object(row) = &r.data {
                let mut row = row.clone();
                raw = row.remove("raw").unwrap_or(Value::Null);
                null_unmeasured(&mut row, measured);
                row.insert("stale".into(), json!(r.stale));
                row.insert("fetched_at".into(), json!(isoformat_utc(r.wall)));
                reading = Value::Object(row);
            }
        }
        if r.is_none() && entry.is_none() {
            return Err(LiveError::Unavailable(join_errors(&errors).unwrap_or_else(|| "sensor unavailable".into())));
        }
        let mut refresh: Vec<f64> = Vec::new();
        if let Some(r) = &r {
            refresh.push(r.refresh_in);
        }
        if let Some(env) = &status_env {
            refresh.push(env["refresh_in_s"].as_f64().unwrap_or(0.0));
        }
        let mut walls: Vec<DateTime<Utc>> = r.iter().map(|r| r.wall).collect();
        if let Some(at) = entry.as_ref().and_then(|e| e["fetched_at"].as_str()).and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
            walls.push(at.with_timezone(&Utc));
        }
        let stale = r.as_ref().is_some_and(|r| r.stale) || entry.as_ref().is_some_and(|e| e["stale"].as_bool() == Some(true));
        Ok(envelope(&LiveResult {
            wall: walls.into_iter().min().unwrap_or_else(Utc::now),
            // this datalogger's `env_list` entry ({fetched_at, stale, sensors}); null = not checked
            data: json!({"datalogger": entry, "reading": reading, "raw": raw, "errors": errors_obj(&errors)}),
            stale,
            error: join_errors(&errors),
            refresh_in: if refresh.is_empty() { self.0.cfg.sensor_ttl_s } else { refresh.into_iter().fold(f64::INFINITY, f64::min) },
        }))
    }

    /// Python `GrowattLiveService.sensor_today`: today's 5-minute records of one weather sensor
    /// (`env_data`, today only), memory only. A probe that reads 0 in every record today is null
    /// and missing from `measured`.
    pub async fn sensor_today(&self, datalogger_sn: &str, address: i64, phase: Option<i32>, coords: &[(f64, f64)]) -> Result<Value, LiveError> {
        let ph = self.resolve_phase(phase)?;
        let day = self.now_local().date();
        let k = key!("envday", datalogger_sn, address, day.to_string());
        let ttl = self.night_ttl(self.0.cfg.device_gap_s.max(SENSOR_DAY_TTL_S), coords);
        let dl = datalogger_sn.to_owned();
        let f = fetch(move |c: GrowattClient| async move {
            let recs = c.env_history(&dl, address, day, day, None).await?;
            let mut rows = parse_env_records(&dl, address, &recs)?;
            rows.sort_by_key(|r| r.timestamp);
            let mut out: BTreeMap<String, Value> = BTreeMap::new();
            for r in &rows {
                if r.timestamp.date() != day {
                    continue;
                }
                let t = r.timestamp;
                let slot = t.date().and_hms_opt(chrono::Timelike::hour(&t), chrono::Timelike::minute(&t) - chrono::Timelike::minute(&t) % 5, 0).expect("valid");
                let vals: Map<String, Value> = ENV_FIELDS.iter().map(|(_, col)| (col.to_string(), json!(env_col(r, col)))).collect();
                out.insert(slot.format("%Y-%m-%d %H:%M:%S").to_string(), Value::Object(vals)); // newest in a slot wins
            }
            Ok(Value::Array(
                out.into_iter()
                    .map(|(t, v)| {
                        let mut m = v.as_object().cloned().unwrap_or_default();
                        m.insert("timestamp".into(), json!(t));
                        Value::Object(m)
                    })
                    .collect(),
            ))
        });
        let r = self.get(&k, f, &ttl, ph, self.0.cfg.device_gap_s).await?;
        let points = r.data.as_array().cloned().unwrap_or_default();
        let cols: Vec<&str> = ENV_FIELDS.iter().map(|(_, c)| *c).collect();
        let measured: Vec<&str> = cols
            .iter()
            .copied()
            .filter(|c| points.iter().any(|p| p.get(*c).and_then(Value::as_f64).is_some_and(|v| v != 0.0)))
            .collect();
        let series: Vec<Value> = points
            .iter()
            .map(|p| {
                let mut m = Map::new();
                m.insert("timestamp".into(), p.get("timestamp").cloned().unwrap_or(Value::Null));
                for c in &cols {
                    m.insert((*c).into(), if measured.contains(c) { p.get(*c).cloned().unwrap_or(Value::Null) } else { Value::Null });
                }
                Value::Object(m)
            })
            .collect();
        Ok(envelope(&LiveResult {
            wall: r.wall,
            data: json!({"day": day.to_string(), "measured": measured, "series": series}),
            stale: r.stale,
            error: r.error,
            refresh_in: r.refresh_in,
        }))
    }

    /// Python `GrowattLiveService.plant_meter`: newest energy-meter record per meter of one plant
    /// (`meter_last_data`), cached per meter like `plant_weather`. `data.grid` sums the meters only
    /// when every meter has a record (a partial sum would understate import).
    pub async fn plant_meter(&self, plant_id: i64, meters: &[(String, i64)], phase: Option<i32>, coords: &[(f64, f64)]) -> Result<Value, LiveError> {
        let ph = self.resolve_phase(phase)?;
        let ttl = self.device_ttl(coords);
        let mut results = Vec::new();
        for (dl, addr) in meters {
            let k = key!("meter", dl, *addr);
            let (d, a) = (dl.clone(), *addr);
            let f = self.interval_fetch(&k, fetch(move |c: GrowattClient| async move { rows::meter_row(&c, &d, a).await }));
            results.push((format!("{dl}/{addr}"), k.clone(), self.get(&k, f, &ttl, ph, self.0.cfg.device_gap_s).await));
        }
        let mut out: Vec<Value> = Vec::new();
        let (wall, stale, errors, refresh_in) = self
            .fold_devices(
                results,
                |r| {
                    if let Value::Object(m) = &r.data {
                        let mut m = m.clone();
                        m.insert("stale".into(), json!(r.stale));
                        m.insert("fetched_at".into(), json!(isoformat_utc(r.wall)));
                        out.push(Value::Object(m));
                    }
                },
                "no energy meters",
            )
            .await?;
        let powers: Vec<Option<f64>> = out.iter().map(|m| m.get("active_power_w").and_then(Value::as_f64)).collect();
        let whole = out.len() == meters.len() && powers.iter().all(Option::is_some);
        let kw = whole.then(|| powers.iter().map(|p| p.unwrap_or(0.0)).fold(0.0, |a, b| a + b) / 1000.0);
        let r2 = |x: f64| crate::common::py_round(x, 2);
        let grid = json!({
            "timestamp": out.iter().filter_map(|m| m.get("timestamp").and_then(Value::as_str)).max(),
            "grid_power_kw": kw.map(r2),
            "grid_import_kw": kw.map(|k| r2(k.max(0.0))),
            "grid_export_kw": kw.map(|k| r2((-k).max(0.0))),
        });
        Ok(envelope(&LiveResult {
            wall,
            data: json!({"plant_id": plant_id, "meters": out, "grid": grid, "errors": errors_obj(&errors)}),
            stale,
            error: join_errors(&errors),
            refresh_in,
        }))
    }

    /// Python `GrowattLiveService.plant_alarms`: Growatt alarm / fault log of one plant's
    /// inverters over `days` (`device/max/alarm_data`, one inverter-day per call), newest first.
    /// Each inverter-day is cached separately: a past day [`PAST_DAY_ALARM_TTL_S`], today `ttl_s`
    /// (night-stretched).
    pub async fn plant_alarms(
        &self,
        plant_id: i64,
        device_sns: &[String],
        days: &[NaiveDate],
        phase: Option<i32>,
        coords: &[(f64, f64)],
    ) -> Result<Value, LiveError> {
        let ph = self.resolve_phase(phase)?;
        let today = self.now_local().date();
        let mut ds: Vec<NaiveDate> = days.to_vec();
        ds.sort();
        ds.dedup();
        let keys: Vec<(String, NaiveDate)> = ds.iter().flat_map(|d| device_sns.iter().map(move |sn| (sn.clone(), *d))).collect();
        let today_ttl = self.night_ttl(self.0.cfg.ttl_s, coords);
        let futs: Vec<BoxFut<Result<LiveResult, LiveError>>> = keys
            .iter()
            .map(|(sn, d)| {
                let (me, sn, d) = (self.clone(), sn.clone(), *d);
                let ttl = if d < today { Ttl::Fixed(PAST_DAY_ALARM_TTL_S) } else { today_ttl.clone() };
                Box::pin(async move {
                    let k = key!("alarms", &sn, d);
                    let f = fetch(move |c: GrowattClient| async move {
                        let list = c.max_alarms(&sn, d, 100, 10).await?;
                        Ok(Value::Array(list.iter().map(|a| rows::alarm_row(&sn, a)).collect::<Result<Vec<_>, _>>()?))
                    });
                    me.get(&k, f, &ttl, ph, 0.0).await
                }) as BoxFut<_>
            })
            .collect();
        let results = run_bounded(ALARM_WORKERS, futs).await;
        let mut alarms: Vec<Value> = Vec::new();
        let mut errors = Vec::new();
        let (mut fresh_walls, mut all_walls, mut refresh) = (Vec::new(), Vec::new(), Vec::new());
        for ((sn, d), r) in keys.iter().zip(results) {
            let label = format!("{sn} {d}");
            match r {
                Ok(r) => {
                    refresh.push(r.refresh_in);
                    all_walls.push(r.wall);
                    if let Some(e) = r.error {
                        errors.push((label, e));
                    }
                    if !r.stale {
                        fresh_walls.push(r.wall);
                    }
                    if let Value::Array(a) = r.data {
                        alarms.extend(a);
                    }
                }
                Err(LiveError::Unavailable(e)) => {
                    errors.push((label, e));
                    refresh.push(self.refresh_in(&key!("alarms", sn, *d)).await);
                }
                Err(e) => return Err(e),
            }
        }
        let Some(wall) = all_walls.iter().min().copied() else {
            return Err(LiveError::Unavailable(join_errors(&errors).unwrap_or_else(|| "no inverters".into())));
        };
        let start = |a: &Value| match a.get("start_time") {
            Some(v) if py::truthy(v) => py::str_of(v),
            _ => String::new(),
        };
        alarms.sort_by_key(|a| std::cmp::Reverse(start(a))); // stable, as Python's sort(reverse=True)
        Ok(envelope(&LiveResult {
            wall,
            data: json!({
                "plant_id": plant_id,
                "from": ds.first().map(ToString::to_string),
                "to": ds.last().map(ToString::to_string),
                "alarms": alarms,
                "errors": errors_obj(&errors),
            }),
            stale: fresh_walls.is_empty(),
            error: join_errors(&errors),
            refresh_in: refresh.into_iter().fold(f64::INFINITY, f64::min),
        }))
    }
}

/// `errors[name] = msg` keeping the first position (a Python dict assignment).
fn set_error(errors: &mut Vec<(String, String)>, name: &str, msg: String) {
    match errors.iter_mut().find(|(k, _)| k == name) {
        Some(e) => e.1 = msg,
        None => errors.push((name.to_owned(), msg)),
    }
}

/// Fields outside `measured` (probes that read only 0 in the stored history) are null.
fn null_unmeasured(row: &mut Map<String, Value>, measured: Option<&[String]>) {
    if let Some(measured) = measured {
        for (_, col) in ENV_FIELDS {
            if !measured.iter().any(|m| m == col) {
                row.insert(col.into(), Value::Null);
            }
        }
    }
}

fn env_col(r: &EnvRow, col: &str) -> Option<f64> {
    match col {
        "irradiance_wm2" => r.irradiance_wm2,
        "ambient_temp_c" => r.ambient_temp_c,
        "module_temp_c" => r.module_temp_c,
        "humidity_pct" => r.humidity_pct,
        "wind_speed_ms" => r.wind_speed_ms,
        "wind_dir_deg" => r.wind_dir_deg,
        _ => None,
    }
}

/// Python `dict(items)`: the first position of each id, the last phase given for it.
fn dedup_items(items: &[(String, Option<i32>)]) -> Vec<(String, Option<i32>)> {
    let mut pos: HashMap<&str, usize> = HashMap::new();
    let mut out: Vec<(String, Option<i32>)> = Vec::new();
    for (id, ph) in items {
        match pos.get(id.as_str()) {
            Some(&n) => out[n].1 = *ph,
            None => {
                pos.insert(id, out.len());
                out.push((id.clone(), *ph));
            }
        }
    }
    out
}

/// Python `core._daylight`: (dawn, dusk) covering every plant in `coords`, margins included;
/// None = a plant without sunrise / sunset that day (never treated as night).
pub fn daylight(day: NaiveDate, coords: &[(f64, f64)]) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let mut times = Vec::with_capacity(coords.len());
    for &(lat, lon) in coords {
        times.push(sun_times(day, lat, lon, PLANT_UTC_OFFSET_H)?);
    }
    let margin = Duration::seconds(DAYLIGHT_MARGIN_S as i64);
    let dawn = times.iter().map(|t| t.0).min()?;
    let dusk = times.iter().map(|t| t.1).max()?;
    Some((dawn - margin, dusk + margin))
}

#[cfg(test)]
mod tests;
