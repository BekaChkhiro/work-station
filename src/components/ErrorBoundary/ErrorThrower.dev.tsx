import { Show, createSignal } from "solid-js";

const Crash = () => {
  throw new Error("ErrorThrower: simulated child crash for boundary verification");
};

// Dev-only verification surface for T1.8. Mount via `?wsdebug=errorboundary`.
export const ErrorThrower = () => {
  const [armed, setArmed] = createSignal(false);
  return (
    <div class="m-4 rounded-md border border-border-default bg-surface p-3">
      <div class="mb-2 text-xs text-fg-secondary">Error boundary verification (dev only)</div>
      <Show
        when={armed()}
        fallback={
          <button
            type="button"
            onClick={() => setArmed(true)}
            class="rounded-sm border border-border-default bg-elevated px-2 py-1 text-xs text-fg hover:bg-hover"
          >
            Throw in child
          </button>
        }
      >
        <Crash />
      </Show>
    </div>
  );
};
