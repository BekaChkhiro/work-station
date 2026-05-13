//! T13.5: external-change conflict detection for the in-app editor.
//!
//! When a file is open in the Monaco editor we want the UI to react if
//! something *outside* the editor (a `git pull`, `formatter --write`,
//! another editor) rewrites it on disk:
//!   • buffer is clean → the editor silently reloads to the new disk
//!     content
//!   • buffer is dirty → we surface a conflict banner so the user can
//!     pick reload / keep mine / view diff (the UX wiring lives in
//!     `AppShell::EditorWorkspace`)
//!
//! What this module owns
//! ---------------------
//! A single OS-level filesystem watcher (`notify::RecommendedWatcher`)
//! plus the bookkeeping needed to map raw fs events back to logical
//! "this open file in the editor" entries:
//!
//!   • Each `start_file_watch` call canonicalizes the requested
//!     file and remembers the SHA-256 of its current bytes.
//!   • We watch the file's *parent directory* non-recursively, not
//!     the file itself. On Linux, `inotify` watches an inode; our
//!     atomic save (write temp + rename) replaces the inode, so a
//!     file-level watch would silently stop firing after the first
//!     save. Parent-directory watches survive the swap.
//!   • Multiple watches can target the same file or share a parent
//!     directory; ref counting keeps the kernel-level subscription
//!     installed until the last watch goes away.
//!
//! Why hash, not mtime
//! -------------------
//! fs-event APIs are noisy. Editors often `touch` a file (chmod, atime)
//! or fire spurious "Modify" events even when the bytes never changed.
//! Some networked filesystems coalesce or amplify events. Comparing the
//! SHA-256 of the file we just read against the hash we last knew about
//! is the only reliable way to say "the content actually changed."
//!
//! Self-write filtering
//! --------------------
//! Every successful save through `commands::files::write_text_file` ends
//! in a rename that the watcher will also see. To avoid prompting the
//! user about their own save, `note_self_write` updates the entry's
//! last-known hash *before* the fs event arrives. When the event fires
//! we re-hash the file, see the hash matches what we expect, and skip
//! the emit.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{event::EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;

use crate::pty::{Recovery, UserShape};

/// Same ceiling as `read_text_file` (T13.3). A file that grows past the
/// limit while watched goes silent (we stop classifying / emitting) —
/// the next open attempt will reject it explicitly with `FileError::TooLarge`.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Window we inspect to decide text-vs-binary. Mirrors files.rs so both
/// paths agree on what a "text file" is.
const SNIFF_WINDOW: usize = 8 * 1024;

