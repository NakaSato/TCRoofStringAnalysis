//! Log records of the Rust API stored in SQL `app_logs`, as backend/app/logging_db.py does it for
//! Python, so System → Logs shows both: same columns, `source` = "api", the same host, level
//! names / numbers, redaction, truncation, buffer limit and failure handling.
//!
//! - `DbLogLayer` (a tracing layer) turns an event into a row: `logger` = the event's target, so
//!   Python's logger names are used as targets where they matter (`app.audit`, `app.api.request`).
//!   A field `exc_text` fills that column (Python's traceback); other fields go to `extra_json`
//!   (Python's `extra={"ctx": {...}}`).
//! - Stored: level ≥ `LOG_DB_LEVEL` and ≥ INFO (Python's root / `app` loggers are at INFO, so DEBUG
//!   never reaches its handler). Never stored: `sqlx` (Python: `sqlalchemy`), this module, and
//!   tower-http's trace events (console only); HTTP-client and server crates below WARNING (Python:
//!   `urllib3` / `httpx` / `httpcore` / `requests`).
//! - `DbLog::flush` bulk-inserts the buffer in one transaction. The request middleware flushes before
//!   each response is returned (Cloud Run cuts CPU after it), like Python's API. A failed insert is
//!   printed to stderr, never logged (no recursion); its records go back in the buffer and flushes
//!   pause `RETRY_AFTER_FAILURE_S`. Unlike Python's API, `spawn_flusher` also flushes every
//!   `LOG_FLUSH_INTERVAL_S` and at once after an ERROR (Python does that in the worker), so records
//!   logged outside a request (start-up) don't wait for the next request.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use regex::Regex;
use serde_json::{Map, Value};
use tcroof_db::logs::NewLog;
use tcroof_db::PgPool;
use tokio::sync::Notify;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use crate::config::Settings;

pub const MESSAGE_MAX: usize = 4_000;
pub const EXC_MAX: usize = 16_000;
pub const MASK: &str = "***";
pub const RETRY_AFTER_FAILURE_S: u64 = 30;

/// Python `_SKIP_PREFIXES` (+ the Rust crates in the same role)
const SKIP_PREFIXES: &[&str] = &["sqlx", "sqlalchemy", "app.logging_db", "tcroof_api::logging", "tower_http"];
/// Python `_QUIET_PREFIXES` (+ the Rust HTTP crates): stored from WARNING up only
const QUIET_PREFIXES: &[&str] =
    &["urllib3", "httpx", "httpcore", "requests", "reqwest", "hyper", "h2", "rustls", "tower", "axum", "mio", "tokio"];

tokio::task_local! {
    /// Python `request_id_var`: set by the request middleware for the request's task.
    pub static REQUEST_ID: String;
    /// Python `run_id_var` / `job_var`: set by the worker (`tcroof-worker`, `runs::execute`) for
    /// the run's task, so every record logged during a job carries its run id and job.
    pub static RUN: (i32, String);
}

/// Python `logging.getLevelNamesMapping()`
pub fn level_no(name: &str) -> Option<i16> {
    Some(match name {
        "CRITICAL" | "FATAL" => 50,
        "ERROR" => 40,
        "WARNING" | "WARN" => 30,
        "INFO" => 20,
        "DEBUG" => 10,
        "NOTSET" => 0,
        _ => return None,
    })
}

/// Python `record.levelname` / `levelno` of a tracing level (tracing has no CRITICAL; TRACE is below DEBUG).
fn level_of(l: &Level) -> (&'static str, i16) {
    match *l {
        Level::ERROR => ("ERROR", 40),
        Level::WARN => ("WARNING", 30),
        Level::INFO => ("INFO", 20),
        Level::DEBUG => ("DEBUG", 10),
        Level::TRACE => ("TRACE", 5),
    }
}

/// Python `urlsplit(url).password`: the raw (still percent-encoded) text after the first `:` of
/// the user info.
fn url_password(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let netloc = rest.split(['/', '?', '#']).next()?;
    let (userinfo, _) = netloc.rsplit_once('@')?;
    let (_, pw) = userinfo.split_once(':')?;
    Some(pw.to_owned())
}

