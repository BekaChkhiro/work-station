// Floating mini-terminal pinned to the bottom-right of the PlanFlow tab.
//
// The widget gives the user a focused CLI session — Claude / Codex /
// Kimi — scoped to the active project. Earlier iterations tried to
// scrape the CLI's TUI output into chat bubbles, but modern coding
// CLIs animate every "thinking" word and redraw the screen with
// cursor moves, which a plain PTY buffer can't reassemble without a
// real terminal emulator. So we just mount xterm.js directly: the
// user types and reads in the CLI's own UI, exactly the way they do
// in a regular terminal pane.
//
// Three panel states:
//   * collapsed  — small chip ("💬 Claude") in the corner. Click → expand.
//   * expanded   — terminal mounted. Click-outside collapses it.
//   * pinned     — terminal stays open through click-outside until
//                  the user toggles the pin.
//
// CLI swap kills the current PTY and spawns the new one. The scope
// primer is the first thing typed in so the assistant knows to use
// planflow_* MCP tools for this project's plan only.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  untrack,
  type JSX,
} from "solid-js";

import {
  chatCli,
  chatPanel,
  hydrateChatPrefs,
  setChatCli,
  setChatPanel,
} from "../../stores/planflowChatPrefs";
import { cliListAvailable } from "../../ipc/cli";
import type { CliInfo } from "../../ipc/cli";
import { ptyKill, ptySpawn } from "../../ipc/pty";
import { Terminal } from "../Terminal/Terminal";
import { Tooltip } from "../Tooltip";
import { bumpPlanflowChatRefetch } from "../../stores/planflowChatNotify";
import { listProjects, type Project } from "../../db/projects";

export interface PlanFlowChatProps {
  /** Workspace projectId — the local row, used as the chat's primary key. */
  projectId: string;
  /** PlanFlow project UUID, from project_links. Exposed in env so the
   *  CLI can pick it up if its own config does (CLAUDE.md, etc.). */
  externalId: string;
}

