/**
 * TabStrip — per-project tab bar for terminal session navigation.
 *
 * Displays a horizontal list of tabs, one per open session/pane.
 * Supports active-state highlighting, close buttons, and drag-to-reorder.
 */

import { createSignal, For, Show } from "solid-js";

export interface TabItem {
  /** Session UUID this tab represents. */
  sessionId: string;
  /** Human-readable label (falls back to truncated id). */
  label?: string;
}

export interface TabStripProps {
  tabs: TabItem[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

export default function TabStrip(props: TabStripProps) {
  const [draggedIndex, setDraggedIndex] = createSignal<number | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = createSignal<number | null>(null);

  function handleDragStart(index: number) {
    setDraggedIndex(index);
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    const dragged = draggedIndex();
    if (dragged === null || dragged === index) {
      setDropIndicatorIndex(null);
      return;
    }

    // Determine whether to drop before or after this tab
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    const before = e.clientX < mid;
    setDropIndicatorIndex(before ? index : index + 1);
  }

  function handleDragLeave() {
    setDropIndicatorIndex(null);
  }

  function handleDrop() {
    const from = draggedIndex();
    const toIndicator = dropIndicatorIndex();
    if (from !== null && toIndicator !== null) {
      // Convert drop-indicator position to target array index
      let to = toIndicator;
      if (to > from) {
        to -= 1;
      }
      if (to !== from) {
        props.onReorder(from, to);
      }
    }
    setDraggedIndex(null);
    setDropIndicatorIndex(null);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
    setDropIndicatorIndex(null);
  }

  function tabLabel(item: TabItem, index: number): string {
    return item.label ?? `Terminal ${index + 1}`;
  }

  return (
    <div
      class="flex h-[var(--tab-height)] items-end gap-0.5 border-b border-surface-border bg-surface-base px-2 select-none"
      role="tablist"
      aria-label="Session tabs"
      onDragLeave={handleDragLeave}
    >
      <For each={props.tabs}>
        {(item, index) => (
          <>
            {/* Drop indicator line (before this tab) */}
            <Show when={dropIndicatorIndex() === index()}>
              <div class="h-5 w-0.5 shrink-0 rounded-full bg-primary-500 animate-pulse" aria-hidden="true" />
            </Show>

            <div
              role="tab"
              aria-selected={props.activeSessionId === item.sessionId}
              draggable
              onDragStart={() => handleDragStart(index())}
              onDragOver={(e) => handleDragOver(e, index())}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              class={`group relative flex h-7 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-3 text-sm transition-colors duration-fast
                ${props.activeSessionId === item.sessionId
                  ? "bg-surface-elevated text-text-accent"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                }
                ${draggedIndex() === index() ? "opacity-40" : ""}
              `}
              onClick={() => props.onSelect(item.sessionId)}
            >
              {/* Tab label */}
              <span class="truncate font-medium">{tabLabel(item, index())}</span>

              {/* Close button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(item.sessionId);
                }}
                class={`shrink-0 rounded-sm p-0.5 text-xs transition-colors duration-fast
                  ${props.activeSessionId === item.sessionId
                    ? "text-text-tertiary hover:text-danger"
                    : "text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger"
                  }
                `}
                aria-label={`Close ${tabLabel(item, index())}`}
                title="Close tab"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M3 3L6 6M6 6L9 3M6 6L3 9M6 6L9 9"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>

              {/* Active indicator bottom border */}
              <Show when={props.activeSessionId === item.sessionId}>
                <div
                  class="absolute bottom-0 left-1 right-1 h-0.5 rounded-t-full bg-primary-500"
                  aria-hidden="true"
                />
              </Show>
            </div>
          </>
        )}
      </For>

      {/* Drop indicator at the very end */}
      <Show when={dropIndicatorIndex() === props.tabs.length}>
        <div class="h-5 w-0.5 shrink-0 rounded-full bg-primary-500 animate-pulse" aria-hidden="true" />
      </Show>
    </div>
  );
}
