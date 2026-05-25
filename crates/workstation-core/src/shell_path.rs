//! Resolve the user's interactive login-shell PATH on Unix and apply it
//! to the current process at boot.
//!
//! On macOS, GUI processes launched from Finder/Dock inherit launchd's
//! minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). User-installed CLIs
//! that live in `/opt/homebrew/bin`, `~/.nvm/versions/node/*/bin`,
//! `~/.local/bin`, `~/.bun/bin`, etc. are invisible — so the CLI
//! registry (T7.1) sees only `bash` / `zsh` and PTY spawns can't find
//! `claude`, `kimi`, `codex`. Same problem affects Linux when launched
//! from a desktop entry instead of a terminal.
//!
//! Fix: spawn the user's `$SHELL` once as an interactive login shell
//! and read back its `$PATH`. This is the same trick VS Code, iTerm2,
//! and Atom use (see `shell-env` on npm). The probe is bounded by a
//! short timeout so a slow / broken rc file can't stall startup.
//!
//! No-op on Windows — its GUI processes inherit the user's PATH from
//! the per-user environment block, which is already complete.

#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::{Duration, Instant};

/// Maximum wall-clock budget for the shell probe. Generous enough for
/// a typical zshrc with nvm / oh-my-zsh, tight enough that a broken
/// rc file doesn't hold up the splash screen.
#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

/// Filename for the on-disk PATH cache. Lives in `dirs::cache_dir()` so
/// it survives across runs but is fair game for the OS to nuke. Format
/// is plain JSON (see `cache::CachedPath`).
#[cfg(unix)]
const PATH_CACHE_FILE: &str = "work-station/path_cache.json";

/// Update the current process PATH from the user's interactive login
/// shell, if we can resolve one. Logs the outcome and returns silently
/// on any failure — detection then falls back to whatever PATH the OS
/// gave us (which is at least good enough for `bash` / `zsh`).
///
/// **Cache:** the first boot writes the resolved PATH to disk along
/// with the shell + rc-file mtimes that produced it. Subsequent boots
/// load that cache in <1ms and skip the 0.5–2.5s shell probe entirely
/// — the dominant cost users were seeing on every cold start. The
/// cache is invalidated automatically when `$SHELL` changes or any
/// tracked rc file's mtime moves, so `brew install …`-style additions
/// flow through naturally as long as the user touches their rc.
pub fn hydrate_from_login_shell() {
    #[cfg(unix)]
    {
        // Fast path — if we have a fresh disk cache, apply it and
        // bail. No subprocess, no rc-file execution.
        if let Some((cached_path, source)) = cache::load_fresh() {
            tracing::info!(
                target: "shell_path",
                source = source,
                chars = cached_path.len(),
                "hydrated PATH from disk cache (skipping shell probe)",
            );
            apply_path(std::ffi::OsString::from(cached_path));
            return;
        }

        match probe_login_path() {
            Ok((path, elapsed)) => {
                tracing::info!(
                    target: "shell_path",
                    elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
                    chars = path.len(),
                    "hydrated PATH from login shell",
                );
                if let Some(s) = path.to_str() {
                    if let Err(error) = cache::save(s) {
                        tracing::warn!(
                            target: "shell_path",
                            %error,
                            "failed to write PATH cache; subsequent boots will reprobe",
                        );
                    }
                }
                apply_path(path);
            }
            Err(reason) => {
                tracing::warn!(
                    target: "shell_path",
                    %reason,
                    "could not hydrate PATH from login shell; using OS-provided PATH",
                );
            }
        }
    }
}

#[cfg(unix)]
fn apply_path(path: std::ffi::OsString) {
    let previous = std::env::var_os("PATH").unwrap_or_default();
    if previous == path {
        return;
    }
    // SAFETY: set_var is unsound if other threads are reading the env
    // concurrently. We run before any background tasks (cli registry
    // scan, db init) are spawned in `lib.rs::run`, so we're
    // single-threaded here. Anything that reads PATH later (cli
    // detection, pty spawns) sees the updated value.
    std::env::set_var("PATH", path);
}

#[cfg(unix)]
mod cache {
    use std::fs;
    use std::path::PathBuf;

    use serde::{Deserialize, Serialize};

    use super::PATH_CACHE_FILE;

    /// rc files we treat as inputs to the probe. Missing entries are
    /// skipped at fingerprint time, not treated as errors.
    const RC_FILES: &[&str] = &[
        ".zshrc",
        ".zprofile",
        ".zshenv",
        ".zlogin",
        ".bashrc",
        ".bash_profile",
        ".profile",
    ];

    #[derive(Serialize, Deserialize)]
    struct CachedPath {
        shell: String,
        /// (absolute path, mtime as seconds since epoch). Missing
        /// files appear with mtime == 0 so adding a previously-absent
        /// rc file invalidates the cache automatically.
        rc_mtimes: Vec<(String, i64)>,
        path: String,
    }

