// Phase 3 — hidden PTY bridge for the PlanFlow chat widget.
//
// Wires the chat panel's `sendChatMessage` call to a long-lived PTY
// running the user's chosen CLI. The PTY is invisible: there's no
// xterm renderer mounted, just a `ptySubscribe` callback that
// accumulates output into a string buffer until the CLI goes idle.
//
// Why interactive PTY instead of one-shot `claude --print`:
//   * Multi-turn context flows naturally — the CLI remembers what was
//     said earlier, so the user can write "now do the same for T2.7"
//     without restating context.
//   * Spawn cost is paid once per session instead of per message.
//   * Same code path supports any CLI (claude / kimi / codex) without
//     each needing its own flags surface — we just stream stdin/stdout.
//
// Why idle detection instead of marker parsing:
//   * Different CLIs use different prompt characters, banners, and
//     status indicators. A marker that works for Claude breaks on
//     Kimi.
//   * "Quiet stdout for N ms" works uniformly: when the assistant is
//     done writing + spinners stop ticking, we collect what landed.
//
// The bridge is registered by AppRoot once during boot (after the
// CLI registry has populated). It tears down on app close via the
// existing onCleanup that runs through `setChatBridge(null)`.

import { ptyKill, ptySpawn, ptySubscribe, ptyWrite, type PtySubscription } from "../../ipc/pty";
import { bumpPlanflowChatRefetch } from "../../stores/planflowChatNotify";
import {
  setChatBridge,
  type ChatSessionResult,
  type SendChatMessageInput,
} from "../../stores/planflowChatBridge";
import type { ToolCall } from "../../db/planflowChats";

/** Wait this long after the last stdout chunk before treating the
 *  assistant's turn as finished. 1500ms is long enough to ride out a
 *  CLI's progress-bar refresh interval, short enough that the user
 *  doesn't feel they're waiting on a spinner that's already done. */
const IDLE_MS = 1500;

/** Hard ceiling for any single turn. Stops the bridge from hanging on
 *  a runaway tool call. Three minutes covers the worst-case "let me
 *  refactor your plan" prompt; anything longer is almost certainly a
 *  stuck process. */
const MAX_TURN_MS = 3 * 60 * 1000;

export interface ChatBridgeOptions {
  /** Resolve the absolute path of the CLI executable on disk. AppRoot
   *  pulls this from the registry that `cliListAvailable` populates. */
  resolveCliPath: (cliId: string) => string | null;
  /** Project cwd lookup. Spawning the CLI in the project's working
   *  directory makes any `planflow-mcp index`-style scans land on the
   *  right file tree, and is the convention the rest of the app uses
   *  for project-scoped CLIs (T7.4). */
  resolveProjectCwd: (projectId: string) => string | null;
  /** Per-project env vars (T7.5). Merged with the bridge's own
   *  WS_PLANFLOW_* keys before spawn. */
  resolveProjectEnv: (projectId: string) => Record<string, string>;
  /** Optional — lookup the PlanFlow external project UUID from a
   *  workspace projectId. Embedded in the scope primer so the
   *  assistant doesn't have to guess which PlanFlow project to talk
   *  to when the user types a vague request. */
  resolveExternalId?: (projectId: string) => string | null;
}

/** First message we send into a freshly-spawned CLI session. Phase 4
 *  scope enforcement is best-effort: we can't reach into the CLI's
 *  system-prompt slot without per-CLI flag handling, so instead we
 *  rely on the assistant treating this primer as a strong user
 *  instruction. Tested against Claude Code and Kimi — both comply.
 *  Embedded externalId is the load-bearing piece: without it the
 *  assistant has to discover the project via `planflow_projects`. */
function scopePrimer(externalId: string | null): string {
  const idLine =
    externalId != null && externalId.length > 0
      ? `Project UUID: ${externalId}. Use this id when calling planflow_* tools.`
      : `Use planflow_projects() once to discover the project UUID, then stick with it.`;
  return [
    "You are scoped to PlanFlow plan/task management for one project only.",
    idLine,
    "Use the planflow_* MCP tools to read and edit the plan, tasks, comments, and knowledge.",
    "Do NOT use Bash, Read, Write, or Edit. Do NOT modify code or files.",
    "Confirm before destructive operations (planflow_task_done, plan deletions).",
    "Acknowledge with one short sentence and wait for the user's first request.",
  ].join(" ");
}

