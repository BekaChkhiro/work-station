//! Git working-tree commands for the Agent view's review panel (POC).
//!
//! Thin wrappers over the `git` CLI run in the project's cwd: status with
//! per-file add/remove counts, per-file unified diffs, and stage / unstage /
//! discard / commit actions. Output is structured so the Solid `GitReviewPanel`
//! can render a Codex-style change list and act on it.

use std::collections::HashMap;
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Run `git <args>` in `cwd`, returning stdout. Errors carry stderr so the UI
/// can surface "not a git repo" etc.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like [`run_git`] but tolerant of a non-zero exit (e.g. `git diff
/// --no-index` exits 1 when files differ) — returns stdout regardless.
fn run_git_lossy(cwd: &str, args: &[&str]) -> String {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Parse `git diff --numstat` output into `path -> (added, removed)`.
fn parse_numstat(text: &str) -> HashMap<String, (u32, u32)> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split('\t');
        let added = parts.next().unwrap_or("0");
        let removed = parts.next().unwrap_or("0");
        let Some(path) = parts.next() else { continue };
        // Binary files report "-" for counts.
        let a = added.parse::<u32>().unwrap_or(0);
        let d = removed.parse::<u32>().unwrap_or(0);
        map.insert(path.to_string(), (a, d));
    }
    map
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// True for an entry in the index (staged), false for the working tree.
    pub staged: bool,
    /// Single-letter porcelain status (`M`, `A`, `D`, `R`, `?` for untracked).
    pub status: String,
    pub adds: u32,
    pub dels: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub files: Vec<GitFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    pub cwd: String,
}

/// Working-tree status: current branch + one [`GitFile`] per staged/unstaged
/// change (a partially-staged file appears in both groups).
#[tauri::command]
pub async fn git_status(args: GitStatusArgs) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || status_inner(&args.cwd))
        .await
        .map_err(|e| format!("git status task join failed: {e}"))?
}

fn status_inner(cwd: &str) -> Result<GitStatus, String> {
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map_or_else(|_| "—".to_string(), |s| s.trim().to_string());
    let porcelain = run_git(cwd, &["status", "--porcelain"])?;
    let unstaged = parse_numstat(&run_git_lossy(cwd, &["diff", "--numstat"]));
    let staged = parse_numstat(&run_git_lossy(cwd, &["diff", "--cached", "--numstat"]));

    let mut files = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let bytes = line.as_bytes();
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let raw = &line[3..];
        // Renames render as "old -> new"; key on the new path.
        let path = raw
            .rsplit(" -> ")
            .next()
            .unwrap_or(raw)
            .trim_matches('"')
            .to_string();

        if index != ' ' && index != '?' {
            let (adds, dels) = staged.get(&path).copied().unwrap_or((0, 0));
            files.push(GitFile {
                path: path.clone(),
                staged: true,
                status: index.to_string(),
                adds,
                dels,
            });
        }
        if worktree != ' ' {
            let untracked = index == '?' && worktree == '?';
            let (adds, dels) = unstaged.get(&path).copied().unwrap_or((0, 0));
            files.push(GitFile {
                path,
                staged: false,
                status: if untracked {
                    "?".to_string()
                } else {
                    worktree.to_string()
                },
                adds,
                dels,
            });
        }
    }
    Ok(GitStatus { branch, files })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffArgs {
    pub cwd: String,
    pub path: String,
    pub staged: bool,
}

/// Unified diff for one file. Falls back to `--no-index` so brand-new
/// untracked files still render as an all-added diff.
#[tauri::command]
pub async fn git_diff_file(args: GitDiffArgs) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if args.staged {
            return run_git(&args.cwd, &["diff", "--cached", "--", &args.path]);
        }
        let tracked = run_git_lossy(&args.cwd, &["diff", "--", &args.path]);
        if tracked.trim().is_empty() {
            Ok(run_git_lossy(
                &args.cwd,
                &["diff", "--no-index", "--", "/dev/null", &args.path],
            ))
        } else {
            Ok(tracked)
        }
    })
    .await
    .map_err(|e| format!("git diff task join failed: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathArgs {
    pub cwd: String,
    pub path: String,
}

/// `git add -- <path>`.
#[tauri::command]
pub async fn git_stage(args: GitPathArgs) -> Result<(), String> {
    tokio::task::spawn_blocking(move || run_git(&args.cwd, &["add", "--", &args.path]).map(|_| ()))
        .await
        .map_err(|e| format!("git stage task join failed: {e}"))?
}

/// `git restore --staged -- <path>`.
#[tauri::command]
pub async fn git_unstage(args: GitPathArgs) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&args.cwd, &["restore", "--staged", "--", &args.path]).map(|_| ())
    })
    .await
    .map_err(|e| format!("git unstage task join failed: {e}"))?
}

/// Discard a working-tree change: `git restore` for tracked files, `git clean`
/// for untracked ones. Destructive — the UI confirms first.
#[tauri::command]
pub async fn git_discard(args: GitPathArgs) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let restored = run_git(&args.cwd, &["restore", "--worktree", "--", &args.path]);
        if restored.is_err() {
            // Untracked file — `restore` can't touch it; remove it instead.
            run_git(&args.cwd, &["clean", "-f", "--", &args.path]).map(|_| ())
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("git discard task join failed: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCwdArgs {
    pub cwd: String,
}

/// `git add -A`.
#[tauri::command]
pub async fn git_stage_all(args: GitCwdArgs) -> Result<(), String> {
    tokio::task::spawn_blocking(move || run_git(&args.cwd, &["add", "-A"]).map(|_| ()))
        .await
        .map_err(|e| format!("git stage-all task join failed: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitArgs {
    pub cwd: String,
    pub message: String,
}

/// `git commit -m <message>` (commits the index). Returns the short commit
/// summary git prints.
#[tauri::command]
pub async fn git_commit(args: GitCommitArgs) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if args.message.trim().is_empty() {
            return Err("commit message is empty".to_string());
        }
        run_git(&args.cwd, &["commit", "-m", &args.message])
    })
    .await
    .map_err(|e| format!("git commit task join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_parses_counts_and_binary() {
        let map = parse_numstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n");
        assert_eq!(map.get("src/a.ts").copied(), Some((12, 3)));
        assert_eq!(map.get("img.png").copied(), Some((0, 0)));
    }
}
