//! Fleet-wide settings (global data), stored in SQL `app_settings` and mirrored to Firestore.
//! Port of backend/app/services/fleet_settings.py. `fleet_module` is the PV module used across
//! all plants; until someone saves it the operator's stated module is returned with
//! `source = "default"` (ZNShine ZXM7-UHLDD144 570 W, STC datasheet values).

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::isoformat_utc;
use crate::publish::Doc;

/// Python `FLEET_MODULE_KEY`
pub const FLEET_MODULE_KEY: &str = "fleet_module";

/// Python `DEFAULT_FLEET_MODULE`
pub fn default_fleet_module() -> Map<String, Value> {
    let v = json!({
        "manufacturer": "ZNShine",
        "model": "ZXM7-UHLDD144-570",
        "wp": 570.0,
        "vmp_stc": 42.40,
        "imp_stc": 13.45,
        "voc_stc": 51.10,
        "isc_stc": 14.23,
        "efficiency_pct": 22.07,
        "temp_coeff_pmax_pct": -0.30,
        "temp_coeff_voc_pct": -0.25,
        "temp_coeff_isc_pct": 0.046,
        "bifacial_factor_pct": 80.0,
        "rs_ohm": 0.22,
        "kappa_ohm_per_k": 0.0012,
        "first_year_lid_pct": 1.0,
        "annual_degradation_pct": 0.45,
        "datasheet_url": "https://solarpvpros.com/content/Products/ZNShine/ZXM7-UHLDD144-580W.pdf",
    });
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

/// A row of `app_settings` (Python `AppSetting`)
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AppSetting {
    pub value: Value,
    pub updated_by: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
}

/// Python `db.get(AppSetting, key)`
pub async fn get_setting(pool: &PgPool, key: &str) -> Result<Option<AppSetting>, sqlx::Error> {
    sqlx::query_as::<_, AppSetting>("SELECT value, updated_by, updated_at FROM app_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
}

/// Python's `row is None → add, else row.value = value; row.updated_by = username` + commit.
/// SQLAlchemy issues no UPDATE (and `updated_at` keeps its value) when both are unchanged.
pub async fn put_setting(pool: &PgPool, key: &str, value: &Value, username: Option<&str>) -> Result<(), sqlx::Error> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM app_settings WHERE key = $1").bind(key).fetch_optional(pool).await?;
    if exists.is_none() {
        sqlx::query("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::text::json, $3, now())")
            .bind(key)
            .bind(value.to_string())
            .bind(username)
            .execute(pool)
            .await?;
    } else {
        sqlx::query(
            "UPDATE app_settings SET value = $2::text::json, updated_by = $3, updated_at = now() WHERE key = $1 \
             AND (value::jsonb IS DISTINCT FROM $2::text::jsonb OR updated_by IS DISTINCT FROM $3)",
        )
        .bind(key)
        .bind(value.to_string())
        .bind(username)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// `{**defaults, **row.value, "source": "saved", "updated_by", "updated_at"}` or the defaults
/// with `source = "default"`.
pub fn with_defaults(defaults: Map<String, Value>, row: Option<AppSetting>) -> Value {
    let mut m = defaults;
    match row {
        Some(r) if r.value.is_object() => {
            if let Value::Object(v) = r.value {
                m.extend(v);
            }
            m.insert("source".into(), json!("saved"));
            m.insert("updated_by".into(), json!(r.updated_by));
            m.insert("updated_at".into(), json!(r.updated_at.map(isoformat_utc)));
        }
        _ => {
            m.insert("source".into(), json!("default"));
            m.insert("updated_by".into(), Value::Null);
            m.insert("updated_at".into(), Value::Null);
        }
    }
    Value::Object(m)
}

/// Python `fleet_settings.get_fleet_module`
pub async fn get_fleet_module(pool: &PgPool) -> Result<Value, sqlx::Error> {
    Ok(with_defaults(default_fleet_module(), get_setting(pool, FLEET_MODULE_KEY).await?))
}

/// Python `fleet_settings.put_fleet_module`: save (the whole validated model) and read back.
pub async fn put_fleet_module(pool: &PgPool, value: &Value, username: Option<&str>) -> Result<Value, sqlx::Error> {
    put_setting(pool, FLEET_MODULE_KEY, value, username).await?;
    get_fleet_module(pool).await
}

/// The fleet module's Wp (`get_fleet_module(db).get("wp")`)
pub async fn fleet_module_wp(pool: &PgPool) -> Result<Option<f64>, sqlx::Error> {
    Ok(get_fleet_module(pool).await?.get("wp").and_then(Value::as_f64))
}

/// Python `fleet_settings.config_docs`: Firestore `config/*` documents (the timestamp left out so
/// unchanged content is skipped).
pub async fn config_docs(pool: &PgPool) -> Result<Vec<Doc>, sqlx::Error> {
    let mut m = get_fleet_module(pool).await?;
    if let Some(o) = m.as_object_mut() {
        o.remove("updated_at");
    }
    Ok(vec![(format!("config/{FLEET_MODULE_KEY}"), m), crate::tariff::config_doc(pool).await?])
}
