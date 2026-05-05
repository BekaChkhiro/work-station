-- T3.2: projects table.
-- Spec (PROJECT_PLAN T3.2): id PK, descriptive fields, env stored as JSON
-- text, position-ordered with an index, created_at as Unix epoch seconds.
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
