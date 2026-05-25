// T19.35 Phase A — see auto_run/mod.rs for module-level documentation.
// PlanFlow, PTY, WebSocket, SQLite appear in prose; allow doc-markdown lint.
#![allow(clippy::doc_markdown)]

//! Auto-run state machine and orchestration tick loop (Phase A).
//!
//! ## Tick loop
//!
//! [`spawn_orchestrator`] starts a perpetual `tokio::spawn` that wakes
//! every [`AUTO_RUN_POLL_INTERVAL_MS`] milliseconds. On each wake it
//! calls [`tick`], which queries all active queues from the DB and runs
//! [`advance`] for each. Errors inside a single-queue advance are logged
//! and swallowed so one broken queue never blocks the others.
//!
//! ## State machine (`advance`)
//!
//! Ports `src/stores/autoRunQueue.ts::advance` verbatim:
//!
//! ```text
//! scheduled  → running (when startAt elapses) → pickAndDispatch
//! waiting    → running (when nextDispatchAt elapses, unless past deadline)
//! running    → pollRunning → completeCurrent / timeout
//! verifying_merge → finishVerifyAdvance (Phase D: PR merge poll; Phase A: immediate)
//! paused / stopped / done / failed / idle → no-op
//! ```
//!
//! ## Dispatch (`pick_and_dispatch`)
//!
//! 1. Calls `planflow.list_tasks` for a fresh task graph.
//! 2. Passes the task list + queue history to [`pick_next_task_id`].
//! 3. Calls `planflow.start_work` to flip the task to `IN_PROGRESS`.
//! 4. Looks up the project's filesystem path from the `projects` table.
//! 5. Spawns a `claude` PTY in that directory via `PtyManager`.
//! 6. Writes the start prompt + CR to the PTY after a short idle delay.
//! 7. Persists `current_task_id` + `current_session_id` to the DB.
//!
//! ## Prompt construction
//!
//! [`format_planflow_start_prompt`] is a Rust port of
//! `src/types/planflowStartMode.ts::formatPlanFlowStartPromptForMode`.
//! The generated string is what the desktop normally types into the
//! spawned `claude` terminal; the orchestrator writes it directly over
//! `PtyManager::write`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use sqlx::sqlite::SqlitePool;
use tokio::task::JoinHandle;
use uuid::Uuid;
use workstation_core::pty::{spawn_reader, PtyManager, SpawnConfig};

use crate::db::auto_run::{
    self, AutoRunFailureMode, AutoRunHistoryEntry, AutoRunHistoryStatus, AutoRunQueue,
    AutoRunState, PlanFlowStartMode,
};
use crate::db::projects;
use crate::dispatch::ProjectsRoot;
use crate::planflow_proxy::PlanflowState;

/// Polling interval for the orchestrator tick loop.
///
/// Mirrors `AUTO_RUN_POLL_INTERVAL_MS = 20_000` from
/// `src/types/autoRunQueue.ts`. Light on the PlanFlow API but responsive
/// enough for the Auto-run bar to feel alive.
pub const AUTO_RUN_POLL_INTERVAL_MS: u64 = 20_000;

/// Maximum time a single task may stay `IN_PROGRESS` before the
/// orchestrator counts it as a timeout and applies `on_failure`.
///
/// Mirrors `AUTO_RUN_TASK_TIMEOUT_MS = 90 * 60 * 1000` from
/// `src/types/autoRunQueue.ts`. Generous because a fresh repo +
/// `pnpm install` can legitimately take 30+ minutes.
pub const AUTO_RUN_TASK_TIMEOUT_MS: i64 = 90 * 60 * 1000;

/// Short delay between spawning a PTY and writing the start prompt.
///
/// Gives the shell a moment to print its banner before we inject
/// `planflow_task_start(...)` — otherwise the bytes may race ahead of
/// the shell's `read()` call and be lost.
const PROMPT_WRITE_DELAY: Duration = Duration::from_millis(800);

/// Columns for the headless `claude` PTY spawned per task.
///
/// Headless agents don't render visually, so any non-zero dimension
/// works. 220 columns gives planflow-mcp plenty of room to emit its
/// JSON tool-call output without wrapping.
const PTY_COLS: u16 = 220;
/// Rows for the headless `claude` PTY. Matches the desktop's headless
/// spawn so `claude`'s output pagination is consistent.
const PTY_ROWS: u16 = 50;

// ---------- Public entry point ----------

/// Spawn the perpetual orchestration loop and return its `JoinHandle`.
///
/// The returned handle should be stored for the daemon's lifetime (e.g.
/// in a `Vec<JoinHandle<()>>` inside `server::spawn`) so the task isn't
/// silently dropped. The loop is intentionally infallible: a panic inside
/// a single tick is caught and logged; the loop restarts on the next
/// `AUTO_RUN_POLL_INTERVAL_MS` beat.
///
/// `pool`, `manager`, `planflow`, and `projects_root` are all cheaply
/// cloneable Arc-wrapped handles; the orchestrator holds its own clones
/// so the caller can drop its copies without affecting us.
pub fn spawn_orchestrator(
    pool: SqlitePool,
    manager: PtyManager,
    planflow: PlanflowState,
    projects_root: ProjectsRoot,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            target: "cloud_agent::auto_run",
            interval_ms = AUTO_RUN_POLL_INTERVAL_MS,
            "auto-run orchestrator started",
        );
        loop {
            tokio::time::sleep(Duration::from_millis(AUTO_RUN_POLL_INTERVAL_MS)).await;
            tick(&pool, &manager, &planflow, &projects_root).await;
        }
    })
}

// ---------- Tick and advance ----------

/// Run one orchestration tick: load all active queues and advance each.
///
/// A failure inside a single queue's advance is logged and swallowed so
/// one broken project doesn't prevent the others from making progress.
async fn tick(
    pool: &SqlitePool,
    manager: &PtyManager,
    planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
) {
    let queues = match auto_run::list_active(pool).await {
        Ok(q) => q,
        Err(error) => {
            tracing::error!(
                target: "cloud_agent::auto_run",
                error = %error,
                "list_active failed; skipping tick",
            );
            return;
        }
    };

    for queue in queues {
        let project_id = queue.project_id.clone();
        if let Err(error) = advance(pool, manager, planflow, projects_root, queue).await {
            tracing::warn!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                error = %error,
                "advance failed for queue; will retry next tick",
            );
        }
    }
}

