//! Clients for the external HTTP APIs the backend reads, ported from `backend/solar_core`.
//! Keys and tokens stay on the backend (root CLAUDE.md rule 4); nothing here stores a value.
//!
//! - [`growatt`]: Growatt OpenAPI client and response parsers (`solar_core/growatt/`).
//! - [`google_weather`]: Google Maps Weather (`solar_core/google_weather.py`).
//! - [`longdo_weather`]: Longdo weather radar (`solar_core/longdo_weather.py`).
//! - [`rainviewer`]: RainViewer radar snapshot list (`solar_core/rainviewer.py`).
//! - [`google_auth`]: service-account OAuth tokens (google-auth, for firebase_admin / Firestore).
//! - [`fcm`]: Firebase Cloud Messaging HTTP v1 (firebase_admin `messaging.send_each`).

#![forbid(unsafe_code)]

pub mod fcm;
pub mod google_auth;
pub mod google_weather;
pub mod growatt;
pub mod longdo_weather;
pub mod rainviewer;
