//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod session;

#[allow(unused_imports)] // first consumer lands in T2.3 (PtyManager).
pub(crate) use session::PtySession;
