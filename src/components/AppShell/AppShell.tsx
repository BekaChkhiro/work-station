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

import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { FileTree } from "../FileTree";
import { LayoutTree } from "../LayoutTree";
import { MonacoDiff, MonacoEditor } from "../MonacoEditor";
import {
  readTextFile,
  writeTextFile,
  type ReadFileResult,
  type TextEncoding,
} from "../../ipc/files";
import {
  onExternalChange,
  startFileWatch,
  stopFileWatch,
  type ExternalChangeEvent,
} from "../../ipc/fileWatch";
import type { PaneCliLaunchMode, PaneCliOption } from "../Pane";
import type { CliMeta } from "../../types/tab";
import { ProjectsEmptyState } from "../ProjectsEmptyState";
import { Sidebar } from "../Sidebar";
import { WindowsAppMenu } from "../WindowsAppMenu";
import { IntegrationTabPlaceholder, WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { IntegrationReauthBanner } from "../IntegrationReauthBanner";
import { PlanFlowTaskList } from "../PlanFlowTaskList";
import { editorScratch, setEditorScratch } from "../../stores/editorScratch";
import { editorAutosaveMs } from "../../stores/editorAutosave";
import { cloudMode } from "../../stores/cloudMode";
import { getSetting, setSetting } from "../../db/settings";
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
  /** T13.2 — resolve a project's absolute root path so the editor tab can
   *  mount its file tree. Returning null hides the tree gracefully (the
   *  Monaco scratch buffer still renders), which keeps the prop optional
   *  for harnesses that don't track project paths. */
  resolveProjectPath?: (projectId: string) => string | null;
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
                  projectPath={props.resolveProjectPath?.(project.id) ?? null}
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
        onRequestCloudPair={() => dispatchMenuAction("open-settings")}
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
  /** T13.2 — absolute root path for the file tree, or null when unknown. */
  projectPath?: string | null;
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
            when={currentTab() === "editor"}
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
                <PlanFlowTaskList
                  projectId={props.projectId}
                  onOpenSettings={props.onOpenSettings}
                  clis={props.clis ?? []}
                />
              </Show>
            }
          >
            {/* T13.1 — Monaco editor + T13.2 file tree. When a file is
             *  picked in the tree the buffer becomes read-only and shows
             *  that file's contents (T13.3 wired); without a selection
             *  we fall back to the scratch buffer so the editor tab is
             *  never empty on first open. */}
            <EditorWorkspace projectId={props.projectId} projectPath={props.projectPath ?? null} />
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

/**
 * T13.2 / T13.4 / T13.6 — editor tab body: [file tree | tabs | Monaco].
 *
 * Layout: fixed-width file tree on the left; editor pane on the right
 * containing a horizontal sub-tab strip atop the Monaco host. The tree is
 * hidden when the project root is unknown so the editor still works as a
 * scratch buffer.
 *
 * Tab list (T13.6):
 *   • Clicking a file in the tree opens a new sub-tab or activates an
 *     existing one keyed by absolute path.
 *   • Sub-tabs persist per-project in `editor_tabs_by_project` and are
 *     restored on mount. Files that can't be read on restore drop out of
 *     the list silently (the on-disk file is the source of truth).
 *   • Cmd/Ctrl+W routes to `close-editor-tab` whenever the editor is the
 *     active workspace tab — the keystroke is otherwise the close-pane
 *     accelerator for terminals (see paneHotkeys / AppRoot).
 *   • Closing a dirty tab prompts via `window.confirm`. The buffer's
 *     dirty state lives on the tab itself (`content !== baseline`).
 *
 * Per-tab state machine (unchanged from T13.3/T13.4):
 *   • "loading"  → placeholder text, read-only
 *   • "text"     → editable; baseline snapshot drives the dirty flag and
 *                   save reconciliation
 *   • "binary"   → read-only placeholder
 *   • "error"    → read-only placeholder with the IO error message
 *
 * Save flow (T13.4):
 *   • Cmd/Ctrl+S → `save-file` menu action. Saves the active tab if dirty.
 *   • Optional debounced auto-save fires per-tab when `editor_autosave_ms`
 *     > 0; each tab carries its own timer so typing in tab A then
 *     switching to B doesn't drop A's pending save.
 *   • Successful saves update `baseline` so the dirty indicator clears
 *     without re-reading from disk.
 *
 * MonacoEditor is value-bound (one model); switching tabs swaps the
 * buffer text. Cursor / scroll / undo do NOT survive a tab switch — a
 * future revisit can move to per-tab `IModel` instances and
 * `editor.setModel()`. The acceptance criteria for T13.6 only require
 * content survival, which the tab list gives us.
 */