interface Session {
  sessionId: string;
  cliId: string;
  subscription: PtySubscription;
  /** Accumulating bytes since the last `runTurn` reset. */
  buffer: string;
  /** Resolves on the next idle deadline; reset on every chunk. */
  idleResolve: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Set while a `runTurn` call is in flight so concurrent sends queue
   *  rather than interleave on the same PTY. */
  busy: Promise<unknown> | null;
  /** Resolves once the scope primer (Phase 4) has been written + the
   *  CLI's acknowledgement window has elapsed. The first user message
   *  awaits this so the primer's reply doesn't bleed into the first
   *  assistant bubble. */
  ready: Promise<void>;
}

/** Strip every ANSI escape sequence + carriage returns we know about
 *  so the chat bubble sees plain text. Doesn't try to render colour as
 *  CSS — the chat layer is monochrome on purpose. */
/* eslint-disable no-control-regex */
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\r/g, "");
}
/* eslint-enable no-control-regex */

/** Detect tool calls the assistant made during this turn. We can't
 *  reliably parse a tool-call JSON out of an interactive REPL's
 *  output, so we use a heuristic: every distinct `planflow_<name>`
 *  mention is recorded as a tool call (with empty args). This gives
 *  the UI a "✏ planflow_task_progress" chip without claiming to know
 *  the arguments. False positives are harmless — the chip just hints
 *  at what the assistant did. */
function detectToolCalls(text: string): ToolCall[] {
  const seen = new Set<string>();
  const calls: ToolCall[] = [];
  const regex = /\bplanflow_[a-z_]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[0];
    if (seen.has(name)) continue;
    seen.add(name);
    calls.push({ name });
  }
  return calls;
}

/** Trim leading echoes of the user's own input and trailing CLI prompts
 *  (lines like `> `, `Claude > `, etc.) so the chat shows only the
 *  assistant's prose. Heuristic: drop lines that exactly equal the user
 *  message or end with a single `>` / `›` glyph. */
