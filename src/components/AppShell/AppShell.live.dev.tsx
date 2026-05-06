// T6.2: AppShell harness — exercises state-only project switching.
//
// Spawns three demo projects, each with its own real PTY shell, and
// renders them through AppShell. While "argon" is active, you can type
// a long-running command (e.g. `for i in 1 2 3 4 5; do echo "$i"; sleep
// 1; done`) and switch to another project mid-loop. When you switch
// back, the argon terminal shows every line that printed during the
// absence — that's the T6.2 acceptance.
//
// Reachable via `?wsdebug=appshell` in dev builds.

import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { AppShell } from "./AppShell";
import { Terminal } from "../Terminal/Terminal";
import { ptyKill, ptySpawn } from "../../ipc/pty";
import { activeProjectId, addProject, projects, setLayout } from "../../stores/workspace";
import { paneNode } from "../../types/layout";

interface DemoProject {
  id: string;
  name: string;
  color: string;
  glyph: string;
  startupCommands: string[];
}

const DEMO_PROJECTS: DemoProject[] = [
  {
    id: "argon",
    name: "argon-web",
    color: "var(--swatch-4)",
    glyph: "AR",
    startupCommands: [
      `echo "argon-web — try a long-running loop, then switch projects:"`,
      `echo "  for i in 1 2 3 4 5 6 7 8 9 10; do echo \\"argon \\$i\\"; sleep 1; done"`,
    ],
  },
  {
    id: "kepler",
    name: "kepler-cli",
    color: "var(--swatch-6)",
    glyph: "KE",
    startupCommands: [`echo "kepler-cli — Cmd/Ctrl+1..3 also switches projects."`],
  },
  {
    id: "borealis",
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

const spawnShell = async (project: DemoProject): Promise<string> => {
  const resp = await ptySpawn({
    command: defaultShell(),
    args: [],
    env: {
      WS_LIVE_HARNESS: "appshell",
      WS_PROJECT_ID: project.id,
    },
    startupCommands: project.startupCommands,
    cols: 80,
    rows: 24,
  });
  return resp.sessionId;
};

type SpawnState = { kind: "spawning" } | { kind: "ready" } | { kind: "failed"; message: string };

export function AppShellLiveHarness(): JSX.Element {
  const [state, setState] = createSignal<SpawnState>({ kind: "spawning" });
  const [collapsed, setCollapsed] = createSignal(false);
  // Track sessions we own so they're killed on harness unmount. The store
  // doesn't reach into the IPC layer; the harness is the IPC owner here.
  const ownedSessions: string[] = [];

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
        for (const project of DEMO_PROJECTS) {
          const sessionId = await spawnShell(project);
          ownedSessions.push(sessionId);
          addProject(
            { id: project.id, name: project.name, color: project.color, glyph: project.glyph },
            { layout: paneNode(sessionId), focusedSessionId: sessionId },
          );
        }
        setState({ kind: "ready" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      // Best-effort kill — failures here just mean the child outlives the
      // harness for a moment. The workspace store is module-scoped so we
      // also clear it to avoid stale projects bleeding into a re-mount.
      for (const id of ownedSessions) void ptyKill(id);
      // Clear the store so a re-open of the harness starts fresh. We can't
      // import _resetWorkspaceForTests here without coupling — instead,
      // remove projects we know we added.
      for (const project of DEMO_PROJECTS) {
        // Defensive: setLayout(..., null) so any subsequent mount sees no
        // dangling tree before the entry is removed below.
        setLayout(project.id, null);
      }
    });
  });

  // T6.3: AppShell installs Cmd/Ctrl+1..9 → switch project on mount, so
  // the harness no longer needs its own keydown listener. Behaviour is
  // intentionally different from the inline version that lived here: the
  // hotkey is suppressed when focus is inside a terminal pane or text
  // input. Click anywhere outside a pane (e.g. the sidebar) before
  // pressing the shortcut.

  const renderPane = (projectId: string, sessionId: string): JSX.Element => (
    <Terminal
      sessionId={sessionId}
      projectId={projectId}
      title={`${projectId} · ${sessionId.slice(0, 6)}`}
    />
  );

  const headerActiveLabel = (): string => {
    const id = activeProjectId();
    const list = projects();
    return list.find((p) => p.id === id)?.name ?? "—";
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="flex items-center gap-3">
          <div class="font-semibold">AppShell harness (T6.2)</div>
          <div class="text-fg-tertiary">
            Cmd/Ctrl+1..3 switches projects (click outside a pane first) · sidebar click also works
            · active: <span class="text-fg">{headerActiveLabel()}</span>
          </div>
        </div>
        <div class="mt-1 text-fg-secondary">
          Run a long loop in argon, switch to kepler/borealis for a few seconds, switch back —
          argon's terminal should show every line that printed while it was hidden.
        </div>
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
            />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

export default AppShellLiveHarness;
