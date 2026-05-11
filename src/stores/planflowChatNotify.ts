// Cross-component notification channel for the PlanFlow chat → task
// list refetch flow. After the chat bridge finishes an assistant turn
// (the CLI's reply landed in the chat), any plan/task mutation it
// made has already happened on the server, but the local task list
// has no idea. Bumping the per-project counter here triggers
// LinkedTaskList's `createResource` re-run via a reactive read.
//
// Implementation mirrors `pendingTaskJump`: a Solid signal keyed by
// projectId. The chat bridge writes; the task list reads on every
// render and refetches when the value increments.

import { createSignal } from "solid-js";

const [counterByProject, setCounterByProject] = createSignal<Record<string, number>>({});

/** Reactive: latest refetch tick for `projectId`. Returns 0 when the
 *  project has never been bumped. */
export function planflowChatRefetchTick(projectId: string): number {
  return counterByProject()[projectId] ?? 0;
}

/** Increment the refetch tick for `projectId`. Safe to call from
 *  non-reactive contexts (e.g. the chat bridge). */
export function bumpPlanflowChatRefetch(projectId: string): void {
  setCounterByProject((prev) => ({
    ...prev,
    [projectId]: (prev[projectId] ?? 0) + 1,
  }));
}
