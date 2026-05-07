// Lightweight settings popover anchored to the sidebar's footer cog.
// Currently exposes only theme selection; future surfaces (font, density,
// hotkey rebinds) can slot into the same menu without rewiring AppShell.
//
// The popover positions itself in viewport coordinates from the anchor's
// bounding rect so the parent doesn't have to thread a relative container
// through the Sidebar layout. Outside-click and Escape both close.

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { setThemeMode, themeMode, type ThemeMode } from "../../stores/theme";

export interface SettingsMenuProps {
  open: boolean;
  /** Cog button the menu anchors against. Outside-click ignores events
   *  inside the anchor so the parent's toggle handler stays the source
   *  of truth for open state. */
  anchor: HTMLElement | null;
  onClose: () => void;
}

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

const MENU_WIDTH = 200;
const MENU_GAP = 8;

export function SettingsMenu(props: SettingsMenuProps): JSX.Element {
  let root: HTMLDivElement | undefined;
  const [rect, setRect] = createSignal<DOMRect | null>(null);

  // Recompute the anchor rect whenever the menu opens — between toggles
  // the cog can move (sidebar collapse, font-size change, OS zoom).
  createEffect(() => {
    if (!props.open) {
      setRect(null);
      return;
    }
    setRect(props.anchor?.getBoundingClientRect() ?? null);
  });

  onMount(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!props.open) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root?.contains(target)) return;
      if (props.anchor?.contains(target)) return;
      props.onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!props.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    const onResize = (): void => {
      if (props.open) setRect(props.anchor?.getBoundingClientRect() ?? null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    });
  });

  const positionStyle = (): JSX.CSSProperties => {
    const r = rect();
    if (!r) return {};
    return {
      left: `${Math.max(8, r.right - MENU_WIDTH)}px`,
      bottom: `${Math.max(8, window.innerHeight - r.top + MENU_GAP)}px`,
      width: `${MENU_WIDTH}px`,
    };
  };

  return (
    <Show when={props.open && rect() !== null}>
      <div ref={root} class="ws-settings" role="menu" aria-label="Settings" style={positionStyle()}>
        <div class="ws-settings__head">Theme</div>
        <div class="ws-settings__group" role="radiogroup" aria-label="Theme">
          <For each={THEME_OPTIONS}>
            {(opt) => (
              <button
                type="button"
                class="ws-settings__opt"
                role="radio"
                aria-checked={themeMode() === opt.id}
                data-selected={themeMode() === opt.id ? "true" : undefined}
                onClick={() => setThemeMode(opt.id)}
              >
                {opt.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

export default SettingsMenu;
