//! T7.1: scan PATH for known CLI binaries and cache the result for the
//! lifetime of the app.
//!
//! The registry is stored as Tauri-managed state (see `lib.rs`) and
//! populated exactly once during boot via [`CliRegistry::populate_default`].
//! Subsequent reads are a lock-free `OnceLock` hit, so commands added in
//! later tasks (T7.2 onwards) can return the cached list without re-walking
//! PATH.
//!
//! Detection rules:
//!   * PATH is split with [`std::env::split_paths`] so quoting / separator
//!     differences across Windows and Unix are handled correctly.
//!   * On Windows we honour `PATHEXT` (default `.COM;.EXE;.BAT;.CMD`).
//!     Common npm-installed CLIs ship as `claude.cmd`, so dropping `.cmd`
//!     would miss the agent we most care about.
//!   * On Unix the file must have at least one execute bit set
//!     (`mode & 0o111 != 0`) to qualify — readable shell scripts in PATH
//!     that aren't actually launchable shouldn't pollute the list.
//!   * Symlinks aren't resolved beyond the first match: returning the PATH
//!     entry as-typed keeps the result stable even if the user later
//!     reconfigures their toolchain manager (asdf / volta / nvm).

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

/// CLIs we probe for in PATH. Order matters — it's the order the
/// frontend will display them in until the user reorders manually.
pub const DEFAULT_CANDIDATES: &[&str] = &[
    "claude", "kimi", "codex", "bash", "zsh", "fish", "pwsh", "cmd",
];

/// A single detected CLI on PATH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBinary {
    /// Stable id matching the candidate name we searched for
    /// (`claude`, `bash`, …). Used as the key in `projects.default_cli`
    /// and on the frontend's `PROJECT_CLI_OPTIONS` shape.
    pub id: String,
    /// Absolute path to the executable as resolved from PATH. On Windows
    /// this includes the matched extension (`claude.cmd`,
    /// `pwsh.exe`).
    pub path: PathBuf,
}

/// T7.2: a detected CLI plus its best-effort version banner. This is the
/// shape the `cli_list_available` IPC command returns, and the shape the
/// frontend renders directly. `version` is `None` when the probe failed,
/// timed out, or the CLI doesn't support `--version` — the UI surfaces
/// this as a blank version label per the T7.2 acceptance criterion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub name: String,
    pub path: PathBuf,
    pub version: Option<String>,
}

/// App-scoped CLI registry — held by Tauri's `.manage()` so the cached
/// list is shared across windows and survives webview reloads.
#[derive(Debug, Default)]
pub struct CliRegistry {
    detected: OnceLock<Vec<CliBinary>>,
    /// Cached version-probed view — populated lazily on the first
    /// `cli_list_available` call and reused for the rest of the session.
    /// Keyed off `tokio::sync::OnceCell` rather than the std variant so
    /// the `get_or_init` future can `.await` the per-CLI probes.
    info_cache: tokio::sync::OnceCell<Vec<CliInfo>>,
}

impl CliRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Populate the cache from the current process PATH using
    /// [`DEFAULT_CANDIDATES`]. No-op on subsequent calls — once detected,
    /// the list is frozen for the session.
    ///
    /// Walks the filesystem (one `metadata` syscall per candidate × PATH
    /// directory) so call from a blocking pool — `tokio::task::spawn_blocking`
    /// in `lib.rs` for the boot-time scan, or the same wrapper in any
    /// later IPC command that ends up here as a fallback.
    pub fn populate_default(&self) -> &[CliBinary] {
        self.detected
            .get_or_init(|| detect_in_path(DEFAULT_CANDIDATES, std::env::var_os("PATH").as_deref()))
    }

    /// Return the cached list. `None` until `populate_default` has run —
    /// IPC commands (T7.2) should fall back to `populate_default` if the
    /// boot-time scan hasn't completed yet.
    #[allow(dead_code)] // wired into the IPC surface in T7.2
    pub fn get(&self) -> Option<&[CliBinary]> {
        self.detected.get().map(Vec::as_slice)
    }

    /// Test-only constructor that seeds the cache directly. Used so
    /// command tests can assert behaviour without depending on the host
    /// PATH.
    #[cfg(test)]
    pub fn from_seed(binaries: Vec<CliBinary>) -> Self {
        let cell = OnceLock::new();
        let _ = cell.set(binaries);
        Self {
            detected: cell,
            info_cache: tokio::sync::OnceCell::new(),
        }
    }

    /// T7.2: return the cached binary list with `--version` metadata
    /// attached. Probes `--version` once on first call and caches the
    /// result for the rest of the session. Probe failures collapse to
    /// `version = None` so the list itself is always returned in full.
    pub async fn binaries_with_versions(&self) -> &[CliInfo] {
        self.info_cache
            .get_or_init(|| async {
                // `populate_default` is a OnceLock cache hit on every
                // call after the boot scan, so this is effectively free
                // unless the IPC command races boot — in which case we
                // want to populate inline rather than return an empty
                // list to the frontend.
                let binaries = self.populate_default().to_vec();
                super::version::probe_all(&binaries).await
            })
            .await
            .as_slice()
    }
}

