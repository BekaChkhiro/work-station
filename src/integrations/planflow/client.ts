import { z, type ZodType } from "zod";

import {
  createIntegrationHttpClient,
  IntegrationHttpClient,
  type IntegrationCacheStore,
  type RetryOptions,
} from "../httpClient";
import type { IntegrationId } from "../credentials";
import { markNeedsReauth, runWithReauthGuard } from "../reauth";
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

  constructor(options: PlanFlowClientOptions) {
    this.#reauthIntegration = options.reauthIntegration ?? null;
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
    const payload = await this.#get("/auth/me", meSchema);
    return payload.user;
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
    const query: Record<string, string> = {};
    if (options.status != null) {
      query["status"] = Array.isArray(options.status) ? options.status.join(",") : options.status;
    }
    const payload = await this.#get(
      `/projects/${encodeURIComponent(projectId)}/tasks`,
      taskListSchema,
      { query, cacheTtlMs: options.cacheTtlMs },
    );
    return payload.tasks;
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
  }

  /** Start working on a task — claims the lock + sets working_on for
   *  the authenticated user. PlanFlow uses `{action: "start"}` (NOT a
   *  status flip). The task itself is not transitioned by this call;
   *  the caller must follow up with `updateTaskStatus(..., "IN_PROGRESS")`
   *  if that's the intent. */
  async startWorking(projectId: string, taskId: string): Promise<void> {
    await this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/work`,
      z.unknown(),
      { method: "POST", json: { action: "start" }, responseType: "void" },
    );
  }

  /** Stop working — the taskId in the URL is literal `_` per PlanFlow's
   *  contract; the server resolves the current working_on from the user's
   *  session. */
  async stopWorking(projectId: string): Promise<void> {
    await this.#request(`/projects/${encodeURIComponent(projectId)}/tasks/_/work`, z.unknown(), {
      method: "POST",
      json: { action: "stop" },
      responseType: "void",
    });
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
    const payload = await this.#get(
      `/projects/${encodeURIComponent(projectId)}/active-work`,
      activeWorkResponseSchema,
    );
    return payload.activeWork.map((entry: ActiveWorkEntry) => ({
      user: {
        id: entry.userId,
        email: entry.userEmail,
        name: entry.userName,
      },
      taskId: entry.taskId,
      startedAt: entry.startedAt,
    }));
  }

  async listComments(projectId: string, taskId: string): Promise<Comment[]> {
    const payload = await this.#get(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`,
      commentListSchema,
    );
    return payload.comments;
  }

  async createComment(
    projectId: string,
    taskId: string,
    payload: CreateCommentPayload,
  ): Promise<Comment> {
    // PlanFlow's create-comment route expects `content` as the field name;
    // older callers in this app pass `body`. We accept the legacy shape
    // and translate at the wire boundary so consumers don't have to.
    const response = await this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`,
      commentDetailSchema,
      { method: "POST", json: { content: payload.body } },
    );
    return response.comment;
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
