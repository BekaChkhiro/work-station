// T19.16 — Top-of-app banner that surfaces non-open cloud-agent
// connection states.
//
// Visible only when cloud mode is on AND the manager's state is
// something other than `open`. Different states produce different
// copy + tone so the user can tell a transient reconnect apart from
// a hard "you need to pair this device" condition:
//
//   - connecting / reconnecting → info tone, "Connecting to cloud
//     workspace…". The bridge handles auto-reconnect (T18.8) so the
//     banner is purely informational here.
//   - closed / closing → warning tone, "Cloud workspace disconnected —
//     attempting to reconnect…". Same auto-reconnect applies; the
//     warning tone exists to distinguish "we hit a drop" from "we're
//     coming up for the first time".
//   - unconfigured / no_token → warning tone, "Cloud workspace not
//     paired" with a Settings CTA. These states won't resolve on their
//     own — the user has to act.
//   - idle / open / disabled → hidden. `idle` is the bootstrap state
//     before the manager ever attempts to connect; surfacing it would
//     produce a flash on every cold start.
//
// Mounted once at the App root above the AppShell. The banner is
// purely a state consumer — it doesn't connect / disconnect / pair the
// agent; those actions live in Settings and the manager itself.

import { Show, type JSX } from "solid-js";

import type { CloudAgentConnectionState } from "../../integrations/cloudAgent";
import { cloudMode } from "../../stores/cloudMode";

export type CloudConnectionBannerTone = "info" | "warning";

export interface CloudConnectionBannerView {
  /** Banner tone (drives the stripe colour). */
  tone: CloudConnectionBannerTone;
  /** Headline shown in the banner's bold lead-in. */
  title: string;
  /** Body copy after the title (single sentence). */
  detail: string;
  /** When set, an action button labelled `action.label` is rendered. */
  action?: { label: string };
}

/** Pure mapper from connection state → banner view. Exported for
 *  unit tests; the component below just calls this and renders the
 *  result. Returns `null` when the banner should be hidden. */
export function describeBanner(
  state: CloudAgentConnectionState,
  isCloudMode: boolean,
): CloudConnectionBannerView | null {
  if (!isCloudMode) return null;
  switch (state) {
    case "open":
    case "disabled":
    case "idle":
      return null;
    case "connecting":
      return {
        tone: "info",
        title: "Connecting to cloud workspace…",
        detail: "Sourcing projects, terminals, and settings from your paired agent.",
      };
    case "reconnecting":
      return {
        tone: "warning",
        title: "Cloud workspace disconnected.",
        detail: "Attempting to reconnect — queued changes will replay once the link is back.",
      };
    case "closing":
    case "closed":
      return {
        tone: "warning",
        title: "Cloud workspace offline.",
        detail: "Attempting to reconnect — your pending changes will replay automatically.",
      };
    case "unconfigured":
      return {
        tone: "warning",
        title: "Cloud workspace not paired.",
        detail: "Add your agent URL in Settings to start using this device with the cloud.",
        action: { label: "Open Settings" },
      };
    case "no_token":
      return {
        tone: "warning",
        title: "Cloud workspace pairing missing.",
        detail: "The pairing token isn't on this device. Re-pair from Settings to reconnect.",
        action: { label: "Open Settings" },
      };
  }
}

export interface CloudConnectionBannerProps {
  /** Reactive accessor for the manager's state. Passed in so the
   *  component doesn't reach into the singleton directly — keeps it
   *  trivially testable. */
  state: () => CloudAgentConnectionState;
  /** Fires when the user activates the action button (currently
   *  "Open Settings"). When absent, the button is rendered disabled. */
  onAction?: () => void;
  /** Override the cloud-mode source (tests). Defaults to the global
   *  [`cloudMode`] signal. */
  cloudModeSource?: () => boolean;
}

export function CloudConnectionBanner(props: CloudConnectionBannerProps): JSX.Element {
  const view = (): CloudConnectionBannerView | null => {
    const mode = (props.cloudModeSource ?? cloudMode)();
    return describeBanner(props.state(), mode);
  };

  return (
    <Show when={view()}>
      {(v) => (
        <div
          class="ws-cloud-banner"
          role="status"
          aria-live="polite"
          data-tone={v().tone}
          data-state={props.state()}
        >
          <span class="ws-cloud-banner__icon" aria-hidden="true">
            {v().tone === "info" ? "↻" : "⚠"}
          </span>
          <span class="ws-cloud-banner__text">
            <strong class="ws-cloud-banner__title">{v().title}</strong>{" "}
            <span class="ws-cloud-banner__detail">{v().detail}</span>
          </span>
          <Show when={v().action}>
            {(a) => (
              <button
                type="button"
                class="ws-cloud-banner__action"
                onClick={() => props.onAction?.()}
                disabled={props.onAction == null}
              >
                {a().label}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

export default CloudConnectionBanner;
