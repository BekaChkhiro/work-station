//! T3.5: versioned migration runner.
//!
//! Migrations live in `src-tauri/migrations/NNNN_name.sql` and are applied in
//! version order. On boot the runner ensures the `schema_version` tracking
//! table exists, seeds it from any prior `_sqlx_migrations` rows so dev DBs
//! migrated by `tauri-plugin-sql`'s built-in runner are not re-applied, then
//! runs each pending migration inside its own transaction. A failure rolls
//! the in-flight transaction back so the DB never lands in a half-applied
//! state.
//!
//! T3.10 wires a pre-flight backup of the database file: when there are
//! pending migrations and a `backups_dir` is supplied, [`run`] snapshots
//! the current DB via `VACUUM INTO` before applying any new versions, so a
//! catastrophic failure beyond per-transaction recovery (e.g. corruption
//! mid-`VACUUM`) can be manually restored from `db-vN-TS.sqlite`.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::sqlite::SqlitePool;
use sqlx::{Executor, Row};

use super::backup;

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "create projects table",
        sql: include_str!("../../migrations/0001_projects.sql"),
    },
    Migration {
        version: 2,
        name: "create sessions table",
        sql: include_str!("../../migrations/0002_sessions.sql"),
    },
    Migration {
        version: 3,
        name: "create app_settings table",
        sql: include_str!("../../migrations/0003_app_settings.sql"),
    },
    Migration {
        version: 4,
        name: "add project startup_commands_json",
        sql: include_str!("../../migrations/0004_project_startup_commands.sql"),
    },
    Migration {
        version: 5,
        name: "create http_cache table",
        sql: include_str!("../../migrations/0005_http_cache.sql"),
    },
    Migration {
        version: 6,
        name: "add project workspace tabs",
        sql: include_str!("../../migrations/0006_project_workspace_tabs.sql"),
    },
    Migration {
        version: 7,
        name: "create project_links table",
        sql: include_str!("../../migrations/0007_project_links.sql"),
    },
];

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("migration list must be 1..=N consecutive; got {0:?}")]
    BadOrder(Vec<u32>),
    #[error("migration {version} ({name}) failed: {source}")]
    Apply {
        version: u32,
        name: &'static str,
        #[source]
        source: sqlx::Error,
    },
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("pre-migration backup failed: {0}")]
    Backup(#[source] backup::BackupError),
}

#[derive(Debug, Default, Clone)]
pub struct RunReport {
    pub applied: Vec<u32>,
    pub skipped: Vec<u32>,
}

/// Apply every pending migration from `list` against `pool`.
///
/// When `backups_dir` is `Some` and at least one migration in `list` is
/// pending, the database is snapshotted into that directory via
/// [`backup::snapshot`] before any migration runs. Tests pass `None` to
/// skip the backup step against in-memory pools.
pub async fn run(
    pool: &SqlitePool,
    list: &[Migration],
    backups_dir: Option<&Path>,
) -> Result<RunReport, MigrationError> {
    validate_order(list)?;
    ensure_schema_version_table(pool).await?;
    seed_from_legacy_if_empty(pool, list).await?;

    let already_applied = applied_versions(pool).await?;
    let has_pending = list.iter().any(|m| !already_applied.contains(&m.version));

    if has_pending {
        if let Some(dir) = backups_dir {
            let current = already_applied.iter().copied().max().unwrap_or(0);
            match backup::snapshot(pool, dir, current).await {
                Ok(path) => tracing::info!(
                    target: "db",
                    ?path,
                    schema_version = current,
                    "pre-migration backup written",
                ),
                Err(error) => return Err(MigrationError::Backup(error)),
            }
        }
    }

    let mut report = RunReport::default();
    for migration in list {
        if already_applied.contains(&migration.version) {
            report.skipped.push(migration.version);
            continue;
        }
        apply_one(pool, migration).await?;
        report.applied.push(migration.version);
    }
    Ok(report)
}

fn validate_order(list: &[Migration]) -> Result<(), MigrationError> {
    let versions: Vec<u32> = list.iter().map(|m| m.version).collect();
    let consecutive = versions.first().is_some_and(|first| *first == 1)
        && versions.windows(2).all(|w| w[1] == w[0] + 1);
    if !consecutive {
        return Err(MigrationError::BadOrder(versions));
    }
    Ok(())
}

