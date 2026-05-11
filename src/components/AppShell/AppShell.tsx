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

import { For, Show, createEffect, onCleanup, onMount, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { LayoutTree } from "../LayoutTree";
import type { PaneCliLaunchMode, PaneCliOption } from "../Pane";
import type { CliMeta } from "../../types/tab";
import { ProjectsEmptyState } from "../ProjectsEmptyState";
import { Sidebar } from "../Sidebar";
import { WindowsAppMenu } from "../WindowsAppMenu";
import { IntegrationTabPlaceholder, WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { IntegrationReauthBanner } from "../IntegrationReauthBanner";
import { PlanFlowTaskList } from "../PlanFlowTaskList";
import { hydrateReauthState, reauthSnapshot } from "../../integrations";
import { addMenuActionListener, dispatchMenuAction } from "../../menu";
import type { LayoutPath } from "../../types/layout";
import type { WorkspaceTabKind } from "../../types/workspaceTab";
import {
  activeProjectId,
  activeTab,
  projects,
  sessionCount,
  setActiveProject,
  setActiveTab,
  setFocusedSession,
  updateLayoutRatio,
  getWorkspace,
  visibleTabs,
} from "../../stores/workspace";
import { activeTaskId } from "../../stores/activeTask";
import { sessionList } from "../../stores/sessions";
import { useNumericProjectHotkeys } from "../../hotkeys/numericProjectHotkeys";
import { usePaneNavHotkeys } from "../../hotkeys/paneNavHotkeys";
import { isWindows } from "../../utils/platform";

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
  /** T7.8 — return true when a known install URL exists for `cliName`.
   *  Controls whether the "Install instructions" button is rendered at all. */
  hasInstallUrl?: (cliName: string) => boolean;
  /** Placeholder rendered when a project has no layout (no panes). The
   *  caller can return a "spawn first pane" CTA, an empty illustration,
   *  whatever. Defaults to a quiet hint. */
  renderEmptyWorkspace?: (projectId: string) => JSX.Element;
  /** T11.1 — fires when the user clicks a workspace tab (Terminal / Editor /
   *  integrations). The shell updates the store synchronously so the body
   *  switches without waiting; the caller hooks this to debounce-persist the
   *  active tab. */
  onWorkspaceTabChange?: (projectId: string, kind: WorkspaceTabKind) => void;
  /** T11.1 — open Settings (used by the integration-tab placeholder CTA). */
  onOpenSettings?: () => void;
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

  // T11.8 — load the persisted `needs_reauth` flags before the first
  // integration tab can request them. Hydration is idempotent and runs
  // once per app launch; the banner stays absent until the await
  // resolves, which is the right behaviour (don't flash a stale
  // warning before SQLite has been read).
  void hydrateReauthState();

  // Settings UI moved to the full-window `SettingsPanel` (T8.7). The
  // shell only listens for navigation-relevant menu actions here;
  // `open-settings` is owned by `App.tsx`, which mounts the panel.
  onMount(() => {
    const dispose = addMenuActionListener((id) =>
      untrack(() => {
        if (id === "new-project") {
          props.onAddProject?.();
          return;
        }
        if (id === "toggle-sidebar") {
          props.onToggleSidebar?.();
          return;
        }
        if (id.startsWith("switch-project-")) {
          const index = Number(id.slice("switch-project-".length)) - 1;
          const project = untrack(() => projects()[index]);
          if (project) setActiveProject(project.id);
        }
      }),
    );
    onCleanup(dispose);
  });

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
      <Show when={isWindows}>
        <WindowsAppMenu />
      </Show>
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
                  hasInstallUrl={props.hasInstallUrl}
                  onWorkspaceTabChange={
                    props.onWorkspaceTabChange
                      ? (kind) => props.onWorkspaceTabChange?.(project.id, kind)
                      : undefined
                  }
                  onOpenSettings={
                    props.onOpenSettings ?? (() => dispatchMenuAction("open-settings"))
                  }
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
        onSettings={() => dispatchMenuAction("open-settings")}
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
  hasInstallUrl?: (cliName: string) => boolean;
  onWorkspaceTabChange?: (kind: WorkspaceTabKind) => void;
  onOpenSettings?: () => void;
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
  const tabs = (): readonly WorkspaceTabKind[] => visibleTabs(props.projectId);
  const currentTab = (): WorkspaceTabKind => activeTab(props.projectId);
  // T12.4 — surface the in-progress PlanFlow task id as a pill on the
  // PlanFlow tab so the user can see at a glance which task they're
  // holding the lock for, regardless of which tab is currently focused.
  const tabBadges = (): Partial<Record<WorkspaceTabKind, string>> => {
    const taskId = activeTaskId(props.projectId);
    return taskId ? { planflow: taskId } : {};
  };

  // T11.8 — reauth is keyed by integration id, which lines up 1:1 with
  // the integration WorkspaceTabKind values (`planflow` / `github` /
  // etc.). Core tabs ("terminal" / "editor") never appear in the
  // reauth map.
  const reauth = reauthSnapshot();
  const tabNeedsReauth = (kind: WorkspaceTabKind): boolean => reauth.map()[kind] === true;
  const integrationTabActive = (): boolean =>
    currentTab() !== "terminal" && currentTab() !== "editor";

  const handleRatio = (path: LayoutPath, ratio: number): void => {
    updateLayoutRatio(props.projectId, path, ratio);
  };

  const handleFocus = (sessionId: string): void => {
    setFocusedSession(props.projectId, sessionId);
  };

  const handleTabActivate = (kind: WorkspaceTabKind): void => {
    setActiveTab(props.projectId, kind);
    props.onWorkspaceTabChange?.(kind);
  };

  const renderLeaf = (sessionId: string): JSX.Element =>
    props.renderPane(props.projectId, sessionId);

  return (
    <div class="ws-appshell__pane-host relative flex min-h-0 flex-1 flex-col">
      <WorkspaceTabStrip
        tabs={tabs()}
        activeKind={currentTab()}
        tabBadges={tabBadges()}
        onActivate={handleTabActivate}
      />
      <Show when={props.cliWarning}>
        {(missingCli) => (
          <div class="ws-cli-warning" role="alert" aria-live="polite">
            <span class="ws-cli-warning__icon" aria-hidden="true">
              ⚠
            </span>
            <span class="ws-cli-warning__text">
              <strong class="ws-cli-warning__name">{missingCli()}</strong>
              {" was not found on PATH. Launched fallback shell instead."}
              <Show when={props.hasInstallUrl?.(missingCli())}>
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
      {/* Body switches by active tab. Non-terminal tabs render their
       *  placeholder while the real content lands in T12.x–T17.x. The
       *  terminal body stays mounted across tab flips so xterm state and
       *  PTY subscriptions survive — hiding via display:none would also
       *  pause xterm via T4.12's IntersectionObserver, which is undesired
       *  here (the layout is still semantically "active" inside the
       *  project, just visually behind another tab). For T11.1 we
       *  conditionally render instead since switching to an integration
       *  tab is rare; a future revisit can switch to display:none if PTY
       *  output during off-tab time becomes load-bearing. */}
      <Show when={integrationTabActive() && tabNeedsReauth(currentTab())}>
        <IntegrationReauthBanner kind={currentTab()} onReconnect={() => props.onOpenSettings?.()} />
      </Show>
      <Show
        when={currentTab() === "terminal"}
        fallback={
          <Show
            when={currentTab() === "planflow" && !tabNeedsReauth("planflow")}
            fallback={
              <IntegrationTabPlaceholder
                kind={currentTab()}
                onOpenSettings={props.onOpenSettings}
                needsReauth={tabNeedsReauth(currentTab())}
              />
            }
          >
            <PlanFlowTaskList projectId={props.projectId} onOpenSettings={props.onOpenSettings} />
          </Show>
        }
      >
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
