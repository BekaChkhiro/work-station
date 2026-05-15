// T19.8 — Local/Cloud workspace toggle.
//
// Sits at the top of the Sidebar (T6.1). Reads `cloudMode` (T19.5)
// directly because the toggle is app-wide: every project view shares
// the same source-of-truth, so plumbing controlled props through Sidebar
// would just be noise. The pairing state surfaced on the Cloud segment
// is derived from `cloudAgentUrl` + `cloudAgentStatus`:
//
//   • unpaired      — cloudAgentUrl === null. Clicking Cloud fires
//                     `onRequestPair` so the parent can open Settings
//                     (T19.15) without this component knowing about
//                     Settings UI shapes.
//   • paired        — cloudAgentUrl set, no needsRepairAt timestamp.
//   • needs-repair  — cloudAgentUrl set, needsRepairAt timestamped.
//
// Expanded layout: a segmented two-button switch with a status dot on
// the Cloud segment. Collapsed layout: a single icon button (laptop or
// cloud glyph) sitting in the sidebar rail, with the same status dot
// pinned to the corner. The dot stays visible in both layouts so the
// agent's health is always glanceable.

import { Show, type JSX } from "solid-js";

import {
  cloudAgentStatus,
  cloudAgentUrl,
  cloudMode,
  setCloudMode,
  type CloudAgentStatus,
} from "../../stores/cloudMode";
import { Tooltip } from "../Tooltip";

export type CloudPairingState = "unpaired" | "paired" | "needs-repair";

/** Pure helper — exported for unit tests. Derives the pairing state from
 *  the persisted URL + status snapshot. */
export function cloudPairingState(url: string | null, status: CloudAgentStatus): CloudPairingState {
  if (url === null) return "unpaired";
  if (status && status.needsRepairAt != null) return "needs-repair";
  return "paired";
}

export interface WorkspaceToggleProps {
  /** Icon-only rail variant for the collapsed sidebar. Defaults to expanded. */
  collapsed?: boolean;
  /** Fires when the user clicks Cloud while unpaired. The parent typically
   *  opens the Settings UI (T19.15) so the user can pair an agent. */
  onRequestPair?(): void;
}

export function WorkspaceToggle(props: WorkspaceToggleProps): JSX.Element {
  const state = (): CloudPairingState => cloudPairingState(cloudAgentUrl(), cloudAgentStatus());

  const cloudTooltip = (): string => {
    switch (state()) {
      case "unpaired":
        return "Cloud — not paired. Open Settings to pair.";
      case "needs-repair":
        return "Cloud — pairing expired. Re-pair in Settings.";
      case "paired":
        return cloudMode() ? "Cloud workspace (active)" : "Switch to cloud workspace";
    }
  };

  const localTooltip = (): string =>
    cloudMode() ? "Switch to local workspace" : "Local workspace (active)";

  const handleCloud = (): void => {
    if (state() === "unpaired") {
      props.onRequestPair?.();
      return;
    }
    void setCloudMode(true);
  };

  const handleLocal = (): void => {
    void setCloudMode(false);
  };

  return (
    <Show
      when={props.collapsed === true}
      fallback={
        <div class="ws-wtog" role="group" aria-label="Workspace source">
          <Tooltip label={localTooltip()}>
            <button
              type="button"
              class="ws-wtog__seg"
              data-active={!cloudMode() ? "true" : undefined}
              aria-pressed={!cloudMode()}
              onClick={handleLocal}
            >
              <IconLaptop />
              <span class="ws-wtog__label">Local</span>
            </button>
          </Tooltip>
          <Tooltip label={cloudTooltip()}>
            <button
              type="button"
              class="ws-wtog__seg"
              data-active={cloudMode() ? "true" : undefined}
              data-cloud-state={state()}
              aria-pressed={cloudMode()}
              aria-disabled={state() === "unpaired" ? "true" : undefined}
              onClick={handleCloud}
            >
              <IconCloud />
              <span class="ws-wtog__label">Cloud</span>
              <span class="ws-wtog__dot" data-state={state()} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      }
    >
      <div class="ws-wtog ws-wtog--collapsed" role="group" aria-label="Workspace source">
        <Tooltip label={cloudMode() ? cloudTooltip() : localTooltip()}>
          <button
            type="button"
            class="ws-wtog__rail"
            data-mode={cloudMode() ? "cloud" : "local"}
            data-cloud-state={state()}
            aria-label={
              cloudMode()
                ? "Cloud workspace — switch to local"
                : "Local workspace — switch to cloud"
            }
            aria-pressed={cloudMode()}
            onClick={() => (cloudMode() ? handleLocal() : handleCloud())}
          >
            <Show when={cloudMode()} fallback={<IconLaptop />}>
              <IconCloud />
            </Show>
            <span
              class="ws-wtog__dot ws-wtog__dot--corner"
              data-state={state()}
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      </div>
    </Show>
  );
}

function IconLaptop(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2.2" y="2.5" width="9.6" height="6.5" rx="0.8" />
      <path d="M1 11.5 H13" />
    </svg>
  );
}

function IconCloud(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 10.5 H10.4 A2.6 2.6 0 0 0 10.4 5.3 A3.4 3.4 0 0 0 3.7 5.5 A2.3 2.3 0 0 0 3.5 10.5 Z" />
    </svg>
  );
}

export default WorkspaceToggle;
