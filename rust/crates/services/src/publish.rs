//! Publishing registry and config documents to the summary sink: the parts of
//! backend/app/services/daily_summary.py that the settings routes call right after a save
//! (`publish_config`, `publish_plant_inverters`) and the machinery under them (`publish`, the
//! `published_docs` change check, the per-quota-day write counter, the JSON file sink).
//!
//! Firestore itself is Phase 4 of the port: with `PUBLISH_SINK=firestore` the sink answers an
//! error (as Python's does without credentials), which the routes report in `published.error`
//! without undoing the save, exactly like Python's `_publish_safely`. With `PUBLISH_SINK=json`
//! (Python's default) everything Python does is done here: changed documents are written to
//! `data/firestore_export/<path>.json`, their hashes to `published_docs` and the count to
//! `publish_write_counts`, so both backends agree on which documents are unchanged.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::common::{isoformat_utc, Inverter, INVERTER_COLS};
use crate::inverter_models::model_spec;

/// Python `Doc`: (path, document)
pub type Doc = (String, Value);

/// Python `daily_summary.SCHEMA_VERSION`
pub const SCHEMA_VERSION: i64 = 1;
/// Python `daily_summary.MAX_DOC_BYTES`
pub const MAX_DOC_BYTES: usize = 1_000_000;

// --------------------------------------------------------------------------- Python JSON text

/// Python `float.__repr__` (what `json.dumps` writes for a float): the shortest round-trip
/// digits, fixed notation for decimal exponents -4..15, else `1.5e+16` / `1e-05`.
pub fn py_float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let e_fmt = format!("{:e}", x.abs()); // shortest digits, e.g. "5.7e2"
    let (mant, exp) = e_fmt.split_once('e').expect("LowerExp has an exponent");
    let exp: i32 = exp.parse().expect("exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let sign = if x < 0.0 { "-" } else { "" };
    let body = if (-4..16).contains(&exp) {
        if exp >= 0 {
            let int_len = exp as usize + 1;
            if digits.len() <= int_len {
                format!("{digits}{}.0", "0".repeat(int_len - digits.len()))
            } else {
                format!("{}.{}", &digits[..int_len], &digits[int_len..])
            }
        } else {
            format!("0.{}{digits}", "0".repeat((-exp - 1) as usize))
        }
    } else {
        let m = if digits.len() == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        format!("{m}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs())
    };
    format!("{sign}{body}")
}

fn number_text(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        n.to_string()
    } else {
        py_float_repr(n.as_f64().unwrap_or(f64::NAN))
    }
}

/// `json.dumps(s, ensure_ascii=False)` of a string
fn string_text(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn canonical_into(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_text(n)),
        Value::String(s) => string_text(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_into(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                string_text(k, out);
                out.push(':');
                canonical_into(&m[k], out);
            }
            out.push('}');
        }
    }
}

/// Python `daily_summary._canonical`: `json.dumps(doc, sort_keys=True, ensure_ascii=False,
/// separators=(",", ":"))` as UTF-8, byte for byte, so the content hashes match Python's.
pub fn canonical(doc: &Value) -> Vec<u8> {
    let mut s = String::new();
    canonical_into(doc, &mut s);
    s.into_bytes()
}

fn pretty_into(v: &Value, depth: usize, out: &mut String) {
    let pad = |d: usize| " ".repeat(d);
    match v {
        Value::Array(a) if !a.is_empty() => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                out.push_str(if i > 0 { ",\n" } else { "\n" });
                out.push_str(&pad(depth + 1));
                pretty_into(x, depth + 1, out);
            }
            out.push('\n');
            out.push_str(&pad(depth));
            out.push(']');
        }
        Value::Object(m) if !m.is_empty() => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                out.push_str(if i > 0 { ",\n" } else { "\n" });
                out.push_str(&pad(depth + 1));
                string_text(k, out);
                out.push_str(": ");
                pretty_into(x, depth + 1, out);
            }
            out.push('\n');
            out.push_str(&pad(depth));
            out.push('}');
        }
        other => canonical_into(other, out),
    }
}

/// `json.dumps(doc, ensure_ascii=False, indent=1)` (the JSON sink's file text)
pub fn pretty(doc: &Value) -> String {
    let mut s = String::new();
    pretty_into(doc, 0, &mut s);
    s
}

