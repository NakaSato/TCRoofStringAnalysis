//! Unit tests of the live core (no Growatt server: an unreachable base URL makes every call fail
//! the way a network error does). The HTTP paths are covered by crates/api/tests/growatt_live.rs
//! against a stub Growatt server.

use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

struct FakeClock(AtomicU64);

impl FakeClock {
    fn new(t: f64) -> Arc<FakeClock> {
        Arc::new(FakeClock(AtomicU64::new(t.to_bits())))
    }
    fn now(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::SeqCst))
    }
    fn advance(&self, s: f64) {
        self.0.store((self.now() + s).to_bits(), Ordering::SeqCst);
    }
}

fn ts(s: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
}

/// A service on a fake clock whose Growatt is unreachable (connection refused).
fn service(cfg: LiveConfig, phases: Vec<i32>, now_local: &str) -> (LiveService, Arc<FakeClock>) {
    let clock = FakeClock::new(1_000_000.0);
    let c = Arc::clone(&clock);
    let local = ts(now_local);
    let factory: ClientFactory = Box::new(|_| {
        GrowattClient::new(
            "t",
            GrowattClientOptions {
                base_url: "http://127.0.0.1:1/".into(),
                timeout: std::time::Duration::from_secs(2),
                ..GrowattClientOptions::default()
            },
        )
    });
    let svc = LiveService::with_parts(cfg, phases, factory, Arc::new(move || c.now()), Arc::new(move || local), None);
    (svc, clock)
}

fn entry(stored_at: f64, ttl: f64, data: Value) -> CacheEntry {
    CacheEntry { stored_at, wall: Utc::now().trunc_subsecs(6), data, ttl_s: Some(ttl) }
}

#[test]
fn envelope_rounds_and_floors_refresh() {
    let r = LiveResult { wall: Utc::now(), data: json!([]), stale: false, error: None, refresh_in: 2.5 };
    assert_eq!(envelope(&r)["refresh_in_s"], json!(15));
    let r = LiveResult { refresh_in: 120.5, ..r };
    assert_eq!(envelope(&r)["refresh_in_s"], json!(120)); // half to even
    let r = LiveResult { refresh_in: 121.5, ..r };
    assert_eq!(envelope(&r)["refresh_in_s"], json!(122));
    assert_eq!(envelope(&r)["source"], json!("live"));
}

#[test]
fn phases_resolve_like_python() {
    let (svc, _) = service(LiveConfig::default(), vec![3, 1], "2026-11-27 12:00:00");
    assert_eq!(svc.phases(), &[1, 3]);
    assert_eq!(svc.resolve_phase(None), Ok(1));
    assert_eq!(svc.resolve_phase(Some(3)), Ok(3));
    assert_eq!(svc.resolve_phase(Some(2)), Err(LiveError::Unavailable("no Growatt token configured for phase 2".into())));
    let (none, _) = service(LiveConfig::default(), vec![], "2026-11-27 12:00:00");
    assert_eq!(none.resolve_phase(None), Err(LiveError::Unavailable("no Growatt token configured".into())));
}

#[test]
fn latest_ttl_follows_the_upload_rhythm() {
    let cfg = LiveConfig { latest_ttl_s: 300.0, ..LiveConfig::default() };
    let (svc, _) = service(cfg, vec![1], "2026-11-27 12:00:00");
    // record 2 min old, 5 min rhythm: next due in 3 min + grace
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "2026-11-27 11:58:00", "interval_s": 300.0})), 240.0);
    // no interval measured: the default rhythm
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "2026-11-27 11:58:00", "interval_s": null})), 240.0);
    // record ahead of our clock: capped at interval + grace
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "2026-11-27 12:10:00", "interval_s": 300.0})), 360.0);
    // overdue by less than two intervals: retry soon
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "2026-11-27 11:50:00", "interval_s": 300.0})), LATE_RETRY_S);
    // silent for longer, no record, unreadable: the cap
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "2026-11-27 10:00:00", "interval_s": 300.0})), 300.0);
    assert_eq!(svc.latest_ttl(&Value::Null), 300.0);
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "bad"})), 300.0);
    // an outage gap is not the rhythm
    assert_eq!(svc.latest_ttl(&json!({"timestamp": "2026-11-27 11:58:00", "interval_s": 5000.0})), 240.0);
}

