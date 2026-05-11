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
import { ptyKill, ptySpawn } from "../../ipc/pty";
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
import type { LayoutPersister } from "../../db/sessions";
import { usePaneHotkeys } from "../../hotkeys/paneHotkeys";
import { eventMatchesBinding, getBinding, loadPersistedBindings } from "../../hotkeys";
import { addMenuActionListener } from "../../menu";
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
  const dbSessionByProject: Record<string, string> = {};
  const persisterByProject: Record<string, LayoutPersister> = {};

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

  onMount(() => {
    const dispose = addMenuActionListener((id) => {
      if (id === "close-pane") {
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

    const effectiveCli: PaneCliOption = cli ?? {
      name: defaultShell().split("/").pop() ?? "shell",
      path: defaultShell(),
      version: null,
    };

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

          // T2.12: load or create a persistent session row, then wire its
          // debounced persister so future layout changes are saved to SQLite.
          const { id: dbSessionId, layout: savedLayout } = await getOrCreateProjectSession(
            p.id,
            p.defaultCli,
            p.path,
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
        }
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
        setTaskCliLauncher((projectId, taskId) => startTaskCliLauncher(projectId, taskId));
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
      for (const list of Object.values(sessionsByProject)) {
        for (const id of list) void ptyKill(id);
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
    // T2.12: create the session row and persister for the freshly added project.
    const { id: dbSessionId } = await getOrCreateProjectSession(
      created.id,
      created.defaultCli,
      created.path,
    );
    dbSessionByProject[created.id] = dbSessionId;
    persisterByProject[created.id] = createLayoutPersister(dbSessionId, {
      onError: (err) => console.error("[T2.12] layout persist failed:", err),
    });
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

  const spawnCli = async (
    projectId: string,
    cli: PaneCliOption,
    extraStartupCommands: readonly string[] = [],
  ): Promise<string> => {
    const cwd = projectPaths[projectId];
    const env = projectEnvs[projectId] ?? {};
    const projectStartups = projectStartupCommands[projectId] ?? [];
    const combined = [...projectStartups, ...extraStartupCommands];
    const resp = await ptySpawn({
      command: cli.path,
      args: [],
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      env: { ...env, WS_PROJECT_ID: projectId, WS_CLI_NAME: cli.name },
      startupCommands: combined.length > 0 ? combined : undefined,
      cols: 80,
      rows: 24,
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

  // Resolve the CLI to launch for a Start-task pane. Project default
  // wins; if that's not on PATH (T7.8 case) fall back to the first
  // available CLI. Returns `null` only when *no* CLI is available, in
  // which case the launcher silently skips the spawn and the user keeps
  // the existing flow (git checkout pre-fill in the focused pane).
  const resolveTaskCli = (projectId: string): PaneCliOption | null => {
    const preferred = resolveDefaultCli(projectId);
    if (preferred) return preferred;
    return availableClis()[0] ?? null;
  };

  // Run `planflow_task_start(taskId: …)` against the project. Always spawn
  // a fresh CLI pane with the prompt queued as a startup command — never
  // type into an existing CLI pane. Each Start press gets its own terminal,
  // tiled into a 2×2 grid as starts accumulate:
  //   1st Start (empty layout) → single pane, full size.
  //   2nd Start              → side-by-side with the 1st (top row).
  //   3rd Start              → below the 1st (bottom-left).
  //   4th Start              → below the 2nd (bottom-right) → grid complete.
  //   5th+ Start             → fall back to splitting the focused pane
  //                            vertically; the user can rearrange manually.
  const startTaskCliLauncher = async (projectId: string, taskId: string): Promise<void> => {
    const prompt = formatPlanFlowStartPrompt(taskId);
    const ws = getWorkspace(projectId);
    const focused = ws?.focusedSessionId ?? null;
    const cli = resolveTaskCli(projectId);
    if (!cli) return;
    const sessionId = await spawnCli(projectId, cli, [prompt]);
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
        }
        return;
      }
    }
    setLayout(projectId, paneNode(sessionId));
    setFocusedSession(projectId, sessionId);
  };

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
      const shell = defaultShell();
      const fallback: PaneCliOption = {
        name: shell.split("/").pop() ?? "shell",
        path: shell,
        version: null,
      };
      void handleLaunchFirstCli(projectId, fallback);
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
