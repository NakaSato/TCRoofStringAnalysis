//! Port of `backend/app/services/live_store.py`: the memory cache for live values, optionally
//! mirrored in Redis (no persistence).
//!
//! The live services (`growatt_live`, and later `google_weather` current conditions, Longdo,
//! RainViewer, Geoapify) keep their cache and per-key cooldowns in [`TieredMap`]s: the process map
//! is the first level, and with `REDIS_URL` set every write also goes to Redis on the `tcroof-db`
//! VM, so a Cloud Run cold start finds the cache and the Growatt rate-limit back-offs already warm.
//!
//! Rules this keeps (root CLAUDE.md "Never store realtime values"):
//! - Redis runs with **no persistence**: a Redis restart empties it, like a process restart
//!   empties the maps. Nothing reaches SQL, Firestore or disk.
//! - Every key expires: a cache entry [`STALE_KEEP_S`] after its own TTL, a cooldown when it ends
//!   (+ [`COOLDOWN_SLACK_S`]).
//! - Values are JSON. The encoding is Python's (`_pack`: tuples as `{"__t__": [...]}`, datetimes as
//!   `{"__dt__": iso}`) and keys are Python's `repr(key)` under the same namespace, so the Python and
//!   the Rust API can share one Redis during the cutover and read each other's entries.
//! - Redis is optional and never fatal: on any Redis error the store carries on memory-only and
//!   retries the connection after [`RETRY_S`].
//!
//! Timestamps stored in the maps are wall-clock seconds (Python uses `time.time` when Redis is on:
//! cached timestamps outlive the process).

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};
use tcroof_clients::growatt::py;

use crate::common::isoformat_utc;

/// Python `STALE_KEEP_S`: a cache entry stays in Redis this long after its TTL (stale fallback).
pub const STALE_KEEP_S: f64 = 3600.0;
/// Python `COOLDOWN_SLACK_S`
pub const COOLDOWN_SLACK_S: f64 = 5.0;
/// Python `RETRY_S`: after a Redis error, memory-only for this long.
pub const RETRY_S: f64 = 30.0;
/// Python `TIMEOUT_S`: Redis is on the private network, anything slower is a fault.
pub const TIMEOUT_S: f64 = 0.3;
/// Python `NAMESPACE`
pub const NAMESPACE: &str = "tcroof:v1:";

/// A clock in seconds (wall clock in production; tests pass a fake one).
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// Wall-clock seconds since the epoch (Python `time.time`).
pub fn wall_clock() -> Clock {
    Arc::new(|| {
        let now = Utc::now();
        now.timestamp() as f64 + f64::from(now.timestamp_subsec_nanos()) / 1e9
    })
}

// --------------------------------------------------------------------------- keys

/// One element of a cache key (Python keys are tuples of str / int / date).
#[derive(Debug, Clone, PartialEq)]
pub enum KeyPart {
    Str(String),
    Int(i64),
    Date(NaiveDate),
}

impl From<&str> for KeyPart {
    fn from(s: &str) -> Self {
        KeyPart::Str(s.to_owned())
    }
}
impl From<String> for KeyPart {
    fn from(s: String) -> Self {
        KeyPart::Str(s)
    }
}
impl From<&String> for KeyPart {
    fn from(s: &String) -> Self {
        KeyPart::Str(s.clone())
    }
}
impl From<i64> for KeyPart {
    fn from(i: i64) -> Self {
        KeyPart::Int(i)
    }
}
impl From<i32> for KeyPart {
    fn from(i: i32) -> Self {
        KeyPart::Int(i64::from(i))
    }
}
impl From<NaiveDate> for KeyPart {
    fn from(d: NaiveDate) -> Self {
        KeyPart::Date(d)
    }
}

impl KeyPart {
    fn repr(&self) -> String {
        match self {
            KeyPart::Str(s) => py::repr_str(s),
            KeyPart::Int(i) => i.to_string(),
            KeyPart::Date(d) => {
                use chrono::Datelike;
                format!("datetime.date({}, {}, {})", d.year(), d.month(), d.day())
            }
        }
    }
}

/// A cache key: a Python tuple. Its identity (memory and Redis) is Python's `repr(key)`, e.g.
/// `('latest', 'SN1', datetime.date(2026, 11, 27))`.
#[derive(Debug, Clone, PartialEq)]
pub struct Key(pub Vec<KeyPart>);

impl Key {
    /// Python `repr(tuple)`
    pub fn repr(&self) -> String {
        let parts: Vec<String> = self.0.iter().map(KeyPart::repr).collect();
        if parts.len() == 1 {
            format!("({},)", parts[0])
        } else {
            format!("({})", parts.join(", "))
        }
    }
}

