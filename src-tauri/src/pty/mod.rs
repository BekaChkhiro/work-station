//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod manager;
mod reader;
mod session;

pub(crate) use manager::PtyManager;
#[allow(unused_imports)] // call site lands in T2.5 (pty_spawn).
pub(crate) use reader::spawn_reader;
#[allow(unused_imports)] // wider consumers land in T2.5+ (write, resize).
pub(crate) use session::PtySession;
