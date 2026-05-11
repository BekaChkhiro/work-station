// T11.7 — Failure card for async views.
//
// Sits in the same slot as <SkeletonRows /> / <EmptyState /> when a fetch
// fails. Shows a warning glyph, human-readable headline, optional mono
// detail (raw error message), and Retry / secondary / help-link actions.
// Matches DESIGN_PROMPT_PHASE2.md §1.6.a.

import { Show } from "solid-js";
import type { JSX } from "solid-js";

export interface ErrorCardAction {
  label: string;
  onClick: () => void;
}

export interface ErrorCardHelpLink {
  label: string;
  onClick: () => void;
}

export interface ErrorCardProps {
  title?: string;
  /** User-facing one-line explanation of what went wrong. */
  message: string;
  /** Optional raw error string — rendered in a mono block under the
   *  message. Use for codes / `command not found` lines, not stack traces. */
  detail?: string;
  /** Primary action — typically "Retry". Renders as an accent button. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Optional secondary action — e.g. "Pick another CLI" / "Open settings". */
  secondary?: ErrorCardAction;
  /** Optional subtle link below the buttons — e.g. install instructions. */
  helpLink?: ErrorCardHelpLink;
}

function IconWarning(): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3.5 L17 16 H3 Z" />
      <path d="M10 9 V12" />
      <circle cx="10" cy="14" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ErrorCard(props: ErrorCardProps): JSX.Element {
  return (
    <div class="ws-error-card" role="alert">
      <div class="ws-error-card__inner">
        <div class="ws-error-card__glyph" aria-hidden="true">
          <IconWarning />
        </div>
        <h2 class="ws-error-card__title">{props.title ?? "Something went wrong"}</h2>
        <p class="ws-error-card__message">{props.message}</p>
        <Show when={props.detail}>
          <pre class="ws-error-card__detail">{props.detail}</pre>
        </Show>
        <Show when={props.onRetry || props.secondary}>
          <div class="ws-error-card__actions">
            <Show when={props.onRetry}>
              {(retry) => (
                <button
                  type="button"
                  class="ws-error-card__btn ws-error-card__btn--primary"
                  onClick={() => retry()()}
                >
                  {props.retryLabel ?? "Retry"}
                </button>
              )}
            </Show>
            <Show when={props.secondary}>
              {(action) => (
                <button type="button" class="ws-error-card__btn" onClick={() => action().onClick()}>
                  {action().label}
                </button>
              )}
            </Show>
          </div>
        </Show>
        <Show when={props.helpLink}>
          {(link) => (
            <button type="button" class="ws-error-card__link" onClick={() => link().onClick()}>
              {link().label}
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}

export default ErrorCard;
