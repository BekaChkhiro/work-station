//! CLI detection — scan PATH for known terminal executables.
//!
//! Detects `claude`, `kimi`, `codex`, `bash`, `zsh`, and `pwsh`.
//! Each entry carries the resolved absolute path and a best-effort version string.

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

/// A detected CLI with its resolved absolute path and version.
#[derive(Debug, Clone, Serialize)]
pub struct DetectedCli {
    pub name: String,
    pub path: String,
    pub version: Option<String>,
}

/// Known CLI names to scan for.
const KNOWN_CLIS: &[&str] = &["claude", "kimi", "codex", "bash", "zsh", "pwsh"];

/// Registry that caches CLI scan results from app boot.
///
/// Created once at startup and shared across commands via Tauri state.
#[derive(Debug)]
pub struct CliRegistry {
    clis: Mutex<Vec<DetectedCli>>,
}

impl CliRegistry {
    /// Scan PATH on creation and cache the results.
    pub fn new() -> Self {
        let clis = scan_clis();
        Self {
            clis: Mutex::new(clis),
        }
    }

    /// Return the cached list of detected CLIs.
    pub fn list(&self) -> Vec<DetectedCli> {
        self.clis.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Force a re-scan and update the cache.
    pub fn refresh(&self) {
        let fresh = scan_clis();
        if let Ok(mut guard) = self.clis.lock() {
            *guard = fresh;
        }
    }
}

impl Default for CliRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Scan PATH for known CLIs and resolve their absolute paths and versions.
pub fn scan_clis() -> Vec<DetectedCli> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let path_dirs: Vec<&str> = if cfg!(windows) {
        path_var.split(';').collect()
    } else {
        path_var.split(':').collect()
    };

    let mut results = Vec::new();

    for &name in KNOWN_CLIS {
        if let Some(path) = find_executable(name, &path_dirs) {
            let version = resolve_version(&path, name);
            results.push(DetectedCli {
                name: name.to_string(),
                path,
                version,
            });
        }
    }

    results
}

/// Check whether an executable exists in the given PATH directories.
fn find_executable(name: &str, dirs: &[&str]) -> Option<String> {
    let candidates = if cfg!(windows) {
        vec![
            format!("{}.exe", name),
            format!("{}.cmd", name),
            format!("{}.bat", name),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };

    for dir in dirs {
        for candidate in &candidates {
            let full = Path::new(dir).join(candidate);
            if full.is_file() {
                // Verify it's actually executable. On Windows, `is_file` is enough
                // because PATHEXT handles execution rights; on Unix we need the
                // executable permission bit.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let meta = match full.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if meta.permissions().mode() & 0o111 == 0 {
                        continue;
                    }
                }

                return full
                    .canonicalize()
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned());
            }
        }
    }

    None
}

/// Attempt to fetch the version of a CLI by running `<cli> --version`.
fn resolve_version(path: &str, name: &str) -> Option<String> {
    let flag = match name {
        "pwsh" => "-Version",
        _ => "--version",
    };

    let output = std::process::Command::new(path).arg(flag).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Some tools (e.g. PowerShell) write version to stderr
    let text = if stdout.trim().is_empty() {
        stderr.as_ref()
    } else {
        stdout.as_ref()
    };

    let first_line = text.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }

    // Trim common prefixes like "GNU bash, version "
    let cleaned = first_line
        .trim_start_matches("GNU bash, version ")
        .trim_start_matches("zsh ")
        .trim_start_matches("PowerShell ")
        .trim_start_matches("pwsh ")
        .trim_start_matches("claude ")
        .trim_start_matches("kimi ")
        .trim_start_matches("codex ")
        .trim_start_matches("version ")
        .trim_start_matches("v")
        .trim();

    Some(cleaned.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_clis_does_not_panic() {
        // This test mainly ensures the scan logic is panic-free.
        let clis = scan_clis();
        // On most developer machines at least bash or zsh is present.
        // We don't assert exact contents because PATH varies by environment.
        println!("Detected CLIs: {:?}", clis);
    }
}
