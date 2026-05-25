// T19.35 / Phase A prose references `PlanFlow`, `SQLite`, `JSON`, `PTY`
// and `WebSocket` in passing. Backticking each occurrence hurts
// readability; allow the doc-markdown lint at the module level,
// matching the sibling modules.
#![allow(clippy::doc_markdown)]

//! Persistence layer for the server-side auto-run orchestration queues
//! (Phase A of T19.35).
//!
//! ## Row model
//!
//! One row per workspace project — `project_id` is the PRIMARY KEY so a
//! project can only host one queue at a time. Every field mirrors the
//! TypeScript `AutoRunQueue` / `AutoRunHistoryEntry` interfaces in
//! `src/types/autoRunQueue.ts` so the Rust serde structs and the TS Zod
//! schema stay in lockstep without a conversion layer.
//!
//! Time columns are epoch milliseconds throughout (`i64`), matching
//! `Date.now()` on the TS side. Nullable time fields (`start_at`,
//! `deadline_at`, etc.) are `Option<i64>`.
//!
//! The `history` field is serialised as a JSON array in `history_json` —
//! a single blob avoids a per-entry join on the hot orchestrator read
//! path. History entries are append-only; the column stays small.
//!
//! ## Active-queue filter
//!
//! [`list_active`] returns every queue whose `state` is one of:
//! `scheduled`, `running`, `verifying_merge`, `waiting`, `paused`.
//! `paused` is included because the orchestrator still needs to watch
//! it (the user may resume); `idle`, `stopped`, `done`, and `failed`
//! are excluded because they need no tick-loop attention.
//!
//! ## Upsert semantics
//!
//! [`upsert`] is an `INSERT OR REPLACE` so a Phase B `auto_run_start`
//! frame can seed a fresh row AND the tick loop can persist state
//! transitions with a single call — no separate insert / update needed.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row;

// ---------- Public types ----------

/// Mirror of the TypeScript `AutoRunState` union.
///
/// Serialises as lowercase-with-underscore strings so the wire shape
/// matches `src/types/autoRunQueue.ts` exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoRunState {
    /// Not active; queue exists only for historical display.
    Idle,
    /// `start_at` is in the future; tick loop waits before dispatching.
    Scheduled,
    /// Currently dispatching or polling a running task.
    Running,
    /// Auto-merge: task flipped DONE, waiting for PR merge before next.
    /// Phase D handles full verification; Phase A treats this as "advance
    /// immediately" (see orchestrator TODO comment).
    VerifyingMerge,
    /// Pacing: task finished, waiting for `next_dispatch_at` to elapse.
    Waiting,
    /// User paused, or `on_failure = stop` tripped. No dispatches until
    /// resumed via a future Phase B `auto_run_resume` frame.
    Paused,
    /// User stopped; queue is archived with no further dispatches.
    Stopped,
    /// All `target_count` tasks completed, or PlanFlow ran out of
    /// dispatchable work.
    Done,
    /// Alias for a failure that archived the queue (currently unused in
    /// Phase A; the TS model has it so we keep parity).
    Failed,
}

impl AutoRunState {
    /// The set of states the orchestrator's tick loop needs to observe.
    ///
    /// `idle`, `stopped`, `done`, and `failed` need no orchestrator
    /// attention. `paused` is included because the desktop may resume it
    /// via a Phase B frame while the orchestrator is sleeping — keeping
    /// paused rows in the active list means we catch the transition
    /// within one tick instead of waiting for an explicit notification.
    // Phase B `auto_run_resume` handler will query this before dispatching.
    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Scheduled | Self::Running | Self::VerifyingMerge | Self::Waiting | Self::Paused
        )
    }

    /// The SQL fragment used by [`list_active`] to filter rows.
    ///
    /// Kept as a const so the test and the query stay in sync without
    /// duplicating the string. The placeholder count must match the
    /// bind calls in the query builder.
    const ACTIVE_STATES: &'static [&'static str] = &[
        "scheduled",
        "running",
        "verifying_merge",
        "waiting",
        "paused",
    ];
}

impl std::fmt::Display for AutoRunState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Idle => "idle",
            Self::Scheduled => "scheduled",
            Self::Running => "running",
            Self::VerifyingMerge => "verifying_merge",
            Self::Waiting => "waiting",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
            Self::Done => "done",
            Self::Failed => "failed",
        };
        f.write_str(s)
    }
}

