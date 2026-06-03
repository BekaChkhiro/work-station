// Persistent agent-session registry — keyed by the layout sessionId.
//
// Why this exists: a pane's `AgentView` component is unmounted and remounted
// whenever the layout tree restructures (e.g. splitting to open a second
// terminal beside it). If the conversation lived in component-local state it
// would be wiped — and the `claude` child would be killed and respawned — on
// every split. The PTY Terminal sidesteps this because its state lives in the
// backend; the component only re-subscribes on remount. We mirror that here:
// the claude process, the parsed event log, and the live status all live in a
// module-level registry that survives remounts. `AgentView` becomes a thin
// presentational view that *attaches* to an entry by sessionId.
//
// Lifecycle: `acquireAgentSession` spawns `claude` exactly once per sessionId
// (subsequent calls return the same controller). `releaseAgentSession` — wired
// from AppRoot's pane-close / untrack paths, the same places that `ptyKill` a
// Terminal — kills the child and disposes the reactive root.

import { createRoot, createSignal, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  agentInterrupt,
  agentKill,
  agentSpawn,
  agentWrite,
  type AgentHandle,
} from "../../ipc/agent";

export type ToolStatus = "pending" | "ok" | "error";

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
}
export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  result: string;
}
export interface UserMsgItem {
  kind: "user-msg";
  id: string;
  text: string;
}
export interface NoteItem {
  kind: "note";
  id: string;
  tone: "system" | "stderr" | "info";
  text: string;
}
export type Item = AssistantItem | ToolItem | UserMsgItem | NoteItem;

