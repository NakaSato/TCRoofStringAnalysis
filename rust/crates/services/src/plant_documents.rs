//! Per-plant document links (docs/plans/plant-asbuilt-links.md): the newest as-built drawing PDF
//! and the site photo folder on Google Drive. Port of backend/app/services/plant_documents.py.
//! Links only; SQL only (never Firestore). `matched` rows come from the Drive name matcher,
//! `manual` rows from an admin; an import never overwrites a `manual` row.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::{isoformat_utc, Result, ServiceError};

/// A plant id as the `integer` columns hold it. The same SQL text may be prepared by another
/// module with an `int4` parameter (sqlx caches statements per connection), so ids are always bound
/// as i32; one beyond int4 matches no row (as a lookup of it finds nothing in Python).
pub(crate) fn id32(v: i64) -> i32 {
    i32::try_from(v).unwrap_or(i32::MIN)
}

/// Python `plant_documents.KINDS`
pub const KINDS: [&str; 2] = ["asbuilt", "site_photos"];

/// A row of `plant_documents` (Python `PlantDocument`)
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PlantDocument {
    pub id: i32,
    pub plant_id: i32,
    pub kind: String,
    pub drive_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub revision: Option<String>,
    pub source: String,
    pub match_score: Option<f64>,
    pub updated_by: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
}

const COLS: &str = "id, plant_id, kind, drive_id, url, title, revision, source, match_score, updated_by, updated_at";

/// Python `plant_documents.out`
pub fn out(d: &PlantDocument) -> Value {
    json!({
        "kind": d.kind,
        "url": d.url,
        "title": d.title,
        "revision": d.revision,
        "source": d.source,
        "match_score": d.match_score,
        "updated_by": d.updated_by,
        "updated_at": d.updated_at.map(isoformat_utc),
    })
}

/// Python `str.strip()` (whitespace as `str.isspace` sees it, incl. the \x1c–\x1f separators)
pub fn py_strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// `s[:n]` in characters
fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Python `_DRIVE_ID.search(url)`: `/(?:file/d|drive/folders)/([A-Za-z0-9_-]{10,})`, leftmost match
fn drive_id(url: &str) -> Option<String> {
    let ok = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    for (i, _) in url.match_indices('/') {
        for prefix in ["/file/d/", "/drive/folders/"] {
            if let Some(rest) = url[i..].strip_prefix(prefix) {
                let id: String = rest.chars().take_while(|c| ok(*c)).collect();
                if id.len() >= 10 {
                    return Some(id);
                }
            }
        }
    }
    None
}

/// Python `plant_documents._check`: the kind, and the stripped https URL (≤ 1000 characters)
pub fn check(kind: &str, url: &str) -> Result<String> {
    if !KINDS.contains(&kind) {
        return Err(ServiceError::Invalid(format!("kind must be one of {}", KINDS.join(", "))));
    }
    let url = py_strip(url);
    let https = url.len() >= 8 && url.is_char_boundary(8) && url[..8].eq_ignore_ascii_case("https://");
    if !https || url.chars().count() > 1000 {
        return Err(ServiceError::Invalid("url must be an https link (at most 1000 characters)".into()));
    }
    Ok(url.to_owned())
}

/// Python `plant_documents.for_plant`: {kind: link} of one plant (kinds without a link left out)
pub async fn for_plant(pool: &PgPool, plant_id: i64) -> Result<Map<String, Value>> {
    let rows: Vec<PlantDocument> = sqlx::query_as(&format!("SELECT {COLS} FROM plant_documents WHERE plant_id = $1 ORDER BY id"))
        .bind(id32(plant_id))
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(|d| (d.kind.clone(), out(d))).collect())
}

