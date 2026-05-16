// T6.6: Project row context menu — small floating menu opened from a
// right-click on a sidebar row.
//
// Purely controlled by the parent: state lives outside (typically a
// `{ projectId, x, y } | null` signal), and the menu renders at the
// supplied viewport coordinates with light edge-clamping so it never
// overflows the window. Closes on:
//   • outside click (mousedown anywhere outside the menu)
//   • Escape
//   • selecting an item
// Keyboard: ↑/↓ moves the highlight, Enter activates, Esc closes. The
// rendering parent is responsible for invoking the action (`onSwitch`,
// `onEdit`, `onReveal`, `onDelete`); this component just emits intent.

import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

export interface ProjectContextMenuProps {
  /** When non-null the menu is open at the given viewport coordinates. */
  position: { x: number; y: number } | null;
  /** Close the menu without picking anything. Always called from inside
   *  the menu — outside click, Esc, or after activating an item. */
  onClose: () => void;
  onSwitch: () => void;
  onEdit: () => void;
  onReveal: () => void;
  onDelete: () => void;
  /** Clone the row's metadata (name, default CLI, env, startup commands)
   *  to the paired cloud-agent. Path is left empty so the agent
   *  auto-creates `<projects_root>/<slug>`. */
  onPushToCloud?: () => void;
  /** Optional — when false, the "Reveal in Finder/Explorer" item is
   *  hidden. Useful in harnesses that don't have a real path. */
  canReveal?: boolean;
  /** When true, surface the "Push to cloud" item. The parent gates
   *  this on Local mode + a paired cloud agent so the row only
   *  appears when the action can actually succeed. */
  canPushToCloud?: boolean;
}

const MENU_W = 200;
// Approximate per-item height; only used to clamp the menu inside the
// viewport when opening near the bottom edge. The real height comes from
// CSS — this is a defensive upper bound so the clamp never under-shoots.
const ROW_H = 28;
const PADDING = 8;

type ItemKey = "switch" | "edit" | "reveal" | "push-to-cloud" | "delete";

export function ProjectContextMenu(props: ProjectContextMenuProps): JSX.Element {
  const [highlight, setHighlight] = createSignal<ItemKey>("switch");
  let menuEl: HTMLDivElement | undefined;

  const visibleItems = (): ItemKey[] => {
    const all: ItemKey[] = ["switch", "edit", "reveal", "push-to-cloud", "delete"];
    return all.filter((k) => {
      if (k === "reveal" && props.canReveal === false) return false;
      if (k === "push-to-cloud" && props.canPushToCloud !== true) return false;
      return true;
    });
  };

  // Reset highlight every time the menu re-opens. Otherwise an old
  // highlight value can flash for a frame at the new position.
  createEffect(() => {
    if (props.position) setHighlight("switch");
  });

  // Outside-click + key handling. Capture-phase to win over xterm panes.
  createEffect(() => {
    if (!props.position) return;
    const onDocMouse = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!menuEl || (target && menuEl.contains(target))) return;
      props.onClose();
    };
    const onDocKey = (e: KeyboardEvent): void => {
      const items = visibleItems();
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const idx = items.indexOf(highlight());
        const next = items[(idx + 1) % items.length];
        if (next) setHighlight(next);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const idx = items.indexOf(highlight());
        const next = items[(idx - 1 + items.length) % items.length];
        if (next) setHighlight(next);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        activate(highlight());
      }
    };
    document.addEventListener("mousedown", onDocMouse, { capture: true });
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocMouse, { capture: true });
      document.removeEventListener("keydown", onDocKey, { capture: true });
    });
  });

  const activate = (key: ItemKey): void => {
    switch (key) {
      case "switch":
        props.onSwitch();
        break;
      case "edit":
        props.onEdit();
        break;
      case "reveal":
        props.onReveal();
        break;
      case "push-to-cloud":
        props.onPushToCloud?.();
        break;
      case "delete":
        props.onDelete();
        break;
    }
    props.onClose();
  };

  const clampedPos = (): { left: number; top: number } => {
    const pos = props.position;
    if (!pos) return { left: 0, top: 0 };
    const vw = typeof window !== "undefined" ? window.innerWidth : MENU_W;
    const vh = typeof window !== "undefined" ? window.innerHeight : ROW_H * 4;
    const items = visibleItems();
    const menuH = items.length * ROW_H + PADDING * 2;
    const left = Math.min(pos.x, Math.max(PADDING, vw - MENU_W - PADDING));
    const top = Math.min(pos.y, Math.max(PADDING, vh - menuH - PADDING));
    return { left, top };
  };

  return (
    <Show when={props.position}>
      <div
        ref={menuEl}
        class="ws-pcm"
        role="menu"
        aria-label="Project actions"
        style={{
          left: `${clampedPos().left}px`,
          top: `${clampedPos().top}px`,
          width: `${MENU_W}px`,
        }}
      >
        <ContextItem
          label="Switch to project"
          highlighted={highlight() === "switch"}
          onActivate={() => activate("switch")}
          onHover={() => setHighlight("switch")}
        />
        <ContextItem
          label="Edit…"
          highlighted={highlight() === "edit"}
          onActivate={() => activate("edit")}
          onHover={() => setHighlight("edit")}
        />
        <Show when={props.canReveal !== false}>
          <ContextItem
            label={revealLabel()}
            highlighted={highlight() === "reveal"}
            onActivate={() => activate("reveal")}
            onHover={() => setHighlight("reveal")}
          />
        </Show>
        <Show when={props.canPushToCloud === true}>
          <ContextItem
            label="Push to cloud"
            highlighted={highlight() === "push-to-cloud"}
            onActivate={() => activate("push-to-cloud")}
            onHover={() => setHighlight("push-to-cloud")}
          />
        </Show>
        <div class="ws-pcm__sep" aria-hidden="true" />
        <ContextItem
          label="Delete"
          danger
          highlighted={highlight() === "delete"}
          onActivate={() => activate("delete")}
          onHover={() => setHighlight("delete")}
        />
      </div>
    </Show>
  );
}

interface ContextItemProps {
  label: string;
  danger?: boolean;
  highlighted: boolean;
  onActivate: () => void;
  onHover: () => void;
}

function ContextItem(props: ContextItemProps): JSX.Element {
  return (
    <button
      type="button"
      class="ws-pcm__item"
      data-highlighted={props.highlighted ? "true" : undefined}
      data-danger={props.danger ? "true" : undefined}
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        props.onActivate();
      }}
      onMouseEnter={() => props.onHover()}
    >
      {props.label}
    </button>
  );
}

const revealLabel = (): string => {
  if (typeof navigator === "undefined") return "Reveal in folder";
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return "Reveal in Finder";
  if (/Win/.test(navigator.platform)) return "Reveal in Explorer";
  return "Reveal in folder";
};

export default ProjectContextMenu;
