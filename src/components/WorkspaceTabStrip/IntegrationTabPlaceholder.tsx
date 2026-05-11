// T11.1 / T11.7 — Empty state shown when a non-terminal workspace tab is
// active but the corresponding integration is not yet connected (T11.5) or
// the feature is still pending (T13.x for Editor).
//
// Routes through the shared <EmptyState /> primitive so the canonical
// loading / empty / error pattern stays in one place. Uses the `muted`
// variant — the card sits inside the workspace and shouldn't dominate
// the view the way the projects welcome card does.
//
// T11.8 — When the integration has flipped into `needs_reauth`, the
// copy and CTA shift: the banner above already says "Token expired —
// Reconnect", and this placeholder echoes the message so first-time
// viewers landing directly on the tab still see the prompt even when
// the banner scrolled out (or hasn't rendered yet during hydration).
//
// T11.9 — When the network is down (overall) or this specific integration
// has tripped the soft-offline counter, an Offline pill renders above the
// card so users know reads/writes will be served from cache (or queued)
// without forcing them to scroll an integration view that does not yet
// exist (Phase 12+).

import type { JSX } from "solid-js";
import { EmptyState } from "../AsyncStates";
import { OfflineBadge } from "../integrations/OfflineBadge";
import { WORKSPACE_TAB_META, type WorkspaceTabKind } from "../../types/workspaceTab";

export interface IntegrationTabPlaceholderProps {
  kind: WorkspaceTabKind;
  /** Optional CTA — when provided, renders a button below the description.
   *  The handler typically opens Settings → Integrations (lands with T11.3). */
  onOpenSettings?: () => void;
  /** T11.8 — when true the placeholder switches into the "Token expired"
   *  message and the CTA renames to "Reconnect". */
  needsReauth?: boolean;
}

export function IntegrationTabPlaceholder(props: IntegrationTabPlaceholderProps): JSX.Element {
  const meta = (): (typeof WORKSPACE_TAB_META)[WorkspaceTabKind] => WORKSPACE_TAB_META[props.kind];
  const isIntegration = (): boolean => meta().category === "integration";
  const reauth = (): boolean => isIntegration() && props.needsReauth === true;

  const description = (): string => {
    if (reauth()) {
      return `Your ${meta().label} token was rejected. Reconnect in Settings to keep this tab in sync.`;
    }
    return isIntegration()
      ? `Connect ${meta().label} in Settings to use this view.`
      : `${meta().label} view is coming in a later release.`;
  };

  const ctaLabel = (): string => (reauth() ? "Reconnect" : "Open Settings");

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        flex: "1",
        "min-height": "0",
      }}
    >
      {isIntegration() && (
        <div
          style={{
            display: "flex",
            "justify-content": "flex-end",
            padding: "var(--sp-2) var(--sp-3) 0",
          }}
        >
          <OfflineBadge service={props.kind} />
        </div>
      )}
      <EmptyState
        variant="muted"
        title={reauth() ? `${meta().label} — token expired` : meta().label}
        description={description()}
        ariaLabel={
          reauth() ? `${meta().label} (reconnect required)` : `${meta().label} (not connected)`
        }
        primaryAction={
          isIntegration() && props.onOpenSettings
            ? {
                label: ctaLabel(),
                onClick: () => props.onOpenSettings?.(),
              }
            : undefined
        }
      />
    </div>
  );
}

export default IntegrationTabPlaceholder;
