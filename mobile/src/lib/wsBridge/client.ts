// T18.8 — WebSocket client for the embedded PTY bridge with auto-reconnect.
//
// Wire-compatible with the server in `src-tauri/src/ws/` (see
// `protocol.rs`). The browser `WebSocket` constructor can't set custom
// headers, so the bearer token is appended as `?token=…` — the server
// already accepts both query and header (`require_bearer` middleware).
//
// Reconnect semantics:
//   - exponential backoff with jitter, capped at `maxDelayMs`
//   - `close()` disables reconnect (manual close); transient drops do not
//   - in-flight requests at the time of disconnect reject with
//     `WsBridgeClosedError` so callers can decide to retry — the wire
//     protocol has no replay semantics, so we don't silently resend
//   - PTY subscriptions (sessions explicitly attached via `ptySubscribe`)
//     are re-sent after reconnect so live output keeps flowing without
//     the caller re-wiring listeners
//
// The class exposes both the typed RPC surface (mirrors `src/ipc/pty.ts`)
// and a low-level send/listen API for cases the typed methods don't
// cover. All timers / sockets are pluggable for unit tests.

import { decodeBase64, encodeBase64 } from "./base64";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "reconnecting";

export interface PlanflowChatMessage {
  id: number;
  projectId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  cli: string | null;
  createdAt: number;
}

export type ServerMessage =
  | { type: "pty_spawned"; id?: string; session_id: string }
  | { type: "pty_ack"; id?: string }
  | {
      type: "pty_error";
      id?: string;
      session_id?: string;
      kind: string;
      message: string;
    }
  | { type: "pty_output"; session_id: string; data: string }
  | {
      type: "pty_scrollback_chunk";
      id?: string;
      session_id: string;
      data: string;
      total_bytes: number;
      next_offset: number;
    }
  | { type: "pty_exit"; session_id: string }
  // T18.6 — PlanFlow Tasks bridge response frames. `data` is the raw
  // PlanFlow response payload (envelope already stripped server-side);
  // the mobile UI's existing zod schemas parse it. Errors carry the
  // upstream HTTP status when one was available so callers can branch
  // on 401/403 without parsing prose.
  | { type: "planflow_result"; id?: string; data: unknown }
  | {
      type: "planflow_error";
      id?: string;
      kind: string;
      message: string;
      status?: number;
    }
  // T18.16 — PlanFlow Chat bridge frames.
  | {
      type: "planflow_chat_ack";
      id?: string;
      message_id: number;
      created_at: number;
    }
  | {
      type: "planflow_chat_history_result";
      id?: string;
      messages: PlanflowChatMessage[];
    }
  | {
      type: "planflow_chat_cleared";
      id?: string;
      rows_deleted: number;
    }
  // Generic error envelope (sent by chat handlers + projects/settings handlers).
  | {
      type: "error";
      id?: string;
      kind: string;
      message: string;
    };

export interface PtySpawnPayload {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyScrollbackChunk {
  data: Uint8Array;
  totalBytes: number;
  nextOffset: number;
}

export interface ReconnectOptions {
  /** Delay before the first reconnect attempt. Default 500 ms. */
  initialDelayMs?: number;
  /** Upper bound on the delay between attempts. Default 30_000 ms. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  factor?: number;
  /** Random jitter as a fraction of the current delay (0–1). Default 0.2. */
  jitter?: number;
  /** Cap on consecutive attempts; `Infinity` means retry forever. Default Infinity. */
  maxAttempts?: number;
}

type TimerHandle = unknown;
type SetTimeoutImpl = (handler: () => void, ms: number) => TimerHandle;
type ClearTimeoutImpl = (handle: TimerHandle) => void;

export interface WsBridgeClientOptions {
  /** Base WebSocket URL, e.g. `ws://127.0.0.1:7420/ws`. The token is appended automatically. */
  url: string;
  /** Bearer token from `app_settings.ws_auth_token`. */
  token: string;
  /** Default true. Set false to disable any reconnect attempts. */
  autoReconnect?: boolean;
  reconnect?: ReconnectOptions;

  // Lifecycle hooks
  onOpen?: () => void;
  onClose?: (event: { code: number; reason: string; wasClean: boolean }) => void;
  onError?: (error: Error) => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  onStateChange?: (state: ConnectionState) => void;

  // Testing seams
  webSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: SetTimeoutImpl;
  clearTimeoutImpl?: ClearTimeoutImpl;
  randomFn?: () => number;
}

export class WsBridgeClosedError extends Error {
  constructor(message = "WebSocket bridge is closed") {
    super(message);
    this.name = "WsBridgeClosedError";
  }
}

export class WsBridgeServerError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly sessionId?: string,
  ) {
    super(message);
    this.name = "WsBridgeServerError";
  }
}

