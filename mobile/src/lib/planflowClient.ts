/**
 * Slim REST client for api.planflow.tools — mobile/PWA only.
 *
 * Mirrors the surface area the desktop client exposes for tasks
 * (src/integrations/planflow/client.ts), but stripped to the calls
 * T18.15 actually needs and free of the desktop's IntegrationHttpClient
 * dependency (cache store, retry orchestration, reauth guard). Once the
 * T18.6 WebSocket bridge ships, this module is replaced by a relay shim
 * that speaks the same surface — keep the method signatures stable.
 */

export const PLANFLOW_DEFAULT_BASE_URL = "https://api.planflow.tools";

export type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "DROPPED";

export interface UserSummary {
  id: string;
  email?: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  organizationId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Task {
  id: string;
  taskId: string;
  projectId?: string;
  name: string;
  description?: string | null;
  status: TaskStatus;
  complexity?: string | null;
  phase?: string | number | null;
  dependencies?: string[];
  blocks?: string[];
  lockedBy?: UserSummary | null;
  assignee?: UserSummary | null;
  acceptance?: string | null;
  estimatedHours?: number | null;
  estimateHours?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Me {
  id: string;
  email: string;
  name?: string | null;
}

export class PlanFlowApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "PlanFlowApiError";
    this.status = status;
    this.code = code;
  }
}

interface Envelope<T> {
  success?: boolean;
  data: T;
}

export interface PlanFlowClientOptions {
  baseUrl?: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}

export class PlanFlowClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PlanFlowClientOptions) {
    this.baseUrl = (opts.baseUrl ?? PLANFLOW_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.getToken();
    if (!token) throw new PlanFlowApiError(401, "Not authenticated", "no_token");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new PlanFlowApiError(0, err instanceof Error ? err.message : "Network error", "network");
    }

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let code: string | undefined;
      try {
        const parsed = (await res.json()) as { error?: string; message?: string; code?: string };
        message = parsed.error ?? parsed.message ?? message;
        code = parsed.code;
      } catch {
        // body was not JSON; fall through with the default message
      }
      throw new PlanFlowApiError(res.status, message, code);
    }

    const parsed = (await res.json()) as Envelope<T> | T;
    if (parsed && typeof parsed === "object" && "data" in (parsed as Envelope<T>)) {
      return (parsed as Envelope<T>).data;
    }
    return parsed as T;
  }

  async me(): Promise<Me> {
    const data = await this.request<{ user: Me }>("GET", "/auth/me");
    return data.user;
  }

  async listProjects(): Promise<Project[]> {
    const data = await this.request<{ projects: Project[] }>("GET", "/projects");
    return data.projects ?? [];
  }

  async listTasks(projectId: string): Promise<Task[]> {
    const data = await this.request<{ tasks: Task[] }>("GET", `/projects/${projectId}/tasks`);
    return data.tasks ?? [];
  }

  /** Acquire the lock + mark IN_PROGRESS. Mirrors the desktop client's
   *  `startWork` call (POST /:projectId/tasks/:taskId/work). */
  async startWork(projectId: string, taskId: string): Promise<void> {
    await this.request("POST", `/projects/${projectId}/tasks/${taskId}/work`, { taskId });
  }
}
