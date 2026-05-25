// T19.35 Phase A prose references `PlanFlow`, `PTY`, `WebSocket` and
// `SQLite` in passing. Backticking each occurrence hurts readability;
// allow the doc-markdown lint at the module level, matching sibling
// modules.
#![allow(clippy::doc_markdown)]

//! Server-side auto-run orchestration loop (Phase A of T19.35).
//!
//! ## What this module does
//!
//! Spawns a long-lived tokio background task that ticks every
//! `AUTO_RUN_POLL_INTERVAL_MS` (20 seconds). On each tick it:
//!
//!   1. Fetches all active queues from the DB via
//!      [`crate::db::auto_run::list_active`].
//!   2. For each queue, runs the state-machine [`orchestrator::advance`]
//!      function — a Rust port of `src/stores/autoRunQueue.ts::advance`.
//!   3. Persists any state transitions back to SQLite.
//!
//! The orchestrator calls `PtyManager` and the PlanFlow internal client
//! directly — no WebSocket round-trip — so it keeps running even when
//! the desktop app is offline.
//!
//! ## What is NOT in this module (Phase A limits)
//!
//! * No WS frames: a queue can only be seeded by inserting a row
//!   directly into `auto_run_queues` (e.g. in tests). Phase B adds
//!   `auto_run_start` / `_pause` / `_resume` / `_stop` frames.
//!
//! * No merge verification: the `verifying_merge` state is treated as
//!   an immediate advance in Phase A (PR merge check is Phase D).
//!
//! * No GitHub token store or CLI detection frame (Phase D / Phase F).

pub mod orchestrator;

pub use orchestrator::spawn_orchestrator;
