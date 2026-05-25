-- Cloud-agent auto-run orchestration (Phase A): auto_run_queues table.
--
-- One row per workspace project (project_id is the PRIMARY KEY so a
-- project can only have one active orchestration queue at a time).
-- Every column mirrors the AutoRunQueue TypeScript interface in
-- `src/types/autoRunQueue.ts` so the Rust serde structs and the TS
-- Zod schema stay in lockstep without a conversion layer.
--
-- All "time" columns store epoch milliseconds (Date.now() in JS,
-- `SystemTime::now().duration_since(UNIX_EPOCH).as_millis()` in Rust)
-- so the tick loop can compare them with `>` / `<` without unit
-- juggling. Nullable columns mirror TypeScript's `| null` semantics.
--
-- `history_json` is a JSON array of AutoRunHistoryEntry objects
-- (`[{taskId,status,startedAt,finishedAt}, ...]`). Serialising the
-- history as a single JSON column avoids a separate table and a JOIN
-- on the hot read path — the history only grows by one entry per
-- task completion, so the blob stays small even for long queues.
CREATE TABLE auto_run_queues (
    -- Workspace project id (FK into projects table).
    project_id              TEXT    PRIMARY KEY NOT NULL
                                    REFERENCES projects(id) ON DELETE CASCADE,

    -- Stable queue id generated at creation time (arq_<timestamp>_<random>).
    -- Used by the UI to React-key across remounts.
    queue_id                TEXT    NOT NULL,

    -- PlanFlow externalId (project UUID on the PlanFlow side).
    external_id             TEXT    NOT NULL,

    -- How many task completions the user requested.
    target_count            INTEGER NOT NULL,

    -- Successful completions so far.
    completed_count         INTEGER NOT NULL DEFAULT 0,

    -- Task currently being polled (null when idle/waiting/done/etc.).
    current_task_id         TEXT,

    -- Branch name returned by start_work for the running task.
    current_branch_name     TEXT,

    -- PTY session UUID for the running task's headless agent process.
    current_session_id      TEXT,

    -- Epoch-ms when we entered verifying_merge (null otherwise).
    verify_started_at       INTEGER,

    -- Start-mode literal: manual | auto-merge | pr | merge-master | none.
    mode                    TEXT    NOT NULL,

    -- Epoch-ms to begin the first dispatch (null = start immediately).
    start_at                INTEGER,

    -- Minutes to wait between task completions (0 = back-to-back).
    pacing_minutes          REAL    NOT NULL DEFAULT 0,

    -- Epoch-ms hard deadline (null = no deadline).
    deadline_at             INTEGER,

    -- Failure policy: "stop" | "continue".
    on_failure              TEXT    NOT NULL DEFAULT 'stop',

    -- State machine state.
    -- Valid values: idle | scheduled | running | verifying_merge |
    --               waiting | paused | stopped | done | failed
    state                   TEXT    NOT NULL DEFAULT 'running',

    -- Epoch-ms when the currently-running task was dispatched.
    current_task_started_at INTEGER,

    -- Epoch-ms for the next dispatch (used in scheduled/waiting states).
    next_dispatch_at        INTEGER,

    -- JSON array of AutoRunHistoryEntry objects.
    history_json            TEXT    NOT NULL DEFAULT '[]',

    -- Epoch-ms when the queue was created.
    created_at              INTEGER NOT NULL
);

-- Speed up list_active queries (the orchestrator polls this on every tick).
CREATE INDEX idx_auto_run_queues_state ON auto_run_queues (state);