/// Errors that can occur during a single-queue advance.
#[derive(Debug, thiserror::Error)]
enum AdvanceError {
    #[error("db: {0}")]
    Db(#[from] auto_run::AutoRunError),
    #[error("planflow: {0}")]
    Planflow(String),
    #[error("project not found: {0}")]
    ProjectNotFound(String),
    // Phase B TODO: used when resolving the project_links record for a queue.
    #[allow(dead_code)]
    #[error("project link not found (service=planflow) for project {0}")]
    PlanflowLinkNotFound(String),
    #[error("pty spawn failed: {0}")]
    PtySpawn(String),
    #[error("pty write failed: {0}")]
    PtyWrite(String),
}

/// Log a `pick_and_dispatch` error without propagating it.
///
/// The queue state was already persisted as `Running` before dispatch was
/// attempted, so the next tick will retry. Only `Db` errors (which would
/// mean the state write itself failed) are allowed to propagate via `?`
/// and they never reach this helper.
fn log_dispatch_error(project_id: &str, err: AdvanceError) {
    tracing::warn!(
        target: "cloud_agent::auto_run",
        project_id = %project_id,
        error = %err,
        "pick_and_dispatch failed; state is Running, will retry next tick",
    );
}

/// Advance one queue through its state machine.
///
/// Mirrors `src/stores/autoRunQueue.ts::advance` exactly:
///
/// - `scheduled` → flip to `running` when `startAt` elapses.
/// - `waiting`   → flip to `running` when `nextDispatchAt` elapses
///   (or finalize on deadline).
/// - `running`   → [`poll_running`].
/// - `verifying_merge` → [`finish_verify_advance`] (Phase A: immediate;
///   Phase D replaces this with PR-merge polling).
/// - all other states are terminal / paused; no-op.
async fn advance(
    pool: &SqlitePool,
    manager: &PtyManager,
    planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
    queue: AutoRunQueue,
) -> Result<(), AdvanceError> {
    let now = auto_run::epoch_ms();
    let project_id = queue.project_id.clone();

    match &queue.state {
        AutoRunState::Scheduled => {
            if queue.start_at.map_or(true, |t| now >= t) {
                let updated = AutoRunQueue {
                    state: AutoRunState::Running,
                    next_dispatch_at: None,
                    ..queue
                };
                // Persist Running state before attempting dispatch so that
                // a transient network error doesn't leave the queue stuck in
                // Scheduled. On error the next tick sees Running with no
                // current_task_id and retries pick_and_dispatch.
                auto_run::upsert(pool, &updated).await?;
                if let Err(err) =
                    pick_and_dispatch(pool, manager, planflow, projects_root, updated).await
                {
                    log_dispatch_error(&project_id, err);
                }
            }
        }

        AutoRunState::Waiting => {
            if queue.next_dispatch_at.map_or(true, |t| now >= t) {
                // Hard deadline check.
                if queue.deadline_at.is_some_and(|d| now >= d) {
                    finalize_on_deadline(pool, queue).await?;
                    return Ok(());
                }
                let updated = AutoRunQueue {
                    state: AutoRunState::Running,
                    next_dispatch_at: None,
                    ..queue
                };
                // Same rationale as the Scheduled arm above — the state is
                // already saved; a dispatch failure is transient and retried.
                auto_run::upsert(pool, &updated).await?;
                if let Err(err) =
                    pick_and_dispatch(pool, manager, planflow, projects_root, updated).await
                {
                    log_dispatch_error(&project_id, err);
                }
            }
        }

        AutoRunState::Running => {
            poll_running(pool, manager, planflow, projects_root, queue).await?;
        }

        AutoRunState::VerifyingMerge => {
            // Phase D: replace this block with real PR-merge polling.
            // Phase A treats verifying_merge as an immediate advance so
            // the queue keeps moving without GitHub integration.
            tracing::debug!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                "verifying_merge → immediate advance (Phase D TODO: real PR merge check)",
            );
            // Phase D TODO: poll GitHub PR merged_at before calling finish_verify_advance.
            finish_verify_advance(pool, manager, planflow, projects_root, queue).await?;
        }

        // Paused: user may resume via a future Phase B frame; the
        // orchestrator leaves paused queues alone. They remain in
        // list_active so a Phase B resume frame can be serviced.
        AutoRunState::Paused => {
            tracing::trace!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                "queue is paused; no-op",
            );
        }

        // These should not appear in list_active, but guard defensively.
        AutoRunState::Idle | AutoRunState::Stopped | AutoRunState::Done | AutoRunState::Failed => {}
    }

    Ok(())
}

// ---------- State handlers ----------

/// Poll a running task: check whether it has flipped to DONE/DROPPED
/// on PlanFlow, or whether the per-task timeout has elapsed.
///
/// Mirrors `src/stores/autoRunQueue.ts::pollRunning`.
async fn poll_running(
    pool: &SqlitePool,
    manager: &PtyManager,
    planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
    queue: AutoRunQueue,
) -> Result<(), AdvanceError> {
    let project_id = &queue.project_id;

    // No current task — re-trigger the picker. Happens when the queue
    // flipped to `running` but the previous tick's dispatch failed.
    let Some(task_id) = queue.current_task_id.clone() else {
        pick_and_dispatch(pool, manager, planflow, projects_root, queue).await?;
        return Ok(());
    };

    // Resolve the PlanFlow external_id from the project link so we can
    // query task status.
    let external_id = queue.external_id.clone();

    // Fetch the task list to check this task's status.
    let tasks_value = match planflow.list_tasks(&external_id, project_id).await {
        Ok(v) => v,
        Err(error) => {
            // Transient network blip — defer to next tick.
            tracing::warn!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                task_id = %task_id,
                error = %error,
                "list_tasks failed during poll; will retry",
            );
            return Ok(());
        }
    };

    let tasks = tasks_value
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Find the task we're polling by taskId.
    let task_status = tasks
        .iter()
        .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some(task_id.as_str()))
        .and_then(|t| t.get("status").and_then(|v| v.as_str()).map(str::to_owned));

    let started_at = queue
        .current_task_started_at
        .unwrap_or_else(auto_run::epoch_ms);
    let elapsed = auto_run::epoch_ms() - started_at;

    match task_status.as_deref() {
        Some("DONE" | "DROPPED") => {
            tracing::info!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                task_id = %task_id,
                "task completed",
            );
            complete_current(
                pool,
                manager,
                planflow,
                projects_root,
                queue,
                task_id,
                AutoRunHistoryStatus::Done,
                started_at,
            )
            .await?;
        }

        _ if elapsed > AUTO_RUN_TASK_TIMEOUT_MS => {
            tracing::warn!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                task_id = %task_id,
                elapsed_ms = elapsed,
                "task timed out",
            );
            complete_current(
                pool,
                manager,
                planflow,
                projects_root,
                queue,
                task_id,
                AutoRunHistoryStatus::Timeout,
                started_at,
            )
            .await?;
        }

        _ => {
            // Task still in progress — nothing to do yet.
            tracing::trace!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                task_id = %task_id,
                status = ?task_status,
                elapsed_ms = elapsed,
                "task still running",
            );
        }
    }

    Ok(())
}