/// Python `redact` / `_redact_obj`.
pub struct Redactor {
    /// exact secret values, longest first
    values: Vec<String>,
    patterns: Vec<(Regex, &'static str)>,
}

impl Redactor {
    /// Python `_secret_values`
    pub fn from_settings(s: &Settings) -> Redactor {
        let mut vals: Vec<String> = [
            &s.growatt_api_token,
            &s.growatt_token_phase1,
            &s.growatt_token_phase2,
            &s.growatt_token_phase3,
            &s.growatt_token_phase4,
            &s.google_weather_api_key,
            &s.jwt_secret_key,
            &s.admin_password,
            &s.report_api_key,
            &s.ai_api_key,
            &s.longdo_api_key,
            &s.geoapify_api_key,
        ]
        .into_iter()
        .cloned()
        .collect();
        for url in [&s.database_url, &s.redis_url] {
            if let Some(pw) = url_password(url).filter(|p| !p.is_empty()) {
                vals.push(pw);
            }
        }
        Redactor::new(vals)
    }

    pub fn new(values: Vec<String>) -> Redactor {
        // very short values would mask ordinary words
        let mut values: Vec<String> =
            values.into_iter().map(|v| v.trim().to_owned()).filter(|v| v.chars().count() >= 6).collect();
        values.sort();
        values.dedup();
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        let p = |re: &str| Regex::new(re).expect("redaction pattern");
        let patterns = vec![
            (p(r#"(?i)([?&](?:key|token|access_token|api_key|apikey)=)[^&\s"']+"#), "${1}***"),
            (p(r"(?i)(Authorization:\s*Bearer\s+)\S+"), "${1}***"),
            (p(r"(Bearer\s+)[A-Za-z0-9._-]{12,}"), "${1}***"),
            (p(r#"(?i)(token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}"#), "${1}***"),
            (p(r"(postgres(?:ql)?(?:\+\w+)?://[^:/@\s]+:)[^@\s]+(@)"), "${1}***${2}"),
            (p(r"(rediss?://[^:/@\s]*:)[^@\s]+(@)"), "${1}***${2}"),
        ];
        Redactor { values, patterns }
    }

    /// The text with the secret values and token-shaped patterns replaced by `***`.
    pub fn redact(&self, text: &str) -> String {
        let mut t = text.to_owned();
        for v in &self.values {
            if t.contains(v.as_str()) {
                t = t.replace(v.as_str(), MASK);
            }
        }
        for (re, rep) in &self.patterns {
            t = re.replace_all(&t, *rep).into_owned();
        }
        t
    }

    pub fn redact_value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.redact(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.redact_value(x)).collect()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), self.redact_value(x))).collect()),
            other => other.clone(),
        }
    }
}

/// Python `_trunc`: longer than `n` characters → the first `n - 20` + " … [truncated]".
pub fn trunc(text: String, n: usize) -> String {
    if text.chars().count() <= n {
        return text;
    }
    let mut out: String = text.chars().take(n - 20).collect();
    out.push_str(" … [truncated]");
    out
}

/// `K_REVISION` (Cloud Run) or the host name (Python `socket.gethostname()`), at most 64 characters.
pub fn host_name() -> String {
    let name = std::env::var("K_REVISION").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length; gethostname writes a NUL-terminated name
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc != 0 {
            return String::new();
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    });
    name.chars().take(64).collect()
}

/// One record before redaction (what the tracing layer saw).
pub struct Record {
    pub level: &'static str,
    pub level_no: i16,
    pub logger: String,
    pub message: String,
    pub exc_text: Option<String>,
    pub extra: Option<Value>,
}

struct Buf {
    rows: VecDeque<NewLog>,
    dropped: u64,
}

/// Python `DbLogHandler`: buffers redacted rows and bulk-inserts them on `flush()`.
pub struct DbLog {
    source: String,
    host: String,
    min_level_no: i16,
    pool: PgPool,
    redactor: Redactor,
    max: usize,
    buf: Mutex<Buf>,
    flush_lock: tokio::sync::Mutex<()>,
    retry_at: Mutex<Option<Instant>>,
    wake: Notify,
}

