//! T13.3 / T13.4: read and write text files for the in-app Monaco editor.
//!
//! Both `read_text_file` and `write_text_file` are path-scoped: the
//! frontend supplies a project root and a path relative to it; everything
//! is canonicalized and the resolved target must live inside the
//! canonicalized root — otherwise the call is rejected. This is the
//! single chokepoint for editor reads and writes, so the project
//! boundary is enforced here rather than in capability JSON (which
//! Tauri's FS plugin uses) — it gives us a typed error the UI can
//! render and lets us layer charset/binary detection alongside the
//! bounds check.
//!
//! Read result shape:
//!   • Text  — UTF-8 (with or without BOM). BOM is stripped from the
//!             content; the encoding tag lets the save path round-trip
//!             it (T13.4).
//!   • Binary — file has a NUL byte in the first 8 KiB, or its bytes
//!              are not valid UTF-8. Surfaced to the UI as a "not a
//!              text file" placeholder instead of garbage in Monaco.
//!
//! Write semantics (T13.4):
//!   • Target must already exist inside the project root — saving from
//!     the editor only happens after a successful read, so this keeps
//!     the surface narrow. File creation lives with a future "new file"
//!     flow, not the save path.
//!   • Atomic on POSIX: bytes are written to a sibling temp file and
//!     `rename`d into place, so a crash mid-write can't truncate an
//!     existing file. The encoding tag round-trips the BOM the reader
//!     stripped.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use thiserror::Error;

use crate::pty::{Recovery, UserShape};

/// Hard ceiling on file size. Monaco starts to choke well before this,
/// but the bound is mostly to keep accidental `read_text_file` calls
/// on multi-GB log files from OOM'ing the renderer. 10 MiB matches the
/// VS Code default for "large file" warnings.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Window we inspect to decide text-vs-binary. Big enough that the NUL
/// in a typical PNG/PDF/elf header is always seen; small enough that
/// the heuristic is O(1) regardless of file size.
const SNIFF_WINDOW: usize = 8 * 1024;

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReadResult {
    Text {
        content: String,
        encoding: TextEncoding,
    },
    Binary {
        reason: BinaryReason,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BinaryReason {
    /// NUL byte found inside the sniff window — almost certainly a
    /// binary format (image, executable, compiled artifact).
    NulByte,
    /// Bytes are not valid UTF-8 and there's no BOM that would tell us
    /// otherwise. Could be a legacy encoding (Latin-1, Shift-JIS); for
    /// now we surface as "not text" rather than guess wrong.
    NotUtf8,
}

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileError {
    /// Path resolves outside the project root, or contains components
    /// (`..`, symlinks) that escape it after canonicalization. This is
    /// the *only* guard against a compromised renderer reading
    /// arbitrary host files via this command — treat it as security-
    /// critical, not a UX hint.
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
    TooLarge {
        message: String,
        size: u64,
        limit: u64,
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

impl FileError {
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

    fn too_large(size: u64) -> Self {
        Self::TooLarge {
            message: format!("File is {size} bytes; limit is {MAX_BYTES}"),
            size,
            limit: MAX_BYTES,
            ui: UserShape::new(
                "File is too large to open in the editor.",
                Recovery::Dismiss,
            ),
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
            ui: UserShape::new("Could not read file. Try again.", Recovery::Retry),
        }
    }
}

/// Canonicalize `root` and `target`, then verify `target` lives under
/// `root`. Returns the canonical target on success.
///
/// Both ends are canonicalized so a symlink in either path can't be
/// used to walk out of the project. `Path::starts_with` works on the
/// canonical forms because they share a normalized prefix.
fn resolve_in_root(root: &Path, relative: &Path) -> Result<PathBuf, FileError> {
    if relative.is_absolute() {
        return Err(FileError::invalid_path(
            "relative path must not be absolute",
        ));
    }

    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| FileError::invalid_path(format!("project root not accessible: {e}")))?;

    let joined = canonical_root.join(relative);
    let canonical_target = std::fs::canonicalize(&joined).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileError::not_found(format!("file not found: {}", joined.display()))
        } else {
            FileError::invalid_path(format!("cannot resolve file: {e}"))
        }
    })?;

    if !canonical_target.starts_with(&canonical_root) {
        return Err(FileError::out_of_scope(format!(
            "{} escapes {}",
            canonical_target.display(),
            canonical_root.display()
        )));
    }

    Ok(canonical_target)
}

/// Strip a UTF-8 BOM if present. Returns `(stripped, had_bom)`.
fn strip_utf8_bom(bytes: &[u8]) -> (&[u8], bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (&bytes[3..], true)
    } else {
        (bytes, false)
    }
}