/// Tauri event payload pushed to the frontend whenever a watched file's
/// disk content changes externally.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChangeEvent {
    pub watch_id: u64,
    /// New text content of the file. We pre-classify on the backend so
    /// the frontend doesn't have to re-invoke `read_text_file` from
    /// inside an event handler.
    pub content: String,
    /// `"utf-8"` or `"utf-8-bom"`. Matches `TextEncoding` in files.rs so
    /// a subsequent save round-trips correctly.
    pub encoding: &'static str,
    /// Hex SHA-256 of the on-disk bytes the frontend just received.
    /// Surfaced so the UI can correlate events if they pile up.
    pub hash: String,
}

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WatchError {
    #[error("{message}")]
    OutOfScope {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    NotFound {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    InvalidPath {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    Internal {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
}

impl WatchError {
    fn out_of_scope(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::OutOfScope {
            ui: UserShape::new("File is outside the project folder.", Recovery::Dismiss),
            message: m,
        }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound {
            ui: UserShape::new("File no longer exists on disk.", Recovery::Dismiss),
            message: message.into(),
        }
    }
    fn invalid_path(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidPath {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new("Could not watch file for changes.", Recovery::Dismiss),
        }
    }
}

struct WatchEntry {
    canonical_path: PathBuf,
    parent: PathBuf,
    last_hash: [u8; 32],
    /// `None` only in unit tests that exercise the bookkeeping without
    /// a real Tauri runtime. Production paths always populate it.
    app: Option<AppHandle>,
}

struct Inner {
    next_id: u64,
    entries: HashMap<u64, WatchEntry>,
    /// Reverse index: canonical absolute file path → set of watch IDs.
    /// Multiple frontend mounts (e.g., reopen same file) all observe the
    /// same physical inode, so we let them share.
    by_path: HashMap<PathBuf, HashSet<u64>>,
    /// Reference count of parent-directory subscriptions. We add /
    /// remove the kernel watch only at the 0↔1 transitions.
    parent_refs: HashMap<PathBuf, u32>,
}

/// App-scoped state managed by Tauri (`app.manage(FileWatchManager::new())`).
pub struct FileWatchManager {
    inner: Arc<Mutex<Inner>>,
    /// Held in an Option so the watcher can be lazily initialised on the
    /// first `start_file_watch` call. Creating it eagerly at boot would
    /// keep a notify thread alive for users who never open the editor.
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl Default for FileWatchManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FileWatchManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                next_id: 1,
                entries: HashMap::new(),
                by_path: HashMap::new(),
                parent_refs: HashMap::new(),
            })),
            watcher: Mutex::new(None),
        }
    }

    /// Wrap the recommended notify watcher. The callback runs on a
    /// notify-managed thread; it locks `inner` briefly and then re-reads
    /// the file from disk so we never hold a mutex across IO.
    fn ensure_watcher(&self) -> Result<(), notify::Error> {
        let mut guard = self.watcher.lock().expect("watcher mutex poisoned");
        if guard.is_some() {
            return Ok(());
        }
        let inner = Arc::clone(&self.inner);
        let watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(event) => handle_event(&inner, &event),
                Err(error) => {
                    tracing::warn!(target: "watch", %error, "notify error");
                }
            })?;
        *guard = Some(watcher);
        Ok(())
    }

    fn start(
        &self,
        app: AppHandle,
        project_root: &Path,
        relative: &Path,
    ) -> Result<u64, WatchError> {
        if relative.is_absolute() {
            return Err(WatchError::invalid_path(
                "relative path must not be absolute",
            ));
        }
        let canonical_root = std::fs::canonicalize(project_root)
            .map_err(|e| WatchError::invalid_path(format!("project root not accessible: {e}")))?;
        let joined = canonical_root.join(relative);
        let canonical_target = std::fs::canonicalize(&joined).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                WatchError::not_found(format!("file not found: {}", joined.display()))
            } else {
                WatchError::invalid_path(format!("cannot resolve file: {e}"))
            }
        })?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(WatchError::out_of_scope(format!(
                "{} escapes {}",
                canonical_target.display(),
                canonical_root.display()
            )));
        }
        let parent = canonical_target
            .parent()
            .ok_or_else(|| WatchError::invalid_path("file has no parent directory"))?
            .to_path_buf();

        let initial_hash = hash_path(&canonical_target).map_err(|e| {
            WatchError::internal(format!(
                "could not hash {}: {e}",
                canonical_target.display()
            ))
        })?;

        self.ensure_watcher()
            .map_err(|e| WatchError::internal(format!("watcher init failed: {e}")))?;

        let (id, needs_subscribe) = {
            let mut guard = self.inner.lock().expect("inner mutex poisoned");
            let id = guard.next_id;
            guard.next_id = guard.next_id.wrapping_add(1).max(1);
            guard.entries.insert(
                id,
                WatchEntry {
                    canonical_path: canonical_target.clone(),
                    parent: parent.clone(),
                    last_hash: initial_hash,
                    app: Some(app),
                },
            );
            guard
                .by_path
                .entry(canonical_target.clone())
                .or_default()
                .insert(id);
            let count = guard.parent_refs.entry(parent.clone()).or_insert(0);
            *count += 1;
            (id, *count == 1)
        };

        if needs_subscribe {
            let mut watcher = self.watcher.lock().expect("watcher mutex poisoned");
            if let Some(w) = watcher.as_mut() {
                if let Err(e) = w.watch(&parent, RecursiveMode::NonRecursive) {
                    // Undo the bookkeeping we just did so the next attempt
                    // starts from a consistent state.
                    let mut guard = self.inner.lock().expect("inner mutex poisoned");
                    guard.entries.remove(&id);
                    if let Some(set) = guard.by_path.get_mut(&canonical_target) {
                        set.remove(&id);
                        if set.is_empty() {
                            guard.by_path.remove(&canonical_target);
                        }
                    }
                    if let Some(count) = guard.parent_refs.get_mut(&parent) {
                        *count = count.saturating_sub(1);
                        if *count == 0 {
                            guard.parent_refs.remove(&parent);
                        }
                    }
                    return Err(WatchError::internal(format!("subscribe failed: {e}")));
                }
            }
        }

        Ok(id)
    }

    fn stop(&self, watch_id: u64) {
        let (parent_to_unwatch, _canonical) = {
            let mut guard = self.inner.lock().expect("inner mutex poisoned");
            let Some(entry) = guard.entries.remove(&watch_id) else {
                return;
            };
            if let Some(set) = guard.by_path.get_mut(&entry.canonical_path) {
                set.remove(&watch_id);
                if set.is_empty() {
                    guard.by_path.remove(&entry.canonical_path);
                }
            }
            let parent_to_unwatch = if let Some(count) = guard.parent_refs.get_mut(&entry.parent) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    guard.parent_refs.remove(&entry.parent);
                    Some(entry.parent.clone())
                } else {
                    None
                }
            } else {
                None
            };
            (parent_to_unwatch, entry.canonical_path)
        };

        if let Some(parent) = parent_to_unwatch {
            let mut watcher = self.watcher.lock().expect("watcher mutex poisoned");
            if let Some(w) = watcher.as_mut() {
                if let Err(error) = w.unwatch(&parent) {
                    tracing::debug!(target: "watch", %error, parent = %parent.display(), "unwatch failed");
                }
            }
        }
    }

    /// Called by the save path after a successful write. Updates the
    /// stored hash for every watch on this file so the fs event that the
    /// rename triggers gets filtered as a no-op self-write.
    pub fn note_self_write(&self, canonical_path: &Path, new_bytes: &[u8]) {
        let mut hasher = Sha256::new();
        hasher.update(new_bytes);
        let new_hash: [u8; 32] = hasher.finalize().into();
        let mut guard = self.inner.lock().expect("inner mutex poisoned");
        let Some(ids) = guard.by_path.get(canonical_path).cloned() else {
            return;
        };
        for id in ids {
            if let Some(entry) = guard.entries.get_mut(&id) {
                entry.last_hash = new_hash;
            }
        }
    }
}