    fn cache_path() -> Option<PathBuf> {
        dirs::cache_dir().map(|d| d.join(PATH_CACHE_FILE))
    }

    fn current_shell() -> String {
        std::env::var("SHELL").unwrap_or_default()
    }

    fn current_mtimes() -> Vec<(String, i64)> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        RC_FILES
            .iter()
            .map(|name| {
                let p = home.join(name);
                let mtime = fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0i64, |d| i64::try_from(d.as_secs()).unwrap_or(0));
                (p.to_string_lossy().into_owned(), mtime)
            })
            .collect()
    }

    /// Returns `Some((path, source_tag))` when a cache file exists and
    /// its fingerprint matches the current environment.
    pub(super) fn load_fresh() -> Option<(String, &'static str)> {
        let path = cache_path()?;
        let raw = fs::read_to_string(&path).ok()?;
        let cached: CachedPath = serde_json::from_str(&raw).ok()?;
        if cached.shell != current_shell() {
            tracing::debug!(target: "shell_path", "cache invalidated: $SHELL changed");
            return None;
        }
        if cached.rc_mtimes != current_mtimes() {
            tracing::debug!(target: "shell_path", "cache invalidated: rc-file mtime drift");
            return None;
        }
        if cached.path.is_empty() {
            return None;
        }
        Some((cached.path, "disk_cache"))
    }

    pub(super) fn save(path: &str) -> Result<(), String> {
        let target = cache_path().ok_or_else(|| "no cache dir available".to_string())?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
        }
        let payload = CachedPath {
            shell: current_shell(),
            rc_mtimes: current_mtimes(),
            path: path.to_string(),
        };
        let body = serde_json::to_string(&payload).map_err(|e| format!("serialize: {e}"))?;
        // Atomic-ish write: stage to a sibling tmp file then rename so
        // a crash partway through a write never leaves a corrupted
        // cache that future boots would silently fall back from.
        let tmp = target.with_extension("json.tmp");
        fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
        fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }
}

#[cfg(unix)]
fn probe_login_path() -> Result<(std::ffi::OsString, Duration), String> {
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::ffi::OsString::from("/bin/zsh"));

    let start = Instant::now();
    let mut child = Command::new(&shell)
        // -i interactive so .zshrc / .bashrc run (where most users
        // export PATH for nvm, asdf, brew). -l so login profile files
        // also run on macOS where Terminal.app does login-shells by
        // default. The marker delimits our payload from any banner /
        // welcome-message output the rc files may print.
        .args([
            "-ilc",
            "printf '__WS_PATH_BEGIN__%s__WS_PATH_END__' \"$PATH\"",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn {shell:?}: {e}"))?;

    // Poll wait_timeout-style — std doesn't ship one, so we kill on
    // overrun and let `wait()` reap. The shell is well-behaved in the
    // overwhelming common case, so this branch is rare.
    let deadline = start + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("shell probe timed out after {PROBE_TIMEOUT:?}"));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("collect stdout: {e}"))?;
    if !output.status.success() {
        return Err(format!("shell exited {:?}", output.status.code()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = extract_marker(&stdout)
        .ok_or_else(|| format!("no marker in stdout (got {} bytes)", stdout.len()))?;
    if path.is_empty() {
        return Err("login shell reported empty PATH".into());
    }
    Ok((std::ffi::OsString::from(path), start.elapsed()))
}

#[cfg(unix)]
fn extract_marker(stdout: &str) -> Option<String> {
    let begin = stdout.find("__WS_PATH_BEGIN__")? + "__WS_PATH_BEGIN__".len();
    let rest = &stdout[begin..];
    let end = rest.find("__WS_PATH_END__")?;
    Some(rest[..end].to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn extract_marker_round_trips() {
        let raw =
            "welcome banner\n__WS_PATH_BEGIN__/usr/local/bin:/usr/bin__WS_PATH_END__\nmore output";
        assert_eq!(
            extract_marker(raw).as_deref(),
            Some("/usr/local/bin:/usr/bin"),
        );
    }

    #[test]
    fn extract_marker_handles_empty_payload() {
        let raw = "__WS_PATH_BEGIN____WS_PATH_END__";
        assert_eq!(extract_marker(raw).as_deref(), Some(""));
    }

    #[test]
    fn extract_marker_returns_none_when_absent() {
        assert!(extract_marker("nothing here").is_none());
        assert!(extract_marker("__WS_PATH_BEGIN__no end marker").is_none());
    }

    #[test]
    fn probe_returns_a_path_under_real_shell() {
        // Smoke test against the actual host shell. We don't assert
        // contents — just that the probe completes and produces
        // something non-empty within budget.
        let (path, elapsed) = probe_login_path().expect("probe should succeed on a dev box");
        assert!(!path.is_empty());
        assert!(
            elapsed < PROBE_TIMEOUT,
            "probe should finish within budget, took {elapsed:?}",
        );
    }
}