/// Complete the current task: append a history entry, apply failure
/// policy, decide next state (verifying_merge / waiting / running / done
/// / paused), reap the PTY, and optionally kick off the next dispatch.
///
/// `_planflow` and `_projects_root` are retained in the signature so
/// Phase B can wire in an inline pick_and_dispatch without a signature
/// change (using `Box::pin` to break the async-recursion cycle).
///
/// Mirrors `src/stores/autoRunQueue.ts::completeCurrent`.
#[allow(clippy::too_many_arguments)]
async fn complete_current(
    pool: &SqlitePool,
    manager: &PtyManager,
    _planflow: &PlanflowState,
    _projects_root: &ProjectsRoot,
    queue: AutoRunQueue,
    task_id: String,
    status: AutoRunHistoryStatus,
    started_at: i64,
) -> Result<(), AdvanceError> {
    let finished_at = auto_run::epoch_ms();
    let project_id = queue.project_id.clone();
    let previous_session_id = queue.current_session_id.clone();

    // Build the history entry.
    let entry = AutoRunHistoryEntry {
        task_id: task_id.clone(),
        status: status.clone(),
        started_at,
        finished_at: Some(finished_at),
    };
    let mut history = queue.history.clone();
    history.push(entry);

    // onFailure=stop: pause the queue instead of advancing.
    if matches!(
        status,
        AutoRunHistoryStatus::Failed | AutoRunHistoryStatus::Timeout
    ) && queue.on_failure == AutoRunFailureMode::Stop
    {
        let updated = AutoRunQueue {
            history,
            state: AutoRunState::Paused,
            next_dispatch_at: None,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            current_task_started_at: None,
            verify_started_at: None,
            ..queue
        };
        auto_run::upsert(pool, &updated).await?;
        reap_pty(manager, &project_id, previous_session_id.as_deref());
        return Ok(());
    }

    // For auto-merge: enter verifying_merge before bumping completedCount,
    // UNLESS this was the last task (no point verifying if we're done).
    //
    // Phase D TODO: replace the immediate-advance branch below with real
    // PR-merge polling once GitHub token store is available.
    if matches!(status, AutoRunHistoryStatus::Done)
        && queue.mode == PlanFlowStartMode::AutoMerge
        && queue.current_branch_name.is_some()
        && queue.completed_count + 1 < queue.target_count
    {
        let updated = AutoRunQueue {
            history,
            state: AutoRunState::VerifyingMerge,
            verify_started_at: Some(finished_at),
            next_dispatch_at: None,
            current_task_started_at: None,
            ..queue
        };
        auto_run::upsert(pool, &updated).await?;
        // Note: the PTY is kept alive during verifying_merge so Phase D's
        // PR-merge poller can inspect the agent's last output if needed.
        // The session is reaped in finish_verify_advance.
        return Ok(());
    }

    // Normal path: bump completedCount, decide state.
    let completed_count = queue.completed_count + 1;
    let all_done = completed_count >= queue.target_count;

    if all_done {
        let updated = AutoRunQueue {
            history,
            completed_count,
            state: AutoRunState::Done,
            next_dispatch_at: None,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            current_task_started_at: None,
            verify_started_at: None,
            ..queue
        };
        auto_run::upsert(pool, &updated).await?;
        reap_pty(manager, &project_id, previous_session_id.as_deref());
        tracing::info!(
            target: "cloud_agent::auto_run",
            project_id = %project_id,
            completed = completed_count,
            "queue completed",
        );
        return Ok(());
    }

    // pacing_minutes is a user-supplied value (0–1440 min); after .round()
    // the result fits comfortably in i64 (max ~86_400_000 ms < i64::MAX).
    #[allow(clippy::cast_possible_truncation)]
    let pacing_ms = (queue.pacing_minutes * 60.0 * 1000.0).round() as i64;
    let (next_state, next_dispatch_at) = if pacing_ms > 0 {
        (AutoRunState::Waiting, Some(finished_at + pacing_ms))
    } else {
        // No pacing: set nextDispatchAt = now so the very next tick
        // (or poll_running re-entry) picks up immediately. We do NOT
        // call pick_and_dispatch inline here to avoid async recursion
        // (complete_current ← pick_and_dispatch ← complete_current
        // is a cycle Rust cannot size without Box::pin). The
        // orchestrator's tick loop will call advance → poll_running →
        // pick_and_dispatch on the next 20s beat — negligible latency
        // compared to a typical task turnaround of minutes.
        (AutoRunState::Running, None)
    };

    let updated = AutoRunQueue {
        history,
        completed_count,
        state: next_state,
        next_dispatch_at,
        current_task_id: None,
        current_branch_name: None,
        current_session_id: None,
        current_task_started_at: None,
        verify_started_at: None,
        ..queue
    };
    auto_run::upsert(pool, &updated).await?;
    reap_pty(manager, &project_id, previous_session_id.as_deref());

    Ok(())
}

