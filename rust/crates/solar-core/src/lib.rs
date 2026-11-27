//! Pure engine of TC Roof Solar, ported from `backend/solar_core` (no DB, no HTTP, no async).
//!
//! Python stays the behavioural oracle: the parity tests in `tests/` compare every function
//! with fixtures written by `tests/fixtures/gen.py` from the Python code.
//!
//! - [`sun`]: NOAA sunrise / sunset and Haurwitz clear-sky GHI (`solar_core/sun.py`).
//! - [`visit_route`]: the Visit Route order solver (`solar_core/visit_route.py`).
//! - [`om_planning`]: Calendar Team recurrence and round scheduling (`solar_core/om_planning.py`).
//! - [`iv_analysis`], [`iv_site_fit`], [`iv_operating`]: I-V analysis (`solar_core/iv_*.py`).

#![forbid(unsafe_code)]

pub mod iv_analysis;
pub mod iv_operating;
pub mod iv_site_fit;
pub mod om_planning;
mod py_random;
pub mod sun;
pub mod visit_route;
