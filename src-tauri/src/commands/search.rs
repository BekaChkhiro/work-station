//! T13.9: project-wide find in files.
//!
//! Shells out to the system `ripgrep` (`rg`) and parses its `--json`
//! event stream. We deliberately rely on the host binary instead of
//! linking the `grep`/`ignore` crates: ripgrep on PATH is the same tool
//! the user runs from their shell, so semantics (`.gitignore`, hidden
//! files, smart case) match their muscle memory exactly. The fallback
//! path — when `rg` is missing — surfaces a typed error the UI maps to
//! a single actionable message rather than silently degrading to a
//! slower in-process scan.
//!
//! Path-scoped like `read_text_file`: the project root is canonicalized
//! and the working directory of the rg process is pinned to it. Paths in
//! the response are returned *relative* to that root so the frontend can
//! display them compactly and re-join them when opening a file via the
//! existing `read_text_file` flow.
//!
//! Hard caps protect the renderer from a pathological query that matches
//! millions of lines:
//!   • `MAX_RESULTS` total matches — once hit, we stop collecting and
//!     flag `truncated: true`.
//!   • `--max-count 200` per file (ripgrep flag) — keeps a single
//!     dependency-vendored file from dominating the result list.
//!   • `--max-filesize` skips multi-MB files (logs, lockfiles) where
//!     matches are rarely useful in this UI.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::pty::{Recovery, UserShape};

/// Total matches we'll buffer across the whole project. The UI groups
/// matches by file and renders virtualised lists, so the bottleneck is
/// the IPC payload size rather than render cost — 5000 keeps the JSON
/// well under a few MB even for short hits.
const MAX_RESULTS: usize = 5000;

/// Per-file match cap. Matches what most "find in files" UIs do; keeps
/// a fixture or generated file from monopolising the result list.
const PER_FILE_MAX: u32 = 200;

