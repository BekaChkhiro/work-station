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
    throw new PlanFlowApiError(error.status, error.body, error.message);
  }
  throw error;
}
