import { IntegrationHttpError } from "../httpClient";

export class PlanFlowAuthError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `PlanFlow authentication failed (HTTP ${status})`);
    this.name = "PlanFlowAuthError";
    this.status = status;
    this.body = body;
  }
}

export class PlanFlowApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `PlanFlow API error (HTTP ${status})`);
    this.name = "PlanFlowApiError";
    this.status = status;
    this.body = body;
  }
}

// T12.4 — `POST /tasks/:id/work` returns 409 when another user already
// holds the lock. We split this out from the generic API error so the
// Start-task flow can surface a targeted "locked by …" toast instead of
// the muddier "HTTP 409" message.
export class PlanFlowConflictError extends Error {
  readonly status: 409;
  readonly body: string;

  constructor(body: string, message?: string) {
    super(message ?? "PlanFlow resource is currently locked by another user.");
    this.name = "PlanFlowConflictError";
    this.status = 409;
    this.body = body;
  }
}

export class PlanFlowParseError extends Error {
  readonly path: string;
  readonly causeValue: unknown;

  constructor(path: string, causeValue: unknown) {
    super(`PlanFlow response failed schema validation for ${path}`);
    this.name = "PlanFlowParseError";
    this.path = path;
    this.causeValue = causeValue;
  }
}

export function mapHttpError(error: unknown): never {
  if (error instanceof IntegrationHttpError) {
    if (error.status === 401 || error.status === 403) {
      throw new PlanFlowAuthError(error.status, error.body);
    }
    if (error.status === 409) {
      throw new PlanFlowConflictError(error.body, error.message);
    }
    throw new PlanFlowApiError(error.status, error.body, error.message);
  }
  throw error;
}
