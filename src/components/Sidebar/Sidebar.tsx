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

import { For } from "solid-js";
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
  /** Fires when "New project" is pressed. */
  onAdd?(): void;
  /** Fires when the footer settings cog is pressed. */
  onSettings?(): void;
  /** Fires when the collapse/expand control is pressed. */
  onToggleCollapse?(): void;
  /** Optional hint shown next to the "New project" button (e.g. "⌘N"). */
  newProjectShortcut?: string;
}

const NAV_ID = "ws-sb-nav";

export function Sidebar(props: SidebarProps): JSX.Element {
  const isCollapsed = (): boolean => props.collapsed === true;

  // Native <button> handles Enter via `click`, but Space on a focused button
  // also scrolls the document by default. Suppress that one case so list
  // navigation feels snappy when the host page can scroll.
  const handleRowKey = (e: KeyboardEvent, id: string): void => {
    if (e.key === " ") {
      e.preventDefault();
      props.onActivate?.(id);
    }
  };

  return (
    <nav
      id={NAV_ID}
      class="ws-sb"
      data-collapsed={isCollapsed() ? "true" : undefined}
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

      <ul class="ws-sb__list" role="list">
        <For each={props.projects}>
          {(p) => {
            const isActive = (): boolean => p.id === props.activeId;
            return (
              <li>
                <button
                  type="button"
                  class="ws-sb__row"
                  data-active={isActive() ? "true" : undefined}
                  aria-current={isActive() ? "page" : undefined}
                  aria-label={`Switch to ${p.name}`}
                  title={isCollapsed() ? p.name : undefined}
                  onClick={() => props.onActivate?.(p.id)}
                  onKeyDown={(e) => handleRowKey(e, p.id)}
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
              </li>
            );
          }}
        </For>
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
