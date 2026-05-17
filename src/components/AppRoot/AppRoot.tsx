// Production wiring for the project shell.
//
// The dev harnesses (`?wsdebug=appshell`, `?wsdebug=editproject`, etc.)
// were the only places where the AppShell + Add / Edit / Delete / Context
// menu / Drag-reorder flows were actually mounted together. This component
// is the non-debug counterpart — what `App.tsx` renders by default.
//
// Responsibilities:
//   • Boot: load existing projects from SQLite, register them in the
//     workspace store with an empty layout. Terminals are intentionally
//     user-launched through the per-project CLI launcher.
//   • Render `AppShell` with `renderPane` returning a real `Terminal`.
//   • Wire `AddProjectModal` (create), `AddProjectModal mode=edit`,
//     `DeleteProjectConfirm`, `ProjectContextMenu`, and the empty-state
//     CTA all to the same set of mutations.
//   • Delete scope: derive the live session list from the workspace
//     store's layout tree (covers split panes from T5.6) so every PTY
//     gets killed before the DB row is removed.

import { Match, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const CLI_INSTALL_URLS: Readonly<Record<string, string>> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
  codex: "https://github.com/openai/codex?tab=readme-ov-file#quickstart",
  kimi: "https://github.com/MoonshotAI/moonshot-cli",
};
import { AppShell } from "../AppShell";
import { TitleBar } from "../TitleBar";
import type { PaneCliLaunchMode, PaneCliOption } from "../Pane";
import { cliMetaForId } from "../../types/cli";
import type { CliMeta } from "../../types/tab";
import { AddProjectModal } from "../AddProjectModal";
import type { AddProjectFormValue, ProjectEnvVars } from "../AddProjectModal";
import { DeleteProjectConfirm } from "../DeleteProjectConfirm";
import { ProjectContextMenu } from "../ProjectContextMenu";
import { SettingsPanel } from "../SettingsPanel";
import { Terminal } from "../Terminal/Terminal";
import {
  createProject,
  deleteProject,
  listProjects,
  reorderProjects,
  updateProject,
  updateProjectWorkspaceTabs,
  type Project,
} from "../../db/projects";
import { getSetting, setSetting } from "../../db/settings";
import { pickProjectFolder } from "../../ipc/picker";
import { cliListAvailable } from "../../ipc/cli";
import { ptyKill, ptyListCloud, ptySpawn, ptySubscribe, ptyWrite } from "../../ipc/pty";
import { setThemeMode, themeMode, type ThemeMode } from "../../stores/theme";
import {
  activeProjectId,
  activeTab,
  addProject,
  getWorkspace,
  projects,
  removeProject,
  reorderProjects as reorderProjectsLocal,
  replacePane,
  setActiveProject,
  setActiveTab,
  setFocusedSession,
  setLayout,
  splitPane,
  closePane as closePaneInStore,
  setTabVisibility,
  updateProjectMeta,
  visibleTabs,
} from "../../stores/workspace";
import { listProjectLinks } from "../../db/projectLinks";
import { Integration } from "../../integrations";
import { setFocusedSessionCliResolver, setTaskCliLauncher } from "../../stores/taskCliLauncher";
import { closeAllPlanflowChatRuntimes } from "../../stores/planflowChatSessions";
import { installChatMobileListener } from "../../integrations/planflow/chatMobileListener";
import type { WorkspaceTabKind } from "../../types/workspaceTab";
import {
  collectPanes,
  isEmptyLayout,
  paneNode,
  remapSessionIds,
  type LayoutNode,
  type PaneNode,
  type SplitDirection,
} from "../../types/layout";
import { EMPTY_LAYOUT, createLayoutPersister, getOrCreateProjectSession } from "../../db/sessions";
import type { LayoutPersister, SessionMode } from "../../db/sessions";
import { invoke } from "@tauri-apps/api/core";
import { cloudAgentUrl, cloudMode } from "../../stores/cloudMode";
import { WsBridgeClient } from "../../integrations/wsBridge";
import { CLOUD_AGENT_WS_PATH } from "../../integrations/cloudAgent";
import { DEFAULT_ACCOUNT, getCredential } from "../../integrations/credentials";
import { usePaneHotkeys } from "../../hotkeys/paneHotkeys";
import { eventMatchesBinding, getBinding, loadPersistedBindings } from "../../hotkeys";
import { addMenuActionListener, dispatchMenuAction } from "../../menu";
import { isMac, isWindows } from "../../utils/platform";
import "../../stores/appearance";

interface EditTarget {
  id: string;
  initial: AddProjectFormValue;
}

interface ContextTarget {
  projectId: string;
  position: { x: number; y: number };
}

type BootState = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };

const defaultShell = (): string => {
  if (isWindows) return "powershell.exe";
  return isMac ? "/bin/zsh" : "/bin/bash";
};

/// Estimate the cols/rows a freshly-spawned pane will end up at, before
/// the ResizeObserver-driven SIGWINCH gets a chance to send the real
/// numbers. Errs on the wide side so a TUI's initial render (claude's
/// welcome banner, codex's intro line) fills the visible area on a
/// modern monitor; SIGWINCH will narrow it back if the actual host is
/// smaller. Off-window environments (vite preview, jsdom) fall back to
/// the classic 80x24.
const guessInitialPaneSize = (): { cols: number; rows: number } => {
  if (typeof window === "undefined") return { cols: 80, rows: 24 };
  // Character cell estimates calibrated to the JetBrains Mono / Geist
  // 13px stack the design system ships — close enough for the brief
  // window between spawn and the real fit.
  const CHAR_W = 9;
  const ROW_H = 18;
  // The terminal pane never quite fills the whole window (sidebar +
  // chrome). Trim ~30% conservatively so we don't overshoot a narrow
  // sidebar-collapsed layout into 240-col absurdity.
  const usableWidth = Math.max(640, window.innerWidth * 0.7);
  const usableHeight = Math.max(360, window.innerHeight * 0.8);
  return {
    cols: Math.min(220, Math.max(80, Math.floor(usableWidth / CHAR_W))),
    rows: Math.min(60, Math.max(24, Math.floor(usableHeight / ROW_H))),
  };
};

// Build a PaneCliOption for "system default shell". Local mode hands
// the spawn an absolute path on this Mac; cloud mode sends a bare
// command name that resolves on the remote host's PATH. The remote
// might not have zsh (Ubuntu doesn't by default), so we always pick
// `bash` in cloud mode — universally installed.
const cloudDefaultShellOption = (): PaneCliOption => {
  if (cloudMode()) {
    return { name: "bash", path: "bash", version: null };
  }
  const shell = defaultShell();
  return {
    name: shell.split("/").pop() ?? "shell",
    path: shell,
    version: null,
  };
};

// Run shells as a login shell on Unix so `~/.zprofile` / `~/.bash_profile`
// load (Homebrew PATH, asdf, nvm, mise, etc.). When the .app is launched
// from Finder, the parent process gets a minimal PATH and PATH-discovered
// tools (claude, planflow-mcp, node, ...) wouldn't otherwise be reachable.
// Windows PowerShell handles its own profile chain, no flag needed.
const defaultShellArgs = (): string[] => {
  if (isWindows) return [];
  return ["-l"];
};

