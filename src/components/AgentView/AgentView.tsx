// Rich "Agent view" for Claude Code — POC (Path B from
// docs/cmux-competitive-analysis.md §"VS Code-like" experience).
//
// Presentational shell only: all session state (the live `claude` child, the
// parsed event log, status) lives in the module-level registry in
// `agentSession.ts`, keyed by the layout sessionId, so it survives the
// unmount/remount a layout split triggers — mirroring how the PTY Terminal
// survives because its state lives in the backend.
//
// Design follows the OpenAI Codex app: centered conversation column,
// right-aligned user bubbles, clean assistant prose with inline code,
// grouped "N files changed" cards, and functional model / permission
// selectors in the composer.

import {
  For,
  Show,
  Switch,
  Match,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX } from "solid-js";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { saveClipboardImage } from "../../ipc/clipboard";
import {
  acquireAgentSession,
  asString,
  listSessions,
  type AssistantItem,
  type Item,
  type NoteItem,
  type SessionMeta,
  type SlashCommand,
  type ToolItem,
  type ToolStatus,
  type UserMsgItem,
} from "./agentSession";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { renderAgentMarkdown } from "./markdown";
import { GitReviewPanel } from "./GitReviewPanel";
import "./agentView.css";

export interface AgentViewProps {
  /** Stable layout sessionId — the registry key for this pane's session. */
  sessionId: string;
  /** Absolute path to the `claude` binary (from CLI detection). */
  command?: string;
  /** Working directory the agent runs in. */
  cwd?: string;
  /** `--permission-mode` for the session. Defaults to `acceptEdits`. */
  permissionMode?: string;
  /** Optional `--model` override. */
  model?: string;
  /** Header label. */
  title?: string;
  /** Project name shown muted beside the title (Codex-style). */
  projectName?: string;
}

const PERMISSION_OPTIONS: { value: string; label: string }[] = [
  { value: "acceptEdits", label: "Accept edits" },
  { value: "default", label: "Ask each time" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass all" },
];
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Opus (default)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

const COLLAPSE_THRESHOLD = 8;
const COLLAPSE_TAIL = 6;

// Lightweight tools render as a slim one-line row (not an expandable card).
const ONELINE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "Bash"]);
const isOneLineTool = (item: Item): item is ToolItem =>
  item.kind === "tool" && ONELINE_TOOLS.has(item.name);

const isFileEdit = (item: Item): item is ToolItem =>
  item.kind === "tool" &&
  (item.name === "Edit" || item.name === "MultiEdit" || item.name === "Write");

// Subagent spawns (the `Task`/`Agent` tool) and task-management tools get
// their own live-status panel instead of cluttering the transcript.
const isSubagentTool = (item: Item): item is ToolItem =>
  item.kind === "tool" &&
  (item.name === "Task" || item.name === "Agent" || item.input.subagent_type != null);

const TASK_MGMT_TOOLS = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
]);
const isTaskMgmtTool = (item: Item): item is ToolItem =>
  item.kind === "tool" && TASK_MGMT_TOOLS.has(item.name);

interface TaskRow {
  id: string;
  title: string;
  status: string;
}

type RenderNode = { kind: "files"; id: string; tools: ToolItem[] } | { kind: "item"; item: Item };

/** Collapse runs of consecutive file-edit tool calls into one grouped
 *  "files changed" card; everything else renders inline. */
const editFilePath = (t: ToolItem): string => asString(t.input.file_path) || asString(t.input.path);

