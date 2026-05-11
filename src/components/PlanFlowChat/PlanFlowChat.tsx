// Floating chat widget pinned to the bottom-right of the PlanFlow tab.
//
// The widget gives the user a focused way to ask their CLI of choice
// (claude / kimi / codex) to mutate the *plan*: add / edit / delete /
// reorder tasks, update statuses, save knowledge. Scope is enforced
// outside this file — Phase 3 spawns the CLI with a system-prompt
// template + an MCP whitelist that only exposes planflow-mcp.
//
// Three panel states:
//   * collapsed  — small chip ("💬 Claude") in the corner. Click → expand.
//   * expanded   — full panel mounted. Click-outside collapses it.
//   * pinned     — full panel, stays open through click-outside until
//                  the user toggles the pin.
//
// Phase 2 (this file) ships UI + history + bridge plumbing. The send
// handler calls `sendChatMessage` from `planflowChatBridge`; until
// Phase 3 wires a real PTY, the call throws and we surface a banner.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";

import {
  appendChatMessage,
  clearChatHistory,
  loadChatHistory,
  type ChatMessage,
  type ToolCall,
} from "../../db/planflowChats";
import {
  chatCli,
  chatPanel,
  hydrateChatPrefs,
  setChatCli,
  setChatPanel,
} from "../../stores/planflowChatPrefs";
import {
  endChatSession,
  hasChatBridge,
  sendChatMessage,
  startChatSession,
} from "../../stores/planflowChatBridge";
import { cliListAvailable } from "../../ipc/cli";
import type { CliInfo } from "../../ipc/cli";
import { Tooltip } from "../Tooltip";
import { renderChatMarkdown } from "./markdown";

export interface PlanFlowChatProps {
  /** Workspace projectId — the local row, used as the chat's primary key. */
  projectId: string;
  /** PlanFlow project UUID, from project_links. Passed to the bridge so
   *  the CLI can hit the right project via planflow_* MCP tools. */
  externalId: string;
}

