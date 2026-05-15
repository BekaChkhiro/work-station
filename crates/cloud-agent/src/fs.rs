// T19.27 prose touches `SQLite`, `PWA`, `UTF-8` etc. — backticking
// each mention hurts readability. Match the rest of the cloud-agent
// modules and disable doc_markdown at the module level.
#![allow(clippy::doc_markdown)]

//! Filesystem operations exposed over the cloud-agent's WebSocket
//! (T19.27).
//!
//! Each operation is anchored to a project root sourced from the
//! cloud-agent's SQLite (`projects.path`). The root is canonicalised
//! once, the requested relative path is joined and canonicalised
//! again, and the result must still live inside the root — otherwise
//! the call is rejected with [`FsError::OutOfScope`]. This is the
//! single chokepoint protecting the VPS filesystem from a hostile or
//! buggy client, so the path-jail check stays here rather than in any
//! per-feature module that might forget to call it.
//!
//! Behaviour mirrors the desktop's `src-tauri/src/commands/{files,fs}.rs`
//! commands so a PWA / desktop client can share a single parser:
//!   * `list_dir` returns folder-first then case-insensitive
//!     alphabetical entries; with `respect_gitignore: true` the
//!     hardcoded NOISE_DIRS set is filtered out.
//!   * `read_file` strips a UTF-8 BOM, sniffs the first 8 KiB for a
//!     NUL byte, then validates UTF-8 — so a PNG never reaches the
//!     editor as garbage.
//!   * `write_file` is atomic on POSIX (sibling temp + rename), and
//!     re-applies the BOM the reader stripped when the client passes
//!     `utf-8-bom`.
//!   * `delete_file` refuses directories — the PWA never needs to
//!     remove whole trees and the surface stays narrow.

use std::path::{Path, PathBuf};

use workstation_core::ws::protocol::{FsEntry, FsReadOutcome};

/// Hard ceiling on file size for reads / writes. Matches the desktop's
/// `commands::files::MAX_BYTES` (10 MiB) so the PWA sees the same
/// boundary regardless of backend. Larger files are surfaced as
/// `too_large` rather than silently truncated.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Window we inspect to decide text-vs-binary. Big enough that the
/// NUL byte in a typical PNG/PDF/elf header is always seen; small
/// enough that the heuristic is O(1) regardless of file size.
const SNIFF_WINDOW: usize = 8 * 1024;

/// Directories filtered when `respect_gitignore: true`. Same set the
/// desktop's `fs_list_dir` uses — chosen for high-noise directories
/// that dominate any unfiltered listing and crowd out the entries the
/// user actually wants to click on. Proper `.gitignore` parsing is
/// deferred to the same future work the desktop is waiting on (T13.9).
const NOISE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".vite",
];

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    /// Path resolves outside the project root — the only guard
    /// between a compromised client and arbitrary VPS files via this
    /// bridge. Treat as security-critical.
    #[error("path escapes project root: {0}")]
    OutOfScope(String),
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("path is not a directory: {0}")]
    NotADirectory(String),
    #[error("path is not a regular file: {0}")]
    NotAFile(String),
    #[error("file too large: {size} bytes (limit {limit})")]
    TooLarge { size: u64, limit: u64 },
    #[error("io error: {0}")]
    Io(String),
}

impl FsError {
    /// Stable `snake_case` discriminator for the wire-side `Error.kind`.
    /// The PWA branches on this; `NotAFile` collapses into
    /// `invalid_path` because the desktop's `read_text_file` already
    /// uses that kind for the same condition.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::OutOfScope(_) => "out_of_scope",
            Self::NotFound(_) => "not_found",
            Self::InvalidPath(_) | Self::NotAFile(_) => "invalid_path",
            Self::NotADirectory(_) => "not_a_directory",
            Self::TooLarge { .. } => "too_large",
            Self::Io(_) => "internal",
        }
    }
}

