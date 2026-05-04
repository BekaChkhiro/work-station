//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod manager;
mod reader;
mod session;

pub(crate) use manager::{PtyError, PtyManager, SpawnConfig};
pub(crate) use reader::spawn_reader;
#[allow(unused_imports)] // wider consumers land in T2.6+ (write, resize).
pub(crate) use session::PtySession;
