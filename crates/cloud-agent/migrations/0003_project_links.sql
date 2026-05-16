-- Cloud-agent T19.32: project_links table.
--
-- Mirrors `src-tauri/migrations/0007_project_links.sql` field-for-field
-- so a row written by either the desktop or the cloud-agent decodes
-- from the other side without conversion. The desktop's TS wrapper in
-- `src/db/projectLinks.ts` re-validates rows on the wire with Zod, so
-- any drift here would surface as a schema error rather than silent
-- data corruption.
--
-- `service` is free-form TEXT; the canonical id set
-- (planflow|github|vercel|neon|railway) lives in
-- `src/integrations/credentials/index.ts::Integration`. `metadata_json`
-- carries service-shaped extras the UI renders without a remote API
-- round-trip. ON DELETE CASCADE drops links when their project is
-- deleted — same shape as the desktop migration.
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
