# QA Matrix — Work Station

> Cross-platform validation checklist for Work Station v0.1.0.
>
> Target platforms: **macOS 14/15 (Apple Silicon + Intel)**, **Windows 10/11 (x64 + ARM64)**.

## Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not tested |
| 🟡 | In progress / partial |
| ✅ | Passed |
| ❌ | Failed / blocked |
| 🚫 | N/A on this platform |

---

## 1. Installation & First Launch

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Notes |
|---|-----------------|-------------|-----------|-------------|---------------|-------|
| 1.1 | Clean install from signed bundle | ⬜ | ⬜ | ⬜ | ⬜ | Fresh VM / user account |
| 1.2 | App launches without crash | ⬜ | ⬜ | ⬜ | ⬜ | |
| 1.3 | No GateKeeper / SmartScreen warnings | ⬜ | ⬜ | ⬜ | ⬜ | Signed bundles only |
| 1.4 | Database auto-initialises on first boot | ⬜ | ⬜ | ⬜ | ⬜ | `sqlite:workstation.db` created |
| 1.5 | Default settings applied (theme, hotkeys) | ⬜ | ⬜ | ⬜ | ⬜ | |
| 1.6 | CLI auto-detection runs at boot | ⬜ | ⬜ | ⬜ | ⬜ | `claude`, `kimi`, `codex`, shell |

## 2. PTY & Terminal

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Notes |
|---|-----------------|-------------|-----------|-------------|---------------|-------|
| 2.1 | Spawn default shell | ⬜ | ⬜ | ⬜ | ⬜ | `/bin/sh`, `cmd.exe`, `pwsh.exe` |
| 2.2 | Write input and receive output | ⬜ | ⬜ | ⬜ | ⬜ | Echo test |
| 2.3 | Resize terminal dimensions | ⬜ | ⬜ | ⬜ | ⬜ | `stty size` / `$host.UI.RawUI` |
| 2.4 | Scrollback accumulates output | ⬜ | ⬜ | ⬜ | ⬜ | Ring buffer ≤ 1 MiB |
| 2.5 | Multiple sessions are isolated | ⬜ | ⬜ | ⬜ | ⬜ | No cross-session output leak |
| 2.6 | Kill session cleans up child process | ⬜ | ⬜ | ⬜ | ⬜ | Verify no zombie processes |
| 2.7 | Terminal WebGL renderer initialises | ⬜ | ⬜ | ⬜ | ⬜ | Fallback to canvas on context loss |
| 2.8 | Copy / paste in terminal | ⬜ | ⬜ | ⬜ | ⬜ | `Cmd/Ctrl+C` (selection), `Cmd/Ctrl+V` |
| 2.9 | Theme colours render correctly | ⬜ | ⬜ | ⬜ | ⬜ | Dark + light mode |
| 2.10 | Visibility pause / resume (background tab) | ⬜ | ⬜ | ⬜ | ⬜ | IntersectionObserver + document.visibility |

## 3. Projects

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Notes |
|---|-----------------|-------------|-----------|-------------|---------------|-------|
| 3.1 | Create project with valid path | ⬜ | ⬜ | ⬜ | ⬜ | |
| 3.2 | Reject duplicate project name | ⬜ | ⬜ | ⬜ | ⬜ | Validation error shown |
| 3.3 | Reject non-existent path | ⬜ | ⬜ | ⬜ | ⬜ | Validation error shown |
| 3.4 | Native folder picker works | ⬜ | ⬜ | ⬜ | ⬜ | `tauri-plugin-dialog` |
| 3.5 | Update project fields (name, colour, icon, CLI, env) | ⬜ | ⬜ | ⬜ | ⬜ | |
| 3.6 | Delete project removes from list | ⬜ | ⬜ | ⬜ | ⬜ | |
| 3.7 | Project list persists across restarts | ⬜ | ⬜ | ⬜ | ⬜ | SQLite persistence |
| 3.8 | Active project highlight in sidebar | ⬜ | ⬜ | ⬜ | ⬜ | |

## 4. Layout & Window Management

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Notes |
|---|-----------------|-------------|-----------|-------------|---------------|-------|
| 4.1 | Split pane (horizontal / vertical) | ⬜ | ⬜ | ⬜ | ⬜ | Hotkey or UI action |
| 4.2 | Close pane | ⬜ | ⬜ | ⬜ | ⬜ | Hotkey or UI action |
| 4.3 | Focus pane via click | ⬜ | ⬜ | ⬜ | ⬜ | Active border / indicator |
| 4.4 | Focus project via hotkey (1–9) | ⬜ | ⬜ | ⬜ | ⬜ | `primary+1` … `primary+9` |
| 4.5 | Open project switcher | ⬜ | ⬜ | ⬜ | ⬜ | Default `primary+P` |