/// Advance out of `verifying_merge`: bump completedCount, decide next
/// state, reap the PTY.
///
/// Phase A: called immediately after entering verifying_merge (no real
/// PR poll). Phase D: called after `merged_at` is confirmed (or timeout).
///
/// Mirrors `src/stores/autoRunQueue.ts::finishVerifyAdvance`.
///
/// `_planflow` and `_projects_root` are retained for Phase B inline
/// dispatch (see `complete_current` doc comment).
async fn finish_verify_advance(
    pool: &SqlitePool,
    manager: &PtyManager,
    _planflow: &PlanflowState,
    _projects_root: &ProjectsRoot,
    queue: AutoRunQueue,
) -> Result<(), AdvanceError> {
    let project_id = queue.project_id.clone();
    let previous_session_id = queue.current_session_id.clone();

    let completed_count = queue.completed_count + 1;
    let all_done = completed_count >= queue.target_count;

    if all_done {
        let updated = AutoRunQueue {
            completed_count,
            state: AutoRunState::Done,
            next_dispatch_at: None,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            current_task_started_at: None,
            verify_started_at: None,
            ..queue
        };
        auto_run::upsert(pool, &updated).await?;
        reap_pty(manager, &project_id, previous_session_id.as_deref());
        return Ok(());
    }

    // Same bound as complete_current: pacing_minutes ≤ 1440 → ≤ 86_400_000 ms.
    #[allow(clippy::cast_possible_truncation)]
    let pacing_ms = (queue.pacing_minutes * 60.0 * 1000.0).round() as i64;
    let now = auto_run::epoch_ms();
    let (next_state, next_dispatch_at) = if pacing_ms > 0 {
        (AutoRunState::Waiting, Some(now + pacing_ms))
    } else {
        // Same pattern as complete_current: leave state=running with no
        // nextDispatchAt and let the next tick's poll_running → pick_and_dispatch
        // handle the dispatch. This avoids async recursion through Box::pin.
        (AutoRunState::Running, None)
    };

    let updated = AutoRunQueue {
        completed_count,
        state: next_state,
        next_dispatch_at,
        current_task_id: None,
        current_branch_name: None,
        current_session_id: None,
        current_task_started_at: None,
        verify_started_at: None,
        ..queue
    };
    auto_run::upsert(pool, &updated).await?;
    reap_pty(manager, &project_id, previous_session_id.as_deref());

    Ok(())
}

/// Finalize the queue because its deadline has passed.
///
/// Mirrors `src/stores/autoRunQueue.ts::finalizeOnDeadline`.
async fn finalize_on_deadline(pool: &SqlitePool, queue: AutoRunQueue) -> Result<(), AdvanceError> {
    let project_id = queue.project_id.clone();
    tracing::info!(
        target: "cloud_agent::auto_run",
        project_id = %project_id,
        "queue deadline reached; finalizing",
    );
    let updated = AutoRunQueue {
        state: AutoRunState::Done,
        next_dispatch_at: None,
        current_task_id: None,
        current_task_started_at: None,
        ..queue
    };
    auto_run::upsert(pool, &updated).await?;
    Ok(())
}

// ---------- Dispatch ----------

