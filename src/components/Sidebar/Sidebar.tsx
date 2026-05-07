// T6.1: Sidebar — right-side, collapsible project list.
//
// Mirrors the prototype's `.sidebar` (work-station-design/components.jsx +
// styles.css) under the `ws-sb__*` prefix so it can sit beside the
// prototype without colliding. Purely controlled — the parent owns
// `projects`, `activeId`, and `collapsed`; the component emits intent
// (`onActivate`, `onAdd`, `onSettings`, `onToggleCollapse`) and renders.
//
// Collapse: width animates between expanded (default 232px) and a narrow
// icon-only rail. To avoid a flicker at the start of the animation, the
// component does NOT unmount text content when collapsing. Instead, every
// element stays in the DOM and CSS hides the labels in the collapsed
// state, so the panel's width transition carries the visual change end-
// to-end.
//
// T6.6 additions: each row exposes a hover-only pencil icon that fires
// `onEdit(id)`, and right-clicking the row fires `onContextMenu(id, x, y)`
// so the parent can render the project context menu at viewport coords.
// Both are no-ops when their respective callbacks aren't wired so the
// component still reads cleanly in earlier-phase harnesses.
//
// T6.7 additions: a hover-revealed grip handle on the left edge of each
// row drags the project to a new sidebar position. Mirrors the TabStrip
// (T5.3) reorder pattern — pointer events + pointer capture, with an
// insertion bar shown between rows during drag. On pointerup the parent
// receives `onReorder(nextIds)` with the full reordered id list and is
// expected to (a) persist it and (b) update its source-of-truth so the
// next render reflects the new order. The dragged row floats up by 2px
// with a popover shadow during the drag for tactile feedback.

import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

export interface SidebarProject {
  id: string;
  name: string;
  /** Any CSS color — used as the icon swatch background. */
  color: string;
  /** Up to two characters shown in the icon swatch. */
  glyph: string;
  /** Count of currently-running sessions. 0 → muted dash. */
  sessions: number;
}

export interface SidebarProps {
  projects: SidebarProject[];
  /** Active project id; pass `null`/omit to render with no active row. */
  activeId?: string | null;
  /** Controlled collapse state. Defaults to expanded. */
  collapsed?: boolean;
  /** Fires when a project row is activated (click or Enter/Space). */
  onActivate?(id: string): void;
  /** Fires when the inline pencil-icon button is pressed (visible on
   *  hover). The parent typically opens the Edit modal. */
  onEdit?(id: string): void;
  /** Fires when the row is right-clicked. The parent decides whether to
   *  open a context menu and where to anchor it. Coordinates are in
   *  viewport space (clientX / clientY). */
  onContextMenu?(id: string, x: number, y: number): void;
  /** T6.7 — fires on pointerup after a successful drag-to-reorder. The
   *  payload is the full list of project ids in their new order. The
   *  parent owns persistence (DB `position` column) and must update its
   *  state so the next render of `projects` reflects the new order. */
  onReorder?(nextIds: string[]): void;
  /** Fires when "New project" is pressed. */
  onAdd?(): void;
  /** Fires when the footer settings cog is pressed. */
  onSettings?(): void;
  /** Hands the settings cog DOM node back to the parent. The parent uses
   *  the rect of this element to anchor a popover (see `SettingsMenu`). */
  onSettingsAnchor?(el: HTMLButtonElement | null): void;
  /** Fires when the collapse/expand control is pressed. */
  onToggleCollapse?(): void;
  /** Optional hint shown next to the "New project" button (e.g. "⌘N"). */
  newProjectShortcut?: string;
}

interface RowRect {
  id: string;
  top: number;
  bottom: number;
}

interface DragState {
  pointerId: number;
  fromIndex: number;
  startClientY: number;
  /** Row rects in list-container coordinates (top-left of `.ws-sb__list`),
   *  captured at drag start so the math doesn't drift if the list scrolls
   *  mid-drag. */
  rects: RowRect[];
  /** Cumulative pointer delta along Y, in pixels. */
  deltaY: number;
  /** Nullable until the pointer has moved past the slop threshold; lets
   *  click-on-grip stay clickable without triggering a phantom reorder. */
  insertionIndex: number | null;
}

