// T6.2 + T6.5 + T6.6: AppShell harness — exercises state-only project
// switching alongside the create / edit / delete project flows.
//
// Spawns three demo projects, each with its own real PTY shell, and
// renders them through AppShell. While "argon" is active, you can type
// a long-running command (e.g. `for i in 1 2 3 4 5; do echo "$i"; sleep
// 1; done`) and switch to another project mid-loop. When you switch
// back, the argon terminal shows every line that printed during the
// absence — that's the T6.2 acceptance.
//
// Reachable via `?wsdebug=appshell` in dev builds.
//
// The demo projects are persisted via `createProject` (or reused via
// `listProjects` on re-mount) so editing and deleting can hit the real
// DB / IPC path. Project paths default to `/tmp/<id>` since these demos
// don't actually live on disk — the field exists just to satisfy the
// backend's path validation.

import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AppShell } from "./AppShell";
import { Terminal } from "../Terminal/Terminal";
import { AddProjectModal } from "../AddProjectModal";
import type { AddProjectFormValue } from "../AddProjectModal";
import { DeleteProjectConfirm } from "../DeleteProjectConfirm";
import { ProjectContextMenu } from "../ProjectContextMenu";
import { ptyKill, ptySpawn } from "../../ipc/pty";
import {
  createProject,
  deleteProject,
  listProjects,
  reorderProjects,
  updateProject,
  type Project,
} from "../../db/projects";
import { pickProjectFolder } from "../../ipc/picker";
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

interface DemoProject {
  /** Stable name used to look up the persisted row across mounts. */
  name: string;
  color: string;
  glyph: string;
  startupCommands: string[];
}

