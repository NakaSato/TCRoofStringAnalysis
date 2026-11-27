//! `/growatt/*` (backend/app/api/routes/growatt/). One Rust module per area of the port; the
//! Python module each handler mirrors is named on the handler.
//!
//! Live and persisted data never mix: a live route never writes to the database, and a DB route
//! never calls Growatt.

use axum::Router;

use crate::AppState;

pub mod devices;
pub mod fleet_config;
pub mod history;
pub mod live;
pub mod plants;
pub mod stored_weather;

/// Python `routes/growatt/__init__.py` `router` (prefix `/growatt`).
pub fn router() -> Router<AppState> {
    Router::new()
        .merge(live::router())
        .merge(plants::router())
        .merge(history::router())
        .merge(stored_weather::router())
        .merge(fleet_config::router())
        .merge(devices::router())
}
