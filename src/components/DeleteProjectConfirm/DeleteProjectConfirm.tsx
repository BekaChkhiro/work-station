// T6.6: Delete project confirm — small destructive dialog stacked on top
// of the Edit modal.
//
// The 500ms safety delay is the load-bearing piece of the acceptance:
// "Enter within first 500ms of confirm modal does not delete." We model it
// with three pieces of state:
//   • `armed` flips true after the delay elapses; until then the Delete
//     button is disabled and the keyboard Enter shortcut is a no-op.
//   • A `--ws-dpc-progress` CSS custom property animates 0 → 1 over the
//     same window, driving the visual progress fill on the button.
//   • `submitting` flips true once the user clicks Delete and the parent's
//     async handler is in flight, keeping Cancel/Delete disabled until
//     the parent closes the modal.
//
// Closing & re-opening the modal restarts the safety delay so a careless
// user can't scrub the modal open repeatedly to bypass it.

import { Show, batch, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

export interface DeleteProjectConfirmProps {
  open: boolean;
  /** Display name of the project being deleted. */
  projectName: string;
  /** Number of currently-running PTY sessions inside the project. Drives
   *  the warning copy: 0 → "no running sessions", N → "N running … will
   *  be killed." */
  runningSessions: number;
  /** Cancel — also fires on Esc and on backdrop click. */
  onCancel: () => void;
  /** Async delete. The modal stays mounted with disabled controls until
   *  the promise settles. On rejection the parent is responsible for
   *  surfacing the error (the confirm modal doesn't display its own error
   *  area — keep this component lean). */
  onConfirm: () => Promise<void>;
  /** Override the safety-delay window. Defaults to 500ms. Exposed so the
   *  harness / future visual tweaks can dial it up or down without
   *  patching the component. */
  safetyDelayMs?: number;
}

const DEFAULT_SAFETY_DELAY = 500;

export function DeleteProjectConfirm(props: DeleteProjectConfirmProps): JSX.Element {
  const [armed, setArmed] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  // Bumped on each retry so the arming effect re-runs without depending
  // on `props.open` flipping (the parent keeps the modal open while
  // surfacing the error).
  const [armCycle, setArmCycle] = createSignal(0);

  // Restart the safety window every time the modal opens or a retry
  // bumps `armCycle`. Both `armed` (logical state) and the CSS animation
  // (driven by the `data-armed` attribute on the button) restart in
  // lockstep so the visual progress fill matches the keyboard guard.
  createEffect(() => {
    if (!props.open) return;
    armCycle(); // dependency
    setArmed(false);
    setSubmitting(false);
    const delay = props.safetyDelayMs ?? DEFAULT_SAFETY_DELAY;
    const handle = window.setTimeout(() => setArmed(true), delay);
    onCleanup(() => window.clearTimeout(handle));
  });

  // Esc / Enter — capture-phase so xterm's hidden textarea doesn't swallow
  // them while a pane has focus, matching the Add/Edit modal's pattern.
  createEffect(() => {
    if (!props.open) return;
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submitting()) props.onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (armed() && !submitting()) void handleConfirm();
      }
    };
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onDocKey, { capture: true }));
  });

  const handleConfirm = async (): Promise<void> => {
    if (!armed() || submitting()) return;
    setSubmitting(true);
    try {
      await props.onConfirm();
      // Parent closes the modal on resolve.
    } catch {
      // Restart the safety delay before the user can retry — they'll
      // expect the same protection on the second attempt that they had
      // on the first. The parent is responsible for surfacing the error
      // since this modal stays presentational.
      batch(() => {
        setSubmitting(false);
        setArmCycle((n) => n + 1);
      });
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="ws-dpc__backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target && !submitting()) props.onCancel();
        }}
      >
        <div
          class="ws-dpc"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="ws-dpc-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class="ws-dpc__body">
            <div class="ws-dpc__title" id="ws-dpc-title">
              Delete &ldquo;{props.projectName}&rdquo;?
            </div>
            <div class="ws-dpc__copy">
              <Show
                when={props.runningSessions > 0}
                fallback={<p>This project has no running sessions.</p>}
              >
                <p>
                  This project has {props.runningSessions} running{" "}
                  {props.runningSessions === 1 ? "session" : "sessions"}. They will be killed.
                </p>
              </Show>
              <p class="ws-dpc__copy-warn">This cannot be undone.</p>
            </div>
          </div>
          <footer class="ws-dpc__foot">
            <button
              type="button"
              class="ws-apm__btn ws-apm__btn--ghost"
              onClick={() => {
                if (!submitting()) props.onCancel();
              }}
              disabled={submitting()}
            >
              Cancel
            </button>
            <button
              type="button"
              class="ws-apm__btn ws-apm__btn--danger"
              data-armed={armed() ? "true" : undefined}
              onClick={() => void handleConfirm()}
              disabled={!armed() || submitting()}
              style={{
                "--ws-dpc-delay": `${props.safetyDelayMs ?? DEFAULT_SAFETY_DELAY}ms`,
              }}
            >
              <span class="ws-dpc__btn-fill" aria-hidden="true" />
              <span class="ws-dpc__btn-label">{submitting() ? "Deleting…" : "Delete"}</span>
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

export default DeleteProjectConfirm;
