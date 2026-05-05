// T5.2: SplitPane — two children separated by a draggable handle.
//
// The renderer (T5.4) maps each `SplitNode` from the LayoutNode tree (T5.1)
// to one of these. Two invariants come straight from the task spec:
//
//   1. Drag does NOT remount the children. A drag is a CSS-grid layout
//      change at most — children stay in the same DOM nodes the whole time
//      so xterm + WebGL state isn't torn down on every pixel of motion.
//
//   2. PTY does not resize until drag end. xterm's ResizeObserver fires on
//      every clientWidth change, and `applyFit` issues `pty_resize` for
//      each new cell grid. To avoid that storm during drag, we keep the
//      committed `ratio` (and therefore the children's box sizes) frozen
//      while the pointer is down and only display a translucent "ghost"
//      handle at the cursor. The new ratio is committed on pointerup,
//      which is the single ResizeObserver fire — and so the single
//      `pty_resize` round-trip — that the spec allows.
//
// Keyboard support (Arrow / Home / End on the handle) commits immediately;
// there is no drag-end concept for a single keystroke.
//
// Direction convention follows tmux:
//   'h' → children side by side, vertical separator between them.
//   'v' → children stacked top/bottom, horizontal separator.

import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { SplitDirection } from "../../types/layout";

const DEFAULT_MIN_SIZE_PX = 100;
const HANDLE_SIZE_PX = 6;
// Pixel slack around 50% that snaps the released handle to a perfect halve.
// Picked at ~24px so a casual drag near center commits to 0.5 without the
// user having to land within sub-pixel precision; tighter than this feels
// like the snap fails too often, looser hijacks deliberate off-center drops.
const SNAP_THRESHOLD_PX = 24;
const SNAP_RATIO = 0.5;
// Keyboard nudge step. 5% per keypress — small enough for fine control,
// large enough that holding ArrowRight crosses the pane in <1s.
const KEYBOARD_STEP = 0.05;

export interface SplitPaneProps {
  direction: SplitDirection;
  /** Controlled split ratio in [0, 1]. The first child takes `ratio` of the
   *  available space; the second takes `1 - ratio`. */
  ratio: number;
  /** Fired with the new ratio at drag end (snapped + clamped) or on each
   *  keyboard adjustment. Parents are responsible for persisting via T5.8. */
  onRatioChange?: (ratio: number) => void;
  /** Per-child minimum size in pixels. Defaults to 100. */
  minSize?: number;
  first: JSX.Element;
  second: JSX.Element;
  /** Override the separator's accessible name. Defaults to "Resize panes". */
  handleAriaLabel?: string;
}

interface DragState {
  pointerId: number;
  startCoord: number;
  containerSize: number;
  startRatio: number;
}