impl std::str::FromStr for AutoRunState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "idle" => Ok(Self::Idle),
            "scheduled" => Ok(Self::Scheduled),
            "running" => Ok(Self::Running),
            "verifying_merge" => Ok(Self::VerifyingMerge),
            "waiting" => Ok(Self::Waiting),
            "paused" => Ok(Self::Paused),
            "stopped" => Ok(Self::Stopped),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown auto_run state: {other:?}")),
        }
    }
}

/// Mirror of the TypeScript `AutoRunFailureMode` union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoRunFailureMode {
    /// Pause the queue on any task failure.
    Stop,
    /// Log the failure, add it to history, and keep dispatching.
    Continue,
}

impl std::fmt::Display for AutoRunFailureMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stop => f.write_str("stop"),
            Self::Continue => f.write_str("continue"),
        }
    }
}

impl std::str::FromStr for AutoRunFailureMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "stop" => Ok(Self::Stop),
            "continue" => Ok(Self::Continue),
            other => Err(format!("unknown on_failure value: {other:?}")),
        }
    }
}

/// Mirror of the TypeScript `PlanFlowStartMode` union (T19.35).
///
/// Serialises to the wire-level mergeStrategy literal so the prompt
/// formatter can use it directly without a separate mapping table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanFlowStartMode {
    /// Load context, no autoExecute — `planflow_task_start(taskId: "…")`.
    Manual,
    /// Implement → test → push → open PR → GitHub auto-merge → DONE.
    #[serde(rename = "auto-merge")]
    AutoMerge,
    /// Implement → test → push → open PR → DONE (manual merge).
    Pr,
    /// Implement → test → merge to master → DONE (no review).
    MergeMaster,
    /// Implement → push branch → DONE (no PR / no merge).
    None,
}

impl std::fmt::Display for PlanFlowStartMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Manual => "manual",
            Self::AutoMerge => "auto-merge",
            Self::Pr => "pr",
            Self::MergeMaster => "merge-master",
            Self::None => "none",
        };
        f.write_str(s)
    }
}

impl std::str::FromStr for PlanFlowStartMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "manual" => Ok(Self::Manual),
            "auto-merge" => Ok(Self::AutoMerge),
            "pr" => Ok(Self::Pr),
            "merge-master" => Ok(Self::MergeMaster),
            "none" => Ok(Self::None),
            other => Err(format!("unknown PlanFlow start mode: {other:?}")),
        }
    }
}

/// Mirror of the TypeScript `AutoRunHistoryStatus` union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoRunHistoryStatus {
    Done,
    Failed,
    Skipped,
    Timeout,
}

impl std::fmt::Display for AutoRunHistoryStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Timeout => "timeout",
        };
        f.write_str(s)
    }
}

/// A single completed-task entry appended to `AutoRunQueue::history`.
///
/// Mirrors `src/types/autoRunQueue.ts::AutoRunHistoryEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRunHistoryEntry {
    pub task_id: String,
    pub status: AutoRunHistoryStatus,
    /// Epoch-ms when the task was dispatched.
    pub started_at: i64,
    /// Epoch-ms when the task completed (None for in-flight entries,
    /// though in practice we only push entries when they complete).
    pub finished_at: Option<i64>,
}

