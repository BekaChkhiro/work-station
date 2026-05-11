//! T13.3: read text files for the in-app Monaco editor.
//!
//! `read_text_file` is a path-scoped reader. The frontend supplies a
//! project root and a path relative to it; everything is canonicalized
//! and the resolved target must live inside the canonicalized root —
//! otherwise the call is rejected. This is the single chokepoint for
//! editor reads, so the project boundary is enforced here rather than
//! in capability JSON (which Tauri's FS plugin uses) — it gives us a
//! typed error the UI can render and lets us layer charset/binary
//! detection alongside the bounds check.
//!
//! Result shape:
//!   • Text  — UTF-8 (with or without BOM). BOM is stripped from the
//!             content; the encoding tag lets the save path round-trip
//!             it (T13.4).
//!   • Binary — file has a NUL byte in the first 8 KiB, or its bytes
//!              are not valid UTF-8. Surfaced to the UI as a "not a
//!              text file" placeholder instead of garbage in Monaco.

use std::path::{Path, PathBuf};

use serde::Serialize;
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

#[derive(Debug, Clone, Copy, Serialize)]
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
}