/// A key of a [`TieredMap`], identified by Python's `repr(key)`: a tuple [`Key`], or a `str` for
/// the caches Python keys by a plain string (Google Weather cells, Longdo, RainViewer: `'frames'`).
pub trait MapKey {
    fn map_repr(&self) -> String;
}

impl MapKey for Key {
    fn map_repr(&self) -> String {
        self.repr()
    }
}

impl MapKey for str {
    fn map_repr(&self) -> String {
        py::repr_str(self)
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.repr())
    }
}

/// `key!("latest", sn, day)`: a [`Key`] from parts convertible into [`KeyPart`].
#[macro_export]
macro_rules! key {
    ($($part:expr),+ $(,)?) => {
        $crate::live_store::Key(vec![$($crate::live_store::KeyPart::from($part)),+])
    };
}

// --------------------------------------------------------------------------- JSON encoding

/// Python `_unpack_hook`, applied to a whole value: tagged tuples become arrays, tagged datetimes
/// / dates their ISO text (the live values the Rust services keep hold no other kinds).
pub fn unpack(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(unpack).collect()),
        Value::Object(m) => {
            if m.len() == 1 {
                if let Some(Value::Array(t)) = m.get("__t__") {
                    return Value::Array(t.iter().map(unpack).collect());
                }
                for tag in ["__dt__", "__d__"] {
                    if let Some(Value::String(s)) = m.get(tag) {
                        return Value::String(s.clone());
                    }
                }
            }
            Value::Object(m.iter().map(|(k, v)| (k.clone(), unpack(v))).collect())
        }
        other => other.clone(),
    }
}

/// A value a [`TieredMap`] can mirror in Redis: Python `_pack` / `loads` of it.
pub trait Mirrored: Clone + Send + Sync + 'static {
    /// The JSON Python's `dumps` writes for this value.
    fn pack(&self) -> Value;
    /// Python `loads`; None = unreadable (the read is treated as a miss, as in Python).
    fn unpack(v: &Value) -> Option<Self>;
}

/// A cooldown's `until` timestamp (Python `cooldown_map` values: a float).
impl Mirrored for f64 {
    fn pack(&self) -> Value {
        json!(self)
    }
    fn unpack(v: &Value) -> Option<Self> {
        v.as_f64()
    }
}

/// Any JSON value, kept as is (tags unpacked on read).
impl Mirrored for Value {
    fn pack(&self) -> Value {
        self.clone()
    }
    fn unpack(v: &Value) -> Option<Self> {
        Some(unpack(v))
    }
}

/// One cache entry: Python's tuple `(stored_at, wall, data, ttl_s)` (`cache_map(ttl_index=3)`), or
/// `(stored_at, wall, data)` when `ttl_s` is None (`cache_map(ttl_index=None, fixed_ttl_s=…)`).
#[derive(Debug, Clone, PartialEq)]
pub struct CacheEntry {
    /// clock time of the fetch (taken before the call, as in Python)
    pub stored_at: f64,
    /// UTC time the value arrived (`fetched_at`)
    pub wall: DateTime<Utc>,
    pub data: Value,
    pub ttl_s: Option<f64>,
}

impl Mirrored for CacheEntry {
    fn pack(&self) -> Value {
        let mut t = vec![json!(self.stored_at), json!({"__dt__": isoformat_utc(self.wall)}), self.data.clone()];
        if let Some(ttl) = self.ttl_s {
            t.push(json!(ttl));
        }
        json!({ "__t__": t })
    }
    fn unpack(v: &Value) -> Option<Self> {
        let t = v.as_object()?.get("__t__")?.as_array()?;
        if !(3..=4).contains(&t.len()) {
            return None;
        }
        let wall = match &t[1] {
            Value::Object(m) => m.get("__dt__")?.as_str()?,
            _ => return None,
        };
        Some(CacheEntry {
            stored_at: t[0].as_f64()?,
            wall: DateTime::parse_from_rfc3339(wall).ok()?.with_timezone(&Utc),
            data: unpack(&t[2]),
            ttl_s: match t.get(3) {
                Some(x) => Some(x.as_f64()?),
                None => None,
            },
        })
    }
}

/// Python `dumps`: compact JSON. NaN cannot be written by serde (Python writes `NaN`): such a
/// value is not mirrored, as Python skips a value that is not JSON-safe.
pub fn dumps<V: Mirrored>(v: &V) -> Option<String> {
    serde_json::to_string(&v.pack()).ok()
}

/// Python `loads`
pub fn loads<V: Mirrored>(text: &str) -> Option<V> {
    let v: Value = serde_json::from_str(text).ok()?;
    V::unpack(&v)
}

