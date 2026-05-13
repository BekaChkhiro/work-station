import { Show, createSignal, type JSX } from "solid-js";
import { TabBar } from "./TabBar";
import { SettingsSheet } from "./SettingsSheet";

export function Shell(props: { children?: JSX.Element }) {
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  return (
    <div class="min-h-screen bg-neutral-950 text-neutral-100">
      <header
        class="sticky top-0 z-40 flex items-center justify-between border-b border-border-default bg-canvas/95 px-4 backdrop-blur"
        style={{
          "padding-top": "env(safe-area-inset-top)",
          height: "calc(env(safe-area-inset-top) + 48px)",
        }}
      >
        <span class="text-sm font-semibold tracking-tight">Work Station</span>
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