/** T18.6 — error returned by the PlanFlow Tasks bridge.
 *
 * `kind` is one of: `unauthorized` (401/403), `not_found` (404),
 * `rate_limited` (429), `client` (other 4xx), `server` (5xx),
 * `network`, `timeout`, `decode`, `no_credential` (no PlanFlow API
 * token configured on the desktop), `credential`, `invalid_args`,
 * `unavailable` (bridge not initialised on the server). The mobile UI
 * branches on `kind === "unauthorized" || kind === "no_credential"` to
 * prompt the user to (re)connect PlanFlow on the desktop.
 *
 * `status` carries the upstream HTTP status when one is available.
 */
export class WsBridgePlanflowError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WsBridgePlanflowError";
  }
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
};

interface PendingRequest {
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
}

export type OutputHandler = (data: Uint8Array, sessionId: string) => void;
export type ExitHandler = (sessionId: string) => void;
export type MessageHandler = (msg: ServerMessage) => void;

export class WsBridgeClient {
  private readonly options: WsBridgeClientOptions;
  private readonly reconnect: Required<ReconnectOptions>;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly setTimeoutImpl: SetTimeoutImpl;
  private readonly clearTimeoutImpl: ClearTimeoutImpl;
  private readonly randomFn: () => number;

  private socket: WebSocket | null = null;
  private _state: ConnectionState = "idle";
  private userClosed = false;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempt = 0;

  private nextCorrelationId = 0;
  private readonly pending = new Map<string, PendingRequest>();

  private readonly subscribedSessions = new Set<string>();
  private readonly outputHandlers = new Set<OutputHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private readonly messageHandlers = new Set<MessageHandler>();

  constructor(options: WsBridgeClientOptions) {
    this.options = options;
    this.reconnect = { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) };

    const ctor =
      options.webSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (!ctor) {
      throw new Error("WebSocket implementation not provided and global WebSocket is unavailable");
    }
    this.WebSocketCtor = ctor;
    this.setTimeoutImpl = options.setTimeoutImpl ?? (setTimeout as unknown as SetTimeoutImpl);
    this.clearTimeoutImpl =
      options.clearTimeoutImpl ?? (clearTimeout as unknown as ClearTimeoutImpl);
    this.randomFn = options.randomFn ?? Math.random;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Begin connecting. Idempotent: a second call while open / connecting is a no-op. */
  connect(): void {
    if (this.userClosed) {
      this.userClosed = false; // explicit reconnect after a manual close
    }
    if (this._state === "open" || this._state === "connecting") return;
    this.openSocket();
  }

