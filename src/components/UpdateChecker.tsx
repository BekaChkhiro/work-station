import { Show, onMount } from "solid-js";
import {
  status,
  updateInfo,
  downloadProgress,
  error,
  checkForUpdate,
  downloadAndInstall,
  dismissUpdate,
} from "../stores/updater";

/**
 * Non-intrusive update banner that appears when a new version is available.
 * Auto-checks on mount. User can dismiss or trigger download+install.
 */
export default function UpdateChecker() {
  onMount(() => {
    // Delay slightly so it doesn't fight app startup.
    const timer = setTimeout(() => {
      checkForUpdate();
    }, 3000);
    return () => clearTimeout(timer);
  });

  return (
    <Show when={status() !== "idle" && status() !== "checking"}>
      <div
        class="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-surface-border
               bg-surface-elevated shadow-xl animate-in slide-in-from-bottom-2"
        role="alert"
        aria-live="polite"
      >
        <div class="px-4 py-3">
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-semibold text-text-primary">
                <Show
                  when={status() === "available"}
                  fallback={
                    <Show
                      when={status() === "downloading"}
                      fallback={
                        <Show
                          when={status() === "ready"}
                          fallback="Update error"
                        >
                          Update ready
                        </Show>
                      }
                    >
                      Downloading update…
                    </Show>
                  }
                >
                  Update available
                </Show>
              </h3>

              <Show when={status() === "available" && updateInfo()}>
                <p class="mt-1 text-xs text-text-secondary truncate">
                  Version {updateInfo()?.version} is ready to install.
                </p>
              </Show>

              <Show when={status() === "downloading"}>
                <div class="mt-2 h-1.5 w-full rounded-full bg-surface-sunken overflow-hidden">
                  <div
                    class="h-full bg-primary-500 rounded-full transition-all duration-300"
                    style={{ width: `${downloadProgress()}%` }}
                  />
                </div>
                <p class="mt-1 text-[10px] text-text-tertiary">
                  {downloadProgress()}% downloaded
                </p>
              </Show>

              <Show when={status() === "ready"}>
                <p class="mt-1 text-xs text-text-secondary">
                  Restart the app to finish installing.
                </p>
              </Show>

              <Show when={status() === "error" && error()}>
                <p class="mt-1 text-xs text-danger">{error()}</p>
              </Show>
            </div>

            <button
              onClick={dismissUpdate}
              class="shrink-0 text-text-tertiary hover:text-text-primary transition-colors"
              aria-label="Dismiss update notification"
            >
              ✕
            </button>
          </div>

          <Show when={status() === "available"}>
            <div class="mt-3 flex gap-2">
              <button
                onClick={downloadAndInstall}
                class="flex-1 px-3 py-1.5 rounded-md bg-primary-600 hover:bg-primary-500
                       text-white text-xs font-medium transition-colors"
              >
                Download & Install
              </button>
              <button
                onClick={dismissUpdate}
                class="px-3 py-1.5 rounded-md bg-surface-hover hover:bg-surface-active
                       border border-surface-border text-text-secondary text-xs font-medium transition-colors"
              >
                Later
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
