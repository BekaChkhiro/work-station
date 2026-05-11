-- Per-project chat session list for the PlanFlow chat panel.
--
-- The panel went from "one PTY per project" to "tab strip with N
-- saved sessions per project". Each row here is one tab. The PTY
-- itself isn't persisted (it dies with the host process), but the
-- session metadata is — so a user who restarts the app gets their
-- tabs back and can resume each one with a click.
--
-- `name` is user-editable (defaults to "Session 1", "Session 2", …
-- on the client). `cli_id` records which CLI the tab was last
-- spawned with so a reopen lands on the same assistant. `last_active_at`
-- drives the default-tab pick on first open.
CREATE TABLE planflow_chat_sessions (
    id              TEXT    PRIMARY KEY,
    project_id      TEXT    NOT NULL,
    cli_id          TEXT,
    name            TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    last_active_at  INTEGER NOT NULL
);

CREATE INDEX idx_planflow_chat_sessions_project_active
    ON planflow_chat_sessions (project_id, last_active_at);
