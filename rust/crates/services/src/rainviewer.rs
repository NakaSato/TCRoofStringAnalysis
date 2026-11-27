//! Port of `backend/app/services/rainviewer.py`: fallback rain radar tiles for the Plant Map when
//! Longdo has none to give (no key, or its snapshot list cannot be read with nothing cached).
//!
//! Tiles only: RainViewer gives no rain value over a point (`point_rain: false`). Memory only
//! (mirrored in Redis when configured: maps `rainviewer` / `rainviewer-cooldown`, key `'maps'`),
//! never stored. No key, no counted budget.

use std::sync::Arc;

use serde_json::{json, Value};
use tcroof_clients::rainviewer::{RainViewerClient, ATTRIBUTION, TILE_MAX_ZOOM, TILE_MIN_ZOOM};

use crate::live_store::{cooldown_map, wall_clock, Clock, RedisLink, TieredMap};
use crate::longdo::{env, now_iso, str_cache_map, StrEntry};

/// Python `SOURCE`
pub const SOURCE: &str = "RainViewer weather radar";
/// Python `KEY`
pub const KEY: &str = "maps";
/// Python `RainViewerLive.__init__` default `cooldown_s`
pub const COOLDOWN_S: f64 = 60.0;

/// Python `RainViewerUnavailable`
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct RainViewerUnavailable {
    pub message: String,
    pub retry_s: f64,
}

/// The settings this module reads (Python `settings.rainviewer_*`).
#[derive(Debug, Clone)]
pub struct RainViewerConfig {
    /// `RAINVIEWER_ENABLED` (true)
    pub enabled: bool,
    pub url: String,
    pub ttl_s: f64,
    pub timeout_s: f64,
}

/// Port of `RainViewerLive`: the snapshot list, cached `ttl_s`; a failed call serves the last list
/// as stale and waits `cooldown_s`.
pub struct RainViewerLive {
    pub cfg: RainViewerConfig,
    client: RainViewerClient,
    cooldown_s: f64,
    clock: Clock,
    cache: TieredMap<StrEntry>,
    cooldown_until: TieredMap<f64>,
    /// Python holds one lock over the whole lookup (one snapshot list)
    lock: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for RainViewerLive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RainViewerLive").field("enabled", &self.cfg.enabled).finish_non_exhaustive()
    }
}

impl RainViewerLive {
    /// Python `get_rainviewer_live`
    pub fn new(cfg: RainViewerConfig, redis: Option<Arc<RedisLink>>) -> RainViewerLive {
        Self::with_clock(cfg, wall_clock(), redis)
    }

    pub fn with_clock(cfg: RainViewerConfig, clock: Clock, redis: Option<Arc<RedisLink>>) -> RainViewerLive {
        RainViewerLive {
            client: RainViewerClient::new(&cfg.url, cfg.timeout_s),
            cfg,
            cooldown_s: COOLDOWN_S,
            cache: str_cache_map("rainviewer", redis.clone()),
            cooldown_until: cooldown_map("rainviewer-cooldown", redis, Arc::clone(&clock)),
            clock,
            lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Python `maps`: envelope whose `data` is `{frames, tiles}`.
    pub async fn maps(&self, ttl_s: f64) -> Result<Value, RainViewerUnavailable> {
        let _guard = self.lock.lock().await;
        let now = (self.clock)();
        let hit = self.cache.get(KEY).await;
        if let Some(h) = &hit {
            if now - h.stored_at < ttl_s {
                return Ok(env(&h.wall, &h.data, false, None, ttl_s - (now - h.stored_at)));
            }
        }
        let mut wait = self.cooldown_until.get(KEY).await.unwrap_or(0.0) - now;
        let error: String;
        if wait > 0.0 {
            error = "RainViewer cooldown after an error".into();
        } else {
            match self.client.maps().await {
                Err(e) => {
                    error = e.to_string();
                    wait = self.cooldown_s;
                    self.cooldown_until.set(KEY, now + wait).await;
                }
                Ok(maps) => {
                    let data = serde_json::to_value(&maps).unwrap_or(Value::Null);
                    let wall = now_iso();
                    self.cache.set(KEY, StrEntry { stored_at: now, wall: wall.clone(), data: data.clone(), ttl_s }).await;
                    self.cooldown_until.pop(KEY).await;
                    return Ok(env(&wall, &data, false, None, ttl_s));
                }
            }
        }
        match hit {
            Some(h) => Ok(env(&h.wall, &h.data, true, Some(&error), wait)),
            None => Err(RainViewerUnavailable { message: error, retry_s: wait }),
        }
    }
}

/// Python `radar`: same shape as `longdo.radar`, plus `frame_tiles` (each snapshot has its own
/// tile path), `point_rain: false` and why Longdo is not used.
pub async fn radar(live: &RainViewerLive, fallback_reason: Option<&str>) -> Result<Value, RainViewerUnavailable> {
    let mut env = live.maps(live.cfg.ttl_s).await?;
    let maps = env["data"].take();
    let frames: Vec<Value> = maps.get("frames").and_then(Value::as_array).cloned().unwrap_or_default();
    let tiles = maps.get("tiles").filter(|t| t.is_object()).cloned().unwrap_or_else(|| json!({}));
    // the newest snapshot's tiles; a client that ignores `frame_tiles` still shows rain
    let tile_url = frames
        .last()
        .and_then(|f| tiles.get(f.to_string().as_str()))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    env["data"] = json!({
        "provider": SOURCE,
        "radar": true,
        "frames": frames,
        "tile_url": tile_url,
        "frame_tiles": tiles,
        "min_zoom": TILE_MIN_ZOOM,
        "max_zoom": TILE_MAX_ZOOM,
        "attribution": ATTRIBUTION,
        // RainViewer's colours are not Longdo's 0–5 classes: no legend rather than a made-up one
        "legend": [],
        "point_rain": false,
        "fallback_reason": fallback_reason,
    });
    Ok(env)
}
