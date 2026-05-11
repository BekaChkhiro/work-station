// T11.8 — Non-blocking banner shown above an integration tab's content
// when the corresponding service has flipped into `needs_reauth`. The
// CTA opens Settings → Integrations where the matching row is already
// switched into "Re-enter token" mode.
//
// Style mirrors the T8.5 CLI-warning strip so the visual language of
// "something needs your attention but the rest of the app still works"
// stays consistent.

import type { JSX } from "solid-js";

import { WORKSPACE_TAB_META, type WorkspaceTabKind } from "../../types/workspaceTab";

export interface IntegrationReauthBannerProps {
  kind: WorkspaceTabKind;
  onReconnect: () => void;
}

export function IntegrationReauthBanner(props: IntegrationReauthBannerProps): JSX.Element {
  const label = (): string => WORKSPACE_TAB_META[props.kind].label;
  return (
    <div class="ws-reauth-banner" role="status" aria-live="polite" data-integration={props.kind}>
      <span class="ws-reauth-banner__icon" aria-hidden="true">
        ⚠
      </span>
      <span class="ws-reauth-banner__text">
        <strong class="ws-reauth-banner__name">{label()} token expired.</strong> Reconnect to keep
        this tab in sync.
      </span>
      <button type="button" class="ws-reauth-banner__action" onClick={() => props.onReconnect()}>
        Reconnect
      </button>
    </div>
  );
}

export default IntegrationReauthBanner;