// Pick the pane + split direction for the next PlanFlow-Start spawn so the
// resulting layout tiles into a 2×2 grid as starts accumulate. Returns
// `null` when the layout doesn't look like a partial grid (4+ panes or a
// shape the user has manually reorganised) — caller falls back to
// splitting the focused pane vertically.
//
// Expected grid shapes by step:
//   1 pane :  Pane(s1)                                       → next: split s1 'h'
//   2 panes:  Split(h, s1, s2)                               → next: split s1 'v'
//   3 panes:  Split(h, Split(v, s1, s3), s2)                 → next: split s2 'v'
//   4 panes:  Split(h, Split(v, s1, s3), Split(v, s2, s4))   → grid full
//
// `collectPanes` walks the tree left-first, so the leftmost-leaf ordering
// `[s1]`, `[s1, s2]`, `[s1, s3, s2]` matches the shapes above and lets us
// pick the target by index alone.
function pickGridSplitTarget(
  layout: LayoutNode,
  focusedSessionId: string | null,
): { sessionId: string; direction: SplitDirection } | null {
  const panes: PaneNode[] = collectPanes(layout);
  if (panes.length === 1 && panes[0]) {
    return { sessionId: panes[0].sessionId, direction: "h" };
  }
  if (panes.length === 2 && panes[0]) {
    return { sessionId: panes[0].sessionId, direction: "v" };
  }
  if (panes.length === 3 && panes[2]) {
    return { sessionId: panes[2].sessionId, direction: "v" };
  }
  if (focusedSessionId !== null) {
    return { sessionId: focusedSessionId, direction: "v" };
  }
  return null;
}