#[test]
fn night_stretches_until_dawn_only() {
    let cfg = LiveConfig { night_ttl_s: 1800.0, ..LiveConfig::default() };
    let bkk = [(13.7563, 100.5018)];
    let (day, _) = service(cfg.clone(), vec![1], "2026-11-27 12:00:00");
    assert_eq!(day.until_daylight(&bkk), 0.0);
    assert_eq!(day.night(120.0, &bkk), 120.0);
    let (night, _) = service(cfg.clone(), vec![1], "2026-11-27 23:00:00");
    assert!(night.until_daylight(&bkk) > 5.0 * 3600.0);
    assert_eq!(night.night(120.0, &bkk), 1800.0);
    // shortly before dawn - margin: never past dawn
    let (dawn, _) = (daylight(ts("2026-11-28 00:00:00").date(), &bkk).unwrap().0, ());
    let before = (dawn - Duration::seconds(600)).format("%Y-%m-%d %H:%M:%S").to_string();
    let (early, _) = service(cfg.clone(), vec![1], &before);
    let left = early.night(120.0, &bkk);
    assert!((599.0..=601.0).contains(&left), "{left}");
    // no coordinates: Bangkok
    assert_eq!(night.until_daylight(&[]), night.until_daylight(&bkk));
    // off
    let (off, _) = service(LiveConfig::default(), vec![1], "2026-11-27 23:00:00");
    assert_eq!(off.night(120.0, &bkk), 120.0);
}

#[tokio::test]
async fn refused_call_cools_down_and_serves_stale() {
    let (svc, clock) = service(LiveConfig { cooldown_s: 60.0, ..LiveConfig::default() }, vec![1], "2026-11-27 12:00:00");
    let k = key!("plants", 1i64);
    let f = || fetch(|c: GrowattClient| async move { Ok(Value::Array(c.list_plants(true).await?.into_iter().map(Value::Object).collect())) });

    // nothing cached: unavailable, with the client's message, and the key cools down
    let err = svc.get(&k, f(), &Ttl::Fixed(120.0), 1, 0.0).await.unwrap_err();
    let LiveError::Unavailable(msg) = &err else { panic!("{err:?}") };
    assert!(msg.starts_with("Growatt request plant/list failed:"), "{msg}");
    assert!((svc.refresh_in(&k).await - 60.0).abs() < 1e-9);
    // during the cooldown no call is made
    let err = svc.get(&k, f(), &Ttl::Fixed(120.0), 1, 0.0).await.unwrap_err();
    assert_eq!(err, LiveError::Unavailable("Growatt rate limit cooldown".into()));

    // a cached, expired value is served as stale with the error
    svc.cache().set(&k, entry(clock.now() - 500.0, 120.0, json!(["old"]))).await;
    let r = svc.get(&k, f(), &Ttl::Fixed(120.0), 1, 0.0).await.unwrap();
    assert!(r.stale);
    assert_eq!(r.data, json!(["old"]));
    assert_eq!(r.error.as_deref(), Some("Growatt rate limit cooldown"));

    // fresh entries are served without a call, refresh_in = what is left of the TTL
    clock.advance(61.0);
    svc.cache().set(&k, entry(clock.now() - 20.0, 120.0, json!(["new"]))).await;
    let r = svc.get(&k, f(), &Ttl::Fixed(120.0), 1, 0.0).await.unwrap();
    assert!(!r.stale);
    assert!((r.refresh_in - 100.0).abs() < 1e-9);

    // gap_s: a refused call waits at least until gap_s after the last success
    let k2 = key!("latest", "SN", NaiveDate::from_ymd_opt(2026, 11, 27).unwrap());
    svc.cache().set(&k2, entry(clock.now() - 100.0, 50.0, json!({"x": 1}))).await;
    let r = svc.get(&k2, f(), &Ttl::Fixed(50.0), 1, 270.0).await.unwrap();
    assert!(r.stale);
    assert!((svc.refresh_in(&k2).await - 170.0).abs() < 1e-9, "{}", svc.refresh_in(&k2).await);
}

