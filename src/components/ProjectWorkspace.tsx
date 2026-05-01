/**
 * ProjectWorkspace — tab strip + content area for the active project.
 *
 * Wires the TabStrip to the layout store and renders the active pane's
 * terminal (or a placeholder when the layout tree is empty).
 */

import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { activeProjectId } from "../stores/projects";
import {
  getProjectLayout,
  getActivePaneId,
  setActivePane,
  removePane,
  setProjectLayout,
} from "../stores/layout";
import { flattenPanes } from "../types/layout";
import TabStrip from "./TabStrip";
import Terminal from "./Terminal";

function generateSessionId(): string {
  return crypto.randomUUID();
}

/** Create a default single-pane layout for a project. */
function createDefaultLayout(sessionId?: string) {
  return {
    type: "pane" as const,
    sessionId: sessionId ?? generateSessionId(),
  };
}

export default function ProjectWorkspace() {
  const projectId = createMemo(() => activeProjectId());

  // Ensure every active project has at least one pane so the tabstrip
  // is never empty during early development (T5.3 demo scaffolding).
  createEffect(() => {
    const pid = projectId();
    if (!pid) return;
    const existing = getProjectLayout(pid);
    if (!existing) {
      const layout = createDefaultLayout();
      setProjectLayout(pid, layout);
      setActivePane(pid, layout.sessionId);
    }
  });

  // Custom tab order, persisted locally per project for drag-to-reorder.
  const [tabOrder, setTabOrder] = createSignal<Record<string, string[]>>({});

  // Sync tab order with layout panes: keep existing order, append new ones.
  createEffect(() => {
    const pid = projectId();
    if (!pid) return;
    const layout = getProjectLayout(pid);
    const paneIds = layout ? flattenPanes(layout).map((p) => p.sessionId) : [];
    setTabOrder((prev) => {
      const order = prev[pid] ?? [];
      const existing = order.filter((id) => paneIds.includes(id));
      const newIds = paneIds.filter((id) => !order.includes(id));
      if (existing.length === order.length && newIds.length === 0) return prev;
      return { ...prev, [pid]: [...existing, ...newIds] };
    });
  });

  const tabs = createMemo(() => {
    const pid = projectId();
    if (!pid) return [];
    const order = tabOrder()[pid] ?? [];
    return order.map((sessionId, idx) => ({
      sessionId,
      label: `Terminal ${idx + 1}`,
    }));
  });

  const activeSessionId = createMemo(() => {
    const pid = projectId();
    if (!pid) return undefined;
    return getActivePaneId(pid);
  });

  function handleSelect(sessionId: string) {
    const pid = projectId();
    if (!pid) return;
    setActivePane(pid, sessionId);
  }

  function handleClose(sessionId: string) {
    const pid = projectId();
    if (!pid) return;
    removePane(pid, sessionId);

    // If we closed the active pane, focus another one if available.
    const remaining = tabs().filter((t) => t.sessionId !== sessionId);
    if (remaining.length > 0) {
      setActivePane(pid, remaining[0].sessionId);
    }
  }

  function handleReorder(fromIndex: number, toIndex: number) {
    const pid = projectId();
    if (!pid) return;
    setTabOrder((prev) => {
      const order = prev[pid] ?? [];
      const newOrder = [...order];
      const [moved] = newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, moved);
      return { ...prev, [pid]: newOrder };
    });
  }

  return (
    <div class="flex flex-1 flex-col overflow-hidden">
      <Show when={projectId()}>
        <TabStrip
          tabs={tabs()}
          activeSessionId={activeSessionId()}
          onSelect={handleSelect}
          onClose={handleClose}
          onReorder={handleReorder}
        />
      </Show>

      {/* Content area — renders the active terminal or an empty state. */}
      <div class="relative flex-1 overflow-hidden bg-surface-base">
        <Show
          when={activeSessionId()}
          fallback={
            <div class="flex h-full items-center justify-center">
              <div class="text-center">
                <p class="text-sm text-text-secondary">No active terminal</p>
                <p class="mt-1 text-xs text-text-tertiary">
                  Select a project to open a session.
                </p>
              </div>
            </div>
          }
        >
          <Terminal sessionId={activeSessionId()!} />
        </Show>
      </div>
    </div>
  );
}