function tidyOutput(raw: string, userInput: string): string {
  const userTrim = userInput.trim();
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0) {
    const head = lines[0]?.trim() ?? "";
    if (head.length === 0 || head === userTrim || /^>\s*$/.test(head)) {
      lines.shift();
      continue;
    }
    break;
  }
  while (lines.length > 0) {
    const tail = lines[lines.length - 1]?.trim() ?? "";
    if (tail.length === 0 || /^[>›❯➜]\s*$/.test(tail)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

export function installChatBridge(options: ChatBridgeOptions): () => void {
  // One session per project. Switching CLI mid-conversation kills the
  // old PTY and spawns a fresh one — the user's intent is "talk to a
  // different assistant", which is incompatible with a long-lived
  // process.
  const sessions = new Map<string, Session>();

  const ensureSession = async (projectId: string, cliId: string): Promise<Session> => {
    const existing = sessions.get(projectId);
    if (existing && existing.cliId === cliId) return existing;
    if (existing) {
      await teardown(existing);
      sessions.delete(projectId);
    }
    const path = options.resolveCliPath(cliId);
    if (path == null || path.length === 0) {
      throw new Error(`CLI "${cliId}" is not on PATH. Install it or pick another from the menu.`);
    }
    const cwd = options.resolveProjectCwd(projectId);
    const env: Record<string, string> = {
      ...options.resolveProjectEnv(projectId),
      WS_PROJECT_ID: projectId,
      WS_CLI_NAME: cliId,
      WS_PLANFLOW_SCOPE: "1",
    };
    const resp = await ptySpawn({
      command: path,
      args: [],
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      env,
      cols: 100,
      rows: 30,
    });

    // Held resolver for the primer-settled promise. Closed over below
    // so the chunk handler can re-arm the timer until the CLI stops
    // typing the acknowledgement, then resolve `ready`.
    let primerResolve: (() => void) | null = null;
    let primerTimer: ReturnType<typeof setTimeout> | null = null;
    const ready = new Promise<void>((resolve) => {
      primerResolve = resolve;
    });

    const session: Session = {
      sessionId: resp.sessionId,
      cliId,
      subscription: { unsubscribe: () => undefined },
      buffer: "",
      idleResolve: null,
      idleTimer: null,
      busy: null,
      ready,
    };

    const decoder = new TextDecoder("utf-8", { fatal: false });
    session.subscription = await ptySubscribe(resp.sessionId, (chunk) => {
      session.buffer += decoder.decode(chunk, { stream: true });
      // Primer ack window: re-arm the timer on every chunk until the
      // CLI stops typing, then resolve `ready`. Independent from the
      // per-turn idle timer below.
      if (primerResolve != null) {
        if (primerTimer != null) clearTimeout(primerTimer);
        primerTimer = setTimeout(() => {
          const resolve = primerResolve;
          primerResolve = null;
          primerTimer = null;
          resolve?.();
        }, IDLE_MS);
      }
      if (session.idleResolve != null) {
        if (session.idleTimer != null) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => {
          const resolve = session.idleResolve;
          session.idleResolve = null;
          session.idleTimer = null;
          resolve?.();
        }, IDLE_MS);
      }
    });

    sessions.set(projectId, session);

    // Phase 4 — send the scope primer as the very first message so the
    // assistant is conditioned before the user can type. The primer's
    // own acknowledgement is captured by the `ready` promise: the
    // first `runTurn` awaits it so the primer reply doesn't bleed
    // into the first user assistant bubble. Hard fallback: resolve
    // `ready` after MAX_TURN_MS even if the CLI never goes idle.
    const externalId = options.resolveExternalId?.(projectId) ?? null;
    const primer = scopePrimer(externalId);
    const payload = new TextEncoder().encode(`${primer}\n`);
    await ptyWrite(resp.sessionId, payload);
    primerTimer = setTimeout(() => {
      const resolve = primerResolve;
      primerResolve = null;
      primerTimer = null;
      resolve?.();
    }, MAX_TURN_MS);

    return session;
  };

  const teardown = async (session: Session): Promise<void> => {
    session.subscription.unsubscribe();
    if (session.idleTimer != null) clearTimeout(session.idleTimer);
    if (session.idleResolve) {
      const resolve = session.idleResolve;
      session.idleResolve = null;
      resolve();
    }
    try {
      await ptyKill(session.sessionId);
    } catch {
      // Backend logs the failed kill — the user's flow doesn't care
      // because the renderer has already dropped its reference.
    }
  };

  const runTurn = async (session: Session, userInput: string): Promise<ChatSessionResult> => {
    // Reset the buffer at the START of the turn so anything that
    // landed between turns (idle banners, progress text) doesn't
    // bleed into this assistant message.
    session.buffer = "";

    const idle = new Promise<void>((resolve) => {
      session.idleResolve = resolve;
      // Prime the idle timer right away — if the CLI never echoes
      // anything (offline, scope error) we still time out cleanly.
      session.idleTimer = setTimeout(() => {
        const r = session.idleResolve;
        session.idleResolve = null;
        session.idleTimer = null;
        r?.();
      }, IDLE_MS * 2);
    });

    // Send the user's message + Enter so the CLI processes it.
    const payload = new TextEncoder().encode(`${userInput.replace(/\r/g, "")}\n`);
    await ptyWrite(session.sessionId, payload);

    // Race the idle promise against the hard ceiling so a stuck CLI
    // doesn't pin the UI's spinner indefinitely.
    await Promise.race([idle, new Promise<void>((resolve) => setTimeout(resolve, MAX_TURN_MS))]);

    const tidied = tidyOutput(stripAnsi(session.buffer), userInput);
    const toolCalls = detectToolCalls(tidied);
    return {
      content:
        tidied.length > 0
          ? tidied
          : "(no output — the CLI may need an interactive session, try opening a terminal pane)",
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
    };
  };

  const sender = async (input: SendChatMessageInput): Promise<ChatSessionResult> => {
    const session = await ensureSession(input.projectId, input.cliId);
    // Queue concurrent sends behind the in-flight one so two quick
    // clicks don't double-write to stdin.
    const previous = session.busy;
    let release: () => void = () => undefined;
    session.busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (previous != null) await previous;
      // Wait until the scope primer has settled — guarantees the first
      // assistant bubble contains the answer to the user's question,
      // not the tail of the primer's acknowledgement.
      await session.ready;
      const result = await runTurn(session, input.content);
      // Phase 5 — if the assistant invoked any planflow_* tool, the
      // local task list is stale. Bumping the per-project refetch tick
      // makes LinkedTaskList re-run its task resource on the next
      // microtask so the user sees the edit without manual refresh.
      if (result.toolCalls && result.toolCalls.length > 0) {
        bumpPlanflowChatRefetch(input.projectId);
      }
      return result;
    } finally {
      release();
      if (session.busy != null) session.busy = null;
    }
  };

  const startSession = async (projectId: string, cliId: string): Promise<void> => {
    await ensureSession(projectId, cliId);
  };

  const endSession = async (projectId: string): Promise<void> => {
    const session = sessions.get(projectId);
    if (!session) return;
    await teardown(session);
    sessions.delete(projectId);
  };

  setChatBridge({ sender, startSession, endSession });

  return () => {
    setChatBridge({ sender: null, startSession: null, endSession: null });
    for (const session of sessions.values()) {
      void teardown(session);
    }
    sessions.clear();
  };
}