## 5. UI, Theming & Accessibility

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Notes |
|---|-----------------|-------------|-----------|-------------|---------------|-------|
| 5.1 | Dark mode | ⬜ | ⬜ | ⬜ | ⬜ | `data-theme="dark"` |
| 5.2 | Light mode | ⬜ | ⬜ | ⬜ | ⬜ | `data-theme="light"` |
| 5.3 | System mode follows OS preference | ⬜ | ⬜ | ⬜ | ⬜ | `prefers-color-scheme` |
| 5.4 | Theme persists across restarts | ⬜ | ⬜ | ⬜ | ⬜ | SQLite + localStorage fallback |
| 5.5 | Reduced motion respected | ⬜ | ⬜ | ⬜ | ⬜ | `prefers-reduced-motion` |
| 5.6 | macOS traffic lights visible | ⬜ | ⬜ | 🚫 | 🚫 | `titleBarStyle: Transparent` |
| 5.7 | Windows custom title bar controls | 🚫 | 🚫 | ⬜ | ⬜ | Minimise / maximise / close |
| 5.8 | Window drag region functional | ⬜ | ⬜ | ⬜ | ⬜ | Custom title bar + content area |

## 6. Hotkeys

| # | Action | Default Binding | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 |
|---|--------|-----------------|-------------|-----------|-------------|---------------|
| 6.1 | New terminal | `primary+T` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.2 | Split horizontal | `primary+Shift+D` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.3 | Split vertical | `primary+D` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.4 | Close pane | `primary+W` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.5 | Focus project 1–9 | `primary+1` … `primary+9` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.6 | Open switcher | `primary+P` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.7 | Open settings | `primary+,` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.8 | Find in terminal | `primary+F` | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.9 | Hotkeys ignored in `<input>` / `<textarea>` | — | ⬜ | ⬜ | ⬜ | ⬜ |
| 6.10 | Custom rebinding persists | — | ⬜ | ⬜ | ⬜ | ⬜ |

> **Platform modifier**: `primary` = `⌘` (macOS) / `Ctrl` (Windows).

## 7. Auto-Updater

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Notes |
|---|-----------------|-------------|-----------|-------------|---------------|-------|
| 7.1 | Check for update on launch | ⬜ | ⬜ | ⬜ | ⬜ | 3-second deferred check |
| 7.2 | Update available banner shown | ⬜ | ⬜ | ⬜ | ⬜ | |
| 7.3 | Download progress indicator | ⬜ | ⬜ | ⬜ | ⬜ | |
| 7.4 | Install on restart | ⬜ | ⬜ | ⬜ | ⬜ | |
| 7.5 | Dismiss banner | ⬜ | ⬜ | ⬜ | ⬜ | |
| 7.6 | Error state handled gracefully | ⬜ | ⬜ | ⬜ | ⬜ | Network failure, invalid sig |

## 8. Performance & Stability

| # | Validation Step | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Target |
|---|-----------------|-------------|-----------|-------------|---------------|--------|
| 8.1 | Cold start time | ⬜ | ⬜ | ⬜ | ⬜ | < 500 ms |
| 8.2 | RAM with 10 active terminals | ⬜ | ⬜ | ⬜ | ⬜ | < 300 MB RSS |
| 8.3 | 1 GB output stress test | 🟡 | 🟡 | 🟡 | 🟡 | 60 fps, no main-thread freeze |
| 8.3a | Backend throughput + scrollback bounds | ✅ | ✅ | ✅ | ✅ | `cargo test --test output_stress` |
| 8.3b | Frontend frame-time monitor | 🟡 | 🟡 | 🟡 | 🟡 | `src/utils/performance-monitor.ts` — wire into Terminal.tsx |
| 8.4 | 24-hour leak test (5 sessions) | ⬜ | ⬜ | ⬜ | ⬜ | Stable RSS, no handle leak |
| 8.5 | WebView reload — sessions survive | ⬜ | ⬜ | ⬜ | ⬜ | By design |

## 9. Smoke Tests / CI

| # | Test | macOS ARM64 | macOS x64 | Windows x64 | Windows ARM64 | Command |
|---|------|-------------|-----------|-------------|---------------|---------|
| 9.1 | `cargo test` — unit + integration | ⬜ | ⬜ | ⬜ | ⬜ | `cd src-tauri && cargo test` |
| 9.2 | PTY smoke tests | ⬜ | ⬜ | ⬜ | ⬜ | `cargo test --test pty_smoke` |
| 9.3 | Frontend lint | ⬜ | ⬜ | ⬜ | ⬜ | `pnpm lint` |
| 9.4 | Tauri build succeeds | ⬜ | ⬜ | ⬜ | ⬜ | `pnpm tauri build` |
| 9.5 | Signed bundle produced | ⬜ | ⬜ | ⬜ | ⬜ | `.dmg`, `.msi`, `.exe` |

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| macOS QA | | | |
| Windows QA | | | |
| Release Engineer | | | |

---

## How to Run QA

1. **Fresh environment**: Use a clean VM or create a new macOS user / Windows profile.
2. **Install**: Download the signed bundle for the target platform from the GitHub Release.
3. **Reset state** (optional): Delete `~/Library/Application Support/com.beqolozi.work-station/` (macOS) or `%APPDATA%\com.beqolozi.work-station\` (Windows).
4. **Tick boxes**: Work through each section above. Record any failures with reproduction steps and attach logs.
5. **File issues**: Open GitHub Issues for any ❌ or 🟡 items, tagging them with the platform label (`macos-arm64`, `macos-x64`, `windows-x64`, `windows-arm64`).

## Known Limitations

- **Windows ARM64 builds** are cross-compiled from Windows x64 runners in CI. Native ARM64 runner validation is pending general availability of `windows-11-arm` GitHub-hosted runners.
- **Linux** is not a v0.1.0 target; PTY smoke tests pass on Linux but full UI validation is out of scope for this release.