/// Pure detection function. Returns at most one entry per candidate, in
/// the order given. The first PATH directory that contains a match wins
/// (mirroring how `which` resolves) so user-overridden tools earlier in
/// PATH take precedence over system defaults.
pub fn detect_in_path(candidates: &[&str], path_var: Option<&OsStr>) -> Vec<CliBinary> {
    let dirs: Vec<PathBuf> = match path_var {
        Some(value) => std::env::split_paths(value).collect(),
        None => Vec::new(),
    };

    if dirs.is_empty() {
        return Vec::new();
    }

    let extensions = executable_extensions();
    let mut found = Vec::with_capacity(candidates.len());
    let mut seen: HashSet<&str> = HashSet::new();

    for &name in candidates {
        if seen.contains(name) {
            continue;
        }
        for dir in &dirs {
            if let Some(resolved) = first_match(dir, name, &extensions) {
                seen.insert(name);
                found.push(CliBinary {
                    id: name.to_string(),
                    path: resolved,
                });
                break;
            }
        }
    }

    found
}

fn first_match(dir: &Path, name: &str, extensions: &[OsString]) -> Option<PathBuf> {
    for ext in extensions {
        let mut candidate = dir.join(name);
        if !ext.is_empty() {
            // Append the extension preserving the original `OsString`
            // bytes — `set_extension` would replace any existing dot in
            // the name (e.g. `pwsh.exe` if a future candidate were
            // already qualified).
            let mut filename: OsString = candidate
                .file_name()
                .map(OsStr::to_os_string)
                .unwrap_or_default();
            filename.push(".");
            filename.push(ext);
            candidate.set_file_name(filename);
        }
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        // On Windows the extension match (PATHEXT) is the executability
        // signal; the metadata check above already excluded directories.
        true
    }
}

/// Extensions to try for each candidate. The empty extension is always
/// tried first so plain `claude`-style binaries on Unix or shims placed
/// in PATH without `.exe` still match.
#[cfg(windows)]
fn executable_extensions() -> Vec<OsString> {
    // PATHEXT is `;`-separated on Windows. Use a plain string split rather
    // than `std::env::split_paths` — the latter is documented for PATH-style
    // *path* lists and its dot-handling around `PathBuf` round-trips isn't
    // contractual for raw extension tokens.
    let mut out = vec![OsString::new()];
    let raw = std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    let raw_str = raw.to_string_lossy();
    for piece in raw_str.split(';') {
        let trimmed = piece.trim().trim_start_matches('.');
        if !trimmed.is_empty() {
            out.push(OsString::from(trimmed));
        }
    }
    out
}

