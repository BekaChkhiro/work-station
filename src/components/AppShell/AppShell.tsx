// T6.2: AppShell — wires Sidebar + per-project LayoutTree into one shell
// where switching projects swaps the visible tree without unmounting any
// of the other projects' Terminals.
//
// Render strategy: every registered project's LayoutTree is mounted at all
// times, stacked absolutely inside the workspace area. Only the active
// project's stack entry is visible (`display: flex`); the rest are hidden
// (`display: none`). That toggling triggers each Terminal's
// IntersectionObserver (T4.12), which pauses the live xterm subscription
// while hidden and resumes — replaying the full PTY scrollback — when
// shown again. The backend PTY keeps producing output the entire time,
// so the replay surfaces anything that arrived during the absence.
//
// The shell is purely a state consumer: project metadata, layouts, and
// focus all live in the workspace store (T6.2). The host page passes a
// `renderPane` callback so the Terminal wiring (cwd tracking, project-
// scoped search metadata, etc.) stays out of this file — it just deals
// in layout trees and sessionIds.

import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { LayoutTree } from "../LayoutTree";
import { ProjectsEmptyState } from "../ProjectsEmptyState";
import { Sidebar } from "../Sidebar";
import type { LayoutPath } from "../../types/layout";
import {
  activeProjectId,
  projects,
  sessionCount,
  setActiveProject,
  setFocusedSession,
  updateLayoutRatio,
  getWorkspace,
} from "../../stores/workspace";
import { useNumericProjectHotkeys } from "../../hotkeys/numericProjectHotkeys";

export interface AppShellProps {
  /** Render the contents of a single pane leaf for `projectId` / `sessionId`.
   *  Wired by the caller so the Terminal can be configured with project
   *  metadata, cwd tracking, etc. without leaking into AppShell. */
  renderPane: (projectId: string, sessionId: string) => JSX.Element;
  /** Optional sidebar collapsed state. Controlled by the caller so the
   *  shell stays presentational. */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onAddProject?: () => void;
  /** T6.6 — fires when the inline pencil-icon button on a sidebar row
   *  is pressed. The parent typically opens the project Edit modal. */
  onEditProject?: (projectId: string) => void;
  /** T6.6 — fires when a sidebar row is right-clicked. The parent owns
   *  the context-menu state and decides where to anchor it. */
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
  /** T6.7 — fires after a sidebar drag-to-reorder lands. The payload is
   *  the full project id list in its new order. The parent persists the
   *  ordering (DB `position` column) and updates the workspace store so
   *  the next render reflects the change. */
  onReorderProjects?: (nextIds: string[]) => void;
  onOpenSettings?: () => void;
  /** Placeholder rendered when a project has no layout (no panes). The
   *  caller can return a "spawn first pane" CTA, an empty illustration,
   *  whatever. Defaults to a quiet hint. */
  renderEmptyWorkspace?: (projectId: string) => JSX.Element;
}

const defaultEmptyWorkspace = (): JSX.Element => (
  <div class="flex h-full w-full items-center justify-center p-6 text-xs text-fg-secondary">
    No panes yet — open a terminal in this project to get started.
  </div>
);

export function AppShell(props: AppShellProps): JSX.Element {
  // T6.3: Cmd/Ctrl+1..9 jumps to project N by sidebar position. Suppressed
  // when focus is inside a terminal pane or text input — see hotkeys/
  // numericProjectHotkeys.ts.
  useNumericProjectHotkeys();

  return (
    <div class="ws-appshell relative grid h-full w-full grid-cols-[1fr_auto] bg-canvas text-fg">
      <div class="ws-appshell__workspace relative min-h-0">
        <Show when={projects().length === 0}>
          <ProjectsEmptyState onAddProject={() => props.onAddProject?.()} shortcut="⌘N" />
        </Show>
        <For each={projects()}>
          {(project) => {
            const isActive = (): boolean => activeProjectId() === project.id;
            return (
              <div
                class="absolute inset-0 flex min-h-0 flex-col"
                data-project-id={project.id}
                data-active={isActive() ? "true" : undefined}
                style={{ display: isActive() ? "flex" : "none" }}
                aria-hidden={!isActive()}
              >
                <ProjectWorkspaceView
                  projectId={project.id}
                  renderPane={props.renderPane}
                  renderEmpty={props.renderEmptyWorkspace ?? defaultEmptyWorkspace}
                />
              </div>
            );
          }}
        </For>
      </div>

      <Sidebar
        projects={projects().map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          glyph: p.glyph,
          sessions: sessionCount(p.id),
        }))}
        activeId={activeProjectId()}
        collapsed={props.sidebarCollapsed === true}
        onActivate={(id) => setActiveProject(id)}
        onAdd={() => props.onAddProject?.()}
        onEdit={props.onEditProject}
        onContextMenu={props.onProjectContextMenu}
        onReorder={props.onReorderProjects}
        onSettings={() => props.onOpenSettings?.()}
        onToggleCollapse={() => props.onToggleSidebar?.()}
        newProjectShortcut="⌘N"
      />
    </div>
  );
}

interface ProjectWorkspaceViewProps {
  projectId: string;
  renderPane: (projectId: string, sessionId: string) => JSX.Element;
  renderEmpty: (projectId: string) => JSX.Element;
}

function ProjectWorkspaceView(props: ProjectWorkspaceViewProps): JSX.Element {
  // The store accessor is reactive — when the layout or focus changes,
  // this component recomputes without remounting its Terminals (LayoutTree
  // memoises pane subtrees by sessionId, T5.4).
  const workspace = (): ReturnType<typeof getWorkspace> => getWorkspace(props.projectId);
  const layout = (): NonNullable<ReturnType<typeof getWorkspace>>["layout"] => {
    const ws = workspace();
    return ws ? ws.layout : null;
  };
  const focusedSessionId = (): string | null => {
    const ws = workspace();
    return ws ? ws.focusedSessionId : null;
  };

  const handleRatio = (path: LayoutPath, ratio: number): void => {
    updateLayoutRatio(props.projectId, path, ratio);
  };

  const handleFocus = (sessionId: string): void => {
    setFocusedSession(props.projectId, sessionId);
  };

  const renderLeaf = (sessionId: string): JSX.Element =>
    props.renderPane(props.projectId, sessionId);

  return (
    <div class="ws-appshell__pane-host relative flex min-h-0 flex-1 flex-col">
      <Show when={layout()} fallback={props.renderEmpty(props.projectId)}>
        {(node) => (
          <div class="min-h-0 flex-1">
            <LayoutTree
              node={node()}
              renderPane={renderLeaf}
              onRatioChange={handleRatio}
              focusedSessionId={focusedSessionId()}
              onFocusPane={handleFocus}
            />
          </div>
        )}
      </Show>
    </div>
  );
}

export default AppShell;
