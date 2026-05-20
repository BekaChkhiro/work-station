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
  // T19.9 — projects + settings bridge response frames. Wire shape mirrors
  // the Rust `ServerMessage` (`src-tauri/src/ws/protocol.rs`) and the
  // mobile client's type union.
  | { type: "projects_list_result"; id?: string; projects: WsBridgeProject[] }
  | { type: "project_result"; id?: string; project: WsBridgeProject }
  | { type: "project_switched"; id?: string; project_id: string }
  | { type: "project_void_result"; id?: string }
  | { type: "pty_list_result"; id?: string; sessions: WsBridgePtySession[] }
  | { type: "settings_result"; id?: string; settings: WsBridgeSettings }
  // T19.33 — project_link bridge reply frames. `links` / `link` are the
  // camelCase-shaped rows the cloud-agent emits; the renderer re-validates
  // them through Zod in `src/db/projectLinks.ts` so a wire drift surfaces
  // at the schema boundary, not here.
  | { type: "project_links_result"; id?: string; links: WsBridgeProjectLink[] }
  | { type: "project_link_result"; id?: string; link: WsBridgeProjectLink }
  | { type: "project_link_deleted"; id?: string; removed: boolean }
  | { type: "active_project_changed"; project_id?: string | null }
  // T19.14 — live host stats. The cloud-agent broadcasts these every
  // ~4 s to every authenticated socket (no subscribe handshake); a
  // future desktop Monitor view ignores them in local mode and renders
  // them in cloud mode where they describe the VPS, not the laptop.
  | {
      type: "system_stats";
      cpu_percent: number;
      ram_used_bytes: number;
      ram_total_bytes: number;
      pty_session_count: number;
    }
  // T19.13 — PlanFlow Tasks bridge response frames. `data` is the
  // upstream payload with PlanFlow's `{success, data}` envelope already
  // stripped server-side (see `unwrap_envelope` in
  // `src-tauri/src/ws/planflow_bridge.rs`); the renderer re-validates
  // through the existing Zod schemas in `src/integrations/planflow/schemas.ts`.
  | { type: "planflow_result"; id?: string; data: unknown }
  | {
      type: "planflow_error";
      id?: string;
      kind: string;
      message: string;
      status?: number;
    }
  // Generic error envelope used by the projects / settings handlers
  // (distinct from `pty_error` which carries session_id).
  | { type: "error"; id?: string; kind: string; message: string };

/**
 * T19.14 — snapshot delivered to a [`WsBridgeClient.onSystemStats`]
 * subscriber. Mirrors the wire-level `system_stats` frame's payload
 * fields one-for-one (camelCased for the JS surface).
 */
export interface SystemStatsSnapshot {
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  ptySessionCount: number;
}

/**
 * T19.9 — wire shape of a Project as returned by the cloud-agent's
 * `projects_list_result` / `project_result` frames. Matches the Rust
 * `Project` struct's camelCase serde rename. Kept loose (`unknown`-ish
 * envelope re-validated by Zod in `src/db/projects.ts`) so a backend
 * drift surfaces at the schema boundary rather than here.
 */
export interface WsBridgeProject {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  defaultCli?: string | null;
  env?: Record<string, string>;
  startupCommands?: string[];
  workspaceTabs?: string[];
  activeWorkspaceTab?: string;
  position: number;
  createdAt: number;
}

/** Wire shape of a row in `pty_list_result.sessions`. Mirrors the
 *  cloud-agent's `PtySessionView` struct (camelCase serde rename).
 *  All fields are optional-strict — `projectId` and `cwd` may be
 *  absent on legacy sessions spawned before the sidecar shipped. */
export interface WsBridgePtySession {
  sessionId: string;
  projectId?: string | null;
  command: string;
  cwd?: string | null;
  cols: number;
  rows: number;
  createdAt: number;
}

/** Wire shape for `project_create.args`. Mirrors the desktop Tauri
 *  command's `CreateProjectArgs` so the renderer can hand the same
 *  camelCase object to either backend. */
export interface WsBridgeProjectCreateArgs {
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  defaultCli?: string | null;
  env?: Record<string, string>;
  startupCommands?: string[];
}

/** Wire shape for `project_update.args`. The id rides inside the args
 *  payload (same shape as desktop's `UpdateProjectArgs`). */
export interface WsBridgeProjectUpdateArgs {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  defaultCli?: string | null;
  env?: Record<string, string>;
  startupCommands?: string[];
}

export interface WsBridgeSettings {
  theme: string;
  lastActiveProject: string | null;
}

