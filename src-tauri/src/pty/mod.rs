//! PTY (Pseudo-Terminal) session management.
//!
//! Handles spawning shells, reading output, and writing input.

pub mod manager;
pub mod session;

pub use manager::PtyManager;
pub use session::PtySession;
