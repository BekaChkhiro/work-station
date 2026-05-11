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
import type { LayoutNode, SplitDirection } from "../types/layout";
import {
  closePaneAt,
  collectPanes,
  findPane,
  replacePaneSessionAt,
  splitPaneAt,
  updateSplitRatio,
} from "../types/layout";
import {
  DEFAULT_ACTIVE_TAB,
  DEFAULT_VISIBLE_TABS,
  type WorkspaceTabKind,
} from "../types/workspaceTab";

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
  /** T11.1: ordered list of workspace tab kinds visible in this project's
   *  tab strip. Always includes `terminal`. Integration kinds appear here
   *  once the user links the service (T11.5). */
  visibleTabs: WorkspaceTabKind[];
  /** T11.1: which workspace tab body is currently rendered. Persisted per
   *  project (see AppRoot) so a launch lands on the same view. */
  activeTab: WorkspaceTabKind;
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
 *  call with the same id replaces the metadata and resets the workspace.
 *  When `initial` omits `visibleTabs` / `activeTab`, defaults are filled in
 *  so AppRoot can keep most call sites passing the layout-only shape. */
export function addProject(meta: ProjectMeta, initial: PartialWorkspaceInit): void {
  const normalised: ProjectWorkspace = {
    layout: initial.layout,
    focusedSessionId: initial.focusedSessionId,
    visibleTabs:
      initial.visibleTabs && initial.visibleTabs.length > 0
        ? [...initial.visibleTabs]
        : [...DEFAULT_VISIBLE_TABS],
    activeTab: initial.activeTab ?? DEFAULT_ACTIVE_TAB,
  };
  // Terminal is always part of the visible-tab list — the store is the
  // last line of defence against a corrupt DB payload sneaking in here.
  if (!normalised.visibleTabs.includes("terminal")) {
    normalised.visibleTabs.unshift("terminal");
  }
  if (!normalised.visibleTabs.includes(normalised.activeTab)) {
    normalised.activeTab = DEFAULT_ACTIVE_TAB;
  }
  setState(
    produce((s) => {
      const existing = s.projects.findIndex((p) => p.id === meta.id);
      if (existing >= 0) {
        s.projects[existing] = meta;
      } else {
        s.projects.push(meta);
      }
      s.workspacesByProjectId[meta.id] = normalised;
      if (s.activeProjectId === null) s.activeProjectId = meta.id;
    }),
  );
}

/** Shape accepted by `addProject`. The tab fields are optional so old call
 *  sites (and tests) that only set the layout/focus pair keep working. */
export interface PartialWorkspaceInit {
  layout: LayoutNode | null;
  focusedSessionId: string | null;
  visibleTabs?: readonly WorkspaceTabKind[];
  activeTab?: WorkspaceTabKind;
}

/** Update an already-registered project's metadata in place (T6.6).
 *  No-op when `id` isn't registered. The workspace (layout, focused
 *  session) is left untouched — only the sidebar-visible fields move. */