/** T19.33 — wire shape for a `project_links` row. Mirrors the
 *  cloud-agent's `ProjectLink` struct (camelCase serde rename) and the
 *  desktop's `commands::project_links::ProjectLinkView`. Kept loose
 *  (`metadata` as `unknown`) because each integration narrows it to its
 *  own Zod schema at the call site. */
export interface WsBridgeProjectLink {
  projectId: string;
  service: string;
  externalId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

/** Args shape for [`WsBridgeClient.projectLinkSet`]. Unlike
 *  `project_create` (which nests args in `{args: {...}}`), the
 *  cloud-agent's `project_link_set` carries fields flat on the frame —
 *  the client maps camelCase here to snake_case on the wire. */
export interface WsBridgeProjectLinkSetArgs {
  projectId: string;
  service: string;
  externalId: string;
  metadata: Record<string, unknown>;
}

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

/**
 * T19.9 — error returned by the projects / settings bridge handlers.
 * `kind` is one of: `not_found` (unknown project id), `invalid_args`,
 * `name_already_exists`, `invalid_path`, `internal`, `unsupported`
 * (unknown message type). Mirrors the kind taxonomy used by
 * `ProjectError` on the desktop side and the mobile client's
 * `WsBridgeError`.
 */
export class WsBridgeError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "WsBridgeError";
  }
}

/**
 * T19.13 — error returned by the PlanFlow bridge handlers. Distinct from
 * [`WsBridgeError`] so callers can branch on `status` (the upstream HTTP
 * code) without re-parsing the message. `kind` taxonomy mirrors
 * `planflow_bridge.rs#send_proxy_error`: `unauthorized` | `rate_limited`
 * | `not_found` | `client` | `server` | `network` | `timeout` | `decode`
 * | `no_credential` | `credential` | `invalid_args`.
 */
export class WsPlanflowError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WsPlanflowError";
  }
}

