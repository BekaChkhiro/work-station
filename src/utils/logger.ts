// Frontend logger. T1.9 will mirror these to the Rust `tracing` subscriber via
// IPC; until then we route through `console` so dev still surfaces failures.

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

const emit = (entry: LoggedError): void => {
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

export const logger = {
  error: (message: string, error?: unknown, context?: LogContext) =>
    emit({ level: "error", message, error, context }),
  warn: (message: string, context?: LogContext) => emit({ level: "warn", message, context }),
  info: (message: string, context?: LogContext) => emit({ level: "info", message, context }),
  debug: (message: string, context?: LogContext) => emit({ level: "debug", message, context }),
};
