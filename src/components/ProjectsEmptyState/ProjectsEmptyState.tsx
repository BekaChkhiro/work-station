// T6.8: Onboarding card shown when no projects exist.
//
// Thin wrapper around the shared <EmptyState /> primitive (T11.7) that
// fixes the copy + glyph for the "no projects yet" case. The parent owns
// the "is empty" check and the CTA handler — typically the Add Project
// modal.

import type { JSX } from "solid-js";
import { EmptyState } from "../AsyncStates";

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
    <EmptyState
      ariaLabel="Welcome to Work Station"
      title="Welcome to Work Station"
      description="You don't have any projects yet. Create your first one to start spawning terminal sessions."
      glyph={<IconFolder />}
      primaryAction={
        props.onAddProject
          ? {
              label: "Add your first project",
              onClick: () => props.onAddProject?.(),
              shortcut: props.shortcut,
              icon: <IconPlus />,
              autofocus: true,
            }
          : undefined
      }
    />
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

export default ProjectsEmptyState;
