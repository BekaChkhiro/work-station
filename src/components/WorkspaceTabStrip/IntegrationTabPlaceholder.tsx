// T11.1 / T11.7 — Empty state shown when a non-terminal workspace tab is
// active but the corresponding integration is not yet connected (T11.5) or
// the feature is still pending (T13.x for Editor).
//
// Routes through the shared <EmptyState /> primitive so the canonical
// loading / empty / error pattern stays in one place. Uses the `muted`
// variant — the card sits inside the workspace and shouldn't dominate
// the view the way the projects welcome card does.

import type { JSX } from "solid-js";
import { EmptyState } from "../AsyncStates";
import { WORKSPACE_TAB_META, type WorkspaceTabKind } from "../../types/workspaceTab";

export interface IntegrationTabPlaceholderProps {
  kind: WorkspaceTabKind;
  /** Optional CTA — when provided, renders a button below the description.
   *  The handler typically opens Settings → Integrations (lands with T11.3). */
  onOpenSettings?: () => void;
}

export function IntegrationTabPlaceholder(props: IntegrationTabPlaceholderProps): JSX.Element {
  const meta = (): (typeof WORKSPACE_TAB_META)[WorkspaceTabKind] => WORKSPACE_TAB_META[props.kind];
  const isIntegration = (): boolean => meta().category === "integration";

  const description = (): string =>
    isIntegration()
      ? `Connect ${meta().label} in Settings to use this view.`
      : `${meta().label} view is coming in a later release.`;

  return (
    <EmptyState
      variant="muted"
      title={meta().label}
      description={description()}
      ariaLabel={`${meta().label} (not connected)`}
      primaryAction={
        isIntegration() && props.onOpenSettings
          ? {
              label: "Open Settings",
              onClick: () => props.onOpenSettings?.(),
            }
          : undefined
      }
    />
  );
}

export default IntegrationTabPlaceholder;