// --------------------------------------------------------------------------- Redis link

/// Port of `RedisLink`: one Redis connection shared by the live services, with a simple circuit
/// breaker. Every call has a [`TIMEOUT_S`] limit; any failure marks Redis down for [`RETRY_S`]
/// (logged once per outage) and the caller carries on memory-only.
pub struct RedisLink {
    client: redis::Client,
    conn: tokio::sync::Mutex<Option<redis::aio::MultiplexedConnection>>,
    down_until: Mutex<Option<Instant>>,
}

impl fmt::Debug for RedisLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // never the URL: it holds the password
        f.debug_struct("RedisLink").finish_non_exhaustive()
    }
}

impl RedisLink {
    /// Python `RedisLink.from_url`. Nothing is connected yet (the first call connects).
    pub fn from_url(url: &str) -> Result<RedisLink, redis::RedisError> {
        Ok(RedisLink {
            client: redis::Client::open(url)?,
            conn: tokio::sync::Mutex::new(None),
            down_until: Mutex::new(None),
        })
    }

    /// Python `RedisLink.up`
    pub fn up(&self) -> bool {
        match *self.down_until.lock().unwrap_or_else(|p| p.into_inner()) {
            Some(until) => Instant::now() >= until,
            None => true,
        }
    }

    fn mark_down(&self, what: &str) {
        let mut down = self.down_until.lock().unwrap_or_else(|p| p.into_inner());
        let was_up = down.is_none_or(|u| Instant::now() >= u);
        if was_up {
            // log once per outage; the error kind only (never the URL)
            tracing::warn!("Redis unavailable, live cache is memory-only for {RETRY_S:.0} s: {what}");
        }
        *down = Some(Instant::now() + Duration::from_secs_f64(RETRY_S));
    }

    /// Python `RedisLink.call`: `cmd` on the connection, or None while Redis is marked down or when
    /// the call fails / times out.
    async fn call<T: redis::FromRedisValue>(&self, cmd: redis::Cmd) -> Option<T> {
        if !self.up() {
            return None;
        }
        let limit = Duration::from_secs_f64(TIMEOUT_S);
        let mut guard = self.conn.lock().await;
        if guard.is_none() {
            match tokio::time::timeout(limit, self.client.get_multiplexed_async_connection()).await {
                Ok(Ok(c)) => *guard = Some(c),
                Ok(Err(e)) => {
                    self.mark_down(e.category());
                    return None;
                }
                Err(_) => {
                    self.mark_down("TimeoutError");
                    return None;
                }
            }
        }
        let mut conn = guard.as_ref()?.clone();
        drop(guard);
        match tokio::time::timeout(limit, cmd.query_async::<T>(&mut conn)).await {
            Ok(Ok(v)) => Some(v),
            Ok(Err(e)) => {
                *self.conn.lock().await = None;
                self.mark_down(e.category());
                None
            }
            Err(_) => {
                *self.conn.lock().await = None;
                self.mark_down("TimeoutError");
                None
            }
        }
    }

    async fn get(&self, key: &str) -> Option<String> {
        self.call::<Option<String>>(redis::Cmd::get(key)).await.flatten()
    }

    async fn set_ex(&self, key: &str, text: &str, seconds: u64) {
        let _: Option<()> = self.call(redis::Cmd::set_ex(key, text, seconds)).await;
    }

    async fn delete(&self, key: &str) {
        let _: Option<i64> = self.call(redis::Cmd::del(key)).await;
    }
}

/// Python `redis_link(url)`: the process's Redis link for `url` (None when `url` is empty or not a
/// Redis URL; a bad URL is logged without the URL itself).
pub fn redis_link(url: &str) -> Option<Arc<RedisLink>> {
    if url.trim().is_empty() {
        return None;
    }
    match RedisLink::from_url(url.trim()) {
        Ok(link) => Some(Arc::new(link)),
        Err(e) => {
            tracing::warn!("REDIS_URL is not usable, live cache is memory-only: {}", e.category());
            None
        }
    }
}

// --------------------------------------------------------------------------- the tiered map

type ExpireFn<V> = Box<dyn Fn(&V) -> f64 + Send + Sync>;

/// Port of `TieredDict`: the map operations the live services use (`get`, `set`, `pop`,
/// `contains`), backed by a process map and, when `link` is set, mirrored in Redis. `expire_s(value)`
/// gives a key's Redis lifetime in seconds (<= 0: not mirrored).
pub struct TieredMap<V: Mirrored> {
    local: Mutex<HashMap<String, V>>,
    prefix: String,
    link: Option<Arc<RedisLink>>,
    expire_s: ExpireFn<V>,
}

