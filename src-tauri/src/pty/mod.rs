//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod manager;
mod session;

pub(crate) use manager::PtyManager;
#[allow(unused_imports)] // wider consumers land in T2.4+ (reader, write, resize).
pub(crate) use session::PtySession;
