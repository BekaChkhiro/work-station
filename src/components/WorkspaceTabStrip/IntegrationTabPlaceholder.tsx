// T11.1: placeholder shown when a non-terminal workspace tab is active but
// the corresponding integration content isn't built yet (T12.x–T17.x) or
// the user hasn't linked the service (T11.5).
//
// This stays intentionally bare — the canonical "not connected" empty
// state with a CTA into Settings → Integrations lands with T11.7, which
// will replace this body for the integration kinds.

import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { WORKSPACE_TAB_META, type WorkspaceTabKind } from "../../types/workspaceTab";

export interface IntegrationTabPlaceholderProps {
  kind: WorkspaceTabKind;
  /** Optional CTA — when provided, renders a button below the description.
   *  The handler typically opens Settings → Integrations (lands with T11.3). */
  onOpenSettings?: () => void;
}

export function IntegrationTabPlaceholder(props: IntegrationTabPlaceholderProps): JSX.Element {
  const meta = (): (typeof WORKSPACE_TAB_META)[WorkspaceTabKind] => WORKSPACE_TAB_META[props.kind];

  return (
    <div
      class="ws-workspace-tabs__placeholder"
      role="region"
      aria-label={`${meta().label} (not connected)`}
    >
      <div class="ws-workspace-tabs__placeholder-card">
        <div class="ws-workspace-tabs__placeholder-title">{meta().label}</div>
        <Show
          when={meta().category === "integration"}
          fallback={
            <div class="ws-workspace-tabs__placeholder-body">
              {meta().label} view is coming in a later release.
            </div>
          }
        >
          <div class="ws-workspace-tabs__placeholder-body">
            Connect {meta().label} in Settings to use this view.
          </div>
        </Show>
        <Show when={props.onOpenSettings}>
          <button
            type="button"
            class="ws-workspace-tabs__placeholder-cta"
            onClick={() => props.onOpenSettings?.()}
          >
            Open Settings
          </button>
        </Show>
      </div>
    </div>
  );
}

export default IntegrationTabPlaceholder;
