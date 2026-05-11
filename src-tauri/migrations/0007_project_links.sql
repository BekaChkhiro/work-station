-- T11.5: project ↔ external service linking.
--
-- One row per (project, service, external resource) triple. A project may
-- link to many services (PlanFlow project, GitHub repo, Vercel project,
-- Neon DB, Railway service) and may also keep more than one resource per
-- service — e.g. a monorepo wired to two GitHub repos — hence the composite
-- primary key over all three columns.
--
-- `service` is a free-form TEXT column; the canonical id set
-- (planflow|github|vercel|neon|railway) lives in
-- `src/integrations/credentials/index.ts::Integration` and is mirrored by
-- the typed wrapper in `src/db/projectLinks.ts`.
--
-- `metadata_json` carries service-shaped extras the UI needs at render time
-- (e.g. repo full_name + html_url for GitHub, slug + team for Vercel) so the
-- linked-resources view doesn't need a per-service API round trip on every
-- render. Defaults to `{}` to match the env_json / startup_commands_json
-- pattern in `projects`.
--
-- ON DELETE CASCADE drops links when their project is deleted — same shape
-- as `sessions.project_id`.
CREATE TABLE project_links (
    project_id    TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    service       TEXT    NOT NULL,
    external_id   TEXT    NOT NULL,
    metadata_json TEXT    NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, service, external_id)
);

CREATE INDEX idx_project_links_project ON project_links (project_id);
CREATE INDEX idx_project_links_service ON project_links (service);
