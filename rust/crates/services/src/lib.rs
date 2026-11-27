//! Domain services ported from `backend/app/services` (Phase 3 onwards). Each module names the
//! Python service it ports. DB-only services never call Growatt; live services never write SQL
//! (root CLAUDE.md rule 1: realtime values stay in memory and the Redis mirror).

#![forbid(unsafe_code)]

pub mod common;
pub mod overview;
pub mod daily_checks;
pub mod sync_status;
pub mod inverter_history;
pub mod strings;
pub mod weather;
pub mod google_weather_stored;
pub mod meter;
pub mod curtailment;
pub mod sensors;
pub mod alarms;
pub mod devices;
pub mod device_checks;
pub mod fleet_settings;
pub mod layout;
pub mod inverter_install;
pub mod tariff;
pub mod inverter_models;
pub mod plant_documents;
pub mod publish;
pub mod live_store;
pub mod live;
pub mod google_weather_live;
pub mod longdo;
pub mod rainviewer;