const DEMO_PROJECTS: DemoProject[] = [
  {
    name: "argon-web",
    color: "var(--swatch-4)",
    glyph: "AR",
    startupCommands: [
      `echo "argon-web — try a long-running loop, then switch projects:"`,
      `echo "  for i in 1 2 3 4 5 6 7 8 9 10; do echo \\"argon \\$i\\"; sleep 1; done"`,
    ],
  },
  {
    name: "kepler-cli",
    color: "var(--swatch-6)",
    glyph: "KE",
    startupCommands: [`echo "kepler-cli — Cmd/Ctrl+1..3 also switches projects."`],
  },
  {
    name: "borealis-api",
    color: "var(--swatch-3)",
    glyph: "BO",
    startupCommands: [`echo "borealis-api — switch back to argon to see buffered output."`],
  },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const isWin = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

const defaultShell = (): string => {
  if (isWin) return "powershell.exe";
  return isMac ? "/bin/zsh" : "/bin/bash";
};

const spawnShell = async (projectId: string, startupCommands: string[]): Promise<string> => {
  const resp = await ptySpawn({
    command: defaultShell(),
    args: [],
    env: {
      WS_LIVE_HARNESS: "appshell",
      WS_PROJECT_ID: projectId,
    },
    startupCommands,
    cols: 80,
    rows: 24,
  });
  return resp.sessionId;
};

type SpawnState = { kind: "spawning" } | { kind: "ready" } | { kind: "failed"; message: string };

interface EditTarget {
  id: string;
  initial: AddProjectFormValue;
}

interface ContextTarget {
  projectId: string;
  position: { x: number; y: number };
}

export function AppShellLiveHarness(): JSX.Element {
  const [state, setState] = createSignal<SpawnState>({ kind: "spawning" });
  const [collapsed, setCollapsed] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [editTarget, setEditTarget] = createSignal<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<EditTarget | null>(null);
  const [contextTarget, setContextTarget] = createSignal<ContextTarget | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  // Per-project paths so reveal-in-Finder works after edits without
  // round-tripping the DB. Mirrors what the workspace store would hold
  // once projects own their full DB row (T6.6 doesn't promote `path` to
  // ProjectMeta — keeping the store minimal — so we shadow it here.).
  const projectPaths: Record<string, string> = {};
  // Sessions we own per project. We register one shell per project at
  // start; opening more (T5.6) would extend this list.
  const sessionsByProject: Record<string, string[]> = {};

  const trackSession = (projectId: string, sessionId: string): void => {
    const list = sessionsByProject[projectId] ?? [];
    list.push(sessionId);
    sessionsByProject[projectId] = list;
  };

  const seedFromExisting = async (): Promise<void> => {
    const existing = await listProjects();
    const byName = new Map<string, Project>();
    for (const p of existing) byName.set(p.name.trim().toLowerCase(), p);

    for (const demo of DEMO_PROJECTS) {
      const match = byName.get(demo.name.trim().toLowerCase());
      const persisted: Project =
        match ??
        (await createProject({
          name: demo.name,
          path: `/tmp/ws-demo-${demo.name}`,
          color: demo.color,
          icon: demo.glyph,
        }));
      const sessionId = await spawnShell(persisted.id, demo.startupCommands);
      trackSession(persisted.id, sessionId);
      projectPaths[persisted.id] = persisted.path;
      addProject(
        {
          id: persisted.id,
          name: persisted.name,
          color: persisted.color ?? demo.color,
          glyph: persisted.icon ?? demo.glyph,
        },
        { layout: paneNode(sessionId), focusedSessionId: sessionId },
      );
    }
  };

  onMount(() => {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      setState({
        kind: "failed",
        message:
          "Open this page inside the Tauri window (the one `pnpm tauri dev` launches). PTY commands aren't available in a plain browser tab.",
      });
      return;
    }

    void (async () => {
      try {
        await seedFromExisting();
        setState({ kind: "ready" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      // Best-effort kill — failures here just mean the child outlives the
      // harness for a moment. The workspace store is module-scoped so we
      // also clear what we registered to avoid stale projects bleeding
      // into a re-mount.
      for (const list of Object.values(sessionsByProject)) {
        for (const id of list) void ptyKill(id);
      }
      for (const id of Object.keys(sessionsByProject)) {
        setLayout(id, null);
        removeProject(id);
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
    });
    const sessionId = await spawnShell(created.id, [
      `echo "${created.name} — fresh project. Try ls."`,
    ]);
    trackSession(created.id, sessionId);
    projectPaths[created.id] = created.path;
    addProject(
      {
        id: created.id,
        name: created.name,
        color: value.color,
        glyph: value.glyph,
      },
      { layout: paneNode(sessionId), focusedSessionId: sessionId },
    );
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
    });
    projectPaths[target.id] = updated.path;
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
    // Kill PTYs first so the DB delete doesn't leave orphaned children
    // outliving their project. Failures here are non-fatal — the row goes
    // either way and any zombie shell is cleaned up at app exit.
    const owned = sessionsByProject[target.id] ?? [];
    for (const sessionId of owned) {
      try {
        await ptyKill(sessionId);
      } catch {
        // Logged by the backend; nothing the user can do here.
      }
    }
    sessionsByProject[target.id] = [];
    try {
      await deleteProject(target.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      // Re-throw so DeleteProjectConfirm re-arms instead of closing.
      throw err;
    }
    projectPaths[target.id] = "";
    removeProject(target.id);
    setDeleteTarget(null);
    setEditTarget(null);
  };

  // Generation token for in-flight reorders. Bumped on each new drop so
  // that if drop A's IPC fails after drop B has already issued, A's
  // rollback is suppressed — otherwise we'd stomp B's optimistic state
  // back to A's pre-drop snapshot, leaving the UI desynced from the DB.
  let reorderGeneration = 0;

  const handleReorder = async (nextIds: string[]): Promise<void> => {
    const generation = ++reorderGeneration;
    const prev = projects().map((p) => p.id);
    reorderProjectsLocal(nextIds);
    try {
      await reorderProjects(nextIds);
    } catch (err) {
      // Only roll back if no newer drop has landed since this one. If a
      // later drop superseded us, its own commit/rollback owns the truth.
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

  const headerActiveLabel = (): string => {
    const id = activeProjectId();
    const list = projects();
    return list.find((p) => p.id === id)?.name ?? "—";
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="flex items-center gap-3">
          <div class="font-semibold">AppShell harness (T6.2 + T6.5 + T6.6)</div>
          <div class="text-fg-tertiary">
            Cmd/Ctrl+1..3 switches projects (click outside a pane first) · sidebar click also works
            · active: <span class="text-fg">{headerActiveLabel()}</span>
          </div>
        </div>
        <div class="mt-1 text-fg-secondary">
          Run a long loop in argon, switch to kepler/borealis for a few seconds, switch back —
          argon's terminal should show every line that printed while it was hidden. Click "+ New
          project" to add (T6.5). Hover a row → pencil icon, or right-click → context menu, both
          open the Edit modal (T6.6). Edit footer's red "Delete project" opens the confirm modal
          with a 500ms safety delay.
        </div>
        {actionError() ? (
          <div class="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-danger">
            {actionError()}
          </div>
        ) : null}
      </div>
      <div class="min-h-0 overflow-hidden rounded-md border border-border-default">
        <Switch>
          <Match when={state().kind === "spawning"}>
            <div class="p-3 text-xs text-fg-secondary">Spawning project shells…</div>
          </Match>
          <Match when={state().kind === "failed"}>
            <div class="p-3 text-xs text-danger">
              {(() => {
                const s = state();
                return s.kind === "failed" ? `Spawn failed: ${s.message}` : "";
              })()}
            </div>
          </Match>
          <Match when={state().kind === "ready"}>
            <AppShell
              renderPane={renderPane}
              sidebarCollapsed={collapsed()}
              onToggleSidebar={() => setCollapsed((c) => !c)}
              onAddProject={() => setAddOpen(true)}
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
          // Open the confirm modal directly — the Edit modal is *not*
          // opened underneath, since opening "Delete" was a deliberate
          // pick. Cancel returns the user to the project list.
          const meta = projects().find((p) => p.id === t.projectId);
          if (meta) {
            setDeleteTarget({
              id: t.projectId,
              initial: {
                name: meta.name,
                path: projectPaths[t.projectId] ?? "",
                color: meta.color,
                glyph: meta.glyph,
              },
            });
          }
        }}
      />
    </div>
  );
}

export default AppShellLiveHarness;
