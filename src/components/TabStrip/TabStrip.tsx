// T5.3: TabStrip — horizontal, scrollable strip of tabs per project.
//
// The component is purely controlled: the parent owns `tabs`, `activeId`,
// and the close-confirmation flow for dirty tabs. The strip emits intent
// events (`onActivate`, `onClose`, `onAdd`, `onReorder`) and renders the
// state passed to it. This keeps the persistence layer (T5.8 layout_json)
// and the CLI registry (T7.4) separable.
//
// Reorder is implemented with pointer events rather than HTML5 drag-and-
// drop:
//   • DnD's default ghost is OS-styled and stamps an opaque snapshot of
//     the tab onto the cursor, which clashes with the dark UI.
//   • Pointer capture lets us keep the dragged tab attached to the cursor
//     via `transform: translateX(...)` and surface a thin insertion bar
//     that snaps between tab centers — closer to native macOS tabs.
//   • No external dep. PROJECT_PLAN T5.3 says "dnd-kit or similar" but
//     dnd-kit is React-only, and Solid's DnD libs are immature.
//
// Insertion math: on drag start we snapshot every tab's left/right rect;
// during drag we walk those rects and pick the gap whose center is
// closest to the pointer. The dragged tab itself is excluded so it can't
// snap onto its own slot. On pointerup we reorder the array and emit.
//
// Overflow: the scroll container hides scrollbars and a 24px gradient
// mask at the right edge cues that more tabs are off-screen. The "+"
// button is rendered AFTER the scrollable region so it always stays
// visible regardless of overflow.

import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Tooltip } from "../Tooltip";
import type { CliMeta, Tab } from "../../types/tab";

export interface TabStripProps {
  tabs: Tab[];
  /** Active tab id; pass `null` to render with no active tab. */
  activeId?: string | null;
  /** CLI key → badge metadata. Missing entries fall back to "··". */
  cliMap?: Record<string, CliMeta>;
  onActivate(id: string): void;
  /** Close button click. Parent decides whether to confirm dirty tabs. */
  onClose?(id: string): void;
  /** Trailing "+" button click. Hidden when omitted. */
  onAdd?(): void;
  /** Fires on drag end with the reordered tab list. No-op if order didn't change. */
  onReorder?(next: Tab[]): void;
  /** Override the trailing "+" button's accessible name. */
  addAriaLabel?: string;
}

interface TabRect {
  id: string;
  left: number;
  right: number;
}

interface DragState {
  pointerId: number;
  fromIndex: number;
  startClientX: number;
  rects: TabRect[];
  /** Container's current scrollLeft at drag start; used for translateX math. */
  scrollLeftAtStart: number;
  /** Cumulative pointer delta in container-coordinate space. */
  deltaX: number;
  /** Nullable so we can render an indicator only after the pointer moved past
   *  the slop threshold; first-click should not trigger reorder UI. */
  insertionIndex: number | null;
}

const FALLBACK_BADGE: CliMeta = { badge: "··" };
const DRAG_SLOP_PX = 4;