// --------------------------------------------------------------------------- quota day

/// The n-th Sunday (1-based) of a month
fn nth_sunday(year: i32, month: u32, n: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let to_sun = (7 - first.weekday().num_days_from_sunday()) % 7;
    first + Duration::days(i64::from(to_sun + 7 * (n - 1)))
}

/// Python `daily_summary.quota_day`: the date in America/Los_Angeles (Firestore's free-tier
/// quotas reset at Pacific midnight). US rules since 2007: PDT (UTC-7) from the second Sunday of
/// March 02:00 PST to the first Sunday of November 02:00 PDT, else PST (UTC-8).
pub fn quota_day(now: DateTime<Utc>) -> String {
    let y = now.year();
    let start = Utc.from_utc_datetime(&nth_sunday(y, 3, 2).and_hms_opt(10, 0, 0).expect("time"));
    let end = Utc.from_utc_datetime(&nth_sunday(y, 11, 1).and_hms_opt(9, 0, 0).expect("time"));
    let offset_h = if now >= start && now < end { 7 } else { 8 };
    (now - Duration::hours(offset_h)).date_naive().format("%Y-%m-%d").to_string()
}

// --------------------------------------------------------------------------- sinks

/// Python `daily_summary.DocSink`
pub trait DocSink: Send + Sync {
    fn name(&self) -> &str;
    fn write(&self, docs: &[Doc]) -> Result<(), String>;
}

/// Python `daily_summary.JsonFileSink`: each document to `<root>/<path>.json` (indent 1).
pub struct JsonFileSink {
    pub root: PathBuf,
}

impl DocSink for JsonFileSink {
    fn name(&self) -> &str {
        "json"
    }

    fn write(&self, docs: &[Doc]) -> Result<(), String> {
        for (path, doc) in docs {
            let f = self.root.join(format!("{path}.json"));
            if let Some(dir) = f.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{e}: {}", dir.display()))?;
            }
            std::fs::write(&f, pretty(doc)).map_err(|e| format!("{e}: {}", f.display()))?;
        }
        Ok(())
    }
}

/// Python `daily_summary.FirestoreSink`. Not ported yet (Phase 4 of the port): it fails like
/// Python's does without `FIREBASE_CREDENTIALS_FILE`, and otherwise with a "not ported" message,
/// so a route reports `published.error` and keeps the save (Python's `_publish_safely`).
pub struct FirestoreSink {
    pub credentials_file: String,
}

impl DocSink for FirestoreSink {
    fn name(&self) -> &str {
        "firestore"
    }

    fn write(&self, _docs: &[Doc]) -> Result<(), String> {
        Err("Firestore publishing is not ported to the Rust API yet (Phase 4); the next publish job retries".into())
    }
}

/// The repository's `data/` folder (Python `config.DATA_DIR` = repo root / `data`): the nearest
/// of the working directory and its parents that holds `backend/app`, else `./data`.
pub fn default_data_dir() -> PathBuf {
    let mut dir = PathBuf::from(".");
    for _ in 0..4 {
        if dir.join("backend").join("app").is_dir() {
            return dir.join("data");
        }
        dir = dir.join("..");
    }
    PathBuf::from("data")
}

/// Python `daily_summary.make_sink` (the constructor errors of `FirestoreSink` included)
pub fn make_sink(kind: &str, credentials_file: &str, data_dir: &Path) -> Result<Box<dyn DocSink>, String> {
    if kind == "firestore" {
        if credentials_file.is_empty() {
            return Err("Set FIREBASE_CREDENTIALS_FILE in .env to publish to Firestore.".into());
        }
        return Ok(Box::new(FirestoreSink { credentials_file: credentials_file.to_owned() }));
    }
    Ok(Box::new(JsonFileSink { root: data_dir.join("firestore_export") }))
}

// --------------------------------------------------------------------------- publish

/// Python `daily_summary.PublishReport`
#[derive(Debug, Clone, Default)]
pub struct PublishReport {
    pub sink: String,
    pub considered: usize,
    pub unchanged: usize,
    pub written: usize,
    pub over_budget: Vec<String>,
    pub too_large: Vec<(String, usize)>,
    pub writes_today: i64,
    pub budget: i64,
    pub max_doc_bytes: usize,
    pub total_bytes: usize,
}

