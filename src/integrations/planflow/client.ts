import { z, type ZodType } from "zod";

import {
  createIntegrationHttpClient,
  IntegrationHttpClient,
  type IntegrationCacheStore,
  type RetryOptions,
} from "../httpClient";
import { mapHttpError, PlanFlowParseError } from "./errors";
import {
  activeWorkListSchema,
  branchNameResponseSchema,
  changesResponseSchema,
  commentListSchema,
  commentSchema,
  knowledgeEntrySchema,
  knowledgeListSchema,
  knowledgeTypeSchema,
  meSchema,
  notificationListSchema,
  projectListSchema,
  projectSchema,
  taskListSchema,
  taskSchema,
  type ActiveWorkEntry,
  type BranchNameResponse,
  type ChangesResponse,
  type Comment,
  type KnowledgeEntry,
  type KnowledgeType,
  type Me,
  type Notification,
  type Project,
  type Task,
  type TaskStatus,
} from "./schemas";

export const PLANFLOW_DEFAULT_BASE_URL = "https://api.planflow.tools";

export interface PlanFlowClientOptions {
  baseUrl?: string;
  getAuthToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
  cacheStore?: IntegrationCacheStore;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryOptions;
}

export interface ListTasksOptions {
  status?: TaskStatus | TaskStatus[];
  phase?: string | number;
  cacheTtlMs?: number;
}

export interface ListChangesOptions {
  cursor?: string;
  limit?: number;
}

export interface TaskWorkPayload {
  status?: TaskStatus;
  note?: string;
  saveAsKnowledge?: boolean;
  knowledgeTitle?: string;
  knowledgeType?: KnowledgeType;
}

export interface UpdateTaskPayload {
  name?: string;
  description?: string;
  status?: TaskStatus;
  complexity?: string;
  phase?: string | number;
  dependencies?: string[];
}

export interface CreateCommentPayload {
  body: string;
}

export interface CreateKnowledgePayload {
  title: string;
  body: string;
  type?: KnowledgeType;
}

export interface BulkStatusPayload {
  taskIds: string[];
  status: TaskStatus;
}

export interface ReorderTasksPayload {
  taskIds: string[];
}

export class PlanFlowClient {
  readonly #http: IntegrationHttpClient;

  constructor(options: PlanFlowClientOptions) {
    this.#http = createIntegrationHttpClient({
      service: "planflow",
      baseUrl: options.baseUrl ?? PLANFLOW_DEFAULT_BASE_URL,
      getAuthToken: options.getAuthToken,
      fetchImpl: options.fetchImpl,
      cacheStore: options.cacheStore,
      defaultHeaders: { accept: "application/json" },
      defaultTimeoutMs: options.defaultTimeoutMs,
      defaultRetry: options.defaultRetry,
    });
  }

  async getMe(): Promise<Me> {
    return this.#get("/me", meSchema);
  }

  async listProjects(cacheTtlMs?: number): Promise<Project[]> {
    return this.#get("/projects", projectListSchema, { cacheTtlMs });
  }

  async getProject(projectId: string): Promise<Project> {
    return this.#get(`/projects/${encodeURIComponent(projectId)}`, projectSchema);
  }

  async listTasks(projectId: string, options: ListTasksOptions = {}): Promise<Task[]> {
    const query: Record<string, string> = {};
    if (options.status != null) {
      query["status"] = Array.isArray(options.status) ? options.status.join(",") : options.status;
    }
    if (options.phase != null) query["phase"] = String(options.phase);
    return this.#get(`/projects/${encodeURIComponent(projectId)}/tasks`, taskListSchema, {
      query,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  async getTask(projectId: string, taskId: string): Promise<Task> {
    return this.#get(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      taskSchema,
    );
  }

  async updateTask(projectId: string, taskId: string, payload: UpdateTaskPayload): Promise<Task> {
    return this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      taskSchema,
      { method: "PATCH", json: payload },
    );
  }

  async workOnTask(
    projectId: string,
    taskId: string,
    payload: TaskWorkPayload = {},
  ): Promise<Task> {
    return this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/work`,
      taskSchema,
      { method: "POST", json: payload },
    );
  }

  async releaseTaskLock(projectId: string, taskId: string): Promise<void> {
    await this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/work`,
      z.unknown(),
      { method: "DELETE", responseType: "void" },
    );
  }

  async bulkUpdateStatus(projectId: string, payload: BulkStatusPayload): Promise<Task[]> {
    return this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/bulk-status`,
      taskListSchema,
      { method: "POST", json: payload },
    );
  }

  async reorderTasks(projectId: string, payload: ReorderTasksPayload): Promise<void> {
    await this.#request(`/projects/${encodeURIComponent(projectId)}/tasks/reorder`, z.unknown(), {
      method: "POST",
      json: payload,
      responseType: "void",
    });
  }

  async getBranchName(projectId: string, taskId: string): Promise<BranchNameResponse> {
    return this.#get(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/branch-name`,
      branchNameResponseSchema,
    );
  }

  async listChanges(projectId: string, options: ListChangesOptions = {}): Promise<ChangesResponse> {
    const query: Record<string, string | number> = {};
    if (options.cursor != null) query["cursor"] = options.cursor;
    if (options.limit != null) query["limit"] = options.limit;
    return this.#get(`/projects/${encodeURIComponent(projectId)}/changes`, changesResponseSchema, {
      query,
    });
  }

  async listActiveWork(projectId: string): Promise<ActiveWorkEntry[]> {
    return this.#get(
      `/projects/${encodeURIComponent(projectId)}/active-work`,
      activeWorkListSchema,
    );
  }

  async listComments(projectId: string, taskId: string): Promise<Comment[]> {
    return this.#get(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`,
      commentListSchema,
    );
  }

  async createComment(
    projectId: string,
    taskId: string,
    payload: CreateCommentPayload,
  ): Promise<Comment> {
    return this.#request(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`,
      commentSchema,
      { method: "POST", json: payload },
    );
  }

  async listNotifications(): Promise<Notification[]> {
    return this.#get("/notifications", notificationListSchema);
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.#request(`/notifications/${encodeURIComponent(notificationId)}/read`, z.unknown(), {
      method: "POST",
      responseType: "void",
    });
  }

  async listKnowledge(projectId: string): Promise<KnowledgeEntry[]> {
    return this.#get(`/projects/${encodeURIComponent(projectId)}/knowledge`, knowledgeListSchema);
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
    try {
      return await this.#http.request<T>(path, {
        method: options.method,
        query: options.query,
        json: options.json,
        cacheTtlMs: options.cacheTtlMs,
        responseType,
        parse:
          responseType === "json" ? (value) => parseWithSchema(schema, path, value) : undefined,
      });
    } catch (error) {
      mapHttpError(error);
    }
  }
}

export function createPlanFlowClient(options: PlanFlowClientOptions): PlanFlowClient {
  return new PlanFlowClient(options);
}

function parseWithSchema<T>(schema: ZodType<T>, path: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new PlanFlowParseError(path, result.error);
}
