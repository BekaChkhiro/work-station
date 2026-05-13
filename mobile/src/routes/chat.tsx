// T18.16 — PlanFlow Chat on mobile.
//
// Routes user messages over the WS bridge (planflow_chat_send), which
// persists them on the desktop and emits a Tauri event so the active
// desktop chat session's PTY receives the keystrokes. The mobile UI
// keeps a local optimistic transcript so the user sees what they
// typed without waiting for a round-trip; the desktop is the source
// of truth for assistant turns and history.
//
// Markdown rendering is intentionally inline — the PWA has no markdown
// dependency and pulling one in for a single feature would bloat the
// bundle. `renderMarkdownToHtml` below covers the small subset the
// CLI assistants actually emit (headings, code, lists, emphasis, links).
import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";

import { settingsStore } from "../lib/settingsStore";
import { getBridge, bridgeState } from "../stores/wsBridge";
import { WsBridgeServerError, type PlanflowChatMessage } from "../lib/wsBridge";

interface PendingMessage {
  /** Negative id so it can't collide with server-issued positive ids. */
  id: number;
  role: "user";
  content: string;
  createdAt: number;
  pending: true;
}

interface FailedMessage extends Omit<PendingMessage, "pending"> {
  pending: false;
  error: string;
}

type LocalMessage = PlanflowChatMessage | PendingMessage | FailedMessage;

const HISTORY_LIMIT = 200;

export default function ChatRoute() {
  const [projectId, setProjectIdSignal] = createSignal<string | null>(
    settingsStore.getActiveProjectId(),
  );
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [localExtras, setLocalExtras] = createSignal<LocalMessage[]>([]);
  const [sendError, setSendError] = createSignal<string | null>(null);

  const [history, { refetch }] = createResource<PlanflowChatMessage[] | null, string | null>(
    projectId,
    async (pid) => {
      if (!pid) return null;
      const bridge = getBridge();
      if (!bridge) return [];
      try {
        return await bridge.planflowChatHistory(pid, HISTORY_LIMIT);
      } catch (err) {
        // Hide history-load errors behind an empty list so the user
        // can still type. The send path surfaces failures directly.
        console.warn("[chat] history load failed", err);
        return [];
      }
    },
  );

  // Refresh local view when the bridge reconnects — the desktop may
  // have appended assistant rows while we were offline.
  createEffect(() => {
    const state = bridgeState();
    if (state === "open" && projectId()) {
      void refetch();
    }
  });

  // When the active project changes, drop optimistic extras so we
  // don't bleed one project's transcript into the next.
  createEffect(() => {
    void projectId();
    setLocalExtras([]);
  });

  const combined = createMemo<LocalMessage[]>(() => {
    const base = history() ?? [];
    return [...base, ...localExtras()];
  });

  let scrollerRef: HTMLDivElement | undefined;
  // Auto-scroll to bottom whenever the list grows. Using `length` as
  // the trigger so we don't re-scroll on every keystroke.
  createEffect(() => {
    const len = combined().length;
    if (len === 0 || !scrollerRef) return;
    queueMicrotask(() => {
      if (scrollerRef) scrollerRef.scrollTop = scrollerRef.scrollHeight;
    });
  });

  function pickProject(id: string) {
    settingsStore.setActiveProjectId(id);
    setProjectIdSignal(id);
  }

  async function handleSend(content: string) {
    const pid = projectId();
    if (!pid) {
      setSendError("Pick a project before sending.");
      return;
    }
    const bridge = getBridge();
    if (!bridge) {
      setSendError("Not connected to Work Station.");
      return;
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) return;

    const tempId = -Date.now();
    const optimistic: PendingMessage = {
      id: tempId,
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
      pending: true,
    };
    batch(() => {
      setLocalExtras((prev) => [...prev, optimistic]);
      setDraft("");
      setSendError(null);
      setSending(true);
    });

    try {
      const ack = await bridge.planflowChatSend(pid, trimmed);
      // Promote the optimistic message into a persisted one so the
      // history-refetch doesn't double-render it on reconnect.
      setLocalExtras((prev) =>
        prev.map((msg) =>
          msg.id === tempId
            ? ({
                id: ack.messageId,
                projectId: pid,
                role: "user",
                content: trimmed,
                cli: null,
                createdAt: ack.createdAt,
              } satisfies PlanflowChatMessage)
            : msg,
        ),
      );
    } catch (err) {
      const message = formatSendError(err);
      setLocalExtras((prev) =>
        prev.map((msg) => {
          if (msg.id !== tempId) return msg;
          // Only `PendingMessage` rows can transition to failed (the
          // optimistic insert is always pending). The compiler can't
          // see the runtime invariant, so narrow explicitly.
          if (!("pending" in msg) || msg.pending !== true) return msg;
          const failed: FailedMessage = {
            id: msg.id,
            role: "user",
            content: msg.content,
            createdAt: msg.createdAt,
            pending: false,
            error: message,
          };
          return failed;
        }),
      );
      setSendError(message);
    } finally {
      setSending(false);
    }
  }

  function retry(failed: FailedMessage) {
    setLocalExtras((prev) => prev.filter((m) => m.id !== failed.id));
    void handleSend(failed.content);
  }

  return (
    <section class="flex min-h-[calc(100vh-128px)] flex-col px-4 pt-4">
      <header class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 class="text-fg text-xl font-semibold tracking-tight">Chat</h1>
          <p class="text-fg-tertiary text-xs">
            <Switch>
              <Match when={!projectId()}>Pick a project to start chatting.</Match>
              <Match when={history.loading}>Loading transcript…</Match>
              <Match when={true}>Messages route to the desktop's PlanFlow chat session.</Match>
            </Switch>
          </p>
        </div>
        <Show when={projectId()}>
          <button
            type="button"
            onClick={() => void refetch()}
            class="text-fg-secondary hover:text-fg active:bg-active flex h-9 min-h-touch items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors"
            aria-label="Refresh transcript"
          >
            <RefreshIcon />
            Refresh
          </button>
        </Show>
      </header>

      <Switch>
        <Match when={!projectId()}>
          <ProjectPickerInline onPick={pickProject} />
        </Match>
        <Match when={true}>
          <div
            ref={scrollerRef}
            class="flex-1 overflow-y-auto rounded-lg border border-border-default bg-surface px-3 py-3"
            style={{ "overscroll-behavior-y": "contain" }}
          >
            <Show
              when={combined().length > 0}
              fallback={
                <p class="text-fg-tertiary text-center text-sm py-12">
                  No messages yet. Type below to send one to the desktop.
                </p>
              }
            >
              <ul class="flex flex-col gap-3">
                <For each={combined()}>{(msg) => <MessageBubble msg={msg} onRetry={retry} />}</For>
              </ul>
            </Show>
          </div>

          <Show when={sendError()}>
            <p class="text-error mt-2 text-xs">{sendError()}</p>
          </Show>

          <form
            class="mt-3 flex items-end gap-2 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (sending()) return;
              void handleSend(draft());
            }}
          >
            <textarea
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter → send. Plain Enter inserts a newline
                // so multi-line prompts compose naturally on touch.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!sending()) void handleSend(draft());
                }
              }}
              placeholder="Message the assistant…"
              rows={2}
              class="bg-elevated border-border-default focus:border-accent focus:ring-accent-ring/40 min-h-[44px] flex-1 resize-none rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              disabled={sending()}
            />
            <button
              type="submit"
              disabled={sending() || draft().trim().length === 0}
              class="bg-accent hover:bg-accent-muted text-canvas inline-flex h-11 min-h-touch items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Show when={sending()} fallback={<SendIcon />}>
                <SpinnerIcon />
              </Show>
              {sending() ? "Sending…" : "Send"}
            </button>
          </form>
        </Match>
      </Switch>
    </section>
  );
}

