import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { APP_MENU, dispatchMenuAction, menuShortcut } from "../../menu";

export function WindowsAppMenu(): JSX.Element {
  let root: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);

  onMount(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!open()) return;
      const target = event.target;
      if (target instanceof Node && root?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!open()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <div ref={root} class="ws-win-menu-host">
      <button
        type="button"
        class="ws-win-menu-button"
        aria-label="Application menu"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        ☰
      </button>
      <Show when={open()}>
        <div class="ws-win-menu" role="menu" aria-label="Application menu">
          <For each={APP_MENU}>
            {(section, sectionIndex) => (
              <div class="ws-win-menu__section">
                <div class="ws-win-menu__heading">{section.label}</div>
                <For each={section.items}>
                  {(entry) =>
                    entry === "separator" ? (
                      <div class="ws-win-menu__divider" role="separator" />
                    ) : (
                      <button
                        type="button"
                        class="ws-win-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setOpen(false);
                          dispatchMenuAction(entry.id);
                        }}
                      >
                        <span>{entry.label}</span>
                        <Show when={menuShortcut(entry)}>
                          {(shortcut) => <span class="ws-win-menu__keys">{shortcut()}</span>}
                        </Show>
                      </button>
                    )
                  }
                </For>
                <Show when={sectionIndex() < APP_MENU.length - 1}>
                  <div class="ws-win-menu__divider" role="separator" />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default WindowsAppMenu;