const NAV_ID = "ws-sb-nav";
const DRAG_SLOP_PX = 4;
const DRAG_LIFT_PX = 2;

export function Sidebar(props: SidebarProps): JSX.Element {
  const isCollapsed = (): boolean => props.collapsed === true;

  let listEl!: HTMLUListElement;
  // Row LIs registered via ref callback. Order matches `props.projects`
  // because Solid's `<For>` invokes refs in render order.
  const rowEls = new Map<string, HTMLLIElement>();

  const [drag, setDrag] = createSignal<DragState | null>(null);
  // Set when a drag actually moved past the slop threshold; consulted by
  // the row button's onClick to suppress the synthetic click that follows
  // pointerup. Cleared on the next pointerdown. We can't use `drag()`
  // here — endDrag clears it before the click fires.
  let didDrag = false;

  // Native <button> handles Enter via `click`, but Space on a focused button
  // also scrolls the document by default. Suppress that one case so list
  // navigation feels snappy when the host page can scroll.
  const handleRowKey = (e: KeyboardEvent, id: string): void => {
    if (e.key === " ") {
      e.preventDefault();
      props.onActivate?.(id);
    }
  };

  // Pointer handlers live on the row's <li> rather than the grip span so
  // pointer capture survives the grip unmounting mid-drag (e.g. when
  // `onReorder` becomes undefined or the sidebar collapses). The grip is
  // only the *visual* handle — beginDrag verifies the original target was
  // inside `.ws-sb__grip` so dragging from anywhere else on the row is a
  // no-op.
  const beginDrag = (e: PointerEvent, index: number): void => {
    if (e.button !== 0) return;
    if (!props.onReorder) return;
    if (isCollapsed()) return;
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest(".ws-sb__grip")) return;
    const host = e.currentTarget;
    if (!(host instanceof HTMLElement)) return;

    didDrag = false;

    const containerRect = listEl.getBoundingClientRect();
    const rects: RowRect[] = props.projects.map((p) => {
      const el = rowEls.get(p.id);
      if (!el) return { id: p.id, top: 0, bottom: 0 };
      const r = el.getBoundingClientRect();
      return {
        id: p.id,
        top: r.top - containerRect.top + listEl.scrollTop,
        bottom: r.bottom - containerRect.top + listEl.scrollTop,
      };
    });

    host.setPointerCapture(e.pointerId);
    e.preventDefault();
    setDrag({
      pointerId: e.pointerId,
      fromIndex: index,
      startClientY: e.clientY,
      rects,
      deltaY: 0,
      insertionIndex: null,
    });
  };

  const moveDrag = (e: PointerEvent): void => {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    const deltaY = e.clientY - d.startClientY;
    if (Math.abs(deltaY) < DRAG_SLOP_PX && d.insertionIndex === null) {
      setDrag({ ...d, deltaY });
      return;
    }
    didDrag = true;
    const containerRect = listEl.getBoundingClientRect();
    const pointerInContainer = e.clientY - containerRect.top + listEl.scrollTop;
    const insertionIndex = computeInsertionIndex(d.rects, d.fromIndex, pointerInContainer);
    setDrag({ ...d, deltaY, insertionIndex });
  };

  const endDrag = (e: PointerEvent): void => {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    const host = e.currentTarget;
    if (host instanceof HTMLElement && host.hasPointerCapture(d.pointerId)) {
      host.releasePointerCapture(d.pointerId);
    }
    const insertion = d.insertionIndex;
    setDrag(null);
    if (insertion === null || insertion === d.fromIndex || insertion === d.fromIndex + 1) return;
    const next = reorderIds(props.projects, d.fromIndex, insertion);
    props.onReorder?.(next);
  };

  // Drop the drag signal if the sidebar unmounts mid-drag so a re-mount
  // doesn't pick up phantom drag state. The browser releases pointer
  // capture automatically when the captured element is removed from the
  // DOM, so there's no listener leak to clean up here.
  onCleanup(() => {
    setDrag(null);
  });

  const rowStyle = (index: number): JSX.CSSProperties => {
    const d = drag();
    if (!d || d.fromIndex !== index) return {};
    return {
      transform: `translateY(${d.deltaY - DRAG_LIFT_PX}px)`,
      "z-index": 2,
      "box-shadow": "var(--shadow-popover)",
      "border-radius": "var(--r-md)",
    };
  };

  const indicatorStyle = (): JSX.CSSProperties | null => {
    const d = drag();
    if (!d || d.insertionIndex === null) return null;
    if (d.insertionIndex === d.fromIndex || d.insertionIndex === d.fromIndex + 1) return null;
    const yInContainer = gapCenter(d.rects, d.insertionIndex);
    if (yInContainer === null) return null;
    return { top: `${yInContainer - listEl.scrollTop}px` };
  };

  return (
    <nav
      id={NAV_ID}
      class="ws-sb"
      data-collapsed={isCollapsed() ? "true" : undefined}
      data-dragging={drag() ? "true" : undefined}
      aria-label="Projects"
    >
      <div class="ws-sb__section">
        <span class="ws-sb__section-label">Projects</span>
        <button
          type="button"
          class="ws-sb__icon-btn ws-sb__icon-btn--sm"
          aria-label={isCollapsed() ? "Expand sidebar" : "Collapse sidebar"}
          aria-controls={NAV_ID}
          aria-expanded={isCollapsed() ? "false" : "true"}
          onClick={() => props.onToggleCollapse?.()}
        >
          <IconCollapse size={12} collapsed={isCollapsed()} />
        </button>
      </div>

      <ul ref={listEl} class="ws-sb__list" role="list">
        <For each={props.projects}>
          {(p, index) => {
            const isActive = (): boolean => p.id === props.activeId;
            const isDragging = (): boolean => drag()?.fromIndex === index();
            return (
              <li
                ref={(el) => {
                  rowEls.set(p.id, el);
                  onCleanup(() => {
                    if (rowEls.get(p.id) === el) rowEls.delete(p.id);
                  });
                }}
                class="ws-sb__row-host"
                data-dragging={isDragging() ? "true" : undefined}
                style={rowStyle(index())}
                onPointerDown={(e) => beginDrag(e, index())}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <Show when={props.onReorder && !isCollapsed()}>
                  <span class="ws-sb__grip" title="Drag to reorder" aria-hidden="true">
                    <IconGrip />
                  </span>
                </Show>
                <button
                  type="button"
                  class="ws-sb__row"
                  data-active={isActive() ? "true" : undefined}
                  aria-current={isActive() ? "page" : undefined}
                  aria-label={`Switch to ${p.name}`}
                  title={isCollapsed() ? p.name : undefined}
                  onClick={() => {
                    // Suppress the synthetic click that follows pointerup
                    // when the user actually dragged. didDrag is set in
                    // moveDrag once the slop threshold trips.
                    if (didDrag) {
                      didDrag = false;
                      return;
                    }
                    props.onActivate?.(p.id);
                  }}
                  onKeyDown={(e) => handleRowKey(e, p.id)}
                  onContextMenu={(e) => {
                    if (!props.onContextMenu) return;
                    e.preventDefault();
                    props.onContextMenu(p.id, e.clientX, e.clientY);
                  }}
                >
                  <span class="ws-sb__icon" style={{ background: p.color }} aria-hidden="true">
                    {p.glyph}
                    <span
                      class="ws-sb__live-dot ws-sb__live-dot--corner"
                      data-on={p.sessions > 0 ? "true" : undefined}
                      aria-hidden="true"
                    />
                  </span>
                  <span class="ws-sb__name">{p.name}</span>
                  <span class="ws-sb__meta">
                    {p.sessions > 0 ? (
                      <>
                        <span class="ws-sb__live-dot" aria-hidden="true" />
                        <span class="ws-sb__badge tabular">{p.sessions}</span>
                      </>
                    ) : (
                      <span class="ws-sb__badge ws-sb__badge--idle">—</span>
                    )}
                  </span>
                </button>
                <Show when={props.onEdit && !isCollapsed()}>
                  <button
                    type="button"
                    class="ws-sb__row-edit"
                    aria-label={`Edit ${p.name}`}
                    title="Edit project"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onEdit?.(p.id);
                    }}
                  >
                    <IconPencil size={12} />
                  </button>
                </Show>
              </li>
            );
          }}
        </For>
        <Show when={indicatorStyle()}>
          {(s) => <div class="ws-sb__indicator" aria-hidden="true" style={s()} />}
        </Show>
      </ul>

      <div class="ws-sb__footer">
        <button
          type="button"
          class="ws-sb__add"
          aria-label="New project"
          onClick={() => props.onAdd?.()}
        >
          <span class="ws-sb__add-icon" aria-hidden="true">
            <IconPlus size={12} />
          </span>
          <span class="ws-sb__add-label">New project</span>
          {props.newProjectShortcut ? (
            <kbd class="ws-sb__kbd">{props.newProjectShortcut}</kbd>
          ) : null}
        </button>
        <button
          ref={(el) => props.onSettingsAnchor?.(el)}
          type="button"
          class="ws-sb__icon-btn"
          aria-label="Settings"
          onClick={() => props.onSettings?.()}
        >
          <IconCog size={14} />
        </button>
      </div>
    </nav>
  );
}

