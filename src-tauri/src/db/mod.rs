//! `SQLite` persistence: connection, migrations, queries.
//!
//! T3.1 wires the preloaded pool. T3.2 adds the `projects` table migration.
//! T3.3 adds the `sessions` table. T3.4 adds the `app_settings` key/value
//! table. T3.5 owns the migration runner — see [`migrations`]. T3.6 lands
//! the project CRUD queries in [`projects`]. T3.9 applies durability /
//! concurrency pragmas at boot — see [`apply_pragmas`]. T3.10 snapshots
//! the database before pending migrations run — see [`backup`].

pub mod backup;
pub mod migrations;
pub mod projects;

use sqlx::sqlite::SqlitePool;
use sqlx::{Executor, Row};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_sql::{DbInstances, DbPool};

pub const DB_URL: &str = "sqlite:work-station.db";

/// Pragmas applied at boot before migrations run (T3.9).
///
/// `journal_mode = WAL` is database-level — sqlite writes the mode into the
/// file header, so newly-acquired pool connections inherit it.
///
/// `foreign_keys` and `busy_timeout` are per-connection, but sqlx 0.8's
/// `SqliteConnectOptions` defaults are `foreign_keys: true` and
/// `busy_timeout: Duration::from_secs(5)`, so every fresh connection sqlx
/// opens already carries them. We still re-issue them on the boot
/// connection so the boot path is auditable and a future regression in
/// upstream defaults would surface here as a test failure rather than a
/// silent FK-disabled run.
///
/// `synchronous = NORMAL` is intentionally NOT in this list. It is per-
/// connection and sqlx's default is `FULL`, which means every non-boot
/// connection in the pool runs at `FULL`. Re-issuing `NORMAL` here would
/// only affect the single connection the pragma happens to run on, so
/// claiming pool-wide `NORMAL` would be misleading. `FULL` is more durable
/// than `NORMAL` (extra fsync per commit), which for this personal-use
/// single-writer workload is an acceptable trade.
///
/// Owning the pool ourselves and registering an `after_connect` hook is
/// the only way to guarantee `synchronous = NORMAL` pool-wide; that
/// requires bypassing `tauri-plugin-sql`'s preload and is tracked for
/// v0.2 if commit latency ever becomes a measured problem.
const PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode = WAL;",
    "PRAGMA foreign_keys = ON;",
    "PRAGMA busy_timeout = 5000;",
];

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("preloaded pool {DB_URL} not found")]
    PoolMissing,
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration: {0}")]
    Migration(#[from] migrations::MigrationError),
    #[error("could not resolve app data dir: {0}")]
    AppDataDir(String),
}

/// Apply pending schema migrations against the preloaded pool.
///
/// T3.5 acceptance: adding a new migration applies on next launch; a failure
/// rolls back cleanly via per-migration transactions. T3.10 takes a
/// `VACUUM INTO` snapshot into `<app_data>/backups/` before any pending
/// migration runs.
pub async fn run_migrations<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<migrations::RunReport, DbError> {
    let backups_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| DbError::AppDataDir(e.to_string()))?
        .join("backups");

    let instances = app.state::<DbInstances>();
    let map = instances.0.read().await;
    let pool = map.get(DB_URL).ok_or(DbError::PoolMissing)?;
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(pool) = pool
    else {
        unreachable!("only the sqlite feature is enabled");
    };
    Ok(migrations::run(pool, migrations::MIGRATIONS, Some(&backups_dir)).await?)
}

/// Apply WAL + concurrency pragmas to `pool` (T3.9).
///
/// Run once at boot before migrations so the very first writes use WAL and
/// FK enforcement. `journal_mode = WAL` persists in the database header, so
/// every subsequent connection inherits it.
pub async fn apply_pragmas(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    for pragma in PRAGMAS {
        pool.execute(*pragma).await?;
    }
    Ok(())
}

/// Boot-time variant of [`apply_pragmas`] resolving the preloaded pool.
pub async fn apply_pragmas_app<R: Runtime>(app: &AppHandle<R>) -> Result<(), DbError> {
    let pool = pool(app).await?;
    apply_pragmas(&pool).await?;
    Ok(())
}

