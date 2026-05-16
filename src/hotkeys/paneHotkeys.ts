// Pane / project hotkeys for the production AppRoot.
//
// Bindings (Cmd on macOS, Ctrl elsewhere):
//   • Cmd/Ctrl + \           → split-v: panes side-by-side (vertical divider)
//   • Cmd/Ctrl + Shift + \   → split-h: panes stacked (horizontal divider)
//   • Cmd/Ctrl + W           → close focused pane (kills its PTY)
//   • Cmd/Ctrl + N           → open the Add Project modal
//
// The action ids `split-v` / `split-h` describe what the user sees (which
// way the divider runs). `SplitPane`'s `direction` parameter names the
// layout axis instead — so `split-v` produces direction "h" and `split-h`
// produces direction "v". The mapping happens here so the registry stays in
// user-facing terms.
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
  activeTab,
  closePane as closePaneInStore,
  getWorkspace,
  splitPane,
} from "../stores/workspace";
import type { SplitDirection } from "../types/layout";
import { dispatchMenuAction } from "../menu";
import { eventMatchesBinding, getBinding } from "./registry";
import { cloudMode } from "../stores/cloudMode";

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
  /** T7.6 — startup commands written to the freshly-spawned shell after
   *  subscribers attach. Returned in the order they should run. Empty list
   *  / undefined skips the feature. */
  resolveStartupCommands?: (projectId: string) => readonly string[];
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
  /** T7.7 — fired after a hotkey-driven split spawns a new PTY so the
   *  parent can register the session→CLI mapping for the badge. The
   *  `cliName` is the canonical CLI id when a default CLI was used,
   *  or `null` when the spawn fell through to the system shell. */
  onSessionSpawned?: (sessionId: string, cliName: string | null) => void;
  /** T7.7 — fired after a hotkey-driven pane close so the parent can
   *  forget the session→CLI mapping. */
  onSessionClosed?: (sessionId: string) => void;
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
  const startupCommands = handlers.resolveStartupCommands?.(projectId) ?? [];
  const defaultCli = handlers.resolveDefaultCli?.(projectId) ?? null;
  // Local mode hands the spawn an absolute path resolved on this Mac
  // (`cliListAvailable` + `defaultShell()`). The cloud-agent's
  // filesystem doesn't have those paths, so cloud mode falls back to
  // a bare command name and lets the remote host's PATH resolve it.
  // The shell fallback also swaps zsh for bash in cloud mode — Ubuntu
  // doesn't ship zsh by default and `/bin/zsh` would 404 on the VPS.
  const inCloud = cloudMode();
  const cliCommand = defaultCli
    ? inCloud
      ? defaultCli.name
      : defaultCli.path
    : inCloud
      ? "bash"
      : handlers.shellCommand();
  try {
    const resp = await ptySpawn({
      command: cliCommand,
      args: defaultCli ? [] : (handlers.shellArgs?.() ?? []),
      cwd: cwd ?? undefined,
      env: defaultCli
        ? { ...env, WS_PROJECT_ID: projectId, WS_CLI_NAME: defaultCli.name }
        : { ...env, WS_PROJECT_ID: projectId },
      startupCommands: startupCommands.length > 0 ? Array.from(startupCommands) : undefined,
      cols: 80,
      rows: 24,
    });
    handlers.onSessionSpawned?.(resp.sessionId, defaultCli ? defaultCli.name : null);
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
  handlers.onSessionClosed?.(closed);
  try {
    await ptyKill(closed);
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : String(err));
  }
};

export function installPaneHotkeys(handlers: PaneHotkeyHandlers): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const addProject = getBinding("add-project");
    if (addProject && eventMatchesBinding(e, addProject)) {
      e.preventDefault();
      handlers.onAddProject();
      return;
    }

    const splitV = getBinding("split-v");
    if (splitV && eventMatchesBinding(e, splitV)) {
      e.preventDefault();
      // User-facing "vertical split" = SplitPane horizontal layout.
      void handleSplit("h", handlers);
      return;
    }

    const splitH = getBinding("split-h");
    if (splitH && eventMatchesBinding(e, splitH)) {
      e.preventDefault();
      // User-facing "horizontal split" = SplitPane vertical layout.
      void handleSplit("v", handlers);
      return;
    }

    const closePane = getBinding("close-pane");
    if (closePane && eventMatchesBinding(e, closePane)) {
      e.preventDefault();
      // T13.6 — when the editor workspace tab is active, Cmd/Ctrl+W
      // closes the focused editor sub-tab instead of killing the
      // terminal pane underneath. The editor body owns the menu-action
      // listener; we just route the keystroke through `close-editor-tab`
      // and let EditorWorkspace handle the dirty-buffer confirmation.
      const projectId = activeProjectId();
      if (projectId && activeTab(projectId) === "editor") {
        dispatchMenuAction("close-editor-tab");
        return;
      }
      void handleClose(handlers);
      return;
    }

    // T13.4 — On macOS the native menu accelerator captures Cmd+S before it
    // reaches the webview, so this branch is dead code there. On Windows /
    // Linux there is no native menu owning the accelerator, so we surface the
    // keystroke as the same `save-file` menu action — EditorWorkspace's
    // listener handles the rest (tab focus check, dirty check, dispatch).
    const saveFile = getBinding("save-file");
    if (saveFile && eventMatchesBinding(e, saveFile)) {
      e.preventDefault();
      dispatchMenuAction("save-file");
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