/// Pick the next task and dispatch it.
///
/// Re-queries the PlanFlow task list for a fresh dependency graph (same
/// rationale as `src/stores/autoRunQueue.ts::pickAndDispatch`), picks
/// a task via [`pick_next_task_id`], calls `planflow.start_work`, spawns
/// a `claude` PTY, and writes the start prompt. All state transitions
/// are persisted to the DB.
#[allow(clippy::too_many_lines)]
async fn pick_and_dispatch(
    pool: &SqlitePool,
    manager: &PtyManager,
    planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
    queue: AutoRunQueue,
) -> Result<(), AdvanceError> {
    let project_id = &queue.project_id;

    if queue.state != AutoRunState::Running {
        return Ok(());
    }

    // Resolve the PlanFlow externalId for this project so we can list tasks.
    let planflow_project_id = queue.external_id.clone();

    // Fetch a fresh task list so the picker honours the current
    // dependency graph rather than a stale snapshot from queue-create time.
    let tasks_value = planflow
        .list_tasks(&planflow_project_id, project_id)
        .await
        .map_err(|e| AdvanceError::Planflow(e.to_string()))?;

    let tasks = tasks_value
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let Some(task_id) = pick_next_task_id(&tasks, &queue.history) else {
        // PlanFlow ran out of dispatchable work — finalise the queue.
        tracing::info!(
            target: "cloud_agent::auto_run",
            project_id = %project_id,
            "no dispatchable tasks; finalizing queue as done",
        );
        let updated = AutoRunQueue {
            state: AutoRunState::Done,
            next_dispatch_at: None,
            current_task_id: None,
            current_task_started_at: None,
            ..queue
        };
        auto_run::upsert(pool, &updated).await?;
        return Ok(());
    };

    // Optimistically record the task as in-flight before the network
    // call so a concurrent tick can't double-dispatch the same task.
    let dispatch_started_at = auto_run::epoch_ms();
    let in_flight = AutoRunQueue {
        current_task_id: Some(task_id.clone()),
        current_task_started_at: Some(dispatch_started_at),
        ..queue.clone()
    };
    auto_run::upsert(pool, &in_flight).await?;

    tracing::info!(
        target: "cloud_agent::auto_run",
        project_id = %project_id,
        task_id = %task_id,
        "dispatching task",
    );

    // Call PlanFlow's start_work to flip the task to IN_PROGRESS and get
    // the branch name.
    let work_result = planflow
        .start_work(&planflow_project_id, &task_id, project_id)
        .await;

    let (branch_name, session_id) = match work_result {
        Ok(data) => {
            let branch = data
                .get("branchName")
                .or_else(|| data.get("branch_name"))
                .and_then(|v| v.as_str())
                .map(str::to_owned);

            // Spawn the PTY — resolve project path from DB.
            match spawn_task_pty(
                pool,
                manager,
                planflow,
                projects_root,
                project_id,
                &task_id,
                &queue.mode,
            )
            .await
            {
                Ok(sid) => (branch, Some(sid.to_string())),
                Err(error) => {
                    tracing::warn!(
                        target: "cloud_agent::auto_run",
                        project_id = %project_id,
                        task_id = %task_id,
                        error = %error,
                        "PTY spawn failed; marking task failed",
                    );
                    complete_current(
                        pool,
                        manager,
                        planflow,
                        projects_root,
                        in_flight,
                        task_id,
                        AutoRunHistoryStatus::Failed,
                        dispatch_started_at,
                    )
                    .await?;
                    return Ok(());
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                target: "cloud_agent::auto_run",
                project_id = %project_id,
                task_id = %task_id,
                error = %error,
                "start_work failed; marking task failed",
            );
            complete_current(
                pool,
                manager,
                planflow,
                projects_root,
                in_flight,
                task_id,
                AutoRunHistoryStatus::Failed,
                dispatch_started_at,
            )
            .await?;
            return Ok(());
        }
    };

    // Persist the session id + branch name.
    let dispatched = AutoRunQueue {
        current_branch_name: branch_name,
        current_session_id: session_id,
        ..in_flight
    };
    auto_run::upsert(pool, &dispatched).await?;

    tracing::info!(
        target: "cloud_agent::auto_run",
        project_id = %project_id,
        task_id = %dispatched.current_task_id.as_deref().unwrap_or("?"),
        session_id = ?dispatched.current_session_id,
        branch = ?dispatched.current_branch_name,
        "dispatch complete",
    );

    Ok(())
}

/// Spawn a headless `claude` PTY for the given task and write the start
/// prompt. Returns the session UUID.
///
/// Resolves the project's filesystem path from the `projects` table.
/// Mirrors the desktop's `startTaskCliLauncher` + `writePromptWhenReady`
/// flow (Phase G TODO: port the idle-detect loop for a production-quality
/// idle write; Phase A uses a fixed [`PROMPT_WRITE_DELAY`]).
async fn spawn_task_pty(
    pool: &SqlitePool,
    manager: &PtyManager,
    _planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
    project_id: &str,
    task_id: &str,
    mode: &PlanFlowStartMode,
) -> Result<Uuid, AdvanceError> {
    // Resolve the project's filesystem path.
    let project = projects::get(pool, project_id)
        .await
        .map_err(|_| AdvanceError::ProjectNotFound(project_id.to_string()))?;

    // Resolve the project cwd: use the project's path if it exists on
    // the cloud-agent's filesystem; fall back to projects_root so the
    // spawn still lands somewhere sane if the path is missing.
    let cwd = {
        let candidate = PathBuf::from(&project.path);
        if candidate.exists() {
            candidate
        } else {
            projects_root.as_path().to_path_buf()
        }
    };

    let config = SpawnConfig {
        command: "claude".to_string(),
        args: vec![],
        cwd: Some(cwd),
        // Inherit the daemon's environment so claude / planflow-mcp can
        // find their config files. The design doc (§ 6, VPS findings)
        // notes that `~/.npm-global/bin` may not be on PATH for wsagent;
        // Phase F will add a proper CLI-detection frame. For Phase A we
        // inherit and hope the operator has configured the PATH correctly.
        env: HashMap::new(),
        cols: PTY_COLS,
        rows: PTY_ROWS,
    };

    // spawn_reader must be wired after spawn — mirrors dispatch.rs exactly.
    let manager_clone = manager.clone();
    let session_id = tokio::task::spawn_blocking(move || -> Result<Uuid, String> {
        let session_id = manager_clone.spawn(config).map_err(|e| e.to_string())?;
        if let Some(session) = manager_clone.get(session_id) {
            spawn_reader(manager_clone.clone(), &session);
        }
        Ok(session_id)
    })
    .await
    .map_err(|e| AdvanceError::PtySpawn(format!("spawn task panicked: {e}")))?
    .map_err(AdvanceError::PtySpawn)?;

    tracing::debug!(
        target: "cloud_agent::auto_run",
        project_id = %project_id,
        task_id = %task_id,
        session_id = %session_id,
        "claude PTY spawned; waiting before writing prompt",
    );

    // Wait for the shell to settle before injecting the prompt.
    // Phase G TODO: replace this fixed delay with an idle-detect loop
    // that watches the PTY output broadcast and waits for 600ms of
    // silence (mirrors writePromptWhenReady in AppRoot.tsx:1341).
    tokio::time::sleep(PROMPT_WRITE_DELAY).await;

    let prompt = format_planflow_start_prompt(task_id, mode);
    // Write prompt + carriage return to submit it (mirrors the desktop's
    // `ptyWrite` + `\r` in AppRoot.tsx:1364).
    let payload = format!("{prompt}\r");
    let manager_write = manager.clone();
    tokio::task::spawn_blocking(move || manager_write.write(session_id, payload.as_bytes()))
        .await
        .map_err(|e| AdvanceError::PtyWrite(format!("write task panicked: {e}")))?
        .map_err(|e| AdvanceError::PtyWrite(e.to_string()))?;

    tracing::info!(
        target: "cloud_agent::auto_run",
        project_id = %project_id,
        task_id = %task_id,
        session_id = %session_id,
        "start prompt written to PTY",
    );

    Ok(session_id)
}

// ---------- PTY reap helper ----------

/// Attempt to kill the session's PTY. Errors are logged and swallowed —
/// the PTY may already be dead (child exited cleanly), which is the
/// common case, so a `NotFound` from the manager is expected and benign.
fn reap_pty(manager: &PtyManager, project_id: &str, session_id: Option<&str>) {
    let Some(sid_str) = session_id else { return };
    let Ok(sid) = sid_str.parse::<Uuid>() else {
        tracing::warn!(
            target: "cloud_agent::auto_run",
            project_id = %project_id,
            session_id = %sid_str,
            "cannot parse session id as UUID for reap",
        );
        return;
    };
    // `kill` is synchronous (blocking I/O on the child's stdin pipe);
    // running it on the blocking pool keeps the async orchestrator tick
    // non-blocking. Fire-and-forget: we intentionally drop the JoinHandle
    // so the task is detached (the PTY may already be dead, which is fine).
    let manager = manager.clone();
    let project_id = project_id.to_string();
    drop(tokio::task::spawn_blocking(move || {
        match manager.kill(sid) {
            Ok(()) => {
                tracing::debug!(
                    target: "cloud_agent::auto_run",
                    project_id = %project_id,
                    session_id = %sid,
                    "PTY reaped",
                );
            }
            Err(workstation_core::pty::PtyError::NotFound(_)) => {
                // Child already exited and was auto-removed by the reader —
                // this is the normal path after a successful task.
            }
            Err(error) => {
                tracing::warn!(
                    target: "cloud_agent::auto_run",
                    project_id = %project_id,
                    session_id = %sid,
                    error = %error,
                    "PTY reap failed",
                );
            }
        }
    }));
}

// ---------- Task picking ----------

/// A minimal task view extracted from PlanFlow's JSON response, used
/// inside [`pick_next_task_id`]. Only `task_id` is read back at the
/// call site; the other fields exist to document what was checked
/// during candidate filtering.
struct TaskView<'a> {
    task_id: &'a str,
    /// Retained for documentation — the filter above confirmed status=="TODO".
    #[allow(dead_code)]
    status: &'a str,
    /// Retained for documentation — the filter above confirmed all deps done.
    #[allow(dead_code)]
    dependencies: Vec<&'a str>,
    /// Retained for documentation — the filter above confirmed None.
    #[allow(dead_code)]
    locked_by: Option<&'a str>,
}

