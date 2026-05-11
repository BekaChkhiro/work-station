// Floating mini-terminal panel pinned to the bottom-right of the
// PlanFlow tab. Hosts a tab strip of saved chat sessions — each tab
// is its own CLI process running in the project's working directory.
//
// Why tabs:
//   * The user can keep multiple lines of thought going (e.g. one
//     claude tab planning Phase 22, another running planflow_index)
//     without losing the previous PTY's scrollback.
//   * Closing a tab kills its PTY; the rest keep running.
//   * Switching tabs flips the embedded Terminal renderer to point at
//     the next session's sessionId, which xterm.js handles cleanly
//     via its built-in subscribe/replay.
//
// Persistence model:
//   * Session rows live in SQLite (db/planflowChatSessions) so tabs
//     survive an app restart — the user opens the panel and sees
//     "Session 1, Session 2, …" exactly as they left it.
//   * The live PTY does NOT persist (the host process dies with the
//     app). Each tab is "cold" on the first open after restart;
//     clicking it spawns a fresh CLI.
//   * Active-tab choice is per-project, persisted to localStorage,
//     defaults to the most recently active row.

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
  chatActiveSessionId,
  chatCli,
  chatPanel,
  hydrateChatPrefs,
  setChatActiveSessionId,
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
  closePlanflowChatRuntime,
  planflowChatRuntime,
  setPlanflowChatRuntime,
} from "../../stores/planflowChatSessions";
import {
  createChatSession,
  deleteChatSession,
  listChatSessions,
  renameChatSession,
  touchChatSession,
  type ChatSessionRow,
} from "../../db/planflowChatSessions";
import { listProjects, type Project } from "../../db/projects";

export interface PlanFlowChatProps {
  /** Workspace projectId — the local row, used as the chat's primary key. */
  projectId: string;
  /** PlanFlow project UUID, from project_links. Exposed in env so the
   *  CLI can pick it up if its own config does (CLAUDE.md, etc.). */
  externalId: string;
}

function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function defaultSessionName(count: number): string {
  return `Session ${count + 1}`;
}