export function AppRoot(): JSX.Element {
  const [boot, setBoot] = createSignal<BootState>({ kind: "loading" });
  const [collapsed, setCollapsed] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [editTarget, setEditTarget] = createSignal<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<EditTarget | null>(null);
  const [contextTarget, setContextTarget] = createSignal<ContextTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [updateVersion, setUpdateVersion] = createSignal<string | null>(null);
  const [updateInstalling, setUpdateInstalling] = createSignal(false);
  const [availableClis, setAvailableClis] = createSignal<PaneCliOption[]>([]);
  // T7.8 — projectId → configured-but-missing CLI name. Set when a project's
  // default CLI is saved in the DB but not found on PATH at launch time.
  // Cleared when the user dismisses the banner.
  const [cliNotFoundWarnings, setCliNotFoundWarnings] = createSignal<Record<string, string>>({});

  // Shadow maps for fields not promoted into ProjectMeta. Same pattern as
  // the harness — keeps the workspace store narrow.
  const projectPaths: Record<string, string> = {};
  const projectClis: Record<string, string | null> = {};
  const projectEnvs: Record<string, ProjectEnvVars> = {};
  const projectStartupCommands: Record<string, string[]> = {};

  // Sessions we know about per project. The store's layout tree is the
  // authoritative source for "which sessions does this project have"; this
  // map is a fallback for any session that briefly lives outside a layout
  // (e.g. immediately after spawn before the layout is set).
  const sessionsByProject: Record<string, string[]> = {};

  // T2.12 — per-project DB session id (the sessions table row that owns
  // layout_json) and its debounced layout persister.
  // T19.17 — these maps are scoped to the *currently active* workspace
  // mode. When `cloudMode()` flips we tear them down and rebuild from
  // the mode-scoped session row so layouts and PTYs never cross modes.
  const dbSessionByProject: Record<string, string> = {};
  const persisterByProject: Record<string, LayoutPersister> = {};

  // T19.17 — currently mounted workspace mode. `null` until boot finishes
  // wiring sessions for the first time so the reactive flip-handler below
  // doesn't run during the initial restore pass.
  const [mountedMode, setMountedMode] = createSignal<SessionMode | null>(null);
  const currentMode = (): SessionMode => (cloudMode() ? "cloud" : "local");

  // T7.7 — sessionId → CLI id captured at spawn time. The badge derived
  // from this map is the canonical "what was launched in this pane",
  // independent of whatever the user has typed since (e.g. running
  // `python` inside a `claude` pane keeps the claude badge — matches the
  // task's "derived from spawn command, not parse of running process"
  // heuristic). Solid signal so Pane's `resolveCli` re-runs whenever a
  // new spawn lands.
  const [sessionCli, setSessionCli] = createSignal<Record<string, string>>({});

  const recordSessionCli = (sessionId: string, cliId: string): void => {
    setSessionCli((prev) => ({ ...prev, [sessionId]: cliId }));
  };
  const forgetSessionCli = (sessionId: string): void => {
    setSessionCli((prev) => {
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  };

  const resolveCliBadge = (
    _projectId: string,
    sessionId: string,
  ): { meta: CliMeta; label: string } | null => {
    const cliId = sessionCli()[sessionId];
    if (!cliId) return null;
    const meta = cliMetaForId(cliId);
    if (!meta) return null;
    return { meta, label: cliId };
  };

  const trackSession = (projectId: string, sessionId: string): void => {
    const list = sessionsByProject[projectId] ?? [];
    list.push(sessionId);
    sessionsByProject[projectId] = list;
  };

  const untrackSession = (projectId: string, sessionId: string): void => {
    const list = sessionsByProject[projectId];
    if (!list) return;
    sessionsByProject[projectId] = list.filter((id) => id !== sessionId);
    forgetSessionCli(sessionId);
  };

  // T7.4 — resolve a project's default CLI to a `PaneCliOption` if (and
  // only if) the saved id is in the boot-detected list. Returns `null`
  // when the project has no default, or when the configured CLI isn't on
  // PATH right now (T7.8 handles that case with a warning + fallback).
  const resolveDefaultCli = (projectId: string): PaneCliOption | null => {
    const id = projectClis[projectId];
    if (!id) return null;
    return availableClis().find((cli) => cli.name === id) ?? null;
  };

  // T7.8 — return the configured CLI id when it is set but absent from PATH.
  const missingDefaultCli = (projectId: string): string | null => {
    const id = projectClis[projectId];
    if (!id) return null;
    return availableClis().find((cli) => cli.name === id) ? null : id;
  };

  const dismissCliWarning = (projectId: string): void => {
    setCliNotFoundWarnings((prev) => {
      const { [projectId]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  };

  const handleInstallHint = (missingCli: string): void => {
    const url = CLI_INSTALL_URLS[missingCli];
    if (url) void openUrl(url);
  };

  // Pane / project hotkeys: Cmd+\, Cmd+Shift+\, Cmd+W, Cmd+N. Wire to the
  // shadow map for cwd lookup so split shells inherit the project's folder.
  usePaneHotkeys({
    resolveCwd: (id) => projectPaths[id] ?? null,
    resolveEnv: (id) => projectEnvs[id] ?? {},
    resolveStartupCommands: (id) => projectStartupCommands[id] ?? [],
    shellCommand: defaultShell,
    shellArgs: defaultShellArgs,
    resolveDefaultCli: (id) => {
      const cli = resolveDefaultCli(id);
      return cli ? { name: cli.name, path: cli.path } : null;
    },
    onAddProject: () => {
      setActionError(null);
      setAddOpen(true);
    },
    onError: (msg) => setActionError(msg),
    // T7.7 — keep the badge map in sync with hotkey-driven split / close.
    // The split path passes `null` when it falls back to the system shell;
    // we skip recording in that case so the pane shows no badge (matches
    // the "system default" radio in the project form).
    onSessionSpawned: (sessionId, cliName) => {
      if (cliName) recordSessionCli(sessionId, cliName);
    },
    onSessionClosed: (sessionId) => forgetSessionCli(sessionId),
  });

  // T18.16 — listen for mobile-originated PlanFlow chat messages and
  // route them into the active chat session's PTY so the message
  // appears in the desktop chat panel.
  onMount(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        unlisten = await installChatMobileListener();
      } catch (error) {
        console.warn("[planflow-chat] mobile listener failed to install", error);
      }
    })();
    onCleanup(() => {
      if (unlisten) unlisten();
    });
  });

  onMount(() => {
    const dispose = addMenuActionListener((id) => {
      if (id === "close-pane") {
        // T13.6 — when the editor workspace tab is active, the native
        // "Close pane" menu item closes an editor sub-tab instead of the
        // terminal pane underneath. EditorWorkspace listens for
        // `close-editor-tab` and handles the dirty-buffer prompt.
        const projectId = activeProjectId();
        if (projectId && activeTab(projectId) === "editor") {
          dispatchMenuAction("close-editor-tab");
          return;
        }
        void closeFocusedPane();
        return;
      }
      if (id === "new-terminal") {
        void launchMenuTerminal();
        return;
      }
      if (id === "open-settings") {
        setSettingsOpen(true);
        return;
      }
      if (id === "copy") {
        document.execCommand("copy");
        return;
      }
      if (id === "paste") {
        document.execCommand("paste");
      }
    });
    onCleanup(dispose);
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.body.dataset.wsRebindCapture === "1") return;
      const binding = getBinding("open-settings");
      if (!binding || !eventMatchesBinding(event, binding)) return;
      event.preventDefault();
      setSettingsOpen(true);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onKeyDown, { capture: true }));
  });

  // T2.12 — spawn a fresh PTY for every pane in `savedLayout`, replace the
  // stale session ids from the previous run with the new ones, and put the
  // restored tree into the workspace store. All panes use the project's live
  // default CLI (or the system shell if the CLI is missing from PATH).
  const restoreProjectLayout = async (
    projectId: string,
    savedLayout: LayoutNode,
    cli: PaneCliOption | null,
  ): Promise<void> => {
    const panes = collectPanes(savedLayout);
    if (panes.length === 0) return;

    const effectiveCli: PaneCliOption = cli ?? cloudDefaultShellOption();

    const mapping = new Map<string, string>();
    try {
      for (const pane of panes) {
        const newId = await spawnCli(projectId, effectiveCli);
        trackSession(projectId, newId);
        mapping.set(pane.sessionId, newId);
      }
    } catch (err) {
      // Partial restore — kill what was already spawned and bail.
      for (const newId of mapping.values()) {
        void ptyKill(newId);
        untrackSession(projectId, newId);
      }
      setActionError(err instanceof Error ? err.message : String(err));
      return;
    }

    const restoredLayout = remapSessionIds(savedLayout, mapping);
    setLayout(projectId, restoredLayout);
    const restoredPanes = collectPanes(restoredLayout);
    if (restoredPanes[0]) setFocusedSession(projectId, restoredPanes[0].sessionId);
  };

  // Cloud-mode reattach: pull any live PTY sessions the agent kept
  // alive (we deliberately skip ptyKill on app close in cloud mode —
  // see onCleanup), pick the newest one for the project, and drop
  // it into the layout as a single pane. `Terminal` subscribes via
  // `ptySubscribe` on mount so xterm starts streaming output and
  // replays the scrollback the agent buffered while we were away.
  //
  // Silent failure is intentional: no sessions / agent unreachable /
  // protocol error all degrade to "auto-launch a fresh CLI" via the
  // T7.4 effect, which is the same fallback a brand-new project
  // would hit anyway.
  const restoreCloudSessions = async (projectId: string): Promise<void> => {
    try {
      const sessions = await ptyListCloud(projectId);
      if (sessions.length === 0) return;
      // `pty_list_result.sessions` is already sorted newest-first by
      // the agent; reusing index 0 keeps the contract simple.
      const newest = sessions[0];
      if (!newest) return;
      setLayout(projectId, paneNode(newest.sessionId));
      setFocusedSession(projectId, newest.sessionId);
      trackSession(projectId, newest.sessionId);
      // Treat the reattached session as if the auto-launch already
      // happened so the T7.4 effect doesn't try to spawn a duplicate
      // CLI alongside the one we just reattached to.
      autoLaunchedProjects.add(projectId);
    } catch (err) {
      console.warn("[cloud-reattach] ptyList failed; falling back to auto-launch:", err);
    }
  };

  const registerProject = (persisted: Project): void => {
    projectPaths[persisted.id] = persisted.path;
    projectClis[persisted.id] = persisted.defaultCli;
    projectEnvs[persisted.id] = persisted.env;
    projectStartupCommands[persisted.id] = persisted.startupCommands;
    addProject(
      {
        id: persisted.id,
        name: persisted.name,
        color: persisted.color ?? "var(--swatch-1)",
        glyph: persisted.icon ?? persisted.name.slice(0, 2).toUpperCase(),
      },
      {
        layout: null,
        focusedSessionId: null,
        visibleTabs: persisted.workspaceTabs,
        activeTab: persisted.activeWorkspaceTab,
      },
    );
  };

  // T11.1: debounced persistence for the workspace tab state. Repeated tab
  // clicks coalesce into one round-trip per project per debounce window so
  // a click-storm doesn't hammer SQLite. Same shape as the T2.12 layout
  // persister but inline because the payload is trivial.
  const TAB_PERSIST_DEBOUNCE_MS = 300;
  const tabPersistTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};

  const persistWorkspaceTabs = (projectId: string): void => {
    const existing = tabPersistTimers[projectId];
    if (existing !== undefined) clearTimeout(existing);
    tabPersistTimers[projectId] = setTimeout(() => {
      tabPersistTimers[projectId] = undefined;
      const tabs = visibleTabs(projectId);
      const active = activeTab(projectId);
      if (tabs.length === 0) return;
      void updateProjectWorkspaceTabs(projectId, tabs, active).catch((err: unknown) => {
        console.error("[T11.1] workspace tab persist failed:", err);
      });
    }, TAB_PERSIST_DEBOUNCE_MS);
  };

  const handleWorkspaceTabChange = (projectId: string, kind: WorkspaceTabKind): void => {
    // Store mutation already happened inside AppShell (setActiveTab). We
    // just need to schedule the write. `kind` is logged for the debug
    // overlay's activity feed (T8.7 wires it later); reading it here
    // satisfies the no-unused-vars rule and gives the rule a sticking
    // point if a future refactor stops passing the value.
    void kind;
    persistWorkspaceTabs(projectId);
  };

  onMount(() => {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      setBoot({
        kind: "failed",
        message:
          "This window needs to run inside the Tauri shell — open it via `pnpm tauri dev` (or the packaged app). The plain browser preview doesn't have the PTY/SQLite bridges.",
      });
      return;
    }

    void (async () => {
      try {
        try {
          setThemeMode(await getSetting("theme"));
        } catch (err) {
          console.error("[T8.3] theme restore failed:", err);
        }
        await loadPersistedBindings();
        try {
          setAvailableClis(await cliListAvailable());
        } catch (err) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        const persisted = await listProjects();
        // T19.17 — pin the mode for the boot pass. cloudMode() is hydrated
        // synchronously from settings defaults, then asynchronously from
        // SQLite; we capture once so every project loads under the same
        // mode and the reactive flip-handler can no-op while we restore.
        const bootMode = currentMode();
        for (const p of persisted) {
          registerProject(p);

          // T12.2: project_links is the source of truth for "this project
          // is connected to PlanFlow". If a link row exists but the
          // persisted workspace_tabs JSON drifted, force the PlanFlow tab
          // visible so the strip matches the link state on boot.
          try {
            const links = await listProjectLinks(p.id);
            const hasPlanFlowLink = links.some((link) => link.service === Integration.PlanFlow);
            if (hasPlanFlowLink && !visibleTabs(p.id).includes("planflow")) {
              setTabVisibility(p.id, "planflow", true);
              persistWorkspaceTabs(p.id);
            }
          } catch (err) {
            console.warn("[T12.2] project_links reconcile failed:", err);
          }

          // T2.12 / T19.17: load or create the mode-scoped session row,
          // then wire its debounced persister so future layout changes
          // are saved into the right (Local vs Cloud) row.
          //
          // Cloud mode skips the session row because the project's `id`
          // lives in the cloud-agent's SQLite, not this desktop's —
          // inserting into the local sessions table would trip the
          // `sessions.project_id REFERENCES projects(id)` FK. PTYs in
          // cloud mode are also tied to a live WS connection, so the
          // layout is inherently transient and not worth persisting
          // locally.
          if (bootMode === "local") {
            const { id: dbSessionId, layout: savedLayout } = await getOrCreateProjectSession(
              p.id,
              p.defaultCli,
              p.path,
              bootMode,
            );
            dbSessionByProject[p.id] = dbSessionId;
            persisterByProject[p.id] = createLayoutPersister(dbSessionId, {
              onError: (err) => console.error("[T2.12] layout persist failed:", err),
            });

            // Restore any non-empty layout from the previous session.
            if (!isEmptyLayout(savedLayout)) {
              const cli = resolveDefaultCli(p.id);
              const missing = missingDefaultCli(p.id);
              if (missing && !cli) {
                setCliNotFoundWarnings((prev) => ({ ...prev, [p.id]: missing }));
              }
              await restoreProjectLayout(p.id, savedLayout, cli);
              // Prevent auto-launch (T7.4) from spawning a duplicate first pane.
              autoLaunchedProjects.add(p.id);
            }
          } else {
            // Cloud mode: ask the agent for any PTY sessions left
            // alive from a previous run of this app and reattach to
            // them instead of starting a fresh shell. This is what
            // turns "close app" from "claude dies" into "claude is
            // still here when I come back". `restoreCloudSessions`
            // is a no-op when the agent reports no sessions for the
            // project — the auto-launch effect (T7.4) will take over
            // and spawn the project's default CLI as usual.
            await restoreCloudSessions(p.id);
          }
        }
        // T19.17 — record the mode the persister/session maps now point at.
        // The reactive flip-handler below diffs against this to detect
        // user-initiated cloud_mode toggles after boot.
        setMountedMode(bootMode);
        // T5.9 — restore the project that was active on the previous run.
        // setActiveProject is a no-op if the saved id was deleted in a
        // previous session, so the addProject default (first registered)
        // remains the safe fallback.
        try {
          const savedActive = await getSetting("last_active_project");
          if (savedActive) setActiveProject(savedActive);
        } catch (err) {
          console.error("[T5.9] last_active_project restore failed:", err);
        }
        // Wire the PlanFlow Start-task → CLI bridge. We register AFTER
        // `availableClis` and project metadata have loaded so the very
        // first Start press has the data it needs. The resolver feeds
        // `startTask` the focused pane's CLI so the orchestrator can
        // skip the `git checkout` pre-fill when the focused pane is a
        // REPL (Claude / Kimi / Codex).
        setTaskCliLauncher((projectId, taskId, cliName) =>
          startTaskCliLauncher(projectId, taskId, cliName),
        );
        setFocusedSessionCliResolver((projectId) => resolveFocusedSessionCli(projectId));
        // PlanFlow chat ships an embedded xterm.js mini-terminal now —
        // no PTY-output scraping, so no hidden-bridge installer is
        // needed. The chat panel spawns its own PTY directly.
        setBoot({ kind: "ready" });
        void checkUpdate()
          .then((update) => {
            if (update?.available) setUpdateVersion(update.version ?? "new version");
          })
          .catch((_err: unknown) => void _err);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setBoot({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      // Drop the PlanFlow Start-task bridge so a stale closure doesn't
      // outlive this mount during HMR.
      setTaskCliLauncher(null);
      setFocusedSessionCliResolver(null);
      // PlanFlow chat runtimes live in a module-level registry so
      // they survive panel collapses + project switches. They DON'T
      // get to outlive the app though — kill every tracked PTY on
      // teardown so we don't leak claude/kimi/codex processes.
      void closeAllPlanflowChatRuntimes();
      // Best-effort — if the window is closing the OS will reap them
      // anyway, but explicit kills help during HMR-style remounts.
      //
      // Cloud mode is the exception: leaving the agent's PTY sessions
      // alive across an app close is exactly the feature — the user
      // wants to relaunch later and find their claude / codex still
      // running. The boot path queries `pty_list` and reattaches.
      // Killing here would silently destroy the in-progress session
      // every time the user quit, which is the bug we're fixing.
      if (!cloudMode()) {
        for (const list of Object.values(sessionsByProject)) {
          for (const id of list) void ptyKill(id);
        }
      }
      // T11.1 — flush any pending tab persist windows. We deliberately do
      // not await the writes here: HMR remounts shouldn't block, and a
      // real shutdown loses at most the most recent tab click.
      for (const [projectId, timer] of Object.entries(tabPersistTimers)) {
        if (timer === undefined) continue;
        clearTimeout(timer);
        tabPersistTimers[projectId] = undefined;
        const tabs = visibleTabs(projectId);
        const active = activeTab(projectId);
        if (tabs.length > 0) {
          void updateProjectWorkspaceTabs(projectId, tabs, active).catch((err: unknown) => {
            console.error("[T11.1] workspace tab flush failed:", err);
          });
        }
      }
    });
  });

  const renderPane = (projectId: string, sessionId: string): JSX.Element => {
    const color = projects().find((p) => p.id === projectId)?.color;
    return (
      <Terminal
        sessionId={sessionId}
        projectId={projectId}
        title={`${projectId} · ${sessionId.slice(0, 6)}`}
        tintColor={color}
      />
    );
  };

  const handleCreateProject = async (value: AddProjectFormValue): Promise<void> => {
    const created = await createProject({
      name: value.name,
      path: value.path,
      color: value.color,
      icon: value.glyph,
      defaultCli: value.defaultCli,
      env: value.env,
      startupCommands: value.startupCommands,
    });
    registerProject(created);
    // T2.12 / T19.17: create the session row + persister for the freshly
    // added project. Local-only — see the boot-path comment for why
    // cloud-mode projects skip this (FK references the local projects
    // table, which the cloud project's id isn't in).
    if (currentMode() === "local") {
      const { id: dbSessionId } = await getOrCreateProjectSession(
        created.id,
        created.defaultCli,
        created.path,
        currentMode(),
      );
      dbSessionByProject[created.id] = dbSessionId;
      persisterByProject[created.id] = createLayoutPersister(dbSessionId, {
        onError: (err) => console.error("[T2.12] layout persist failed:", err),
      });
    }
    setActiveProject(created.id);
  };

  const handleEditProject = async (value: AddProjectFormValue): Promise<void> => {
    const target = editTarget();
    if (!target) return;
    const updated = await updateProject({
      id: target.id,
      name: value.name,
      path: value.path,
      color: value.color,
      icon: value.glyph,
      defaultCli: value.defaultCli,
      env: value.env,
      startupCommands: value.startupCommands,
    });
    projectPaths[target.id] = updated.path;
    projectClis[target.id] = updated.defaultCli;
    projectEnvs[target.id] = updated.env;
    projectStartupCommands[target.id] = updated.startupCommands;
    updateProjectMeta(target.id, {
      name: updated.name,
      color: updated.color ?? value.color,
      glyph: updated.icon ?? value.glyph,
    });
  };

  const openEditFor = (projectId: string): void => {
    const meta = projects().find((p) => p.id === projectId);
    const path = projectPaths[projectId] ?? "";
    if (!meta) return;
    setActionError(null);
    setEditTarget({
      id: projectId,
      initial: {
        name: meta.name,
        path,
        color: meta.color,
        glyph: meta.glyph,
        defaultCli: projectClis[projectId] ?? null,
        env: projectEnvs[projectId] ?? {},
        startupCommands: projectStartupCommands[projectId] ?? [],
      },
    });
  };

  const sessionsRunningFor = (projectId: string): number => {
    const ws = getWorkspace(projectId);
    if (!ws || !ws.layout) return 0;
    return collectPanes(ws.layout).length;
  };

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget();
    if (!target) return;
    // Authoritative session list comes from the layout tree — covers split
    // panes opened via T5.6, not just the initial shell. The shadow
    // sessionsByProject map is folded in for the (rare) window where a
    // session has been spawned but not yet placed into a layout.
    const liveSessions = new Set<string>();
    const ws = getWorkspace(target.id);
    if (ws && ws.layout) {
      for (const pane of collectPanes(ws.layout)) liveSessions.add(pane.sessionId);
    }
    for (const id of sessionsByProject[target.id] ?? []) liveSessions.add(id);
    for (const sessionId of liveSessions) {
      try {
        await ptyKill(sessionId);
      } catch {
        // Backend already logs; nothing the user can act on.
      }
      // T7.7 — drop badge entries for the about-to-be-removed sessions
      // so the map doesn't accumulate dead ids over the app's lifetime.
      forgetSessionCli(sessionId);
    }
    sessionsByProject[target.id] = [];
    try {
      await deleteProject(target.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      throw err;
    }
    projectPaths[target.id] = "";
    projectClis[target.id] = null;
    projectEnvs[target.id] = {};
    projectStartupCommands[target.id] = [];
    // T2.12: cancel any pending layout write — the session row is already gone
    // (ON DELETE CASCADE removed it when the project was deleted above).
    persisterByProject[target.id]?.cancel();
    setLayout(target.id, null);
    removeProject(target.id);
    setDeleteTarget(null);
    setEditTarget(null);
  };

  // Same generation-token rollback guard the harness uses — prevents an
  // earlier failed reorder from stomping a newer drop's optimistic state.
  let reorderGeneration = 0;

  const handleReorder = async (nextIds: string[]): Promise<void> => {
    const generation = ++reorderGeneration;
    const prev = projects().map((p) => p.id);
    reorderProjectsLocal(nextIds);
    try {
      await reorderProjects(nextIds);
    } catch (err) {
      if (reorderGeneration === generation) {
        reorderProjectsLocal(prev);
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleReveal = async (projectId: string): Promise<void> => {
    const path = projectPaths[projectId];
    if (!path) {
      setActionError("This project has no folder path on record.");
      return;
    }
    try {
      await revealItemInDir(path);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  // One-click clone of a local project's metadata to the paired
  // cloud-agent. The agent auto-creates the folder under its
  // projects-root (slugified name), so the user just needs to
  // populate it afterwards (`git clone`, etc.) inside a cloud
  // terminal. We deliberately don't copy file contents — that's a
  // separate flow (rsync over WS would need its own protocol and
  // is out of scope for the one-click promise).
  //
  // Uses a one-shot ephemeral `WsBridgeClient` rather than the
  // singleton `awaitCloudClient`: the singleton is gated on
  // `cloudMode()` and refuses to connect while the user is in Local
  // mode (which is exactly the only situation this menu is offered
  // from). Bypassing the gate lets the user push a local row to
  // cloud without first flipping the workspace toggle.
  const handlePushToCloud = async (projectId: string): Promise<void> => {
    const meta = projects().find((p) => p.id === projectId);
    if (!meta) return;
    setActionError(null);
    const rawUrl = cloudAgentUrl();
    if (!rawUrl) {
      setActionError("Cloud agent isn't paired yet — pair one in Settings first.");
      return;
    }
    let token: string | null;
    try {
      token = await getCredential(Integration.CloudAgent, DEFAULT_ACCOUNT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(`Cloud agent token load failed: ${msg}`);
      return;
    }
    if (!token) {
      setActionError("Cloud agent pairing token missing — re-pair in Settings.");
      return;
    }
    const trimmed = rawUrl.replace(/\/+$/, "");
    const url = trimmed.endsWith(CLOUD_AGENT_WS_PATH)
      ? trimmed
      : `${trimmed}${CLOUD_AGENT_WS_PATH}`;

    const client = await new Promise<WsBridgeClient | null>((resolve) => {
      let settled = false;
      const c = new WsBridgeClient({
        url,
        token: token as string,
        autoReconnect: false,
        onOpen: () => {
          if (!settled) {
            settled = true;
            resolve(c);
          }
        },
        onClose: () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
        onError: () => {
          if (!settled) {
            settled = true;
            try {
              c.close();
            } catch {
              // best-effort; client will GC on its own.
            }
            resolve(null);
          }
        },
      });
      c.connect();
      setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            c.close();
          } catch {
            // best-effort
          }
          resolve(null);
        }
      }, 8000);
    });

    if (!client) {
      setActionError("Couldn't reach the cloud agent. Check the connection and try again.");
      return;
    }

    try {
      const created = await client.projectCreate({
        name: meta.name,
        // Empty path → cloud-agent slugifies the name + mkdir_p under
        // `<projects_root>/<slug>` (see resolve_create_path in
        // crates/cloud-agent/src/dispatch.rs).
        path: "",
        color: meta.color,
        icon: meta.glyph,
        defaultCli: projectClis[projectId] ?? null,
        env: projectEnvs[projectId] ?? {},
        startupCommands: projectStartupCommands[projectId] ?? [],
      });

      // Second half of the push: rsync the local files into the
      // cloud-agent's filesystem so the user lands on a populated
      // project, not an empty mkdir. Skipped silently when the user
      // hasn't configured an SSH endpoint yet — the cloud agent's
      // WS URL is typically a Cloudflare hostname, which doesn't
      // accept SSH, so we keep the two endpoints as separate
      // settings.
      const sshEndpoint = (await getSetting("cloud_ssh_endpoint")).trim();
      const localPath = projectPaths[projectId] ?? "";
      if (!sshEndpoint) {
        setActionError(
          `"${created.name}" pushed (metadata only) to ${created.path}. ` +
            `Set Settings → Cloud → SSH endpoint to also sync files.`,
        );
      } else if (!localPath) {
        setActionError(
          `"${created.name}" pushed (metadata only) — no local folder path ` +
            "on record for this project, so file sync was skipped.",
        );
      } else {
        try {
          const result = await invoke<{
            code: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          }>("cloud_sync_files", {
            args: {
              localPath,
              sshEndpoint,
              remotePath: created.path,
              delete: false,
            },
          });
          if (result.code === 0) {
            const secs = Math.round(result.durationMs / 1000);
            setActionError(
              `"${created.name}" pushed + synced in ${secs}s. Switch to Cloud to use it.`,
            );
          } else {
            setActionError(
              `"${created.name}" metadata pushed but rsync exited ${result.code}: ` +
                `${result.stderr.trim().slice(0, 200) || "no stderr captured"}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setActionError(`"${created.name}" metadata pushed but file sync failed: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(`Push to cloud failed: ${msg}`);
    } finally {
      try {
        client.close();
      } catch {
        // best-effort teardown
      }
    }
  };

  const spawnCli = async (
    projectId: string,
    cli: PaneCliOption,
    extraStartupCommands: readonly string[] = [],
  ): Promise<string> => {
    const cwd = projectPaths[projectId];
    const env = projectEnvs[projectId] ?? {};
    const projectStartups = projectStartupCommands[projectId] ?? [];
    const combined = [...projectStartups, ...extraStartupCommands];
    // Local mode hands the cloud-agent / Tauri spawn the absolute path
    // resolved by `cliListAvailable` on this Mac. That path is
    // meaningless on the cloud-agent's filesystem, so cloud mode falls
    // back to the bare CLI name and lets the remote host's PATH
    // resolve it. Names match what the user actually installed there
    // (`claude`, `codex`, `bash`, `zsh`, …).
    const command = cloudMode() ? cli.name : cli.path;
    // Spawn cols/rows are a guess until the pane mounts and the
    // ResizeObserver sends the real geometry via SIGWINCH. The classic
    // 80x24 default was fine on a local PTY where the resize lands
    // before claude prints its welcome banner; over cloud WS the banner
    // arrives first and stays at 80 cols in scrollback forever. Use a
    // realistic full-window guess so the initial render fills modern
    // monitors comfortably; SIGWINCH will narrow it later if needed.
    const { cols, rows } = guessInitialPaneSize();
    const resp = await ptySpawn({
      command,
      args: [],
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      env: { ...env, WS_PROJECT_ID: projectId, WS_CLI_NAME: cli.name },
      startupCommands: combined.length > 0 ? combined : undefined,
      cols,
      rows,
    });
    // T7.7 — capture the CLI id at spawn so Pane's badge tracks what was
    // launched, not what's currently running. `cli.name` matches the
    // canonical CliOption.id ("claude", "codex", "kimi", ...).
    recordSessionCli(resp.sessionId, cli.name);
    return resp.sessionId;
  };

  const handleLaunchCli = async (
    projectId: string,
    sessionId: string,
    cli: PaneCliOption,
    mode: PaneCliLaunchMode,
  ): Promise<void> => {
    setActionError(null);
    try {
      const nextSessionId = await spawnCli(projectId, cli);
      trackSession(projectId, nextSessionId);
      if (mode === "split-h" || mode === "split-v") {
        splitPane(projectId, sessionId, mode === "split-h" ? "h" : "v", nextSessionId);
        const ws = getWorkspace(projectId);
        const didAttach =
          ws?.layout !== null &&
          ws?.layout !== undefined &&
          collectPanes(ws.layout).some((pane) => pane.sessionId === nextSessionId);
        if (!didAttach) {
          await ptyKill(nextSessionId);
          untrackSession(projectId, nextSessionId);
        }
        return;
      }
      const replaced = replacePane(projectId, sessionId, nextSessionId);
      if (replaced === null) {
        await ptyKill(nextSessionId);
        untrackSession(projectId, nextSessionId);
        return;
      }
      untrackSession(projectId, replaced);
      try {
        await ptyKill(replaced);
      } catch {
        // Backend logs the failed cleanup; the replacement pane is already live.
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  // Build the prompt we hand to a freshly-spawned CLI when the user
  // presses "Start" on a PlanFlow task. We pass the literal MCP tool
  // invocation so any MCP-aware CLI (Claude Code, codex, kimi) picks it
  // up as a tool call rather than parsing it as natural language.
  // Embedded double quotes in the task id are not expected (it's
  // `T<n>.<m>` shape), but we escape defensively in case the format
  // ever expands.
  const formatPlanFlowStartPrompt = (taskId: string): string => {
    const escaped = taskId.replace(/"/g, '\\"');
    return `planflow_task_start(taskId: "${escaped}")`;
  };

  // CLIs that support the auto-start flow (idle detection + auto-submit).
  // kimi is excluded because its MCP init state interferes with stdin
  // injection and the prompt never lands reliably.
  const TASK_CLI_NAMES: ReadonlySet<string> = new Set(["claude", "codex"]);

  // Resolve the CLI to launch for a Start-task pane. Prefers the project
  // default when it's a supported task CLI; otherwise picks the first
  // supported CLI on PATH. Returns `null` when none are available.
  const resolveTaskCli = (projectId: string): PaneCliOption | null => {
    const preferred = resolveDefaultCli(projectId);
    if (preferred && TASK_CLI_NAMES.has(preferred.name)) return preferred;
    return availableClis().find((c) => TASK_CLI_NAMES.has(c.name)) ?? null;
  };

  // Run `planflow_task_start(taskId: …)` against the project. Always spawn
  // a fresh CLI pane — never type into an existing CLI pane. Each Start
  // press gets its own terminal, tiled into a 2×2 grid as starts accumulate:
  //   1st Start (empty layout) → single pane, full size.
  //   2nd Start              → side-by-side with the 1st (top row).
  //   3rd Start              → below the 1st (bottom-left).
  //   4th Start              → below the 2nd (bottom-right) → grid complete.
  //   5th+ Start             → fall back to splitting the focused pane
  //                            vertically; the user can rearrange manually.
  const startTaskCliLauncher = async (
    projectId: string,
    taskId: string,
    cliName?: string,
  ): Promise<void> => {
    const prompt = formatPlanFlowStartPrompt(taskId);
    const ws = getWorkspace(projectId);
    const focused = ws?.focusedSessionId ?? null;
    const cli =
      cliName && TASK_CLI_NAMES.has(cliName)
        ? (availableClis().find((c) => c.name === cliName) ?? resolveTaskCli(projectId))
        : resolveTaskCli(projectId);
    if (!cli) return;

    // Surface the Terminal tab before spawning so the new pane is
    // actually visible — otherwise the spawned CLI lives in a hidden
    // workspace whose xterm is paused (T4.12 IntersectionObserver),
    // the user sees nothing happen, and the Start prompt only renders
    // after they manually switch tabs.
    setActiveTab(projectId, "terminal");

    // Spawn without startup commands — write the prompt once the REPL is
    // idle (see writePromptWhenReady below).
    const sessionId = await spawnCli(projectId, cli);
    trackSession(projectId, sessionId);
    if (ws?.layout) {
      const target = pickGridSplitTarget(ws.layout, focused);
      if (target !== null) {
        splitPane(projectId, target.sessionId, target.direction, sessionId);
        const layoutNow = getWorkspace(projectId)?.layout;
        const attached =
          layoutNow != null && collectPanes(layoutNow).some((pane) => pane.sessionId === sessionId);
        if (!attached) {
          await ptyKill(sessionId);
          untrackSession(projectId, sessionId);
          return;
        }
        writePromptWhenReady(sessionId, prompt);
        return;
      }
    }
    setLayout(projectId, paneNode(sessionId));
    setFocusedSession(projectId, sessionId);
    writePromptWhenReady(sessionId, prompt);
  };

  // Write `prompt` (no newline) into a CLI pane once it has been idle for
  // IDLE_MS — i.e. no new PTY output chunks for that window. This lets
  // every CLI finish its startup (claude: fast; kimi: slow, waits for MCP
  // to connect) before we inject text, so the characters appear in the
  // input field. The user then presses Enter when ready, consistent with
  // the git-checkout pre-fill on shell panes.
  //
  // MAX_WAIT_MS is a hard ceiling so we always write, even if the CLI
  // never fully goes idle.
  function writePromptWhenReady(sessionId: string, prompt: string): void {
    // Idle-detection lets fast CLIs (claude, codex) get the prompt as
    // soon as their TUI settles — typically ~1s after spawn. The hard
    // ceiling guarantees a write even when the CLI keeps sending
    // periodic redraws (cursor blink, status ticker) so idle never
    // actually quiesces. Cloud mode forwards frames in coarser batches
    // than a local PTY, so 2.5s is plenty for either transport — the
    // pre-T19.x default of 10s left the user staring at an idle pane
    // wondering whether Start was even wired up.
    const IDLE_MS = 600;
    const MAX_WAIT_MS = 2_500;

    // Shared mutable state for the timers and subscription reference so
    // both the chunk handler and the flush function can reach them.
    const state = {
      idleTimer: null as ReturnType<typeof window.setTimeout> | null,
      maxTimer: null as ReturnType<typeof window.setTimeout> | null,
      done: false,
      sub: null as { unsubscribe: () => void } | null,
    };

    const flush = (): void => {
      if (state.done) return;
      state.done = true;
      if (state.idleTimer != null) clearTimeout(state.idleTimer);
      if (state.maxTimer != null) clearTimeout(state.maxTimer);
      state.sub?.unsubscribe();
      const encoder = new TextEncoder();
      // Write the prompt text first so it appears in the input field, then
      // send \r (Enter in raw-mode) in a separate write after a short pause.
      // Sending both in one call lets the CLI process \r before echoing the
      // text characters — the submit fires on an empty buffer and the prompt
      // text ends up as stray output rather than a submitted command.
      // 500ms between prompt text and CR. The local-PTY default of
      // 150ms was just enough for Tauri's in-process IPC, but cloud
      // mode routes each ptyWrite through WS + Cloudflare Tunnel —
      // claude's Ink TUI hasn't finished consuming the prompt chars by
      // the time CR lands, so the submit fires on a partial buffer
      // (looked to the user like "Start did nothing — I had to press
      // Enter myself").
      void ptyWrite(sessionId, encoder.encode(prompt))
        .then(
          () =>
            new Promise<void>((resolve) => {
              window.setTimeout(resolve, 500);
            }),
        )
        .then(() => ptyWrite(sessionId, encoder.encode("\r")))
        .catch(() => {
          // Session closed — silently ignore.
        });
    };

    const armIdle = (): void => {
      if (state.idleTimer != null) clearTimeout(state.idleTimer);
      state.idleTimer = window.setTimeout(flush, IDLE_MS);
    };

    // Only start idle detection after the first output chunk arrives.
    // Calling armIdle() unconditionally in .then() would fire 600ms after
    // subscription setup even if the CLI hasn't printed anything yet —
    // which causes a false-early write for CLIs like codex that take a
    // moment before their first output burst.
    let seenFirstChunk = false;

    ptySubscribe(sessionId, () => {
      if (state.done) return;
      seenFirstChunk = true;
      armIdle();
    })
      .then((sub) => {
        state.sub = sub;
        if (state.done) {
          sub.unsubscribe();
          return;
        }
        state.maxTimer = window.setTimeout(flush, MAX_WAIT_MS);
        // Do NOT call armIdle() here — let the first output chunk trigger it.
        void seenFirstChunk; // referenced so the closure isn't dead-code stripped
      })
      .catch(() => {
        // ptySubscribe unavailable (non-Tauri preview) — fixed fallback.
        window.setTimeout(flush, 1000);
      });
  }

  // Sibling of the launcher: synchronous lookup of the focused pane's CLI
  // for `projectId`. `startTask` reads this *before* it decides whether to
  // pre-fill `git checkout -b …` — when a CLI is running, the git command
  // would land in the REPL as a chat prompt instead of a shell command.
  const resolveFocusedSessionCli = (projectId: string): string | null => {
    const ws = getWorkspace(projectId);
    const focused = ws?.focusedSessionId ?? null;
    if (focused == null) return null;
    return sessionCli()[focused] ?? null;
  };

  const handleLaunchFirstCli = async (projectId: string, cli: PaneCliOption): Promise<void> => {
    setActionError(null);
    try {
      const sessionId = await spawnCli(projectId, cli);
      trackSession(projectId, sessionId);
      setLayout(projectId, paneNode(sessionId));
      setFocusedSession(projectId, sessionId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  async function closeFocusedPane(): Promise<void> {
    const projectId = activeProjectId();
    if (!projectId) return;
    const ws = getWorkspace(projectId);
    if (!ws?.focusedSessionId) return;
    const closed = closePaneInStore(projectId, ws.focusedSessionId);
    if (closed === null) return;
    untrackSession(projectId, closed);
    try {
      await ptyKill(closed);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function launchMenuTerminal(): Promise<void> {
    const projectId = activeProjectId();
    if (!projectId) return;
    const ws = getWorkspace(projectId);
    if (ws?.layout) {
      setActionError("New terminal tabs land with the project workspace tab system.");
      return;
    }
    const cli = resolveDefaultCli(projectId) ?? availableClis()[0];
    if (!cli) {
      setActionError("No CLI is available on PATH.");
      return;
    }
    await handleLaunchFirstCli(projectId, cli);
  }

  // T7.4 — auto-launch the project's default CLI as the first pane when
  // a project becomes active with no layout yet. Tracks per-id so we
  // don't re-spawn after the user closes every pane (they'll see the
  // empty-state CLI picker and choose explicitly).
  // T7.8 — when the configured CLI is not on PATH, fall back to the system
  // shell and show an inline warning banner so the user knows what happened.
  const autoLaunchedProjects = new Set<string>();
  createEffect(() => {
    if (boot().kind !== "ready") return;
    const projectId = activeProjectId();
    if (projectId === null) return;
    if (autoLaunchedProjects.has(projectId)) return;
    const ws = getWorkspace(projectId);
    if (!ws || ws.layout !== null) return;
    const cli = resolveDefaultCli(projectId);
    if (cli) {
      autoLaunchedProjects.add(projectId);
      void handleLaunchFirstCli(projectId, cli);
      return;
    }
    const missing = missingDefaultCli(projectId);
    if (missing) {
      autoLaunchedProjects.add(projectId);
      setCliNotFoundWarnings((prev) => ({ ...prev, [projectId]: missing }));
      void handleLaunchFirstCli(projectId, cloudDefaultShellOption());
    }
  });

  // T2.12 / T5.8 wiring — persist each project's layout to SQLite whenever it
  // changes. Debounced at 500ms so rapid split-handle drags coalesce into one
  // write. Guarded by boot state so the restore phase doesn't overwrite the
  // just-loaded layouts before boot completes.
  createEffect(() => {
    if (boot().kind !== "ready") return;
    for (const project of projects()) {
      const layout = getWorkspace(project.id)?.layout ?? null;
      const persister = persisterByProject[project.id];
      if (persister) persister.schedule(layout ?? EMPTY_LAYOUT);
    }
  });

  // T19.17 — when the user flips the Local/Cloud workspace toggle after
  // boot, swap every project to the row that belongs to the new mode.
  // We can't just swap layouts because each PTY is alive in exactly one
  // backend (local Tauri vs cloud-agent WS), so we kill the current
  // mode's PTYs, drop the displayed layout, and re-restore from the
  // mode-scoped session row. The other mode's row is left untouched on
  // disk — flipping back returns the user to where they left it.
  createEffect(() => {
    if (boot().kind !== "ready") return;
    const next = currentMode();
    const prev = mountedMode();
    if (prev === null || prev === next) return;
    void swapWorkspaceMode(next);
  });

  const swapWorkspaceMode = async (next: SessionMode): Promise<void> => {
    // Snapshot the project list once — `projects()` is reactive and the
    // mutations below (setLayout) would otherwise reorder the iteration.
    const snapshot = projects().map((p) => p);

    // Tear down PTYs and clear layouts for every currently-mounted
    // project. The IPC transport has already flipped at this point
    // (cloudMode() drove this effect), so ptyKill would route to the
    // NEW backend — which doesn't own the PTY anyway. Fire-and-forget:
    // the previous backend reaps orphans on disconnect, and awaiting
    // every kill round-trip serially is what made the swap feel slow.
    for (const project of snapshot) {
      const live = new Set<string>();
      const ws = getWorkspace(project.id);
      if (ws?.layout) {
        for (const pane of collectPanes(ws.layout)) live.add(pane.sessionId);
      }
      for (const id of sessionsByProject[project.id] ?? []) live.add(id);
      for (const sessionId of live) {
        void ptyKill(sessionId).catch(() => {
          // Best-effort — already gone or backend will reap on disconnect.
        });
        forgetSessionCli(sessionId);
      }
      sessionsByProject[project.id] = [];
      persisterByProject[project.id]?.cancel();
      setLayout(project.id, null);
      autoLaunchedProjects.delete(project.id);
    }

    // Re-fetch the project list from whichever backend `next` routes to.
    // Without this, flipping the workspace toggle wouldn't visibly change
    // anything: the sidebar would keep showing the previous mode's
    // projects (loaded once at boot) even though every subsequent IPC
    // call now lands on the other backend.
    //
    // On failure (cloud-agent unreachable, timeout) we treat it as
    // "the new backend currently has no projects to show" rather than
    // re-using the previous mode's snapshot. Reusing the snapshot
    // would route subsequent PTY spawns through the new backend with
    // paths that only exist on the old one — surfaced to the user as
    // a "cwd does not exist" error from the cloud-agent. The
    // CloudConnectionBanner already surfaces the connectivity issue
    // separately so the empty sidebar is interpretable.
    let nextProjects: Project[];
    try {
      nextProjects = await listProjects();
    } catch (err) {
      console.error("[T19.17] listProjects after mode swap failed:", err);
      nextProjects = [];
    }

    // Drop projects that don't exist in the new mode so the sidebar
    // reflects the new backend. Shadow maps use `undefined` assignment
    // instead of `delete` to keep the no-dynamic-delete lint happy; the
    // store's `removeProject` handles the visible-state removal.
    const nextIds = new Set(nextProjects.map((p) => p.id));
    for (const project of snapshot) {
      if (nextIds.has(project.id)) continue;
      projectPaths[project.id] = "";
      projectClis[project.id] = null;
      projectEnvs[project.id] = {};
      projectStartupCommands[project.id] = [];
      dbSessionByProject[project.id] = "";
      persisterByProject[project.id]?.cancel();
      removeProject(project.id);
    }

    // Register (or refresh) every project in the new list synchronously
    // so the sidebar paints the new project list immediately — without
    // this the user would stare at an empty workspace while the per-
    // project session/PTY restore played out below. registerProject is
    // idempotent on id; subsequent calls just replace metadata.
    for (const project of nextProjects) {
      registerProject(project);
    }
    setMountedMode(next);

    // Load each project's mode-scoped session row and restore its
    // layout in parallel. Projects are independent — there's no shared
    // state between their PTY spawns — so serialising the loop just
    // added latency proportional to N projects.
    if (next === "local") {
      await Promise.all(
        // eslint-disable-next-line solid/reactivity -- one-shot async restore, not a reactive subscription
        nextProjects.map(async (project) => {
          const projectPath = projectPaths[project.id] ?? null;
          const projectCli = projectClis[project.id] ?? null;
          const { id: nextSessionId, layout: savedLayout } = await getOrCreateProjectSession(
            project.id,
            projectCli,
            projectPath,
            next,
          );
          dbSessionByProject[project.id] = nextSessionId;
          persisterByProject[project.id] = createLayoutPersister(nextSessionId, {
            onError: (err) => console.error("[T19.17] layout persist failed:", err),
          });

          if (!isEmptyLayout(savedLayout)) {
            const cli = resolveDefaultCli(project.id);
            await restoreProjectLayout(project.id, savedLayout, cli);
            autoLaunchedProjects.add(project.id);
          }
        }),
      );
    } else {
      // Cloud mode: same reattach pass as boot — if the agent kept
      // a PTY alive across the local→cloud toggle, surface it here
      // instead of spawning a fresh CLI.
      await Promise.all(nextProjects.map((project) => restoreCloudSessions(project.id)));
    }
  };

  // T5.9 — persist the active project id on every change so the next launch
  // opens to the same project. Boot-gated so the restore step above isn't
  // overwritten by the addProject default before we've read last_active_project.
  createEffect(() => {
    if (boot().kind !== "ready") return;
    const id = activeProjectId();
    void setSetting("last_active_project", id).catch((err: unknown) => {
      console.error("[T5.9] last_active_project persist failed:", err);
    });
  });

  createEffect((prev: ThemeMode | undefined) => {
    if (boot().kind !== "ready") return prev;
    const current = themeMode();
    if (prev !== current) {
      void setSetting("theme", current).catch((err: unknown) => {
        console.error("[T8.3] theme persist failed:", err);
      });
    }
    return current;
  });

  // T8.6 — title bar reflects the active project name when one is selected,
  // falling back to the app name during onboarding / empty state.
  const titleBarLabel = (): string => {
    const id = activeProjectId();
    if (!id) return "Work Station";
    const meta = projects().find((p) => p.id === id);
    return meta ? `Work Station — ${meta.name}` : "Work Station";
  };

  return (
    <div class="flex h-full w-full flex-col">
      <TitleBar title={titleBarLabel()} />
      {actionError() ? (
        <div class="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {actionError()}
        </div>
      ) : null}
      <div class="min-h-0 flex-1">
        <Switch>
          <Match when={boot().kind === "loading"}>
            <div class="flex h-full items-center justify-center text-xs text-fg-secondary">
              Loading projects…
            </div>
          </Match>
          <Match when={boot().kind === "failed"}>
            <div class="flex h-full items-center justify-center p-6 text-xs text-danger">
              {(() => {
                const s = boot();
                return s.kind === "failed" ? s.message : "";
              })()}
            </div>
          </Match>
          <Match when={boot().kind === "ready"}>
            <AppShell
              renderPane={renderPane}
              sidebarCollapsed={collapsed()}
              onToggleSidebar={() => setCollapsed((c) => !c)}
              onAddProject={() => {
                setActionError(null);
                setAddOpen(true);
              }}
              onEditProject={openEditFor}
              onProjectContextMenu={(id, x, y) =>
                setContextTarget({ projectId: id, position: { x, y } })
              }
              onReorderProjects={(ids) => void handleReorder(ids)}
              clis={availableClis()}
              onLaunchCli={(projectId, sessionId, cli, mode) =>
                void handleLaunchCli(projectId, sessionId, cli, mode)
              }
              onLaunchFirstCli={(projectId, cli) => void handleLaunchFirstCli(projectId, cli)}
              resolveCli={resolveCliBadge}
              resolveCliWarning={(projectId) => cliNotFoundWarnings()[projectId] ?? null}
              onDismissCliWarning={dismissCliWarning}
              onInstallHint={handleInstallHint}
              hasInstallUrl={(cliName) => cliName in CLI_INSTALL_URLS}
              onWorkspaceTabChange={handleWorkspaceTabChange}
              onOpenSettings={() => setSettingsOpen(true)}
              resolveProjectPath={(id) => projectPaths[id] ?? null}
            />
          </Match>
        </Switch>
      </div>

      <AddProjectModal
        open={addOpen()}
        onClose={() => setAddOpen(false)}
        onPickFolder={pickProjectFolder}
        onSubmit={handleCreateProject}
      />
      <AddProjectModal
        open={editTarget() !== null}
        mode="edit"
        initialValue={editTarget()?.initial}
        onClose={() => setEditTarget(null)}
        onPickFolder={pickProjectFolder}
        onSubmit={handleEditProject}
        onRequestDelete={() => {
          const target = editTarget();
          if (target) setDeleteTarget(target);
        }}
      />
      <DeleteProjectConfirm
        open={deleteTarget() !== null}
        projectName={deleteTarget()?.initial.name ?? ""}
        runningSessions={(() => {
          const t = deleteTarget();
          return t ? sessionsRunningFor(t.id) : 0;
        })()}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
      <ProjectContextMenu
        position={contextTarget()?.position ?? null}
        onClose={() => setContextTarget(null)}
        canPushToCloud={!cloudMode() && cloudAgentUrl() != null}
        onSwitch={() => {
          const t = contextTarget();
          if (t) setActiveProject(t.projectId);
        }}
        onEdit={() => {
          const t = contextTarget();
          if (t) openEditFor(t.projectId);
        }}
        onReveal={() => {
          const t = contextTarget();
          if (t) void handleReveal(t.projectId);
        }}
        onPushToCloud={() => {
          const t = contextTarget();
          if (t) void handlePushToCloud(t.projectId);
        }}
        onDelete={() => {
          const t = contextTarget();
          if (!t) return;
          const meta = projects().find((p) => p.id === t.projectId);
          if (!meta) return;
          setDeleteTarget({
            id: t.projectId,
            initial: {
              name: meta.name,
              path: projectPaths[t.projectId] ?? "",
              color: meta.color,
              glyph: meta.glyph,
              defaultCli: projectClis[t.projectId] ?? null,
              env: projectEnvs[t.projectId] ?? {},
              startupCommands: projectStartupCommands[t.projectId] ?? [],
            },
          });
        }}
      />
      <SettingsPanel open={settingsOpen()} onClose={() => setSettingsOpen(false)} />

      {updateVersion() ? (
        <div class="pointer-events-none fixed inset-0 z-50 flex items-end justify-end p-4">
          <div class="pointer-events-auto flex w-72 flex-col gap-3 rounded-xl border border-accent/20 bg-canvas p-4 shadow-2xl">
            <div class="flex items-start justify-between gap-2">
              <div class="flex flex-col gap-0.5">
                <span class="text-sm font-semibold text-fg">Update available</span>
                <span class="text-xs text-fg-secondary">
                  Version {updateVersion()} is ready to install
                </span>
              </div>
              <button
                type="button"
                class="mt-0.5 shrink-0 text-fg-secondary hover:text-fg"
                aria-label="Dismiss update"
                onClick={() => setUpdateVersion(null)}
              >
                ×
              </button>
            </div>
            <button
              type="button"
              class="w-full rounded-lg bg-accent py-1.5 text-xs font-semibold text-canvas transition-opacity disabled:opacity-50"
              disabled={updateInstalling()}
              onClick={() => {
                setUpdateInstalling(true);
                void checkUpdate()
                  .then(async (update) => {
                    if (update?.available) {
                      await update.downloadAndInstall();
                      await relaunch();
                    }
                  })
                  .catch((err: unknown) => {
                    setUpdateInstalling(false);
                    setActionError(err instanceof Error ? err.message : String(err));
                  });
              }}
            >
              {updateInstalling() ? "Installing…" : "Install & Restart"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default AppRoot;