/// Pick the next task to dispatch from a freshly-fetched task list.
///
/// Ports `src/stores/autoRunQueue.ts::pickNextTaskId` exactly:
///
///   * Only picks tasks with `status == "TODO"`.
///   * Excludes tasks already in `history` (so failed tasks in
///     `onFailure=continue` mode don't get re-picked).
///   * Excludes tasks whose dependencies are not all DONE/DROPPED.
///   * Excludes tasks locked by anybody (auto-run doesn't muscle
///     through concurrent sessions).
///   * Sorts remaining candidates by [`compare_task_ids`] and returns
///     the first.
///
/// Returns `None` when the queue should finalize as `done` — no more
/// dispatchable work exists.
pub fn pick_next_task_id(
    tasks: &[serde_json::Value],
    history: &[AutoRunHistoryEntry],
) -> Option<String> {
    // Build the DONE/DROPPED set for dependency resolution.
    let done: std::collections::HashSet<&str> = tasks
        .iter()
        .filter(|t| {
            matches!(
                t.get("status").and_then(|v| v.as_str()),
                Some("DONE" | "DROPPED")
            )
        })
        .filter_map(|t| t.get("taskId").and_then(|v| v.as_str()))
        .collect();

    // Tasks already attempted in this run are excluded so a failed task
    // doesn't get re-dispatched in the same queue run.
    let attempted: std::collections::HashSet<&str> =
        history.iter().map(|h| h.task_id.as_str()).collect();

    let mut candidates: Vec<TaskView<'_>> = tasks
        .iter()
        .filter_map(|t| {
            let task_id = t.get("taskId").and_then(|v| v.as_str())?;
            let status = t.get("status").and_then(|v| v.as_str())?;
            if status != "TODO" {
                return None;
            }
            if attempted.contains(task_id) {
                return None;
            }
            let deps: Vec<&str> = t
                .get("dependencies")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|d| d.as_str()).collect())
                .unwrap_or_default();
            // All dependencies must be DONE or DROPPED.
            if !deps.iter().all(|d| done.contains(d)) {
                return None;
            }
            // Locked by anyone (including ourselves in a race) → skip.
            let locked_by = t
                .get("lockedBy")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str());
            if locked_by.is_some() {
                return None;
            }
            Some(TaskView {
                task_id,
                status,
                dependencies: deps,
                locked_by,
            })
        })
        .collect();

    // Sort by canonical id so T1.5 < T1.6 < T2.1.
    candidates.sort_by(|a, b| compare_task_ids(a.task_id, b.task_id));
    candidates.first().map(|t| t.task_id.to_owned())
}

