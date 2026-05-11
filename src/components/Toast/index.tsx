// T11.9 — Minimal Solid signal-driven toast stack.
//
// Maximum 3 toasts visible simultaneously. Each auto-dismisses after 5 s.
// New toasts beyond the 3-cap evict the oldest visible entry. Positioned
// top-right via fixed inline style so it works regardless of page layout.
//
// Usage (imperative, works from non-component contexts):
//   import { showToast } from "../../components/Toast";
//   showToast({ message: "Something happened", variant: "warning" });
//
// Mount <ToastRegion /> once near the root. Safe to mount multiple times
// but only one DOM region is needed.

import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";

export type ToastVariant = "info" | "warning" | "error" | "success";

export interface ToastEntry {
  id: number;
  message: string;
  variant: ToastVariant;
}

const MAX_VISIBLE = 3;
const DISMISS_AFTER_MS = 5_000;

let nextId = 1;
const [toasts, setToasts] = createSignal<ToastEntry[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleAutoDismiss(id: number): void {
  const timer = setTimeout(() => {
    dismissToast(id);
  }, DISMISS_AFTER_MS);
  timers.set(id, timer);
}

function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

/** Imperatively push a toast. Can be called from any non-reactive context
 *  (module-level code, async handlers, Tauri command callbacks, etc.). */
export function showToast(opts: { message: string; variant?: ToastVariant }): void {
  const entry: ToastEntry = {
    id: nextId++,
    message: opts.message,
    variant: opts.variant ?? "info",
  };
  setToasts((prev) => {
    const next = [...prev, entry];
    // Cap at MAX_VISIBLE by evicting the oldest entry.
    while (next.length > MAX_VISIBLE) {
      const evicted = next.shift();
      if (evicted !== undefined) {
        const timer = timers.get(evicted.id);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(evicted.id);
        }
      }
    }
    return next;
  });
  scheduleAutoDismiss(entry.id);
}

// -- Variant color mapping (design tokens) ------------------------------------

const VARIANT_STYLES: Record<ToastVariant, { dot: string; border: string }> = {
  info: { dot: "var(--info)", border: "var(--info)" },
  success: { dot: "var(--success)", border: "var(--success)" },
  warning: { dot: "var(--warning)", border: "var(--warning)" },
  error: { dot: "var(--error)", border: "var(--error)" },
};

// -- Component ----------------------------------------------------------------

function Toast(props: { entry: ToastEntry }): JSX.Element {
  const style = VARIANT_STYLES[props.entry.variant];

  onCleanup(() => {
    const timer = timers.get(props.entry.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(props.entry.id);
    }
  });

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        display: "flex",
        "align-items": "center",
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-3)",
        "background-color": "var(--bg-elevated)",
        border: `1px solid ${style.border}`,
        "border-radius": "var(--r-md)",
        "box-shadow": "var(--shadow-popover)",
        "font-size": "var(--fs-12)",
        color: "var(--text-primary)",
        "max-width": "320px",
        "word-break": "break-word",
        "pointer-events": "auto",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "8px",
          height: "8px",
          "border-radius": "50%",
          background: style.dot,
          "flex-shrink": "0",
        }}
      />
      <span style={{ flex: "1" }}>{props.entry.message}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(props.entry.id)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-tertiary)",
          padding: "2px 4px",
          "font-size": "var(--fs-12)",
          "line-height": "1",
          "border-radius": "var(--r-sm)",
          "min-width": "44px",
          "min-height": "44px",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
        }}
      >
        x
      </button>
    </div>
  );
}

/** Mount this once near your app root (e.g. in App.tsx). */
export function ToastRegion(): JSX.Element {
  return (
    <Show when={toasts().length > 0}>
      <div
        aria-label="Notifications"
        style={{
          position: "fixed",
          top: "var(--sp-4)",
          right: "var(--sp-4)",
          "z-index": "9999",
          display: "flex",
          "flex-direction": "column",
          gap: "var(--sp-2)",
          "pointer-events": "none",
        }}
      >
        <For each={toasts()}>{(entry) => <Toast entry={entry} />}</For>
      </div>
    </Show>
  );
}

export default ToastRegion;
