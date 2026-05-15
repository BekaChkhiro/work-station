//! Thin re-export of [`workstation_core::ws::system_monitor`].
//!
//! T19.28 moved the publisher into `workstation-core` so the headless
//! `cloud-agent` can broadcast the same `system_stats` frames the
//! desktop bridge already emits. This stub keeps the existing
//! `super::system_monitor::*` import paths from `pty_bridge` /
//! `server` resolving without churn.

pub use workstation_core::ws::system_monitor::*;
