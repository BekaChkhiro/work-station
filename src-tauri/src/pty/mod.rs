//! PTY (Pseudo-Terminal) session management.
//!
//! Handles spawning shells, reading output, and writing input.

pub mod session;

pub use session::PtySession;
