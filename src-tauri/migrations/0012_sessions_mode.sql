-- T19.17: per-mode (Local vs Cloud) session and layout isolation.
--
-- Before this migration the `sessions` table held one row per project,
-- shared between Local and Cloud workspace modes. Switching cloud_mode
-- in the desktop UI left the same `layout_json` in place, so panes built
-- in one mode leaked into the other.
--
-- Adding `mode` (default 'local' for back-compat with rows created by
-- T2.12) and re-keying the lookup index by `(project_id, mode)` lets
-- `getOrCreateProjectSession` return the row for whichever mode the user
-- is in. The two rows are independent — switching modes swaps the
-- restored layout and PTYs without touching the other mode's row.
ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'local';
DROP INDEX IF EXISTS idx_sessions_project;
CREATE INDEX idx_sessions_project_mode ON sessions (project_id, mode);