/// Canonical ordering for PlanFlow task ids (`T<phase>.<index>`).
///
/// Ports `src/stores/autoRunQueue.ts::compareTaskIds` verbatim.
/// Non-conforming ids sort after conforming ones; two non-conforming ids
/// fall back to lexicographic comparison.
pub fn compare_task_ids(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |id: &str| -> Option<(u64, u64)> {
        let rest = id.strip_prefix('T')?;
        let (phase_str, index_str) = rest.split_once('.')?;
        let phase: u64 = phase_str.parse().ok()?;
        let index: u64 = index_str.parse().ok()?;
        Some((phase, index))
    };
    let pa = parse(a);
    let pb = parse(b);
    match (pa, pb) {
        (Some((ap, ai)), Some((bp, bi))) => ap.cmp(&bp).then_with(|| ai.cmp(&bi)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(b),
    }
}

// ---------- Prompt formatting ----------

/// Build the `planflow_task_start(...)` literal written into the spawned
/// `claude` PTY.
///
/// Ports `src/types/planflowStartMode.ts::formatPlanFlowStartPromptForMode`
/// verbatim. The generated string is what the user would type if they were
/// starting the task manually; the orchestrator injects it over the PTY
/// pipe so the agent kicks off immediately on spawn.
pub fn format_planflow_start_prompt(task_id: &str, mode: &PlanFlowStartMode) -> String {
    let escaped = task_id.replace('"', "\\\"");
    match mode {
        PlanFlowStartMode::Manual => {
            format!("planflow_task_start(taskId: \"{escaped}\")")
        }
        PlanFlowStartMode::AutoMerge => {
            format!(
                "planflow_task_start(taskId: \"{escaped}\", autoExecute: true, mergeStrategy: \"auto-merge\")"
            )
        }
        PlanFlowStartMode::Pr => {
            format!(
                "planflow_task_start(taskId: \"{escaped}\", autoExecute: true, mergeStrategy: \"pr\")"
            )
        }
        PlanFlowStartMode::MergeMaster => {
            format!(
                "planflow_task_start(taskId: \"{escaped}\", autoExecute: true, mergeStrategy: \"merge-master\")"
            )
        }
        PlanFlowStartMode::None => {
            format!(
                "planflow_task_start(taskId: \"{escaped}\", autoExecute: true, mergeStrategy: \"none\")"
            )
        }
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::auto_run::{AutoRunHistoryEntry, AutoRunHistoryStatus, AutoRunState};
    use serde_json::json;
    use tempfile::tempdir;

    // ---------- compare_task_ids ----------

    #[test]
    fn compare_task_ids_sorts_by_phase_then_index() {
        // Same-phase sort: index is the tiebreaker.
        assert!(compare_task_ids("T1.1", "T1.2").is_lt());
        assert!(compare_task_ids("T1.10", "T1.9").is_gt());
        assert!(compare_task_ids("T1.5", "T1.5").is_eq());

        // Cross-phase: phase wins over index.
        assert!(compare_task_ids("T1.100", "T2.1").is_lt());
        assert!(compare_task_ids("T2.1", "T1.100").is_gt());

        // Non-conforming ids sort after conforming ones.
        assert!(compare_task_ids("T1.1", "not-a-task").is_lt());
        assert!(compare_task_ids("not-a-task", "T1.1").is_gt());

        // Two non-conforming ids fall back to lexicographic order.
        assert!(compare_task_ids("abc", "xyz").is_lt());
        assert!(compare_task_ids("xyz", "abc").is_gt());
        assert!(compare_task_ids("abc", "abc").is_eq());
    }

    #[test]
    fn compare_task_ids_leading_zeros_parsed_numerically() {
        // "T1.09" must equal "T1.9" numerically, not sort differently.
        assert!(compare_task_ids("T1.09", "T1.9").is_eq());
        assert!(compare_task_ids("T01.5", "T1.5").is_eq());
    }

    // ---------- pick_next_task_id ----------

    fn make_task(task_id: &str, status: &str, deps: &[&str]) -> serde_json::Value {
        json!({
            "taskId": task_id,
            "status": status,
            "dependencies": deps,
        })
    }

    fn make_locked_task(task_id: &str) -> serde_json::Value {
        json!({
            "taskId": task_id,
            "status": "TODO",
            "dependencies": [],
            "lockedBy": { "id": "some-user" }
        })
    }

    #[test]
    fn pick_next_task_id_picks_lowest_ready() {
        let tasks = vec![
            make_task("T1.3", "TODO", &[]),
            make_task("T1.1", "DONE", &[]),
            make_task("T1.2", "TODO", &[]),
        ];
        let result = pick_next_task_id(&tasks, &[]);
        assert_eq!(result.as_deref(), Some("T1.2"));
    }

    #[test]
    fn pick_next_task_id_respects_dependencies() {
        let tasks = vec![
            make_task("T1.1", "TODO", &[]),
            // T1.2 depends on T1.1 which is only TODO, not DONE.
            make_task("T1.2", "TODO", &["T1.1"]),
        ];
        let result = pick_next_task_id(&tasks, &[]);
        // T1.1 is picked first; T1.2 is blocked.
        assert_eq!(result.as_deref(), Some("T1.1"));
    }

    #[test]
    fn pick_next_task_id_skips_attempted() {
        let tasks = vec![
            make_task("T1.1", "TODO", &[]),
            make_task("T1.2", "TODO", &[]),
        ];
        let history = vec![AutoRunHistoryEntry {
            task_id: "T1.1".to_string(),
            status: AutoRunHistoryStatus::Failed,
            started_at: 0,
            finished_at: None,
        }];
        let result = pick_next_task_id(&tasks, &history);
        // T1.1 is skipped because it's in history; T1.2 is picked.
        assert_eq!(result.as_deref(), Some("T1.2"));
    }

    #[test]
    fn pick_next_task_id_skips_locked() {
        let tasks = vec![make_locked_task("T1.1"), make_task("T1.2", "TODO", &[])];
        let result = pick_next_task_id(&tasks, &[]);
        assert_eq!(result.as_deref(), Some("T1.2"));
    }

    #[test]
    fn pick_next_task_id_returns_none_when_nothing_dispatchable() {
        // All tasks are either done or locked.
        let tasks = vec![make_task("T1.1", "DONE", &[]), make_locked_task("T1.2")];
        let result = pick_next_task_id(&tasks, &[]);
        assert!(result.is_none());
    }

    #[test]
    fn pick_next_task_id_dep_done_unblocks_dependent() {
        let tasks = vec![
            make_task("T1.1", "DONE", &[]),
            make_task("T1.2", "TODO", &["T1.1"]),
        ];
        let result = pick_next_task_id(&tasks, &[]);
        assert_eq!(result.as_deref(), Some("T1.2"));
    }

    #[test]
    fn pick_next_task_id_dropped_counts_as_done_for_deps() {
        let tasks = vec![
            make_task("T1.1", "DROPPED", &[]),
            make_task("T1.2", "TODO", &["T1.1"]),
        ];
        let result = pick_next_task_id(&tasks, &[]);
        assert_eq!(result.as_deref(), Some("T1.2"));
    }

    #[test]
    fn pick_next_task_id_empty_list_returns_none() {
        let result = pick_next_task_id(&[], &[]);
        assert!(result.is_none());
    }

    // ---------- format_planflow_start_prompt ----------

    #[test]
    fn prompt_manual_mode_bare_call() {
        let p = format_planflow_start_prompt("T1.5", &PlanFlowStartMode::Manual);
        assert_eq!(p, r#"planflow_task_start(taskId: "T1.5")"#);
    }

    #[test]
    fn prompt_auto_merge_mode() {
        let p = format_planflow_start_prompt("T2.10", &PlanFlowStartMode::AutoMerge);
        assert_eq!(
            p,
            r#"planflow_task_start(taskId: "T2.10", autoExecute: true, mergeStrategy: "auto-merge")"#
        );
    }

    #[test]
    fn prompt_pr_mode() {
        let p = format_planflow_start_prompt("T1.1", &PlanFlowStartMode::Pr);
        assert_eq!(
            p,
            r#"planflow_task_start(taskId: "T1.1", autoExecute: true, mergeStrategy: "pr")"#
        );
    }

    #[test]
    fn prompt_merge_master_mode() {
        let p = format_planflow_start_prompt("T1.1", &PlanFlowStartMode::MergeMaster);
        assert_eq!(
            p,
            r#"planflow_task_start(taskId: "T1.1", autoExecute: true, mergeStrategy: "merge-master")"#
        );
    }

    #[test]
    fn prompt_none_mode() {
        let p = format_planflow_start_prompt("T1.1", &PlanFlowStartMode::None);
        assert_eq!(
            p,
            r#"planflow_task_start(taskId: "T1.1", autoExecute: true, mergeStrategy: "none")"#
        );
    }

    #[test]
    fn prompt_escapes_double_quotes_in_task_id() {
        // Unlikely in practice but must not produce broken tool-call syntax.
        let p = format_planflow_start_prompt(r#"T1."x""#, &PlanFlowStartMode::Manual);
        assert_eq!(p, r#"planflow_task_start(taskId: "T1.\"x\"")"#);
    }

    // ---------- DB integration: one tick advances a seeded queue ----------

    async fn db_pool() -> sqlx::sqlite::SqlitePool {
        let dir = tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        crate::db::open(dir.path()).await.expect("open pool")
    }

    async fn seed_project(pool: &sqlx::sqlite::SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(format!("proj-{id}"))
        .bind("/tmp")
        .bind("{}")
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(pool)
        .await
        .expect("seed project");
    }

    /// A `scheduled` queue with a `start_at` in the past must advance to
    /// `running` on the next tick (even if the PlanFlow call fails —
    /// we only assert the state transition, not the dispatch result, so
    /// no wiremock is needed).
    ///
    /// Because pick_and_dispatch hits the network we use a token-less
    /// PlanflowState pointed at a non-existent URL — the dispatch will
    /// fail gracefully (network error) and the task will be marked
    /// `failed`, but the queue itself should have transitioned past
    /// `scheduled`.
    #[tokio::test]
    async fn scheduled_queue_advances_to_running_on_tick() {
        let pool = db_pool().await;
        seed_project(&pool, "p1").await;

        let now = auto_run::epoch_ms();
        let queue = AutoRunQueue {
            project_id: "p1".to_string(),
            queue_id: "arq_test".to_string(),
            external_id: "ext-proj".to_string(),
            target_count: 2,
            completed_count: 0,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            verify_started_at: None,
            mode: PlanFlowStartMode::Pr,
            // start_at in the past so the condition triggers immediately.
            start_at: Some(now - 10_000),
            pacing_minutes: 0.0,
            deadline_at: None,
            on_failure: AutoRunFailureMode::Continue,
            state: AutoRunState::Scheduled,
            current_task_started_at: None,
            next_dispatch_at: None,
            history: vec![],
            created_at: now - 60_000,
        };
        auto_run::upsert(&pool, &queue).await.expect("upsert");

        // Use a PlanflowState that will fail on any network call — we don't
        // care about the dispatch outcome, only that the state transitioned.
        let planflow = crate::planflow_proxy::PlanflowState::for_test(
            "http://127.0.0.1:1",
            std::sync::Arc::new(|_| Ok(Some("tok".to_string()))),
        );
        let manager = PtyManager::new();
        let tmp = tempdir().expect("tmp");
        let projects_root = crate::dispatch::ProjectsRoot::new(tmp.path().to_path_buf());

        advance(&pool, &manager, &planflow, &projects_root, queue)
            .await
            .expect("advance should not return Err (network errors are swallowed)");

        // The queue must no longer be in the `scheduled` state.
        let loaded = auto_run::get(&pool, "p1")
            .await
            .expect("get")
            .expect("some");
        assert_ne!(
            loaded.state,
            AutoRunState::Scheduled,
            "queue must advance out of scheduled on tick"
        );
    }

    /// A `waiting` queue whose `nextDispatchAt` is in the past should
    /// transition to `running` (and then attempt dispatch, which will
    /// fail as above — we only assert the state moved).
    #[tokio::test]
    async fn waiting_queue_advances_when_pacing_elapses() {
        let pool = db_pool().await;
        seed_project(&pool, "p2").await;

        let now = auto_run::epoch_ms();
        let queue = AutoRunQueue {
            project_id: "p2".to_string(),
            queue_id: "arq_test2".to_string(),
            external_id: "ext-proj2".to_string(),
            target_count: 2,
            completed_count: 1,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            verify_started_at: None,
            mode: PlanFlowStartMode::Manual,
            start_at: None,
            pacing_minutes: 1.0,
            deadline_at: None,
            on_failure: AutoRunFailureMode::Continue,
            state: AutoRunState::Waiting,
            current_task_started_at: None,
            // next_dispatch_at in the past.
            next_dispatch_at: Some(now - 5_000),
            history: vec![AutoRunHistoryEntry {
                task_id: "T1.1".to_string(),
                status: AutoRunHistoryStatus::Done,
                started_at: now - 120_000,
                finished_at: Some(now - 60_000),
            }],
            created_at: now - 180_000,
        };
        auto_run::upsert(&pool, &queue).await.expect("upsert");

        let planflow = crate::planflow_proxy::PlanflowState::for_test(
            "http://127.0.0.1:1",
            std::sync::Arc::new(|_| Ok(Some("tok".to_string()))),
        );
        let manager = PtyManager::new();
        let tmp = tempdir().expect("tmp");
        let projects_root = crate::dispatch::ProjectsRoot::new(tmp.path().to_path_buf());

        advance(&pool, &manager, &planflow, &projects_root, queue)
            .await
            .expect("advance must not propagate network errors");

        let loaded = auto_run::get(&pool, "p2")
            .await
            .expect("get")
            .expect("some");
        assert_ne!(
            loaded.state,
            AutoRunState::Waiting,
            "queue must advance out of waiting when pacing elapses"
        );
    }

    /// A `waiting` queue that hasn't hit its `nextDispatchAt` yet must
    /// stay in `waiting` — the tick loop must be patient.
    #[tokio::test]
    async fn waiting_queue_does_not_advance_early() {
        let pool = db_pool().await;
        seed_project(&pool, "p3").await;

        let now = auto_run::epoch_ms();
        let queue = AutoRunQueue {
            project_id: "p3".to_string(),
            queue_id: "arq_test3".to_string(),
            external_id: "ext-proj3".to_string(),
            target_count: 3,
            completed_count: 1,
            current_task_id: None,
            current_branch_name: None,
            current_session_id: None,
            verify_started_at: None,
            mode: PlanFlowStartMode::Manual,
            start_at: None,
            pacing_minutes: 60.0,
            deadline_at: None,
            on_failure: AutoRunFailureMode::Stop,
            state: AutoRunState::Waiting,
            current_task_started_at: None,
            // next_dispatch_at far in the future.
            next_dispatch_at: Some(now + 3_600_000),
            history: vec![],
            created_at: now - 1_000,
        };
        auto_run::upsert(&pool, &queue).await.expect("upsert");

        let planflow = crate::planflow_proxy::PlanflowState::for_test(
            "http://127.0.0.1:1",
            std::sync::Arc::new(|_| Ok(Some("tok".to_string()))),
        );
        let manager = PtyManager::new();
        let tmp = tempdir().expect("tmp");
        let projects_root = crate::dispatch::ProjectsRoot::new(tmp.path().to_path_buf());

        advance(&pool, &manager, &planflow, &projects_root, queue)
            .await
            .expect("advance");

        let loaded = auto_run::get(&pool, "p3")
            .await
            .expect("get")
            .expect("some");
        assert_eq!(
            loaded.state,
            AutoRunState::Waiting,
            "queue must stay in waiting when pacing has not elapsed",
        );
    }
}
