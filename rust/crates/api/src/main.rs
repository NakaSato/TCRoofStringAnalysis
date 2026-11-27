use std::sync::Arc;

use tcroof_api::{app, AppState, Settings};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // the repo's .env (run from the repo root or from rust/)
    for p in [".env", "../.env"] {
        if dotenvy::from_filename(p).is_ok() {
            break;
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let settings = Settings::from_env()?;
    let pool = tcroof_db::connect(&settings.database_url, 10).await.map_err(anyhow::Error::msg)?;
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], settings.port));
    let state = AppState { pool, settings: Arc::new(settings) };

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("tcroof-api (Rust) listening on http://{addr}");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