/// Python `plant_documents.list_all`: one row per visible plant (`allowed` None = every plant)
/// with its links (null where none), ordered by phase, name.
pub async fn list_all(pool: &PgPool, allowed: Option<&[i64]>) -> Result<Vec<Value>> {
    let ids: Vec<i32> = match allowed {
        Some([]) => vec![-1],
        Some(a) => a.iter().map(|&i| id32(i)).collect(),
        None => Vec::new(),
    };
    let (pw, dw) = if allowed.is_some() { (" WHERE plant_id = ANY($1)", " WHERE plant_id = ANY($1)") } else { ("", "") };
    let psql = format!("SELECT plant_id, name, phase FROM growatt_plants{pw} ORDER BY phase, name");
    let dsql = format!("SELECT {COLS} FROM plant_documents{dw} ORDER BY id");
    let mut pq = sqlx::query_as::<_, (i32, String, Option<i32>)>(&psql);
    let mut dq = sqlx::query_as::<_, PlantDocument>(&dsql);
    if allowed.is_some() {
        pq = pq.bind(ids.clone());
        dq = dq.bind(ids);
    }
    let plants = pq.fetch_all(pool).await?;
    let rows = dq.fetch_all(pool).await?;
    let mut docs: HashMap<i32, Map<String, Value>> = HashMap::new();
    for d in &rows {
        docs.entry(d.plant_id).or_default().insert(d.kind.clone(), out(d));
    }
    Ok(plants
        .into_iter()
        .map(|(pid, name, phase)| {
            let mut m = Map::new();
            m.insert("plant_id".into(), json!(pid));
            m.insert("name".into(), json!(name));
            m.insert("phase".into(), json!(phase));
            for k in KINDS {
                m.insert(k.into(), docs.get(&pid).and_then(|d| d.get(k)).cloned().unwrap_or(Value::Null));
            }
            Value::Object(m)
        })
        .collect())
}

/// Python `plant_documents.put`: an admin's link (source `manual`), replacing whatever the plant
/// had for that kind. 422 on a bad kind / URL, 404 for an unknown plant.
pub async fn put(pool: &PgPool, who: Option<&str>, plant_id: i64, kind: &str, url: &str, title: Option<&str>) -> Result<Value> {
    let url = check(kind, url)?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT plant_id FROM growatt_plants WHERE plant_id = $1")
        .bind(id32(plant_id))
        .fetch_optional(pool)
        .await?;
    let Some(pid) = exists else {
        return Err(ServiceError::NotFound(format!("Plant {plant_id} not found")));
    };
    let title = Some(take_chars(py_strip(title.unwrap_or("")), 300)).filter(|t| !t.is_empty());
    let did = drive_id(&url);
    let row: PlantDocument = sqlx::query_as(&format!(
        "INSERT INTO plant_documents (plant_id, kind, drive_id, url, title, revision, source, match_score, updated_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, NULL, 'manual', NULL, $6, now()) \
         ON CONFLICT (plant_id, kind) DO UPDATE SET drive_id = EXCLUDED.drive_id, url = EXCLUDED.url, \
         title = EXCLUDED.title, revision = NULL, source = 'manual', match_score = NULL, updated_by = EXCLUDED.updated_by, \
         updated_at = CASE WHEN (plant_documents.drive_id, plant_documents.url, plant_documents.title, plant_documents.revision, \
           plant_documents.source, plant_documents.match_score, plant_documents.updated_by) \
           IS NOT DISTINCT FROM (EXCLUDED.drive_id, EXCLUDED.url, EXCLUDED.title, NULL::varchar, 'manual'::varchar, \
           NULL::double precision, EXCLUDED.updated_by) THEN plant_documents.updated_at ELSE now() END \
         RETURNING {COLS}"
    ))
    .bind(pid)
    .bind(kind)
    .bind(did)
    .bind(&url)
    .bind(title)
    .bind(who)
    .fetch_one(pool)
    .await?;
    Ok(out(&row))
}