export function PlanFlowChat(props: PlanFlowChatProps): JSX.Element {
  const [sessions, setSessions] = createSignal<ChatSessionRow[]>([]);
  const [spawnError, setSpawnError] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");

  const [availableClis] = createResource<CliInfo[]>(async () => {
    try {
      return await cliListAvailable();
    } catch {
      return [];
    }
  });

  // Project cwd — fetched once on mount so the spawn lands the CLI in
  // the right working directory (same convention as T7.4).
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

  // Hydrate persisted prefs (panel state + active session id) before
  // the first paint so opening the tab doesn't flash a "collapsed"
  // frame for a project the user had pinned last session.
  createEffect(() => {
    hydrateChatPrefs(props.projectId);
  });

  // Load the saved session list whenever the project changes.
  createEffect(() => {
    const pid = props.projectId;
    void (async () => {
      const rows = await listChatSessions(pid);
      setSessions(rows);
      // If no active id is set, prefer the most-recently-active row.
      if (chatActiveSessionId(pid) == null && rows.length > 0) {
        setChatActiveSessionId(pid, rows[0]?.id ?? null);
      }
    })();
  });

  // Default the panel-level CLI choice when nothing's been picked.
  // Individual sessions can override via their own cli_id, but the
  // dropdown above the tabs steers new spawns.
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

  const activeRow = createMemo<ChatSessionRow | null>(() => {
    const activeId = chatActiveSessionId(props.projectId);
    if (activeId == null) return null;
    return sessions().find((s) => s.id === activeId) ?? null;
  });

  const sessionCli = (): string | null => {
    const row = activeRow();
    if (!row) return null;
    return planflowChatRuntime(row.id)?.cliId ?? row.cliId ?? null;
  };

  const sessionId = (): string | null => {
    const row = activeRow();
    if (!row) return null;
    return planflowChatRuntime(row.id)?.sessionId ?? null;
  };

  // Spawn / swap / preserve the PTY for the active tab whenever the
  // panel is open. We use `on(...)` with explicit deps so changes to
  // unrelated reactive state (other tabs' runtimes) don't re-run.
  createEffect(
    on(
      [
        () => chatPanel(props.projectId),
        () => activeRow()?.id ?? null,
        () => activeRow()?.cliId ?? null,
      ],
      ([panel, rowId, rowCli]) => {
        if (panel === "collapsed") {
          if (untrack(() => sessionId() != null)) {
            bumpPlanflowChatRefetch(props.projectId);
          }
          return;
        }
        if (rowId == null) return;

        const cli = rowCli ?? chatCli(props.projectId);
        if (cli == null) {
          setSpawnError("No CLI on PATH. Install claude / codex / kimi.");
          return;
        }
        const path = resolvePath(cli);
        if (path == null) {
          setSpawnError(`CLI "${cli}" is not on PATH.`);
          return;
        }

        const existing = untrack(() => planflowChatRuntime(rowId));
        if (existing && existing.cliId === cli) {
          setSpawnError(null);
          return;
        }

        setSpawnError(null);

        void (async () => {
          if (existing) await closePlanflowChatRuntime(rowId);
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
                WS_PLANFLOW_EXTERNAL_ID: props.externalId,
              },
              cols: 80,
              rows: 24,
            });
            setPlanflowChatRuntime(rowId, {
              sessionId: resp.sessionId,
              cliId: cli,
              projectId: props.projectId,
            });
            void touchChatSession(rowId, cli).catch(() => undefined);
          } catch (error) {
            setSpawnError(error instanceof Error ? error.message : "Couldn't start the CLI.");
          }
        })();
      },
    ),
  );

  // No onCleanup — runtimes live in the registry. AppRoot tears
  // everything down on app exit.

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

  const createSession = async (): Promise<void> => {
    const id = newSessionId();
    const cli = chatCli(props.projectId) ?? availableClis()?.[0]?.name ?? null;
    const row = await createChatSession({
      id,
      projectId: props.projectId,
      cliId: cli,
      name: defaultSessionName(sessions().length),
    });
    setSessions((prev) => [row, ...prev]);
    setChatActiveSessionId(props.projectId, row.id);
  };

  const selectSession = (rowId: string): void => {
    setChatActiveSessionId(props.projectId, rowId);
    void touchChatSession(rowId).catch(() => undefined);
  };

  const closeSession = async (rowId: string): Promise<void> => {
    await closePlanflowChatRuntime(rowId);
    await deleteChatSession(rowId);
    setSessions((prev) => prev.filter((s) => s.id !== rowId));
    if (chatActiveSessionId(props.projectId) === rowId) {
      const next = untrack(sessions)[0];
      setChatActiveSessionId(props.projectId, next?.id ?? null);
    }
  };

  const killActiveRuntime = async (): Promise<void> => {
    const row = activeRow();
    if (!row) return;
    await closePlanflowChatRuntime(row.id);
  };

  const startRename = (row: ChatSessionRow): void => {
    setRenamingId(row.id);
    setRenameDraft(row.name);
  };

  const commitRename = async (): Promise<void> => {
    const id = renamingId();
    const name = renameDraft().trim();
    setRenamingId(null);
    if (id == null || name.length === 0) return;
    await renameChatSession(id, name);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
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

  const anyRunning = (): boolean => {
    return sessions().some((s) => planflowChatRuntime(s.id) != null);
  };

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
          <span class="ws-pf-chat__chip-dot" data-on={anyRunning() ? "true" : undefined} />
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
              aria-label="Choose CLI for new sessions"
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
              <Tooltip label="Stop this session">
                <button
                  type="button"
                  class="ws-pf-chat__head-btn ws-pf-chat__head-btn--danger"
                  onClick={() => void killActiveRuntime()}
                  aria-label="Stop this CLI session"
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

          <div class="ws-pf-chat__tabs" role="tablist" aria-label="Chat sessions">
            <div class="ws-pf-chat__tabs-scroll">
              <For each={sessions()}>
                {(row) => {
                  const isActive = (): boolean => chatActiveSessionId(props.projectId) === row.id;
                  const isRunning = (): boolean => planflowChatRuntime(row.id) != null;
                  return (
                    <div
                      class="ws-pf-chat__tab"
                      data-active={isActive() ? "true" : undefined}
                      role="tab"
                      aria-selected={isActive()}
                    >
                      <button
                        type="button"
                        class="ws-pf-chat__tab-main"
                        onClick={() => selectSession(row.id)}
                        onDblClick={() => startRename(row)}
                        aria-label={`Switch to ${row.name}`}
                      >
                        <span
                          class="ws-pf-chat__tab-dot"
                          data-on={isRunning() ? "true" : undefined}
                          aria-hidden="true"
                        />
                        <Show
                          when={renamingId() === row.id}
                          fallback={
                            <span class="ws-pf-chat__tab-name" title={row.name}>
                              {row.name}
                            </span>
                          }
                        >
                          <input
                            class="ws-pf-chat__tab-rename"
                            value={renameDraft()}
                            onInput={(e) => setRenameDraft(e.currentTarget.value)}
                            onBlur={() => void commitRename()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRename();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenamingId(null);
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            ref={(el) => {
                              queueMicrotask(() => {
                                el.focus();
                                el.select();
                              });
                            }}
                          />
                        </Show>
                      </button>
                      <button
                        type="button"
                        class="ws-pf-chat__tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          void closeSession(row.id);
                        }}
                        aria-label={`Close ${row.name}`}
                        title="Close tab"
                      >
                        <IconMinimize size={10} />
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
            <Tooltip label="New session">
              <button
                type="button"
                class="ws-pf-chat__tab-add"
                onClick={() => void createSession()}
                aria-label="Start a new chat session"
              >
                <IconPlus />
              </button>
            </Tooltip>
          </div>

          <Show when={spawnError()}>
            {(msg) => (
              <div class="ws-pf-chat__error" role="status">
                {msg()}
              </div>
            )}
          </Show>

          <div class="ws-pf-chat__term">
            <Show
              when={activeRow()}
              fallback={
                <div class="ws-pf-chat__empty">
                  <span>No sessions yet — click + to start one.</span>
                </div>
              }
            >
              {(row) => (
                <Show
                  when={planflowChatRuntime(row().id)?.sessionId}
                  fallback={
                    <div class="ws-pf-chat__empty">
                      <Show when={spawnError() == null} fallback={<span>{spawnError()}</span>}>
                        <span>Starting {sessionCli() ?? "CLI"}…</span>
                      </Show>
                    </div>
                  }
                >
                  {(sid) => (
                    <Terminal
                      sessionId={sid()}
                      projectId={props.projectId}
                      title={`planflow-chat:${sessionCli() ?? "cli"}`}
                      fontSize={12}
                    />
                  )}
                </Show>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default PlanFlowChat;

/* ─── Inline icon components ─────────────────────────────────────── */

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

function IconPlus(props: { size?: number } = {}): JSX.Element {
  return (
    <svg {...iconProps(props.size)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