/// Python `daily_summary.publish`: write only changed documents, within today's write budget
/// (`dry_run` writes nothing anywhere). A sink failure is an `Err` and stores nothing.
pub async fn publish(
    pool: &PgPool,
    sink: &dyn DocSink,
    docs: &[Doc],
    budget: i64,
    dry_run: bool,
    now: Option<DateTime<Utc>>,
) -> Result<PublishReport, String> {
    let stamp = now.unwrap_or_else(Utc::now);
    let qday = quota_day(stamp);
    let name = sink.name().to_owned();
    let used: Option<i32> = sqlx::query_scalar("SELECT writes FROM publish_write_counts WHERE sink = $1 AND quota_day = $2")
        .bind(&name)
        .bind(&qday)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let had_counter = used.is_some();
    let used = i64::from(used.unwrap_or(0));
    let mut rep = PublishReport { sink: name.clone(), considered: docs.len(), budget, ..Default::default() };
    let known: std::collections::HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT path, content_hash FROM published_docs WHERE sink = $1")
            .bind(&name)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
    let mut pending: Vec<(&String, &Value, String, usize)> = Vec::new();
    for (path, doc) in docs {
        let body = canonical(doc);
        let size = body.len();
        rep.max_doc_bytes = rep.max_doc_bytes.max(size);
        rep.total_bytes += size;
        if size > MAX_DOC_BYTES {
            rep.too_large.push((path.clone(), size));
            continue;
        }
        let digest = format!("{:x}", Sha256::digest(&body));
        if known.get(path) == Some(&digest) {
            rep.unchanged += 1;
            continue;
        }
        if used + pending.len() as i64 >= budget {
            rep.over_budget.push(path.clone());
            continue;
        }
        pending.push((path, doc, digest, size));
    }
    rep.written = pending.len();
    rep.writes_today = used + pending.len() as i64;
    if dry_run || pending.is_empty() {
        if dry_run {
            rep.writes_today = used;
        }
        return Ok(rep);
    }
    let stamped: Vec<Doc> = pending
        .iter()
        .map(|(path, doc, _, _)| {
            let mut d: Map<String, Value> = doc.as_object().cloned().unwrap_or_default();
            d.insert("published_at".into(), Value::String(isoformat_utc(stamp)));
            ((*path).clone(), Value::Object(d))
        })
        .collect();
    sink.write(&stamped)?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (path, _doc, digest, size) in &pending {
        sqlx::query(
            "INSERT INTO published_docs (sink, path, content_hash, size_bytes, written_at) VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (sink, path) DO UPDATE SET content_hash = EXCLUDED.content_hash, \
             size_bytes = EXCLUDED.size_bytes, written_at = EXCLUDED.written_at",
        )
        .bind(&name)
        .bind(*path)
        .bind(digest)
        .bind(*size as i32)
        .bind(stamp)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    let writes = (used + pending.len() as i64) as i32;
    let q = if had_counter {
        "UPDATE publish_write_counts SET writes = $3 WHERE sink = $1 AND quota_day = $2"
    } else {
        "INSERT INTO publish_write_counts (sink, quota_day, writes) VALUES ($1, $2, $3) \
         ON CONFLICT (sink, quota_day) DO UPDATE SET writes = EXCLUDED.writes"
    };
    sqlx::query(q).bind(&name).bind(&qday).bind(writes).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(rep)
}

// --------------------------------------------------------------------------- registry documents

/// Python `daily_summary.build_inverter_docs`: `inverters/{sn}` registry docs (all, or one
/// plant's), with the as-built string topology only on inverters that have a layout row or a
/// removed input, and `not_installed: true` only on a marked inverter.
pub async fn build_inverter_docs(pool: &PgPool, plant_id: Option<i64>) -> Result<Vec<Doc>, sqlx::Error> {
    let invs: Vec<Inverter> = match plant_id {
        Some(p) => sqlx::query_as(&format!("SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 ORDER BY device_sn"))
            .bind(crate::plant_documents::id32(p))
            .fetch_all(pool)
            .await?,
        None => sqlx::query_as(&format!("SELECT {INVERTER_COLS} FROM growatt_inverters ORDER BY device_sn")).fetch_all(pool).await?,
    };
    let sns: Vec<String> = invs.iter().map(|i| i.device_sn.clone()).collect();
    type LayoutRow = (String, i32, i32, Option<f64>, Option<f64>, Option<f64>);
    let mut layout: std::collections::HashMap<String, Vec<LayoutRow>> = Default::default();
    let mut removed: std::collections::HashMap<String, Vec<i32>> = Default::default();
    if !sns.is_empty() {
        let rows: Vec<LayoutRow> = sqlx::query_as(
            "SELECT device_sn, string_no, modules, module_wp, azimuth_deg, tilt_deg FROM growatt_string_layouts \
             WHERE device_sn = ANY($1) ORDER BY device_sn, string_no",
        )
        .bind(&sns)
        .fetch_all(pool)
        .await?;
        for r in rows {
            layout.entry(r.0.clone()).or_default().push(r);
        }
        let marks: Vec<(String, i32)> = sqlx::query_as(
            "SELECT device_sn, string_no FROM growatt_string_removed WHERE device_sn = ANY($1) ORDER BY device_sn, string_no",
        )
        .bind(&sns)
        .fetch_all(pool)
        .await?;
        for (sn, no) in marks {
            removed.entry(sn).or_default().push(no);
        }
    }
    let mut docs = Vec::with_capacity(invs.len());
    for inv in &invs {
        let device_types: Vec<String> = match inv.device_types.as_deref() {
            Some(s) if !s.is_empty() => s.split(',').map(str::to_owned).collect(),
            _ => Vec::new(),
        };
        let mut doc = json!({
            "schema": SCHEMA_VERSION,
            "device_sn": inv.device_sn,
            "plant_id": inv.plant_id,
            "model": inv.model,
            "datalogger_sn": inv.datalogger_sn,
            "device_types": device_types,
        });
        let d = doc.as_object_mut().expect("object");
        let rows = layout.get(&inv.device_sn).map(Vec::as_slice).unwrap_or(&[]);
        let gone = removed.get(&inv.device_sn).map(Vec::as_slice).unwrap_or(&[]);
        if !rows.is_empty() || !gone.is_empty() {
            let spec = model_spec(inv.device_model.as_deref()).unwrap_or(Value::Null);
            // Python truthiness: a missing or 0 value counts as absent
            let truthy = |v: &Value| v.as_f64().filter(|x| *x != 0.0).map(|_| v.clone());
            let mppts = truthy(&spec["mppt_count"]);
            let per_mppt = truthy(&spec["strings_per_mppt"]);
            let mut strings = Vec::new();
            for (_, no, modules, wp, az, tilt) in rows {
                let mut s = json!({"string_no": no, "modules": modules, "module_wp": wp});
                let so = s.as_object_mut().expect("object");
                if let Some(p) = per_mppt.as_ref().and_then(Value::as_i64).filter(|p| *p != 0) {
                    // -(-n // p): ceiling division
                    so.insert("mppt".into(), json!(-((-i64::from(*no)).div_euclid(p))));
                }
                if let Some(a) = az {
                    so.insert("azimuth_deg".into(), json!(a));
                }
                if let Some(t) = tilt {
                    so.insert("tilt_deg".into(), json!(t));
                }
                strings.push(s);
            }
            if !strings.is_empty() {
                d.insert("strings".into(), Value::Array(strings));
            }
            if !gone.is_empty() {
                d.insert("removed_strings".into(), json!(gone));
            }
            if let Some(m) = inv.device_model.as_deref().filter(|m| !m.is_empty()) {
                d.insert("device_model".into(), json!(m));
            }
            if let (Some(m), Some(p)) = (mppts, per_mppt) {
                d.insert("inputs".into(), json!({"mppt_count": m, "strings_per_mppt": p}));
            }
        }
        if inv.not_installed_at.is_some() {
            d.insert("not_installed".into(), json!(true));
        }
        docs.push((format!("inverters/{}", inv.device_sn), doc));
    }
    Ok(docs)
}

// --------------------------------------------------------------------------- publisher

/// The `daily_summary.publish_*` calls the settings routes make right after a save.
pub trait Publisher {
    /// Python `daily_summary.publish_config`: only the `config/*` documents (1 write when changed)
    fn publish_config(&self, pool: &PgPool) -> impl std::future::Future<Output = Result<PublishReport, String>> + Send;
    /// Python `daily_summary.publish_plant_inverters`: one plant's `inverters/{sn}` docs
    fn publish_plant_inverters(
        &self,
        pool: &PgPool,
        plant_id: i64,
    ) -> impl std::future::Future<Output = Result<PublishReport, String>> + Send;
}

/// Publishes to the sink `PUBLISH_SINK` names, within `PUBLISH_DAILY_WRITE_BUDGET`, as Python's
/// `make_sink(settings.publish_sink)` + `publish(...)` do.
#[derive(Debug, Clone)]
pub struct SinkPublisher {
    pub sink_kind: String,
    pub credentials_file: String,
    pub budget: i64,
    pub data_dir: PathBuf,
}

impl SinkPublisher {
    async fn run(&self, pool: &PgPool, docs: Vec<Doc>) -> Result<PublishReport, String> {
        let sink = make_sink(&self.sink_kind, &self.credentials_file, &self.data_dir)?;
        publish(pool, sink.as_ref(), &docs, self.budget, false, None).await
    }
}

impl Publisher for SinkPublisher {
    async fn publish_config(&self, pool: &PgPool) -> Result<PublishReport, String> {
        let docs = crate::fleet_settings::config_docs(pool).await.map_err(|e| e.to_string())?;
        let docs = docs
            .into_iter()
            .map(|(path, doc)| {
                let mut m = Map::new();
                m.insert("schema".into(), json!(SCHEMA_VERSION));
                if let Value::Object(o) = doc {
                    m.extend(o);
                }
                (path, Value::Object(m))
            })
            .collect();
        self.run(pool, docs).await
    }

    async fn publish_plant_inverters(&self, pool: &PgPool, plant_id: i64) -> Result<PublishReport, String> {
        let docs = build_inverter_docs(pool, Some(plant_id)).await.map_err(|e| e.to_string())?;
        self.run(pool, docs).await
    }
}

/// Python `routes/growatt/fleet_config._publish_safely`: the route's `published` value. A
/// failure does not undo the save (the next publish job retries); it is reported instead.
pub fn published_json(res: Result<PublishReport, String>) -> Value {
    match res {
        Ok(rep) => json!({"sink": rep.sink, "written": rep.written, "deferred": !rep.over_budget.is_empty()}),
        Err(e) => json!({"sink": null, "written": 0, "error": e}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_repr_matches_python() {
        // checked against CPython repr()
        for (x, s) in [
            (570.0, "570.0"),
            (0.0012, "0.0012"),
            (1e-5, "1e-05"),
            (0.0001, "0.0001"),
            (1e16, "1e+16"),
            (1.5e16, "1.5e+16"),
            (123456789012345.6, "123456789012345.6"),
            (-0.3, "-0.3"),
            (2.7647, "2.7647"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e22, "1e+22"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(py_float_repr(x), s, "{x}");
        }
    }

    #[test]
    fn canonical_sorts_and_escapes() {
        let v = json!({"b": [1, 2.0, null], "a": "ไทย\"\n\u{1}", "c": {"z": true, "y": 0.5}});
        assert_eq!(
            String::from_utf8(canonical(&v)).unwrap(),
            "{\"a\":\"ไทย\\\"\\n\\u0001\",\"b\":[1,2.0,null],\"c\":{\"y\":0.5,\"z\":true}}"
        );
    }

    #[test]
    fn pretty_like_indent_1() {
        let v = json!({"a": [1, {}], "b": []});
        assert_eq!(pretty(&v), "{\n \"a\": [\n  1,\n  {}\n ],\n \"b\": []\n}");
    }

    #[test]
    fn pacific_quota_day() {
        let t = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        assert_eq!(quota_day(t("2026-11-27T07:59:00Z")), "2026-11-26"); // PST: 23:59
        assert_eq!(quota_day(t("2026-11-27T08:00:00Z")), "2026-11-27");
        assert_eq!(quota_day(t("2026-07-01T06:59:00Z")), "2026-06-30"); // PDT: 23:59
        assert_eq!(quota_day(t("2026-07-01T07:00:00Z")), "2026-07-01");
        assert_eq!(nth_sunday(2026, 3, 2), NaiveDate::from_ymd_opt(2026, 3, 8).unwrap());
        assert_eq!(nth_sunday(2026, 11, 1), NaiveDate::from_ymd_opt(2026, 11, 1).unwrap());
    }
}
