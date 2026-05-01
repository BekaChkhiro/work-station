/**
 * Default hotkey handlers — T8.2.
 *
 * Wires up the action handlers for all default keybindings.  Each handler
 * integrates with the appropriate store (projects, layout, CLI) and IPC
 * layer to perform the actual work.
 */

import type { HotkeyAction } from "../types/hotkey";
import { isMac } from "../types/hotkey";
import { ptyKill, ptySpawn, ptyWrite } from "../ipc";
import {
  getActivePaneId,
  getProjectLayout,
  removePane,
  setActivePane,
  setProjectLayout,
  splitPane,
} from "./layout";
import {
  getActiveProject,
  getProjects,
  selectProject,
} from "./projects";
import { availableClis } from "./cli";
import { setHotkeyHandler } from "./hotkey";

/* ─── Helpers ─── */

/** Pick a sensible fallback shell when no explicit CLI is configured. */
function getDefaultShell(): string {
  const clis = availableClis();
  for (const name of ["zsh", "bash", "pwsh"]) {
    const found = clis.find((c) => c.name === name);
    if (found) return found.path;
  }
  return isMac ? "/bin/zsh" : "/bin/bash";
}

/** Spawn a PTY for the active project and add it to the layout. */
function spawnForActiveProject(direction?: "vertical" | "horizontal"): void {
  const project = getActiveProject();
  if (!project) return;

  const command = project.default_cli ?? getDefaultShell();
  let projectEnv: Record<string, string> = {};
  if (project.env_json) {
    try {
      projectEnv = JSON.parse(project.env_json) as Record<string, string>;
    } catch {
      console.warn("[hotkey] Invalid env_json for project", project.name);
    }
  }
  ptySpawn(project.path, command, projectEnv, 80, 24)
    .then((sessionId) => {
      const layout = getProjectLayout(project.id);
      if (!layout) {
        // First terminal in this project — make it the root pane.
        setProjectLayout(project.id, { type: "pane", sessionId });
      } else {
        const activeSessionId = getActivePaneId(project.id);
        if (activeSessionId && direction) {
          splitPane(project.id, activeSessionId, direction, sessionId);
        } else {
          // No active pane tracked — overwrite root (edge case).
          setProjectLayout(project.id, { type: "pane", sessionId });
        }
      }
      setActivePane(project.id, sessionId);

      // Run per-project startup commands if configured
      if (project.startup_commands) {
        const commands = project.startup_commands
          .split("\n")
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        commands.forEach((cmd, i) => {
          setTimeout(() => {
            const data = new TextEncoder().encode(cmd + "\r\n");
            ptyWrite(sessionId, data).catch((err: unknown) => {
              console.error("[hotkey] Failed to write startup command:", err);
            });
          }, 100 * (i + 1));
        });
      }
    })
    .catch((err: unknown) => {
      console.error("[hotkey] Failed to spawn terminal:", err);
    });
}

/* ─── Action handlers ─── */

function handleNewTerminal(): void {
  spawnForActiveProject("vertical");
}

function handleSplitVertical(): void {
  spawnForActiveProject("vertical");
}

function handleSplitHorizontal(): void {
  spawnForActiveProject("horizontal");
}

function handleClosePane(): void {
  const project = getActiveProject();
  if (!project) return;

  const activeSessionId = getActivePaneId(project.id);
  if (!activeSessionId) return;

  removePane(project.id, activeSessionId);
  ptyKill(activeSessionId).catch((err: unknown) => {
    console.error("[hotkey] Failed to kill session:", err);
  });
}

function handleFocusProject(index: number): () => void {
  return () => {
    const projects = getProjects();
    const project = projects[index];
    if (project) {
      selectProject(project.id);
    }
  };
}

function handleOpenSwitcher(): void {
  console.log("[hotkey] open-switcher — not yet implemented (T8.4)");
}

function handleOpenSettings(): void {
  console.log("[hotkey] open-settings — not yet implemented (T8.7)");
}

function handleFind(): void {
  console.log("[hotkey] find — not yet implemented (T8.8)");
}

/* ─── Registration ─── */

/** Attach handlers for every default action.  Safe to call multiple times. */
export function registerDefaultHandlers(): void {
  setHotkeyHandler("new-terminal", handleNewTerminal);
  setHotkeyHandler("split-vertical", handleSplitVertical);
  setHotkeyHandler("split-horizontal", handleSplitHorizontal);
  setHotkeyHandler("close-pane", handleClosePane);
  setHotkeyHandler("open-switcher", handleOpenSwitcher);
  setHotkeyHandler("open-settings", handleOpenSettings);
  setHotkeyHandler("find", handleFind);

  for (let i = 1; i <= 9; i++) {
    setHotkeyHandler(
      `focus-project-${i}` as HotkeyAction,
      handleFocusProject(i - 1),
    );
  }
}
