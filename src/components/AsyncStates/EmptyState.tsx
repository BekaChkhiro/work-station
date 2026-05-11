// T11.7 — Canonical empty state for async views.
//
// Used wherever a slot has loaded but has nothing to show — "no projects
// yet", "PlanFlow not connected", "no deployments". The same component
// powers both the prominent welcome card (accent CTA) and the muted
// "connect via Settings" card by toggling the `variant` prop. Mirrors
// DESIGN_PROMPT.md §P0 #1 and DESIGN_PROMPT_PHASE2.md §1.7.

import { Show } from "solid-js";
import type { JSX } from "solid-js";

export type EmptyStateVariant = "primary" | "muted";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** Optional shortcut hint rendered as a `<kbd>` chip next to the label.
   *  Only honoured by the primary CTA — secondary actions stay text-only. */
  shortcut?: string;
  /** Optional leading icon rendered inside the CTA. The component supplies
   *  a 14×14 slot; pass a `<svg>` sized to fit. */
  icon?: JSX.Element;
  /** Focus the CTA on mount. Useful for first-run onboarding cards. */
  autofocus?: boolean;
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Decorative glyph rendered above the title. The component supplies the
   *  64×56px tile chrome; pass an SVG sized ~28px. Omit for a chrome-free
   *  card. */
  glyph?: JSX.Element;
  primaryAction?: EmptyStateAction;
  secondaryAction?: Omit<EmptyStateAction, "shortcut">;
  /** `primary` (default) uses the accent CTA on a full-canvas card —
   *  matches the prototype welcome screen. `muted` swaps the CTA for a
   *  ghost button so the card reads as a non-blocking nudge rather than
   *  the main thing on screen. */
  variant?: EmptyStateVariant;
  /** Accessible label for the surrounding region. Defaults to the title. */
  ariaLabel?: string;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const variant = (): EmptyStateVariant => props.variant ?? "primary";

  return (
    <div
      class="ws-empty"
      data-variant={variant()}
      role="region"
      aria-label={props.ariaLabel ?? props.title}
    >
      <div class="ws-empty__card">
        <Show when={props.glyph}>
          <div class="ws-empty__glyph" aria-hidden="true">
            {props.glyph}
          </div>
        </Show>
        <div class="ws-empty__copy">
          <h2 class="ws-empty__title">{props.title}</h2>
          <Show when={props.description}>
            <p class="ws-empty__subtitle">{props.description}</p>
          </Show>
        </div>
        <Show when={props.primaryAction}>
          {(action) => (
            <button
              type="button"
              class="ws-empty__cta"
              onClick={() => action().onClick()}
              autofocus={action().autofocus}
            >
              <Show when={action().icon}>
                <span class="ws-empty__cta-icon" aria-hidden="true">
                  {action().icon}
                </span>
              </Show>
              <span>{action().label}</span>
              <Show when={action().shortcut}>
                <kbd class="ws-empty__kbd">{action().shortcut}</kbd>
              </Show>
            </button>
          )}
        </Show>
        <Show when={props.secondaryAction}>
          {(action) => (
            <button type="button" class="ws-error-card__link" onClick={() => action().onClick()}>
              {action().label}
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}

export default EmptyState;