function reorderIds(
  projects: SidebarProject[],
  fromIndex: number,
  insertionIndex: number,
): string[] {
  const ids = projects.map((p) => p.id);
  const [moved] = ids.splice(fromIndex, 1);
  if (moved === undefined) return projects.map((p) => p.id);
  const adjusted = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
  ids.splice(adjusted, 0, moved);
  return ids;
}

function computeInsertionIndex(rects: RowRect[], fromIndex: number, pointerY: number): number {
  let bestIndex = fromIndex;
  let bestDist = Infinity;
  for (let i = 0; i <= rects.length; i++) {
    if (i === fromIndex || i === fromIndex + 1) continue;
    const center = gapCenter(rects, i);
    if (center === null) continue;
    const dist = Math.abs(pointerY - center);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function gapCenter(rects: RowRect[], index: number): number | null {
  if (rects.length === 0) return null;
  if (index <= 0) {
    const first = rects[0];
    return first ? first.top : null;
  }
  if (index >= rects.length) {
    const last = rects[rects.length - 1];
    return last ? last.bottom : null;
  }
  const before = rects[index - 1];
  const after = rects[index];
  if (!before || !after) return null;
  return (before.bottom + after.top) / 2;
}

function IconPlus(props: { size?: number }): JSX.Element {
  return (
    <svg width={props.size ?? 12} height={props.size ?? 12} viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M6 1.5 V10.5 M1.5 6 H10.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

function IconCog(props: { size?: number }): JSX.Element {
  return (
    <svg
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="2.2" />
      <path d="M7 1.5 V3 M7 11 V12.5 M1.5 7 H3 M11 7 H12.5 M2.6 2.6 L3.7 3.7 M10.3 10.3 L11.4 11.4 M2.6 11.4 L3.7 10.3 M10.3 3.7 L11.4 2.6" />
    </svg>
  );
}

function IconPencil(props: { size?: number }): JSX.Element {
  return (
    <svg
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8.2 1.6 L10.4 3.8 L4 10.2 L1.5 10.5 L1.8 8 z" />
      <path d="M7.4 2.4 L9.6 4.6" />
    </svg>
  );
}

// 6×6 grip-dots (two columns of three) — matches the sketch in
// PROJECT_PLAN.md T6.7. Pure presentational; the host span carries the
// pointer handlers and the role.
function IconGrip(): JSX.Element {
  return (
    <svg width="6" height="10" viewBox="0 0 6 10" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="1.25" cy="1.5" r="0.9" />
        <circle cx="4.75" cy="1.5" r="0.9" />
        <circle cx="1.25" cy="5" r="0.9" />
        <circle cx="4.75" cy="5" r="0.9" />
        <circle cx="1.25" cy="8.5" r="0.9" />
        <circle cx="4.75" cy="8.5" r="0.9" />
      </g>
    </svg>
  );
}

function IconCollapse(props: { size?: number; collapsed: boolean }): JSX.Element {
  // Chevron points outward when expanded (collapse →), inward when collapsed
  // (expand ←). The component lives on the right side so the directionality
  // matches the panel edge it pulls toward.
  return (
    <svg width={props.size ?? 12} height={props.size ?? 12} viewBox="0 0 12 12" aria-hidden="true">
      <path
        d={props.collapsed ? "M7.5 2 L3 6 L7.5 10" : "M4.5 2 L9 6 L4.5 10"}
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  );
}

export default Sidebar;
