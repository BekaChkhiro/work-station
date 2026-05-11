// T11.1: WorkspaceTabStrip — top-level tab switcher inside a project.
//
// This sits *above* the per-terminal TabStrip (T5.3) and the LayoutTree. It
// flips the workspace body between Terminal, Editor, and per-integration
// views (PlanFlow, GitHub, Vercel, Neon, Railway). Visibility of each tab
// is per-project (T11.5 links integrations once credentials land in T11.2);
// for the T11.1 scaffold only the Terminal tab is populated by default.
//
// Controlled component: parent owns `tabs` and `activeKind` and persists
// selection changes. The strip doesn't reach into the workspace store on
// its own so a future split-pane / dev-harness can reuse it with mocked
// state.
//
// Styling reuses the `ws-tabstrip__*` BEM block from globals.css with a
// `ws-workspace-tabs` modifier so the workspace-level strip can diverge
// visually later without rewriting the per-terminal strip.

import { For } from "solid-js";
import type { JSX } from "solid-js";
import { Tooltip } from "../Tooltip";
import { WORKSPACE_TAB_META, type WorkspaceTabKind } from "../../types/workspaceTab";

export interface WorkspaceTabStripProps {
  /** Ordered list of tab kinds to render. The Terminal tab is conventionally
   *  first, but the strip renders whatever order it receives. */
  tabs: readonly WorkspaceTabKind[];
  /** Currently active tab kind. Must be one of `tabs` — out-of-list values
   *  render with no active highlight. */
  activeKind: WorkspaceTabKind;
  onActivate(kind: WorkspaceTabKind): void;
}

export function WorkspaceTabStrip(props: WorkspaceTabStripProps): JSX.Element {
  return (
    <div class="ws-workspace-tabs" role="tablist" aria-label="Workspace views">
      <div class="ws-workspace-tabs__scroll">
        <For each={props.tabs}>
          {(kind) => {
            const meta = WORKSPACE_TAB_META[kind];
            const isActive = (): boolean => props.activeKind === kind;
            return (
              <Tooltip label={meta.label}>
                <button
                  type="button"
                  role="tab"
                  class="ws-workspace-tabs__tab"
                  data-active={isActive() ? "true" : undefined}
                  data-kind={meta.kind}
                  data-category={meta.category}
                  aria-selected={isActive()}
                  tabIndex={isActive() ? 0 : -1}
                  onClick={() => props.onActivate(kind)}
                >
                  <span class="ws-workspace-tabs__label">{meta.label}</span>
                </button>
              </Tooltip>
            );
          }}
        </For>
      </div>
    </div>
  );
}

export default WorkspaceTabStrip;