impl DbLog {
    /// Python `setup_logging(source)`: `None` when `LOG_DB_ENABLED` is false.
    pub fn from_settings(source: &str, s: &Settings, pool: PgPool) -> Option<Arc<DbLog>> {
        if !s.log_db_enabled {
            return None;
        }
        // unknown names fall back to INFO, as Python's `.get(..., logging.INFO)`
        let configured = level_no(&s.log_db_level.to_uppercase()).unwrap_or(20);
        Some(Arc::new(DbLog {
            source: source.to_owned(),
            host: host_name(),
            min_level_no: configured.max(20),
            pool,
            redactor: Redactor::from_settings(s),
            max: s.log_buffer_max.max(1),
            buf: Mutex::new(Buf { rows: VecDeque::new(), dropped: 0 }),
            flush_lock: tokio::sync::Mutex::new(()),
            retry_at: Mutex::new(None),
            wake: Notify::new(),
        }))
    }

    /// Whether a record with this level and logger is stored at all (Python handler level + `_DbFilter`).
    pub fn accepts(&self, level_no: i16, logger: &str) -> bool {
        if level_no < self.min_level_no || SKIP_PREFIXES.iter().any(|p| logger.starts_with(p)) {
            return false;
        }
        !(level_no < 30 && QUIET_PREFIXES.iter().any(|p| logger.starts_with(p)))
    }

    /// Python `DbLogHandler.emit`: redact, truncate, append (the oldest goes when the buffer is full).
    pub fn emit(&self, r: Record) {
        if !self.accepts(r.level_no, &r.logger) {
            return;
        }
        let row = NewLog {
            ts: Utc::now(),
            level: r.level.chars().take(8).collect(),
            level_no: r.level_no,
            source: self.source.clone(),
            host: Some(self.host.clone()),
            logger: r.logger.chars().take(128).collect(),
            message: trunc(self.redactor.redact(&r.message), MESSAGE_MAX),
            exc_text: r.exc_text.filter(|t| !t.is_empty()).map(|t| trunc(self.redactor.redact(&t), EXC_MAX)),
            run_id: RUN.try_with(|r| r.0).ok(),
            job: RUN.try_with(|r| r.1.clone()).ok(),
            request_id: REQUEST_ID.try_with(Clone::clone).ok(),
            extra_json: r.extra.map(|v| self.redactor.redact_value(&v)),
        };
        {
            let mut b = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            if b.rows.len() >= self.max {
                b.rows.pop_front();
                b.dropped += 1;
            }
            b.rows.push_back(row);
        }
        if r.level_no >= 40 {
            self.wake.notify_one();
        }
    }

    pub fn pending(&self) -> usize {
        self.buf.lock().unwrap_or_else(|e| e.into_inner()).rows.len()
    }