/// Resolve the preloaded `SqlitePool`. Cloning the pool is cheap (it's
/// internally Arc-wrapped) so command handlers can take ownership and drop
/// the `DbInstances` read guard before doing async work.
pub async fn pool<R: Runtime>(app: &AppHandle<R>) -> Result<SqlitePool, DbError> {
    let instances = app.state::<DbInstances>();
    let map = instances.0.read().await;
    let pool = map.get(DB_URL).ok_or(DbError::PoolMissing)?;
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(pool) = pool
    else {
        unreachable!("only the sqlite feature is enabled");
    };
    Ok(pool.clone())
}

/// Hello-world `SELECT 1` against the preloaded pool — boot-time smoke check
/// that satisfies T3.1's acceptance ("can run a hello-world query from Rust").
pub async fn hello<R: Runtime>(app: &AppHandle<R>) -> Result<i64, DbError> {
    let pool = pool(app).await?;
    let row = sqlx::query("SELECT 1 AS one").fetch_one(&pool).await?;
    Ok(row.try_get::<i64, _>("one")?)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Executor, Row};
    use std::path::PathBuf;

    /// File-backed pool guard that cleans up the .db, .db-wal, and .db-shm
    /// files when dropped — the WAL test below needs a real on-disk DB
    /// because `:memory:` `SQLite` does not support WAL.
    struct TempDb {
        path: PathBuf,
    }

    impl TempDb {
        fn new(label: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "work-station-t39-{label}-{}.db",
                uuid::Uuid::new_v4()
            ));
            Self { path }
        }

        fn url(&self) -> String {
            format!("sqlite://{}?mode=rwc", self.path.display())
        }

        fn sidecar(&self, suffix: &str) -> PathBuf {
            let mut s = self.path.clone().into_os_string();
            s.push(suffix);
            PathBuf::from(s)
        }

        fn wal(&self) -> PathBuf {
            self.sidecar("-wal")
        }

        fn shm(&self) -> PathBuf {
            self.sidecar("-shm")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(self.wal());
            let _ = std::fs::remove_file(self.shm());
        }
    }

    /// T3.2 acceptance: applying the migration creates the table and an
    /// insert/select round-trips with no data loss.
    #[tokio::test]
    async fn projects_migration_round_trips() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        let migration = include_str!("../../migrations/0001_projects.sql");
        pool.execute(migration).await.expect("apply migration");

        sqlx::query(
            "INSERT INTO projects (id, name, path, color, icon, default_cli, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("p1")
        .bind("Demo")
        .bind("/tmp/demo")
        .bind("#fa0")
        .bind("rocket")
        .bind("zsh")
        .bind(r#"{"FOO":"bar"}"#)
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(&pool)
        .await
        .expect("insert project");

        let row =
            sqlx::query("SELECT id, name, path, env_json, position FROM projects WHERE id = ?")
                .bind("p1")
                .fetch_one(&pool)
                .await
                .expect("select project");

        assert_eq!(row.get::<String, _>("id"), "p1");
        assert_eq!(row.get::<String, _>("name"), "Demo");
        assert_eq!(row.get::<String, _>("path"), "/tmp/demo");
        assert_eq!(row.get::<String, _>("env_json"), r#"{"FOO":"bar"}"#);
        assert_eq!(row.get::<i64, _>("position"), 0);

        let index = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_position'",
        )
        .fetch_optional(&pool)
        .await
        .expect("query index");
        assert!(index.is_some(), "position index should be created");
    }

    /// T3.3 acceptance: applying both migrations creates the sessions table,
    /// an insert/select round-trips, the project FK is enforced, and
    /// `ON DELETE CASCADE` removes orphaned sessions.
    #[tokio::test]
    async fn sessions_migration_round_trips() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        // T3.9: apply the same pragmas the boot path applies, so this test
        // matches production behaviour rather than a half-configured pool.
        super::apply_pragmas(&pool).await.expect("apply pragmas");
        pool.execute(include_str!("../../migrations/0001_projects.sql"))
            .await
            .expect("apply 0001");
        pool.execute(include_str!("../../migrations/0002_sessions.sql"))
            .await
            .expect("apply 0002");

        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("p1")
        .bind("Demo")
        .bind("/tmp/demo")
        .bind("{}")
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(&pool)
        .await
        .expect("insert project");

        sqlx::query(
            "INSERT INTO sessions (id, project_id, title, cli, cwd, layout_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("s1")
        .bind("p1")
        .bind("main")
        .bind("zsh")
        .bind("/tmp/demo")
        .bind(r#"{"type":"pane","sessionId":"s1"}"#)
        .bind(1_700_000_001_i64)
        .execute(&pool)
        .await
        .expect("insert session");

        let row = sqlx::query(
            "SELECT id, project_id, title, cli, layout_json FROM sessions WHERE id = ?",
        )
        .bind("s1")
        .fetch_one(&pool)
        .await
        .expect("select session");
        assert_eq!(row.get::<String, _>("id"), "s1");
        assert_eq!(row.get::<String, _>("project_id"), "p1");
        assert_eq!(row.get::<String, _>("title"), "main");
        assert_eq!(row.get::<String, _>("cli"), "zsh");
        assert_eq!(
            row.get::<String, _>("layout_json"),
            r#"{"type":"pane","sessionId":"s1"}"#
        );

        let index = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_project'",
        )
        .fetch_optional(&pool)
        .await
        .expect("query index");
        assert!(index.is_some(), "project index should be created");

        // FK rejects a session pointing at a non-existent project.
        let orphan = sqlx::query(
            "INSERT INTO sessions (id, project_id, title, layout_json, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("s2")
        .bind("does-not-exist")
        .bind("ghost")
        .bind("{}")
        .bind(1_700_000_002_i64)
        .execute(&pool)
        .await;
        assert!(orphan.is_err(), "FK violation should be rejected");

        // ON DELETE CASCADE: removing the project removes its sessions.
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind("p1")
            .execute(&pool)
            .await
            .expect("delete project");
        let remaining: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sessions")
            .fetch_one(&pool)
            .await
            .expect("count sessions")
            .get("n");
        assert_eq!(remaining, 0, "sessions should cascade-delete with project");
    }

    /// T3.4 acceptance: applying the migration creates the `app_settings`
    /// key/value table; insert/select round-trips, the PRIMARY KEY rejects
    /// duplicates, and `INSERT ... ON CONFLICT(key) DO UPDATE` upserts cleanly
    /// (the upsert path is what the frontend wrapper relies on).
    #[tokio::test]
    async fn app_settings_migration_round_trips() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        pool.execute(include_str!("../../migrations/0003_app_settings.sql"))
            .await
            .expect("apply 0003");

        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("theme")
            .bind(r#""dark""#)
            .execute(&pool)
            .await
            .expect("insert setting");

        let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
            .bind("theme")
            .fetch_one(&pool)
            .await
            .expect("select setting");
        assert_eq!(row.get::<String, _>("value"), r#""dark""#);

        // Upsert: same key replaces the value.
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind("theme")
        .bind(r#""light""#)
        .execute(&pool)
        .await
        .expect("upsert setting");

        let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
            .bind("theme")
            .fetch_one(&pool)
            .await
            .expect("select setting after upsert");
        assert_eq!(row.get::<String, _>("value"), r#""light""#);

        // PK rejects a naive duplicate insert (no ON CONFLICT clause).
        let dup = sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("theme")
            .bind(r#""system""#)
            .execute(&pool)
            .await;
        assert!(dup.is_err(), "duplicate key should be rejected");
    }

    /// T3.9 acceptance: applying the pragmas produces the expected runtime
    /// state on the boot connection — WAL journaling, FK enforcement, and
    /// a 5s busy timeout.
    #[tokio::test]
    async fn pragmas_set_expected_runtime_state() {
        let temp = TempDb::new("state");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&temp.url())
            .await
            .expect("open file-backed sqlite");

        super::apply_pragmas(&pool).await.expect("apply pragmas");

        let mode: String = sqlx::query("PRAGMA journal_mode;")
            .fetch_one(&pool)
            .await
            .expect("query journal_mode")
            .get(0);
        assert_eq!(mode.to_lowercase(), "wal");

        let fk: i64 = sqlx::query("PRAGMA foreign_keys;")
            .fetch_one(&pool)
            .await
            .expect("query foreign_keys")
            .get(0);
        assert_eq!(fk, 1, "foreign keys must be enforced");

        let busy: i64 = sqlx::query("PRAGMA busy_timeout;")
            .fetch_one(&pool)
            .await
            .expect("query busy_timeout")
            .get(0);
        assert_eq!(busy, 5000);
    }

    /// T3.9 regression guard: the pool-wide guarantees we DO claim — WAL
    /// journaling, FK enforcement, and the 5s busy timeout — must hold on
    /// every connection sqlx hands out, not just the boot connection. WAL
    /// is database-level (file header); FK and `busy_timeout` are per-
    /// connection but sqlx 0.8's defaults match. If a future sqlx upgrade
    /// changes those defaults, this test fails loudly.
    #[tokio::test]
    async fn pragmas_apply_to_every_pool_connection() {
        let temp = TempDb::new("multi-conn");
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect(&temp.url())
            .await
            .expect("open file-backed sqlite");
        super::apply_pragmas(&pool).await.expect("apply pragmas");

        // Hold four connections concurrently so each tokio task gets a
        // distinct one — otherwise sqlx may keep handing out the boot
        // connection and the test would assert nothing about the rest.
        let mut handles = Vec::new();
        for _ in 0..4 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                let mut conn = pool.acquire().await.expect("acquire");
                let mode: String = sqlx::query("PRAGMA journal_mode;")
                    .fetch_one(&mut *conn)
                    .await
                    .expect("query journal_mode")
                    .get(0);
                let fk: i64 = sqlx::query("PRAGMA foreign_keys;")
                    .fetch_one(&mut *conn)
                    .await
                    .expect("query foreign_keys")
                    .get(0);
                let busy: i64 = sqlx::query("PRAGMA busy_timeout;")
                    .fetch_one(&mut *conn)
                    .await
                    .expect("query busy_timeout")
                    .get(0);
                // Block the connection long enough that the next acquire
                // is forced to open a fresh one rather than re-using this.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                (mode, fk, busy)
            }));
        }

        for handle in handles {
            let (mode, fk, busy) = handle.await.expect("task joined");
            assert_eq!(
                mode.to_lowercase(),
                "wal",
                "WAL must apply on every connection"
            );
            assert_eq!(fk, 1, "foreign_keys default must be ON on every connection");
            assert_eq!(
                busy, 5000,
                "busy_timeout default must be 5000ms on every connection"
            );
        }
    }

    /// T3.9 acceptance: WAL files are created on disk after a write, and
    /// concurrent reader + writer connections do not deadlock.
    #[tokio::test]
    async fn wal_files_created_and_concurrent_rw_no_deadlock() {
        let temp = TempDb::new("wal");
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect(&temp.url())
            .await
            .expect("open file-backed sqlite");

        super::apply_pragmas(&pool).await.expect("apply pragmas");
        pool.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);")
            .await
            .expect("create table");
        pool.execute("INSERT INTO t (id, n) VALUES (1, 0);")
            .await
            .expect("seed row");

        // Triggering writes ensures the WAL file is materialised.
        assert!(temp.wal().exists(), "WAL sidecar should be created");
        assert!(temp.shm().exists(), "SHM sidecar should be created");

        // Concurrent reader + writer: WAL allows readers to proceed while a
        // writer commits. With busy_timeout=5000ms even contended writes
        // succeed instead of returning SQLITE_BUSY immediately.
        let writer = {
            let pool = pool.clone();
            tokio::spawn(async move {
                for i in 1..=50_i64 {
                    sqlx::query("UPDATE t SET n = ? WHERE id = 1")
                        .bind(i)
                        .execute(&pool)
                        .await
                        .expect("write");
                }
            })
        };
        let reader = {
            let pool = pool.clone();
            tokio::spawn(async move {
                for _ in 0..50 {
                    let _: i64 = sqlx::query("SELECT n FROM t WHERE id = 1")
                        .fetch_one(&pool)
                        .await
                        .expect("read")
                        .get(0);
                }
            })
        };

        // 10s ceiling — generous on slow CI, but tight enough to fail loudly
        // if the pool actually deadlocks.
        let joined = async {
            let (w, r) = tokio::join!(writer, reader);
            (w, r)
        };
        let (w, r) = tokio::time::timeout(std::time::Duration::from_secs(10), joined)
            .await
            .expect("concurrent rw must not deadlock");
        w.expect("writer joined");
        r.expect("reader joined");
    }
}