/// Canonicalise `root` + `relative`, then verify the result lives
/// under `root`. The root must already exist on disk; the target may
/// not (callers like `write_file` need to handle missing-target
/// themselves so a "create new file" path can land at a non-existent
/// canonical destination).
///
/// Both ends are canonicalised so a symlink in either path can't be
/// used to walk out of the project. `must_exist: false` falls back to
/// resolving the parent directory and re-joining the final name when
/// the full path doesn't exist yet — keeping the jail honest for
/// creation flows without re-implementing canonicalisation by hand.
fn resolve_in_root(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, FsError> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err(FsError::InvalidPath(
            "relative path must not be absolute".to_string(),
        ));
    }

    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| FsError::InvalidPath(format!("project root not accessible: {e}")))?;

    let joined = if relative.is_empty() {
        canonical_root.clone()
    } else {
        canonical_root.join(relative_path)
    };

    let canonical_target = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if must_exist {
                return Err(FsError::NotFound(joined.display().to_string()));
            }
            // For create flows: canonicalise the parent (which must
            // exist) and re-join the final component. The jail check
            // below still rejects parent-traversing escapes because
            // the parent's canonical form is what we anchor on.
            let parent = joined.parent().ok_or_else(|| {
                FsError::InvalidPath("cannot resolve parent directory".to_string())
            })?;
            let file_name = joined.file_name().ok_or_else(|| {
                FsError::InvalidPath("path has no filename component".to_string())
            })?;
            let canonical_parent = std::fs::canonicalize(parent).map_err(|e2| {
                if e2.kind() == std::io::ErrorKind::NotFound {
                    FsError::NotFound(parent.display().to_string())
                } else {
                    FsError::InvalidPath(format!("cannot resolve parent: {e2}"))
                }
            })?;
            canonical_parent.join(file_name)
        }
        Err(e) => return Err(FsError::InvalidPath(format!("cannot resolve: {e}"))),
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err(FsError::OutOfScope(format!(
            "{} escapes {}",
            canonical_target.display(),
            canonical_root.display(),
        )));
    }

    Ok(canonical_target)
}

/// Compute the relative form of `target` against `root` (both already
/// canonical). Returns "" when `target == root`. Falls back to the
/// final path component when `target` lacks `root` as a prefix —
/// which would only happen if `resolve_in_root` was bypassed, so the
/// fallback exists for safety, not correctness.
fn relative_to_root(root: &Path, target: &Path) -> String {
    target.strip_prefix(root).ok().map_or_else(
        || {
            target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        },
        |p| p.to_string_lossy().into_owned(),
    )
}

