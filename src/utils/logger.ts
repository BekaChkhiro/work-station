// Frontend logger (T1.9).
// Always logs through `console` so dev surfaces failures inline; in production
// builds running inside Tauri we additionally forward each entry to the Rust
// `tracing` subscriber via the `log_from_frontend` command so it lands in the
// rotating log file alongside backend logs.

import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogContext {
  scope?: string;
  [key: string]: unknown;
}

export interface LoggedError {
  level: LogLevel;
  message: string;
  error?: unknown;
  context?: LogContext;
}

const shouldForwardToBackend = (): boolean => {
  if (!import.meta.env.PROD) return false;
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
};

const serializeError = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { value: err };
};

const emitConsole = (entry: LoggedError): void => {
  const payload = {
    message: entry.message,
    ...(entry.error !== undefined ? { error: serializeError(entry.error) } : {}),
    ...(entry.context ?? {}),
  };
  switch (entry.level) {
    case "error":
      console.error("[work-station]", payload);
      break;
    case "warn":
      console.warn("[work-station]", payload);
      break;
    case "info":
      console.info("[work-station]", payload);
      break;
    case "debug":
      console.debug("[work-station]", payload);
      break;
  }
};

const forwardToBackend = (entry: LoggedError): void => {
  const payload = {
    level: entry.level,
    message: entry.message,
    error: entry.error !== undefined ? serializeError(entry.error) : null,
    context: entry.context ?? null,
  };
  // Fire-and-forget — failures fall back to console so we don't lose the trail.
  void invoke("log_from_frontend", { payload }).catch((forwardError: unknown) => {
    console.error("[work-station] log forward failed", { forwardError, entry });
  });
};

const emit = (entry: LoggedError): void => {
  emitConsole(entry);
  if (shouldForwardToBackend()) {
    forwardToBackend(entry);
  }
};

export const logger = {
  error: (message: string, error?: unknown, context?: LogContext) =>
    emit({ level: "error", message, error, context }),
  warn: (message: string, context?: LogContext) => emit({ level: "warn", message, context }),
  info: (message: string, context?: LogContext) => emit({ level: "info", message, context }),
  debug: (message: string, context?: LogContext) => emit({ level: "debug", message, context }),
};
