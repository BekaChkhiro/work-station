//! PTY orchestration: spawn shells, manage lifecycle, stream I/O.
//!
//! Implementations land in Phase 2 (T2.x).

mod errors;
mod manager;
mod reader;
mod scrollback;
mod session;

// T19.1 — `pub` (not `pub(crate)`) so the desktop binary can keep using
// these types via the re-export from `src-tauri/src/lib.rs`.
pub use errors::{Recovery, UserShape};
pub use manager::{BackpressureSnapshot, PtyError, PtyManager, ScrollbackChunk, SpawnConfig};
pub use reader::spawn_reader;
// `Scrollback` is exposed for src-tauri's integration tests that
// stub the ring buffer (e.g. `pty_get_scrollback` edge cases). It
// stays implementation-detail-ish so no production code paths
// depend on the exact buffer type.
pub use scrollback::Scrollback;
#[allow(unused_imports)] // direct consumers grow as later phases land.
pub use session::PtySession;