    /// True while flushes are paused after a failed insert.
    pub fn waiting(&self) -> bool {
        self.retry_at.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| Instant::now() < t)
    }

    /// Python `DbLogHandler.flush`: insert everything buffered in one transaction; on failure print
    /// once to stderr, put the records back (oldest first, as far as there is room) and pause
    /// flushes for `RETRY_AFTER_FAILURE_S`. `force` (shutdown) ignores that pause.
    pub async fn flush(&self, force: bool) {
        {
            let b = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            if b.rows.is_empty() && b.dropped == 0 {
                return;
            }
        }
        if !force && self.waiting() {
            return;
        }
        let _guard = self.flush_lock.lock().await;
        if !force && self.waiting() {
            return;
        }
        let (mut rows, dropped) = {
            let mut b = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            let rows: Vec<NewLog> = b.rows.drain(..).collect();
            (rows, std::mem::take(&mut b.dropped))
        };
        let records = rows.len();
        if dropped > 0 {
            rows.push(NewLog {
                ts: Utc::now(),
                level: "WARNING".into(),
                level_no: 30,
                source: self.source.clone(),
                host: Some(self.host.clone()),
                logger: "app.logging_db".into(),
                message: format!("log buffer full: {dropped} older records dropped"),
                exc_text: None,
                run_id: None,
                job: None,
                request_id: None,
                extra_json: None,
            });
        }
        if rows.is_empty() {
            return;
        }
        match tcroof_db::logs::insert_logs(&self.pool, &rows).await {
            Ok(()) => *self.retry_at.lock().unwrap_or_else(|e| e.into_inner()) = None,
            Err(e) => {
                *self.retry_at.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(Instant::now() + Duration::from_secs(RETRY_AFTER_FAILURE_S));
                rows.truncate(records);
                let kept = self.requeue(rows, dropped);
                let lost = if kept < records { format!(", {} dropped (buffer full)", records - kept) } else { String::new() };
                let msg: String = self.redactor.redact(&e.to_string()).chars().take(300).collect();
                eprintln!("app_logs insert failed, {kept} records kept for the next flush{lost}: {msg}");
            }
        }
    }

    /// Python `_requeue`: `rows` back in front of what was logged meanwhile; the newest of them win
    /// when there is not room for all, the rest (and `dropped`) count as dropped.
    fn requeue(&self, rows: Vec<NewLog>, dropped: u64) -> usize {
        let mut b = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        let room = self.max.saturating_sub(b.rows.len());
        let n = rows.len();
        let keep: Vec<NewLog> = if room == 0 { Vec::new() } else { rows.into_iter().skip(n.saturating_sub(room)).collect() };
        let kept = keep.len();
        for r in keep.into_iter().rev() {
            b.rows.push_front(r);
        }
        b.dropped += dropped + (n - kept) as u64;
        kept
    }

    /// The background flush (see the module doc): every `interval`, and at once after an ERROR.
    pub fn spawn_flusher(self: &Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = me.wake.notified() => {}
                }
                me.flush(false).await;
            }
        })
    }
}

/// Feeds tracing events into a `DbLog`.
pub struct DbLogLayer(pub Arc<DbLog>);

impl DbLog {
    /// Whether an event with this metadata would be stored.
    pub fn accepts_meta(&self, m: &Metadata<'_>) -> bool {
        self.accepts(level_of(m.level()).1, m.target())
    }
}

/// The `app_logs` layer. It has no per-layer filter: under a global dispatcher those left the
/// library's own callsites (the audit lines) disabled. It applies `DbLog::accepts` itself, first
/// thing in `on_event`; the subscriber's global filter (RUST_LOG, default `info`) comes before it.
pub fn db_layer(sink: Arc<DbLog>) -> DbLogLayer {
    DbLogLayer(sink)
}

/// The process's subscriber (Python `setup_logging`'s console part + the handler): one global
/// filter (RUST_LOG, default `info`) for the console and app_logs, then the DB layer applies
/// LOG_DB_LEVEL and its logger rules itself. Call once, at start.
pub fn init_tracing(logs: Option<Arc<DbLog>>) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .with(logs.map(db_layer))
        .init();
}

/// [`init_tracing`] with the console on stderr (the worker: stdout carries only `--once`'s run,
/// as Python's worker prints it while its log goes to stderr); colours only on a terminal.
pub fn init_tracing_stderr(logs: Option<Arc<DbLog>>) {
    use std::io::IsTerminal;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_ansi(std::io::stderr().is_terminal()))
        .with(logs.map(db_layer))
        .init();
}

#[derive(Default)]
struct Fields {
    message: Option<String>,
    exc_text: Option<String>,
    extra: Map<String, Value>,
}

impl Fields {
    fn put(&mut self, f: &Field, v: Value) {
        match f.name() {
            "message" => self.message = Some(v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())),
            "exc_text" => self.exc_text = Some(v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())),
            n if n.starts_with("log.") => {}
            n => {
                self.extra.insert(n.to_owned(), v);
            }
        }
    }
}

