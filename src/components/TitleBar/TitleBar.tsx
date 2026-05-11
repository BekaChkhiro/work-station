// T8.6: Custom window chrome.
//
// macOS:   `titleBarStyle: Overlay` in tauri.conf.json hides the native
//          title text but keeps the traffic lights overlaid on top of the
//          webview. We leave a 70px inset on the left so the buttons don't
//          clash with our content.
// Windows: `decorations: false` (set via tauri.windows.conf.json) removes
//          all native chrome. We render min/max/close buttons on the right.
//          Drag region covers the rest of the bar.
// Linux:   Native chrome is kept; this component still renders a slim drag
//          region row so the title stays consistent across platforms.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac, isWindows } from "../../utils/platform";
import { NotificationsBell } from "../NotificationsBell";

export interface TitleBarProps {
  /** Title text shown centered in the bar. Falls back to "Work Station". */
  title?: string;
}

export function TitleBar(props: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = createSignal(false);

  // Track the maximize state so the toggle button can swap glyphs. The
  // listener returns an unlisten fn we must call on cleanup.
  onMount(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        setMaximized(await win.isMaximized());
        unlisten = await win.onResized(() => {
          void win.isMaximized().then(setMaximized);
        });
      } catch {
        // Non-Tauri context (storybook / dev preview) — leave defaults.
      }
    })();
    onCleanup(() => unlisten?.());
  });

  const handleMinimize = (): void => {
    void getCurrentWindow().minimize();
  };
  const handleMaximizeToggle = (): void => {
    void getCurrentWindow().toggleMaximize();
  };
  const handleClose = (): void => {
    void getCurrentWindow().close();
  };

  const heightClass = isMac ? "h-7" : "h-8";
  // macOS traffic lights live in a ~70px area on the left; reserve it so the
  // app title doesn't sit underneath them.
  const leftPad = isMac ? "pl-[78px]" : "pl-3";

  return (
    <div
      class={`ws-titlebar relative flex ${heightClass} w-full shrink-0 select-none items-center border-b border-border/40 bg-canvas text-fg-secondary`}
      data-tauri-drag-region
    >
      <div class={`flex flex-1 items-center ${leftPad}`} data-tauri-drag-region>
        <span class="truncate text-xs font-medium" data-tauri-drag-region>
          {props.title ?? "Work Station"}
        </span>
      </div>

      {/* T12.9 — cross-project notifications bell. Always rendered (Mac
          + Windows + Linux): the bell handles its own gating (no token →
          no badge) and we want it reachable regardless of where the
          window controls live. */}
      <NotificationsBell />

      <Show when={isWindows}>
        <div class="flex h-full items-stretch">
          <button
            type="button"
            class="ws-titlebar__btn"
            aria-label="Minimize"
            onClick={handleMinimize}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5h10" stroke="currentColor" stroke-width="1" />
            </svg>
          </button>
          <button
            type="button"
            class="ws-titlebar__btn"
            aria-label={maximized() ? "Restore" : "Maximize"}
            onClick={handleMaximizeToggle}
          >
            <Show
              when={maximized()}
              fallback={
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect
                    x="0.5"
                    y="0.5"
                    width="9"
                    height="9"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1"
                  />
                </svg>
              }
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect
                  x="2.5"
                  y="0.5"
                  width="7"
                  height="7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1"
                />
                <rect
                  x="0.5"
                  y="2.5"
                  width="7"
                  height="7"
                  fill="var(--bg-canvas, #000)"
                  stroke="currentColor"
                  stroke-width="1"
                />
              </svg>
            </Show>
          </button>
          <button
            type="button"
            class="ws-titlebar__btn ws-titlebar__btn--close"
            aria-label="Close"
            onClick={handleClose}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 0L10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
            </svg>
          </button>
        </div>
      </Show>
    </div>
  );
}

export default TitleBar;
