// T5.5: Pane — focus-aware wrapper around a single layout leaf's content.
//
// Wraps any subtree (typically a Terminal) so that:
//   • Click anywhere inside the pane = "this pane is active".
//   • Tabbing into pane content (e.g. xterm textarea) = active too.
//   • The active pane shows an accent border ring (1px tinted) per the
//     PROJECT_PLAN T5.5 acceptance — exactly mirroring the prototype's
//     `.pane.focused` rule in work-station-design/styles.css.
//
// Focus state is fully controlled by the parent (`focused` prop). The
// wrapper reports activation intent via `onFocus(sessionId)`; the parent
// reduces those events into a single "focusedSessionId" the LayoutTree
// can render against. This keeps the hotkey-routing layer (T8.x) free
// to consult the same source of truth without duplicating click logic.
//
// Activation listeners:
//   • `pointerdown` — fires before any child takes focus, so keyboard or
//     mouse clicks both register even when the inner Terminal swallows
//     them via xterm's textarea capture.
//   • `focusin` — bubbles from any descendant. Catches keyboard tab
//     navigation that lands focus on the xterm textarea directly without
//     a pointer event ever firing.

import { children } from "solid-js";
import type { JSX } from "solid-js";

export interface PaneProps {
  /** Stable identifier for this pane (typically the PTY sessionId). Echoed
   *  back through `onFocus` so the parent can reduce events into a single
   *  focused-session signal without reaching into refs. */
  sessionId: string;
  /** Whether this pane currently has the focus ring. Controlled. */
  focused: boolean;
  /** Fired on pointerdown OR descendant focusin. Idempotent — the parent
   *  may receive multiple events for the same activation; treat as
   *  "make this pane focused". */
  onFocus?: (sessionId: string) => void;
  /** The subtree mounted inside the pane (Terminal, placeholder, etc.). */
  children: JSX.Element;
}

export function Pane(props: PaneProps): JSX.Element {
  // The `children` helper memoises the resolved JSX so the wrapper's
  // `focused` prop changes can NEVER trigger a re-evaluation of the
  // child subtree. Required to keep T5.4's "100 ratio drags = 1 mount"
  // acceptance intact when focus is being toggled in the same session
  // (focus changes happen alongside ratio drags during normal use).
  const resolved = children(() => props.children);

  // Both paths must be idempotent — clicking on the already-focused pane
  // re-fires onFocus, descendant focusin events do too. The parent
  // reducer (typically `setFocusedSessionId`) treats repeats as no-ops,
  // so pre-filtering here would just hide the contract from callers
  // that legitimately want every activation event (e.g., for
  // last-activated metrics in T6.3 hotkey routing).
  const activate = (): void => {
    props.onFocus?.(props.sessionId);
  };

  return (
    <div
      class="ws-pane"
      role="region"
      aria-label={`Pane ${props.sessionId}`}
      data-session-id={props.sessionId}
      data-focused={props.focused ? "true" : undefined}
      onPointerDown={activate}
      onFocusIn={activate}
    >
      {resolved()}
    </div>
  );
}

export default Pane;
