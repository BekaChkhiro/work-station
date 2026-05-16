import { z, type ZodType } from "zod";

import {
  createIntegrationHttpClient,
  IntegrationHttpClient,
  type IntegrationCacheStore,
  type RetryOptions,
} from "../httpClient";
import type { IntegrationId } from "../credentials";
import { markNeedsReauth, runWithReauthGuard } from "../reauth";
import { routeIpc } from "../../ipc/transport";
import type { WsBridgeClient } from "../wsBridge";
import { mapHttpError, PlanFlowParseError } from "./errors";
import {
  activeWorkResponseSchema,
  changesResponseSchema,
  commentDetailSchema,
  commentListSchema,
  envelopeSchema,
  knowledgeEntrySchema,
  knowledgeListSchema,
  knowledgeTypeSchema,
  meSchema,
  notificationListSchema,
  unreadNotificationCountSchema,
  organizationListSchema,
  organizationSchema,
  projectDetailSchema,
  projectListSchema,
  projectSchema,
  taskListSchema,
  taskSchema,
  type ActiveWorkEntry,
  type Comment,
  type KnowledgeEntry,
  type KnowledgeType,
  type Me,
  type Notification,
  type Organization,
  type Project,
  type Task,
  type TaskStatus,
  type Change,
} from "./schemas";

export const PLANFLOW_DEFAULT_BASE_URL = "https://api.planflow.tools";

export interface PlanFlowClientOptions {
  baseUrl?: string;
  getAuthToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
  cacheStore?: IntegrationCacheStore;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryOptions;
  /** T11.8 — when provided, every request is wrapped in the integration
   *  reauth guard. A 401/403 marks the integration as `needs_reauth`,
   *  surfaces the Reconnect banner, and queues the request for retry
   *  after the next successful Verify. Verify clients should leave this
   *  unset so a bad-token check doesn't trip the global state. */
  reauthIntegration?: IntegrationId;
  /** T19.13 — when true, methods that have a cloud-agent counterpart
   *  (`listTasks`, `updateTaskStatus`, `startWorking`, `stopWorking`,
   *  `listActiveWork`, `listComments`, `createComment`, `getMe`) route
   *  through the IPC transport so cloud mode hits the cloud-agent's
   *  `planflow_*` WS handlers instead of HTTP. Other methods (notifications,
   *  knowledge, list-changes, list-projects, get-branch-name, …) stay on
   *  HTTP regardless — they have no cloud-agent counterpart. The renderer
   *  factory (`createRendererPlanFlowClient`) sets this to `true`; the
   *  verifier and Settings panel keep it `false` so a credential-test or
   *  account-config call always hits the desktop's own PlanFlow token. */
  routeViaCloudAgent?: boolean;
  /** T19.35 — Work Station project UUID this client is scoped to. When
   *  set, every routed `planflow_*` WS call ships `cloud_project_id`
   *  alongside the PlanFlow `project_id`, letting the cloud-agent's
   *  per-project token resolver (T19.34) pick the correct PlanFlow API
   *  token for the linked account. Omitted in local mode and in
   *  unscoped contexts (NotificationsBell), where the cloud-agent falls
   *  back to its global token. */
  cloudProjectId?: string;
}

export interface ListTasksOptions {
  status?: TaskStatus | TaskStatus[];
  cacheTtlMs?: number;
}

export interface ListChangesOptions {
  /** Server-side watermark — return only changes that occurred after this
   *  timestamp (ISO string). The API does not echo back a cursor; the
   *  caller is expected to use the most recent `occurredAt`/`createdAt` it
   *  has seen. */
  since?: string;
  limit?: number;
}

/** PlanFlow's `/work` endpoint takes an action verb rather than a status.
 *  Status changes ride a separate route (PATCH /tasks/:taskId). */
export interface StartWorkPayload {
  taskId: string;
}

export interface UpdateTaskStatusPayload {
  status: TaskStatus;
}

