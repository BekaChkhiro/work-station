// Production wiring for the project shell.
//
// The dev harnesses (`?wsdebug=appshell`, `?wsdebug=editproject`, etc.)
// were the only places where the AppShell + Add / Edit / Delete / Context
// menu / Drag-reorder flows were actually mounted together. This component
// is the non-debug counterpart — what `App.tsx` renders by default.
//
// Responsibilities:
//   • Boot: load existing projects from SQLite, register them in the
//     workspace store, and spawn one default shell per project so the
//     T6.5 acceptance ("New project appears with one tab + one pane open")
//     also holds for previously-created projects until T2.12 layout
//     restore lands.
//   • Render `AppShell` with `renderPane` returning a real `Terminal`.
//   • Wire `AddProjectModal` (create), `AddProjectModal mode=edit`,
//     `DeleteProjectConfirm`, `ProjectContextMenu`, and the empty-state
//     CTA all to the same set of mutations.
//   • Delete scope: derive the live session list from the workspace
//     store's layout tree (covers split panes from T5.6) so every PTY
//     gets killed before the DB row is removed.

import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AppShell } from "../AppShell";
import { AddProjectModal } from "../AddProjectModal";
import type { AddProjectFormValue } from "../AddProjectModal";
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
import { ptyKill, ptySpawn } from "../../ipc/pty";
import {
  activeProjectId,
  addProject,
  getWorkspace,
  projects,
  removeProject,
  reorderProjects as reorderProjectsLocal,
  setActiveProject,
  setLayout,
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

const spawnDefaultShell = async (projectId: string, cwd: string): Promise<string> => {
  const resp = await ptySpawn({
    command: defaultShell(),
    args: defaultShellArgs(),
    cwd: cwd.length > 0 ? cwd : undefined,
    env: { WS_PROJECT_ID: projectId },
    cols: 80,
    rows: 24,
  });
  return resp.sessionId;
};

export function AppRoot(): JSX.Element {
  const [boot, setBoot] = createSignal<BootState>({ kind: "loading" });
  const [collapsed, setCollapsed] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [editTarget, setEditTarget] = createSignal<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<EditTarget | null>(null);
  const [contextTarget, setContextTarget] = createSignal<ContextTarget | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  // Shadow maps for fields not promoted into ProjectMeta. Same pattern as
  // the harness — keeps the workspace store narrow.
  const projectPaths: Record<string, string> = {};
  const projectClis: Record<string, string | null> = {};

  // Sessions we know about per project. The store's layout tree is the
  // authoritative source for "which sessions does this project have"; this
  // map is a fallback for any session that briefly lives outside a layout
  // (e.g. immediately after spawn before the layout is set).
  const sessionsByProject: Record<string, string[]> = {};

  const trackSession = (projectId: string, sessionId: string): void => {
    const list = sessionsByProject[projectId] ?? [];
    list.push(sessionId);
    sessionsByProject[projectId] = list;
  };

  // Pane / project hotkeys: Cmd+\, Cmd+Shift+\, Cmd+W, Cmd+N. Wire to the
  // shadow map for cwd lookup so split shells inherit the project's folder.
  usePaneHotkeys({
    resolveCwd: (id) => projectPaths[id] ?? null,
    shellCommand: defaultShell,
    shellArgs: defaultShellArgs,
    onAddProject: () => {
      setActionError(null);
      setAddOpen(true);
    },
    onError: (msg) => setActionError(msg),
  });

  const registerProject = (persisted: Project, sessionId: string | null): void => {
    projectPaths[persisted.id] = persisted.path;
    projectClis[persisted.id] = persisted.defaultCli;
    addProject(
      {
        id: persisted.id,
        name: persisted.name,
        color: persisted.color ?? "var(--swatch-1)",
        glyph: persisted.icon ?? persisted.name.slice(0, 2).toUpperCase(),
      },
      {
        layout: sessionId !== null ? paneNode(sessionId) : null,
        focusedSessionId: sessionId,
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
        const persisted = await listProjects();
        for (const p of persisted) {
          // Best-effort — if the shell fails to spawn (e.g. /bin/zsh
          // missing), the project still registers without a session and
          // the user can re-spawn via T5.6 once that wires up.
          let sessionId: string | null = null;
          try {
            sessionId = await spawnDefaultShell(p.id, p.path);
            trackSession(p.id, sessionId);
          } catch (err) {
            // Surface once at boot but keep going so the rest of the list
            // still loads.
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`failed to spawn default shell for ${p.name}: ${message}`);
          }
          registerProject(p, sessionId);
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
    });
    let sessionId: string | null = null;
    try {
      sessionId = await spawnDefaultShell(created.id, created.path);
      trackSession(created.id, sessionId);
    } catch (err) {
      // Project is created in the DB even if the shell fails — surface the
      // shell error so the user knows why no pane appeared. They can
      // re-spawn via T5.6.
      setActionError(err instanceof Error ? err.message : String(err));
    }
    registerProject(created, sessionId);
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
    });
    projectPaths[target.id] = updated.path;
    projectClis[target.id] = updated.defaultCli;
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