// ---------- Message bubble ----------

function MessageBubble(props: { msg: LocalMessage; onRetry: (failed: FailedMessage) => void }) {
  const role = () => props.msg.role;
  const isUser = () => role() === "user";
  const isSystem = () => role() === "system" || role() === "tool";
  const failed = () =>
    "pending" in props.msg && props.msg.pending === false && "error" in props.msg;
  const pending = () => "pending" in props.msg && props.msg.pending === true;
  const failedMsg = (): FailedMessage | null => (failed() ? (props.msg as FailedMessage) : null);

  const html = createMemo(() => renderMarkdownToHtml(props.msg.content));

  return (
    <li class={`flex flex-col ${isUser() ? "items-end" : "items-start"}`} data-role={role()}>
      <Show when={isSystem()}>
        <span class="text-fg-tertiary mb-0.5 px-1 text-[10px] uppercase tracking-wide">
          {role()}
        </span>
      </Show>
      <div
        class={`max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${
          isUser()
            ? "bg-accent text-canvas"
            : isSystem()
              ? "bg-elevated text-fg-secondary border border-border-default"
              : "bg-elevated text-fg border border-border-default"
        } ${pending() ? "opacity-60" : ""} ${failed() ? "border-error/60 border" : ""}`}
        // The HTML comes from a small in-module renderer that escapes
        // every literal first, so this innerHTML is safe by construction.
        innerHTML={html()}
      />
      <Show when={failedMsg()}>
        {(fm) => (
          <button
            type="button"
            onClick={() => props.onRetry(fm())}
            class="text-error mt-1 inline-flex h-7 items-center rounded-md px-2 text-[11px] underline hover:bg-error/10"
          >
            ⚠ {fm().error} — tap to retry
          </button>
        )}
      </Show>
      <Show when={!failed()}>
        <span class="text-fg-tertiary mt-0.5 px-1 text-[10px]">
          {formatTime(props.msg.createdAt)}
          {pending() ? " · sending…" : ""}
        </span>
      </Show>
    </li>
  );
}

