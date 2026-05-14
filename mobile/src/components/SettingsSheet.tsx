import { Show, createMemo } from "solid-js";
import { authStore, signOut } from "../lib/auth";
import { bridgeLastError, bridgeState } from "../stores/wsBridge";
import { AuthScreen } from "./AuthScreen";

export function SettingsSheet(props: { onClose: () => void }) {
  function handleSignOut() {
    signOut();
    props.onClose();
  }

  const stateTone = createMemo(() => {
    switch (bridgeState()) {
      case "open":
        return { label: "Connected", className: "bg-success/15 text-success" };
      case "connecting":
        return { label: "Connecting", className: "bg-accent-soft text-accent" };
      case "reconnecting":
        return { label: "Reconnecting", className: "bg-warning/15 text-warning" };
      case "closing":
      case "closed":
        return { label: "Offline", className: "bg-error/15 text-error" };
      default:
        return { label: "Idle", className: "bg-elevated text-fg-tertiary" };
    }
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="flex w-full max-w-md flex-col gap-3 rounded-t-2xl border-t border-border-default bg-canvas px-4 pt-5 pb-6 shadow-2xl sm:rounded-2xl sm:border"
        style={{ "padding-bottom": "calc(env(safe-area-inset-bottom) + 16px)" }}
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex flex-col">
            <h2 class="text-base font-semibold tracking-tight">Connection</h2>
            <p class="text-xs text-fg-tertiary">Host and token used by every tab.</p>
          </div>
          <span
            class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${stateTone().className}`}
          >
            <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {stateTone().label}
          </span>
        </div>

        <Show when={bridgeLastError()}>
          <div class="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {bridgeLastError()}
          </div>
        </Show>

        <AuthScreen
          inline
          initialHost={authStore.host()}
          initialToken={authStore.token()}
          submitLabel="Save & reconnect"
          onCancel={props.onClose}
        />

        <button
          type="button"
          onClick={handleSignOut}
          class="min-h-[44px] rounded-lg border border-border-default bg-transparent text-sm font-medium text-error hover:bg-error/10"
        >
          Sign out / forget host
        </button>

        <p class="text-center text-[10px] text-fg-tertiary">PWA build · {import.meta.env.MODE}</p>
      </div>
    </div>
  );
}