/** T13.5 — pending external-change prompt for a single text tab. `mode`
 *  controls whether the user sees the slim banner above the editor or
 *  the full side-by-side Monaco diff swapped in for the editor host. */
interface EditorConflict {
  mode: "banner" | "diff";
  /** Content read from disk by the watcher when the change was detected. */
  newContent: string;
  newEncoding: TextEncoding;
  /** Hex sha256 of the on-disk bytes — purely for debugging / telemetry;
   *  the UI compares strings, not hashes, when resolving the conflict. */
  newHash: string;
}

type EditorFileTab =
  | { kind: "loading"; path: string }
  | {
      kind: "text";
      path: string;
      relative: string;
      content: string;
      baseline: string;
      encoding: TextEncoding;
      saving: boolean;
      lastError: string | null;
      /** T13.5 — watch handle returned by `start_file_watch`. `null` until
       *  the watch is registered (briefly during the open transition, and
       *  for the duration of failed-to-arm cases). */
      watchId: number | null;
      /** T13.5 — non-null while an external change is awaiting resolution.
       *  Cleared by Reload / Keep Mine. */
      conflict: EditorConflict | null;
    }
  | { kind: "binary"; path: string; reason: string }
  | { kind: "error"; path: string; message: string };

function fileLabelFromPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

