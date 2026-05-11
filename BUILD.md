# Build & install — Work Station

Personal-use Tauri 2.x desktop app. Builds are **unsigned**. macOS and Windows installers are produced locally on macOS or via the GitHub Actions matrix in [`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml).

This document covers:

- [Local macOS build](#local-macos-build)
- [Windows build via GitHub Actions](#windows-build-via-github-actions)
- [Install — macOS](#install--macos)
- [Install — Windows](#install--windows)
- [Verify the install](#verify-the-install)

Toolchain setup (Rust, Node, pnpm, platform deps) lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md#platform-dependencies). Run that once per machine before the steps below.

---

## Local macOS build

```bash
pnpm install
pnpm tauri build --target universal-apple-darwin
```

First build is cold (~5–10 min). Subsequent builds are incremental.

Artifacts land in `src-tauri/target/universal-apple-darwin/release/bundle/`:

| File                                       | What it is                       |
| ------------------------------------------ | -------------------------------- |
| `macos/Work Station.app`                   | Drag-installable app bundle      |
| `dmg/Work Station_<version>_universal.dmg` | Disk-image installer (preferred) |

> Building on Apple Silicon without the x64 target installed will fail. If `rustup target list --installed` doesn't include both `aarch64-apple-darwin` and `x86_64-apple-darwin`, run `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

To skip the universal build (arm64-only — smaller, faster, but won't run on Intel Macs):

```bash
pnpm tauri build
```

Output goes to `src-tauri/target/release/bundle/` instead.

---

## Windows build via GitHub Actions

Local Windows builds aren't required — the GHA matrix produces the same artifact. Use it from any OS.

1. Open **Actions** → **build** in the repo.
2. Click **Run workflow**, pick the branch (usually `master`), confirm. The workflow also runs automatically on every push to `master` and on `release/*` tags.
3. Wait ~8–15 min for the `Windows x64 installer` job to finish.
4. Open the run → scroll to **Artifacts** → download `work-station-windows-x64.zip`.
5. Unzip — you get:
   - `Work Station_<version>_x64_en-US.msi` (MSI installer, preferred)
   - `Work Station_<version>_x64-setup.exe` (NSIS setup)

Artifacts expire after **30 days** — re-run the workflow if you need a fresh build.

The same workflow also produces `work-station-macos-universal.zip` (DMG + `.app.tar.gz`) if you want the macOS bundle without building locally.

---

## Install — macOS

The build is unsigned, so Gatekeeper will block first launch. One-time bypass per build:

1. Open the `.dmg` and drag **Work Station.app** to **Applications**. (Or unpack `.app.tar.gz` directly into `/Applications`.)
2. Open **Finder → Applications**.
3. **Right-click** Work Station → **Open**.
4. In the dialog, click **Open Anyway**.

Subsequent launches work from Dock / Spotlight without prompts — until you install a new build, at which point repeat the right-click → Open dance once.

If macOS still refuses with "damaged and can't be opened," strip the quarantine attribute:

```bash
xattr -dr com.apple.quarantine "/Applications/Work Station.app"
```

---

## Install — Windows

1. Double-click `Work Station_<version>_x64_en-US.msi`.
2. SmartScreen will show **"Windows protected your PC"** because the binary is unsigned.
3. Click **More info** → **Run anyway**.
4. Step through the installer (Next → Next → Install).

The `.exe` (NSIS) installer behaves the same way — same SmartScreen prompt, same bypass.

WebView2 Runtime is required at runtime (preinstalled on Windows 11; on Windows 10 install the [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) if missing).

Subsequent launches from Start menu / desktop shortcut go through without prompts.

---

## Verify the install

After install, on either OS:

1. Launch the app — a 1280×800 window opens with the Work Station UI.
2. Check version: **Menu → About Work Station** (macOS) or **Help → About** (Windows) shows the version from [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json).
3. Open a project, spawn a terminal session — the PTY should produce output within ~1s.

If any of the above fail, see [`CONTRIBUTING.md` → Troubleshooting](./CONTRIBUTING.md#troubleshooting).