export interface ResultInfo {
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  denials: number;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface AgentSessionOptions {
  /** Absolute path to the `claude` binary. Passing the resolved path (from
   *  CLI detection) instead of the bare name is what makes the agent work in
   *  the bundled .app, whose PATH lacks `~/.local/bin` etc. */
  command?: string;
  cwd?: string;
  permissionMode?: string;
  model?: string;
  /** Project label, stored with the session for the history list. */
  projectName?: string;
}

// ── Session history (localStorage) ──────────────────────────────────────
// Persists each conversation's transcript keyed by Claude's own session id,
// so the user can browse past sessions and resume them (`claude --resume`).

const HISTORY_KEY = "ws.agent.history";
const HISTORY_LIMIT = 60;

export interface SessionMeta {
  claudeId: string;
  title: string;
  projectName?: string;
  cwd?: string;
  updatedAt: number;
}

interface StoredSession extends SessionMeta {
  items: Item[];
}

function loadHistory(): StoredSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredSession[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(list: StoredSession[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    /* quota / unavailable — history is best-effort */
  }
}

/** Past sessions, most-recently-updated first (transcripts omitted). */
export function listSessions(): SessionMeta[] {
  return loadHistory()
    .map((s) => ({
      claudeId: s.claudeId,
      title: s.title,
      projectName: s.projectName,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The stored transcript for a Claude session id, or `[]`. */
export function loadSessionTranscript(claudeId: string): Item[] {
  return loadHistory().find((s) => s.claudeId === claudeId)?.items ?? [];
}

function upsertSession(session: StoredSession): void {
  const list = loadHistory().filter((s) => s.claudeId !== session.claudeId);
  list.unshift(session);
  saveHistory(list);
}

/** Reactive read surface + actions exposed to the view. */
export interface AgentController {
  items: Accessor<Item[]>;
  model: Accessor<string | null>;
  permission: Accessor<string | null>;
  busy: Accessor<boolean>;
  closed: Accessor<boolean>;
  fatal: Accessor<string | null>;
  result: Accessor<ResultInfo | null>;
  draft: Accessor<string>;
  setDraft: (value: string) => void;
  send: () => void;
  /** Currently selected `--permission-mode` (drives the composer chip). */
  chosenPermission: Accessor<string>;
  /** Currently selected `--model` ("default" = no override). */
  chosenModel: Accessor<string>;
  /** Change the permission mode — restarts the session (the CLI can't switch
   *  mid-flight) and clears the log. */
  setPermissionMode: (mode: string) => void;
  /** Change the model — restarts the session and clears the log. */
  setModel: (model: string) => void;
  /** Kill the current child and start a fresh session with the same options. */
  restart: () => void;
  /** Load a past session's transcript and resume it (`claude --resume`). */
  resumeSession: (claudeId: string) => void;
  /** Interrupt the in-flight turn without ending the session. */
  interrupt: () => void;
  /** Slash commands the session advertises (from the initialize handshake,
   *  falling back to `system/init` / a built-in default). */
  slashCommands: Accessor<SlashCommand[]>;
  /** Increments whenever a file-editing tool (Edit/Write/MultiEdit) finishes,
   *  so the review panel can refresh live without waiting for the turn. */
  editTick: Accessor<number>;
}

interface Entry {
  controller: AgentController;
  dispose: () => void;
}

let idCounter = 0;
const nextId = (): string => {
  idCounter += 1;
  return `a${idCounter}`;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const normalizeResult = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => asString(asRecord(block).text))
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
};

// Shown for the "/" autocomplete before the session's `system/init` arrives
// (which only happens after the first turn). Replaced with the real,
// account-specific list once init lands.
const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Start a new session with empty context" },
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "context", description: "Show current context usage" },
  { name: "review", description: "Review a pull request" },
  { name: "security-review", description: "Security review of pending changes" },
  { name: "init", description: "Initialize a CLAUDE.md for the project" },
  { name: "usage", description: "Show session cost and duration" },
  { name: "model", description: "Switch the model" },
  { name: "config", description: "Open configuration" },
  { name: "help", description: "Show help" },
];

const registry = new Map<string, Entry>();

/**
 * Return the controller for `sessionId`, spawning the `claude` child on first
 * call. Safe to call from a component body on every (re)mount — only the first
 * call starts a process.
 */
export function acquireAgentSession(sessionId: string, opts: AgentSessionOptions): AgentController {
  const existing = registry.get(sessionId);
  if (existing) return existing.controller;

  const entry = createRoot<Entry>((disposeRoot) => {
    const [store, setStore] = createStore<{ items: Item[] }>({ items: [] });
    const [model, setModel] = createSignal<string | null>(null);
    const [permission, setPermission] = createSignal<string | null>(null);
    const [busy, setBusy] = createSignal(false);
    const [closed, setClosed] = createSignal(false);
    const [fatal, setFatal] = createSignal<string | null>(null);
    const [result, setResult] = createSignal<ResultInfo | null>(null);
    const [draft, setDraft] = createSignal("");
    const [slashCommands, setSlashCommands] = createSignal<SlashCommand[]>(DEFAULT_SLASH_COMMANDS);
    const [editTick, setEditTick] = createSignal(0);
    // Tools that may have changed files on disk → refresh the review panel.
    // Bash is included because agents often edit via shell (sed/cat/heredoc),
    // which wouldn't otherwise trigger a refresh.
    const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
    // Once the rich list (with descriptions) lands from the initialize
    // handshake, don't let the name-only `system/init` list overwrite it.
    let gotRichCommands = false;

    let handle: AgentHandle | null = null;

    const pushItem = (item: Item): void => {
      setStore(produce((s) => void s.items.push(item)));
    };
    const note = (tone: NoteItem["tone"], text: string): void =>
      pushItem({ kind: "note", id: nextId(), tone, text });

    // Progressive-streaming state (from `--include-partial-messages`).
    // `blockByIndex` maps the current message's content-block index to the
    // store item it feeds (plus a buffer for tool-input JSON deltas). The
    // batch `assistant` event then *finalizes* each block's content
    // authoritatively — this both fills blocks that produced no deltas and
    // forces a definitive render of the last message (the bug where the
    // final chunk only appeared on the next turn).
    const blockByIndex = new Map<number, { itemId: string; kind: "text" | "tool"; json: string }>();
    // Id of the message `blockByIndex` currently maps. A batch `assistant`
    // for a NEW message (one that emitted no `message_start`/deltas) must
    // start fresh, otherwise its blocks would overwrite the previous
    // message's items — the bug where the final reply never appeared.
    let currentMsgId = "";

    const appendAssistantText = (itemId: string, delta: string): void => {
      if (delta.length === 0) return;
      setStore(
        produce((s) => {
          const it = s.items.find((x) => x.id === itemId);
          if (it && it.kind === "assistant") it.text += delta;
        }),
      );
    };

    const handleStreamEvent = (ev: Record<string, unknown>): void => {
      const etype = asString(ev.type);
      const index = typeof ev.index === "number" ? ev.index : -1;

      if (etype === "message_start") {
        currentMsgId = asString(asRecord(ev.message).id);
        blockByIndex.clear();
        setBusy(true);
        return;
      }
      if (etype === "content_block_start") {
        const block = asRecord(ev.content_block);
        const blockType = asString(block.type);
        if (blockType === "text") {
          const id = nextId();
          pushItem({ kind: "assistant", id, text: "" });
          blockByIndex.set(index, { itemId: id, kind: "text", json: "" });
        } else if (blockType === "tool_use") {
          const id = asString(block.id) || nextId();
          pushItem({
            kind: "tool",
            id,
            name: asString(block.name) || "tool",
            input: asRecord(block.input),
            status: "pending",
            result: "",
          });
          blockByIndex.set(index, { itemId: id, kind: "tool", json: "" });
        }
        return;
      }
      if (etype === "content_block_delta") {
        const slot = blockByIndex.get(index);
        if (!slot) return;
        const delta = asRecord(ev.delta);
        const dtype = asString(delta.type);
        if (dtype === "text_delta" && slot.kind === "text") {
          appendAssistantText(slot.itemId, asString(delta.text));
        } else if (dtype === "input_json_delta" && slot.kind === "tool") {
          slot.json += asString(delta.partial_json);
        }
        return;
      }
      if (etype === "content_block_stop") {
        const slot = blockByIndex.get(index);
        if (slot && slot.kind === "tool" && slot.json.length > 0) {
          try {
            const parsed = asRecord(JSON.parse(slot.json));
            setStore(
              produce((s) => {
                const it = s.items.find((x) => x.id === slot.itemId);
                if (it && it.kind === "tool") it.input = parsed;
              }),
            );
          } catch {
            // Partial/invalid JSON — keep whatever input arrived on start.
          }
        }
      }
    };

    const handleEvent = (line: string): void => {
      let event: Record<string, unknown>;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        return;
      }
      const type = asString(event.type);
      const sid = asString(event.session_id);
      if (sid.length > 0) claudeSessionId = sid;

      if (type === "_closed") {
        setClosed(true);
        setBusy(false);
        note("info", "Session ended.");
        persist();
        return;
      }
      if (type === "_stderr") {
        note("stderr", asString(event.text));
        return;
      }
      if (type === "system") {
        if (asString(event.subtype) === "init") {
          setModel(asString(event.model) || null);
          setPermission(asString(event.permissionMode) || null);
          if (!gotRichCommands && Array.isArray(event.slash_commands)) {
            const cmds = event.slash_commands
              .filter((c): c is string => typeof c === "string")
              .map((name) => ({ name }));
            if (cmds.length > 0) setSlashCommands(cmds);
          }
        }
        return;
      }
      if (type === "control_response") {
        // The initialize handshake's reply carries the full slash-command
        // catalogue (name + description + argumentHint).
        const inner = asRecord(asRecord(event.response).response);
        if (Array.isArray(inner.commands)) {
          const list = inner.commands
            .map((c) => {
              const r = asRecord(c);
              const name = asString(r.name);
              const description = asString(r.description);
              const argumentHint = asString(r.argumentHint);
              return {
                name,
                description: description.length > 0 ? description : undefined,
                argumentHint: argumentHint.length > 0 ? argumentHint : undefined,
              };
            })
            .filter((c) => c.name.length > 0);
          if (list.length > 0) {
            gotRichCommands = true;
            setSlashCommands(list);
          }
        }
        return;
      }
      if (type === "stream_event") {
        handleStreamEvent(asRecord(event.event));
        return;
      }
      if (type === "assistant") {
        // Finalize each content block authoritatively. If `stream_event`
        // deltas already created the item (slot), overwrite it with the full
        // content (block end → no later deltas, so no duplication); otherwise
        // create it. Works with OR without partial streaming.
        const message = asRecord(event.message);
        const content = message.content;
        if (!Array.isArray(content)) return;
        setBusy(true);
        // If this batch is for a message that never streamed (no
        // `message_start`), the index→item map is stale from the previous
        // message — reset so its blocks become NEW items instead of
        // overwriting the prior reply.
        const msgId = asString(message.id);
        if (msgId && msgId !== currentMsgId) {
          currentMsgId = msgId;
          blockByIndex.clear();
        }
        content.forEach((raw, i) => {
          const block = asRecord(raw);
          const blockType = asString(block.type);
          const slot = blockByIndex.get(i);
          if (blockType === "text") {
            const text = asString(block.text);
            if (slot && slot.kind === "text") {
              setStore(
                produce((s) => {
                  const it = s.items.find((x) => x.id === slot.itemId);
                  if (it && it.kind === "assistant") it.text = text;
                }),
              );
            } else if (text.trim().length > 0) {
              const id = nextId();
              pushItem({ kind: "assistant", id, text });
              blockByIndex.set(i, { itemId: id, kind: "text", json: "" });
            }
          } else if (blockType === "tool_use") {
            const input = asRecord(block.input);
            const tid = asString(block.id);
            // Prefer an existing item — by stream slot, else by tool-use id —
            // so a batch never duplicates a tool card the stream already made.
            const targetId =
              slot && slot.kind === "tool"
                ? slot.itemId
                : tid && store.items.some((x) => x.kind === "tool" && x.id === tid)
                  ? tid
                  : null;
            if (targetId) {
              setStore(
                produce((s) => {
                  const it = s.items.find((x) => x.id === targetId);
                  if (it && it.kind === "tool") {
                    it.input = input;
                    // Canonicalize to the real tool-use id so the later
                    // tool_result (keyed by that id) can match and flip the
                    // status to done — otherwise the row is stuck "running".
                    if (tid && it.id !== tid) it.id = tid;
                  }
                }),
              );
              if (tid && slot && slot.kind === "tool") {
                blockByIndex.set(i, { itemId: tid, kind: "tool", json: "" });
              }
            } else {
              const id = tid || nextId();
              pushItem({
                kind: "tool",
                id,
                name: asString(block.name) || "tool",
                input,
                status: "pending",
                result: "",
              });
              blockByIndex.set(i, { itemId: id, kind: "tool", json: "" });
            }
          }
        });
        persist();
        return;
      }
      if (type === "user") {
        const content = asRecord(event.message).content;
        if (!Array.isArray(content)) return;
        for (const raw of content) {
          const block = asRecord(raw);
          if (asString(block.type) !== "tool_result") continue;
          const toolUseId = asString(block.tool_use_id);
          const isError = block.is_error === true;
          const text = normalizeResult(block.content);
          let editedFile = false;
          setStore(
            produce((s) => {
              const target = s.items.find((it) => it.kind === "tool" && it.id === toolUseId);
              if (target && target.kind === "tool") {
                target.status = isError ? "error" : "ok";
                target.result = text;
                if (!isError && FILE_EDIT_TOOLS.has(target.name)) editedFile = true;
              }
            }),
          );
          // Live-refresh the review panel the moment a file edit lands, rather
          // than waiting for the whole turn to finish.
          if (editedFile) setEditTick((n) => n + 1);
        }
        persist();
        return;
      }
      if (type === "result") {
        const denials = Array.isArray(event.permission_denials)
          ? event.permission_denials.length
          : 0;
        setResult({
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
          turns: typeof event.num_turns === "number" ? event.num_turns : null,
          durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
          denials,
        });
        // Guaranteed-final fallback: the `result` event always carries the
        // turn's final assistant text. If streaming didn't surface it (the
        // intermittent "last reply missing" bug), append it here — deduped
        // against the last assistant message so a normal turn isn't doubled.
        const finalText = asString(event.result);
        if (finalText.trim().length > 0) {
          let lastAssistant: AssistantItem | null = null;
          for (let i = store.items.length - 1; i >= 0; i -= 1) {
            const candidate = store.items[i];
            if (candidate && candidate.kind === "assistant") {
              lastAssistant = candidate;
              break;
            }
          }
          if (!lastAssistant || lastAssistant.text.trim() !== finalText.trim()) {
            pushItem({ kind: "assistant", id: nextId(), text: finalText });
          }
        }
        setBusy(false);
        persist();
        return;
      }
    };

    // Mutable launch options — updated by the permission/model selectors,
    // applied on the next (re)spawn. `chosenModel` uses "default" to mean
    // "no --model override".
    const launch = {
      command: opts.command,
      cwd: opts.cwd,
      // Default to bypassPermissions so tools (Bash, Read, …) actually run —
      // the headless flow has no permission-prompt UI, so "ask"/"acceptEdits"
      // would silently deny everything but edits. The composer dropdown lets
      // the user dial this back per session.
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      model: opts.model,
      resume: undefined as string | undefined,
    };

    // Claude's own session id (from init / result / message events) + a title
    // derived from the first user turn — both feed the persisted history.
    let claudeSessionId: string | null = null;
    let title = "";
    const persist = (): void => {
      if (!claudeSessionId) return;
      upsertSession({
        claudeId: claudeSessionId,
        title: title.length > 0 ? title : "Untitled session",
        projectName: opts.projectName,
        cwd: opts.cwd,
        updatedAt: Date.now(),
        items: store.items.slice(),
      });
    };
    const [chosenPermission, setChosenPermission] = createSignal(launch.permissionMode);
    const [chosenModel, setChosenModel] = createSignal(launch.model ?? "default");

    const killChild = (): void => {
      const live = handle;
      if (live) {
        live.dispose();
        void agentKill(live.sessionId);
        handle = null;
      }
    };

    const spawn = (): void => {
      blockByIndex.clear();
      currentMsgId = "";
      setClosed(false);
      setBusy(false);
      setModel(null);
      setPermission(null);
      setResult(null);
      setFatal(null);
      void agentSpawn(
        {
          command: launch.command,
          cwd: launch.cwd,
          permissionMode: launch.permissionMode,
          model: launch.model,
          resume: launch.resume,
        },
        handleEvent,
      )
        .then((h) => {
          handle = h;
        })
        .catch((error: unknown) => {
          setFatal(error instanceof Error ? error.message : String(error));
        });
    };

    const restart = (): void => {
      killChild();
      setStore("items", []);
      title = "";
      claudeSessionId = null;
      launch.resume = undefined;
      spawn();
    };

    const resumeSession = (claudeId: string): void => {
      const transcript = loadSessionTranscript(claudeId);
      killChild();
      setStore("items", transcript);
      const firstUser = transcript.find((i): i is UserMsgItem => i.kind === "user-msg");
      title = firstUser?.text.slice(0, 80) ?? "";
      claudeSessionId = claudeId;
      launch.resume = claudeId;
      spawn();
    };

    // Initial spawn for the session (not reactive — runs once at creation).
    // eslint-disable-next-line solid/reactivity
    spawn();

    const send = (): void => {
      const text = draft().trim();
      if (text.length === 0 || !handle || closed()) return;
      if (title.length === 0) title = text.slice(0, 80);
      pushItem({ kind: "user-msg", id: nextId(), text });
      setDraft("");
      setBusy(true);
      const live = handle;
      void agentWrite(live.sessionId, text).catch((error: unknown) => {
        note("stderr", error instanceof Error ? error.message : String(error));
      });
    };

    const interrupt = (): void => {
      const live = handle;
      if (live) {
        void agentInterrupt(live.sessionId).catch(() => {
          /* best-effort — the turn may already have finished */
        });
      }
      // Checkpoint immediately so a stop (or a crash right after) is resumable
      // from exactly here.
      persist();
    };

    const setPermissionMode = (mode: string): void => {
      if (mode === launch.permissionMode) return;
      launch.permissionMode = mode;
      setChosenPermission(mode);
      restart();
    };
    const setModelChoice = (model: string): void => {
      if (model === chosenModel()) return;
      launch.model = model === "default" ? undefined : model;
      setChosenModel(model);
      restart();
    };

    const controller: AgentController = {
      items: () => store.items,
      model,
      permission,
      busy,
      closed,
      fatal,
      result,
      draft,
      setDraft,
      send,
      chosenPermission,
      chosenModel,
      setPermissionMode,
      setModel: setModelChoice,
      restart,
      resumeSession,
      interrupt,
      slashCommands,
      editTick,
    };

    const dispose = (): void => {
      killChild();
      disposeRoot();
      registry.delete(sessionId);
    };

    return { controller, dispose };
  });

  registry.set(sessionId, entry);
  return entry.controller;
}

/** Kill the `claude` child and tear down the reactive root for `sessionId`.
 *  No-op when the session was never created. Called from AppRoot when an
 *  agent pane is closed — the agent-pane analogue of `ptyKill`. */
export function releaseAgentSession(sessionId: string): void {
  registry.get(sessionId)?.dispose();
}