export function SplitPane(props: SplitPaneProps) {
  let containerEl!: HTMLDivElement;
  let handleEl!: HTMLDivElement;

  const [dragging, setDragging] = createSignal(false);
  // Pixel offset of the ghost handle from its committed position. Lives in
  // a signal so the ghost overlay re-renders during drag without touching
  // the committed ratio (which would resize the children).
  const [ghostOffsetPx, setGhostOffsetPx] = createSignal(0);

  let dragState: DragState | null = null;

  const isHorizontal = (): boolean => props.direction === "h";
  const minSize = (): number => props.minSize ?? DEFAULT_MIN_SIZE_PX;

  const containerSize = (): number =>
    isHorizontal() ? containerEl.clientWidth : containerEl.clientHeight;

  const getCoord = (e: PointerEvent): number => (isHorizontal() ? e.clientX : e.clientY);

  // Clamp a ratio so neither child shrinks below `minSize`. When the
  // container is too small to honour both minimums we fall back to 0.5 —
  // arbitrary but predictable, and the parent layout is the one to fix
  // (e.g. by collapsing a pane).
  const clampRatio = (r: number, total: number): number => {
    const min = minSize();
    if (total <= 2 * min + HANDLE_SIZE_PX) return SNAP_RATIO;
    const minRatio = min / total;
    const maxRatio = 1 - min / total;
    if (r < minRatio) return minRatio;
    if (r > maxRatio) return maxRatio;
    return r;
  };

  const beginDrag = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const total = containerSize();
    if (total <= 0) return;
    dragState = {
      pointerId: e.pointerId,
      startCoord: getCoord(e),
      containerSize: total,
      startRatio: props.ratio,
    };
    handleEl.setPointerCapture(e.pointerId);
    setGhostOffsetPx(0);
    setDragging(true);
  };

  const updateGhost = (e: PointerEvent): void => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const delta = getCoord(e) - dragState.startCoord;
    const total = dragState.containerSize;
    const startPx = dragState.startRatio * total;
    const min = minSize();
    // Clamp the visual handle so the ghost can't be dragged into either
    // pane's min-size band — stops the user from dropping somewhere we'd
    // immediately bounce out of via clampRatio.
    const nextPx = Math.max(min, Math.min(total - min, startPx + delta));
    setGhostOffsetPx(nextPx - startPx);
  };

  const endDrag = (e: PointerEvent): void => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const total = dragState.containerSize;
    const startPx = dragState.startRatio * total;
    const finalPx = startPx + ghostOffsetPx();
    let nextRatio = finalPx / total;
    // Snap-to-50% when released near center. The threshold is in pixels so
    // the feel stays consistent across container sizes — a 24px slack is
    // about the same physical distance whether the pane is 600px or 1800px.
    if (Math.abs(finalPx - total / 2) <= SNAP_THRESHOLD_PX) {
      nextRatio = SNAP_RATIO;
    }
    nextRatio = clampRatio(nextRatio, total);

    if (handleEl.hasPointerCapture(dragState.pointerId)) {
      handleEl.releasePointerCapture(dragState.pointerId);
    }
    dragState = null;
    setDragging(false);
    setGhostOffsetPx(0);

    if (nextRatio !== props.ratio) props.onRatioChange?.(nextRatio);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const horizontal = isHorizontal();
    let delta = 0;
    if (horizontal && e.key === "ArrowLeft") delta = -KEYBOARD_STEP;
    else if (horizontal && e.key === "ArrowRight") delta = KEYBOARD_STEP;
    else if (!horizontal && e.key === "ArrowUp") delta = -KEYBOARD_STEP;
    else if (!horizontal && e.key === "ArrowDown") delta = KEYBOARD_STEP;
    else if (e.key === "Home") {
      e.preventDefault();
      const total = containerSize();
      if (total > 0) props.onRatioChange?.(clampRatio(0, total));
      return;
    } else if (e.key === "End") {
      e.preventDefault();
      const total = containerSize();
      if (total > 0) props.onRatioChange?.(clampRatio(1, total));
      return;
    } else {
      return;
    }
    e.preventDefault();
    const total = containerSize();
    if (total <= 0) return;
    const next = clampRatio(props.ratio + delta, total);
    if (next !== props.ratio) props.onRatioChange?.(next);
  };

  const gridStyle = (): JSX.CSSProperties => {
    const tracks = `minmax(0, ${props.ratio}fr) ${HANDLE_SIZE_PX}px minmax(0, ${1 - props.ratio}fr)`;
    return isHorizontal()
      ? { "grid-template-columns": tracks, "grid-template-rows": "1fr" }
      : { "grid-template-columns": "1fr", "grid-template-rows": tracks };
  };

  // Ghost handle position during drag: anchored at the committed ratio,
  // displaced by the live ghostOffsetPx. Calc keeps it correct even if the
  // container resizes mid-drag (it shouldn't, but cheaper to stay robust).
  const ghostStyle = (): JSX.CSSProperties => {
    const offset = `calc(${props.ratio * 100}% + ${ghostOffsetPx()}px - ${HANDLE_SIZE_PX / 2}px)`;
    return isHorizontal()
      ? { top: 0, bottom: 0, left: offset, width: `${HANDLE_SIZE_PX}px` }
      : { left: 0, right: 0, top: offset, height: `${HANDLE_SIZE_PX}px` };
  };

  return (
    <div
      ref={containerEl}
      class="ws-split-pane"
      data-direction={props.direction}
      data-dragging={dragging() ? "true" : undefined}
      style={{
        display: "grid",
        position: "relative",
        height: "100%",
        width: "100%",
        "min-width": 0,
        "min-height": 0,
        ...gridStyle(),
      }}
    >
      <div
        class="ws-split-pane__child ws-split-pane__child--first"
        style={{ "min-width": 0, "min-height": 0, overflow: "hidden" }}
      >
        {props.first}
      </div>
      <div
        ref={handleEl}
        role="separator"
        aria-orientation={isHorizontal() ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(props.ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={props.handleAriaLabel ?? "Resize panes"}
        tabindex={0}
        class="ws-split-pane__handle"
        data-orientation={isHorizontal() ? "vertical" : "horizontal"}
        onPointerDown={beginDrag}
        onPointerMove={updateGhost}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        style={{
          cursor: isHorizontal() ? "col-resize" : "row-resize",
          "user-select": "none",
          "touch-action": "none",
          "background-color": "var(--border-default)",
          transition: "background-color var(--dur-fast, 100ms) var(--ease, ease)",
        }}
      />
      <div
        class="ws-split-pane__child ws-split-pane__child--second"
        style={{ "min-width": 0, "min-height": 0, overflow: "hidden" }}
      >
        {props.second}
      </div>
      <Show when={dragging()}>
        <div
          aria-hidden="true"
          class="ws-split-pane__ghost"
          style={{
            position: "absolute",
            "pointer-events": "none",
            "background-color": "var(--accent, currentColor)",
            opacity: 0.55,
            ...ghostStyle(),
          }}
        />
      </Show>
    </div>
  );
}

export default SplitPane;
