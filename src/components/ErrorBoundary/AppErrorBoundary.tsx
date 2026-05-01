import { ErrorBoundary, type JSX } from "solid-js";
import { logger } from "../../utils/logger";

const formatMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "Unknown error";
};

const AppFallback = (props: { error: unknown; reset: () => void }) => {
  // Reload is the user-facing recovery; `reset` re-runs the boundary subtree.
  const reload = () => window.location.reload();
  return (
    <div role="alert" class="flex h-full w-full items-center justify-center bg-canvas p-8 text-fg">
      <div class="w-full max-w-md rounded-lg border border-border-default bg-surface p-6 shadow-modal">
        <div class="mb-4 flex items-center gap-3">
          <span
            aria-hidden="true"
            class="inline-flex h-8 w-8 items-center justify-center rounded-md bg-elevated text-error"
          >
            !
          </span>
          <h1 class="text-lg font-semibold tracking-tight">Work Station crashed</h1>
        </div>
        <p class="mb-4 text-sm text-fg-secondary">
          The app hit an unexpected error and stopped rendering. Reload to recover; if it keeps
          happening, the details below help us reproduce it.
        </p>
        <pre class="mb-4 max-h-40 overflow-auto rounded-md border border-border-subtle bg-elevated p-3 font-mono text-xs text-fg-tertiary whitespace-pre-wrap break-words">
          {formatMessage(props.error)}
        </pre>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => props.reset()}
            class="rounded-md border border-border-default bg-surface px-3 py-1.5 text-sm text-fg hover:bg-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={reload}
            class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas hover:bg-accent-muted"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
};

export const AppErrorBoundary = (props: { children: JSX.Element }) => {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        logger.error("Unhandled error reached app root", error, { scope: "app" });
        return <AppFallback error={error} reset={reset} />;
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
};
