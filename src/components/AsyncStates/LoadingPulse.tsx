// T11.7 — Inline "working…" pulse for short async waits where a full
// skeleton would be overkill. Three opacity-cycling dots + optional label,
// in the mono UI font. Matches DESIGN_PROMPT_PHASE2.md §1.7.b.

import type { JSX } from "solid-js";

export interface LoadingPulseProps {
  /** Optional label rendered to the left of the dots. */
  label?: string;
  /** When true, fills the parent slot (centered) instead of rendering
   *  inline. Use for pane-mount / tab-body loading. */
  block?: boolean;
}

export function LoadingPulse(props: LoadingPulseProps): JSX.Element {
  return (
    <div
      class={props.block ? "ws-pulse ws-pulse--block" : "ws-pulse"}
      role="status"
      aria-live="polite"
      aria-label={props.label ?? "Loading"}
    >
      {props.label ? <span>{props.label}</span> : null}
      <span class="ws-pulse__dots" aria-hidden="true">
        <span class="ws-pulse__dot" />
        <span class="ws-pulse__dot" />
        <span class="ws-pulse__dot" />
      </span>
    </div>
  );
}

export default LoadingPulse;
