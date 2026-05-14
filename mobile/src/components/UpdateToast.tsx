// Prompts the user when a new service worker has been installed.
//
// vite-plugin-pwa's `prompt` registration mode means the new SW sits in
// `waiting` state until we call `updateSW(true)`. Without this UI the
// user would only get the new build on the next full page reload — for
// a PWA that lives on the home screen, that "next reload" can be days
// away. We mount the toast at app root so it survives route changes.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";

export function UpdateToast() {
  const [needRefresh, setNeedRefresh] = createSignal(false);
  let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

  onMount(async () => {
    if (isServer) return;
    if (!("serviceWorker" in navigator)) return;
    try {
      const mod = await import("virtual:pwa-register");
      updateSW = mod.registerSW({
        immediate: true,
        onNeedRefresh() {
          setNeedRefresh(true);
        },
        onRegisterError(error) {
          console.warn("[pwa] service worker registration failed", error);
        },
      });
    } catch (err) {
      console.warn("[pwa] virtual:pwa-register import failed", err);
    }
  });

  onCleanup(() => {
    updateSW = null;
  });

  function applyUpdate() {
    setNeedRefresh(false);
    void updateSW?.(true);
  }

  return (
    <Show when={needRefresh()}>
      <div
        class="fixed inset-x-0 z-[60] mx-auto flex max-w-md flex-col gap-2 rounded-2xl border border-border-default bg-elevated px-4 py-3 shadow-2xl"
        style={{
          bottom: "calc(env(safe-area-inset-bottom) + 88px)",
          left: "calc(env(safe-area-inset-left) + 12px)",
          right: "calc(env(safe-area-inset-right) + 12px)",
        }}
        role="status"
        aria-live="polite"
      >
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-accent"
            aria-hidden="true"
          />
          <div class="flex-1">
            <p class="text-sm font-medium text-fg">New version available</p>
            <p class="text-xs text-fg-tertiary">
              Reload to get the latest Work Station mobile build.
            </p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setNeedRefresh(false)}
            class="min-h-[36px] rounded-lg px-3 text-xs font-medium text-fg-secondary hover:bg-hover"
          >
            Later
          </button>
          <button
            type="button"
            onClick={applyUpdate}
            class="min-h-[36px] rounded-lg bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-muted"
          >
            Reload
          </button>
        </div>
      </div>
    </Show>
  );
}
