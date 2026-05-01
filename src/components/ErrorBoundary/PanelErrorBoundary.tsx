import { ErrorBoundary, type JSX } from "solid-js";
import { logger } from "../../utils/logger";

export type PanelScope = "sidebar" | "terminal" | "layout-tree" | "panel";

const formatMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "Unknown error";
};

const labelFor = (scope: PanelScope): string => {
  switch (scope) {
    case "sidebar":
      return "Sidebar";
    case "terminal":
      return "Terminal pane";
    case "layout-tree":
      return "Layout";
    case "panel":
      return "Panel";
  }
};

const PanelFallback = (props: { error: unknown; reset: () => void; scope: PanelScope }) => {
  return (
    <div role="alert" class="flex h-full w-full items-center justify-center bg-canvas p-4 text-fg">
      <div class="w-full max-w-sm rounded-md border border-border-default bg-surface p-4">
        <div class="mb-2 flex items-center gap-2">
          <span aria-hidden="true" class="text-error">
            !
          </span>
          <h2 class="text-sm font-semibold">{labelFor(props.scope)} crashed</h2>
        </div>
        <p class="mb-3 text-xs text-fg-secondary">
          A component in this region threw. The rest of the app is unaffected.
        </p>
        <pre class="mb-3 max-h-24 overflow-auto rounded-sm border border-border-subtle bg-elevated p-2 font-mono text-xs text-fg-tertiary whitespace-pre-wrap break-words">
          {formatMessage(props.error)}
        </pre>
        <div class="flex justify-end">
          <button
            type="button"
            onClick={() => props.reset()}
            class="rounded-sm border border-border-default bg-surface px-2 py-1 text-xs text-fg hover:bg-hover"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
};

export const PanelErrorBoundary = (props: { scope: PanelScope; children: JSX.Element }) => {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        logger.error(`Unhandled error in ${props.scope}`, error, { scope: props.scope });
        return <PanelFallback error={error} reset={reset} scope={props.scope} />;
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
};
