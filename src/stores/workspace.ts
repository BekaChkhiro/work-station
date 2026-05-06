// T6.2: workspace store — per-project layout + active project switching.
//
// The store keeps each project's runtime state (layout tree + focused
// pane) in memory at the same time. Switching projects is a single
// `activeProjectId` write — every project's LayoutTree (and the
// Terminals it owns) stays mounted in the DOM at all times, so PTY
// subscriptions for the inactive projects keep streaming into xterm's
// scrollback without remount churn.
//
// Hiding inactive workspaces via `display: none` is intentional: it
// trips the Terminal's IntersectionObserver (T4.12) so xterm pauses
// its render path while the project is off-screen. The backend PTY
// keeps producing output into its scrollback ring, and on switch-back
// the Terminal resumes the subscription, reset()s xterm, and replays
// the full snapshot — which now contains anything that arrived during
// the absence. That's the load-bearing piece of T6.2's acceptance:
//   "Switch A→B→A: project A terminals show output that arrived while
//    B was active."
//
// The store is purely client-side state. Persistence (T5.8 layout_json)
// and launch-time restore (T2.12 / T5.9) live elsewhere — a workspace
// here exists from the moment the user opens a project until the app
// closes, regardless of whether it's been written to SQLite yet.

import { batch, createMemo } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { LayoutNode } from "../types/layout";
import { collectPanes, findPane, updateSplitRatio } from "../types/layout";

export interface ProjectMeta {
  id: string;
  name: string;
  /** CSS color used for the sidebar swatch. */
  color: string;
  /** Up to two characters drawn inside the swatch. */
  glyph: string;
}

export interface ProjectWorkspace {
  /** Root of the layout tree, or `null` for a project that has no panes
   *  open yet (empty workspace placeholder). */
  layout: LayoutNode | null;
  /** Currently focused pane within this project. Cleared when the focused
   *  pane is closed and there are no other panes. */
  focusedSessionId: string | null;
}

interface WorkspaceState {
  projects: ProjectMeta[];
  /** Project id → workspace. Kept dense — every entry in `projects` has a
   *  matching key here. Removed in lockstep with `removeProject`. */
  workspacesByProjectId: Record<string, ProjectWorkspace>;
  activeProjectId: string | null;
}

const [state, setState] = createStore<WorkspaceState>({
  projects: [],
  workspacesByProjectId: {},
  activeProjectId: null,
});

/** Snapshot of the current project list (reactive). */
export const projects = (): ProjectMeta[] => state.projects;

/** The id of the project currently shown in the workspace area. */
export const activeProjectId = (): string | null => state.activeProjectId;

/** Workspace for `projectId`, or `null` if the id isn't registered. */
export function getWorkspace(projectId: string): ProjectWorkspace | null {
  return state.workspacesByProjectId[projectId] ?? null;
}

/** Reactive accessor for the active project's workspace. */
export const activeWorkspace = createMemo<ProjectWorkspace | null>(() => {
  const id = state.activeProjectId;
  if (id === null) return null;
  return state.workspacesByProjectId[id] ?? null;
});

/** Number of running PTY sessions inside `projectId`'s layout tree. Used by
 *  the Sidebar's running-session badge. Reactive — recounts when the layout
 *  changes. */
export function sessionCount(projectId: string): number {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws || !ws.layout) return 0;
  return collectPanes(ws.layout).length;
}

/** Register a project + its initial workspace. Idempotent on `id`: a second
 *  call with the same id replaces the metadata and resets the workspace. */
export function addProject(meta: ProjectMeta, initial: ProjectWorkspace): void {
  setState(
    produce((s) => {
      const existing = s.projects.findIndex((p) => p.id === meta.id);
      if (existing >= 0) {
        s.projects[existing] = meta;
      } else {
        s.projects.push(meta);
      }
      s.workspacesByProjectId[meta.id] = initial;
      if (s.activeProjectId === null) s.activeProjectId = meta.id;
    }),
  );
}

/** Remove a project and its workspace. The caller is responsible for killing
 *  the PTYs referenced by the layout tree before invoking this — the store
 *  doesn't reach into the IPC layer on its own. If `projectId` was active,
 *  activeProjectId falls back to the first remaining project (or null). */
export function removeProject(projectId: string): void {
  setState(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx >= 0) s.projects.splice(idx, 1);
      // Rebuild without the removed key — `delete` on a dynamically-computed
      // store path trips a lint rule and the store's reactive proxy doesn't
      // benefit from in-place deletion either.
      const next: Record<string, ProjectWorkspace> = {};
      for (const [key, value] of Object.entries(s.workspacesByProjectId)) {
        if (key !== projectId) next[key] = value;
      }
      s.workspacesByProjectId = next;
      if (s.activeProjectId === projectId) {
        s.activeProjectId = s.projects[0]?.id ?? null;
      }
    }),
  );
}

/** Switch the active project. No-op if `projectId` isn't registered or is
 *  already active. */
export function setActiveProject(projectId: string): void {
  if (state.activeProjectId === projectId) return;
  if (!state.workspacesByProjectId[projectId]) return;
  setState("activeProjectId", projectId);
}

/** Replace the layout tree for a project. Layout mutations (updateSplitRatio,
 *  splitPaneAt, closePaneAt) preserve untouched subtree references on their
 *  own — required for T5.4's no-remount contract to survive across switches.
 *  We cast around Solid's deep-store typing because LayoutNode is a recursive
 *  discriminated union; the store treats the value opaquely. */
export function setLayout(projectId: string, layout: LayoutNode | null): void {
  if (!state.workspacesByProjectId[projectId]) return;
  setState(
    produce((s) => {
      const ws = s.workspacesByProjectId[projectId];
      if (!ws) return;
      ws.layout = layout;
    }),
  );
}

/** Update a single split's ratio inside `projectId`'s layout. The path
 *  uses LayoutTree's "L"/"R" encoding — see `updateSplitRatio` in
 *  types/layout. No-op when the path doesn't resolve to a split. */
export function updateLayoutRatio(projectId: string, path: string, ratio: number): void {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws || !ws.layout) return;
  const next = updateSplitRatio(ws.layout, path, ratio);
  if (next === ws.layout) return;
  setLayout(projectId, next);
}

/** Set the focused pane inside `projectId`. The id must reference a pane
 *  currently in the layout; otherwise the focus is left unchanged so a
 *  stale event doesn't strand focus on a dead session. */
export function setFocusedSession(projectId: string, sessionId: string | null): void {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws) return;
  if (sessionId !== null) {
    if (!ws.layout || !findPane(ws.layout, sessionId)) return;
  }
  setState("workspacesByProjectId", projectId, "focusedSessionId", sessionId);
}

/** Test-only — replace the full state. Not exported via the barrel. */
export function _resetWorkspaceForTests(): void {
  batch(() => {
    setState({
      projects: [],
      workspacesByProjectId: {},
      activeProjectId: null,
    });
  });
}
