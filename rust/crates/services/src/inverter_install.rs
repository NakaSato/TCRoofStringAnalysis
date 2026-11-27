//! Inverters listed in Growatt but not installed on site. Port of
//! backend/app/services/inverter_install.py: an admin marks one (`growatt_inverters.
//! not_installed_at`); it is then left out of every job, live call, count and analysis. Its
//! stored rows are kept, and clearing the mark brings it back on the next runs.

use std::collections::HashSet;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::common::{inverter_out, Inverter, Result, ServiceError, INVERTER_COLS};

/// Python `ACTIVE_ISSUES`
pub const ACTIVE_ISSUES: [&str; 2] = ["open", "acknowledged"];
/// Python `CLOSE_REASON`
pub const CLOSE_REASON: &str = "not_installed";
/// Python `NOTE_MAX`
pub const NOTE_MAX: usize = 255;

/// Python `inverter_install.set_installed`: mark (installed false) or clear (installed true) the
/// plant's inverter. Marking dismisses the inverter's and its strings' active issues; clearing
/// reopens nothing. Returns `{inverter, issues_closed}`. One transaction.
pub async fn set_installed(
    pool: &PgPool,
    plant_id: i64,
    device_sn: &str,
    installed: bool,
    username: &str,
    note: Option<&str>,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let inv: Option<Inverter> = sqlx::query_as(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND device_sn = $2 FOR UPDATE"
    ))
    .bind(crate::plant_documents::id32(plant_id))
    .bind(device_sn)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(inv) = inv else {
        return Err(ServiceError::NotFound(format!("Inverter {device_sn} not found on plant {plant_id}")));
    };
    let text = Some(crate::plant_documents::py_strip(note.unwrap_or(""))).filter(|t| !t.is_empty()).map(str::to_owned);
    if text.as_ref().is_some_and(|t| t.chars().count() > NOTE_MAX) {
        return Err(ServiceError::Invalid(format!("The note is longer than {NOTE_MAX} characters")));
    }
    let mut closed: i64 = 0;
    if installed {
        // SQLAlchemy issues no UPDATE (synced_at kept) when the mark is already clear
        if inv.not_installed_at.is_some() || inv.not_installed_by.is_some() || inv.not_installed_note.is_some() {
            sqlx::query(
                "UPDATE growatt_inverters SET not_installed_at = NULL, not_installed_by = NULL, not_installed_note = NULL, \
                 synced_at = now() WHERE device_sn = $1",
            )
            .bind(device_sn)
            .execute(&mut *tx)
            .await?;
        }
    } else {
        let first = inv.not_installed_at.is_none();
        if first || inv.not_installed_note != text {
            sqlx::query(
                "UPDATE growatt_inverters SET not_installed_at = COALESCE(not_installed_at, now()), \
                 not_installed_by = CASE WHEN not_installed_at IS NULL THEN $2 ELSE not_installed_by END, \
                 not_installed_note = $3, synced_at = now() WHERE device_sn = $1",
            )
            .bind(device_sn)
            .bind(username)
            .bind(&text)
            .execute(&mut *tx)
            .await?;
        }
        closed = sqlx::query(
            "UPDATE growatt_issues SET status = 'dismissed', close_reason = $3, closed_at = now(), closed_by = $4, \
             updated_at = now() WHERE plant_id = $1 AND device_sn = $2 AND status = ANY($5)",
        )
        .bind(crate::plant_documents::id32(plant_id))
        .bind(device_sn)
        .bind(CLOSE_REASON)
        .bind(username)
        .bind(ACTIVE_ISSUES.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .execute(&mut *tx)
        .await?
        .rows_affected() as i64;
    }
    let inv: Inverter = sqlx::query_as(&format!("SELECT {INVERTER_COLS} FROM growatt_inverters WHERE device_sn = $1"))
        .bind(device_sn)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"inverter": inverter_out(&inv), "issues_closed": closed}))
}

/// Python `inverter_install.not_installed_sns`: serials of the inverters marked not installed
/// (of `plant_ids`, or the whole fleet).
pub async fn not_installed_sns(pool: &PgPool, plant_ids: Option<&[i64]>) -> Result<HashSet<String>> {
    let rows: Vec<String> = match plant_ids {
        Some(ids) => sqlx::query_scalar(
            "SELECT device_sn FROM growatt_inverters WHERE not_installed_at IS NOT NULL AND plant_id = ANY($1)",
        )
        .bind(ids.iter().map(|&i| crate::plant_documents::id32(i)).collect::<Vec<i32>>())
        .fetch_all(pool)
        .await?,
        None => sqlx::query_scalar("SELECT device_sn FROM growatt_inverters WHERE not_installed_at IS NOT NULL")
            .fetch_all(pool)
            .await?,
    };
    Ok(rows.into_iter().collect())
}