impl<V: Mirrored> fmt::Debug for TieredMap<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TieredMap").field("prefix", &self.prefix).field("redis", &self.link.is_some()).finish()
    }
}

impl<V: Mirrored> TieredMap<V> {
    /// Python `TieredDict(name, link, expire_s)`
    pub fn new(name: &str, link: Option<Arc<RedisLink>>, expire_s: impl Fn(&V) -> f64 + Send + Sync + 'static) -> Self {
        TieredMap {
            local: Mutex::new(HashMap::new()),
            prefix: format!("{NAMESPACE}{name}:"),
            link,
            expire_s: Box::new(expire_s),
        }
    }

    fn rkey<K: MapKey + ?Sized>(&self, key: &K) -> String {
        format!("{}{}", self.prefix, key.map_repr())
    }

    fn local(&self) -> std::sync::MutexGuard<'_, HashMap<String, V>> {
        self.local.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Python `TieredDict.get`: the process map first; on a miss Redis, whose value then becomes
    /// the first level. An unreadable Redis value is a miss.
    pub async fn get<K: MapKey + ?Sized>(&self, key: &K) -> Option<V> {
        if let Some(hit) = self.local().get(&key.map_repr()) {
            return Some(hit.clone());
        }
        let link = self.link.as_ref()?;
        let raw = link.get(&self.rkey(key)).await?;
        let value: V = loads(&raw)?;
        self.local().insert(key.map_repr(), value.clone());
        Some(value)
    }

    /// Python `TieredDict.__setitem__`
    pub async fn set<K: MapKey + ?Sized>(&self, key: &K, value: V) {
        let ttl = (self.expire_s)(&value);
        let text = if self.link.is_some() && ttl > 0.0 { dumps(&value) } else { None };
        self.local().insert(key.map_repr(), value);
        if let (Some(link), Some(text)) = (&self.link, text) {
            // max(1, int(ttl))
            link.set_ex(&self.rkey(key), &text, (ttl as u64).max(1)).await;
        }
    }

    /// Python `TieredDict.pop`
    pub async fn pop<K: MapKey + ?Sized>(&self, key: &K) -> Option<V> {
        let value = self.local().remove(&key.map_repr());
        if let Some(link) = &self.link {
            link.delete(&self.rkey(key)).await;
        }
        value
    }

    /// Python `TieredDict.__contains__`
    pub async fn contains<K: MapKey + ?Sized>(&self, key: &K) -> bool {
        self.get(key).await.is_some()
    }
}

/// Python `cache_map(name, link, ttl_index=3)` (the entry's own TTL) or
/// `cache_map(name, link, None, fixed_ttl_s)`: kept in Redis [`STALE_KEEP_S`] beyond the TTL.
pub fn cache_map(name: &str, link: Option<Arc<RedisLink>>, fixed_ttl_s: f64) -> TieredMap<CacheEntry> {
    TieredMap::new(name, link, move |e: &CacheEntry| e.ttl_s.unwrap_or(fixed_ttl_s) + STALE_KEEP_S)
}

