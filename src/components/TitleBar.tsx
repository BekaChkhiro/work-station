import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWindows } from "../utils/platform";

/**
 * Custom window title bar for platforms without native decorations.
 *
 * Currently renders on Windows only (macOS uses Tauri's transparent
 * title-bar style with inset traffic lights).
 *
 * The left portion is draggable via data-tauri-drag-region.
 * Window controls are on the right.
 */
export default function TitleBar() {
  const [isMaximized, setIsMaximized] = createSignal(false);
  const win = getCurrentWindow();

  async function updateMaximized() {
    try {
      setIsMaximized(await win.isMaximized());
    } catch {
      // Ignore when running outside Tauri (e.g. vite dev in browser).
    }
  }

  onMount(() => {
    if (!isWindows()) return;
    updateMaximized();
    let unlisten: (() => void) | undefined;
    win.onResized(() => updateMaximized()).then((fn) => {
      unlisten = fn;
    });
    onCleanup(() => unlisten?.());
  });

  return (
    <Show when={isWindows()}>
      <div class="flex items-center justify-between h-[var(--titlebar-height)] bg-surface-elevated border-b border-surface-border select-none shrink-0">
        {/* Draggable title area */}
        <div class="flex-1 flex items-center px-3 h-full" data-tauri-drag-region>
          <span class="text-sm font-medium text-text-secondary">Work Station</span>
        </div>

        {/* Window controls */}
        <div class="flex items-center h-full">
          <TitleBarButton onClick={() => win.minimize().catch(() => {})} title="Minimize">
            <svg width="10" height="1" viewBox="0 0 10 1" class="fill-current">
              <rect width="10" height="1" />
            </svg>
          </TitleBarButton>

          <TitleBarButton
            onClick={() => win.toggleMaximize().catch(() => {})}
            title={isMaximized() ? "Restore" : "Maximize"}
          >
            {isMaximized() ? (
              <svg width="10" height="10" viewBox="0 0 10 10" class="fill-none stroke-current" stroke-width="1">
                <rect x="1" y="2" width="7" height="7" />
                <polyline points="3,2 3,0 10,0 10,7 8,7" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" class="fill-none stroke-current" stroke-width="1">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            )}
          </TitleBarButton>

          <TitleBarButton
            onClick={() => win.close().catch(() => {})}
            title="Close"
            class="hover:bg-danger hover:text-white"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" class="fill-none stroke-current" stroke-width="1.2">
              <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
              <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
            </svg>
          </TitleBarButton>
        </div>
      </div>
    </Show>
  );
}

function TitleBarButton(props: {
  onClick: () => void;
  title: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      title={props.title}
      class={`inline-flex items-center justify-center w-[46px] h-full text-text-tertiary transition-colors duration-fast ${props.class ?? "hover:bg-surface-hover hover:text-text-primary"}`}
    >
      {props.children}
    </button>
  );
}