export interface CreateCommentPayload {
  body: string;
}

export interface CreateKnowledgePayload {
  title: string;
  body: string;
  type?: KnowledgeType;
}

export interface MarkNotificationsReadPayload {
  notificationIds?: string[];
  projectId?: string;
}

/** A flattened active-work entry that matches what the UI already expected
 *  before T-fix. We adapt the new server response (`{taskId, userId,
 *  userName, ...}`) into a `{user, taskId, startedAt}` triple so the
 *  rest of the app doesn't have to change. */
export interface ActiveWorkUser {
  user: {
    id: string;
    email?: string;
    name?: string | null;
  };
  taskId: string;
  startedAt: string;
}

/** Mirrors the old `{branchName: string}` shape so the caller doesn't need
 *  to know we now generate this client-side. */
export interface BranchNameResponse {
  branchName: string;
  /** Optional convenience string that callers can drop straight into a
   *  terminal — `git checkout -b <branchName>`. */
  gitCommand?: string;
}

export class PlanFlowClient {
  readonly #http: IntegrationHttpClient;
  readonly #reauthIntegration: IntegrationId | null;
  readonly #routeViaCloudAgent: boolean;
  readonly #cloudProjectId: string | undefined;

  constructor(options: PlanFlowClientOptions) {
    this.#reauthIntegration = options.reauthIntegration ?? null;
    this.#routeViaCloudAgent = options.routeViaCloudAgent ?? false;
    this.#cloudProjectId = options.cloudProjectId;
    const reauthIntegration = this.#reauthIntegration;
    this.#http = createIntegrationHttpClient({
      service: "planflow",
      baseUrl: options.baseUrl ?? PLANFLOW_DEFAULT_BASE_URL,
      getAuthToken: options.getAuthToken,
      fetchImpl: options.fetchImpl,
      cacheStore: options.cacheStore,
      defaultHeaders: { accept: "application/json" },
      defaultTimeoutMs: options.defaultTimeoutMs,
      defaultRetry: options.defaultRetry,
      onAuthFailure:
        reauthIntegration == null
          ? undefined
          : async () => {
              await markNeedsReauth(reauthIntegration);
            },
    });
  }

  async getMe(): Promise<Me["user"]> {
    return this.#route(
      async () => {
        const payload = await this.#get("/auth/me", meSchema);
        return payload.user;
      },
      async (client) => {
        const raw = await client.planflowGetMe(this.#cloudProjectId);
        return meSchema.parse(raw).user;
      },
    );
  }

  async listOrganizations(): Promise<Organization[]> {
    const payload = await this.#get("/organizations", organizationListSchema);
    return payload.organizations;
  }

  async listProjects(organizationId?: string, cacheTtlMs?: number): Promise<Project[]> {
    let orgId = organizationId;
    if (orgId == null) {
      const orgs = await this.listOrganizations();
      const first = orgs[0];
      if (first == null) return [];
      orgId = first.id;
    }
    const payload = await this.#get("/projects", projectListSchema, {
      query: { organizationId: orgId },
      cacheTtlMs,
    });
    return payload.projects;
  }

  async getProject(projectId: string): Promise<Project> {
    const payload = await this.#get(
      `/projects/${encodeURIComponent(projectId)}`,
      projectDetailSchema,
    );
    return payload.project;
  }

  async listTasks(projectId: string, options: ListTasksOptions = {}): Promise<Task[]> {
    return this.#route(
      async () => {
        const query: Record<string, string> = {};
        if (options.status != null) {
          query["status"] = Array.isArray(options.status)
            ? options.status.join(",")
            : options.status;
        }
        const payload = await this.#get(
          `/projects/${encodeURIComponent(projectId)}/tasks`,
          taskListSchema,
          { query, cacheTtlMs: options.cacheTtlMs },
        );
        return payload.tasks;
      },
      async (client) => {
        const status =
          options.status == null
            ? undefined
            : Array.isArray(options.status)
              ? options.status.join(",")
              : options.status;
        const raw = await client.planflowListTasks(projectId, status, this.#cloudProjectId);
        return taskListSchema.parse(raw).tasks;
      },
    );
  }

  /** PlanFlow has no single-task GET — the caller looks the task up in the
   *  bulk list. We keep this signature for API parity but it's just a
   *  thin filter on top of `listTasks`. */
  async getTask(projectId: string, taskIdOrUuid: string): Promise<Task | null> {
    const tasks = await this.listTasks(projectId);
    return tasks.find((t) => t.taskId === taskIdOrUuid || t.id === taskIdOrUuid) ?? null;
  }

  /** Update a task's status. PlanFlow's `bulk-status` route is the cleanest
   *  way to flip a single task because it returns the patched row in the
   *  response, but the server validates the body's `taskIds` against task
   *  UUIDs only. The path parameter is the project UUID; the body needs
   *  the task UUID even when the caller has the human-readable taskId
   *  ("T1.1") in hand. We resolve `T<n>.<m>` → UUID with a single
   *  `listTasks` round-trip when needed. */
  async updateTaskStatus(
    projectId: string,
    taskIdOrUuid: string,
    status: TaskStatus,
  ): Promise<Task | null> {
    return this.#route(
      async () => {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          taskIdOrUuid,
        );
        let taskUuid = taskIdOrUuid;
        if (!isUuid) {
          const tasks = await this.listTasks(projectId);
          const match = tasks.find((t) => t.taskId === taskIdOrUuid);
          if (!match) return null;
          taskUuid = match.id;
        }
        const response = await this.#request(
          `/projects/${encodeURIComponent(projectId)}/tasks/bulk-status`,
          taskListSchema,
          { method: "POST", json: { taskIds: [taskUuid], status } },
        );
        return response.tasks[0] ?? null;
      },
      // The cloud-agent's `handle_update_task_status` does the same
      // human-id → UUID resolution server-side, so we forward the caller's
      // input verbatim.
      async (client) => {
        const raw = await client.planflowUpdateTaskStatus(
          projectId,
          taskIdOrUuid,
          status,
          this.#cloudProjectId,
        );
        return taskListSchema.parse(raw).tasks[0] ?? null;
      },
    );
  }

  /** Start working on a task — claims the lock + sets working_on for
   *  the authenticated user. PlanFlow uses `{action: "start"}` (NOT a
   *  status flip). The task itself is not transitioned by this call;
   *  the caller must follow up with `updateTaskStatus(..., "IN_PROGRESS")`
   *  if that's the intent. */
  async startWorking(projectId: string, taskId: string): Promise<void> {
    return this.#route(
      async () => {
        await this.#request(
          `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/work`,
          z.unknown(),
          { method: "POST", json: { action: "start" }, responseType: "void" },
        );
      },
      async (client) => {
        await client.planflowStartWork(projectId, taskId, this.#cloudProjectId);
      },
    );
  }

  /** Stop working — the taskId in the URL is literal `_` per PlanFlow's
   *  contract; the server resolves the current working_on from the user's
   *  session. */
  async stopWorking(projectId: string): Promise<void> {
    return this.#route(
      async () => {
        await this.#request(
          `/projects/${encodeURIComponent(projectId)}/tasks/_/work`,
          z.unknown(),
          {
            method: "POST",
            json: { action: "stop" },
            responseType: "void",
          },
        );
      },
      async (client) => {
        await client.planflowStopWork(projectId, this.#cloudProjectId);
      },
    );
  }

  /** Client-side branch-name generation. PlanFlow's `/branch-name` route
   *  exists but is gated by browser-JWT (not API tokens), so we replicate
   *  its slug logic here. Kept as `async` for API parity. */
  async getBranchName(
    projectId: string,
    taskId: string,
    options: { prefix?: string } = {},
  ): Promise<BranchNameResponse> {
    void projectId;
    // The task name isn't strictly required for branch generation but it
    // makes the slug human-friendly. We fetch it best-effort and fall back
    // to the taskId-only branch when offline / unauthorised.
    let name: string | null = null;
    try {
      const task = await this.getTask(projectId, taskId);
      name = task?.name ?? null;
    } catch {
      // Branch name fallback is acceptable on error.
    }
    const prefix = options.prefix?.trim() ?? "feature";
    const slug = slugify(name ?? taskId);
    const branchName = `${prefix}/${taskId.toLowerCase()}-${slug}`.replace(/-+$/g, "");
    return { branchName, gitCommand: `git checkout -b ${branchName}` };
  }

  async listChanges(
    projectId: string,
    options: ListChangesOptions = {},
  ): Promise<{ changes: Change[]; cursor: string | null }> {
    const query: Record<string, string | number> = {};
    if (options.since != null) query["since"] = options.since;
    if (options.limit != null) query["limit"] = options.limit;
    const payload = await this.#get(
      `/projects/${encodeURIComponent(projectId)}/changes`,
      changesResponseSchema,
      { query },
    );
    // Normalise the timestamp field so consumers can rely on `occurredAt`
    // regardless of what the server happens to call it.
    const normalised: Change[] = payload.changes.map((c: Change) => ({
      ...c,
      occurredAt: c.occurredAt ?? c.timestamp ?? c.createdAt ?? "",
    }));
    // PlanFlow doesn't return a cursor itself — derive one from the most
    // recent entry so the next poll can pass `since=<latest>` and skip
    // already-seen rows.
    const stamps: string[] = [];
    for (const c of normalised) {
      const t = c.occurredAt;
      if (typeof t === "string" && t.length > 0) stamps.push(t);
    }
    stamps.sort((a, b) => Date.parse(b) - Date.parse(a));
    const latest = stamps[0] ?? null;
    return { changes: normalised, cursor: latest };
  }

  async listActiveWork(projectId: string): Promise<ActiveWorkUser[]> {
    const adapt = (entries: ActiveWorkEntry[]): ActiveWorkUser[] =>
      entries.map((entry) => ({
        user: {
          id: entry.userId,
          email: entry.userEmail,
          name: entry.userName,
        },
        taskId: entry.taskId,
        startedAt: entry.startedAt,
      }));
    return this.#route(
      async () => {
        const payload = await this.#get(
          `/projects/${encodeURIComponent(projectId)}/active-work`,
          activeWorkResponseSchema,
        );
        return adapt(payload.activeWork);
      },
      async (client) => {
        const raw = await client.planflowListActiveWork(projectId, this.#cloudProjectId);
        return adapt(activeWorkResponseSchema.parse(raw).activeWork);
      },
    );
  }

  async listComments(projectId: string, taskId: string): Promise<Comment[]> {
    return this.#route(
      async () => {
        const payload = await this.#get(
          `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`,
          commentListSchema,
        );
        return payload.comments;
      },
      async (client) => {
        const raw = await client.planflowListComments(projectId, taskId, this.#cloudProjectId);
        return commentListSchema.parse(raw).comments;
      },
    );
  }

  async createComment(
    projectId: string,
    taskId: string,
    payload: CreateCommentPayload,
  ): Promise<Comment> {
    return this.#route(
      // PlanFlow's create-comment route expects `content` as the field name;
      // older callers in this app pass `body`. We accept the legacy shape
      // and translate at the wire boundary so consumers don't have to.
      async () => {
        const response = await this.#request(
          `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`,
          commentDetailSchema,
          { method: "POST", json: { content: payload.body } },
        );
        return response.comment;
      },
      // The cloud-agent's `handle_create_comment` performs the same
      // body→content translation; we forward the body verbatim.
      async (client) => {
        const raw = await client.planflowCreateComment(
          projectId,
          taskId,
          payload.body,
          this.#cloudProjectId,
        );
        return commentDetailSchema.parse(raw).comment;
      },
    );
  }

  async listNotifications(
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<Notification[]> {
    const query: Record<string, string | number> = {};
    if (options.unreadOnly) query["unreadOnly"] = "true";
    if (options.limit != null) query["limit"] = options.limit;
    const payload = await this.#get("/notifications", notificationListSchema, { query });
    return payload.notifications;
  }

  async getUnreadNotificationCount(): Promise<number> {
    const payload = await this.#get("/notifications/unread-count", unreadNotificationCountSchema);
    return payload.unreadCount;
  }

  /** Mark a single notification as read. PlanFlow uses PATCH (not POST). */
  async markNotificationRead(notificationId: string): Promise<void> {
    await this.#request(`/notifications/${encodeURIComponent(notificationId)}/read`, z.unknown(), {
      method: "PATCH",
      responseType: "void",
    });
  }

  async listKnowledge(projectId: string): Promise<KnowledgeEntry[]> {
    const payload = await this.#get(
      `/projects/${encodeURIComponent(projectId)}/knowledge`,
      knowledgeListSchema,
    );
    return payload.knowledge ?? payload.entries ?? [];
  }

  async createKnowledge(
    projectId: string,
    payload: CreateKnowledgePayload,
  ): Promise<KnowledgeEntry> {
    const json: Record<string, unknown> = { title: payload.title, body: payload.body };
    if (payload.type != null) json["type"] = knowledgeTypeSchema.parse(payload.type);
    return this.#request(
      `/projects/${encodeURIComponent(projectId)}/knowledge`,
      knowledgeEntrySchema,
      { method: "POST", json },
    );
  }

  /** T19.13 — route a method between local HTTP and the cloud-agent's
   *  WS bridge based on `cloudMode`. When `routeViaCloudAgent` is off
   *  (verifier / Settings panel), always run the local branch — there's
   *  no cloud transport to dial in that context. */
  async #route<T>(
    local: () => Promise<T>,
    cloud: (client: WsBridgeClient) => Promise<T>,
  ): Promise<T> {
    if (!this.#routeViaCloudAgent) return local();
    return routeIpc(local, cloud);
  }

  async #get<T>(
    path: string,
    schema: ZodType<T>,
    options: { query?: Record<string, string | number>; cacheTtlMs?: number } = {},
  ): Promise<T> {
    return this.#request(path, schema, {
      method: "GET",
      query: options.query,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  async #request<T>(
    path: string,
    schema: ZodType<T>,
    options: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      query?: Record<string, string | number>;
      json?: unknown;
      cacheTtlMs?: number;
      responseType?: "json" | "void";
    },
  ): Promise<T> {
    const responseType = options.responseType ?? "json";
    const exec = async (): Promise<T> => {
      try {
        return await this.#http.request<T>(path, {
          method: options.method,
          query: options.query,
          json: options.json,
          cacheTtlMs: options.cacheTtlMs,
          responseType,
          parse:
            responseType === "json" ? (value) => parseEnvelope(schema, path, value) : undefined,
        });
      } catch (error) {
        mapHttpError(error);
      }
    };
    if (this.#reauthIntegration == null) return exec();
    return runWithReauthGuard(this.#reauthIntegration, exec);
  }
}

export function createPlanFlowClient(options: PlanFlowClientOptions): PlanFlowClient {
  return new PlanFlowClient(options);
}

/** All success responses look like `{success: true, data: ...}`. We strip
 *  the envelope at the parse step so callers see the inner shape directly.
 *  When the response doesn't carry the envelope (older endpoints, future
 *  changes) we fall back to parsing the raw value so the call still works. */
function parseEnvelope<T>(schema: ZodType<T>, path: string, value: unknown): T {
  const enveloped = envelopeSchema(schema).safeParse(value);
  if (enveloped.success) return enveloped.data.data;
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;
  // Surface the envelope-shaped failure: it's more informative because the
  // wrapper mismatch is the common case.
  throw new PlanFlowParseError(path, enveloped.error);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export { organizationSchema, projectSchema, taskSchema };