/// Python `cooldown_map(name, link, clock)`: `until` timestamps on `clock`; a key lives in Redis
/// until the cooldown ends (+ [`COOLDOWN_SLACK_S`]).
pub fn cooldown_map(name: &str, link: Option<Arc<RedisLink>>, clock: Clock) -> TieredMap<f64> {
    TieredMap::new(name, link, move |until: &f64| until - clock() + COOLDOWN_SLACK_S)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ttl: Option<f64>) -> CacheEntry {
        CacheEntry {
            stored_at: 1_764_000_000.5,
            wall: DateTime::parse_from_rfc3339("2026-11-27T03:04:05.123456+00:00").unwrap().with_timezone(&Utc),
            data: json!({"a": [1, 2.5, null], "b": "x"}),
            ttl_s: ttl,
        }
    }

    #[test]
    fn key_repr_is_pythons() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 7).unwrap();
        assert_eq!(key!("latest", "SN1", d).repr(), "('latest', 'SN1', datetime.date(2026, 11, 7))");
        assert_eq!(key!("plants", 1i64).repr(), "('plants', 1)");
        assert_eq!(key!("x").repr(), "('x',)");
        assert_eq!(key!("it's").repr(), "(\"it's\",)");
    }

    #[test]
    fn entry_roundtrip_in_python_encoding() {
        let e = entry(Some(120.0));
        let text = dumps(&e).unwrap();
        assert!(text.contains(r#""__t__""#) && text.contains(r#"{"__dt__":"2026-11-27T03:04:05.123456+00:00"}"#), "{text}");
        assert_eq!(loads::<CacheEntry>(&text), Some(e));
        let e3 = entry(None);
        assert_eq!(loads::<CacheEntry>(&dumps(&e3).unwrap()), Some(e3));
        // what Python writes for (stored_at, wall, data, ttl)
        let py = r#"{"__t__":[12.5,{"__dt__":"2026-11-27T03:04:05+00:00"},{"x":{"__t__":[1,2]}},300.0]}"#;
        let got: CacheEntry = loads(py).unwrap();
        assert_eq!(got.data, json!({"x": [1, 2]}));
        assert_eq!(got.ttl_s, Some(300.0));
        assert!(loads::<CacheEntry>("not json").is_none());
        assert!(loads::<CacheEntry>("[1,2]").is_none());
    }

    #[tokio::test]
    async fn memory_only_map() {
        let m = cache_map("t", None, 0.0);
        let k = key!("a", 1i64);
        assert!(m.get(&k).await.is_none());
        m.set(&k, entry(Some(10.0))).await;
        assert_eq!(m.get(&k).await.unwrap().ttl_s, Some(10.0));
        assert!(m.contains(&k).await);
        assert!(m.pop(&k).await.is_some());
        assert!(!m.contains(&k).await);
    }

    #[tokio::test]
    async fn expiry_policies() {
        let now = 1000.0;
        let c = cooldown_map("cd", None, Arc::new(move || now));
        assert_eq!((c.expire_s)(&1060.0), 65.0);
        let m = cache_map("c", None, 30.0);
        assert_eq!((m.expire_s)(&entry(Some(120.0))), 120.0 + STALE_KEEP_S);
        assert_eq!((m.expire_s)(&entry(None)), 30.0 + STALE_KEEP_S);
    }

    #[tokio::test]
    async fn redis_down_falls_back_to_memory() {
        // nothing listens on port 1: every call fails fast and the map carries on in memory
        let link = redis_link("redis://127.0.0.1:1/0").expect("a valid URL");
        let m = cache_map("t", Some(Arc::clone(&link)), 0.0);
        let k = key!("a");
        assert!(m.get(&k).await.is_none());
        assert!(!link.up(), "marked down after the failed connect");
        m.set(&k, entry(Some(5.0))).await;
        assert!(m.get(&k).await.is_some());
        assert!(m.pop(&k).await.is_some());
        assert!(redis_link("").is_none());
        assert!(redis_link("not a url").is_none());
    }

    /// Against a real Redis only when `TEST_REDIS_URL` is set (e.g. redis://127.0.0.1:6379/15).
    #[tokio::test]
    async fn redis_mirror_roundtrip() {
        let Ok(url) = std::env::var("TEST_REDIS_URL") else {
            eprintln!("skipped: TEST_REDIS_URL is not set");
            return;
        };
        let link = redis_link(&url).expect("TEST_REDIS_URL");
        let name = format!("rust-test-{}", std::process::id());
        let writer = cache_map(&name, Some(Arc::clone(&link)), 0.0);
        let k = key!("latest", "SN1", NaiveDate::from_ymd_opt(2026, 11, 27).unwrap());
        writer.set(&k, entry(Some(60.0))).await;
        // a second process (fresh memory) reads it back from Redis
        let reader = cache_map(&name, Some(Arc::clone(&link)), 0.0);
        assert_eq!(reader.get(&k).await, Some(entry(Some(60.0))));
        let ttl: i64 = link.call(redis::Cmd::ttl(writer.rkey(&k))).await.unwrap();
        assert!(ttl > 3600 && ttl <= 3660, "expires after TTL + STALE_KEEP_S: {ttl}");
        reader.pop(&k).await;
        let fresh = cache_map(&name, Some(Arc::clone(&link)), 0.0);
        assert!(fresh.get(&k).await.is_none());
        // a cooldown expires when it ends (+ slack)
        let cd = cooldown_map(&name, Some(Arc::clone(&link)), wall_clock());
        cd.set(&key!("plants", 1i64), wall_clock()() + 60.0).await;
        let ttl: i64 = link.call(redis::Cmd::ttl(cd.rkey(&key!("plants", 1i64)))).await.unwrap();
        assert!((60..=65).contains(&ttl), "{ttl}");
        cd.pop(&key!("plants", 1i64)).await;
        // with TEST_REDIS_INTEROP set, one entry stays for a Python `TieredDict("rust-interop")` to read
        if std::env::var("TEST_REDIS_INTEROP").is_ok() {
            cache_map("rust-interop", Some(link), 0.0).set(&k, entry(Some(60.0))).await;
        }
    }
}
