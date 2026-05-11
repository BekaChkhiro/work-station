// T11.9 — Small pill that surfaces offline state for an integration.
//
// Reads the reactive `offlineSnapshot()` signals — the component re-renders
// automatically when the overall or per-service state changes. Hidden (null)
// when the relevant state is "online".
//
// Usage:
//   <OfflineBadge />                    // overall offline
//   <OfflineBadge service="planflow" /> // planflow-specific soft-offline

import { Show, type JSX } from "solid-js";
import { isOffline, offlineSnapshot } from "../../integrations/offline";

export interface OfflineBadgeProps {
  /** When provided, shows the badge when THIS service is soft-offline (or
   *  overall is offline). When omitted, only the overall state is checked. */
  service?: string;
  class?: string;
}

export function OfflineBadge(props: OfflineBadgeProps): JSX.Element {
  // Reading `overall` and `perService` inside the component body keeps
  // the Show reactive — Solid tracks the signal reads.
  const snapshot = offlineSnapshot();

  const offline = (): boolean => {
    // Trigger reactive tracking by reading both signals.
    void snapshot.overall();
    void snapshot.perService();
    return isOffline(props.service);
  };

  return (
    <Show when={offline()}>
      <span
        class={props.class}
        aria-label={props.service != null ? `${props.service} is offline` : "Offline"}
        role="status"
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "4px",
          padding: "1px 6px",
          "font-size": "var(--fs-11)",
          "border-radius": "4px",
          background: "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
          color: "var(--text-secondary)",
          "white-space": "nowrap",
          "line-height": "1.5",
        }}
      >
        {/* Red dot — always use --error token, not a hardcoded hex */}
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "6px",
            height: "6px",
            "border-radius": "50%",
            background: "var(--error)",
            "flex-shrink": "0",
          }}
        />
        Offline
      </span>
    </Show>
  );
}

export default OfflineBadge;