function EditorWorkspace(props: { projectId: string; projectPath: string | null }): JSX.Element {
  const [tabs, setTabs] = createSignal<EditorFileTab[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);

  // Per-path race guard. A slow read on /big.txt followed by a fast read
  // on /readme.md should land each result in its own tab; tokens prevent
  // a late read from clobbering a tab that has already been edited or
  // closed in the meantime.
  const openTokens = new Map<string, number>();
  // Per-tab autosave timer. Survives tab switches so a buffer that was
  // typed-in but then deactivated still flushes after the debounce window.
  const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearAutosaveTimer = (path: string): void => {
    const t = autosaveTimers.get(path);
    if (t !== undefined) {
      clearTimeout(t);
      autosaveTimers.delete(path);
    }
  };

  const clearAllAutosaveTimers = (): void => {
    for (const t of autosaveTimers.values()) clearTimeout(t);
    autosaveTimers.clear();
  };

  const findTab = (path: string): EditorFileTab | undefined => tabs().find((t) => t.path === path);

  const activeTabValue = (): EditorFileTab | null => {
    const p = activePath();
    if (p === null) return null;
    return findTab(p) ?? null;
  };

  const updateTab = (
    path: string,
    updater: (prev: EditorFileTab) => EditorFileTab | null,
  ): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx === -1) return prev;
      const current = prev[idx];
      if (current === undefined) return prev;
      const next = updater(current);
      if (next === null) return prev;
      const out = prev.slice();
      out[idx] = next;
      return out;
    });
  };

  const toRelative = (root: string, absPath: string): string => {
    if (absPath.startsWith(`${root}/`)) return absPath.slice(root.length + 1);
    if (absPath.startsWith(`${root}\\`)) return absPath.slice(root.length + 1);
    return absPath;
  };

  // Load a path into a tab. If the tab already exists, leaves its buffer
  // alone (we don't want a stray click in the tree to refresh a tab the
  // user is editing). `silent` skips activation — used during restore so
  // we end up with a coherent active selection at the end, not whatever
  // happened to be the last entry in the persisted list.
  const openOrActivate = async (absPath: string, silent = false): Promise<void> => {
    const root = props.projectPath;
    if (root === null) return;
    const existing = findTab(absPath);
    if (existing) {
      if (!silent) setActivePath(absPath);
      return;
    }
    const relative = toRelative(root, absPath);
    const myToken = (openTokens.get(absPath) ?? 0) + 1;
    openTokens.set(absPath, myToken);
    setTabs((prev) => [...prev, { kind: "loading", path: absPath }]);
    if (!silent) setActivePath(absPath);
    try {
      const result: ReadFileResult = await readTextFile(root, relative);
      if (openTokens.get(absPath) !== myToken) return;
      // The tab might have been closed while the read was in flight.
      if (!findTab(absPath)) return;
      let next: EditorFileTab;
      if (result.kind === "text") {
        next = {
          kind: "text",
          path: absPath,
          relative,
          content: result.content,
          baseline: result.content,
          encoding: result.encoding,
          saving: false,
          lastError: null,
          watchId: null,
          conflict: null,
        };
      } else {
        const reason =
          result.reason === "nul-byte"
            ? "binary file (contains NUL bytes)"
            : "binary file (not valid UTF-8)";
        next = { kind: "binary", path: absPath, reason };
      }
      updateTab(absPath, () => next);
      // T13.5 — arm the file watcher after the tab is in place. We do
      // this *after* updateTab so a fast external write that hits between
      // start_file_watch and the state update can never race ahead of
      // the tab existing. `void` because watch failures aren't fatal:
      // the editor still works, just without external-change detection,
      // and the next open attempt will retry.
      if (next.kind === "text") {
        void armWatch(absPath, relative);
      }
    } catch (err) {
      if (openTokens.get(absPath) !== myToken) return;
      if (!findTab(absPath)) return;
      const message = err instanceof Error ? err.message : String(err);
      updateTab(absPath, () => ({ kind: "error", path: absPath, message }));
    }
  };

  const editorValue = (): string => {
    const t = activeTabValue();
    if (t === null) return editorScratch(props.projectId);
    if (t.kind === "loading") return "// Loading…";
    if (t.kind === "text") return t.content;
    if (t.kind === "binary") return `// ${t.path}\n//\n// Not displayed — ${t.reason}.`;
    return `// ${t.path}\n//\n// Could not open file: ${t.message}`;
  };

  const isReadOnly = (): boolean => {
    const t = activeTabValue();
    return t !== null && t.kind !== "text";
  };

  const isTabDirty = (t: EditorFileTab): boolean => t.kind === "text" && t.content !== t.baseline;

  const isActiveDirty = (): boolean => {
    const t = activeTabValue();
    return t !== null && isTabDirty(t);
  };

  const activeFileLabel = (): string | null => {
    const t = activeTabValue();
    return t === null ? null : fileLabelFromPath(t.path);
  };

  const saveStatus = (): "idle" | "saving" | "dirty" | "error" => {
    const t = activeTabValue();
    if (t?.kind !== "text") return "idle";
    if (t.saving) return "saving";
    if (t.lastError !== null) return "error";
    return isTabDirty(t) ? "dirty" : "idle";
  };

  const performSaveFor = async (targetPath: string): Promise<void> => {
    const root = props.projectPath;
    if (root === null) return;
    const current = findTab(targetPath);
    if (current?.kind !== "text") return;
    if (current.saving) return;
    if (current.content === current.baseline) return;

    const snapshot = current.content;
    updateTab(targetPath, (prev) =>
      prev.kind === "text" ? { ...prev, saving: true, lastError: null } : prev,
    );
    try {
      await writeTextFile(root, current.relative, snapshot, current.encoding);
      updateTab(targetPath, (prev) =>
        prev.kind === "text"
          ? { ...prev, baseline: snapshot, saving: false, lastError: null }
          : prev,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTab(targetPath, (prev) =>
        prev.kind === "text" ? { ...prev, saving: false, lastError: message } : prev,
      );
      console.warn("[editor] save failed", err);
    }
  };

  const performSaveActive = async (): Promise<void> => {
    const p = activePath();
    if (p === null) return;
    await performSaveFor(p);
  };

  // T13.5 — bookkeeping for the file watchers attached to text tabs.
  // The map keys are absolute paths (same key as the tab list). It
  // exists in addition to the `watchId` stored on each tab because we
  // need a fast lookup from event payload → tab path: events come in
  // with a watch ID, and we hold the ID-to-path mapping here.
  const watchIdToPath = new Map<number, string>();

  const stopWatchForTab = (tab: EditorFileTab): void => {
    if (tab.kind !== "text" || tab.watchId === null) return;
    const id = tab.watchId;
    watchIdToPath.delete(id);
    void stopFileWatch(id).catch((err) => {
      console.warn("[T13.5] stop_file_watch failed", err);
    });
  };

  const armWatch = async (absPath: string, relative: string): Promise<void> => {
    const root = props.projectPath;
    if (root === null) return;
    try {
      const watchId = await startFileWatch(root, relative);
      // The tab may have been closed (or replaced via re-open) while the
      // command was in flight. If it's no longer the same text tab we
      // armed for, drop the watch right back.
      const current = findTab(absPath);
      if (current?.kind !== "text" || current.watchId !== null) {
        void stopFileWatch(watchId).catch(() => undefined);
        return;
      }
      watchIdToPath.set(watchId, absPath);
      updateTab(absPath, (prev) => (prev.kind === "text" ? { ...prev, watchId } : prev));
    } catch (err) {
      console.warn("[T13.5] start_file_watch failed", err);
    }
  };

  // T13.5 — react to an external write surfaced by the backend.
  //   • clean buffer (content === baseline) → silent reload to the new
  //     disk content. Mirrors VS Code's "auto-reload on disk change"
  //     when there's nothing to lose.
  //   • dirty buffer → stage a conflict so the banner lets the user pick.
  // Late events (the tab was closed mid-flight, or another event already
  // replaced the conflict with a newer one) overwrite cleanly: the latest
  // disk state is always the canonical one to resolve against.
  const handleExternalChange = (event: ExternalChangeEvent): void => {
    const path = watchIdToPath.get(event.watchId);
    if (path === undefined) return;
    const tab = findTab(path);
    if (tab?.kind !== "text") return;
    // No-op if the file's bytes now match what's in the buffer
    // (e.g. the user edited the file to match an external write).
    if (event.content === tab.content && event.encoding === tab.encoding) {
      updateTab(path, (prev) =>
        prev.kind === "text"
          ? { ...prev, baseline: event.content, encoding: event.encoding, conflict: null }
          : prev,
      );
      return;
    }
    const buffered = tab.content;
    const isDirty = buffered !== tab.baseline;
    if (!isDirty) {
      updateTab(path, (prev) =>
        prev.kind === "text"
          ? {
              ...prev,
              content: event.content,
              baseline: event.content,
              encoding: event.encoding,
              conflict: null,
            }
          : prev,
      );
      return;
    }
    updateTab(path, (prev) =>
      prev.kind === "text"
        ? {
            ...prev,
            conflict: {
              mode: "banner",
              newContent: event.content,
              newEncoding: event.encoding,
              newHash: event.hash,
            },
          }
        : prev,
    );
  };

  // T13.5 — Reload: discard the buffer's edits, snap to disk content.
  // We update both `content` and `baseline` so the dirty indicator clears
  // and a subsequent save would be a no-op until the user types again.
  const resolveReload = (path: string): void => {
    updateTab(path, (prev) => {
      if (prev.kind !== "text" || prev.conflict === null) return prev;
      return {
        ...prev,
        content: prev.conflict.newContent,
        baseline: prev.conflict.newContent,
        encoding: prev.conflict.newEncoding,
        conflict: null,
      };
    });
  };

  // T13.5 — Keep Mine: retain the buffer as-is, but advance `baseline`
  // (and encoding) to whatever's on disk now. The next save will write
  // the user's content over the external change — which is what they
  // asked for. Without the baseline bump, the buffer would still be
  // marked dirty against the *original* disk content, and the next
  // save's "did the bytes change?" guard would compare against a stale
  // snapshot.
  const resolveKeepMine = (path: string): void => {
    updateTab(path, (prev) => {
      if (prev.kind !== "text" || prev.conflict === null) return prev;
      return {
        ...prev,
        baseline: prev.conflict.newContent,
        encoding: prev.conflict.newEncoding,
        conflict: null,
      };
    });
  };

  const resolveViewDiff = (path: string): void => {
    updateTab(path, (prev) =>
      prev.kind === "text" && prev.conflict !== null
        ? { ...prev, conflict: { ...prev.conflict, mode: "diff" } }
        : prev,
    );
  };

  const resolveBackToEdit = (path: string): void => {
    updateTab(path, (prev) =>
      prev.kind === "text" && prev.conflict !== null
        ? { ...prev, conflict: { ...prev.conflict, mode: "banner" } }
        : prev,
    );
  };

  const handleEditorChange = (v: string): void => {
    const t = activeTabValue();
    if (t === null) {
      setEditorScratch(props.projectId, v);
      return;
    }
    if (t.kind !== "text") return;
    const targetPath = t.path;
    updateTab(targetPath, (prev) =>
      prev.kind === "text" ? { ...prev, content: v, lastError: null } : prev,
    );
    clearAutosaveTimer(targetPath);
    const delay = editorAutosaveMs();
    if (delay > 0) {
      const timer = setTimeout(() => {
        autosaveTimers.delete(targetPath);
        void performSaveFor(targetPath);
      }, delay);
      autosaveTimers.set(targetPath, timer);
    }
  };

  // Close a tab. Confirms via window.confirm when the buffer is dirty so
  // the user doesn't lose work to an errant Cmd+W. Picks a sensible next
  // active tab: the same-index entry after removal (i.e. the tab to the
  // right) or, if we closed the last one, the new tail.
  const closeTab = (path: string, options: { confirmDirty?: boolean } = {}): boolean => {
    const tab = findTab(path);
    if (!tab) return false;
    if (options.confirmDirty !== false && isTabDirty(tab)) {
      const label = fileLabelFromPath(path);
      const ok = window.confirm(`${label} has unsaved changes. Close anyway?`);
      if (!ok) return false;
    }
    clearAutosaveTimer(path);
    openTokens.delete(path);
    stopWatchForTab(tab);
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx === -1) return prev;
      const out = prev.slice();
      out.splice(idx, 1);
      // If we just closed the active tab, slide to the neighbour to the
      // right (same index after splice). Falls back to the new tail when
      // the closed tab was last, and to null when the list is empty.
      if (activePath() === path) {
        const nextActive = out[idx] ?? out[out.length - 1] ?? null;
        setActivePath(nextActive ? nextActive.path : null);
      }
      return out;
    });
    return true;
  };

  const closeActiveTab = (): void => {
    const p = activePath();
    if (p === null) return;
    closeTab(p);
  };

  // T13.6 — persist `{ paths, active }` per project. Read-modify-write
  // the global `editor_tabs_by_project` map so we don't lose other
  // projects' entries when this one updates. Debounced to coalesce burst
  // changes (rapid tree clicks, tab close storms).
  const PERSIST_DEBOUNCE_MS = 250;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let restored = false;

  const persistNow = async (): Promise<void> => {
    try {
      const all = await getSetting("editor_tabs_by_project");
      const paths = tabs().map((t) => t.path);
      const active = activePath();
      const next: typeof all = {};
      for (const [key, value] of Object.entries(all)) {
        if (key === props.projectId) continue;
        next[key] = value;
      }
      if (paths.length > 0) {
        next[props.projectId] = { paths, active };
      }
      await setSetting("editor_tabs_by_project", next);
    } catch (err) {
      console.warn("[T13.6] editor tab persist failed", err);
    }
  };

  const schedulePersist = (): void => {
    if (!restored) return;
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
  };

  // Re-persist whenever the tab list or active selection changes — but
  // only after the initial restore pass completes, otherwise the
  // mid-restore intermediate states would overwrite the persisted record.
  createEffect(() => {
    // Track both signals.
    tabs();
    activePath();
    schedulePersist();
  });

  const restoreTabs = async (): Promise<void> => {
    if (props.projectPath === null) {
      restored = true;
      return;
    }
    try {
      const all = await getSetting("editor_tabs_by_project");
      const entry = all[props.projectId];
      if (entry && entry.paths.length > 0) {
        for (const p of entry.paths) {
          // Sequential: keeps the restored tab order stable and avoids a
          // thundering herd of FS reads on app launch.
          await openOrActivate(p, true);
        }
        // Pick the persisted active tab if it survived the restore; else
        // fall back to the first surviving tab.
        const survivors = tabs();
        const wanted =
          entry.active && survivors.some((t) => t.path === entry.active)
            ? entry.active
            : (survivors[0]?.path ?? null);
        setActivePath(wanted);
      }
    } catch (err) {
      console.warn("[T13.6] editor tab restore failed", err);
    } finally {
      restored = true;
      schedulePersist();
    }
  };

  // T19.12 — when the workspace flips into cloud mode, drop every piece
  // of editor state that ties back to local-disk file ops. `readTextFile`
  // / `writeTextFile` / `startFileWatch` all raise
  // `CloudTransportUnsupportedError` in cloud mode (T19.11), so leaving
  // dirty buffers, queued autosaves, or live watches in place would
  // either fail silently in the background or surface as "Save failed"
  // errors on the next keystroke. We close the tabs the same way as
  // closeTab() but unconditionally (bypassing the dirty-confirm prompt):
  // the user is making an explicit workspace switch, not closing an
  // individual tab. Tabs persist to settings only while in local mode —
  // when they're cleared by this effect, the persist debounce later
  // writes an empty record for this project, which restores cleanly when
  // they toggle back.
  createEffect(() => {
    if (!cloudMode()) return;
    if (tabs().length === 0 && activePath() === null) return;
    clearAllAutosaveTimers();
    for (const id of watchIdToPath.keys()) {
      void stopFileWatch(id).catch(() => undefined);
    }
    watchIdToPath.clear();
    openTokens.clear();
    setTabs([]);
    setActivePath(null);
  });

  onMount(() => {
    // restoreTabs reads `tabs()` (a signal) inside an async tail — solid's
    // lint flags any reactive read outside a tracked scope as a possible
    // missed update. Here we intentionally only sample once after the
    // restore loop, so the read is correct and untracked is appropriate.
    //
    // T19.12 — skip restore in cloud mode: the persisted paths reference
    // the local disk and the FS commands would fail with
    // `CloudTransportUnsupportedError`. The list is restored on the next
    // local-mode mount.
    untrack(() => {
      if (cloudMode()) {
        restored = true;
        return;
      }
      void restoreTabs();
    });

    const dispose = addMenuActionListener((id) => {
      if (activeProjectId() !== props.projectId) return;
      if (activeTab(props.projectId) !== "editor") return;
      if (id === "save-file") {
        void performSaveActive();
        return;
      }
      if (id === "close-editor-tab") {
        closeActiveTab();
        return;
      }
    });

    // T13.5 — single subscription per workspace instance routes events
    // by their watchId. Bookkeeping (id → path) lives in `watchIdToPath`
    // so this handler stays a pure dispatcher.
    let disposeExternal: (() => void) | null = null;
    void onExternalChange(handleExternalChange).then((unlisten) => {
      disposeExternal = unlisten;
    });

    onCleanup(() => {
      clearAllAutosaveTimers();
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      dispose();
      if (disposeExternal !== null) disposeExternal();
      // Stop every watcher we own. Stops are idempotent on the backend
      // (unknown IDs no-op), so racing the unlisten above is fine.
      for (const id of watchIdToPath.keys()) {
        void stopFileWatch(id).catch(() => undefined);
      }
      watchIdToPath.clear();
    });
  });

  return (
    <Show when={!cloudMode()} fallback={<EditorCloudPlaceholder />}>
      <div class="ws-editor-tab flex min-h-0 flex-1">
        <Show when={props.projectPath}>
          {(root) => (
            <aside class="ws-editor-tab__tree" aria-label="Project files">
              <FileTree
                root={root()}
                onSelectFile={(p) => void openOrActivate(p)}
                selectedPath={activePath()}
              />
            </aside>
          )}
        </Show>
        <div class="ws-editor-tab__editor min-h-0 flex-1 flex flex-col">
          <Show when={tabs().length > 0}>
            <div class="ws-editor-tab__tabs" role="tablist" aria-label="Open files">
              <For each={tabs()}>
                {(tab) => {
                  const isActive = (): boolean => activePath() === tab.path;
                  const label = fileLabelFromPath(tab.path);
                  const dirty = (): boolean => isTabDirty(tab);
                  return (
                    <div
                      class="ws-editor-tab__tab"
                      data-active={isActive() ? "true" : undefined}
                      data-dirty={dirty() ? "true" : undefined}
                      role="tab"
                      aria-selected={isActive() ? "true" : "false"}
                      title={tab.path}
                    >
                      <button
                        type="button"
                        class="ws-editor-tab__tab-main"
                        onClick={() => setActivePath(tab.path)}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            closeTab(tab.path);
                          }
                        }}
                      >
                        <Show when={dirty()}>
                          <span class="ws-editor-tab__tab-dirty" aria-label="Unsaved changes" />
                        </Show>
                        <span class="ws-editor-tab__tab-name">{label}</span>
                      </button>
                      <button
                        type="button"
                        class="ws-editor-tab__tab-close"
                        aria-label={`Close ${label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(tab.path);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={activeFileLabel()}>
            {(label) => (
              <div
                class="ws-editor-tab__header"
                role="toolbar"
                aria-label="Editor status"
                data-status={saveStatus()}
              >
                <span
                  class="ws-editor-tab__header-filename"
                  title={activeTabValue()?.path ?? undefined}
                >
                  <Show when={isActiveDirty()}>
                    <span class="ws-editor-tab__dirty-dot" aria-label="Unsaved changes" />
                  </Show>
                  {label()}
                </span>
                <Show when={saveStatus() === "saving"}>
                  <span class="ws-editor-tab__header-status">Saving…</span>
                </Show>
                <Show when={saveStatus() === "error"}>
                  <span class="ws-editor-tab__header-status ws-editor-tab__header-status--error">
                    Save failed
                    <Show
                      when={(() => {
                        const t = activeTabValue();
                        return t?.kind === "text" && t.lastError ? t.lastError : null;
                      })()}
                    >
                      {(msg) => <>: {msg()}</>}
                    </Show>
                  </span>
                </Show>
              </div>
            )}
          </Show>
          <Show
            when={(() => {
              const t = activeTabValue();
              return t?.kind === "text" && t.conflict !== null && t.conflict.mode === "banner"
                ? t
                : null;
            })()}
          >
            {(t) => (
              <div class="ws-editor-tab__conflict" role="status" aria-live="polite">
                <span class="ws-editor-tab__conflict-text">
                  <strong>{fileLabelFromPath(t().path)}</strong> changed on disk while you were
                  editing. Your buffer has unsaved changes.
                </span>
                <div class="ws-editor-tab__conflict-actions">
                  <button
                    type="button"
                    class="ws-editor-tab__conflict-button"
                    onClick={() => resolveReload(t().path)}
                    title="Discard your changes and load the new disk content"
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    class="ws-editor-tab__conflict-button"
                    onClick={() => resolveKeepMine(t().path)}
                    title="Keep your buffer; the next save will overwrite the new disk content"
                  >
                    Keep mine
                  </button>
                  <button
                    type="button"
                    class="ws-editor-tab__conflict-button"
                    onClick={() => resolveViewDiff(t().path)}
                    title="See what changed on disk vs. what's in your buffer"
                  >
                    View diff
                  </button>
                </div>
              </div>
            )}
          </Show>
          <div class="min-h-0 flex-1">
            <Show
              when={(() => {
                const t = activeTabValue();
                return t?.kind === "text" && t.conflict !== null && t.conflict.mode === "diff"
                  ? t
                  : null;
              })()}
              fallback={
                <MonacoEditor
                  value={editorValue()}
                  path={activeTabValue()?.path ?? undefined}
                  readOnly={isReadOnly()}
                  onChange={handleEditorChange}
                />
              }
            >
              {(t) => (
                <div class="ws-editor-tab__diff flex min-h-0 flex-1 flex-col">
                  <div class="ws-editor-tab__diff-toolbar" role="toolbar" aria-label="Diff actions">
                    <span class="ws-editor-tab__diff-label">
                      <strong>On disk</strong> ↔ <strong>Your changes</strong>
                    </span>
                    <div class="ws-editor-tab__conflict-actions">
                      <button
                        type="button"
                        class="ws-editor-tab__conflict-button"
                        onClick={() => resolveReload(t().path)}
                      >
                        Reload
                      </button>
                      <button
                        type="button"
                        class="ws-editor-tab__conflict-button"
                        onClick={() => resolveKeepMine(t().path)}
                      >
                        Keep mine
                      </button>
                      <button
                        type="button"
                        class="ws-editor-tab__conflict-button"
                        onClick={() => resolveBackToEdit(t().path)}
                      >
                        Back to editor
                      </button>
                    </div>
                  </div>
                  <div class="min-h-0 flex-1">
                    <MonacoDiff
                      original={t().conflict?.newContent ?? ""}
                      modified={t().content}
                      path={t().path}
                    />
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

// T19.12 — Editor empty state for cloud mode. `read_text_file` /
// `write_text_file` / `start_file_watch` all throw
// `CloudTransportUnsupportedError` in cloud mode (T19.11) because the
// cloud-agent has no filesystem RPCs yet, so the editor body is replaced
// with a clear "not available" affordance instead of letting tree clicks
// produce error tabs and save attempts produce "Save failed" toasts.
function EditorCloudPlaceholder(): JSX.Element {
  return (
    <div
      class="ws-editor-tab ws-editor-tab--cloud-empty"
      role="region"
      aria-label="Code editor — cloud workspace"
    >
      <div class="ws-editor-tab__cloud-empty-panel">
        <div class="ws-editor-tab__cloud-empty-title">
          Editor not available on cloud workspaces yet
        </div>
        <div class="ws-editor-tab__cloud-empty-subtitle">
          File browsing and editing run against the local disk. Switch back to a local workspace to
          open files from this project, or use the Terminal tab to work on the remote machine.
        </div>
      </div>
    </div>
  );
}

export default AppShell;
