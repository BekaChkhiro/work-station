# State-only project switching (T6.2)

Manual verification for the runtime mechanic introduced by T6.2:
switching projects only swaps the visible layout tree — every project's
PTYs stay alive in the backend and keep filling their scrollback while
hidden, and the Terminal's render layer (T4.12) pauses/resumes around
the visibility change.

## How to run

1. Build the dev app:
   ```bash
   pnpm tauri dev
   ```
2. Once the window is open, navigate to `?wsdebug=appshell` (append the
   query string in the address bar / configure the launch URL).
3. Three demo projects spawn real shells: `argon-web`, `kepler-cli`,
   `borealis-api`. Each gets one pane with a single PTY.

## Acceptance — "switch A→B→A shows buffered output"

1. With **argon-web** active, click into its terminal and run:
   ```bash
   for i in 1 2 3 4 5 6 7 8 9 10; do echo "argon $i"; sleep 1; done
   ```
2. While the loop is still running, switch to **kepler-cli** (sidebar
   click or `Cmd/Ctrl+2`). Wait at least 4–5 seconds.
3. Switch back to **argon-web** (`Cmd/Ctrl+1`).

**Pass:** the argon terminal shows every `argon N` line that printed
during the absence — including the lines emitted while kepler was the
active project. The terminal redraws once on resume (the T4.12 replay
path calls `term.reset()` and replays the full PTY scrollback snapshot).

**Fail modes:**

- Missing lines → IntersectionObserver did not fire on the hidden
  workspace, so xterm kept consuming output without the backend
  scrollback being the source of truth.
- Terminal blanks then stays empty → replay path did not run; check
  console for `pty replay/subscribe failed` warnings.
- Lines duplicated → backend forwarded the same chunk twice; check that
  `subscriptionToken` short-circuit in `Terminal.tsx` is intact.

## Secondary checks

- **No remount on switch:** With React DevTools / Solid devtools, observe
  that switching projects does not destroy the hidden Terminal subtrees.
  Each Terminal mounts exactly once for the lifetime of the harness.
- **Sidebar session badge:** `argon` shows `1` while a pane is open;
  toggling between projects doesn't change the badge counts.
- **Hotkeys:** `Cmd/Ctrl+1..3` switches between projects regardless of
  whether xterm has focus.

## Out of scope (deferred)

- Restoring layouts from SQLite on switch / launch — covered by T2.12 +
  T5.9. See `qa/layout-restore-on-switch-launch.md`.
- The "project hot-pause" timer that closes long-idle backend PTYs —
  not in v0.1.