/// Decide whether the file looks like text we can safely hand to
/// Monaco. NUL-byte sniff first (catches binary formats with valid
/// UTF-8 elsewhere — e.g. PNG IDAT chunks), then full UTF-8 validation.
fn classify(bytes: &[u8]) -> Result<(String, TextEncoding), BinaryReason> {
    let (body, had_bom) = strip_utf8_bom(bytes);

    let window_end = body.len().min(SNIFF_WINDOW);
    if body[..window_end].contains(&0) {
        return Err(BinaryReason::NulByte);
    }

    match std::str::from_utf8(body) {
        Ok(s) => Ok((
            s.to_owned(),
            if had_bom {
                TextEncoding::Utf8Bom
            } else {
                TextEncoding::Utf8
            },
        )),
        Err(_) => Err(BinaryReason::NotUtf8),
    }
}

fn read_inner(project_root: &str, relative_path: &str) -> Result<ReadResult, FileError> {
    let target = resolve_in_root(Path::new(project_root), Path::new(relative_path))?;

    let meta =
        std::fs::metadata(&target).map_err(|e| FileError::internal(format!("stat failed: {e}")))?;
    if !meta.is_file() {
        return Err(FileError::invalid_path("path is not a regular file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(FileError::too_large(meta.len()));
    }

    let bytes =
        std::fs::read(&target).map_err(|e| FileError::internal(format!("read failed: {e}")))?;

    match classify(&bytes) {
        Ok((content, encoding)) => Ok(ReadResult::Text { content, encoding }),
        Err(reason) => Ok(ReadResult::Binary { reason }),
    }
}

#[tauri::command]
pub async fn read_text_file(
    project_root: String,
    relative_path: String,
) -> Result<ReadResult, FileError> {
    // Disk I/O on a blocking pool — same pattern as `pick_project_folder`.
    tokio::task::spawn_blocking(move || read_inner(&project_root, &relative_path))
        .await
        .map_err(|e| FileError::internal(format!("join error: {e}")))?
}

/// Writes the file and returns `(canonical_target, bytes_written)`. The
/// caller (`write_text_file`) hands the bytes to the watch manager so the
/// fs event generated by our own atomic rename is suppressed (T13.5).
/// Returning the bytes is cheaper than re-reading from disk and keeps
/// the hash exactly aligned with what we just persisted.
fn write_inner(
    project_root: &str,
    relative_path: &str,
    content: &str,
    encoding: TextEncoding,
) -> Result<(PathBuf, Vec<u8>), FileError> {
    let target = resolve_in_root(Path::new(project_root), Path::new(relative_path))?;

    let meta =
        std::fs::metadata(&target).map_err(|e| FileError::internal(format!("stat failed: {e}")))?;
    if !meta.is_file() {
        return Err(FileError::invalid_path("path is not a regular file"));
    }

    // Reapply the BOM the reader stripped so files round-trip byte-for-byte
    // for users on tools that look for it (Windows Notepad, some PowerShell
    // pipelines).
    let mut bytes: Vec<u8> = Vec::with_capacity(content.len() + 3);
    if matches!(encoding, TextEncoding::Utf8Bom) {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(content.as_bytes());

    if bytes.len() as u64 > MAX_BYTES {
        return Err(FileError::too_large(bytes.len() as u64));
    }

    // Atomic write: a sibling temp file in the same directory keeps the
    // rename on the same filesystem, then `rename` swaps it in. A crash
    // between `write` and `rename` leaves the original file untouched.
    // PID + nanos in the suffix avoids clashes when two saves race on the
    // same file (the second save's rename simply overwrites the first).
    let parent = target
        .parent()
        .ok_or_else(|| FileError::invalid_path("cannot resolve parent directory of target"))?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FileError::invalid_path("target path has no valid filename component"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let tmp = parent.join(format!(".{file_name}.tmp.{pid}.{nanos}"));

    if let Err(e) = std::fs::write(&tmp, &bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FileError::internal(format!("write failed: {e}")));
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FileError::internal(format!("rename failed: {e}")));
    }

    Ok((target, bytes))
}

#[tauri::command]
pub async fn write_text_file(
    app: tauri::AppHandle,
    project_root: String,
    relative_path: String,
    content: String,
    encoding: TextEncoding,
) -> Result<(), FileError> {
    let (canonical, bytes) = tokio::task::spawn_blocking(move || {
        write_inner(&project_root, &relative_path, &content, encoding)
    })
    .await
    .map_err(|e| FileError::internal(format!("join error: {e}")))??;

    // T13.5: tell the watch manager what we just wrote so the fs event
    // our own atomic rename triggers gets recognised as a self-write
    // and never reaches the conflict-prompt path in the UI.
    let manager = app.state::<crate::commands::watch::FileWatchManager>();
    manager.note_self_write(&canonical, &bytes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn reads_utf8_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        fs::write(&path, "hello, world\n").unwrap();

        let res = read_inner(dir.path().to_str().unwrap(), "hello.txt").unwrap();

        match res {
            ReadResult::Text { content, encoding } => {
                assert_eq!(content, "hello, world\n");
                assert!(matches!(encoding, TextEncoding::Utf8));
            }
            ReadResult::Binary { .. } => panic!("expected text"),
        }
    }

    #[test]
    fn strips_utf8_bom() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bom.txt");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"with bom\n");
        fs::write(&path, &bytes).unwrap();

        let res = read_inner(dir.path().to_str().unwrap(), "bom.txt").unwrap();
        match res {
            ReadResult::Text { content, encoding } => {
                assert_eq!(content, "with bom\n");
                assert!(matches!(encoding, TextEncoding::Utf8Bom));
            }
            ReadResult::Binary { .. } => panic!("expected text"),
        }
    }

    #[test]
    fn binary_nul_byte_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("blob.png");
        // PNG signature has a NUL in the first 8 bytes.
        let png_signature: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00];
        fs::write(&path, png_signature).unwrap();

        let res = read_inner(dir.path().to_str().unwrap(), "blob.png").unwrap();
        match res {
            ReadResult::Binary { reason } => {
                assert!(matches!(reason, BinaryReason::NulByte));
            }
            ReadResult::Text { .. } => panic!("expected binary"),
        }
    }

    #[test]
    fn binary_invalid_utf8_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("latin1.txt");
        // 0xFF is never valid as a UTF-8 start byte, and no NUL means
        // we exercise the str::from_utf8 branch rather than the sniff
        // shortcut.
        fs::write(&path, [0x68, 0x69, 0xFF, 0xFE_u8]).unwrap();

        let res = read_inner(dir.path().to_str().unwrap(), "latin1.txt").unwrap();
        match res {
            ReadResult::Binary { reason } => {
                assert!(matches!(reason, BinaryReason::NotUtf8));
            }
            ReadResult::Text { .. } => panic!("expected binary"),
        }
    }

    #[test]
    fn rejects_path_outside_root() {
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        let escape_target = outer.path().join("secret.txt");
        fs::write(&escape_target, "shhh").unwrap();

        // Build a relative path that walks out of `inner` into `outer`.
        // We use the parent .. dance because absolute paths are
        // rejected up-front by `resolve_in_root`.
        let relative = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .join("secret.txt");

        let err =
            read_inner(inner.path().to_str().unwrap(), relative.to_str().unwrap()).unwrap_err();

        assert!(
            matches!(err, FileError::OutOfScope { .. }),
            "expected OutOfScope, got {err:?}"
        );
    }

    #[test]
    fn rejects_absolute_relative_path() {
        let dir = tempdir().unwrap();
        let err = read_inner(dir.path().to_str().unwrap(), "/etc/passwd").unwrap_err();
        assert!(matches!(err, FileError::InvalidPath { .. }));
    }

    #[test]
    fn missing_file_returns_not_found() {
        let dir = tempdir().unwrap();
        let err = read_inner(dir.path().to_str().unwrap(), "nope.txt").unwrap_err();
        assert!(matches!(err, FileError::NotFound { .. }));
    }

    #[test]
    fn write_round_trips_utf8() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        fs::write(&path, "old\n").unwrap();

        write_inner(
            dir.path().to_str().unwrap(),
            "hello.txt",
            "fresh content\n",
            TextEncoding::Utf8,
        )
        .unwrap();

        let on_disk = fs::read(&path).unwrap();
        assert_eq!(on_disk, b"fresh content\n");
    }

    #[test]
    fn write_reapplies_bom() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bom.txt");
        fs::write(&path, "seed").unwrap();

        write_inner(
            dir.path().to_str().unwrap(),
            "bom.txt",
            "with bom\n",
            TextEncoding::Utf8Bom,
        )
        .unwrap();

        let on_disk = fs::read(&path).unwrap();
        let expected: Vec<u8> = [0xEF, 0xBB, 0xBF]
            .iter()
            .copied()
            .chain(b"with bom\n".iter().copied())
            .collect();
        assert_eq!(on_disk, expected);
    }

    #[test]
    fn write_rejects_path_outside_root() {
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        let escape_target = outer.path().join("secret.txt");
        fs::write(&escape_target, "shhh").unwrap();

        let relative = PathBuf::from("..")
            .join(outer.path().file_name().unwrap())
            .join("secret.txt");

        let err = write_inner(
            inner.path().to_str().unwrap(),
            relative.to_str().unwrap(),
            "pwned",
            TextEncoding::Utf8,
        )
        .unwrap_err();

        assert!(matches!(err, FileError::OutOfScope { .. }));
        // Original file must be untouched.
        assert_eq!(fs::read(&escape_target).unwrap(), b"shhh");
    }

    #[test]
    fn write_atomic_leaves_no_tmp_on_success() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "before").unwrap();

        write_inner(
            dir.path().to_str().unwrap(),
            "file.txt",
            "after",
            TextEncoding::Utf8,
        )
        .unwrap();

        let leftover = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with(".file.txt.tmp."))
                    .unwrap_or(false)
            });
        assert!(!leftover, "temp file should be renamed away on success");
    }
}
