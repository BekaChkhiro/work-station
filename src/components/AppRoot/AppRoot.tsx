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
import { AppShell } from "../AppShell";
import type { PaneCliLaunchMode, PaneCliOption } from "../Pane";
import { cliMetaForId } from "../../types/cli";
import type { CliMeta } from "../../types/tab";
import { AddProjectModal } from "../AddProjectModal";
import type { AddProjectFormValue, ProjectEnvVars } from "../AddProjectModal";
import { DeleteProjectConfirm } from "../DeleteProjectConfirm";
import { ProjectContextMenu } from "../ProjectContextMenu";
import { Terminal } from "../Terminal/Terminal";
import {
  createProject,
  deleteProject,
  listProjects,
  reorderProjects,
  updateProject,
  type Project,
} from "../../db/projects";
import { pickProjectFolder } from "../../ipc/picker";
import { cliListAvailable } from "../../ipc/cli";
import { ptyKill, ptySpawn } from "../../ipc/pty";
import {
  activeProjectId,
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
  updateProjectMeta,
} from "../../stores/workspace";
import { collectPanes, paneNode } from "../../types/layout";
import { usePaneHotkeys } from "../../hotkeys/paneHotkeys";
import { isMac, isWindows } from "../../utils/platform";

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

export function AppRoot(): JSX.Element {
  const [boot, setBoot] = createSignal<BootState>({ kind: "loading" });
  const [collapsed, setCollapsed] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [editTarget, setEditTarget] = createSignal<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<EditTarget | null>(null);
  const [contextTarget, setContextTarget] = createSignal<ContextTarget | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
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

  // Install URLs for known CLIs — opened in the default browser when the
  // user clicks "Install instructions" in the warning banner.
  const CLI_INSTALL_URLS: Record<string, string> = {
    claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    codex: "https://github.com/openai/codex?tab=readme-ov-file#quickstart",
    kimi: "https://github.com/MoonshotAI/moonshot-cli",
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
      },
    );
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
          setAvailableClis(await cliListAvailable());
        } catch (err) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
        const persisted = await listProjects();
        for (const p of persisted) {
          registerProject(p);
        }
        setBoot({ kind: "ready" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setBoot({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      // Best-effort — if the window is closing the OS will reap them
      // anyway, but explicit kills help during HMR-style remounts.
      for (const list of Object.values(sessionsByProject)) {
        for (const id of list) void ptyKill(id);
      }
    });
  });

  const renderPane = (projectId: string, sessionId: string): JSX.Element => (
    <Terminal
      sessionId={sessionId}
      projectId={projectId}
      title={`${projectId} · ${sessionId.slice(0, 6)}`}
    />
  );

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

  const spawnCli = async (projectId: string, cli: PaneCliOption): Promise<string> => {
    const cwd = projectPaths[projectId];
    const env = projectEnvs[projectId] ?? {};
    const startupCommands = projectStartupCommands[projectId] ?? [];
    const resp = await ptySpawn({
      command: cli.path,
      args: [],
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      env: { ...env, WS_PROJECT_ID: projectId, WS_CLI_NAME: cli.name },
      startupCommands: startupCommands.length > 0 ? startupCommands : undefined,
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

  return (
    <div class="flex h-full w-full flex-col">
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
    </div>
  );
}

// Note: `activeProjectId` is imported above for parity with the harness; not
// referenced directly in this file but kept to keep the import set aligned
// for future surface (e.g. window-title binding).
void activeProjectId;

export default AppRoot;
