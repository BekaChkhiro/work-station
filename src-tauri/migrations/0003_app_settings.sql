-- T3.4: app_settings key/value table.
-- Spec (PROJECT_PLAN T3.4): single TEXT/TEXT table holding theme, hotkeys,
-- last-active project, scrollback size, default fallback CLI, etc. Values are
-- always JSON-encoded TEXT; the frontend get/set wrapper (src/db/settings.ts)
-- handles typed coercion via Zod and falls back to defaults on parse failure
-- so corrupt rows never crash callers.
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
