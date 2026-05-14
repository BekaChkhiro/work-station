import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { TabBar } from "./TabBar";
import { SettingsSheet } from "./SettingsSheet";
import { bridgeReauthRequired, bridgeReconnectInfo, bridgeState } from "../stores/wsBridge";

export function Shell(props: { children?: JSX.Element }) {
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Auto-open Settings when the server rejects the token — the user has
  // to paste a fresh one before anything else works.
  createEffect(() => {
    if (bridgeReauthRequired()) setSettingsOpen(true);
  });

  return (
    <div class="min-h-screen bg-canvas text-fg">
      <header
        class="sticky top-0 z-40 flex items-center justify-between border-b border-border-default bg-canvas/95 px-4 backdrop-blur"
        style={{
          "padding-top": "env(safe-area-inset-top)",
          height: "calc(env(safe-area-inset-top) + 48px)",
        }}
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold tracking-tight">Work Station</span>
          <ConnectionPill onClick={() => setSettingsOpen(true)} />
        </div>
        <button
          type="button"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
          class="flex h-11 w-11 items-center justify-center rounded-lg text-fg-secondary hover:bg-hover"
        >
          <GearIcon />
        </button>
      </header>
      <main
        class="mx-auto max-w-xl"
        style={{
          "padding-left": "env(safe-area-inset-left)",
          "padding-right": "env(safe-area-inset-right)",
          "padding-bottom": "calc(env(safe-area-inset-bottom) + 72px)",
        }}
      >
        {props.children}
      </main>
      <TabBar />
      <Show when={settingsOpen()}>
        <SettingsSheet onClose={() => setSettingsOpen(false)} />
      </Show>
    </div>
  );
}

function ConnectionPill(props: { onClick?: () => void }) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!bridgeReconnectInfo()) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(handle));
  });

  const tone = createMemo(() => {
    if (bridgeReauthRequired()) {
      return { dot: "bg-error", label: "Re-auth", text: "text-error" };
    }
    const info = bridgeReconnectInfo();
    switch (bridgeState()) {
      case "open":
        return { dot: "bg-success", label: "Live", text: "text-fg-secondary" };
      case "connecting":
        return { dot: "bg-warning animate-pulse", label: "Connecting", text: "text-fg-tertiary" };
      case "reconnecting": {
        const secs = info ? Math.max(0, Math.ceil((info.retryAt - now()) / 1000)) : 0;
        const suffix = info ? ` · #${info.attempt}${secs > 0 ? ` (${secs}s)` : ""}` : "";
        return {
          dot: "bg-warning animate-pulse",
          label: `Reconnecting${suffix}`,
          text: "text-fg-tertiary",
        };
      }
      case "closing":
      case "closed":
        return { dot: "bg-error", label: "Offline", text: "text-error" };
      default:
        return { dot: "bg-fg-tertiary", label: "Idle", text: "text-fg-tertiary" };
    }
  });

  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`inline-flex items-center gap-1.5 rounded-full border border-border-default bg-elevated px-2 py-0.5 text-[10px] font-medium outline-none hover:bg-hover ${tone().text}`}
      aria-live="polite"
      aria-label={`Bridge ${tone().label} — open settings`}
    >
      <span class={`h-1.5 w-1.5 rounded-full ${tone().dot}`} aria-hidden="true" />
      {tone().label}
    </button>
  );
}

function GearIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