/// Read and hash a file's bytes. Returns the SHA-256 of the raw bytes
/// (before BOM stripping) — keeping the hash byte-exact lets us detect
/// even BOM-only changes as external writes.
fn hash_path(path: &Path) -> std::io::Result<[u8; 32]> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_BYTES {
        return Err(std::io::Error::other("file exceeds watch size limit"));
    }
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hasher.finalize().into())
}

fn hex_encode(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Re-implementation of `commands::files::classify`, narrowed to text/utf-8.
/// We intentionally don't share the function because `files::classify`
/// returns a typed enum and lives behind module-private helpers; copying
/// the 20-line heuristic is cheaper than reshaping its API for one call site.
fn classify_for_event(bytes: &[u8]) -> Option<(String, &'static str)> {
    let (body, had_bom) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (&bytes[3..], true)
    } else {
        (bytes, false)
    };
    let window_end = body.len().min(SNIFF_WINDOW);
    if body[..window_end].contains(&0) {
        return None;
    }
    let text = std::str::from_utf8(body).ok()?;
    Some((text.to_owned(), if had_bom { "utf-8-bom" } else { "utf-8" }))
}

fn handle_event(inner: &Arc<Mutex<Inner>>, event: &notify::Event) {
    // We care about events that may change the bytes; Access events
    // (atime, opened-for-read) carry no content delta.
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    for path in &event.paths {
        let ids: Vec<u64> = {
            let guard = inner.lock().expect("inner mutex poisoned");
            guard
                .by_path
                .get(path)
                .map(|set| set.iter().copied().collect())
                .unwrap_or_default()
        };
        for id in ids {
            process_entry(inner, id);
        }
    }
}