export function PlanFlowChat(props: PlanFlowChatProps): JSX.Element {
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [spawnError, setSpawnError] = createSignal<string | null>(null);

  const [availableClis] = createResource<CliInfo[]>(async () => {
    try {
      return await cliListAvailable();
    } catch {
      return [];
    }
  });

  // The project's working directory comes from the same `projects`
  // table the sidebar reads. We fetch it once on mount so the spawn
  // call lands the CLI in the right cwd — matches the convention
  // every other CLI in this app uses (T7.4 default-CLI flow, T12.4
  // task-start launcher).
  const [projectsList] = createResource<Project[]>(async () => {
    try {
      return await listProjects();
    } catch {
      return [];
    }
  });
  const projectCwd = (): string | null => {
    const all = projectsList() ?? [];
    return all.find((p) => p.id === props.projectId)?.path ?? null;
  };

  // Hydrate persisted prefs (selected CLI + panel state) before the
  // first paint so opening the tab doesn't flash a "collapsed" frame
  // when the user pinned the panel last session.
  createEffect(() => {
    hydrateChatPrefs(props.projectId);
  });

  // Default the selected CLI to the first available one whenever the
  // user hasn't already picked.
  createEffect(() => {
    const list = availableClis() ?? [];
    if (list.length === 0) return;
    if (chatCli(props.projectId) != null) return;
    const first = list[0];
    if (!first) return;
    setChatCli(props.projectId, first.name);
  });

  const resolvePath = (cliId: string | null): string | null => {
    if (cliId == null) return null;
    return availableClis()?.find((c) => c.name === cliId)?.path ?? null;
  };

  // Spawn / re-spawn the PTY when the *trigger inputs* — panel state +
  // chosen CLI — change. We use `on(...)` with explicit deps so the
  // effect re-runs ONLY when those signals change, not when the body
  // happens to read other reactive values (like `sessionId`). Without
  // this guard the previous version looped: setSessionId inside the
  // async block was tracked by the surrounding effect, which spawned
  // again, ad infinitum — hence the "session EOF; removing" log spam.
  createEffect(
    on([() => chatPanel(props.projectId), () => chatCli(props.projectId)], ([panel, cli]) => {
      if (panel === "collapsed") {
        const id = untrack(sessionId);
        if (id != null) {
          void ptyKill(id);
          setSessionId(null);
          // When the panel closes we ALSO bump the refetch tick so
          // any task changes the assistant made show up. Guarded by
          // the "had-a-session" check so collapsed → collapsed
          // re-renders don't spam refetches.
          bumpPlanflowChatRefetch(props.projectId);
        }
        return;
      }

      if (cli == null) {
        setSpawnError("No CLI on PATH. Install claude / codex / kimi.");
        return;
      }
      const path = resolvePath(cli);
      if (path == null) {
        setSpawnError(`CLI "${cli}" is not on PATH.`);
        return;
      }
      setSpawnError(null);

      void (async () => {
        // Read + clear the previous session id before awaiting the
        // new spawn so a fast CLI swap doesn't double-spawn. Both
        // reads are untracked because Solid's tracking of async
        // continuations would otherwise re-arm the outer effect.
        const previousId = untrack(sessionId);
        if (previousId != null) {
          void ptyKill(previousId);
        }
        setSessionId(null);
        const cwd = untrack(projectCwd);
        try {
          const resp = await ptySpawn({
            command: path,
            args: [],
            cwd: cwd && cwd.length > 0 ? cwd : undefined,
            env: {
              WS_PROJECT_ID: props.projectId,
              WS_CLI_NAME: cli,
              WS_PLANFLOW_SCOPE: "1",
              // Exposed so the user's own CLAUDE.md / shell config
              // can pick it up if they want planflow_* tools auto-
              // scoped without seeing a wall of primer text.
              WS_PLANFLOW_EXTERNAL_ID: props.externalId,
            },
            cols: 80,
            rows: 24,
          });
          setSessionId(resp.sessionId);
        } catch (error) {
          setSpawnError(error instanceof Error ? error.message : "Couldn't start the CLI.");
        }
      })();
    }),
  );

  onCleanup(() => {
    const id = untrack(sessionId);
    if (id != null) {
      void ptyKill(id);
    }
  });

  const expand = (): void => {
    if (chatPanel(props.projectId) === "collapsed") {
      setChatPanel(props.projectId, "expanded");
    }
  };
  const collapse = (): void => {
    setChatPanel(props.projectId, "collapsed");
  };
  const togglePin = (): void => {
    const current = chatPanel(props.projectId);
    setChatPanel(props.projectId, current === "pinned" ? "expanded" : "pinned");
  };
  const refreshTasks = (): void => {
    bumpPlanflowChatRefetch(props.projectId);
  };

  // Outside-click closes the expanded panel — unless it's pinned.
  let panelRef: HTMLDivElement | undefined;
  createEffect(() => {
    if (chatPanel(props.projectId) !== "expanded") return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (panelRef && target && panelRef.contains(target)) return;
      collapse();
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });

  const chipLabel = createMemo<string>(() => {
    const cli = chatCli(props.projectId);
    if (cli != null && cli.length > 0) {
      return `💬 ${cli.charAt(0).toUpperCase() + cli.slice(1)}`;
    }
    return "💬 Plan chat";
  });

  return (
    <div
      class="ws-pf-chat"
      data-panel={chatPanel(props.projectId)}
      role="region"
      aria-label="PlanFlow chat"
    >
      <Show when={chatPanel(props.projectId) === "collapsed"}>
        <button
          type="button"
          class="ws-pf-chat__chip"
          onClick={expand}
          aria-label="Open PlanFlow chat"
        >
          <span class="ws-pf-chat__chip-dot" data-on={sessionId() != null ? "true" : undefined} />
          <span class="ws-pf-chat__chip-label">{chipLabel()}</span>
        </button>
      </Show>

      <Show when={chatPanel(props.projectId) !== "collapsed"}>
        <div
          class="ws-pf-chat__panel"
          ref={(el) => (panelRef = el)}
          data-pinned={chatPanel(props.projectId) === "pinned" ? "true" : undefined}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header class="ws-pf-chat__head">
            <select
              class="ws-pf-chat__cli-select"
              value={chatCli(props.projectId) ?? ""}
              onChange={(e) => setChatCli(props.projectId, e.currentTarget.value || null)}
              aria-label="Choose CLI"
            >
              <Show when={(availableClis() ?? []).length === 0}>
                <option value="">No CLI on PATH</option>
              </Show>
              <For each={availableClis() ?? []}>
                {(cli) => (
                  <option value={cli.name}>
                    {cli.name.charAt(0).toUpperCase() + cli.name.slice(1)}
                  </option>
                )}
              </For>
            </select>
            <span class="ws-pf-chat__head-spacer" />
            <Tooltip label="Refresh task list">
              <button
                type="button"
                class="ws-pf-chat__head-btn"
                onClick={refreshTasks}
                aria-label="Refresh task list"
              >
                ↻
              </button>
            </Tooltip>
            <Tooltip label={chatPanel(props.projectId) === "pinned" ? "Unpin" : "Pin open"}>
              <button
                type="button"
                class="ws-pf-chat__head-btn"
                data-on={chatPanel(props.projectId) === "pinned" ? "true" : undefined}
                onClick={togglePin}
                aria-label={
                  chatPanel(props.projectId) === "pinned" ? "Unpin chat" : "Pin chat open"
                }
              >
                {chatPanel(props.projectId) === "pinned" ? "📌" : "📍"}
              </button>
            </Tooltip>
            <Tooltip label="Minimize">
              <button
                type="button"
                class="ws-pf-chat__head-btn"
                onClick={collapse}
                aria-label="Minimize chat"
              >
                ✕
              </button>
            </Tooltip>
          </header>

          <Show when={spawnError()}>
            {(msg) => (
              <div class="ws-pf-chat__error" role="status">
                {msg()}
              </div>
            )}
          </Show>

          <div class="ws-pf-chat__term">
            <Show
              when={sessionId()}
              fallback={
                <div class="ws-pf-chat__empty">
                  <Show when={spawnError() == null} fallback={<span>{spawnError()}</span>}>
                    Starting {chatCli(props.projectId) ?? "CLI"}…
                  </Show>
                </div>
              }
            >
              {(id) => (
                <Terminal
                  sessionId={id()}
                  projectId={props.projectId}
                  title={`planflow-chat:${chatCli(props.projectId) ?? "cli"}`}
                  fontSize={12}
                />
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default PlanFlowChat;