/// Python `plant_documents.remove`: true when a link was deleted
pub async fn remove(pool: &PgPool, plant_id: i64, kind: &str) -> Result<bool> {
    if !KINDS.contains(&kind) {
        return Err(ServiceError::Invalid(format!("kind must be one of {}", KINDS.join(", "))));
    }
    let n = sqlx::query("DELETE FROM plant_documents WHERE plant_id = $1 AND kind = $2")
        .bind(id32(plant_id))
        .bind(kind)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// One validated row of the import body (Python `PlantDocumentRow`)
#[derive(Debug, Clone)]
pub struct ImportRow {
    pub plant_id: i64,
    pub kind: String,
    pub url: String,
    pub drive_id: Option<String>,
    pub title: Option<String>,
    pub revision: Option<String>,
    pub match_score: Option<f64>,
}

/// Python `plant_documents.import_rows`: matched links from the Drive matcher, upserted as
/// `matched`, never over a `manual` row. Unknown plants and bad rows are reported, not written;
/// `apply = false` only counts (dry run).
pub async fn import_rows(pool: &PgPool, rows: &[ImportRow], apply: bool, who: Option<&str>) -> Result<Value> {
    let known: HashSet<i64> = sqlx::query_scalar::<_, i32>("SELECT plant_id FROM growatt_plants")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(i64::from)
        .collect();
    let existing: HashMap<(i64, String), PlantDocument> =
        sqlx::query_as::<_, PlantDocument>(&format!("SELECT {COLS} FROM plant_documents"))
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|d| ((i64::from(d.plant_id), d.kind.clone()), d))
            .collect();
    let (mut created, mut updated, mut unchanged, mut kept_manual) = (0, 0, 0, 0);
    let mut errors: Vec<String> = Vec::new();
    let mut seen: HashSet<(i64, String)> = HashSet::new();
    let mut tx = pool.begin().await?;
    for (i, r) in rows.iter().enumerate() {
        let i = i + 1;
        let url = match check(&r.kind, &r.url) {
            Ok(u) => u,
            Err(e) => {
                errors.push(format!("row {i}: {e}"));
                continue;
            }
        };
        let pid = r.plant_id;
        if !known.contains(&pid) {
            errors.push(format!("row {i}: plant {pid} not in the registry"));
            continue;
        }
        let key = (pid, r.kind.clone());
        if seen.contains(&key) {
            errors.push(format!("row {i}: plant {pid} {} given twice", r.kind));
            continue;
        }
        seen.insert(key.clone());
        let d = existing.get(&key);
        if d.is_some_and(|d| d.source == "manual") {
            kept_manual += 1;
            continue;
        }
        let drive_id = r.drive_id.clone().filter(|s| !s.is_empty());
        let title = Some(take_chars(r.title.as_deref().unwrap_or(""), 300)).filter(|s| !s.is_empty());
        let revision = Some(take_chars(r.revision.as_deref().unwrap_or(""), 16)).filter(|s| !s.is_empty());
        let score = r.match_score;
        if let Some(d) = d {
            if d.url == url && d.drive_id == drive_id && d.title == title && d.revision == revision && d.match_score == score {
                unchanged += 1;
                continue;
            }
            updated += 1;
        } else {
            created += 1;
        }
        if !apply {
            continue;
        }
        sqlx::query(
            "INSERT INTO plant_documents (plant_id, kind, drive_id, url, title, revision, source, match_score, updated_by, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, 'matched', $7, $8, now()) \
             ON CONFLICT (plant_id, kind) DO UPDATE SET drive_id = EXCLUDED.drive_id, url = EXCLUDED.url, \
             title = EXCLUDED.title, revision = EXCLUDED.revision, source = 'matched', match_score = EXCLUDED.match_score, \
             updated_by = EXCLUDED.updated_by, updated_at = now()",
        )
        .bind(pid as i32)
        .bind(&r.kind)
        .bind(drive_id)
        .bind(&url)
        .bind(title)
        .bind(revision)
        .bind(score)
        .bind(who)
        .execute(&mut *tx)
        .await?;
    }
    if apply {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(json!({
        "applied": apply,
        "created": created,
        "updated": updated,
        "unchanged": unchanged,
        "kept_manual": kept_manual,
        "errors": errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_ids_and_checks() {
        assert_eq!(drive_id("https://drive.google.com/file/d/1AbCdEfGhIjK/view").as_deref(), Some("1AbCdEfGhIjK"));
        assert_eq!(drive_id("https://drive.google.com/drive/folders/abc_DEF-123456?usp=x").as_deref(), Some("abc_DEF-123456"));
        assert_eq!(drive_id("https://drive.google.com/file/d/short/view"), None);
        assert_eq!(check("asbuilt", "  HTTPS://x.y/z ").unwrap(), "HTTPS://x.y/z");
        assert!(check("asbuilt", "http://x.y").is_err());
        assert!(check("other", "https://x.y").is_err());
        assert_eq!(py_strip("\u{1c} a \n"), "a");
    }
}
