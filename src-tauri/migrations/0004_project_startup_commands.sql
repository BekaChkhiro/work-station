-- T4.14: per-project startup commands.
-- Stored as a JSON array of strings (e.g. `["npm run dev", "tail -f log"]`).
-- The PTY layer writes each command + a newline to the freshly-spawned
-- shell after subscribers are attached, so commands look like user input.
ALTER TABLE projects ADD COLUMN startup_commands_json TEXT NOT NULL DEFAULT '[]';