impl Visit for Fields {
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        self.put(f, Value::String(format!("{v:?}")));
    }
    fn record_str(&mut self, f: &Field, v: &str) {
        self.put(f, Value::String(v.to_owned()));
    }
    fn record_i64(&mut self, f: &Field, v: i64) {
        self.put(f, Value::from(v));
    }
    fn record_u64(&mut self, f: &Field, v: u64) {
        self.put(f, Value::from(v));
    }
    fn record_bool(&mut self, f: &Field, v: bool) {
        self.put(f, Value::from(v));
    }
    fn record_f64(&mut self, f: &Field, v: f64) {
        self.put(f, serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null));
    }
}

impl<S: Subscriber> Layer<S> for DbLogLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let m = event.metadata();
        if !self.0.accepts_meta(m) {
            return;
        }
        let (level, level_no) = level_of(m.level());
        let mut f = Fields::default();
        event.record(&mut f);
        self.0.emit(Record {
            level,
            level_no,
            logger: m.target().to_owned(),
            message: f.message.unwrap_or_default(),
            exc_text: f.exc_text,
            extra: if f.extra.is_empty() { None } else { Some(Value::Object(f.extra)) },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r() -> Redactor {
        let s = Settings {
            jwt_secret_key: "jwt-secret-value-123".into(),
            growatt_token_phase2: "  growatt-token-abc  ".into(),
            admin_password: "short".into(),
            database_url: "postgresql+psycopg://app:db%40pw123@10.0.0.2:5432/tcroof".into(),
            ..Settings::default()
        };
        Redactor::from_settings(&s)
    }

    #[test]
    fn secret_values_are_masked_short_ones_kept() {
        let r = r();
        assert_eq!(r.redact("key jwt-secret-value-123 and growatt-token-abc"), "key *** and ***");
        assert_eq!(r.redact("a short password"), "a short password", "under 6 characters is not masked");
        assert_eq!(r.redact("pw db%40pw123"), "pw ***", "the raw URL password");
    }

    #[test]
    fn patterns_match_python() {
        // expected values from backend/app/logging_db.redact with empty settings
        let r = Redactor::new(vec![]);
        let cases = [
            ("GET https://x/y?key=AIzaSyABC&b=1", "GET https://x/y?key=***&b=1"),
            ("u?TOKEN=abc def", "u?TOKEN=*** def"),
            ("Authorization: Bearer abc", "Authorization: Bearer ***"),
            ("sent Bearer eyJhbGciOiJIUzI1NiJ9.x.y", "sent Bearer ***"),
            ("Bearer short", "Bearer short"),
            ("token: 'abcdefghijklmnop'", "token: '***'"),
            ("\"token\":\"abcdefghijklmnop\"", "\"token\":\"***\""),
            ("postgresql+psycopg://app:s3cr@t@host/db", "postgresql+psycopg://app:***@t@host/db"),
            ("postgres://u:pw@h/d", "postgres://u:***@h/d"),
            ("redis://:pw123@10.0.0.2:6379/0", "redis://:***@10.0.0.2:6379/0"),
            ("", ""),
        ];
        for (inp, want) in cases {
            assert_eq!(r.redact(inp), want, "{inp}");
        }
        let v = serde_json::json!({"url": "a?key=zzz", "n": 3, "l": ["Bearer abcdefghijklm"]});
        assert_eq!(r.redact_value(&v), serde_json::json!({"url": "a?key=***", "n": 3, "l": ["Bearer ***"]}));
    }

    #[test]
    fn trunc_matches_python() {
        assert_eq!(trunc("abc".into(), 10), "abc");
        let t = trunc("x".repeat(30), 25);
        assert_eq!(t, format!("{} … [truncated]", "x".repeat(5)));
    }

    #[test]
    fn url_password_like_urlsplit() {
        assert_eq!(url_password("postgresql+psycopg://u:p%40w@h:5/d").as_deref(), Some("p%40w"));
        assert_eq!(url_password("redis://:pw@h:6379/0").as_deref(), Some("pw"));
        assert_eq!(url_password("postgres://u@h/d"), None);
        assert_eq!(url_password(""), None);
    }

    #[test]
    fn level_names() {
        assert_eq!(level_no("WARNING"), Some(30));
        assert_eq!(level_no("WARN"), Some(30));
        assert_eq!(level_no("nope"), None);
    }
}

