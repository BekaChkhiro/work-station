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
import { ptySpawn } from "../../ipc/pty";
import { Terminal } from "../Terminal/Terminal";
import { Tooltip } from "../Tooltip";
import { bumpPlanflowChatRefetch } from "../../stores/planflowChatNotify";
import {
  closePlanflowChatSession,
  planflowChatSession,
  setPlanflowChatSession,
} from "../../stores/planflowChatSessions";
import { listProjects, type Project } from "../../db/projects";

export interface PlanFlowChatProps {
  /** Workspace projectId — the local row, used as the chat's primary key. */
  projectId: string;
  /** PlanFlow project UUID, from project_links. Exposed in env so the
   *  CLI can pick it up if its own config does (CLAUDE.md, etc.). */
  externalId: string;
}

export function PlanFlowChat(props: PlanFlowChatProps): JSX.Element {
  // Reactive read of the project's session from the module-level
  // registry. Keeping the source of truth outside the component is
  // what lets the PTY live through panel collapses and project
  // switches — see planflowChatSessions for the lifecycle contract.
  const session = (): ReturnType<typeof planflowChatSession> =>
    planflowChatSession(props.projectId);
  const sessionId = (): string | null => session()?.sessionId ?? null;
  const sessionCli = (): string | null => session()?.cliId ?? null;
  const [spawnError, setSpawnError] = createSignal<string | null>(null);
  const [spawning, setSpawning] = createSignal(false);

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

  // Spawn / swap / preserve the PTY based on panel state + selected
  // CLI. Lifecycle contract:
  //   * panel collapsed → DO NOTHING (session keeps running). The
  //     xterm renderer is unmounted, but the underlying PTY is alive
  //     in the registry so re-opening just re-attaches.
  //   * panel expanded/pinned + no session yet → spawn fresh CLI.
  //   * panel expanded/pinned + existing session for a DIFFERENT cli
  //     → kill the old one and spawn the new one (user-driven CLI
  //     swap).
  //   * panel expanded/pinned + matching session → noop, the existing
  //     PTY stays.
  // We use `on(...)` with explicit deps so reads of `session()`,
  // `projectCwd()` etc. inside the body don't add reactive deps that
  // would trigger redundant re-runs.
  createEffect(
    on([() => chatPanel(props.projectId), () => chatCli(props.projectId)], ([panel, cli]) => {
      if (panel === "collapsed") {
        // Bump the task list refetch tick once whenever the panel
        // collapses with an active session — likely the assistant
        // edited something while it was open.
        if (untrack(session) != null) bumpPlanflowChatRefetch(props.projectId);
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

      const existing = untrack(session);
      if (existing && existing.cliId === cli) {
        // Same CLI is already running — leave it. Clears any stale
        // spawn error from a previous attempt.
        setSpawnError(null);
        return;
      }

      setSpawnError(null);
      setSpawning(true);

      void (async () => {
        if (existing) {
          // CLI changed → tear down the previous session before
          // spawning the new one. closePlanflowChatSession kills the
          // PTY and removes the registry entry.
          await closePlanflowChatSession(props.projectId);
        }
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
          setPlanflowChatSession(props.projectId, {
            sessionId: resp.sessionId,
            cliId: cli,
          });
        } catch (error) {
          setSpawnError(error instanceof Error ? error.message : "Couldn't start the CLI.");
        } finally {
          setSpawning(false);
        }
      })();
    }),
  );

  // No onCleanup tear-down — the session is owned by the registry,
  // not by this component. AppRoot calls closeAllPlanflowChatSessions
  // on app exit. A component remount (HMR, project switch) leaves the
  // PTY running so the user keeps their conversation.

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
  const closeSession = async (): Promise<void> => {
    await closePlanflowChatSession(props.projectId);
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
      return `${cli.charAt(0).toUpperCase() + cli.slice(1)}`;
    }
    return "Plan chat";
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
          <span class="ws-pf-chat__chip-icon" aria-hidden="true">
            <IconChat />
          </span>
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
                <IconRefresh />
              </button>
            </Tooltip>
            <Show when={sessionId() != null}>
              <Tooltip label="Close CLI session">
                <button
                  type="button"
                  class="ws-pf-chat__head-btn ws-pf-chat__head-btn--danger"
                  onClick={() => void closeSession()}
                  aria-label="Close CLI session"
                >
                  <IconStop />
                </button>
              </Tooltip>
            </Show>
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
                <Show when={chatPanel(props.projectId) === "pinned"} fallback={<IconPin />}>
                  <IconPinOff />
                </Show>
              </button>
            </Tooltip>
            <Tooltip label="Minimize">
              <button
                type="button"
                class="ws-pf-chat__head-btn"
                onClick={collapse}
                aria-label="Minimize chat"
              >
                <IconMinimize />
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
                    <Show
                      when={spawning()}
                      fallback={<span>No session — pick a CLI to start.</span>}
                    >
                      Starting {chatCli(props.projectId) ?? "CLI"}…
                    </Show>
                  </Show>
                </div>
              }
            >
              {(id) => (
                <Terminal
                  sessionId={id()}
                  projectId={props.projectId}
                  title={`planflow-chat:${sessionCli() ?? "cli"}`}
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

/* ─── Inline icon components ─────────────────────────────────────────
 *
 * Lucide-style strokes, currentColor so they inherit the surrounding
 * text colour (which lets the data-on / data-danger button styles
 * tint them without per-icon overrides). 14×14 viewport keeps them
 * proportionate to the 22px header buttons. */

function iconProps(size?: number): JSX.IntrinsicElements["svg"] {
  return {
    width: size ?? 14,
    height: size ?? 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.8,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
}

function IconChat(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function IconRefresh(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function IconStop(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function IconPin(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1V4H8v2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
    </svg>
  );
}

function IconPinOff(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <line x1="2" y1="2" x2="22" y2="22" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M9 4h7v2h-1v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17h-9" />
      <path d="M9 6v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17" />
    </svg>
  );
}

function IconMinimize(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
