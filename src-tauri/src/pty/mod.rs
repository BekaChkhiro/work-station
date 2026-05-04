//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod errors;
mod manager;
mod reader;
mod scrollback;
mod session;

pub(crate) use errors::{Recovery, UserShape};
pub(crate) use manager::{
    BackpressureSnapshot, PtyError, PtyManager, ScrollbackChunk, SpawnConfig,
};
pub(crate) use reader::spawn_reader;
#[allow(unused_imports)] // direct consumers grow as later phases land.
pub(crate) use session::PtySession;

#[cfg(test)]
pub(crate) use scrollback::Scrollback;