export type ActiveProjectChangedHandler = (projectId: string | null) => void;

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
export type SystemStatsHandler = (snapshot: SystemStatsSnapshot) => void;

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
    // Bare `setTimeout`/`clearTimeout` references break when called as
    // an instance method: WebKit enforces that `this` is the Window, and
    // assigning the bare function to a class property re-binds `this` to
    // the class instance, throwing "Can only call Window.setTimeout on
    // instances of Window". Wrap with arrow functions so the inner call
    // sees the implicit global `this`.
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl =
      options.clearTimeoutImpl ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
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

  /** Ask the agent for its live PTY registry. Optional `projectId`
   *  scopes the reply to one project — the desktop uses it on cloud-
   *  mode boot to find sessions worth resuming instead of spawning a
   *  fresh PTY into an already-running claude / codex. */
  async ptyList(projectId?: string | null): Promise<WsBridgePtySession[]> {
    const payload: Record<string, unknown> = { type: "pty_list" };
    if (projectId != null) payload.project_id = projectId;
    const reply = await this.request(payload);
    if (reply.type !== "pty_list_result") {
      throw new WsBridgeError("protocol", `expected pty_list_result, got ${reply.type}`);
    }
    return reply.sessions;
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

  // ---- T19.9: projects + settings bridge ----------------------------------
  //
  // Mirrors the typed surface the mobile PWA uses (T18.4). Routed by the
  // IPC transport layer (`src/ipc/transport.ts`) so cloud mode lands on
  // the cloud-agent's WS handlers without each call site knowing.

  async projectsList(): Promise<WsBridgeProject[]> {
    const reply = await this.request({ type: "projects_list" });
    if (reply.type !== "projects_list_result") {
      throw new WsBridgeError("protocol", `expected projects_list_result, got ${reply.type}`);
    }
    return reply.projects;
  }

  async projectGet(projectId: string): Promise<WsBridgeProject> {
    const reply = await this.request({ type: "project_get", project_id: projectId });
    if (reply.type !== "project_result") {
      throw new WsBridgeError("protocol", `expected project_result, got ${reply.type}`);
    }
    return reply.project;
  }

  async projectSwitch(projectId: string): Promise<void> {
    const reply = await this.request({ type: "project_switch", project_id: projectId });
    if (reply.type !== "project_switched") {
      throw new WsBridgeError("protocol", `expected project_switched, got ${reply.type}`);
    }
  }

  // Cloud-agent project CRUD. The `args` payload mirrors the desktop's
  // `commands::projects::{CreateProjectArgs, UpdateProjectArgs}` so the
  // same camelCase object the renderer hands to Tauri's `invoke` can be
  // forwarded verbatim over WS.

  async projectCreate(args: WsBridgeProjectCreateArgs): Promise<WsBridgeProject> {
    const reply = await this.request({ type: "project_create", args });
    if (reply.type !== "project_result") {
      throw new WsBridgeError("protocol", `expected project_result, got ${reply.type}`);
    }
    return reply.project;
  }

  async projectUpdate(args: WsBridgeProjectUpdateArgs): Promise<WsBridgeProject> {
    const reply = await this.request({ type: "project_update", args });
    if (reply.type !== "project_result") {
      throw new WsBridgeError("protocol", `expected project_result, got ${reply.type}`);
    }
    return reply.project;
  }

  async projectDelete(projectId: string): Promise<void> {
    const reply = await this.request({ type: "project_delete", project_id: projectId });
    if (reply.type !== "project_void_result") {
      throw new WsBridgeError("protocol", `expected project_void_result, got ${reply.type}`);
    }
  }

  async projectReorder(ids: string[]): Promise<void> {
    const reply = await this.request({ type: "project_reorder", ids });
    if (reply.type !== "project_void_result") {
      throw new WsBridgeError("protocol", `expected project_void_result, got ${reply.type}`);
    }
  }

  async projectUpdateWorkspaceTabs(
    projectId: string,
    visible: string[],
    active: string,
  ): Promise<void> {
    const reply = await this.request({
      type: "project_update_workspace_tabs",
      project_id: projectId,
      visible,
      active,
    });
    if (reply.type !== "project_void_result") {
      throw new WsBridgeError("protocol", `expected project_void_result, got ${reply.type}`);
    }
  }

  // ---- T19.33: project_link bridge -------------------------------------
  //
  // Each method maps 1:1 to a `project_link_*` `ClientMessage` variant in
  // `crates/workstation-core/src/ws/protocol.rs`. Wire payload is flat
  // (no `args` wrapper) so the camelCase fields are mapped to snake_case
  // here before send. Returns are typed via [`WsBridgeProjectLink`] but
  // the renderer re-validates through Zod in `src/db/projectLinks.ts`.

  async projectLinkList(projectId: string): Promise<WsBridgeProjectLink[]> {
    const reply = await this.request({
      type: "project_link_list",
      project_id: projectId,
    });
    if (reply.type !== "project_links_result") {
      throw new WsBridgeError("protocol", `expected project_links_result, got ${reply.type}`);
    }
    return reply.links;
  }

  async projectLinkSet(args: WsBridgeProjectLinkSetArgs): Promise<WsBridgeProjectLink> {
    const reply = await this.request({
      type: "project_link_set",
      project_id: args.projectId,
      service: args.service,
      external_id: args.externalId,
      metadata: args.metadata,
    });
    if (reply.type !== "project_link_result") {
      throw new WsBridgeError("protocol", `expected project_link_result, got ${reply.type}`);
    }
    return reply.link;
  }

  async projectLinkDelete(
    projectId: string,
    service: string,
    externalId: string,
  ): Promise<boolean> {
    const reply = await this.request({
      type: "project_link_delete",
      project_id: projectId,
      service,
      external_id: externalId,
    });
    if (reply.type !== "project_link_deleted") {
      throw new WsBridgeError("protocol", `expected project_link_deleted, got ${reply.type}`);
    }
    return reply.removed;
  }

  async settingsGet(): Promise<WsBridgeSettings> {
    const reply = await this.request({ type: "settings_get" });
    if (reply.type !== "settings_result") {
      throw new WsBridgeError("protocol", `expected settings_result, got ${reply.type}`);
    }
    return reply.settings;
  }

  // ---- T19.13: PlanFlow Tasks bridge ------------------------------------
  //
  // Each method maps 1:1 to a `planflow_*` ClientMessage variant in
  // `src-tauri/src/ws/protocol.rs`. The cloud-agent proxies the call
  // through its embedded HTTP client using the cloud-agent's keychain
  // PlanFlow token, then ships the upstream payload back as
  // `planflow_result.data` with PlanFlow's `{success, data}` envelope
  // already stripped. The renderer-side `PlanFlowClient` re-validates
  // the payload through the same Zod schemas the local-HTTP path uses,
  // so a server-side drift surfaces at the schema boundary, not here.
  //
  // Returns are typed `unknown` because the wire payload's shape is the
  // upstream PlanFlow API's, which is captured by the Zod schemas — not
  // by a discriminated union here.

  async planflowGetMe(cloudProjectId?: string): Promise<unknown> {
    const payload: Record<string, unknown> = { type: "planflow_get_me" };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  async planflowListTasks(
    projectId: string,
    status?: string,
    cloudProjectId?: string,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      type: "planflow_list_tasks",
      project_id: projectId,
    };
    if (status !== undefined) payload["status"] = status;
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  async planflowListActiveWork(projectId: string, cloudProjectId?: string): Promise<unknown> {
    const payload: Record<string, unknown> = {
      type: "planflow_list_active_work",
      project_id: projectId,
    };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  async planflowListComments(
    projectId: string,
    taskId: string,
    cloudProjectId?: string,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      type: "planflow_list_comments",
      project_id: projectId,
      task_id: taskId,
    };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  async planflowCreateComment(
    projectId: string,
    taskId: string,
    body: string,
    cloudProjectId?: string,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      type: "planflow_create_comment",
      project_id: projectId,
      task_id: taskId,
      body,
    };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  async planflowStartWork(
    projectId: string,
    taskId: string,
    cloudProjectId?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      type: "planflow_start_work",
      project_id: projectId,
      task_id: taskId,
    };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
  }

  async planflowStopWork(projectId: string, cloudProjectId?: string): Promise<void> {
    const payload: Record<string, unknown> = {
      type: "planflow_stop_work",
      project_id: projectId,
    };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
  }

  async planflowUpdateTaskStatus(
    projectId: string,
    taskId: string,
    status: string,
    cloudProjectId?: string,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      type: "planflow_update_task_status",
      project_id: projectId,
      task_id: taskId,
      status,
    };
    if (cloudProjectId !== undefined) payload["cloud_project_id"] = cloudProjectId;
    const reply = await this.request(payload);
    if (reply.type !== "planflow_result") {
      throw new WsBridgeError("protocol", `expected planflow_result, got ${reply.type}`);
    }
    return reply.data;
  }

  /**
   * Listen to server-initiated `active_project_changed` events. Reserved
   * in the wire protocol today (the cloud-agent only emits a Tauri event
   * on its side); registering is safe and a future cross-WS broadcast
   * will start firing this without a wrapper change.
   */
  onActiveProjectChanged(handler: ActiveProjectChangedHandler): () => void {
    const wrapped: MessageHandler = (msg) => {
      if (msg.type === "active_project_changed") {
        handler(msg.project_id ?? null);
      }
    };
    return this.onMessage(wrapped);
  }

  /**
   * T19.14 — subscribe to `system_stats` broadcast frames. The
   * cloud-agent pushes one snapshot per tick to every authenticated
   * socket; no subscribe handshake is required, so callers just attach
   * a listener. Returns a disposer.
   */
  onSystemStats(handler: SystemStatsHandler): () => void {
    const wrapped: MessageHandler = (msg) => {
      if (msg.type !== "system_stats") return;
      handler({
        cpuPercent: msg.cpu_percent,
        ramUsedBytes: msg.ram_used_bytes,
        ramTotalBytes: msg.ram_total_bytes,
        ptySessionCount: msg.pty_session_count,
      });
    };
    return this.onMessage(wrapped);
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
      case "error": {
        // T19.9 — generic, non-PTY error envelope used by the projects /
        // settings handlers and by the unknown-type fallback. Reject the
        // pending promise with the typed bridge error so callers can
        // branch on `.kind` without per-feature plumbing.
        const id = parsed.id;
        if (id !== undefined) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(new WsBridgeError(parsed.kind, parsed.message));
          }
        }
        return;
      }
      case "planflow_error": {
        // T19.13 — PlanFlow bridge error envelope (carries optional HTTP
        // `status` so callers can branch on 401/403/404 without re-parsing
        // prose). Distinct from the generic `error` frame for that reason.
        const id = parsed.id;
        if (id !== undefined) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(new WsPlanflowError(parsed.kind, parsed.message, parsed.status));
          }
        }
        return;
      }
      case "active_project_changed": {
        // Server-initiated event — no correlation id. Already delivered
        // to every `onMessage` handler above (which is where
        // `onActiveProjectChanged` listens).
        return;
      }
      case "pty_spawned":
      case "pty_ack":
      case "pty_scrollback_chunk":
      case "projects_list_result":
      case "project_result":
      case "project_switched":
      case "project_void_result":
      case "pty_list_result":
      case "settings_result":
      case "project_links_result":
      case "project_link_result":
      case "project_link_deleted":
      case "planflow_result": {
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
