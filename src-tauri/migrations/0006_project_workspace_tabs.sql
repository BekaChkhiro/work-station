-- T11.1: per-project workspace tab state.
--
-- `workspace_tabs_json` is the ordered list of tab kinds visible in the
-- project's top-level tab strip (Terminal / Editor / integrations). Stored
-- as a JSON array of strings — same pattern as env_json and
-- startup_commands_json. `active_workspace_tab` records which of those tabs
-- the body currently shows so a relaunch lands on the same view.
--
-- Defaults: every existing row gets `["terminal"]` + `terminal`, matching
-- DEFAULT_VISIBLE_TABS / DEFAULT_ACTIVE_TAB in src/types/workspaceTab.ts.
ALTER TABLE projects ADD COLUMN workspace_tabs_json TEXT NOT NULL DEFAULT '["terminal"]';
ALTER TABLE projects ADD COLUMN active_workspace_tab TEXT NOT NULL DEFAULT 'terminal';