#[tokio::test]
async fn sweep_batches_oldest_first_and_reports_cached() {
    let cfg = LiveConfig::default();
    let (svc, clock) = service(cfg, vec![1], "2026-11-27 12:00:00");
    let now = clock.now();
    // a fresh, an expired (older) and a never-fetched item; one item on an unknown phase
    svc.cache().set(&key!("pdata", "1"), entry(now - 10.0, 300.0, json!({"today_energy_kwh": 1.0, "last_update_time": "2026-11-27 11:55:00"}))).await;
    svc.cache().set(&key!("pdata", "2"), entry(now - 400.0, 300.0, json!({"today_energy_kwh": 2.0, "last_update_time": "2026-11-26 18:00:00"}))).await;
    let out = svc.plant_today(&[(1, Some(1)), (2, Some(1)), (3, Some(1)), (4, Some(9))], &[]).await.unwrap();
    let d = &out["data"];
    assert_eq!(d["day"], json!("2026-11-27"));
    assert_eq!(d["plants"]["1"]["today_energy_kwh"], json!(1.0));
    assert_eq!(d["plants"]["1"]["stale"], json!(false));
    // yesterday's upload: no today energy; the refresh failed, so stale
    assert_eq!(d["plants"]["2"]["today_energy_kwh"], Value::Null);
    assert_eq!(d["plants"]["2"]["stale"], json!(true));
    assert!(d["plants"].get("3").is_none(), "never fetched: absent");
    assert_eq!(d["errors"]["4"], json!("no Growatt token configured for phase 9"));
    assert!(d["errors"]["3"].as_str().unwrap().starts_with("Growatt request plant/data failed"));
    assert_eq!(d["sweep"], json!({"fresh": 1, "checked": 2, "total": 4, "oldest_age_s": 400}));
    assert_eq!(out["stale"], json!(true));
    // plant 4 (unknown phase) never cools down, so it stays due: the page keeps polling
    assert_eq!(out["refresh_in_s"], json!(15));
}

#[tokio::test]
async fn empty_inputs() {
    let (svc, _) = service(LiveConfig::default(), vec![1], "2026-11-27 12:00:00");
    let out = svc.inverter_snapshot(&[], None, &[]).await.unwrap();
    assert_eq!(out["refresh_in_s"], json!(300));
    assert_eq!(out["data"]["sweep"], json!({"fresh": 0, "checked": 0, "total": 0, "oldest_age_s": 0, "inverters": 0, "answered": 0}));
    let err = svc.plant_latest(7, &[], ts("2026-11-27 00:00:00").date(), None, &[]).await.unwrap_err();
    assert_eq!(err, LiveError::Unavailable("no inverters".into()));
    let (none, _) = service(LiveConfig::default(), vec![], "2026-11-27 12:00:00");
    assert_eq!(none.plants(&[]).await.unwrap_err(), LiveError::Unavailable("no Growatt token configured".into()));
    assert_eq!(none.plant_dataloggers(7, None, &[]).await, (None, Some("no Growatt token configured".into())));
}

#[test]
fn items_dedup_like_a_dict() {
    let got = dedup_items(&[("a".into(), Some(1)), ("b".into(), None), ("a".into(), Some(2))]);
    assert_eq!(got, vec![("a".to_owned(), Some(2)), ("b".to_owned(), None)]);
}
