//! T3.10: pre-migration database backups.
//!
//! Before the migration runner applies any pending versions, [`snapshot`]
//! copies the current database to `<backups_dir>/db-v{N}-{TS}.sqlite`, where
//! `N` is the schema version we're migrating *from* and `TS` is the epoch
//! milliseconds at which the snapshot started. The copy uses
//! `VACUUM INTO`, which is WAL-safe — it sees a consistent transactional
//! view even with other connections open against the live pool.
//!
//! Snapshots accumulate; [`prune`] keeps only the `N` most recent so the
//! backups directory does not grow unbounded across upgrades. The retention
//! count is parameterised so tests can exercise the prune path without
//! generating six real backups.
//!
//! Manual restore is documented in `docs/db-backup-restore.md`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::sqlite::SqlitePool;

/// Maximum number of pre-migration backups retained on disk.
pub const KEEP: usize = 5;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("backup path is not valid UTF-8: {0}")]
    NonUtf8Path(PathBuf),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Snapshot the database backing `pool` into `backups_dir` and prune older
/// snapshots beyond [`KEEP`]. Returns the path of the new backup.
///
/// `schema_version` should be the version we're about to migrate *from*
/// (i.e. `MAX(version)` from `schema_version`, or `0` for a fresh DB).
pub async fn snapshot(
    pool: &SqlitePool,
    backups_dir: &Path,
    schema_version: u32,
) -> Result<PathBuf, BackupError> {
    std::fs::create_dir_all(backups_dir)?;

    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map_or(0, |d| d.as_millis());

    let target = backups_dir.join(format!("db-v{schema_version}-{ts_ms}.sqlite"));

    let target_str = target
        .to_str()
        .ok_or_else(|| BackupError::NonUtf8Path(target.clone()))?;
    // Single-quote escape the path for the SQL literal — VACUUM INTO does
    // not accept a parameter binding. `raw_sql` issues the statement via
    // SQLite's simple-execute interface, which is what VACUUM requires.
    let escaped = target_str.replace('\'', "''");
    let sql = format!("VACUUM INTO '{escaped}'");
    sqlx::raw_sql(&sql).execute(pool).await?;

    prune(backups_dir, KEEP)?;
    Ok(target)
}

/// Keep the `keep` newest `db-v*-*.sqlite` files in `backups_dir`, deleting
/// the rest. Newest is determined by the timestamp embedded in the filename
/// — file mtime is unreliable on copies, snapshots, and some filesystems.
pub fn prune(backups_dir: &Path, keep: usize) -> Result<(), BackupError> {
    let read = match std::fs::read_dir(backups_dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    let mut entries: Vec<(u128, PathBuf)> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?;
            let ts = parse_backup_ts(name)?;
            Some((ts, path))
        })
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.0));
    for (_, path) in entries.into_iter().skip(keep) {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(
                target: "db",
                ?path,
                %error,
                "could not prune old backup",
            );
        }
    }
    Ok(())
}

fn parse_backup_ts(file_name: &str) -> Option<u128> {
    let stem = file_name.strip_prefix("db-v")?.strip_suffix(".sqlite")?;
    // stem is "{N}-{TS}" — split on the last '-' to be tolerant of
    // hypothetical version strings that contain digits only (they don't, but
    // the contract is clearer this way).
    let dash = stem.rfind('-')?;
    stem[dash + 1..].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Executor, Row};
    use std::path::PathBuf;

    /// Holds an on-disk DB plus a backups dir, both removed on drop.
    /// VACUUM INTO with sqlx's in-memory pools is unreliable (it returns
    /// success but does not materialise the destination file), so the
    /// backup tests use a real file-backed source DB which mirrors how
    /// the production runner is invoked anyway.
    struct TempDb {
        dir: PathBuf,
        db: PathBuf,
    }

    impl TempDb {
        fn new(label: &str) -> Self {
            let mut dir = std::env::temp_dir();
            dir.push(format!(
                "work-station-t310-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            let db = dir.join("source.db");
            Self { dir, db }
        }

        fn url(&self) -> String {
            format!("sqlite://{}?mode=rwc", self.db.display())
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "work-station-t310-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn snapshot_writes_readable_backup() {
        let temp = TempDb::new("snapshot");
        let backups = temp.dir.join("backups");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&temp.url())
            .await
            .expect("open file-backed sqlite");
        pool.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);")
            .await
            .expect("create table");
        pool.execute("INSERT INTO t (id, n) VALUES (1, 42), (2, 7);")
            .await
            .expect("seed rows");

        let path = snapshot(&pool, &backups, 3).await.expect("snapshot");

        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .expect("backup name");
        assert!(name.starts_with("db-v3-"), "name was {name}");
        assert!(name.ends_with(".sqlite"), "name was {name}");
        assert!(path.exists(), "backup file should exist");

        // The backup must be a real, readable SQLite database with our data.
        let url = format!("sqlite://{}?mode=ro", path.display());
        let restored = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("open backup");
        let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM t")
            .fetch_one(&restored)
            .await
            .expect("count rows")
            .try_get("n")
            .expect("read count");
        assert_eq!(count, 2);
    }

    #[test]
    fn prune_keeps_only_newest_n() {
        let dir = TempDir::new("prune");
        // Mix of versions to make sure prune is timestamp-driven, not
        // version-driven — the newest five timestamps survive regardless of
        // which schema version they were taken at.
        let names = [
            "db-v0-1.sqlite",
            "db-v1-2.sqlite",
            "db-v1-3.sqlite",
            "db-v2-4.sqlite",
            "db-v2-5.sqlite",
            "db-v3-6.sqlite",
            "db-v3-7.sqlite",
            "db-v4-8.sqlite",
            // Unrelated file in the same dir — must be left alone.
            "README.txt",
        ];
        for name in names {
            std::fs::write(dir.path.join(name), b"x").expect("write fixture");
        }

        prune(&dir.path, 5).expect("prune");

        let mut survivors: Vec<String> = std::fs::read_dir(&dir.path)
            .expect("read dir")
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        survivors.sort();

        assert_eq!(
            survivors,
            vec![
                "README.txt".to_string(),
                "db-v2-4.sqlite".to_string(),
                "db-v2-5.sqlite".to_string(),
                "db-v3-6.sqlite".to_string(),
                "db-v3-7.sqlite".to_string(),
                "db-v4-8.sqlite".to_string(),
            ],
        );
    }

    #[test]
    fn prune_is_a_noop_when_dir_does_not_exist() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "work-station-t310-missing-{}",
            uuid::Uuid::new_v4()
        ));
        // Directory deliberately not created.
        prune(&path, 5).expect("prune missing dir");
    }

    #[tokio::test]
    async fn snapshot_creates_backups_dir_if_missing() {
        let temp = TempDb::new("auto-mkdir");
        let nested = temp.dir.join("backups");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&temp.url())
            .await
            .expect("open file-backed sqlite");
        pool.execute("CREATE TABLE t (id INTEGER);")
            .await
            .expect("create");

        let path = snapshot(&pool, &nested, 0).await.expect("snapshot");
        assert!(nested.is_dir(), "snapshot must mkdir -p the backups dir");
        assert!(path.starts_with(&nested));
    }
}