async fn ensure_schema_version_table(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    pool.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (
             version    INTEGER PRIMARY KEY NOT NULL,
             name       TEXT    NOT NULL,
             applied_at INTEGER NOT NULL
         );",
    )
    .await?;
    Ok(())
}

async fn applied_versions(pool: &SqlitePool) -> Result<BTreeSet<u32>, sqlx::Error> {
    let rows = sqlx::query("SELECT version FROM schema_version")
        .fetch_all(pool)
        .await?;
    let mut out = BTreeSet::new();
    for row in rows {
        let raw: i64 = row.try_get("version")?;
        if let Ok(v) = u32::try_from(raw) {
            out.insert(v);
        }
    }
    Ok(out)
}

async fn seed_from_legacy_if_empty(
    pool: &SqlitePool,
    list: &[Migration],
) -> Result<(), sqlx::Error> {
    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM schema_version")
        .fetch_one(pool)
        .await?
        .try_get("n")?;
    if count > 0 {
        return Ok(());
    }

    let legacy: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await?
    .try_get("n")?;
    if legacy == 0 {
        return Ok(());
    }

    let known: HashMap<u32, &'static str> = list.iter().map(|m| (m.version, m.name)).collect();
    let now = epoch_seconds();
    let rows =
        sqlx::query("SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version ASC")
            .fetch_all(pool)
            .await?;
    for row in rows {
        let raw: i64 = row.try_get("version")?;
        let Ok(version) = u32::try_from(raw) else {
            continue;
        };
        let name = known.get(&version).copied().unwrap_or("legacy migration");
        sqlx::query(
            "INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .bind(i64::from(version))
        .bind(name)
        .bind(now)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn apply_one(pool: &SqlitePool, migration: &Migration) -> Result<(), MigrationError> {
    let mut tx = pool.begin().await.map_err(|e| wrap(migration, e))?;

    Executor::execute(&mut *tx, migration.sql)
        .await
        .map_err(|e| wrap(migration, e))?;

    sqlx::query("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)")
        .bind(i64::from(migration.version))
        .bind(migration.name)
        .bind(epoch_seconds())
        .execute(&mut *tx)
        .await
        .map_err(|e| wrap(migration, e))?;

    tx.commit().await.map_err(|e| wrap(migration, e))?;
    Ok(())
}

fn wrap(migration: &Migration, source: sqlx::Error) -> MigrationError {
    MigrationError::Apply {
        version: migration.version,
        name: migration.name,
        source,
    }
}

fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite")
    }

    #[tokio::test]
    async fn applies_pending_and_is_idempotent() {
        let pool = fresh_pool().await;

        let first = run(&pool, MIGRATIONS, None).await.expect("first run");
        assert_eq!(first.applied, vec![1, 2, 3, 4, 5, 6, 7]);
        assert!(first.skipped.is_empty());

        // All marker tables exist after a fresh apply.
        for table in [
            "projects",
            "sessions",
            "app_settings",
            "http_cache",
            "project_links",
            "schema_version",
        ] {
            let count: i64 = sqlx::query(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .expect("query master")
            .try_get("n")
            .expect("read count");
            assert_eq!(count, 1, "{table} should exist");
        }

        let second = run(&pool, MIGRATIONS, None).await.expect("second run");
        assert!(second.applied.is_empty(), "no migrations should re-apply");
        assert_eq!(second.skipped, vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[tokio::test]
    async fn failure_rolls_back_and_keeps_prior_versions() {
        // Use a static so the leaked &'static str lives as long as the test.
        const BROKEN_SQL: &str = "CREATE TABLE pending_after_break (id INTEGER); \
                                  THIS IS NOT VALID SQL;";
        let plan: &[Migration] = &[
            MIGRATIONS[0],
            MIGRATIONS[1],
            Migration {
                version: 3,
                name: "broken migration",
                sql: BROKEN_SQL,
            },
        ];

        let pool = fresh_pool().await;
        let err = run(&pool, plan, None)
            .await
            .expect_err("broken plan should fail");
        match err {
            MigrationError::Apply { version, .. } => assert_eq!(version, 3),
            other => panic!("expected Apply error, got {other:?}"),
        }

        // Versions 1 and 2 committed, version 3 did not.
        let versions = applied_versions(&pool).await.expect("query schema_version");
        assert!(versions.contains(&1));
        assert!(versions.contains(&2));
        assert!(!versions.contains(&3));

        // The broken migration's first statement must NOT have leaked through:
        // if rollback works, `pending_after_break` does not exist.
        let leaked: i64 = sqlx::query(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='pending_after_break'",
        )
        .fetch_one(&pool)
        .await
        .expect("query master")
        .try_get("n")
        .expect("count");
        assert_eq!(leaked, 0, "failed migration must roll back fully");
    }

    #[tokio::test]
    async fn seeds_from_legacy_sqlx_migrations() {
        let pool = fresh_pool().await;

        // Simulate a dev DB that was migrated by tauri-plugin-sql earlier.
        pool.execute(include_str!("../../migrations/0001_projects.sql"))
            .await
            .expect("apply 0001 directly");
        pool.execute(
            "CREATE TABLE _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            );",
        )
        .await
        .expect("create legacy table");
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (?, ?, 1, X'00', 0)",
        )
        .bind(1_i64)
        .bind("create projects table")
        .execute(&pool)
        .await
        .expect("seed legacy row");

        let report = run(&pool, MIGRATIONS, None)
            .await
            .expect("run with legacy seed");
        // v1 should be skipped (seeded), v2..v7 newly applied.
        assert_eq!(report.skipped, vec![1]);
        assert_eq!(report.applied, vec![2, 3, 4, 5, 6, 7]);

        let versions = applied_versions(&pool).await.expect("read schema_version");
        assert_eq!(
            versions.iter().copied().collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6, 7]
        );
    }

    /// T3.10 acceptance: when there are pending migrations and a backups
    /// directory is supplied, the runner writes a single
    /// `db-vN-TS.sqlite` snapshot into it before applying anything.
    /// Uses a file-backed DB because `VACUUM INTO` on sqlx in-memory pools
    /// reports success but does not materialise the destination file.
    #[tokio::test]
    async fn writes_backup_before_applying_pending_migrations() {
        let mut workdir = std::env::temp_dir();
        workdir.push(format!("work-station-t310-runner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workdir).expect("create workdir");
        let db_path = workdir.join("source.db");
        let backups = workdir.join("backups");

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite://{}?mode=rwc", db_path.display()))
            .await
            .expect("open file-backed sqlite");

        let report = run(&pool, MIGRATIONS, Some(&backups))
            .await
            .expect("run with backups");
        assert_eq!(report.applied, vec![1, 2, 3, 4, 5, 6, 7]);

        let entries: Vec<_> = std::fs::read_dir(&backups)
            .expect("backups dir created")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(entries.len(), 1, "one pre-migration backup expected");
        let name = entries[0].file_name().to_string_lossy().into_owned();
        assert!(
            name.starts_with("db-v0-") && name.ends_with(".sqlite"),
            "fresh DB should snapshot at v0; got {name}",
        );

        // Re-running with no pending work must NOT add another backup.
        let again = run(&pool, MIGRATIONS, Some(&backups))
            .await
            .expect("idempotent re-run");
        assert!(again.applied.is_empty());
        let count = std::fs::read_dir(&backups)
            .expect("read backups dir")
            .count();
        assert_eq!(count, 1, "no-op run must not write a new backup");

        let _ = std::fs::remove_dir_all(&workdir);
    }

    #[tokio::test]
    async fn rejects_non_consecutive_plan() {
        let pool = fresh_pool().await;
        let plan: &[Migration] = &[
            MIGRATIONS[0],
            Migration {
                version: 5,
                name: "skips ahead",
                sql: "SELECT 1;",
            },
        ];
        let err = run(&pool, plan, None).await.expect_err("gap should fail");
        assert!(matches!(err, MigrationError::BadOrder(_)));
    }
}