  /** Close the connection and disable any further auto-reconnect. */
  close(code = 1000, reason = "client closed"): void {
    this.userClosed = true;
    this.cancelReconnect();
    const socket = this.socket;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      this.setState("closing");
      try {
        socket.close(code, reason);
      } catch {
        // browsers may throw on invalid code/reason — keep going so we reach
        // a deterministic terminal state.
      }
    } else {
      this.setState("closed");
    }
    this.failAllPending(new WsBridgeClosedError());
  }

  /** Listen to every server frame after JSON parsing. Returns a disposer. */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /** Listen to `pty_output` frames decoded into bytes. */
  onPtyOutput(handler: OutputHandler): () => void {
    this.outputHandlers.add(handler);
    return () => this.outputHandlers.delete(handler);
  }

  /** Listen to `pty_exit` frames. */
  onPtyExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async ptySpawn(payload: PtySpawnPayload): Promise<{ sessionId: string }> {
    const reply = await this.request({
      type: "pty_spawn",
      command: payload.command,
      args: payload.args ?? [],
      cwd: payload.cwd,
      env: payload.env ?? {},
      cols: payload.cols,
      rows: payload.rows,
    });
    if (reply.type !== "pty_spawned") {
      throw new WsBridgeServerError("protocol", `expected pty_spawned, got ${reply.type}`);
    }
    return { sessionId: reply.session_id };
  }

  async ptyWrite(sessionId: string, data: Uint8Array | string): Promise<void> {
    if (typeof data !== "string" && data.byteLength === 0) return;
    const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.request({
      type: "pty_write",
      session_id: sessionId,
      data: encodeBase64(payload),
    });
  }

  async ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request({
      type: "pty_resize",
      session_id: sessionId,
      cols,
      rows,
    });
  }

  async ptyKill(sessionId: string): Promise<void> {
    await this.request({
      type: "pty_kill",
      session_id: sessionId,
    });
  }

  async ptyScrollback(sessionId: string, offset = 0, limit?: number): Promise<PtyScrollbackChunk> {
    const reply = await this.request({
      type: "pty_scrollback",
      session_id: sessionId,
      offset,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (reply.type !== "pty_scrollback_chunk") {
      throw new WsBridgeServerError("protocol", `expected pty_scrollback_chunk, got ${reply.type}`);
    }
    return {
      data: decodeBase64(reply.data),
      totalBytes: reply.total_bytes,
      nextOffset: reply.next_offset,
    };
  }

  async ptySubscribe(sessionId: string): Promise<void> {
    await this.request({ type: "pty_subscribe", session_id: sessionId });
    this.subscribedSessions.add(sessionId);
  }

  async ptyUnsubscribe(sessionId: string): Promise<void> {
    this.subscribedSessions.delete(sessionId);
    await this.request({ type: "pty_unsubscribe", session_id: sessionId });
  }

  // ---- T18.6: PlanFlow Tasks bridge ---------------------------------------
  //
  // Mirrors mobile/src/lib/planflowClient.ts's surface but routes
  // through the desktop's embedded WebSocket bridge so the mobile
  // client never handles the PlanFlow API token directly.
  //
  // The bridge already strips PlanFlow's `{success, data}` envelope —
  // callers receive the inner payload directly.

  async planflowGetMe(): Promise<unknown> {
    return this.planflowRequest({ type: "planflow_get_me" });
  }

  async planflowListProjects(organizationId?: string): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_list_projects",
      ...(organizationId ? { organization_id: organizationId } : {}),
    });
  }

  async planflowListTasks(projectId: string, options: { status?: string } = {}): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_list_tasks",
      project_id: projectId,
      ...(options.status ? { status: options.status } : {}),
    });
  }

  async planflowListActiveWork(projectId: string): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_list_active_work",
      project_id: projectId,
    });
  }

  async planflowListComments(projectId: string, taskId: string): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_list_comments",
      project_id: projectId,
      task_id: taskId,
    });
  }

  async planflowCreateComment(projectId: string, taskId: string, body: string): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_create_comment",
      project_id: projectId,
      task_id: taskId,
      body,
    });
  }

  async planflowStartWork(projectId: string, taskId: string): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_start_work",
      project_id: projectId,
      task_id: taskId,
    });
  }

  async planflowStopWork(projectId: string): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_stop_work",
      project_id: projectId,
    });
  }

  async planflowUpdateTaskStatus(
    projectId: string,
    taskId: string,
    status: string,
  ): Promise<unknown> {
    return this.planflowRequest({
      type: "planflow_update_task_status",
      project_id: projectId,
      task_id: taskId,
      status,
    });
  }

  // ---- T18.16: PlanFlow Chat bridge ----

  async planflowChatSend(
    projectId: string,
    content: string,
  ): Promise<{ messageId: number; createdAt: number }> {
    const reply = await this.request({
      type: "planflow_chat_send",
      project_id: projectId,
      content,
    });
    if (reply.type !== "planflow_chat_ack") {
      throw new WsBridgePlanflowError("protocol", `expected planflow_chat_ack, got ${reply.type}`);
    }
    return { messageId: reply.message_id, createdAt: reply.created_at };
  }

  async planflowChatHistory(projectId: string, limit?: number): Promise<PlanflowChatMessage[]> {
    const reply = await this.request({
      type: "planflow_chat_history",
      project_id: projectId,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (reply.type !== "planflow_chat_history_result") {
      throw new WsBridgePlanflowError(
        "protocol",
        `expected planflow_chat_history_result, got ${reply.type}`,
      );
    }
    return reply.messages;
  }

  async planflowChatClear(projectId: string): Promise<number> {
    const reply = await this.request({
      type: "planflow_chat_clear",
      project_id: projectId,
    });
    if (reply.type !== "planflow_chat_cleared") {
      throw new WsBridgePlanflowError(
        "protocol",
        `expected planflow_chat_cleared, got ${reply.type}`,
      );
    }
    return reply.rows_deleted;
  }

  private async planflowRequest(payload: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgePlanflowError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  // ---- internals ----------------------------------------------------------

  private buildUrl(): string {
    const sep = this.options.url.includes("?") ? "&" : "?";
    return `${this.options.url}${sep}token=${encodeURIComponent(this.options.token)}`;
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    let socket: WebSocket;
    try {
      socket = new this.WebSocketCtor(this.buildUrl());
    } catch (error) {
      this.emitError(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("open");
      this.options.onOpen?.();
      // Re-attach any sessions that were subscribed before the drop. New
      // subscriptions issued during the reconnect-pending window are
      // already tracked in `subscribedSessions`.
      for (const sessionId of this.subscribedSessions) {
        this.sendRaw({ type: "pty_subscribe", session_id: sessionId }, undefined);
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleFrame(event.data);
    };

    socket.onerror = () => {
      // The browser surfaces socket errors without details for security
      // reasons. Pass an opaque Error to the hook so callers can log it.
      this.emitError(new Error("WebSocket error"));
    };

    socket.onclose = (event: CloseEvent) => {
      const previous = this._state;
      this.socket = null;
      this.failAllPending(new WsBridgeClosedError());
      this.options.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      if (this.userClosed || previous === "closing" || this.options.autoReconnect === false) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== "string") {
      // Server only sends text frames per the protocol.
      this.emitError(new Error("non-text WebSocket frame received"));
      return;
    }
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(raw) as ServerMessage;
    } catch (error) {
      this.emitError(error);
      return;
    }

    for (const handler of this.messageHandlers) handler(parsed);

    switch (parsed.type) {
      case "pty_output": {
        const bytes = safeDecode(parsed.data, (e) => this.emitError(e));
        if (bytes) {
          for (const handler of this.outputHandlers) handler(bytes, parsed.session_id);
        }
        return;
      }
      case "pty_exit": {
        for (const handler of this.exitHandlers) handler(parsed.session_id);
        return;
      }
      case "pty_error": {
        const id = parsed.id;
        if (id !== undefined) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(new WsBridgeServerError(parsed.kind, parsed.message, parsed.session_id));
          }
        }
        return;
      }
      case "planflow_error": {
        const id = parsed.id;
        if (id !== undefined) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(new WsBridgePlanflowError(parsed.kind, parsed.message, parsed.status));
          }
        }
        return;
      }
      case "error": {
        // Generic error envelope used by chat / projects / settings
        // handlers + the unknown-type fallback. Reject the pending
        // promise using the same Server error class as PTY failures so
        // callers can branch on `.kind` without per-feature plumbing.
        const id = parsed.id;
        if (id !== undefined) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(new WsBridgeServerError(parsed.kind, parsed.message));
          }
        }
        return;
      }
      case "pty_spawned":
      case "pty_ack":
      case "pty_scrollback_chunk":
      case "planflow_result":
      case "planflow_chat_ack":
      case "planflow_chat_history_result":
      case "planflow_chat_cleared": {
        const id = parsed.id;
        if (id !== undefined) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.resolve(parsed);
          }
        }
        return;
      }
    }
  }

  private request(payload: Record<string, unknown>): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new WsBridgeClosedError("WebSocket bridge is not connected"));
        return;
      }
      const id = this.allocateCorrelationId();
      this.pending.set(id, { resolve, reject });
      try {
        this.sendRaw(payload, id);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendRaw(payload: Record<string, unknown>, id: string | undefined): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new WsBridgeClosedError("WebSocket bridge is not connected");
    }
    const frame = id !== undefined ? { ...payload, id } : payload;
    socket.send(JSON.stringify(frame));
  }

  private allocateCorrelationId(): string {
    const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (crypto?.randomUUID) return crypto.randomUUID();
    this.nextCorrelationId += 1;
    return `req-${Date.now().toString(36)}-${this.nextCorrelationId}`;
  }

  private scheduleReconnect(): void {
    if (this.userClosed || this.options.autoReconnect === false) {
      this.setState("closed");
      return;
    }
    if (this.reconnectAttempt >= this.reconnect.maxAttempts) {
      this.setState("closed");
      return;
    }
    const attempt = this.reconnectAttempt + 1;
    const baseDelay = Math.min(
      this.reconnect.initialDelayMs * this.reconnect.factor ** this.reconnectAttempt,
      this.reconnect.maxDelayMs,
    );
    const jitterAmount = baseDelay * this.reconnect.jitter;
    // Symmetric jitter around the base delay, never below 0.
    const delay = Math.max(0, Math.round(baseDelay + (this.randomFn() * 2 - 1) * jitterAmount));

    this.setState("reconnecting");
    this.reconnectAttempt = attempt;
    this.options.onReconnecting?.(attempt, delay);
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of snapshot) p.reject(error);
  }

  private setState(next: ConnectionState): void {
    if (this._state === next) return;
    this._state = next;
    this.options.onStateChange?.(next);
  }

  private emitError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(err);
  }
}

function safeDecode(b64: string, onError: (e: Error) => void): Uint8Array | null {
  try {
    return decodeBase64(b64);
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}
