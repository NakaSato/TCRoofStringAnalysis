//! Python `jobs._per_phase` / `_clients` / `NoGrowattAccount`: run a job's per-account body once
//! per Growatt account (one account per project phase); one failing account does not stop the
//! others, plants without a phase go with the first account.
//!
//! Detail: totals summed over phases (numbers added, lists concatenated) plus
//! `phases: {phase: detail | {"error": "..."}}`. Status `partial` when an account failed or the
//! totals report `failed` / `env_failed`; the run fails only when every account failed.

use std::collections::BTreeMap;
use std::future::Future;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Number, Value};
use tcroof_clients::growatt::{GrowattClient, GrowattClientOptions};
use tcroof_db::PgPool;

use crate::{Ctx, JobError};

/// Python `GrowattClient(timeout=60)` in `_clients`
pub const CLIENT_TIMEOUT_S: u64 = 60;

/// Python `_clients`: one client per configured account, ascending by phase.
pub fn clients(ctx: &Ctx) -> Result<BTreeMap<i32, GrowattClient>, JobError> {
    let accounts = ctx.settings.growatt_accounts();
    if accounts.is_empty() {
        return Err(JobError::new(
            "NoGrowattAccount",
            "No Growatt token configured (GROWATT_TOKEN_PHASE1..4 or GROWATT_API_TOKEN)",
        ));
    }
    accounts
        .into_iter()
        .map(|(phase, token)| {
            let c = GrowattClient::new(
                &token,
                GrowattClientOptions {
                    base_url: ctx.settings.growatt_base_url.clone(),
                    timeout: Duration::from_secs(CLIENT_TIMEOUT_S),
                    blocked_plant_ids: ctx.settings.blocked_plant_ids(),
                    ..GrowattClientOptions::default()
                },
            )
            .map_err(|e| JobError::new("GrowattAPIError", e.to_string()))?;
            Ok((phase, c))
        })
        .collect()
}

/// What one account's body gets: its own pool handle (Python: its own session), its client, its
/// phase, and whether it also takes the plants with no phase yet (`include_untagged`).
#[derive(Clone)]
pub struct PhaseCtx {
    pub ctx: Ctx,
    pub pool: PgPool,
    pub client: GrowattClient,
    pub phase: i32,
    pub include_untagged: bool,
}

/// Python `totals[k] = totals.get(k, 0) + v` for JSON numbers (int + int stays int).
fn add(a: &Value, b: &Number) -> Value {
    match (a.as_i64(), b.as_i64()) {
        (Some(x), Some(y)) => json!(x + y),
        _ => json!(a.as_f64().unwrap_or(0.0) + b.as_f64().unwrap_or(0.0)),
    }
}

/// Python `_per_phase(db, fn)`. `body` runs once per account (in parallel with
/// `WORKER_PARALLEL_ACCOUNTS` and more than one account, each in its own task carrying the run's
/// log context).
pub async fn per_phase<F, Fut>(ctx: &Ctx, body: F) -> Result<(String, Value), JobError>
where
    F: Fn(PhaseCtx) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<Map<String, Value>, JobError>> + Send + 'static,
{
    let clients = clients(ctx)?;
    let first = *clients.keys().next().expect("at least one account");
    let run_ctx = tcroof_api::logging::RUN.try_with(Clone::clone).ok();
    let one = move |pc: PhaseCtx, body: F| async move {
        let phase = pc.phase;
        let t0 = Instant::now();
        match body(pc).await {
            Ok(d) => {
                tracing::info!(target: "jobs", "phase {} done in {:.0} s", phase, t0.elapsed().as_secs_f64());
                d
            }
            Err(e) => {
                // keep going with the other accounts
                tracing::error!(target: "jobs", exc_text = %e, "phase {} failed", phase);
                let mut m = Map::new();
                m.insert("error".into(), json!(e.to_string()));
                m
            }
        }
    };
    let phase_ctx = |phase: i32, client: GrowattClient| PhaseCtx {
        ctx: ctx.clone(),
        pool: ctx.pool.clone(),
        client,
        phase,
        include_untagged: phase == first,
    };
    let mut results: Vec<(i32, Map<String, Value>)> = Vec::new();
    if ctx.worker.worker_parallel_accounts && clients.len() > 1 {
        let mut handles = Vec::new();
        for (phase, client) in clients {
            let fut = one(phase_ctx(phase, client), body.clone());
            // each task gets the run's context, so phase logs keep the job's run id
            let fut: std::pin::Pin<Box<dyn Future<Output = Map<String, Value>> + Send>> = match run_ctx.clone() {
                Some(rc) => Box::pin(tcroof_api::logging::RUN.scope(rc, fut)),
                None => Box::pin(fut),
            };
            handles.push((phase, tokio::spawn(fut)));
        }
        for (phase, h) in handles {
            let d = h.await.unwrap_or_else(|e| {
                let mut m = Map::new();
                m.insert("error".into(), json!(format!("RuntimeError: {e}")));
                m
            });
            results.push((phase, d));
        }
    } else {
        for (phase, client) in clients {
            results.push((phase, one(phase_ctx(phase, client), body.clone()).await));
        }
    }

    let mut per = Map::new();
    let mut totals = Map::new();
    let mut errors = 0;
    let n = results.len();
    for (phase, d) in &results {
        per.insert(phase.to_string(), Value::Object(d.clone()));
        if d.contains_key("error") {
            errors += 1;
            continue;
        }
        for (k, v) in d {
            match v {
                Value::Number(num) => {
                    let cur = totals.get(k).cloned().unwrap_or(json!(0));
                    totals.insert(k.clone(), add(&cur, num));
                }
                Value::Array(a) => {
                    let mut cur = totals.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
                    cur.extend(a.iter().cloned());
                    totals.insert(k.clone(), Value::Array(cur));
                }
                _ => {}
            }
        }
    }
    if errors == n {
        let msg = results
            .iter()
            .map(|(p, d)| format!("phase {p}: {}", d.get("error").and_then(Value::as_str).unwrap_or("")))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(JobError::new("RuntimeError", msg));
    }
    let truthy = |k: &str| match totals.get(k) {
        Some(Value::Number(x)) => x.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::Array(a)) => !a.is_empty(),
        _ => false,
    };
    let partial = errors > 0 || truthy("failed") || truthy("env_failed");
    totals.insert("phases".into(), Value::Object(per));
    Ok(((if partial { "partial" } else { "ok" }).into(), Value::Object(totals)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_add_like_python() {
        assert_eq!(add(&json!(2), &Number::from(3)), json!(5));
        assert_eq!(add(&json!(2), Number::from_f64(0.5).as_ref().unwrap()), json!(2.5));
    }
}
