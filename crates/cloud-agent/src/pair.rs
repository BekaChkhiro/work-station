//! Pairing token persistence for the cloud-agent (T19.22).
//!
//! The agent accepts one bearer token on the `/ws` upgrade. Priority,
//! highest first:
//!
//!   1. `auth_token` pinned in the TOML config (operator chose to keep
//!      the secret under root-managed configuration).
//!   2. `<state_dir>/pairing_token` — a file the agent owns at runtime
//!      so the token survives restarts without a config edit, and so
//!      the `pair` subcommand can rotate it independently of the
//!      config file.
//!   3. A freshly minted 256-bit token, persisted to the file above on
//!      the way back up so the next boot reads the same value.
//!
//! The file is mode `0600` and owned by the running user — typically
//! `wsagent` under systemd (`User=wsagent` in the unit). The `pair`
//! subcommand is meant to be invoked as that same user (e.g.
//! `sudo -u wsagent cloud-agent pair rotate`) so the agent process can
//! read what was just written.
//!
//! Token format reuses [`workstation_core::ws::auth::generate_token`]
//! — 32 random bytes, base64-url-no-pad encoded (43 chars). Same shape
//! as the desktop's `ws_auth_token`, so the desktop pair flow doesn't
//! need to know whether the bearer it pasted came from a cloud agent
//! or a local bridge.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use workstation_core::ws::auth::generate_token;

/// File name (under `state_dir`) holding the persisted pairing token.
pub const PAIRING_TOKEN_FILENAME: &str = "pairing_token";

/// Mode applied to the pairing token file on Unix. `0600` — only the
/// owning user (`wsagent` under systemd) can read it.
#[cfg(unix)]
const PAIRING_TOKEN_MODE: u32 = 0o600;

/// Compute the on-disk path of the pairing token for a given state dir.
#[must_use]
pub fn pairing_token_path(state_dir: &Path) -> PathBuf {
    state_dir.join(PAIRING_TOKEN_FILENAME)
}

/// Read the persisted pairing token, if any.
///
/// Returns `Ok(None)` when the file does not exist or is empty (the
/// caller treats either as "no token yet" and mints one). Whitespace —
/// including a trailing newline — is trimmed so an operator who edits
/// the file with `vim` doesn't accidentally include the EOL in the
/// bearer.
pub fn read_pairing_token(state_dir: &Path) -> io::Result<Option<String>> {
    let path = pairing_token_path(state_dir);
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_owned()))
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Write `token` to `<state_dir>/pairing_token` atomically (write to a
/// sibling tempfile, then rename) so a concurrent read never sees a
/// half-written file. The final file has mode `0600` on Unix.
pub fn write_pairing_token(state_dir: &Path, token: &str) -> io::Result<()> {
    fs::create_dir_all(state_dir)?;

    let final_path = pairing_token_path(state_dir);
    let tmp_path = state_dir.join(format!(
        ".{PAIRING_TOKEN_FILENAME}.{}.tmp",
        std::process::id()
    ));

    // Write tempfile + flush before rename so the on-disk file is
    // either the old or new token, never a truncated view.
    {
        use std::io::Write as _;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)?;
        f.write_all(token.as_bytes())?;
        // Trailing newline is conventional for plain-text secret files
        // and keeps `cat` output readable on the VPS.
        f.write_all(b"\n")?;
        f.sync_all()?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(PAIRING_TOKEN_MODE))?;
    }

    // `rename` on Unix is atomic within a filesystem; both the
    // tempfile and the destination live in `state_dir` so this holds.
    if let Err(e) = fs::rename(&tmp_path, &final_path) {
        // Best-effort cleanup so a failed rename doesn't leave a
        // dangling tempfile next to the real one.
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

/// Read the existing pairing token, or mint + persist a fresh one.
///
/// Used by the daemon boot path: a brand-new agent has no token yet;
/// after the first boot the file exists and every subsequent restart
/// reads the same value. Surface I/O errors verbatim — the operator
/// must see "permission denied on `state_dir`" rather than a silent
/// fallback to an ephemeral token they can't reproduce.
pub fn load_or_create_pairing_token(state_dir: &Path) -> io::Result<String> {
    if let Some(existing) = read_pairing_token(state_dir)? {
        return Ok(existing);
    }
    let fresh = generate_token();
    write_pairing_token(state_dir, &fresh)?;
    Ok(fresh)
}

/// Generate a new token and overwrite the on-disk file, returning the
/// new value. Used by `cloud-agent pair rotate`.
pub fn rotate_pairing_token(state_dir: &Path) -> io::Result<String> {
    let fresh = generate_token();
    write_pairing_token(state_dir, &fresh)?;
    Ok(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_returns_none_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_pairing_token(tmp.path()).unwrap().is_none());
    }

    #[test]
    fn read_trims_whitespace_and_newlines() {
        let tmp = tempfile::tempdir().unwrap();
        let path = pairing_token_path(tmp.path());
        fs::write(&path, "  abc-token\n").unwrap();
        let token = read_pairing_token(tmp.path()).unwrap().unwrap();
        assert_eq!(token, "abc-token");
    }

    #[test]
    fn read_returns_none_for_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = pairing_token_path(tmp.path());
        fs::write(&path, "   \n").unwrap();
        assert!(read_pairing_token(tmp.path()).unwrap().is_none());
    }

    #[test]
    fn write_persists_token_with_trailing_newline() {
        let tmp = tempfile::tempdir().unwrap();
        write_pairing_token(tmp.path(), "fresh-token").unwrap();
        let raw = fs::read_to_string(pairing_token_path(tmp.path())).unwrap();
        assert_eq!(raw, "fresh-token\n");
    }

    #[test]
    fn write_creates_state_dir_if_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a/b/c");
        write_pairing_token(&nested, "tok").unwrap();
        assert!(nested.is_dir());
        assert_eq!(read_pairing_token(&nested).unwrap().as_deref(), Some("tok"));
    }

    #[cfg(unix)]
    #[test]
    fn write_sets_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt as _;
        let tmp = tempfile::tempdir().unwrap();
        write_pairing_token(tmp.path(), "tok").unwrap();
        let mode = fs::metadata(pairing_token_path(tmp.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn load_or_create_mints_and_persists_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let first = load_or_create_pairing_token(tmp.path()).unwrap();
        assert_eq!(first.len(), 43, "base64url-no-pad of 32 bytes is 43 chars");
        // Idempotent on subsequent calls — the persisted value is
        // reused so the agent's bearer survives a restart.
        let second = load_or_create_pairing_token(tmp.path()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn rotate_overwrites_existing_token() {
        let tmp = tempfile::tempdir().unwrap();
        let first = load_or_create_pairing_token(tmp.path()).unwrap();
        let second = rotate_pairing_token(tmp.path()).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            read_pairing_token(tmp.path()).unwrap().as_deref(),
            Some(second.as_str()),
        );
    }

    #[test]
    fn write_does_not_leave_tempfiles_on_success() {
        let tmp = tempfile::tempdir().unwrap();
        write_pairing_token(tmp.path(), "tok").unwrap();
        let entries: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries.len(), 1, "only the final file should remain");
        assert_eq!(entries[0], PAIRING_TOKEN_FILENAME);
    }
}