const groupNodes = (items: Item[]): RenderNode[] => {
  const out: RenderNode[] = [];
  let run: ToolItem[] = [];
  const flush = (): void => {
    // Drop empty `{}` partials (no file) and dedupe by tool-use id so a file
    // never appears twice in the "files changed" card.
    const seen = new Set<string>();
    const clean = run.filter((t) => {
      if (editFilePath(t).length === 0 || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    if (clean.length > 0) {
      out.push({ kind: "files", id: clean.map((t) => t.id).join("+"), tools: clean });
    }
    run = [];
  };
  for (const item of items) {
    if (isFileEdit(item)) {
      run.push(item);
    } else {
      flush();
      out.push({ kind: "item", item });
    }
  }
  flush();
  return out;
};

export function AgentView(props: AgentViewProps): JSX.Element {
  // A pane's sessionId and launch options are fixed for its lifetime, so
  // reading them once at setup is correct — the registry keys on sessionId.
  /* eslint-disable solid/reactivity */
  const ctrl = acquireAgentSession(props.sessionId, {
    command: props.command,
    cwd: props.cwd,
    permissionMode: props.permissionMode,
    model: props.model,
    projectName: props.projectName,
  });
  /* eslint-enable solid/reactivity */

  let scroller: HTMLDivElement | undefined;
  let textarea: HTMLTextAreaElement | undefined;
  // Smart scroll: only stick to the bottom when the user is already there, so
  // scrolling up to read earlier output isn't yanked back down by streaming.
  let atBottom = true;
  const onScroll = (): void => {
    if (scroller) {
      atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    }
  };
  createEffect(() => {
    // Track item count AND the streaming text length of the last assistant
    // message, so the view follows tokens as they arrive (appending text to
    // an existing item doesn't change the count). Without this the final
    // chunk lands below the fold and only scrolls into view on the next turn.
    const items = ctrl.items();
    let sig = items.length;
    const last = items[items.length - 1];
    if (last && last.kind === "assistant") sig += last.text.length;
    void sig;
    void ctrl.busy();
    queueMicrotask(() => {
      if (scroller && atBottom) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  // Per-id expand state, kept here (not in the row components) so it survives
  // the frequent remounts caused by streaming token updates.
  const [openIds, setOpenIds] = createSignal<ReadonlySet<string>>(new Set());
  const isOpen = (id: string): boolean => openIds().has(id);
  const toggleOpen = (id: string): void => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [menuOpen, setMenuOpen] = createSignal(false);
  const [showAll, setShowAll] = createSignal(false);
  // Pending file/image attachments — shown as chips above the composer and
  // folded into the message text on send (Claude reads them by path).
  const [attachments, setAttachments] = createSignal<string[]>([]);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [sessions, setSessions] = createSignal<SessionMeta[]>([]);
  const openHistory = (): void => {
    setSessions(listSessions());
    setMenuOpen(false);
    setHistoryOpen(true);
  };

  // Git review panel — refresh its status each time a turn finishes, since the
  // agent likely edited files.
  const [showReview, setShowReview] = createSignal(false);
  const [reviewKey, setReviewKey] = createSignal(0);
  let prevBusy = false;
  let prevEdit = 0;
  createEffect(() => {
    const b = ctrl.busy();
    const e = ctrl.editTick();
    // Refresh the review when a turn finishes OR the instant a file edit
    // lands (live), so changes appear without a manual refresh.
    if ((prevBusy && !b) || e !== prevEdit) setReviewKey((k) => k + 1);
    prevBusy = b;
    prevEdit = e;
  });

  // Subagent spawns (Task/Agent) and task-management tools are lifted out of
  // the inline transcript into the dedicated status panel above the composer.
  // Filter out the empty `{}` partials and dedupe by tool-use id.
  const subagents = createMemo(() => {
    const map = new Map<string, ToolItem>();
    for (const it of ctrl.items()) {
      if (!isSubagentTool(it)) continue;
      if (it.input.subagent_type == null && asString(it.input.description).length === 0) continue;
      map.set(it.id, it);
    }
    return [...map.values()];
  });

  // Tasks: built authoritatively from the task tools' *results* (parsed in
  // chronological order so the latest state wins):
  //   • TaskCreate → "Task #N created successfully: TITLE"
  //   • TaskList   → "#N [status] TITLE"  (full snapshot)
  //   • TaskUpdate → status from the tool input (result has no status)
  const tasks = createMemo<TaskRow[]>(() => {
    const map = new Map<string, TaskRow>();
    const upsert = (id: string, patch: Partial<TaskRow>): void => {
      const row = map.get(id) ?? { id, title: `Task ${id}`, status: "pending" };
      if (patch.title) row.title = patch.title;
      if (patch.status) row.status = patch.status;
      map.set(id, row);
    };
    for (const it of ctrl.items()) {
      if (!isTaskMgmtTool(it)) continue;
      if (it.name === "TaskCreate") {
        const m = /Task #(\d+) created successfully:\s*(.+)/.exec(it.result);
        if (m?.[1]) upsert(m[1], { title: m[2]?.trim() });
      } else if (it.name === "TaskList") {
        for (const raw of it.result.split("\n")) {
          const m = /^#(\d+)\s*\[([^\]]+)\]\s*(.*)$/.exec(raw.trim());
          if (m?.[1]) upsert(m[1], { status: m[2]?.trim(), title: m[3]?.trim() || undefined });
        }
      } else if (it.name === "TaskUpdate") {
        const id = asString(it.input.taskId);
        if (id) upsert(id, { status: asString(it.input.status) || undefined });
      }
    }
    return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
  });

  // Hide each section once its work is done: tasks vanish when all complete,
  // agents vanish when none are still running.
  const showTasks = (): boolean => tasks().some((t) => t.status !== "completed");
  const showAgents = (): boolean => subagents().some((a) => a.status === "pending");

  const nodes = createMemo(() =>
    groupNodes(ctrl.items().filter((it) => !isSubagentTool(it) && !isTaskMgmtTool(it))),
  );
  const hiddenCount = (): number => {
    const n = nodes().length;
    return showAll() || n <= COLLAPSE_THRESHOLD ? 0 : n - COLLAPSE_TAIL;
  };
  const visibleNodes = (): RenderNode[] => {
    const n = nodes();
    return hiddenCount() === 0 ? n : n.slice(-COLLAPSE_TAIL);
  };

  const statusLabel = (): string => (ctrl.closed() ? "Ended" : ctrl.busy() ? "Working…" : "Ready");
  const canSend = (): boolean =>
    (ctrl.draft().trim().length > 0 || attachments().length > 0) && !ctrl.closed();

  // Send: fold any attachment paths into the message text, then dispatch.
  const submit = (): void => {
    if (!canSend()) return;
    const atts = attachments();
    if (atts.length > 0) {
      const joined = atts.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
      const text = ctrl.draft().trim();
      ctrl.setDraft(text.length > 0 ? `${text} ${joined}` : joined);
      setAttachments([]);
    }
    ctrl.send();
  };

  // Slash-command autocomplete: active while the draft is a single "/token".
  const [slashSel, setSlashSel] = createSignal(0);
  const slashMatches = (): SlashCommand[] => {
    const d = ctrl.draft();
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return [];
    const q = d.slice(1).toLowerCase();
    return ctrl.slashCommands().filter((c) => c.name.toLowerCase().startsWith(q));
  };
  const slashOpen = (): boolean => slashMatches().length > 0;
  createEffect(() => {
    if (slashSel() >= slashMatches().length) setSlashSel(0);
  });
  const pickSlash = (cmd: SlashCommand): void => {
    ctrl.setDraft(`/${cmd.name} `);
    setSlashSel(0);
    textarea?.focus();
  };

  // Append file/image paths to the prompt. Claude reads them via its Read
  // tool (text) or vision (images) by path — no base64 plumbing needed.
  const appendPaths = (paths: string[]): void => {
    if (paths.length === 0) return;
    setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    textarea?.focus();
  };
  const removeAttachment = (index: number): void => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // "+" button: pick files via the OS dialog.
  const attachFiles = (): void => {
    void (async () => {
      try {
        const picked = await openFileDialog({ multiple: true, directory: false });
        if (!picked) return;
        appendPaths(Array.isArray(picked) ? picked : [picked]);
      } catch {
        /* dialog unavailable / cancelled */
      }
    })();
  };

  // Paste an image from the clipboard → save to a temp PNG and attach its path.
  const onPaste = (e: ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      void file
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (const b of bytes) binary += String.fromCharCode(b);
          return saveClipboardImage(btoa(binary));
        })
        .then((path) => appendPaths([path]))
        .catch(() => {
          /* clipboard image save failed — ignore */
        });
      return;
    }
  };

  // Drag-and-drop files/images onto the composer (Tauri webview drag-drop).
  let composerEl: HTMLDivElement | undefined;
  onMount(() => {
    let unlisten: (() => void) | null = null;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type !== "drop" || !composerEl) return;
          const rect = composerEl.getBoundingClientRect();
          const { x, y } = event.payload.position;
          if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
          appendPaths(event.payload.paths);
        })
        .then((u) => {
          unlisten = u;
        })
        .catch(() => {
          /* not in Tauri */
        });
    } catch {
      /* not in Tauri */
    }
    onCleanup(() => unlisten?.());
  });

  // Auto-grow the composer up to ~3 lines, then scroll internally.
  createEffect(() => {
    void ctrl.draft();
    queueMicrotask(() => {
      const el = textarea;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
    });
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (slashOpen()) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashSel((i) => Math.min(i + 1, slashMatches().length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashSel((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const cmd = slashMatches()[slashSel()];
        if (cmd) pickSlash(cmd);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const permissionLabel = (): string =>
    PERMISSION_OPTIONS.find((o) => o.value === ctrl.chosenPermission())?.label ??
    ctrl.chosenPermission();
  const modelLabel = (): string =>
    MODEL_OPTIONS.find((o) => o.value === ctrl.chosenModel())?.label ?? ctrl.chosenModel();

  return (
    <Show
      when={ctrl.fatal() === null}
      fallback={
        <div class="flex h-full items-center justify-center bg-canvas p-6 text-center text-[13px] text-danger">
          Agent failed: {ctrl.fatal()}
        </div>
      }
    >
      <div class="flex h-full min-h-0 flex-col bg-canvas text-fg">
        {/* Header */}
        <header class="border-b border-border-default py-2.5">
          <div
            class="relative flex w-full items-center gap-2.5 px-5"
            classList={{ "mx-auto max-w-3xl": !showReview() }}
          >
            <span class="flex h-5 w-5 items-center justify-center rounded-md bg-accent/10 text-[10px] font-semibold text-accent">
              CC
            </span>
            <span class="text-[13px] font-medium">{props.title ?? "Claude Code"}</span>
            <Show when={props.projectName}>
              <span class="text-[12px] text-fg-secondary">{props.projectName}</span>
            </Show>
            <Show when={ctrl.model()}>
              <span class="truncate rounded-full border border-border-default px-2 py-0.5 text-[11px] text-fg-secondary">
                {ctrl.model()}
              </span>
            </Show>
            <span class="ml-auto flex items-center gap-2.5 text-[11px] text-fg-secondary">
              <span class="flex items-center gap-1.5">
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  classList={{
                    "bg-success": ctrl.busy(),
                    "bg-border-strong": !ctrl.busy() && !ctrl.closed(),
                    "bg-danger": ctrl.closed(),
                  }}
                />
                {statusLabel()}
              </span>
              <button
                type="button"
                class="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover"
                classList={{ "bg-accent/10 text-accent": showReview() }}
                aria-label="Toggle review panel"
                aria-pressed={showReview()}
                onClick={() => setShowReview((v) => !v)}
              >
                <IconReview />
                Review
              </button>
              <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-fg-secondary hover:bg-hover"
                aria-label="Session menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <IconDots />
              </button>
            </span>
            <Show when={menuOpen()}>
              <Menu onClose={() => setMenuOpen(false)}>
                <MenuItem
                  label="New session"
                  onClick={() => {
                    ctrl.restart();
                    setMenuOpen(false);
                  }}
                />
                <MenuItem label="History…" onClick={openHistory} />
              </Menu>
            </Show>
            <Show when={historyOpen()}>
              <Menu wide onClose={() => setHistoryOpen(false)}>
                <Show
                  when={sessions().length > 0}
                  fallback={
                    <div class="px-3 py-2 text-[12px] text-fg-secondary">No past sessions yet.</div>
                  }
                >
                  <For each={sessions()}>
                    {(s) => (
                      <button
                        type="button"
                        class="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-hover"
                        onClick={() => {
                          ctrl.resumeSession(s.claudeId);
                          setHistoryOpen(false);
                        }}
                      >
                        <span class="truncate text-[12.5px]">{s.title}</span>
                        <span class="truncate text-[11px] text-fg-secondary">
                          {s.projectName ? `${s.projectName} · ` : ""}
                          {relTime(s.updatedAt)}
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </Menu>
            </Show>
          </div>
        </header>

        <div class="flex min-h-0 flex-1">
          {/* Chat column */}
          <div class="flex min-h-0 flex-1 flex-col">
            {/* Conversation */}
            <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
              <div class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
                <Show when={ctrl.items().length === 0}>
                  <div class="pt-10 text-center text-[13px] text-fg-secondary">
                    Ask Claude Code anything. Edits, commands, and diffs render inline.
                  </div>
                </Show>

                <Show when={hiddenCount() > 0}>
                  <button
                    type="button"
                    class="flex items-center gap-1.5 self-center rounded-full border border-border-default px-3 py-1 text-[12px] text-fg-secondary hover:bg-hover"
                    onClick={() => setShowAll(true)}
                  >
                    <IconChevron open={false} />
                    {hiddenCount()} earlier messages
                  </button>
                </Show>

                <For each={visibleNodes()}>
                  {(node) => (
                    <Switch>
                      <Match when={node.kind === "files" ? node : null}>
                        {(n) => (
                          <FilesChangedCard
                            tools={n().tools}
                            isOpen={isOpen}
                            onToggle={toggleOpen}
                          />
                        )}
                      </Match>
                      <Match when={node.kind === "item" ? node.item : null}>
                        {(item) => (
                          <Switch>
                            <Match
                              when={item().kind === "user-msg" ? (item() as UserMsgItem) : null}
                            >
                              {(it) => (
                                <div class="flex justify-end">
                                  <div class="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface px-4 py-2.5 text-[13.5px] leading-6">
                                    {it().text}
                                  </div>
                                </div>
                              )}
                            </Match>
                            <Match
                              when={item().kind === "assistant" ? (item() as AssistantItem) : null}
                            >
                              {(it) => {
                                // markdown.ts HTML-escapes all content before
                                // re-introducing only trusted tags → XSS-safe.
                                const html = renderAgentMarkdown(it().text);
                                // eslint-disable-next-line solid/no-innerhtml -- sanitized above
                                return <div class="agent-md" innerHTML={html} />;
                              }}
                            </Match>
                            <Match when={isOneLineTool(item()) ? (item() as ToolItem) : null}>
                              {(it) => <ReadLine tool={it()} />}
                            </Match>
                            <Match when={item().kind === "tool" ? (item() as ToolItem) : null}>
                              {(it) => (
                                <ToolCard tool={it()} isOpen={isOpen} onToggle={toggleOpen} />
                              )}
                            </Match>
                            <Match when={item().kind === "note" ? (item() as NoteItem) : null}>
                              {(it) => (
                                <div
                                  class="text-[12px] leading-5"
                                  classList={{
                                    "font-mono text-danger": it().tone === "stderr",
                                    "text-fg-secondary": it().tone !== "stderr",
                                  }}
                                >
                                  {it().text}
                                </div>
                              )}
                            </Match>
                          </Switch>
                        )}
                      </Match>
                    </Switch>
                  )}
                </For>

                <Show when={ctrl.busy()}>
                  <div class="flex items-center gap-1 text-[15px] leading-none text-fg-secondary">
                    <span class="agent-dot">•</span>
                    <span class="agent-dot">•</span>
                    <span class="agent-dot">•</span>
                  </div>
                </Show>

                <Show when={ctrl.result()}>
                  {(r) => (
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-secondary">
                      <Show when={r().turns !== null}>
                        <span>{r().turns} turns</span>
                      </Show>
                      <Show when={r().durationMs !== null}>
                        <span>· {Math.round((r().durationMs ?? 0) / 100) / 10}s</span>
                      </Show>
                      <Show when={r().denials > 0}>
                        <span class="text-warning">· {r().denials} permission denial(s)</span>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </div>

            {/* Live status — tasks + subagents, above the composer. Each
                section auto-hides once its work is done. */}
            <Show when={showTasks() || showAgents()}>
              <div class="mx-auto w-full max-w-3xl px-5 pb-1">
                <div class="rounded-xl border border-border-default bg-surface px-3 py-2.5">
                  <Show when={showTasks()}>
                    <div class="flex flex-col gap-1.5">
                      <For each={tasks()}>{(t) => <TaskItemRow task={t} />}</For>
                    </div>
                  </Show>
                  <Show when={showTasks() && showAgents()}>
                    <div class="my-2.5 border-t border-border-default" />
                  </Show>
                  <Show when={showAgents()}>
                    <div class="flex flex-col gap-1.5">
                      <For each={subagents()}>{(a) => <SubagentRow tool={a} />}</For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Composer */}
            <div class="px-5 pb-5 pt-2">
              <div class="relative mx-auto w-full max-w-3xl">
                {/* Slash-command autocomplete */}
                <Show when={slashOpen()}>
                  <div class="absolute bottom-full left-0 z-10 mb-2 max-h-80 w-[26rem] overflow-auto rounded-xl border border-border-default bg-elevated py-1 shadow-lg">
                    <For each={slashMatches()}>
                      {(cmd, i) => (
                        <button
                          type="button"
                          class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left"
                          classList={{ "bg-hover": i() === slashSel() }}
                          onMouseEnter={() => setSlashSel(i())}
                          onClick={() => pickSlash(cmd)}
                        >
                          <span class="shrink-0 font-mono text-[12.5px] text-accent">
                            /{cmd.name}
                            <Show when={cmd.argumentHint}>
                              <span class="text-fg-secondary"> {cmd.argumentHint}</span>
                            </Show>
                          </span>
                          <Show when={cmd.description}>
                            <span class="truncate text-[11.5px] text-fg-secondary">
                              {cmd.description}
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <div
                  ref={composerEl}
                  class="rounded-2xl border border-border-default bg-surface px-3.5 pb-2 pt-3 transition-colors focus-within:border-accent"
                >
                  <Show when={attachments().length > 0}>
                    <div class="mb-2 flex flex-wrap gap-1.5">
                      <For each={attachments()}>
                        {(path, i) => (
                          <span class="flex items-center gap-1.5 rounded-lg border border-border-default bg-canvas py-1 pl-2 pr-1.5 text-[11.5px] text-fg-secondary">
                            <IconImage />
                            <span class="max-w-[160px] truncate">{attachmentName(path)}</span>
                            <button
                              type="button"
                              class="flex h-4 w-4 items-center justify-center rounded-full text-fg-secondary hover:bg-hover hover:text-danger"
                              aria-label="Remove attachment"
                              onClick={() => removeAttachment(i())}
                            >
                              <IconX />
                            </button>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <textarea
                    ref={textarea}
                    class="w-full resize-none overflow-y-auto bg-transparent text-[13.5px] leading-6 text-fg outline-none placeholder:text-fg-secondary"
                    rows={1}
                    placeholder={
                      ctrl.closed()
                        ? "Session ended — restart from the ⋯ menu."
                        : "Ask Claude Code…  ( / for commands, paste or drop an image )"
                    }
                    disabled={ctrl.closed()}
                    value={ctrl.draft()}
                    onInput={(e) => ctrl.setDraft(e.currentTarget.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                  />
                  <div class="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      class="flex h-6 w-6 items-center justify-center rounded-md text-fg-secondary hover:bg-hover"
                      aria-label="Attach files or images"
                      onClick={attachFiles}
                    >
                      <IconPlus />
                    </button>
                    <Dropdown
                      icon={<IconShield />}
                      label={permissionLabel()}
                      value={ctrl.chosenPermission()}
                      options={PERMISSION_OPTIONS}
                      onSelect={(v) => ctrl.setPermissionMode(v)}
                    />
                    <Dropdown
                      icon={<IconSpark />}
                      label={modelLabel()}
                      value={ctrl.chosenModel()}
                      options={MODEL_OPTIONS}
                      onSelect={(v) => ctrl.setModel(v)}
                    />
                    <span class="ml-auto" />
                    <Show
                      when={ctrl.busy()}
                      fallback={
                        <button
                          type="button"
                          class="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-canvas transition-opacity disabled:opacity-30"
                          aria-label="Send message"
                          disabled={!canSend()}
                          onClick={submit}
                        >
                          <IconArrowUp />
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-full bg-fg text-canvas transition-opacity hover:opacity-80"
                        aria-label="Stop generating"
                        onClick={() => ctrl.interrupt()}
                      >
                        <IconStop />
                      </button>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* Always mounted; the width animates 0 → 460px so it slides open
              smoothly. Inner has a fixed width so content doesn't reflow
              during the transition. */}
          <div
            class="min-h-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
            classList={{
              "w-[460px] border-l border-border-default": showReview(),
              "w-0": !showReview(),
            }}
            aria-hidden={!showReview()}
          >
            <div class="h-full w-[460px]">
              <GitReviewPanel cwd={props.cwd} refreshKey={reviewKey()} visible={showReview()} />
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

interface DiffLine {
  sign: "-" | "+";
  text: string;
}

const splitLines = (value: string): string[] => (value.length === 0 ? [] : value.split("\n"));
const addedText = (tool: ToolItem): string =>
  tool.name === "Write" ? asString(tool.input.content) : asString(tool.input.new_string);
const removedText = (tool: ToolItem): string =>
  tool.name === "Write" ? "" : asString(tool.input.old_string);
const adds = (tool: ToolItem): number => splitLines(addedText(tool)).length;
const dels = (tool: ToolItem): number => splitLines(removedText(tool)).length;
const fileName = (tool: ToolItem): string => {
  const fp = asString(tool.input.file_path) || asString(tool.input.path);
  return fp ? fp.split("/").slice(-2).join("/") : tool.name;
};
const diffLines = (tool: ToolItem): DiffLine[] => {
  const out: DiffLine[] = [];
  for (const l of splitLines(removedText(tool))) out.push({ sign: "-", text: l });
  for (const l of splitLines(addedText(tool))) out.push({ sign: "+", text: l });
  return out;
};

interface OpenProps {
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
}

/** Codex-style "N files changed" card grouping a turn's edits, one row per
 *  file with add/remove counts and an inline diff on expand. */
function FilesChangedCard(props: { tools: ToolItem[] } & OpenProps): JSX.Element {
  const totalAdds = (): number => props.tools.reduce((n, t) => n + adds(t), 0);
  const totalDels = (): number => props.tools.reduce((n, t) => n + dels(t), 0);
  return (
    <div class="overflow-hidden rounded-xl border border-border-default bg-surface">
      <div class="flex items-center gap-2 px-3.5 py-2.5 text-[13px]">
        <span class="font-medium">{props.tools.length} files changed</span>
        <span class="font-mono text-[12px]">
          <span class="text-success">+{totalAdds()}</span>{" "}
          <span class="text-danger">-{totalDels()}</span>
        </span>
      </div>
      <For each={props.tools}>
        {(tool) => (
          <div class="border-t border-border-default">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] hover:bg-hover"
              onClick={() => props.onToggle(tool.id)}
            >
              <span class="truncate font-mono">{fileName(tool)}</span>
              <span class="ml-auto flex items-center gap-2.5">
                <span class="font-mono text-[12px]">
                  <span class="text-success">+{adds(tool)}</span>{" "}
                  <span class="text-danger">-{dels(tool)}</span>
                </span>
                <StatusDot status={tool.status} />
                <IconChevron open={props.isOpen(tool.id)} />
              </span>
            </button>
            <Show when={props.isOpen(tool.id)}>
              <DiffBody lines={diffLines(tool)} />
              <Show when={tool.status !== "pending" && tool.result.trim().length > 0}>
                <pre
                  class="max-h-40 overflow-auto border-t border-border-default px-3.5 py-2 font-mono text-[12px] leading-5 text-fg-secondary"
                  classList={{ "text-danger": tool.status === "error" }}
                >
                  {tool.result.slice(0, 3000)}
                </pre>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** A non-file tool call (Bash / Grep / Read / web): verb + target + output. */
function ToolCard(props: { tool: ToolItem } & OpenProps): JSX.Element {
  const verb = (): string => {
    switch (props.tool.name) {
      case "Read":
        return "Read";
      case "Bash":
        return "Ran";
      case "Grep":
      case "Glob":
        return "Searched";
      case "WebSearch":
      case "WebFetch":
        return "Searched web";
      default:
        return props.tool.name;
    }
  };
  const target = (): string => {
    const cmd = asString(props.tool.input.command);
    if (cmd) return cmd;
    const pattern = asString(props.tool.input.pattern);
    if (pattern) return pattern;
    const fp = asString(props.tool.input.file_path) || asString(props.tool.input.path);
    if (fp) return fp.split("/").slice(-2).join("/");
    return JSON.stringify(props.tool.input).slice(0, 120);
  };
  const hasBody = (): boolean =>
    props.tool.status !== "pending" && props.tool.result.trim().length > 0;

  return (
    <div class="overflow-hidden rounded-xl border border-border-default bg-surface">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] disabled:cursor-default"
        disabled={!hasBody()}
        onClick={() => props.onToggle(props.tool.id)}
      >
        <span class="font-medium">{verb()}</span>
        <span class="truncate font-mono text-[12.5px] text-fg-secondary">{target()}</span>
        <span class="ml-auto flex items-center gap-2.5">
          <StatusDot status={props.tool.status} />
          <Show when={hasBody()}>
            <IconChevron open={props.isOpen(props.tool.id)} />
          </Show>
        </span>
      </button>
      <Show when={hasBody() && props.isOpen(props.tool.id)}>
        <pre
          class="max-h-48 overflow-auto border-t border-border-default px-3.5 py-2 font-mono text-[12px] leading-5 text-fg-secondary"
          classList={{ "text-danger": props.tool.status === "error" }}
        >
          {props.tool.result.slice(0, 4000)}
        </pre>
      </Show>
    </div>
  );
}

function DiffBody(props: { lines: DiffLine[] }): JSX.Element {
  return (
    <div class="overflow-x-auto bg-canvas py-1.5 font-mono text-[12px] leading-[1.55]">
      <For each={props.lines}>
        {(line) => (
          <div
            class="flex"
            classList={{
              "bg-danger/10": line.sign === "-",
              "bg-success/10": line.sign === "+",
            }}
          >
            <span
              class="w-6 shrink-0 select-none text-center"
              classList={{
                "text-danger": line.sign === "-",
                "text-success": line.sign === "+",
              }}
            >
              {line.sign}
            </span>
            <span
              class="whitespace-pre pr-3"
              classList={{
                "text-danger": line.sign === "-",
                "text-success": line.sign === "+",
                "text-fg": line.sign !== "-" && line.sign !== "+",
              }}
            >
              {line.text}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

function StatusDot(props: { status: ToolStatus }): JSX.Element {
  return (
    <span
      class="h-1.5 w-1.5 rounded-full"
      classList={{
        "bg-border-strong": props.status === "pending",
        "bg-success": props.status === "ok",
        "bg-danger": props.status === "error",
      }}
      aria-label={props.status}
    />
  );
}

/** A task row in the live status panel — checkbox style by status. */
function TaskItemRow(props: { task: TaskRow }): JSX.Element {
  const done = (): boolean => props.task.status === "completed";
  const active = (): boolean => props.task.status === "in_progress";
  return (
    <div class="flex items-center gap-2 text-[12.5px]">
      <span
        class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
        classList={{
          "border-success bg-success text-canvas": done(),
          "border-accent": active(),
          "border-border-strong": !done() && !active(),
        }}
      >
        <Show when={done()}>
          <IconCheck />
        </Show>
        <Show when={active()}>
          <span class="agent-dot h-1.5 w-1.5 rounded-full bg-accent" />
        </Show>
      </span>
      <span classList={{ "text-fg-secondary line-through": done(), "text-fg": !done() }}>
        {props.task.title}
      </span>
    </div>
  );
}

/** A subagent row in the live status panel. */
function SubagentRow(props: { tool: ToolItem }): JSX.Element {
  const desc = (): string =>
    asString(props.tool.input.description) ||
    asString(props.tool.input.subagent_type) ||
    "subagent";
  const type = (): string => asString(props.tool.input.subagent_type);
  const running = (): boolean => props.tool.status === "pending";
  return (
    <div class="flex items-center gap-2 text-[12.5px]">
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        classList={{
          "agent-dot bg-accent": running(),
          "bg-success": props.tool.status === "ok",
          "bg-danger": props.tool.status === "error",
        }}
      />
      <span class="truncate text-fg">{desc()}</span>
      <Show when={type()}>
        <span class="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-[10.5px] text-fg-secondary">
          {type()}
        </span>
      </Show>
      <span class="ml-auto shrink-0 text-[11px] text-fg-secondary">
        {running() ? "running" : props.tool.status === "ok" ? "done" : "failed"}
      </span>
    </div>
  );
}

function IconCheck(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Small popover dropdown — opens above the trigger (composer sits at the
 *  bottom). Closes on outside pointerdown / Escape. */
function Dropdown(props: {
  icon: JSX.Element;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onSelect: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const onPointerDown = (event: PointerEvent): void => {
    const t = event.target;
    if (t instanceof Node && root?.contains(t)) return;
    setOpen(false);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") setOpen(false);
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        class="flex items-center gap-1 rounded-full border border-border-default px-2 py-0.5 text-[11px] text-fg-secondary hover:bg-hover"
        onClick={() => setOpen((v) => !v)}
      >
        {props.icon}
        {props.label}
        <IconChevron open={open()} />
      </button>
      <Show when={open()}>
        <div class="absolute bottom-full left-0 z-10 mb-1.5 min-w-40 overflow-hidden rounded-xl border border-border-default bg-elevated py-1 shadow-lg">
          <For each={props.options}>
            {(opt) => (
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-hover"
                onClick={() => {
                  props.onSelect(opt.value);
                  setOpen(false);
                }}
              >
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  classList={{
                    "bg-accent": opt.value === props.value,
                    "bg-transparent": opt.value !== props.value,
                  }}
                />
                {opt.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Header overflow menu — closes on outside pointerdown / Escape. */
function Menu(props: { onClose: () => void; children: JSX.Element; wide?: boolean }): JSX.Element {
  let root: HTMLDivElement | undefined;
  const onPointerDown = (event: PointerEvent): void => {
    const t = event.target;
    if (t instanceof Node && root?.contains(t)) return;
    props.onClose();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") props.onClose();
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKey, true);
  });
  return (
    <div
      ref={root}
      class="absolute right-3 top-11 z-10 rounded-xl border border-border-default bg-elevated py-1 shadow-lg"
      classList={{
        "min-w-44 overflow-hidden": !props.wide,
        "max-h-80 w-80 overflow-auto": props.wide,
      }}
    >
      {props.children}
    </div>
  );
}

/** Compact relative time for the history list (e.g. "3m", "2h", "5d"). */
function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function MenuItem(props: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      class="flex w-full items-center px-3 py-1.5 text-left text-[12px] hover:bg-hover"
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}

function IconChevron(props: { open: boolean }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      class="text-fg-secondary transition-transform"
      classList={{ "rotate-180": props.open }}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

function IconArrowUp(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3M8 3l-4 4M8 3l4 4"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function attachmentName(path: string): string {
  const clean = path.replace(/^"|"$/g, "");
  return clean.split("/").pop() || clean;
}

function IconImage(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.2" />
      <circle cx="6" cy="6.5" r="1.1" fill="currentColor" />
      <path
        d="M3 12l3.5-3.5 2.5 2.5L11 9l2 2.5"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function IconX(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

function IconPlus(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

function IconStop(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2.5" />
    </svg>
  );
}

/** Lightweight tool (Read / Grep / Glob / LS / Bash) — a slim one-line row
 *  with a subtle fade-in, instead of an expandable card. */
function ReadLine(props: { tool: ToolItem }): JSX.Element {
  const verb = (): string => {
    switch (props.tool.name) {
      case "Grep":
      case "Glob":
        return "Searched";
      case "LS":
        return "Listed";
      case "Bash":
        return "Ran";
      default:
        return "Read";
    }
  };
  const target = (): string => {
    if (props.tool.name === "Bash") {
      const cmd = asString(props.tool.input.command).split("\n")[0] ?? "";
      return cmd;
    }
    const fp = asString(props.tool.input.file_path) || asString(props.tool.input.path);
    if (fp) return fp.split("/").slice(-2).join("/");
    return asString(props.tool.input.pattern);
  };
  return (
    <div class="agent-fadein flex items-center gap-2 px-0.5 text-[12px] text-fg-secondary">
      <span class="text-fg">{verb()}</span>
      <span class="truncate font-mono text-[11.5px]">{target()}</span>
    </div>
  );
}

function IconShield(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2l5 2v4c0 3-2.2 5.3-5 6-2.8-.7-5-3-5-6V4l5-2z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function IconSpark(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function IconReview(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
  );
}

function IconDots(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

export default AgentView;