#[cfg(not(windows))]
fn executable_extensions() -> Vec<OsString> {
    vec![OsString::new()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn make_executable(path: &Path) {
        let mut f = fs::File::create(path).expect("create shim");
        writeln!(f, "#!/bin/sh\necho ok").expect("write shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(path, perms).unwrap();
        }
    }

    fn make_non_executable(path: &Path) {
        let mut f = fs::File::create(path).expect("create non-exec");
        writeln!(f, "not runnable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o644);
            fs::set_permissions(path, perms).unwrap();
        }
    }

    fn join_path(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs.iter().map(|p| p.as_os_str())).expect("join paths")
    }

    #[test]
    fn empty_path_yields_empty_list() {
        let result = detect_in_path(&["claude"], None);
        assert!(result.is_empty());
    }

    #[test]
    fn finds_executable_in_single_dir() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        make_executable(&bin);

        let path = join_path(&[dir.path()]);
        let result = detect_in_path(&["claude", "kimi"], Some(path.as_os_str()));

        assert_eq!(result.len(), 1, "only `claude` is on PATH");
        assert_eq!(result[0].id, "claude");
        assert_eq!(result[0].path, bin);
    }

    #[test]
    fn first_path_dir_wins() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_bin = first.path().join("bash");
        let second_bin = second.path().join("bash");
        make_executable(&first_bin);
        make_executable(&second_bin);

        let path = join_path(&[first.path(), second.path()]);
        let result = detect_in_path(&["bash"], Some(path.as_os_str()));

        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].path, first_bin,
            "earlier PATH entry should shadow later one"
        );
    }

    #[test]
    fn missing_candidates_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(&dir.path().join("zsh"));

        let path = join_path(&[dir.path()]);
        let result = detect_in_path(&["claude", "kimi", "zsh", "fish"], Some(path.as_os_str()));

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "zsh");
    }

    #[test]
    #[cfg(unix)]
    fn non_executable_files_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        make_non_executable(&bin);

        let path = join_path(&[dir.path()]);
        let result = detect_in_path(&["claude"], Some(path.as_os_str()));

        assert!(
            result.is_empty(),
            "non-executable file in PATH should not be reported"
        );
    }

    #[test]
    fn directory_named_like_candidate_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        // A directory called `bash` — has been seen on misconfigured systems
        // (someone created a folder for notes / dotfiles in PATH).
        fs::create_dir(dir.path().join("bash")).unwrap();

        let path = join_path(&[dir.path()]);
        let result = detect_in_path(&["bash"], Some(path.as_os_str()));

        assert!(
            result.is_empty(),
            "directories shouldn't be treated as executables"
        );
    }

    #[test]
    fn returns_absolute_paths() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(&dir.path().join("fish"));

        let path = join_path(&[dir.path()]);
        let result = detect_in_path(&["fish"], Some(path.as_os_str()));

        assert_eq!(result.len(), 1);
        assert!(
            result[0].path.is_absolute(),
            "detector must return absolute paths"
        );
    }

    #[test]
    fn registry_caches_for_session() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("zsh");
        make_executable(&bin);

        let path = join_path(&[dir.path()]);
        // We can't override PATH per-call on the public struct (it's
        // designed to read the process env), so seed via the test-only
        // constructor and assert subsequent reads return the same slice.
        let registry = CliRegistry::from_seed(vec![CliBinary {
            id: "zsh".into(),
            path: bin.clone(),
        }]);

        let first = registry.get().expect("seeded value");
        let second = registry.get().expect("seeded value");
        assert_eq!(first, second);
        assert_eq!(first[0].path, bin);

        let _ = path; // silence unused on platforms where above test omits it
    }

    #[test]
    fn populate_default_is_idempotent() {
        let registry = CliRegistry::new();
        let first = registry.populate_default().to_vec();
        let second = registry.populate_default().to_vec();
        assert_eq!(first, second, "second call must hit the cache");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn binaries_with_versions_caches_and_preserves_order() {
        // Seed two synthetic CLIs that won't actually exist on the host
        // (so version probing returns `None` for both quickly) and
        // confirm the order plus cache behaviour.
        let registry = CliRegistry::from_seed(vec![
            CliBinary {
                id: "claude".into(),
                path: PathBuf::from("/nonexistent/claude"),
            },
            CliBinary {
                id: "kimi".into(),
                path: PathBuf::from("/nonexistent/kimi"),
            },
        ]);

        let first = registry.binaries_with_versions().await.to_vec();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].name, "claude");
        assert_eq!(first[1].name, "kimi");
        assert!(
            first.iter().all(|info| info.version.is_none()),
            "nonexistent binaries should produce version=None, got {first:?}"
        );

        // Second call must hit the cache — equality on the full vec is
        // sufficient since `CliInfo` derives PartialEq.
        let second = registry.binaries_with_versions().await.to_vec();
        assert_eq!(first, second);
    }

    #[test]
    #[cfg(unix)]
    fn detect_in_path_completes_within_budget() {
        // Acceptance for T7.1 is "list populated within 200ms of boot",
        // i.e. detection itself plus the Tauri setup overhead. We can't
        // measure boot here, but we can lock in that the scan portion is
        // far below budget against a controlled PATH so the assertion
        // doesn't drift if a candidate is added.
        //
        // Using a tempdir keeps the test hermetic — the host's real PATH
        // (NFS mounts, /nix/store, dead network drives) would otherwise
        // make this flaky in CI.
        let dir = tempfile::tempdir().unwrap();
        for name in DEFAULT_CANDIDATES {
            make_executable(&dir.path().join(name));
        }
        let path = join_path(&[dir.path()]);

        let start = std::time::Instant::now();
        let result = detect_in_path(DEFAULT_CANDIDATES, Some(path.as_os_str()));
        let elapsed = start.elapsed();

        assert_eq!(result.len(), DEFAULT_CANDIDATES.len());
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "scan of {} candidates took {elapsed:?}; budget is 50ms",
            DEFAULT_CANDIDATES.len(),
        );
    }
}
