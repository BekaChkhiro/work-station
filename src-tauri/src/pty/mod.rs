//! PTY (Pseudo-Terminal) session management.
//!
//! Handles spawning shells, reading output, and writing input.

pub mod manager;
pub mod scrollback;
pub mod session;

pub use manager::PtyManager;
pub use scrollback::ScrollbackBuffer;
pub use session::{PtySession, SessionInfo};
