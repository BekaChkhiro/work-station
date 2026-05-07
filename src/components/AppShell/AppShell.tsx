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

import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { LayoutTree } from "../LayoutTree";
import type { PaneCliLaunchMode, PaneCliOption } from "../Pane";
import type { CliMeta } from "../../types/tab";
import { ProjectsEmptyState } from "../ProjectsEmptyState";
import { SettingsMenu } from "../SettingsMenu";
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
import { sessionList } from "../../stores/sessions";
import { useNumericProjectHotkeys } from "../../hotkeys/numericProjectHotkeys";
import { usePaneNavHotkeys } from "../../hotkeys/paneNavHotkeys";

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
  clis?: readonly PaneCliOption[];
  onLaunchCli?: (
    projectId: string,
    sessionId: string,
    cli: PaneCliOption,
    mode: PaneCliLaunchMode,
  ) => void;
  onLaunchFirstCli?: (projectId: string, cli: PaneCliOption) => void;
  /** T7.7 — resolve a project pane's CLI badge from its sessionId. The
   *  caller wires the spawn-time mapping (sessionId → CLI id) so the
   *  badge tracks what was actually launched, not what's currently in
   *  the pane's process tree. */
  resolveCli?: (projectId: string, sessionId: string) => { meta: CliMeta; label: string } | null;
  /** T7.8 — return the configured-but-missing CLI name for a project, or
   *  null when no warning is active. Drives the inline warning banner. */
  resolveCliWarning?: (projectId: string) => string | null;
  /** T7.8 — dismiss the CLI-not-found banner for a project. */
  onDismissCliWarning?: (projectId: string) => void;
  /** T7.8 — open install docs for the given CLI name in the default browser. */
  onInstallHint?: (cliName: string) => void;
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
  // only inside plain text inputs — terminal panes pass it through. See
  // hotkeys/numericProjectHotkeys.ts.
  useNumericProjectHotkeys();

  // Cmd/Ctrl+Alt+Arrow → move focus between panes inside the active
  // project. Geometry-based; see hotkeys/paneNavHotkeys.ts.
  usePaneNavHotkeys();

  // Settings popover anchored to the sidebar's footer cog.
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsAnchor, setSettingsAnchor] = createSignal<HTMLButtonElement | null>(null);

  // Auto-focus the previously focused pane whenever the active project
  // flips so the user can keep typing without an extra click. The display
  // toggle in the workspace area happens synchronously in this same render
  // pass; defer to the next microtask so xterm's hidden textarea has been
  // re-parented into a visible ancestor before we ask it to take focus.
  createEffect(() => {
    const projectId = activeProjectId();
    if (!projectId) return;
    const ws = getWorkspace(projectId);
    const sessionId = ws?.focusedSessionId;
    if (!sessionId) return;
    queueMicrotask(() => {
      // Re-check: a fast project flip could have changed the target while
      // we waited. Focus only if the resolved session is still current.
      if (activeProjectId() !== projectId) return;
      const live = getWorkspace(projectId);
      if (live?.focusedSessionId !== sessionId) return;
      const entry = sessionList().find((s) => s.id === sessionId);
      entry?.focus();
    });
  });

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
                aria-hidden={isActive() ? undefined : "true"}
              >
                <ProjectWorkspaceView
                  projectId={project.id}
                  renderPane={props.renderPane}
                  renderEmpty={props.renderEmptyWorkspace ?? defaultEmptyWorkspace}
                  clis={props.clis}
                  onLaunchCli={props.onLaunchCli}
                  onLaunchFirstCli={props.onLaunchFirstCli}
                  resolveCli={props.resolveCli}
                  cliWarning={props.resolveCliWarning?.(project.id) ?? null}
                  onDismissCliWarning={() => props.onDismissCliWarning?.(project.id)}
                  onInstallHint={props.onInstallHint}
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
        onSettings={() => {
          setSettingsOpen((open) => !open);
          props.onOpenSettings?.();
        }}
        onSettingsAnchor={setSettingsAnchor}
        onToggleCollapse={() => props.onToggleSidebar?.()}
        newProjectShortcut="⌘N"
      />
      <SettingsMenu
        open={settingsOpen()}
        anchor={settingsAnchor()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

interface ProjectWorkspaceViewProps {
  projectId: string;
  renderPane: (projectId: string, sessionId: string) => JSX.Element;
  renderEmpty: (projectId: string) => JSX.Element;
  clis?: readonly PaneCliOption[];
  onLaunchCli?: (
    projectId: string,
    sessionId: string,
    cli: PaneCliOption,
    mode: PaneCliLaunchMode,
  ) => void;
  onLaunchFirstCli?: (projectId: string, cli: PaneCliOption) => void;
  resolveCli?: (projectId: string, sessionId: string) => { meta: CliMeta; label: string } | null;
  cliWarning?: string | null;
  onDismissCliWarning?: () => void;
  onInstallHint?: (cliName: string) => void;
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
      <Show when={props.cliWarning}>
        {(missingCli) => (
          <div class="ws-cli-warning" role="alert" aria-live="polite">
            <span class="ws-cli-warning__icon" aria-hidden="true">
              ⚠
            </span>
            <span class="ws-cli-warning__text">
              <strong class="ws-cli-warning__name">{missingCli()}</strong>
              {" was not found on PATH. Launched fallback shell instead."}
              <Show when={props.onInstallHint}>
                {" "}
                <button
                  type="button"
                  class="ws-cli-warning__link"
                  onClick={() => props.onInstallHint?.(missingCli())}
                >
                  Install instructions
                </button>
              </Show>
            </span>
            <button
              type="button"
              class="ws-cli-warning__dismiss"
              aria-label="Dismiss warning"
              onClick={() => props.onDismissCliWarning?.()}
            >
              ×
            </button>
          </div>
        )}
      </Show>
      <Show
        when={layout()}
        fallback={
          props.onLaunchFirstCli ? (
            <ProjectTerminalEmptyState
              clis={props.clis ?? []}
              onLaunch={(cli) => props.onLaunchFirstCli?.(props.projectId, cli)}
            />
          ) : (
            props.renderEmpty(props.projectId)
          )
        }
      >
        {(node) => (
          <div class="min-h-0 flex-1">
            <LayoutTree
              node={node()}
              renderPane={renderLeaf}
              onRatioChange={handleRatio}
              focusedSessionId={focusedSessionId()}
              onFocusPane={handleFocus}
              clis={props.clis}
              onLaunchCli={(sessionId, cli, mode) =>
                props.onLaunchCli?.(props.projectId, sessionId, cli, mode)
              }
              resolveCli={
                props.resolveCli
                  ? (sessionId) => props.resolveCli?.(props.projectId, sessionId) ?? null
                  : undefined
              }
            />
          </div>
        )}
      </Show>
    </div>
  );
}