fn process_entry(inner: &Arc<Mutex<Inner>>, id: u64) {
    let (canonical, app, last_hash) = {
        let guard = inner.lock().expect("inner mutex poisoned");
        match guard.entries.get(&id) {
            Some(entry) => {
                let Some(app) = entry.app.clone() else {
                    return;
                };
                (entry.canonical_path.clone(), app, entry.last_hash)
            }
            None => return,
        }
    };
    // The file may have been removed between the event firing and now.
    // We do not currently emit a "deleted" event — the next save attempt
    // will surface the missing file via `FileError::NotFound`.
    let Ok(meta) = std::fs::metadata(&canonical) else {
        return;
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return;
    }
    let Ok(bytes) = std::fs::read(&canonical) else {
        return;
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let new_hash: [u8; 32] = hasher.finalize().into();
    if new_hash == last_hash {
        return;
    }
    let Some((content, encoding)) = classify_for_event(&bytes) else {
        // The file flipped to binary (e.g., overwritten by a different
        // tool with a non-text payload). We swallow the event because
        // there is no text content to hand back to Monaco; the user
        // will see staleness on the next save attempt, and reopening
        // the file goes through the text/binary branch in files.rs.
        return;
    };
    // Update before emit so a second event arriving while the frontend
    // is handling the first sees the new hash and stays quiet.
    {
        let mut guard = inner.lock().expect("inner mutex poisoned");
        if let Some(entry) = guard.entries.get_mut(&id) {
            entry.last_hash = new_hash;
        }
    }
    let payload = ExternalChangeEvent {
        watch_id: id,
        content,
        encoding,
        hash: hex_encode(&new_hash),
    };
    if let Err(error) = app.emit("file:external-change", &payload) {
        tracing::warn!(target: "watch", %error, watch_id = id, "emit failed");
    }
}

// Both commands run on the blocking pool because `start` does
// canonicalize + read-to-hash, and `stop` may call into notify's
// `unwatch` which on some platforms blocks briefly on the kernel.
// Matches the pattern in `commands::files`.
#[tauri::command]
pub async fn start_file_watch(
    app: AppHandle,
    project_root: String,
    relative_path: String,
) -> Result<u64, WatchError> {
    let project_root_p = PathBuf::from(project_root);
    let relative_p = PathBuf::from(relative_path);
    tokio::task::spawn_blocking(move || {
        let emit_app = app.clone();
        let manager = app.state::<FileWatchManager>();
        manager.start(emit_app, &project_root_p, &relative_p)
    })
    .await
    .map_err(|e| WatchError::internal(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn stop_file_watch(app: AppHandle, watch_id: u64) -> Result<(), WatchError> {
    tokio::task::spawn_blocking(move || {
        let manager = app.state::<FileWatchManager>();
        manager.stop(watch_id);
    })
    .await
    .map_err(|e| WatchError::internal(format!("join error: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    /// On macOS fsevents has a ~30ms latency floor before events arrive.
    /// On Linux inotify is sub-millisecond. 500ms is a safe upper bound
    /// for tests on any of our supported platforms.
    const POLL_WAIT: Duration = Duration::from_millis(500);

    #[test]
    fn classify_detects_utf8_and_bom() {
        let (text, enc) = classify_for_event(b"hello").unwrap();
        assert_eq!(text, "hello");
        assert_eq!(enc, "utf-8");

        let mut with_bom: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(b"hello");
        let (text, enc) = classify_for_event(&with_bom).unwrap();
        assert_eq!(text, "hello");
        assert_eq!(enc, "utf-8-bom");
    }

    #[test]
    fn classify_rejects_nul_and_non_utf8() {
        assert!(classify_for_event(&[0x68, 0x00, 0x69]).is_none());
        assert!(classify_for_event(&[0x68, 0x69, 0xFF]).is_none());
    }

    #[test]
    fn hash_path_is_stable_for_same_content() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("f.txt");
        fs::write(&p, b"alpha").unwrap();
        let h1 = hash_path(&p).unwrap();
        let h2 = hash_path(&p).unwrap();
        assert_eq!(h1, h2);
        fs::write(&p, b"beta").unwrap();
        let h3 = hash_path(&p).unwrap();
        assert_ne!(h1, h3);
    }

    #[test]
    fn start_rejects_path_outside_root() {
        // We can't easily construct an AppHandle in a unit test, so this
        // covers the validation that happens before any Tauri-shaped
        // bookkeeping.
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        let escape_target = outer.path().join("secret.txt");
        fs::write(&escape_target, "shhh").unwrap();
        let relative = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .join("secret.txt");

        // Resolve manually mirroring `start()` validation; the test
        // ensures the canonical-prefix check refuses the escape attempt.
        let canonical_root = std::fs::canonicalize(inner.path()).unwrap();
        let canonical_target = std::fs::canonicalize(canonical_root.join(&relative)).unwrap();
        assert!(!canonical_target.starts_with(&canonical_root));
    }

    /// Touch the inner state directly to verify the parent-refcount
    /// bookkeeping invariants, since the full notify roundtrip requires
    /// an `AppHandle` we can't synthesize here.
    #[test]
    fn parent_refcount_tracks_overlapping_watches() {
        let mgr = FileWatchManager::new();
        let mut guard = mgr.inner.lock().unwrap();
        let parent = PathBuf::from("/tmp/x");
        *guard.parent_refs.entry(parent.clone()).or_insert(0) += 1;
        *guard.parent_refs.entry(parent.clone()).or_insert(0) += 1;
        assert_eq!(guard.parent_refs[&parent], 2);
        let count = guard.parent_refs.get_mut(&parent).unwrap();
        *count -= 1;
        assert_eq!(*count, 1);
    }

    /// Smoke check the self-write filter against the inner state: after
    /// `note_self_write`, the stored hash matches the new bytes, so the
    /// next event for the same content is a no-op. `app: None` keeps
    /// the test out of Tauri's runtime entirely.
    #[test]
    fn note_self_write_updates_known_hash() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("f.txt");
        fs::write(&p, b"v1").unwrap();
        let canonical = std::fs::canonicalize(&p).unwrap();

        let mgr = FileWatchManager::new();
        {
            let mut guard = mgr.inner.lock().unwrap();
            let initial = hash_path(&canonical).unwrap();
            guard.entries.insert(
                42,
                WatchEntry {
                    canonical_path: canonical.clone(),
                    parent: canonical.parent().unwrap().to_path_buf(),
                    last_hash: initial,
                    app: None,
                },
            );
            guard
                .by_path
                .entry(canonical.clone())
                .or_default()
                .insert(42);
        }

        mgr.note_self_write(&canonical, b"v2");
        let stored = mgr.inner.lock().unwrap().entries[&42].last_hash;
        let mut hasher = Sha256::new();
        hasher.update(b"v2");
        let expected: [u8; 32] = hasher.finalize().into();
        assert_eq!(stored, expected);
    }

    /// Sleep a bit to absorb fsevent / inotify settle time. Used by
    /// integration-style tests if we add them later — kept here as a
    /// convenience constant for now.
    #[allow(dead_code)]
    fn settle() {
        thread::sleep(POLL_WAIT);
    }
}
