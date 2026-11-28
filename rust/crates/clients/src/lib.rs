//! Clients for the external HTTP APIs the backend reads, ported from `backend/solar_core`.
//! Keys and tokens stay on the backend (root CLAUDE.md rule 4); nothing here stores a value.
//!
//! - [`growatt`]: Growatt OpenAPI client and response parsers (`solar_core/growatt/`).
//! - [`google_weather`]: Google Maps Weather (`solar_core/google_weather.py`).
//! - [`longdo_weather`]: Longdo weather radar (`solar_core/longdo_weather.py`).
//! - [`rainviewer`]: RainViewer radar snapshot list (`solar_core/rainviewer.py`).
//! - [`google_auth`]: service-account OAuth access tokens (key file → JWT → bearer token).
//! - [`firestore`]: Firestore REST commit (the summary sink, `daily_summary.FirestoreSink`).

#![forbid(unsafe_code)]

pub mod firestore;
pub mod google_auth;
pub mod google_weather;
pub mod growatt;
pub mod longdo_weather;
pub mod rainviewer;
