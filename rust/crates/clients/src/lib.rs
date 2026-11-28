//! Clients for the external HTTP APIs the backend reads, ported from `backend/solar_core`.
//! Keys and tokens stay on the backend (root CLAUDE.md rule 4); nothing here stores a value.
//!
//! - [`growatt`]: Growatt OpenAPI client and response parsers (`solar_core/growatt/`).
//! - [`google_weather`]: Google Maps Weather (`solar_core/google_weather.py`).
//! - [`longdo_weather`]: Longdo weather radar (`solar_core/longdo_weather.py`).
//! - [`rainviewer`]: RainViewer radar snapshot list (`solar_core/rainviewer.py`).
//! - [`google_auth`]: service-account OAuth tokens (google-auth `service_account.Credentials`).
//! - [`google_sheets`]: Sheets API v4 (`services/pwa_sheet.py` `SheetsClient`).
//! - [`firestore_read`]: Firestore REST reads (`services/pwa_report.py` `firestore_day_docs`).

#![forbid(unsafe_code)]

pub mod firestore_read;
pub mod google_auth;
pub mod google_sheets;
pub mod google_weather;
pub mod growatt;
pub mod longdo_weather;
pub mod rainviewer;
