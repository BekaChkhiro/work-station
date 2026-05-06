// T6.8: Onboarding card shown when no projects exist.
//
// Pure presentational component — the parent owns the "no projects" check
// and wires the CTA back to whatever `onAddProject` flow it uses. Mirrors
// the prototype's empty-state pattern (centred card, swatch tile, headline
// + supporting copy + primary CTA), styled via `.ws-empty__*` classes in
// globals.css.

import type { JSX } from "solid-js";

export interface ProjectsEmptyStateProps {
  /** Fires when the primary CTA is pressed. The parent typically opens
   *  the Add Project modal (T6.5). */
  onAddProject?: () => void;
  /** Optional shortcut hint rendered next to the CTA label (e.g. "⌘N").
   *  Matches the sidebar's `New project` button affordance. */
  shortcut?: string;
}

export function ProjectsEmptyState(props: ProjectsEmptyStateProps): JSX.Element {
  return (
    <div class="ws-empty" role="region" aria-label="Welcome to Work Station">
      <div class="ws-empty__card">
        <div class="ws-empty__glyph" aria-hidden="true">
          <IconFolder />
        </div>
        <div class="ws-empty__copy">
          <h1 class="ws-empty__title">Welcome to Work Station</h1>
          <p class="ws-empty__subtitle">
            You don't have any projects yet. Create your first one to start spawning terminal
            sessions.
          </p>
        </div>
        <button
          type="button"
          class="ws-empty__cta"
          onClick={() => props.onAddProject?.()}
          autofocus
        >
          <span class="ws-empty__cta-icon" aria-hidden="true">
            <IconPlus />
          </span>
          <span>Add your first project</span>
          {props.shortcut ? <kbd class="ws-empty__kbd">{props.shortcut}</kbd> : null}
        </button>
      </div>
    </div>
  );
}

function IconFolder(): JSX.Element {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5 a2 2 0 0 1 2-2 h4.5 l2.5 2.5 h10 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 h-17 a2 2 0 0 1 -2 -2 z" />
    </svg>
  );
}

function IconPlus(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M6 1.5 V10.5 M1.5 6 H10.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

export default ProjectsEmptyState;