/// Server-side auto-run queue, mirroring `src/types/autoRunQueue.ts::AutoRunQueue`.
///
/// Persisted in `auto_run_queues` via [`upsert`]; loaded by the
/// orchestrator tick loop via [`get`] / [`list_active`].
///
/// `camelCase` wire serialisation matches the TypeScript `AutoRunQueue`
/// shape so Phase C desktop code can parse the JSON without a rename map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRunQueue {
    /// Workspace project id (PRIMARY KEY in the DB).
    pub project_id: String,
    /// Stable id for UI React-keying (`arq_<epoch36>_<random6>`).
    /// Serialized as `id` on the wire to match the desktop's
    /// `autoRunQueueSchema` (`src/types/autoRunQueue.ts`), which names this
    /// field `id`; the column + Rust field stay `queue_id`.
    #[serde(rename = "id")]
    pub queue_id: String,
    /// PlanFlow externalId (project UUID on the PlanFlow side).
    pub external_id: String,
    /// How many task completions the user requested.
    pub target_count: i64,
    /// Completed task count so far.
    pub completed_count: i64,
    /// Task currently being polled (None when idle/waiting/done/etc.).
    pub current_task_id: Option<String>,
    /// Branch name returned by `start_work` for the current task.
    pub current_branch_name: Option<String>,
    /// PTY session UUID for the running task's headless agent process.
    /// None until dispatch succeeds or when no task is running.
    pub current_session_id: Option<String>,
    /// Epoch-ms when we entered `verifying_merge` (None otherwise).
    pub verify_started_at: Option<i64>,
    /// Start-mode for every task in this queue.
    pub mode: PlanFlowStartMode,
    /// Epoch-ms to begin the first dispatch (None = start immediately).
    pub start_at: Option<i64>,
    /// Minutes to wait between task completions (0 = back-to-back).
    pub pacing_minutes: f64,
    /// Epoch-ms hard deadline (None = no deadline).
    pub deadline_at: Option<i64>,
    /// Failure policy.
    pub on_failure: AutoRunFailureMode,
    /// Current state-machine state.
    pub state: AutoRunState,
    /// Epoch-ms when the current task was dispatched.
    pub current_task_started_at: Option<i64>,
    /// Epoch-ms for the next dispatch (used in `scheduled` / `waiting`).
    pub next_dispatch_at: Option<i64>,
    /// Ordered history of completed (and failed/timed-out) tasks.
    pub history: Vec<AutoRunHistoryEntry>,
    /// Epoch-ms when the queue was created.
    pub created_at: i64,
}

/// Errors from the auto-run DB layer.
#[derive(Debug, thiserror::Error)]
pub enum AutoRunError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("history JSON: {0}")]
    HistoryJson(#[from] serde_json::Error),
    #[error("invalid state: {0}")]
    InvalidState(String),
    #[error("invalid mode: {0}")]
    InvalidMode(String),
    #[error("invalid on_failure: {0}")]
    InvalidOnFailure(String),
}

// ---------- Public store functions ----------

/// Fetch the queue for a single project. Returns `Ok(None)` when no
/// queue has ever been seeded for this project.
// Phase B `auto_run_start` / `auto_run_status` WS handlers call this.
#[allow(dead_code)]
pub async fn get(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Option<AutoRunQueue>, AutoRunError> {
    let row = sqlx::query(
        "SELECT project_id, queue_id, external_id, target_count, completed_count,
                current_task_id, current_branch_name, current_session_id,
                verify_started_at, mode, start_at, pacing_minutes, deadline_at,
                on_failure, state, current_task_started_at, next_dispatch_at,
                history_json, created_at
         FROM auto_run_queues
         WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_queue).transpose()
}

/// Fetch all queues whose state is `scheduled`, `running`,
/// `verifying_merge`, `waiting`, or `paused`. Called by the
/// orchestrator on every 20-second tick.
///
/// The query uses a fixed IN-list rather than a parameterised array
/// because sqlx/SQLite don't support `bind_array` — the state strings
/// are a closed set defined by the application, not user input, so the
/// literal is safe here. The `ACTIVE_STATES` constant keeps the set in
/// one place.
pub async fn list_active(pool: &SqlitePool) -> Result<Vec<AutoRunQueue>, AutoRunError> {
    // Build: SELECT … FROM auto_run_queues WHERE state IN ('scheduled','running',…)
    // We need exactly as many `?` placeholders as ACTIVE_STATES entries.
    let placeholders = AutoRunState::ACTIVE_STATES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT project_id, queue_id, external_id, target_count, completed_count,
                current_task_id, current_branch_name, current_session_id,
                verify_started_at, mode, start_at, pacing_minutes, deadline_at,
                on_failure, state, current_task_started_at, next_dispatch_at,
                history_json, created_at
         FROM auto_run_queues
         WHERE state IN ({placeholders})"
    );

    let mut q = sqlx::query(&sql);
    for state in AutoRunState::ACTIVE_STATES {
        q = q.bind(*state);
    }

    let rows = q.fetch_all(pool).await?;
    rows.into_iter().map(row_to_queue).collect()
}

