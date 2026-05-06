//! CLI agent registry: detection, version probing, launch profiles.
//!
//! Phase 7 fills this module out. T7.1 lands the boot-time PATH scan
//! (see [`registry`]); T7.2 adds the `cli_list_available` IPC command
//! that exposes the cached list to the frontend.

pub mod registry;

pub use registry::CliRegistry;
