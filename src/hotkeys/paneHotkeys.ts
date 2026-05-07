// Pane / project hotkeys for the production AppRoot.
//
// Bindings (Cmd on macOS, Ctrl elsewhere):
//   • Cmd/Ctrl + \           → split focused pane vertically (side-by-side)
//   • Cmd/Ctrl + Shift + \   → split focused pane horizontally (stacked)
//   • Cmd/Ctrl + W           → close focused pane (kills its PTY)
//   • Cmd/Ctrl + N           → open the Add Project modal
//
// Listens at the document level so it wins over xterm's hidden textarea —
// xterm's `customKeyEventHandler` is configured (T4.5) to let the modifier
// combos through.
//
// All operations target the *active project's focused pane*. When no pane
// is focused (e.g. project just created with no layout yet) the split / close
// are no-ops; Cmd+N is always live.

import { onCleanup, onMount } from "solid-js";
import { ptyKill, ptySpawn } from "../ipc/pty";
import {
  activeProjectId,
  closePane as closePaneInStore,
  getWorkspace,
  splitPane,
} from "../stores/workspace";
import type { SplitDirection } from "../types/layout";
import { isMac } from "../utils/platform";

export interface PaneHotkeyDefaultCli {
  /** Stable CLI id (e.g. "claude", "zsh"). Echoed into `WS_CLI_NAME`. */
  name: string;
  /** Absolute path to the executable as detected on PATH. */
  path: string;
}

export interface PaneHotkeyHandlers {
  /** Resolves to the cwd to use for new shells in `projectId`. The AppRoot
   *  has the path map; we keep this module decoupled by going through a
   *  callback. */
  resolveCwd: (projectId: string) => string | null;
  /** Extra environment variables saved on the project row. */
  resolveEnv?: (projectId: string) => Record<string, string>;
  /** Default shell command (e.g. "/bin/zsh", "powershell.exe"). */
  shellCommand: () => string;
  /** Args for the shell — typically `["-l"]` on Unix to source profile
   *  files (Homebrew PATH, asdf, etc.) so split shells can find brew-
   *  installed tools when the app was launched from Finder. */
  shellArgs?: () => string[];
  /** T7.4 — return the project's default CLI when one is configured AND
   *  detected on PATH. Splits use this in preference to the system shell so
   *  new panes inherit the project's CLI choice; the user can still swap a
   *  pane via the per-pane CLI dropdown (T7.3). */
  resolveDefaultCli?: (projectId: string) => PaneHotkeyDefaultCli | null;
  /** Open the Add Project modal. */
  onAddProject: () => void;
  /** Surface a user-visible error from one of the IPC calls. */
  onError?: (message: string) => void;
}

const handleSplit = async (
  direction: SplitDirection,
  handlers: PaneHotkeyHandlers,
): Promise<void> => {
  const projectId = activeProjectId();
  if (!projectId) return;
  const ws = getWorkspace(projectId);
  if (!ws || !ws.focusedSessionId) return;
  const target = ws.focusedSessionId;
  const cwd = handlers.resolveCwd(projectId);
  const env = handlers.resolveEnv?.(projectId) ?? {};
  const defaultCli = handlers.resolveDefaultCli?.(projectId) ?? null;
  try {
    const resp = await ptySpawn({
      command: defaultCli ? defaultCli.path : handlers.shellCommand(),
      args: defaultCli ? [] : (handlers.shellArgs?.() ?? []),
      cwd: cwd ?? undefined,
      env: defaultCli
        ? { ...env, WS_PROJECT_ID: projectId, WS_CLI_NAME: defaultCli.name }
        : { ...env, WS_PROJECT_ID: projectId },
      cols: 80,
      rows: 24,
    });
    splitPane(projectId, target, direction, resp.sessionId);
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : String(err));
  }
};

const handleClose = async (handlers: PaneHotkeyHandlers): Promise<void> => {
  const projectId = activeProjectId();
  if (!projectId) return;
  const ws = getWorkspace(projectId);
  if (!ws || !ws.focusedSessionId) return;
  const closed = closePaneInStore(projectId, ws.focusedSessionId);
  if (closed === null) return;
  try {
    await ptyKill(closed);
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : String(err));
  }
};

export function installPaneHotkeys(handlers: PaneHotkeyHandlers): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;

    // Cmd+N — new project. Independent of pane focus.
    if (!e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      handlers.onAddProject();
      return;
    }

    // Cmd+\ / Cmd+Shift+\ — split focused pane.
    // KeyboardEvent.key is "\\" both with and without Shift; check via key.
    if (e.key === "\\") {
      e.preventDefault();
      void handleSplit(e.shiftKey ? "v" : "h", handlers);
      return;
    }

    // Cmd+W — close focused pane.
    if (!e.shiftKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      void handleClose(handlers);
      return;
    }
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

/** Solid lifecycle wrapper. */
export function usePaneHotkeys(handlers: PaneHotkeyHandlers): void {
  onMount(() => {
    const dispose = installPaneHotkeys(handlers);
    onCleanup(dispose);
  });
}