pub fn list_dir(
    project_root: &Path,
    relative: &str,
    respect_gitignore: bool,
) -> Result<Vec<FsEntry>, FsError> {
    let target = resolve_in_root(project_root, relative, true)?;
    let canonical_root = std::fs::canonicalize(project_root)
        .map_err(|e| FsError::InvalidPath(format!("project root not accessible: {e}")))?;

    let meta = std::fs::metadata(&target).map_err(|e| FsError::Io(format!("stat failed: {e}")))?;
    if !meta.is_dir() {
        return Err(FsError::NotADirectory(target.display().to_string()));
    }

    let mut out = Vec::new();
    let read_dir = std::fs::read_dir(&target).map_err(|e| FsError::Io(format!("read_dir: {e}")))?;
    for entry in read_dir {
        let entry = entry.map_err(|e| FsError::Io(format!("read_dir entry: {e}")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // `file_type()` is one stat call; `metadata()` would follow
        // symlinks and double the syscalls per entry. Symlinked-to-dir
        // surfaces as a file so the tree never recurses blindly into
        // a self-referential link.
        let file_type = entry.file_type().ok();
        let is_dir = file_type.as_ref().is_some_and(std::fs::FileType::is_dir);
        if respect_gitignore && is_dir && NOISE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let relative_path = relative_to_root(&canonical_root, &full);
        out.push(FsEntry {
            name,
            relative_path,
            is_dir,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

pub fn read_file(project_root: &Path, relative: &str) -> Result<FsReadOutcome, FsError> {
    let target = resolve_in_root(project_root, relative, true)?;
    let meta = std::fs::metadata(&target).map_err(|e| FsError::Io(format!("stat failed: {e}")))?;
    if !meta.is_file() {
        return Err(FsError::NotAFile(target.display().to_string()));
    }
    if meta.len() > MAX_BYTES {
        return Err(FsError::TooLarge {
            size: meta.len(),
            limit: MAX_BYTES,
        });
    }
    let bytes = std::fs::read(&target).map_err(|e| FsError::Io(format!("read failed: {e}")))?;
    Ok(classify(&bytes))
}

pub fn write_file(
    project_root: &Path,
    relative: &str,
    content: &str,
    encoding: &str,
) -> Result<(), FsError> {
    let target = resolve_in_root(project_root, relative, false)?;

    // Reject directories explicitly. A target that doesn't exist yet
    // is fine (create flow); one that exists must be a regular file
    // — otherwise the rename below would clobber a directory entry on
    // some platforms.
    if let Ok(meta) = std::fs::metadata(&target) {
        if !meta.is_file() {
            return Err(FsError::NotAFile(target.display().to_string()));
        }
    }

    let mut bytes: Vec<u8> = Vec::with_capacity(content.len() + 3);
    if encoding.eq_ignore_ascii_case("utf-8-bom") {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(content.as_bytes());

    if bytes.len() as u64 > MAX_BYTES {
        return Err(FsError::TooLarge {
            size: bytes.len() as u64,
            limit: MAX_BYTES,
        });
    }

    // Atomic write: a sibling temp file in the same directory keeps
    // the rename on the same filesystem, then `rename` swaps it in.
    // A crash between `write` and `rename` leaves the original file
    // untouched. PID + nanos in the suffix avoids clashes when two
    // saves race on the same file.
    let parent = target
        .parent()
        .ok_or_else(|| FsError::InvalidPath("cannot resolve parent of target".to_string()))?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FsError::InvalidPath("target has no filename component".to_string()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let pid = std::process::id();
    let tmp = parent.join(format!(".{file_name}.tmp.{pid}.{nanos}"));

    if let Err(e) = std::fs::write(&tmp, &bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FsError::Io(format!("write failed: {e}")));
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FsError::Io(format!("rename failed: {e}")));
    }
    Ok(())
}

pub fn delete_file(project_root: &Path, relative: &str) -> Result<(), FsError> {
    let target = resolve_in_root(project_root, relative, true)?;
    let meta = std::fs::metadata(&target).map_err(|e| FsError::Io(format!("stat failed: {e}")))?;
    if !meta.is_file() {
        return Err(FsError::NotAFile(target.display().to_string()));
    }
    std::fs::remove_file(&target).map_err(|e| FsError::Io(format!("remove failed: {e}")))
}

/// Strip a UTF-8 BOM if present. Returns `(stripped, had_bom)`.
fn strip_utf8_bom(bytes: &[u8]) -> (&[u8], bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (&bytes[3..], true)
    } else {
        (bytes, false)
    }
}

/// Decide whether the file looks like UTF-8 text. NUL-byte sniff
/// first (catches binary formats with valid UTF-8 elsewhere — e.g.
/// PNG IDAT chunks), then full UTF-8 validation on the body.
fn classify(bytes: &[u8]) -> FsReadOutcome {
    let (body, had_bom) = strip_utf8_bom(bytes);
    let window_end = body.len().min(SNIFF_WINDOW);
    if body[..window_end].contains(&0) {
        return FsReadOutcome::Binary {
            reason: "nul-byte".to_string(),
        };
    }
    match std::str::from_utf8(body) {
        Ok(s) => FsReadOutcome::Text {
            content: s.to_owned(),
            encoding: if had_bom {
                "utf-8-bom".to_string()
            } else {
                "utf-8".to_string()
            },
        },
        Err(_) => FsReadOutcome::Binary {
            reason: "not-utf-8".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write as _;
    use tempfile::tempdir;

    #[test]
    fn list_dir_returns_folder_first_sorted_entries() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("zeta")).unwrap();
        fs::write(dir.path().join("alpha.txt"), b"a").unwrap();
        fs::write(dir.path().join("Beta.txt"), b"b").unwrap();
        fs::create_dir(dir.path().join("apex")).unwrap();

        let entries = list_dir(dir.path(), "", true).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["apex", "zeta", "alpha.txt", "Beta.txt"]);
    }

    #[test]
    fn list_dir_filters_noise_dirs_when_respecting_gitignore() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("README.md"), b"r").unwrap();

        let filtered = list_dir(dir.path(), "", true).unwrap();
        let names: Vec<_> = filtered.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);

        let unfiltered = list_dir(dir.path(), "", false).unwrap();
        let names: Vec<_> = unfiltered.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"node_modules"), "got {names:?}");
        assert!(names.contains(&".git"), "got {names:?}");
    }

    #[test]
    fn list_dir_returns_relative_paths_under_root() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub").join("inner.txt"), b"x").unwrap();

        let entries = list_dir(dir.path(), "sub", true).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "inner.txt");
        // `relative_path` is from the project root, not the listed
        // dir — so the PWA can chain `fs_read` with it directly.
        assert!(
            entries[0].relative_path == "sub/inner.txt"
                || entries[0].relative_path == "sub\\inner.txt",
            "got {}",
            entries[0].relative_path,
        );
    }

    #[test]
    fn list_dir_rejects_path_outside_root() {
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        fs::write(outer.path().join("secret.txt"), b"shhh").unwrap();
        let escape = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .into_os_string()
            .into_string()
            .unwrap();
        let err = list_dir(inner.path(), &escape, true).unwrap_err();
        assert!(
            matches!(err, FsError::OutOfScope(_)),
            "expected OutOfScope, got {err:?}",
        );
    }

    #[test]
    fn list_dir_rejects_absolute_relative_path() {
        let dir = tempdir().unwrap();
        let err = list_dir(dir.path(), "/etc", true).unwrap_err();
        assert!(matches!(err, FsError::InvalidPath(_)));
    }

    #[test]
    fn list_dir_rejects_non_directory_target() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), b"x").unwrap();
        let err = list_dir(dir.path(), "file.txt", true).unwrap_err();
        assert!(matches!(err, FsError::NotADirectory(_)));
    }

    #[test]
    fn read_file_returns_utf8_text() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hello.txt"), "hello\n").unwrap();
        match read_file(dir.path(), "hello.txt").unwrap() {
            FsReadOutcome::Text { content, encoding } => {
                assert_eq!(content, "hello\n");
                assert_eq!(encoding, "utf-8");
            }
            FsReadOutcome::Binary { reason } => panic!("expected text, got binary ({reason})"),
        }
    }

    #[test]
    fn read_file_strips_and_reports_bom() {
        let dir = tempdir().unwrap();
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"with bom\n");
        fs::write(dir.path().join("bom.txt"), &bytes).unwrap();
        match read_file(dir.path(), "bom.txt").unwrap() {
            FsReadOutcome::Text { content, encoding } => {
                assert_eq!(content, "with bom\n");
                assert_eq!(encoding, "utf-8-bom");
            }
            FsReadOutcome::Binary { reason } => panic!("expected text, got binary ({reason})"),
        }
    }

    #[test]
    fn read_file_detects_binary_nul_byte() {
        let dir = tempdir().unwrap();
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00];
        fs::write(dir.path().join("blob.png"), png).unwrap();
        match read_file(dir.path(), "blob.png").unwrap() {
            FsReadOutcome::Binary { reason } => assert_eq!(reason, "nul-byte"),
            FsReadOutcome::Text { .. } => panic!("expected binary, got text"),
        }
    }

    #[test]
    fn read_file_detects_invalid_utf8() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("latin.txt"), [0x68, 0x69, 0xFF, 0xFE_u8]).unwrap();
        match read_file(dir.path(), "latin.txt").unwrap() {
            FsReadOutcome::Binary { reason } => assert_eq!(reason, "not-utf-8"),
            FsReadOutcome::Text { .. } => panic!("expected binary, got text"),
        }
    }

    #[test]
    fn read_file_rejects_too_large() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.bin");
        // Avoid actually allocating MAX_BYTES — instead lie via a
        // smaller cap by writing one byte past MAX_BYTES is wasteful
        // here, so check the boundary via metadata: create a file
        // exactly at MAX_BYTES + 1.
        let mut f = fs::File::create(&path).unwrap();
        let size = usize::try_from(MAX_BYTES + 1).expect("size fits in usize");
        f.write_all(&vec![b'a'; size]).unwrap();
        drop(f);
        let err = read_file(dir.path(), "big.bin").unwrap_err();
        assert!(matches!(err, FsError::TooLarge { .. }), "got {err:?}");
    }

    #[test]
    fn read_file_rejects_path_outside_root() {
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        fs::write(outer.path().join("secret.txt"), b"shhh").unwrap();
        let relative = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .join("secret.txt")
            .into_os_string()
            .into_string()
            .unwrap();
        let err = read_file(inner.path(), &relative).unwrap_err();
        assert!(matches!(err, FsError::OutOfScope(_)), "got {err:?}");
    }

    #[test]
    fn read_file_missing_returns_not_found() {
        let dir = tempdir().unwrap();
        let err = read_file(dir.path(), "missing.txt").unwrap_err();
        assert!(matches!(err, FsError::NotFound(_)), "got {err:?}");
    }

    #[test]
    fn write_file_creates_new_file_in_root() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "new.txt", "content\n", "utf-8").unwrap();
        let on_disk = fs::read_to_string(dir.path().join("new.txt")).unwrap();
        assert_eq!(on_disk, "content\n");
    }

    #[test]
    fn write_file_overwrites_existing_file_atomically() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "before").unwrap();
        write_file(dir.path(), "file.txt", "after", "utf-8").unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "after");
        let leftover = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with(".file.txt.tmp."))
            });
        assert!(!leftover, "temp file should be renamed away on success");
    }

    #[test]
    fn write_file_reapplies_bom_when_requested() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "bom.txt", "hi\n", "utf-8-bom").unwrap();
        let on_disk = fs::read(dir.path().join("bom.txt")).unwrap();
        let expected: Vec<u8> = [0xEF, 0xBB, 0xBF]
            .iter()
            .copied()
            .chain(b"hi\n".iter().copied())
            .collect();
        assert_eq!(on_disk, expected);
    }

    #[test]
    fn write_file_rejects_path_outside_root() {
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        fs::write(outer.path().join("victim.txt"), b"orig").unwrap();
        let relative = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .join("victim.txt")
            .into_os_string()
            .into_string()
            .unwrap();
        let err = write_file(inner.path(), &relative, "pwned", "utf-8").unwrap_err();
        assert!(matches!(err, FsError::OutOfScope(_)), "got {err:?}");
        // Victim must be untouched.
        assert_eq!(fs::read(outer.path().join("victim.txt")).unwrap(), b"orig");
    }

    #[test]
    fn write_file_rejects_directory_target() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let err = write_file(dir.path(), "sub", "data", "utf-8").unwrap_err();
        assert!(matches!(err, FsError::NotAFile(_)), "got {err:?}");
    }

    #[test]
    fn delete_file_removes_target() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("rm.txt");
        fs::write(&path, "x").unwrap();
        delete_file(dir.path(), "rm.txt").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_file_rejects_directory() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let err = delete_file(dir.path(), "sub").unwrap_err();
        assert!(matches!(err, FsError::NotAFile(_)), "got {err:?}");
    }

    #[test]
    fn delete_file_rejects_path_outside_root() {
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        let target = outer.path().join("secret.txt");
        fs::write(&target, "shhh").unwrap();
        let relative = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .join("secret.txt")
            .into_os_string()
            .into_string()
            .unwrap();
        let err = delete_file(inner.path(), &relative).unwrap_err();
        assert!(matches!(err, FsError::OutOfScope(_)), "got {err:?}");
        // Target must still exist.
        assert!(target.exists());
    }

    #[test]
    fn fserror_kind_maps_all_variants() {
        let pairs: Vec<(FsError, &str)> = vec![
            (FsError::OutOfScope("x".into()), "out_of_scope"),
            (FsError::NotFound("x".into()), "not_found"),
            (FsError::InvalidPath("x".into()), "invalid_path"),
            (FsError::NotAFile("x".into()), "invalid_path"),
            (FsError::NotADirectory("x".into()), "not_a_directory"),
            (
                FsError::TooLarge {
                    size: 1,
                    limit: MAX_BYTES,
                },
                "too_large",
            ),
            (FsError::Io("x".into()), "internal"),
        ];
        for (error, expected) in pairs {
            assert_eq!(error.kind(), expected, "{error:?}");
        }
    }
}
