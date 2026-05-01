/**
 * SplitPane — draggable split container.
 *
 * Renders two children separated by a drag handle.
 * The split ratio is controlled externally via props.
 * Resize does not remount children (pure CSS flex changes).
 */

import { children as resolveChildren, createSignal, type JSX } from "solid-js";
import type { SplitDirection } from "../types/layout";

export interface SplitPaneProps {
  direction: SplitDirection;
  /** Ratio of the first child's size relative to the total (0–1). */
  ratio: number;
  /** Called while dragging with the updated ratio (clamped 0.05–0.95). */
  onRatioChange?: (ratio: number) => void;
  children: [JSX.Element, JSX.Element] | JSX.Element[];
}

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

export default function SplitPane(props: SplitPaneProps) {
  const [isDragging, setIsDragging] = createSignal(false);
  // eslint-disable-next-line prefer-const
  let containerRef: HTMLDivElement | undefined = undefined;

  const resolved = resolveChildren(() => props.children);

  function firstChild() {
    const r = resolved();
    return Array.isArray(r) ? r[0] : r;
  }

  function secondChild() {
    const r = resolved();
    return Array.isArray(r) ? r[1] : null;
  }

  function startDrag(e: MouseEvent) {
    if (!props.onRatioChange || !containerRef) return;
    e.preventDefault();
    setIsDragging(true);

    const rect = containerRef.getBoundingClientRect();
    const isHorizontal = props.direction === "horizontal";

    function handleMove(moveEvent: MouseEvent) {
      const pos = isHorizontal
        ? moveEvent.clientX - rect.left
        : moveEvent.clientY - rect.top;
      const size = isHorizontal ? rect.width : rect.height;
      const rawRatio = size > 0 ? pos / size : 0.5;
      const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, rawRatio));
      props.onRatioChange!(clamped);
    }

    function handleUp() {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    }

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }

  const flexDir = () => (props.direction === "horizontal" ? "row" : "column");
  const cursor = () => (props.direction === "horizontal" ? "col-resize" : "row-resize");

  const firstSize = () => `${props.ratio}`;
  const secondSize = () => `${1 - props.ratio}`;

  return (
    <div
      ref={containerRef}
      class="flex w-full h-full overflow-hidden select-none"
      style={{ "flex-direction": flexDir() }}
      data-split-dragging={isDragging() || undefined}
    >
      {/* First pane */}
      <div class="relative min-w-0 min-h-0 overflow-hidden" style={{ flex: firstSize() }}>
        {firstChild()}
      </div>

      {/* Drag handle */}
      <div
        class="shrink-0 flex items-center justify-center transition-colors duration-fast"
        classList={{
          "bg-surface-border hover:bg-primary-500": !isDragging(),
        }}
        style={{
          width: props.direction === "horizontal" ? "4px" : undefined,
          height: props.direction === "vertical" ? "4px" : undefined,
          cursor: cursor(),
          "background-color": isDragging() ? "var(--color-primary-500)" : undefined,
        }}
        onMouseDown={startDrag}
        role="separator"
        aria-orientation={props.direction === "horizontal" ? "vertical" : "horizontal"}
      >
        <div
          class="rounded-full transition-colors duration-fast"
          style={{
            width: props.direction === "horizontal" ? "2px" : "12px",
            height: props.direction === "horizontal" ? "12px" : "2px",
            "background-color": isDragging()
              ? "var(--color-primary-400)"
              : "var(--color-neutral-600)",
          }}
        />
      </div>

      {/* Second pane */}
      <div class="relative min-w-0 min-h-0 overflow-hidden" style={{ flex: secondSize() }}>
        {secondChild()}
      </div>
    </div>
  );
}
