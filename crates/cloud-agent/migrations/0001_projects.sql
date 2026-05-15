-- Cloud-agent T19.25: projects table.
--
-- Mirrors `src-tauri/migrations/0001_projects.sql` so cloud-agent reads the
-- same row shape the desktop's `db::projects` module produces. Phase-1 only
-- exposes the read paths over WebSocket (`projects_list`, `project_get`,
-- `project_switch`) — CRUD is deferred until a follow-up task wires the
-- mutation messages. Keeping the schema identical means the same row
-- written by a future CRUD path will satisfy the existing readers.
CREATE TABLE projects (
    id          TEXT    PRIMARY KEY NOT NULL,
    name        TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    color       TEXT,
    icon        TEXT,
    default_cli TEXT,
    env_json    TEXT    NOT NULL DEFAULT '{}',
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_projects_position ON projects (position);

ALTER TABLE projects ADD COLUMN startup_commands_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE projects ADD COLUMN workspace_tabs_json TEXT NOT NULL DEFAULT '["terminal"]';
ALTER TABLE projects ADD COLUMN active_workspace_tab TEXT NOT NULL DEFAULT 'terminal';