interface ProjectTerminalEmptyStateProps {
  clis: readonly PaneCliOption[];
  onLaunch: (cli: PaneCliOption) => void;
}

function ProjectTerminalEmptyState(props: ProjectTerminalEmptyStateProps): JSX.Element {
  return (
    <div class="ws-project-empty" role="region" aria-label="No terminals in this project">
      <div class="ws-project-empty__panel">
        <div class="ws-project-empty__title">No terminals open</div>
        <div class="ws-project-empty__subtitle">Start a new terminal for this project.</div>
        <Show
          when={props.clis.length > 0}
          fallback={<div class="ws-project-empty__note">No detected CLIs are available.</div>}
        >
          <div class="ws-project-empty__grid" role="list">
            <For each={props.clis}>
              {(cli) => (
                <button
                  type="button"
                  class="ws-project-empty__cli"
                  role="listitem"
                  onClick={() => props.onLaunch(cli)}
                >
                  <span class="ws-project-empty__dot" aria-hidden="true" />
                  <span class="ws-project-empty__cli-main">
                    <span class="ws-project-empty__cli-name">{cli.name}</span>
                    <span class="ws-project-empty__cli-path">{cli.path}</span>
                  </span>
                  <Show when={cli.version}>
                    {(version) => <span class="ws-project-empty__version">{version()}</span>}
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

export default AppShell;