export function PlanFlowChat(props: PlanFlowChatProps): JSX.Element {
  // The chip is always rendered; the expanded panel mounts on-demand
  // so a project the user never opens the chat for doesn't pay the
  // PTY spawn cost (Phase 3).
  const [history, setHistory] = createSignal<ChatMessage[]>([]);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Available CLIs come from the existing PATH scan (T7.1). The widget
  // shows whatever is on PATH; if none are detected the dropdown is
  // disabled with a hint.
  const [availableClis] = createResource<CliInfo[]>(async () => {
    try {
      return await cliListAvailable();
    } catch {
      return [];
    }
  });

  // Hydrate persisted prefs (selected CLI + panel state) before the
  // first paint so opening Settings doesn't flash a "collapsed" frame
  // when the user pinned the panel last session.
  createEffect(() => {
    hydrateChatPrefs(props.projectId);
  });

  // Load the transcript on mount + whenever the project changes. The
  // chat persists per-project so switching workspaces yields a fresh
  // (or empty) thread.
  createEffect(() => {
    const pid = props.projectId;
    void (async () => {
      const rows = await loadChatHistory(pid);
      setHistory(rows);
    })();
  });

  // Pick a default CLI when none is persisted: first available wins.
  // Re-runs when `availableClis` resolves so a brand-new project lands
  // on a real selection instead of `null`.
  createEffect(() => {
    const list = availableClis() ?? [];
    if (list.length === 0) return;
    if (chatCli(props.projectId) != null) return;
    const first = list[0];
    if (!first) return;
    setChatCli(props.projectId, first.name);
  });

  // Tell the bridge to spin up a session when the panel first opens
  // (or when the CLI selection changes). End the session when the panel
  // collapses so the PTY can release resources.
  createEffect(() => {
    const panel = chatPanel(props.projectId);
    const cli = chatCli(props.projectId);
    if (cli == null) return;
    if (panel === "collapsed") {
      void endChatSession(props.projectId, cli);
      return;
    }
    void startChatSession(props.projectId, cli);
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

  // Outside-click closes the expanded panel — unless it's pinned. Pinned
  // panels only close on explicit minimize. We capture the click at the
  // document level so a click inside the panel's own children (e.g.
  // textarea autofocus) doesn't trip the close.
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

  const lastCli = createMemo<string | null>(() => {
    const all = history();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const row = all[i];
      if (row?.cli) return row.cli;
    }
    return chatCli(props.projectId);
  });

  const chipLabel = createMemo<string>(() => {
    const cli = chatCli(props.projectId) ?? lastCli();
    if (cli != null && cli.length > 0) {
      return `💬 ${cli.charAt(0).toUpperCase() + cli.slice(1)}`;
    }
    return "💬 Plan chat";
  });

  const handleSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const content = draft().trim();
    if (content.length === 0 || sending()) return;
    const cli = chatCli(props.projectId);
    if (cli == null) {
      setError("No CLI selected — pick one above.");
      return;
    }
    setSending(true);
    setError(null);
    // Optimistic append: the user sees their message instantly even
    // if the bridge takes a moment.
    const userRow = await appendChatMessage({
      projectId: props.projectId,
      role: "user",
      content,
      cli,
    });
    setHistory((prev) => [...prev, userRow]);
    setDraft("");

    try {
      const result = await sendChatMessage({
        projectId: props.projectId,
        externalId: props.externalId,
        cliId: cli,
        content,
      });
      const assistantRow = await appendChatMessage({
        projectId: props.projectId,
        role: "assistant",
        content: result.content,
        cli,
        toolCalls: result.toolCalls ?? null,
      });
      setHistory((prev) => [...prev, assistantRow]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't reach the CLI. Try again.";
      setError(message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const form = (event.currentTarget as HTMLTextAreaElement).form;
      if (form) form.requestSubmit();
    }
  };

  const handleClear = async (): Promise<void> => {
    if (!window.confirm("Clear this project's chat history?")) return;
    await clearChatHistory(props.projectId);
    setHistory([]);
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
          <span class="ws-pf-chat__chip-dot" data-on={hasChatBridge() ? "true" : undefined} />
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
              disabled={sending()}
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
            <Tooltip label="Clear history">
              <button
                type="button"
                class="ws-pf-chat__head-btn"
                onClick={() => void handleClear()}
                aria-label="Clear chat history"
              >
                ⌫
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

          <Show when={!hasChatBridge()}>
            <div class="ws-pf-chat__notice" role="status">
              CLI transport not connected yet — Phase 3 hooks the hidden PTY in. Messages save to
              history but the assistant won't reply.
            </div>
          </Show>

          <div class="ws-pf-chat__log" role="log" aria-live="polite">
            <Show when={history().length === 0}>
              <div class="ws-pf-chat__empty">
                Ask the CLI to add, edit, or reorder tasks. Tools are scoped to this project's plan.
              </div>
            </Show>
            <For each={history()}>{(msg) => <ChatBubble message={msg} />}</For>
            <Show when={sending()}>
              <div class="ws-pf-chat__pending" aria-label="Assistant is thinking">
                <span class="ws-pf-chat__pending-dot" />
                <span class="ws-pf-chat__pending-dot" />
                <span class="ws-pf-chat__pending-dot" />
              </div>
            </Show>
          </div>

          <Show when={error()}>{(msg) => <div class="ws-pf-chat__error">{msg()}</div>}</Show>

          <form class="ws-pf-chat__composer" onSubmit={(e) => void handleSubmit(e)}>
            <textarea
              class="ws-pf-chat__input"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Add task, fix typo, rename phase…  (Enter to send, Shift+Enter for newline)"
              rows={2}
              disabled={sending()}
            />
            <button
              type="submit"
              class="ws-pf-chat__send"
              disabled={sending() || draft().trim().length === 0}
              aria-label="Send message"
            >
              {sending() ? "…" : "↑"}
            </button>
          </form>
        </div>
      </Show>
    </div>
  );
}

function ChatBubble(props: { message: ChatMessage }): JSX.Element {
  const isUser = (): boolean => props.message.role === "user";
  const isSystem = (): boolean => props.message.role === "system";
  // Assistant content is rendered through the minimal markdown helper
  // so backticks, **bold**, lists, and fenced code blocks come out
  // legible. User messages stay plain text — the user typed them and
  // we don't want to render their own asterisks as formatting.
  const renderedHtml = (): string =>
    isUser() || isSystem() ? "" : renderChatMarkdown(props.message.content);
  return (
    <div
      class="ws-pf-chat__bubble"
      data-role={props.message.role}
      data-system={isSystem() ? "true" : undefined}
    >
      <Show when={!isUser() && !isSystem() && props.message.cli}>
        {(cli) => <span class="ws-pf-chat__bubble-author">{cli()}</span>}
      </Show>
      <Show
        when={!isUser() && !isSystem()}
        fallback={<div class="ws-pf-chat__bubble-content">{props.message.content}</div>}
      >
        <div
          class="ws-pf-chat__bubble-content ws-pf-chat__bubble-content--md"
          // eslint-disable-next-line solid/no-innerhtml
          innerHTML={renderedHtml()}
        />
      </Show>
      <Show when={(props.message.toolCalls ?? []).length > 0}>
        <ul class="ws-pf-chat__tools" role="list">
          <For each={props.message.toolCalls ?? []}>
            {(call: ToolCall) => (
              <li class="ws-pf-chat__tool-chip" title={JSON.stringify(call.args ?? {})}>
                ✏ {call.name}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export default PlanFlowChat;
