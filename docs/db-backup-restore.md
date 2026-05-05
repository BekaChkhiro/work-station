# Database Backup & Manual Restore (T3.10)

Work Station automatically snapshots its SQLite database before applying
any pending schema migrations. Snapshots use SQLite's `VACUUM INTO`, which
produces a consistent transactional copy that is WAL-safe, then the runner
prunes the directory to the five most recent backups.

## Where backups live

The backups directory sits next to the live database in the platform app
data directory (the same dir where `work-station.db` is created):

| Platform | Path                                                          |
| -------- | ------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/com.work-station.app/backups/` |
| Linux    | `~/.local/share/com.work-station.app/backups/`                |
| Windows  | `%APPDATA%\com.work-station.app\backups\`                     |

Each file is named `db-v{N}-{TS}.sqlite` where:

- `{N}` is the schema version the database was at _before_ this migration
  batch — `0` if the migration runner has never executed against this DB.
- `{TS}` is the epoch milliseconds at which the snapshot started.

## When backups are written

A backup is taken **once per boot, only when at least one migration is
pending.** Idempotent boots (no migrations to apply) do not produce a new
file.

## Manual restore

If a migration fails in a way that per-transaction rollback cannot recover
from (for example, on-disk corruption), the live database can be replaced
with the most recent backup:

1. **Quit Work Station fully.** The app must not hold open file handles
   on the database while you restore.
2. Locate the backups directory (table above) and pick the newest
   `db-vN-TS.sqlite`.
3. In that directory, replace the live database files:

   ```sh
   cd <app-data-dir>
   # Move the broken DB aside in case you need it for diagnostics.
   mv work-station.db work-station.db.broken
   # Discard any leftover WAL sidecars — they belong to the broken DB.
   rm -f work-station.db-wal work-station.db-shm
   # Promote the chosen backup.
   cp backups/db-vN-TS.sqlite work-station.db
   ```

4. Relaunch Work Station. The migration runner will detect that the DB
   is at version `N` and re-apply versions `N+1..` cleanly.

## Verifying a backup

Before relying on a backup, confirm it opens and reports the expected
schema version:

```sh
sqlite3 backups/db-vN-TS.sqlite \
  'SELECT version, name, applied_at FROM schema_version ORDER BY version;'
```

If `schema_version` is empty, the backup pre-dates any migration —
relaunching Work Station will apply the full migration ladder against it.

## Retention

Only the five newest backups are kept. Older snapshots are removed at the
end of each successful backup. Newest is determined by the `{TS}` in the
filename, not file mtime, so manually copying or rsync'ing backups around
will not skew retention.
