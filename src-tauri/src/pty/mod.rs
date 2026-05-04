//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod manager;
mod reader;
mod scrollback;
mod session;

pub(crate) use manager::{PtyError, PtyManager, ScrollbackChunk, SpawnConfig};
pub(crate) use reader::spawn_reader;
#[allow(unused_imports)] // direct consumers grow as later phases land.
pub(crate) use session::PtySession;
