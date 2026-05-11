// T8.6: Custom window chrome.
//
// macOS:   `titleBarStyle: Overlay` in tauri.conf.json keeps the traffic
//          lights overlaid on top of the webview. We render an invisible
//          drag region so the user can grab the empty strip next to the
//          buttons to move the window. The app title and bell live in
//          the sidebar header now — this strip is structural only.
// Windows: `decorations: false` (set via tauri.windows.conf.json) removes
//          all native chrome. We still need the min/max/close buttons,
//          so the strip is taller on Windows + has its own buttons.
// Linux:   Native chrome is kept; the strip collapses to 0 height so
//          there's no double title.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac, isWindows } from "../../utils/platform";

export interface TitleBarProps {
  /** Reserved for future use (e.g. window title in screen-reader text).
   *  No longer rendered visually — the title and notifications bell
   *  live in the sidebar header. */
  title?: string;
}

export function TitleBar(props: TitleBarProps): JSX.Element {
  void props.title;
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

  // Only Mac + Windows need a strip — Mac for the traffic-light overlay
  // (the buttons sit on top of the webview, so we need a draggable empty
  // strip behind them) and Windows for our custom min/max/close buttons.
  // Linux uses native chrome so the strip is suppressed entirely.
  const showStrip = isMac || isWindows;
  const heightClass = isMac ? "h-7" : "h-8";

  return (
    <Show when={showStrip}>
      <div
        class={`ws-titlebar relative flex ${heightClass} w-full shrink-0 select-none items-center bg-canvas`}
        data-tauri-drag-region
      >
        <div class="flex flex-1" data-tauri-drag-region />

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
    </Show>
  );
}

export default TitleBar;