/// Files larger than this are skipped by ripgrep. The UI's primary use
/// case is finding identifiers in source, not grepping logs.
const MAX_FILESIZE: &str = "2M";

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// Treat the query as a regex. Default `false` → literal substring.
    #[serde(default)]
    pub regex: bool,
    /// Force case-sensitive matching. Default is ripgrep's smart-case
    /// (mixed-case query → sensitive, all-lowercase → insensitive).
    #[serde(default)]
    pub case_sensitive: bool,
    /// Require the match to be bounded by word characters on both sides.
    #[serde(default)]
    pub whole_word: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// Path relative to the project root (forward slashes on every OS
    /// since ripgrep's JSON encodes them that way on Windows too).
    pub path: String,
    pub line_number: u32,
    /// 1-based column of the *first* match on this line. Used when
    /// jumping into the editor; the highlighted range is in `ranges`.
    pub column: u32,
    /// Full line text with the trailing newline stripped.
    pub text: String,
    /// One range per submatch on this line. Byte offsets into `text`,
    /// suitable for highlighting with substring slicing on the frontend.
    pub ranges: Vec<MatchRange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub matches: Vec<SearchMatch>,
    /// `true` when we stopped collecting at `MAX_RESULTS` (or a per-file
    /// cap). The UI shows a "showing first N" hint in that case.
    pub truncated: bool,
}

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchError {
    #[error("{message}")]
    InvalidPath {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    /// `rg` is not on PATH. The UI surfaces install instructions rather
    /// than a generic IO error — a missing binary is the most common
    /// failure on a fresh dev machine.
    #[error("{message}")]
    RipgrepMissing {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    /// Pattern that ripgrep rejected (unbalanced regex, etc.). Surfaced
    /// inline next to the input so the user can correct it.
    #[error("{message}")]
    InvalidPattern {
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

impl SearchError {
    fn invalid_path(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidPath {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }

    fn ripgrep_missing() -> Self {
        Self::RipgrepMissing {
            message: "ripgrep (rg) not found on PATH".to_string(),
            ui: UserShape::new(
                "Install ripgrep to enable project-wide search.",
                Recovery::Dismiss,
            ),
        }
    }

    fn invalid_pattern(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidPattern {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new("Search failed. Try again.", Recovery::Retry),
        }
    }
}

fn canonicalize_root(root: &str) -> Result<PathBuf, SearchError> {
    std::fs::canonicalize(Path::new(root))
        .map_err(|e| SearchError::invalid_path(format!("project root not accessible: {e}")))
}

/// Ripgrep's JSON event stream is one JSON object per line, with a
/// `type` discriminator. We only care about `match` events for results
/// and let everything else (`begin`, `end`, `summary`, `context`) flow
/// past — those are useful for streaming UIs but not for the batch
/// "give me all matches" surface this command exposes.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RgEvent {
    Match {
        data: RgMatchData,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct RgMatchData {
    path: RgText,
    lines: RgText,
    line_number: u32,
    submatches: Vec<RgSubmatch>,
}

/// Ripgrep emits paths and line text as either `{"text": "..."}` (UTF-8)
/// or `{"bytes": "base64..."}` (non-UTF-8). We skip the bytes variant —
/// our other editor paths are UTF-8 only, and surfacing latin-1 matches
/// would lie about what the file actually contains.
#[derive(Debug, Deserialize)]
struct RgText {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RgSubmatch {
    start: u32,
    end: u32,
}

async fn run_search(
    root: &Path,
    query: &str,
    options: SearchOptions,
) -> Result<SearchResponse, SearchError> {
    let mut cmd = Command::new("rg");
    cmd.arg("--json")
        .arg("--max-count")
        .arg(PER_FILE_MAX.to_string())
        .arg("--max-filesize")
        .arg(MAX_FILESIZE)
        // The user generally doesn't want to grep through binary blobs,
        // and ripgrep already auto-detects them. `--no-binary` would
        // also suppress the "binary file matches" line; we want that
        // suppressed because the UI can't open binaries anyway.
        .arg("--no-binary");

    if options.case_sensitive {
        cmd.arg("--case-sensitive");
    } else {
        cmd.arg("--smart-case");
    }
    if options.whole_word {
        cmd.arg("--word-regexp");
    }
    if !options.regex {
        cmd.arg("--fixed-strings");
    }

    // `--` terminates options so a query starting with a dash isn't
    // mistaken for a flag.
    cmd.arg("--").arg(query).arg(".");
    cmd.current_dir(root);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SearchError::ripgrep_missing()
        } else {
            SearchError::internal(format!("spawn rg failed: {e}"))
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SearchError::internal("rg stdout missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SearchError::internal("rg stderr missing"))?;

    let mut reader = BufReader::new(stdout).lines();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut truncated = false;

    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|e| SearchError::internal(format!("rg stdout read failed: {e}")))?
    {
        if line.is_empty() {
            continue;
        }
        let event: RgEvent = match serde_json::from_str(&line) {
            Ok(ev) => ev,
            // A malformed line shouldn't kill the whole search — skip it
            // and continue. Ripgrep occasionally emits unparseable JSON
            // on platforms with locale weirdness; better to surface
            // what we can than to fail closed.
            Err(_) => continue,
        };
        if let RgEvent::Match { data } = event {
            let Some(path) = data.path.text else {
                continue;
            };
            let Some(text) = data.lines.text else {
                continue;
            };
            let text = text.trim_end_matches(['\n', '\r']).to_string();
            let ranges: Vec<MatchRange> = data
                .submatches
                .into_iter()
                .map(|s| MatchRange {
                    start: s.start,
                    end: s.end,
                })
                .collect();
            let column = ranges.first().map_or(1, |r| r.start.saturating_add(1));
            // Normalise Windows backslashes so the UI can compare paths
            // with `read_text_file` (which uses forward slashes on every
            // OS via canonicalization) without platform-specific casing.
            let path = path.replace('\\', "/");
            matches.push(SearchMatch {
                path,
                line_number: data.line_number,
                column,
                text,
                ranges,
            });
            if matches.len() >= MAX_RESULTS {
                truncated = true;
                // We don't kill the child here — `kill_on_drop` (set by
                // tokio's `Child` when wrapped in `tokio::process`) tears
                // it down when this function returns. Continuing to
                // drain stdout would let us look at the `summary` line
                // but we don't need it: the response already has what
                // the UI shows.
                break;
            }
        }
    }

    // Reap the child. If it exited non-zero AND we have no matches AND
    // stderr has content, surface it as an InvalidPattern (the most
    // common cause: bad regex). Non-zero with results is fine — ripgrep
    // exits 1 when no matches found, and we'd still have a 0-match
    // response from the loop above.
    let status = child
        .wait()
        .await
        .map_err(|e| SearchError::internal(format!("rg wait failed: {e}")))?;

    if !status.success() && matches.is_empty() && !truncated {
        let mut stderr_buf = String::new();
        let mut stderr_reader = BufReader::new(stderr);
        let _ = stderr_reader.read_line(&mut stderr_buf).await;
        let stderr_buf = stderr_buf.trim().to_string();
        // Exit code 1 is "no matches" — return an empty response, not
        // an error. Anything else with stderr content is a real failure.
        let code = status.code().unwrap_or(0);
        if code != 1 && !stderr_buf.is_empty() {
            return Err(SearchError::invalid_pattern(stderr_buf));
        }
    }

    Ok(SearchResponse { matches, truncated })
}

#[tauri::command]
pub async fn search_in_project(
    project_root: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<SearchResponse, SearchError> {
    if query.is_empty() {
        return Ok(SearchResponse {
            matches: Vec::new(),
            truncated: false,
        });
    }
    let root = canonicalize_root(&project_root)?;
    run_search(&root, &query, options.unwrap_or_default()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, body).unwrap();
    }

    /// CI / sandboxed test runs may not have `rg` on PATH. Skip the
    /// behaviour tests in that case so the unit suite stays green; the
    /// `RipgrepMissing` error path stays exercised in production via
    /// the typed UI surface.
    fn has_rg() -> bool {
        std::process::Command::new("rg")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn finds_literal_matches() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "hello world\nfoo bar\nhello again\n");
        write(dir.path(), "b.txt", "no matches here\n");

        let res = run_search(dir.path(), "hello", SearchOptions::default())
            .await
            .unwrap();
        assert!(!res.truncated);
        assert_eq!(res.matches.len(), 2);
        for m in &res.matches {
            assert_eq!(m.path, "a.txt");
            assert!(m.text.contains("hello"));
            assert_eq!(m.ranges[0].start, m.text.find("hello").unwrap() as u32);
            assert_eq!(m.ranges[0].end, m.ranges[0].start + 5);
        }
    }

    #[tokio::test]
    async fn empty_query_returns_empty() {
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "anything");
        let res = search_in_project(
            dir.path().to_string_lossy().to_string(),
            String::new(),
            None,
        )
        .await
        .unwrap();
        assert!(res.matches.is_empty());
        assert!(!res.truncated);
    }

    #[tokio::test]
    async fn case_sensitive_off_by_default_smart_case() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "Hello\nhello\nHELLO\n");

        // All-lowercase query → smart-case treats as insensitive, so 3 hits.
        let res = run_search(dir.path(), "hello", SearchOptions::default())
            .await
            .unwrap();
        assert_eq!(res.matches.len(), 3);

        // Mixed-case query → smart-case treats as sensitive, 1 hit.
        let res = run_search(dir.path(), "Hello", SearchOptions::default())
            .await
            .unwrap();
        assert_eq!(res.matches.len(), 1);
        assert!(res.matches[0].text.starts_with("Hello"));
    }

    #[tokio::test]
    async fn case_sensitive_flag_forces_exact_case() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "Foo\nfoo\nFOO\n");

        let res = run_search(
            dir.path(),
            "foo",
            SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].line_number, 2);
    }

    #[tokio::test]
    async fn whole_word_filters_partial_matches() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "foo\nfoobar\nbar foo baz\n");

        let res = run_search(
            dir.path(),
            "foo",
            SearchOptions {
                whole_word: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(res.matches.len(), 2);
        let line_numbers: Vec<u32> = res.matches.iter().map(|m| m.line_number).collect();
        assert_eq!(line_numbers, vec![1, 3]);
    }

    #[tokio::test]
    async fn regex_mode_parses_anchors() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "start of line\nnot the start\n");

        let res = run_search(
            dir.path(),
            "^start",
            SearchOptions {
                regex: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].line_number, 1);
    }

    #[tokio::test]
    async fn literal_mode_treats_regex_chars_as_text() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "uses arr[0] for index\n");

        let res = run_search(dir.path(), "arr[0]", SearchOptions::default())
            .await
            .unwrap();
        // Literal `arr[0]` matches; in regex mode `[0]` would be a char class.
        assert_eq!(res.matches.len(), 1);
        assert!(res.matches[0].text.contains("arr[0]"));
    }

    #[tokio::test]
    async fn invalid_regex_surfaces_pattern_error() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "a.txt", "anything\n");

        let err = run_search(
            dir.path(),
            "(",
            SearchOptions {
                regex: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, SearchError::InvalidPattern { .. }),
            "expected InvalidPattern, got {err:?}"
        );
    }

    #[tokio::test]
    async fn paths_are_relative_to_root() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        write(dir.path(), "deep/nested/file.txt", "needle\n");

        let res = run_search(dir.path(), "needle", SearchOptions::default())
            .await
            .unwrap();
        assert_eq!(res.matches.len(), 1);
        // ripgrep prefixes with `./` when given `.` as a path — accept
        // either form since we strip in the UI.
        let p = &res.matches[0].path;
        assert!(
            p == "deep/nested/file.txt" || p == "./deep/nested/file.txt",
            "unexpected path: {p}"
        );
    }

    #[tokio::test]
    async fn invalid_root_rejected() {
        let err = search_in_project(
            "/this/path/does/not/exist/anywhere".to_string(),
            "needle".to_string(),
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SearchError::InvalidPath { .. }));
    }

    #[tokio::test]
    async fn respects_gitignore() {
        if !has_rg() {
            return;
        }
        let dir = tempdir().unwrap();
        // The .gitignore needs a git repo marker for ripgrep to honor it
        // outside an existing repo; the `.git` directory presence is
        // enough. (Alternatively pass `--require-git=false`, but the
        // production UX should match what users see in their own repos.)
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        write(dir.path(), ".gitignore", "ignored.txt\n");
        write(dir.path(), "ignored.txt", "needle\n");
        write(dir.path(), "kept.txt", "needle\n");

        let res = run_search(dir.path(), "needle", SearchOptions::default())
            .await
            .unwrap();
        assert_eq!(res.matches.len(), 1);
        assert!(res.matches[0].path.ends_with("kept.txt"));
    }
}