export function updateProjectMeta(id: string, patch: Partial<Omit<ProjectMeta, "id">>): void {
  setState(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const current = s.projects[idx];
      if (!current) return;
      s.projects[idx] = {
        ...current,
        ...patch,
      };
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

/** T6.7: rearrange the registered project list to match `nextIds`. The list
 *  must be a permutation of the currently-registered ids — extra ids,
 *  missing ids, or duplicates are no-ops so an out-of-sync caller can't
 *  silently drop projects from the sidebar. The persistence side (DB
 *  position column) is the caller's responsibility; this only moves the
 *  in-memory order so the Sidebar reflects the drop immediately. */
export function reorderProjects(nextIds: string[]): void {
  const current = state.projects;
  if (nextIds.length !== current.length) return;
  const seen = new Set<string>();
  for (const id of nextIds) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  const byId = new Map<string, ProjectMeta>();
  for (const p of current) byId.set(p.id, p);
  const next: ProjectMeta[] = [];
  for (const id of nextIds) {
    const meta = byId.get(id);
    if (!meta) return;
    next.push(meta);
  }
  setState("projects", next);
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

/** Split the pane carrying `targetSessionId` along `direction` and place a
 *  new pane carrying `newSessionId` next to it. Updates focus to the new
 *  pane so the spawned shell receives input immediately. No-op if the
 *  target pane isn't in the layout. The PTY for `newSessionId` must be
 *  spawned by the caller before this is called — the store does not reach
 *  into the IPC layer. */
export function splitPane(
  projectId: string,
  targetSessionId: string,
  direction: SplitDirection,
  newSessionId: string,
): void {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws || !ws.layout) return;
  const next = splitPaneAt(ws.layout, targetSessionId, direction, newSessionId);
  if (next === ws.layout) return;
  setState(
    produce((s) => {
      const w = s.workspacesByProjectId[projectId];
      if (!w) return;
      w.layout = next;
      w.focusedSessionId = newSessionId;
    }),
  );
}

/** Replace the pane carrying `targetSessionId` with `newSessionId`, preserving
 * the surrounding layout shape. Returns the replaced session id so callers can
 * kill the old PTY after the new one is visible. */
export function replacePane(
  projectId: string,
  targetSessionId: string,
  newSessionId: string,
): string | null {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws || !ws.layout) return null;
  if (!findPane(ws.layout, targetSessionId)) return null;
  const next = replacePaneSessionAt(ws.layout, targetSessionId, newSessionId);
  if (next === ws.layout) return null;
  setState(
    produce((s) => {
      const w = s.workspacesByProjectId[projectId];
      if (!w) return;
      w.layout = next;
      w.focusedSessionId = newSessionId;
    }),
  );
  return targetSessionId;
}

/** Remove the pane carrying `targetSessionId` from `projectId`'s layout.
 *  Returns the closed sessionId so the caller can kill the matching PTY,
 *  or `null` when the target was not in the layout. After the close the
 *  surviving sibling's leftmost pane gets focus; if the closed pane was
 *  the only one, the layout drops to `null` and focus clears. */
export function closePane(projectId: string, targetSessionId: string): string | null {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws || !ws.layout) return null;
  if (!findPane(ws.layout, targetSessionId)) return null;
  const result = closePaneAt(ws.layout, targetSessionId);
  setState(
    produce((s) => {
      const w = s.workspacesByProjectId[projectId];
      if (!w) return;
      w.layout = result.tree;
      w.focusedSessionId = result.nextFocusSessionId;
    }),
  );
  return targetSessionId;
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

/** T11.1: change the active workspace tab for `projectId`. No-op when the
 *  target kind isn't in the project's visible-tabs list — a stale hotkey or
 *  menu action can't strand the user on a tab that isn't rendered. */
export function setActiveTab(projectId: string, kind: WorkspaceTabKind): void {
  const ws = state.workspacesByProjectId[projectId];
  if (!ws) return;
  if (ws.activeTab === kind) return;
  if (!ws.visibleTabs.includes(kind)) return;
  setState("workspacesByProjectId", projectId, "activeTab", kind);
}

/** T11.1: toggle visibility of a workspace tab kind. The Terminal tab
 *  cannot be hidden — closing the last pane drops panes, not the tab.
 *  Hiding the currently-active tab moves the active selection to the first
 *  remaining visible tab so the body stays in sync. */
export function setTabVisibility(
  projectId: string,
  kind: WorkspaceTabKind,
  visible: boolean,
): void {
  if (kind === "terminal" && !visible) return;
  const ws = state.workspacesByProjectId[projectId];
  if (!ws) return;
  const present = ws.visibleTabs.includes(kind);
  if (present === visible) return;
  setState(
    produce((s) => {
      const w = s.workspacesByProjectId[projectId];
      if (!w) return;
      if (visible) {
        w.visibleTabs = [...w.visibleTabs, kind];
        return;
      }
      w.visibleTabs = w.visibleTabs.filter((k) => k !== kind);
      if (w.activeTab === kind) {
        w.activeTab = w.visibleTabs[0] ?? DEFAULT_ACTIVE_TAB;
      }
    }),
  );
}

/** T11.1: reactive accessor for a project's workspace tab list. */
export function visibleTabs(projectId: string): WorkspaceTabKind[] {
  return state.workspacesByProjectId[projectId]?.visibleTabs ?? [];
}

/** T11.1: reactive accessor for a project's active workspace tab. */
export function activeTab(projectId: string): WorkspaceTabKind {
  return state.workspacesByProjectId[projectId]?.activeTab ?? DEFAULT_ACTIVE_TAB;
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
