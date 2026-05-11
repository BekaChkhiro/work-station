// T12.9 — Pending cross-project task jump signal.
//
// The notifications bell can target a task in any linked PlanFlow project,
// including one whose workspace tab isn't currently mounted. We can't call
// the PlanFlowTaskList's controller imperatively from the bell because the
// list mounts lazily — switching to that project + flipping its
// workspace tab to "planflow" may happen one render after the click.
//
// This module records "after the PlanFlow tab for project X is mounted,
// scroll to task Y and flash the row". PlanFlowTaskList consumes the
// pending jump on mount and reactively, then clears it.

import { createSignal } from "solid-js";

const [pending, setPending] = createSignal<Record<string, string>>({});

/** Request that PlanFlowTaskList scroll to and flash `taskId` the next
 *  time it mounts for `workspaceProjectId`. Overwrites any prior pending
 *  jump for the same project — only the most recent target wins. */
export function requestTaskJump(workspaceProjectId: string, taskId: string): void {
  setPending((prev) => ({ ...prev, [workspaceProjectId]: taskId }));
}

/** Read-only reactive accessor — returns the pending task id for
 *  `workspaceProjectId`, or `null` when none is pending. */
export function pendingTaskJump(workspaceProjectId: string): string | null {
  return pending()[workspaceProjectId] ?? null;
}

/** Drop the pending jump for `workspaceProjectId` once it has been
 *  delivered. Caller is responsible for calling this — leaving it in
 *  place would re-fire the jump on every PlanFlow tab remount. */
export function consumeTaskJump(workspaceProjectId: string): string | null {
  const value = pending()[workspaceProjectId];
  if (value == null) return null;
  setPending((prev) => {
    const { [workspaceProjectId]: _drop, ...rest } = prev;
    void _drop;
    return rest;
  });
  return value;
}

/** Test-only — reset all pending jumps. */
export function _resetPendingTaskJumpsForTests(): void {
  setPending({});
}
