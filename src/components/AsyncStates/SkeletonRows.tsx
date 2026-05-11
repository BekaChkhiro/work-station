// T11.7 — Shimmering placeholder rows shown while a list-y async view is
// loading. Matches DESIGN_PROMPT_PHASE2.md §1.7.a (sidebar / list shell).
//
// The shimmer animation collapses to a static dimmed bar under
// `prefers-reduced-motion` (handled in globals.css).

import { For } from "solid-js";
import type { JSX } from "solid-js";

export interface SkeletonRowsProps {
  /** Number of placeholder rows to render. Defaults to 5 — the sidebar
   *  shell size used by the prototype tweaks panel. */
  rows?: number;
  /** Accessible label for the busy region. Screen readers also pick up the
   *  `aria-busy` flag we set on the wrapper. */
  ariaLabel?: string;
}

export function SkeletonRows(props: SkeletonRowsProps): JSX.Element {
  const count = (): number => Math.max(1, props.rows ?? 5);
  return (
    <div
      class="ws-skel"
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={props.ariaLabel ?? "Loading"}
    >
      <For each={Array.from({ length: count() })}>
        {() => (
          <div class="ws-skel__row">
            <span class="ws-skel__shape ws-skel__icon" />
            <span class="ws-skel__shape ws-skel__line" />
            <span class="ws-skel__shape ws-skel__line ws-skel__line--short" />
            <span class="ws-skel__shape ws-skel__dot" />
          </div>
        )}
      </For>
    </div>
  );
}

export default SkeletonRows;
