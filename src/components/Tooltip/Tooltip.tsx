// T8.4 — Tooltip primitive.
//
// Wraps a single trigger element. After 600ms of hover the tooltip appears
// above the trigger (auto-flips below when there's no room). It hides on
// `mouseleave`, `mousedown`, blur, or Escape so click-throughs don't leave
// a stale chip floating over the new UI.
//
// Positioning is computed in viewport coordinates and the tooltip is
// rendered via <Portal> so parent `overflow: hidden` containers (sidebar,
// pane header) don't clip it. Reduced-motion is handled by tokens.css —
// the @keyframes-driven entrance collapses to 0ms there.

import { Portal } from "solid-js/web";
import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";

export interface TooltipProps {
  /** Tooltip body text. */
  label: string;
  /** Optional keyboard shortcut. Rendered as a chip on the right. */
  shortcut?: string;
  /** Hover delay before showing. Defaults to 600ms per design spec. */
  delay?: number;
  /** Disable rendering entirely (e.g. when a modal is open over the trigger). */
  disabled?: boolean;
  /** The trigger element. Wrapped in an inline span that captures pointer events. */
  children: JSX.Element;
}

type Placement = "top" | "bottom";

const DEFAULT_DELAY = 600;
const GAP = 6;

export function Tooltip(props: TooltipProps): JSX.Element {
  let host: HTMLSpanElement | undefined;
  let tip: HTMLDivElement | undefined;
  let timer: number | undefined;

  const [open, setOpen] = createSignal(false);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const [placement, setPlacement] = createSignal<Placement>("top");
  const [tipSize, setTipSize] = createSignal<{ w: number; h: number } | null>(null);

  const clearTimer = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const close = (): void => {
    clearTimer();
    setOpen(false);
    setRect(null);
    setTipSize(null);
  };

  const scheduleOpen = (): void => {
    if (props.disabled) return;
    clearTimer();
    const delay = props.delay ?? DEFAULT_DELAY;
    timer = window.setTimeout(() => {
      if (!host) return;
      setRect(host.getBoundingClientRect());
      setOpen(true);
    }, delay);
  };

  // Measure the tooltip after it mounts so we can flip when it would
  // overflow the viewport top edge. Run on every open since the label or
  // shortcut may have changed between shows.
  createEffect(() => {
    if (!open()) return;
    const triggerRect = rect();
    if (!triggerRect) return;
    queueMicrotask(() => {
      if (!tip) return;
      const r = tip.getBoundingClientRect();
      setTipSize({ w: r.width, h: r.height });
      const wantTop = triggerRect.top - r.height - GAP;
      setPlacement(wantTop < 8 ? "bottom" : "top");
    });
  });

  // Global listeners — close on viewport changes so the chip never
  // hangs over the wrong spot. `mousedown` here intentionally fires
  // for both clicks on the trigger and clicks elsewhere — the spec
  // calls for "disappears on mousedown".
  createEffect(() => {
    if (!open()) return;
    const onScroll = (): void => close();
    const onMouseDown = (): void => close();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  onCleanup(clearTimer);

  const positionStyle = (): JSX.CSSProperties => {
    const r = rect();
    if (!r) return { visibility: "hidden" };
    const size = tipSize();
    const tipW = size?.w ?? 0;
    const place = placement();
    const top = place === "top" ? r.top - (size?.h ?? 0) - GAP : r.bottom + GAP;
    let left = r.left + r.width / 2 - tipW / 2;
    // Clamp to viewport with an 8px safe inset.
    const maxLeft = window.innerWidth - tipW - 8;
    if (left < 8) left = 8;
    else if (left > maxLeft) left = Math.max(8, maxLeft);
    return {
      position: "fixed",
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      visibility: size ? "visible" : "hidden",
    };
  };

  return (
    <span
      ref={host}
      class="ws-tooltip-host"
      onMouseEnter={scheduleOpen}
      onMouseLeave={close}
      onFocusIn={scheduleOpen}
      onFocusOut={close}
    >
      {props.children}
      <Show when={open() && !props.disabled}>
        <Portal>
          <div
            ref={tip}
            class="ws-tooltip"
            data-placement={placement()}
            role="tooltip"
            style={positionStyle()}
          >
            <span class="ws-tooltip__label">{props.label}</span>
            <Show when={props.shortcut}>
              {(shortcut) => <kbd class="ws-tooltip__kbd">{shortcut()}</kbd>}
            </Show>
          </div>
        </Portal>
      </Show>
    </span>
  );
}

export default Tooltip;