/// Upsert a queue row. Used both to seed a new queue (Phase B) and to
/// persist state transitions from the orchestrator tick loop (Phase A).
///
/// `INSERT OR REPLACE` semantics: if a row for `project_id` already
/// exists it is fully replaced, so there's no need for a separate
/// update path. The caller hands in a fully-populated `AutoRunQueue`
/// either way.
pub async fn upsert(pool: &SqlitePool, queue: &AutoRunQueue) -> Result<(), AutoRunError> {
    let history_json = serde_json::to_string(&queue.history)?;
    sqlx::query(
        "INSERT OR REPLACE INTO auto_run_queues
             (project_id, queue_id, external_id, target_count, completed_count,
              current_task_id, current_branch_name, current_session_id,
              verify_started_at, mode, start_at, pacing_minutes, deadline_at,
              on_failure, state, current_task_started_at, next_dispatch_at,
              history_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&queue.project_id)
    .bind(&queue.queue_id)
    .bind(&queue.external_id)
    .bind(queue.target_count)
    .bind(queue.completed_count)
    .bind(queue.current_task_id.as_deref())
    .bind(queue.current_branch_name.as_deref())
    .bind(queue.current_session_id.as_deref())
    .bind(queue.verify_started_at)
    .bind(queue.mode.to_string())
    .bind(queue.start_at)
    .bind(queue.pacing_minutes)
    .bind(queue.deadline_at)
    .bind(queue.on_failure.to_string())
    .bind(queue.state.to_string())
    .bind(queue.current_task_started_at)
    .bind(queue.next_dispatch_at)
    .bind(&history_json)
    .bind(queue.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete a queue row. Idempotent — a missing row returns `Ok(false)`
/// rather than an error, mirroring the `project_links::delete` convention.
// Phase B `auto_run_stop` WS handler calls this.
#[allow(dead_code)]
pub async fn delete(pool: &SqlitePool, project_id: &str) -> Result<bool, AutoRunError> {
    let result = sqlx::query("DELETE FROM auto_run_queues WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

// ---------- Epoch helpers ----------

/// Current wall clock time as epoch milliseconds. Matches `Date.now()`
/// on the TypeScript side so timestamp comparisons across the boundary
/// don't need unit conversion.
pub fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

// ---------- Row mapper ----------

fn row_to_queue(row: SqliteRow) -> Result<AutoRunQueue, AutoRunError> {
    let state_str: String = row.try_get("state")?;
    let state: AutoRunState = state_str
        .parse()
        .map_err(|e: String| AutoRunError::InvalidState(e))?;

    let mode_str: String = row.try_get("mode")?;
    let mode: PlanFlowStartMode = mode_str
        .parse()
        .map_err(|e: String| AutoRunError::InvalidMode(e))?;

    let on_failure_str: String = row.try_get("on_failure")?;
    let on_failure: AutoRunFailureMode = on_failure_str
        .parse()
        .map_err(|e: String| AutoRunError::InvalidOnFailure(e))?;

    let history_json: String = row.try_get("history_json")?;
    let history: Vec<AutoRunHistoryEntry> = serde_json::from_str(&history_json).unwrap_or_default();

    Ok(AutoRunQueue {
        project_id: row.try_get("project_id")?,
        queue_id: row.try_get("queue_id")?,
        external_id: row.try_get("external_id")?,
        target_count: row.try_get("target_count")?,
        completed_count: row.try_get("completed_count")?,
        current_task_id: row.try_get("current_task_id")?,
        current_branch_name: row.try_get("current_branch_name")?,
        current_session_id: row.try_get("current_session_id")?,
        verify_started_at: row.try_get("verify_started_at")?,
        mode,
        start_at: row.try_get("start_at")?,
        pacing_minutes: row.try_get("pacing_minutes")?,
        deadline_at: row.try_get("deadline_at")?,
        on_failure,
        state,
        current_task_started_at: row.try_get("current_task_started_at")?,
        next_dispatch_at: row.try_get("next_dispatch_at")?,
        history,
        created_at: row.try_get("created_at")?,
    })
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn pool() -> SqlitePool {
        let dir = tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        crate::db::open(dir.path()).await.expect("open pool")
    }

    /// Seed the required parent project row so the FK on
    /// `auto_run_queues.project_id` is satisfied.
    async fn seed_project(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(format!("project-{id}"))
        .bind("/tmp")
        .bind("{}")
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(pool)
        .await
        .expect("seed project");
    }

    fn make_queue(project_id: &str) -> AutoRunQueue {
        AutoRunQueue {
            project_id: project_id.to_string(),
            queue_id: format!("arq_{project_id}"),
            external_id: "ext-1".to_string(),
            target_count: 3,
            completed_count: 0,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            verify_started_at: None,
            mode: PlanFlowStartMode::AutoMerge,
            start_at: None,
            pacing_minutes: 5.0,
            deadline_at: None,
            on_failure: AutoRunFailureMode::Continue,
            state: AutoRunState::Running,
            current_task_started_at: None,
            next_dispatch_at: None,
            history: vec![],
            created_at: 1_700_000_000_000,
        }
    }

    #[tokio::test]
    async fn get_returns_none_for_missing_project() {
        let pool = pool().await;
        let result = get(&pool, "ghost").await.expect("get");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn upsert_and_get_round_trips_all_fields() {
        let pool = pool().await;
        seed_project(&pool, "p1").await;

        let mut queue = make_queue("p1");
        queue.current_task_id = Some("T1.5".to_string());
        queue.current_branch_name = Some("branch-t1-5".to_string());
        queue.current_session_id = Some("session-abc".to_string());
        queue.verify_started_at = Some(1_700_000_001_000);
        queue.start_at = Some(1_700_000_000_500);
        queue.deadline_at = Some(1_700_003_600_000);
        queue.current_task_started_at = Some(1_700_000_000_100);
        queue.next_dispatch_at = Some(1_700_000_300_000);
        queue.history = vec![AutoRunHistoryEntry {
            task_id: "T1.4".to_string(),
            status: AutoRunHistoryStatus::Done,
            started_at: 1_699_999_000_000,
            finished_at: Some(1_699_999_900_000),
        }];

        upsert(&pool, &queue).await.expect("upsert");

        let loaded = get(&pool, "p1").await.expect("get").expect("some");
        assert_eq!(loaded.project_id, "p1");
        assert_eq!(loaded.queue_id, "arq_p1");
        assert_eq!(loaded.external_id, "ext-1");
        assert_eq!(loaded.target_count, 3);
        assert_eq!(loaded.completed_count, 0);
        assert_eq!(loaded.current_task_id.as_deref(), Some("T1.5"));
        assert_eq!(loaded.current_branch_name.as_deref(), Some("branch-t1-5"));
        assert_eq!(loaded.current_session_id.as_deref(), Some("session-abc"));
        assert_eq!(loaded.verify_started_at, Some(1_700_000_001_000));
        assert_eq!(loaded.mode, PlanFlowStartMode::AutoMerge);
        assert_eq!(loaded.start_at, Some(1_700_000_000_500));
        assert!((loaded.pacing_minutes - 5.0).abs() < f64::EPSILON);
        assert_eq!(loaded.deadline_at, Some(1_700_003_600_000));
        assert_eq!(loaded.on_failure, AutoRunFailureMode::Continue);
        assert_eq!(loaded.state, AutoRunState::Running);
        assert_eq!(loaded.current_task_started_at, Some(1_700_000_000_100));
        assert_eq!(loaded.next_dispatch_at, Some(1_700_000_300_000));
        assert_eq!(loaded.created_at, 1_700_000_000_000);

        assert_eq!(loaded.history.len(), 1);
        assert_eq!(loaded.history[0].task_id, "T1.4");
        assert_eq!(loaded.history[0].status, AutoRunHistoryStatus::Done);
        assert_eq!(loaded.history[0].finished_at, Some(1_699_999_900_000));
    }

    #[tokio::test]
    async fn upsert_replaces_existing_row() {
        let pool = pool().await;
        seed_project(&pool, "p1").await;
        let queue = make_queue("p1");
        upsert(&pool, &queue).await.expect("first upsert");

        let mut updated = queue.clone();
        updated.state = AutoRunState::Done;
        updated.completed_count = 3;
        upsert(&pool, &updated).await.expect("second upsert");

        let loaded = get(&pool, "p1").await.expect("get").expect("some");
        assert_eq!(loaded.state, AutoRunState::Done);
        assert_eq!(loaded.completed_count, 3);
    }

    #[tokio::test]
    async fn list_active_returns_only_active_states() {
        let pool = pool().await;
        for id in ["p1", "p2", "p3", "p4", "p5", "p6"] {
            seed_project(&pool, id).await;
        }

        // Active states: scheduled, running, verifying_merge, waiting, paused.
        let states = [
            ("p1", AutoRunState::Scheduled),
            ("p2", AutoRunState::Running),
            ("p3", AutoRunState::VerifyingMerge),
            ("p4", AutoRunState::Waiting),
            ("p5", AutoRunState::Paused),
            // Inactive: done — must NOT appear.
            ("p6", AutoRunState::Done),
        ];

        for (pid, state) in &states {
            let mut q = make_queue(pid);
            q.state = state.clone();
            upsert(&pool, &q).await.expect("upsert");
        }

        let active = list_active(&pool).await.expect("list_active");
        let active_ids: Vec<&str> = active.iter().map(|q| q.project_id.as_str()).collect();
        assert_eq!(
            active.len(),
            5,
            "should return 5 active queues, got {active_ids:?}"
        );
        assert!(!active_ids.contains(&"p6"), "done queue must not appear");
    }

    #[tokio::test]
    async fn delete_removes_row_and_is_idempotent() {
        let pool = pool().await;
        seed_project(&pool, "p1").await;
        let queue = make_queue("p1");
        upsert(&pool, &queue).await.expect("upsert");

        let removed = delete(&pool, "p1").await.expect("delete");
        assert!(removed);
        assert!(get(&pool, "p1").await.expect("get").is_none());

        // Second delete must return false, not an error.
        let removed_again = delete(&pool, "p1").await.expect("delete again");
        assert!(!removed_again);
    }

    #[tokio::test]
    async fn deleting_project_cascades_queue() {
        let pool = pool().await;
        seed_project(&pool, "p1").await;
        let queue = make_queue("p1");
        upsert(&pool, &queue).await.expect("upsert");

        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind("p1")
            .execute(&pool)
            .await
            .expect("delete project");

        // The ON DELETE CASCADE in the migration should have removed the queue.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auto_run_queues")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(remaining, 0, "cascade delete must remove queue");
    }

    #[tokio::test]
    async fn corrupt_history_json_degrades_to_empty() {
        let pool = pool().await;
        seed_project(&pool, "p1").await;
        // Insert a row with broken history JSON directly.
        sqlx::query(
            "INSERT INTO auto_run_queues
                 (project_id, queue_id, external_id, target_count, completed_count,
                  mode, on_failure, state, history_json, pacing_minutes, created_at)
             VALUES ('p1', 'arq_p1', 'ext', 1, 0, 'pr', 'stop', 'done',
                     '{not json}', 0, 1700000000000)",
        )
        .execute(&pool)
        .await
        .expect("insert corrupt");

        let loaded = get(&pool, "p1").await.expect("get").expect("some");
        assert!(
            loaded.history.is_empty(),
            "corrupt history_json must degrade to empty vec"
        );
    }

    #[tokio::test]
    async fn auto_run_state_active_coverage() {
        // Every active state must return true; every inactive state false.
        for state in [
            AutoRunState::Scheduled,
            AutoRunState::Running,
            AutoRunState::VerifyingMerge,
            AutoRunState::Waiting,
            AutoRunState::Paused,
        ] {
            assert!(state.is_active(), "{state} should be active");
        }
        for state in [
            AutoRunState::Idle,
            AutoRunState::Stopped,
            AutoRunState::Done,
            AutoRunState::Failed,
        ] {
            assert!(!state.is_active(), "{state} should not be active");
        }
    }

    #[tokio::test]
    async fn planflow_start_mode_round_trips() {
        for (s, expected) in [
            ("manual", PlanFlowStartMode::Manual),
            ("auto-merge", PlanFlowStartMode::AutoMerge),
            ("pr", PlanFlowStartMode::Pr),
            ("merge-master", PlanFlowStartMode::MergeMaster),
            ("none", PlanFlowStartMode::None),
        ] {
            let parsed: PlanFlowStartMode = s.parse().expect("parse");
            assert_eq!(parsed, expected);
            assert_eq!(parsed.to_string(), s);
        }
    }
}
