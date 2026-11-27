//! `app_logs` (backend/app/db/models/system.py `AppLog`): the insert of backend/app/logging_db.py
//! `DbLogHandler.flush` and the reads of backend/app/services/system_logs.py. Pruning is the
//! worker's `retention` job and is not here.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, QueryBuilder};

use crate::Error;

/// One record, already redacted and truncated by the API's log handler.
#[derive(Debug, Clone, PartialEq)]
pub struct NewLog {
    pub ts: DateTime<Utc>,
    pub level: String,
    pub level_no: i16,
    pub source: String,
    pub host: Option<String>,
    pub logger: String,
    pub message: String,
    pub exc_text: Option<String>,
    pub run_id: Option<i32>,
    pub job: Option<String>,
    pub request_id: Option<String>,
    pub extra_json: Option<Value>,
}

/// A stored record as read back (Python `row_out` turns it into JSON).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LogRow {
    pub id: i32,
    pub ts: DateTime<Utc>,
    pub level: String,
    pub level_no: i16,
    pub source: String,
    pub host: Option<String>,
    pub logger: String,
    pub message: String,
    pub exc_text: Option<String>,
    pub run_id: Option<i32>,
    pub job: Option<String>,
    pub request_id: Option<String>,
    pub extra_json: Option<Value>,
}

const COLS: &str = "id, ts, level, level_no, source, host, logger, message, exc_text, run_id, job, request_id, extra_json";
/// 12 binds a row; Postgres allows 65 535 per statement
const INSERT_CHUNK: usize = 5_000;

/// Python `DbLogHandler.flush`: every row in one transaction (`engine.begin()`).
pub async fn insert_logs(pool: &PgPool, rows: &[NewLog]) -> Result<(), Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for chunk in rows.chunks(INSERT_CHUNK) {
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            "INSERT INTO app_logs (ts, level, level_no, source, host, logger, message, exc_text, run_id, job, request_id, extra_json) ",
        );
        qb.push_values(chunk, |mut b, r| {
            b.push_bind(r.ts)
                .push_bind(&r.level)
                .push_bind(r.level_no)
                .push_bind(&r.source)
                .push_bind(&r.host)
                .push_bind(&r.logger)
                .push_bind(&r.message)
                .push_bind(&r.exc_text)
                .push_bind(r.run_id)
                .push_bind(&r.job)
                .push_bind(&r.request_id)
                // the column is `json` (SQLAlchemy JSON), not jsonb: bind text and cast
                .push_bind(r.extra_json.as_ref().map(Value::to_string))
                .push_unseparated("::json");
        });
        qb.build().execute(&mut *tx).await?;
    }
    tx.commit().await
}

/// The WHERE of Python `system_logs.list_logs`, values already checked and converted to UTC.
#[derive(Debug, Default, Clone)]
pub struct LogFilter {
    pub min_level_no: i16,
    pub sources: Option<Vec<String>>,
    /// prefix, matched literally (`startswith(..., autoescape=True)`)
    pub logger_prefix: Option<String>,
    pub job: Option<String>,
    pub run_id: Option<i64>,
    /// already lowercased; matched literally inside `lower(message)`
    pub text: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub before_id: Option<i64>,
    pub after_id: Option<i64>,
}

/// SQLAlchemy `autoescape=True`: `/` escapes `%`, `_` and itself (`ESCAPE '/'`).
pub fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '/' | '%' | '_') {
            out.push('/');
        }
        out.push(c);
    }
    out
}

/// Python `list_logs`: newest first (`ORDER BY id DESC`), at most `limit` rows.
pub async fn list_logs(pool: &PgPool, f: &LogFilter, limit: i64) -> Result<Vec<LogRow>, Error> {
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(format!("SELECT {COLS} FROM app_logs WHERE level_no >= "));
    qb.push_bind(f.min_level_no);
    if let Some(src) = &f.sources {
        qb.push(" AND source = ANY(").push_bind(src.clone()).push(")");
    }
    if let Some(p) = &f.logger_prefix {
        qb.push(" AND logger LIKE ").push_bind(format!("{}%", like_escape(p))).push(" ESCAPE '/'");
    }
    if let Some(j) = &f.job {
        qb.push(" AND job = ").push_bind(j.clone());
    }
    if let Some(r) = f.run_id {
        qb.push(" AND run_id = ").push_bind(r);
    }
    if let Some(t) = &f.text {
        qb.push(" AND lower(message) LIKE ").push_bind(format!("%{}%", like_escape(t))).push(" ESCAPE '/'");
    }
    if let Some(s) = f.since {
        qb.push(" AND ts >= ").push_bind(s);
    }
    if let Some(u) = f.until {
        qb.push(" AND ts < ").push_bind(u);
    }
    if let Some(b) = f.before_id {
        qb.push(" AND id < ").push_bind(b);
    }
    if let Some(a) = f.after_id {
        qb.push(" AND id > ").push_bind(a);
    }
    qb.push(" ORDER BY id DESC LIMIT ").push_bind(limit);
    qb.build_query_as::<LogRow>().fetch_all(pool).await
}

/// Python `summary`: (level, count) since `since`.
pub async fn count_by_level(pool: &PgPool, since: DateTime<Utc>) -> Result<Vec<(String, i64)>, Error> {
    sqlx::query_as("SELECT level, count(*) FROM app_logs WHERE ts >= $1 GROUP BY level ORDER BY level")
        .bind(since)
        .fetch_all(pool)
        .await
}

/// Python `summary`: (source, count) since `since`.
pub async fn count_by_source(pool: &PgPool, since: DateTime<Utc>) -> Result<Vec<(String, i64)>, Error> {
    sqlx::query_as("SELECT source, count(*) FROM app_logs WHERE ts >= $1 GROUP BY source ORDER BY source")
        .bind(since)
        .fetch_all(pool)
        .await
}

/// Python `summary`: the newest ERROR+ (level_no >= 40) record since `since`.
pub async fn last_error(pool: &PgPool, since: DateTime<Utc>) -> Result<Option<LogRow>, Error> {
    sqlx::query_as::<_, LogRow>(&format!(
        "SELECT {COLS} FROM app_logs WHERE ts >= $1 AND level_no >= 40 ORDER BY id DESC LIMIT 1"
    ))
    .bind(since)
    .fetch_optional(pool)
    .await
}

/// Python `summary`'s `newest_id`: over the whole table, not the window.
pub async fn newest_id(pool: &PgPool) -> Result<Option<i32>, Error> {
    sqlx::query_scalar("SELECT max(id) FROM app_logs").fetch_one(pool).await
}

#[cfg(test)]
mod tests {
    use super::like_escape;

    #[test]
    fn like_escape_matches_sqlalchemy_autoescape() {
        assert_eq!(like_escape("app.services"), "app.services");
        assert_eq!(like_escape("50%_a/b"), "50/%/_a//b");
    }
}
