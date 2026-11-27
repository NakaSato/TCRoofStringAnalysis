use std::time::Duration;

use tcroof_api::logging::{init_tracing, DbLog};
use tcroof_api::{app, AppState, Settings};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // the repo's .env (run from the repo root or from rust/); real environment variables win
    for p in [".env", "../.env"] {
        if dotenvy::from_filename(p).is_ok() {
            break;
        }
    }
    let settings = Settings::from_env()?;
    let pool = tcroof_db::connect(&settings.database_url, 10).await.map_err(anyhow::Error::msg)?;
    // Python `setup_logging("api")`: console + app_logs (backend/app/logging_db.py)
    let logs = DbLog::from_settings("api", &settings, pool.clone());
    init_tracing(logs.clone());

    let flusher = logs.as_ref().map(|l| l.spawn_flusher(Duration::from_secs_f64(settings.log_flush_interval_s.max(0.1))));
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], settings.port));
    let state = AppState { logs: logs.clone(), ..AppState::new(pool, settings) };

    let listener = tokio::net::TcpListener::bind(addr).await?;
    // console only (Python's start-up lines are uvicorn's, which don't reach app_logs)
    println!("tcroof-api (Rust) listening on http://{addr}");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    // Python `teardown_logging`: one last flush, even inside the pause after a failure
    if let Some(f) = flusher {
        f.abort();
    }
    if let Some(l) = logs {
        l.flush(true).await;
    }
    Ok(())
}