export function TabStrip(props: TabStripProps) {
  let scrollEl!: HTMLDivElement;
  // Tab elements registered via ref callback. Order matches `props.tabs`
  // because Solid's `<For>` invokes refs in render order.
  const tabEls = new Map<string, HTMLDivElement>();

  const [drag, setDrag] = createSignal<DragState | null>(null);

  const cliFor = (key: string | undefined): CliMeta =>
    (key && props.cliMap?.[key]) || FALLBACK_BADGE;

  const beginDrag = (e: PointerEvent, index: number): void => {
    if (e.button !== 0) return;
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    // Only start a drag from the tab body — close button has its own handler
    // that calls stopPropagation, but be defensive.
    if (e.target instanceof HTMLElement && e.target.closest(".ws-tabstrip__close")) return;

    const containerRect = scrollEl.getBoundingClientRect();
    const rects: TabRect[] = props.tabs.map((t) => {
      const el = tabEls.get(t.id);
      if (!el) return { id: t.id, left: 0, right: 0 };
      const r = el.getBoundingClientRect();
      // Translate to container coordinates so scroll changes don't shift math.
      return {
        id: t.id,
        left: r.left - containerRect.left + scrollEl.scrollLeft,
        right: r.right - containerRect.left + scrollEl.scrollLeft,
      };
    });

    target.setPointerCapture(e.pointerId);
    setDrag({
      pointerId: e.pointerId,
      fromIndex: index,
      startClientX: e.clientX,
      rects,
      scrollLeftAtStart: scrollEl.scrollLeft,
      deltaX: 0,
      insertionIndex: null,
    });
  };

  const moveDrag = (e: PointerEvent): void => {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    const deltaX = e.clientX - d.startClientX;
    // Hold off until the pointer has moved past slop — eats the small jitter
    // that would otherwise interpret a click as a reorder.
    if (Math.abs(deltaX) < DRAG_SLOP_PX && d.insertionIndex === null) {
      setDrag({ ...d, deltaX });
      return;
    }
    const containerRect = scrollEl.getBoundingClientRect();
    const pointerInContainer = e.clientX - containerRect.left + scrollEl.scrollLeft;
    const insertionIndex = computeInsertionIndex(d.rects, d.fromIndex, pointerInContainer);
    setDrag({ ...d, deltaX, insertionIndex });
  };

  const endDrag = (e: PointerEvent): void => {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    const target = e.currentTarget;
    if (target instanceof HTMLElement && target.hasPointerCapture(d.pointerId)) {
      target.releasePointerCapture(d.pointerId);
    }
    const insertion = d.insertionIndex;
    setDrag(null);
    if (insertion === null || insertion === d.fromIndex || insertion === d.fromIndex + 1) return;
    const next = reorderTabs(props.tabs, d.fromIndex, insertion);
    props.onReorder?.(next);
  };

  // Defensive cleanup: if the strip unmounts mid-drag (route change), drop
  // pointer capture so the parent doesn't leak event listeners.
  onCleanup(() => {
    setDrag(null);
  });

  const tabStyle = (index: number): JSX.CSSProperties => {
    const d = drag();
    if (!d) return {};
    if (index === d.fromIndex) {
      return {
        transform: `translateX(${d.deltaX}px)`,
        "z-index": 2,
        opacity: 0.92,
        cursor: "grabbing",
      };
    }
    return {};
  };

  const indicatorStyle = (): JSX.CSSProperties | null => {
    const d = drag();
    if (!d || d.insertionIndex === null) return null;
    if (d.insertionIndex === d.fromIndex || d.insertionIndex === d.fromIndex + 1) return null;
    const idx = d.insertionIndex;
    const xInContainer = gapCenter(d.rects, idx);
    if (xInContainer === null) return null;
    // Pull the line back into viewport coordinates: container-relative x
    // minus the live scrollLeft. This keeps it correct if the container
    // scrolls during a drag (we don't auto-scroll yet, but cheap to be safe).
    const x = xInContainer - scrollEl.scrollLeft;
    return {
      left: `${x}px`,
    };
  };

  const handleTabKey = (e: KeyboardEvent, tab: Tab): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onActivate(tab.id);
    }
  };

  return (
    <div class="ws-tabstrip" role="tablist" aria-orientation="horizontal">
      <div ref={scrollEl} class="ws-tabstrip__scroll">
        <For each={props.tabs}>
          {(tab, index) => {
            const cli = (): CliMeta => cliFor(tab.cli);
            const isActive = (): boolean => props.activeId === tab.id;
            const isDragging = (): boolean => drag()?.fromIndex === index();
            return (
              <div
                ref={(el) => {
                  tabEls.set(tab.id, el);
                  onCleanup(() => {
                    if (tabEls.get(tab.id) === el) tabEls.delete(tab.id);
                  });
                }}
                class="ws-tabstrip__tab"
                role="tab"
                tabindex={0}
                aria-selected={isActive()}
                data-active={isActive() ? "true" : undefined}
                data-dirty={tab.dirty ? "true" : undefined}
                data-dragging={isDragging() ? "true" : undefined}
                style={tabStyle(index())}
                onPointerDown={(e) => beginDrag(e, index())}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onClick={(e) => {
                  // Suppress the click that follows a drag-induced reorder.
                  if (drag() !== null) {
                    e.preventDefault();
                    return;
                  }
                  props.onActivate(tab.id);
                }}
                onKeyDown={(e) => handleTabKey(e, tab)}
              >
                <span
                  class="ws-tabstrip__icon"
                  style={!isActive() && cli().color ? { color: cli().color } : undefined}
                  aria-hidden="true"
                >
                  {cli().badge}
                </span>
                <span class="ws-tabstrip__label">{tab.label}</span>
                <Show when={tab.dirty}>
                  <span class="ws-tabstrip__dirty" aria-label="Process running" />
                </Show>
                <Show when={props.onClose}>
                  <Tooltip label="Close tab">
                    <button
                      type="button"
                      class="ws-tabstrip__close"
                      aria-label={`Close ${tab.label}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onClose?.(tab.id);
                      }}
                    >
                      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                        <path
                          d="M1 1 L8 8 M8 1 L1 8"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </Tooltip>
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={indicatorStyle()}>
          {(s) => <div class="ws-tabstrip__indicator" aria-hidden="true" style={s()} />}
        </Show>
      </div>
      <div class="ws-tabstrip__overflow-mask" aria-hidden="true" />
      <Show when={props.onAdd}>
        <Tooltip label={props.addAriaLabel ?? "New tab"}>
          <button
            type="button"
            class="ws-tabstrip__new"
            aria-label={props.addAriaLabel ?? "New tab"}
            onClick={() => props.onAdd?.()}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
              <path
                d="M6.5 2 V11 M2 6.5 H11"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </Tooltip>
      </Show>
    </div>
  );
}

// Split for clarity — pure function so it can be eyeballed without React state.
function reorderTabs(tabs: Tab[], fromIndex: number, insertionIndex: number): Tab[] {
  const next = tabs.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return tabs;
  // Adjust the insertion index when removing the source shifts later items
  // left by one. Math: if the source sat before the insertion, every later
  // index drops by 1.
  const adjusted = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
  next.splice(adjusted, 0, moved);
  return next;
}

function computeInsertionIndex(rects: TabRect[], fromIndex: number, pointerX: number): number {
  // Walk gaps and pick the one whose center is nearest the pointer. Skip
  // gaps that flank only the dragged tab (those map to "no move" anyway
  // and would create a flickering indicator at the source slot).
  let bestIndex = fromIndex;
  let bestDist = Infinity;
  for (let i = 0; i <= rects.length; i++) {
    if (i === fromIndex || i === fromIndex + 1) continue;
    const center = gapCenter(rects, i);
    if (center === null) continue;
    const dist = Math.abs(pointerX - center);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// Returns the x-coordinate (in container space) of the gap at `index` —
// where index 0 is the left edge of the first tab, `rects.length` is the
// right edge of the last, and intermediate values are midway between two
// adjacent tabs. Returns null if the rects array is empty or index points
// at a missing tab (defensive — shouldn't happen during a valid drag).
function gapCenter(rects: TabRect[], index: number): number | null {
  if (rects.length === 0) return null;
  if (index <= 0) {
    const first = rects[0];
    return first ? first.left : null;
  }
  if (index >= rects.length) {
    const last = rects[rects.length - 1];
    return last ? last.right : null;
  }
  const before = rects[index - 1];
  const after = rects[index];
  if (!before || !after) return null;
  return (before.right + after.left) / 2;
}

export default TabStrip;
