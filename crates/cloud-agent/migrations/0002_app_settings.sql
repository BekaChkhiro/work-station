-- Cloud-agent T19.25: app_settings key/value table.
--
-- Mirrors `src-tauri/migrations/0003_app_settings.sql`. Values are JSON-
-- encoded TEXT — the same convention `src-tauri/src/db/app_settings.rs`
-- and the TS `src/db/settings.ts` wrapper share, so a row written by
-- either side decodes from the other without conversion.
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
