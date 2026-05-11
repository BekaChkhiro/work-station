-- PlanFlow chat — per-project, scoped CLI chat for plan/task edits.
--
-- A floating chat widget in the bottom-right of the PlanFlow tab pipes
-- user messages to a hidden PTY running the project's chosen CLI
-- (claude / kimi / codex), with planflow-mcp tools loaded and a system
-- prompt that limits the assistant to plan/task management. The
-- transcript persists per project so the user can pick the conversation
-- back up after restart.
--
-- Schema choices:
--   * `role` is a free text column so we can introduce "tool" or
--     "system" entries later without a schema bump; the inserts in
--     `db/planflowChats.ts` validate against a literal union.
--   * `cli` records which CLI handled the assistant turn so a project
--     that switches CLI mid-conversation can still annotate each
--     message with its origin in the UI.
--   * `tool_calls_json` stores the structured tool-invocation list
--     (e.g. [{name: "planflow_task_progress", args: {...}}]) for
--     assistant messages — Phase 5 renders these as inline chips.
--   * No FK to projects(id) because the chat may outlive a project
--     deletion (the user can keep transcripts even if the workspace
--     entry is gone). The renderer joins by id and silently drops
--     orphaned chats.
CREATE TABLE planflow_chats (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       TEXT    NOT NULL,
    role             TEXT    NOT NULL,
    content          TEXT    NOT NULL,
    cli              TEXT,
    tool_calls_json  TEXT,
    created_at       INTEGER NOT NULL
);

CREATE INDEX idx_planflow_chats_project_created
    ON planflow_chats (project_id, created_at);