// ---------- Project picker (inline, since /chat may be visited without /tasks) ----------

function ProjectPickerInline(props: { onPick: (id: string) => void }) {
  const [value, setValue] = createSignal("");
  return (
    <form
      class="bg-surface border-border-default mx-auto mt-6 w-full max-w-md rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value().trim();
        if (v) props.onPick(v);
      }}
    >
      <label class="text-fg block text-sm font-medium" for="chat-project-id">
        PlanFlow project ID
      </label>
      <p class="text-fg-tertiary mt-1 text-xs">
        Paste the project UUID. The Tasks tab also sets this when you pick a project there.
      </p>
      <input
        id="chat-project-id"
        type="text"
        autocomplete="off"
        spellcheck={false}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        placeholder="00000000-0000-0000-0000-…"
        class="bg-elevated border-border-default focus:border-accent focus:ring-accent-ring/40 mt-3 block w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
      />
      <button
        type="submit"
        disabled={!value().trim()}
        class="bg-accent hover:bg-accent-muted text-canvas mt-3 inline-flex h-10 min-h-touch w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50"
      >
        Use this project
      </button>
    </form>
  );
}

// ---------- Helpers ----------

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatSendError(err: unknown): string {
  if (err instanceof WsBridgeServerError) {
    return err.message || "Send failed.";
  }
  if (err instanceof Error) return err.message;
  return "Send failed.";
}

// ---------- Tiny markdown renderer ----------
//
// Handles a deliberately small subset (the CLI assistants we proxy emit
// headings, fenced code, inline code, bullet lists, emphasis, links,
// and line breaks). Everything is escaped first so the user can't
// inject raw HTML, then known patterns are converted back into tags.

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdownToHtml(raw: string): string {
  if (!raw) return "";

  // 1) Pull out fenced code blocks so their content isn't mangled by
  //    the per-line transforms below. Replace with placeholders, splice
  //    the rendered <pre><code> back in at the end.
  const codeBlocks: string[] = [];
  let work = raw.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, _lang, body) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="overflow-x-auto rounded-md bg-canvas/60 px-2 py-1.5 text-xs"><code>${escapeHtml(
        body,
      )}</code></pre>`,
    );
    return `@@CB${idx}@@`;
  });

  // 2) Escape everything else so HTML in messages is shown literally.
  work = escapeHtml(work);

  // 3) Headings (only at line start).
  work = work.replace(/^### (.+)$/gm, '<h3 class="text-sm font-semibold mt-2">$1</h3>');
  work = work.replace(/^## (.+)$/gm, '<h2 class="text-sm font-semibold mt-2">$1</h2>');
  work = work.replace(/^# (.+)$/gm, '<h1 class="text-base font-semibold mt-2">$1</h1>');

  // 4) Bullet lists — gather contiguous "- foo" / "* foo" lines into <ul>.
  work = work.replace(/(?:^[-*] .+(?:\n[-*] .+)*)/gm, (block) => {
    const items = block
      .split(/\n/)
      .map((l) => l.replace(/^[-*] /, ""))
      .map((l) => `<li>${l}</li>`)
      .join("");
    return `<ul class="list-disc pl-5 my-1">${items}</ul>`;
  });

  // 5) Blockquotes.
  work = work.replace(
    /(?:^&gt; .+(?:\n&gt; .+)*)/gm,
    (block) =>
      `<blockquote class="border-l-2 border-border-default pl-2 text-fg-secondary italic">${block
        .split(/\n/)
        .map((l) => l.replace(/^&gt; /, ""))
        .join("<br>")}</blockquote>`,
  );

  // 6) Inline code.
  work = work.replace(
    /`([^`\n]+)`/g,
    '<code class="rounded bg-canvas/60 px-1 text-[12.5px]">$1</code>',
  );

  // 7) Bold + italic.
  work = work.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  work = work.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  work = work.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  // 8) Links — [text](https://…). Restricted to http(s) so a malicious
  //    "javascript:" URL can't ride in through escaped angles.
  work = work.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer" class="underline">$1</a>',
  );

  // 9) Line breaks — preserve paragraph spacing but collapse single newlines.
  work = work
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n/g, "<br>"))
    .map((para) => (/^<(h\d|ul|pre|blockquote)/.test(para.trim()) ? para : `<p>${para}</p>`))
    .join("");

  // 10) Splice code blocks back in.
  work = work.replace(/@@CB(\d+)@@/g, (_m, idx) => codeBlocks[Number(idx)] ?? "");

  return work;
}

// ---------- Icons ----------

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="animate-spin"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 1-9 9" />
    </svg>
  );
}
