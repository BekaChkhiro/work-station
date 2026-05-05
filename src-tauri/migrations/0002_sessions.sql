-- T3.3: sessions table.
-- Spec (PROJECT_PLAN T3.3): id PK, project_id FK → projects(id), title, cli,
-- cwd, layout_json (split tree + pane→session_id mapping), created_at as
-- Unix epoch seconds. layout_json is parsed by Zod on read (T3.3 acceptance);
-- corrupt JSON falls back to an empty layout, so we accept any TEXT here.
CREATE TABLE sessions (
    id          TEXT    PRIMARY KEY NOT NULL,
    project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    cli         TEXT,
    cwd         TEXT,
    layout_json TEXT    NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_sessions_project ON sessions (project_id);
