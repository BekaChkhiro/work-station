// T12.4 — In-memory map of workspace projectId → in-progress PlanFlow taskId.
//
// "In progress" here means *this user* has acquired the PlanFlow lock for
// the task via `POST /tasks/:id/work`. The server is still the source of
// truth — if the user relaunches the app while holding a lock the entry
// is rebuilt the next time the task list reloads and we observe a
// `lockedBy.id === me.id` row. We deliberately do not persist this to
// SQLite: a stale local entry pointing at a lock the server has long
// released would be more confusing than rebuilding from server state.
//
// Consumers:
//   - `WorkspaceTabStrip` reads `activeTaskId(projectId)` to render the
//     in-progress badge on the PlanFlow tab.
//   - `startTask` writes here after a successful `/work` + branch fetch.
//   - Later tasks (T12.5 Done flow) will clear the entry when the lock
//     is released. For now no consumer clears, so reload-of-list is the
//     only way the badge disappears.

import { createStore, produce } from "solid-js/store";

interface ActiveTaskState {
  byProjectId: Record<string, string>;
}

const [state, setState] = createStore<ActiveTaskState>({ byProjectId: {} });

/** Reactive: the in-progress task id this user holds for `projectId`, or
 *  null when no task is locked. */
export function activeTaskId(projectId: string): string | null {
  return state.byProjectId[projectId] ?? null;
}

/** Mark `taskId` as the user's in-progress task for `projectId`. Passing
 *  `null` clears the entry. Idempotent. */
export function setActiveTaskId(projectId: string, taskId: string | null): void {
  if (taskId === null) {
    if (state.byProjectId[projectId] === undefined) return;
    // Solid's setState merges keys; assigning a fresh object would leave
    // the cleared key in place. Use `produce` so the deletion actually
    // sticks and other projects' entries are preserved.
    setState(
      "byProjectId",
      produce((map: Record<string, string>) => {
        Reflect.deleteProperty(map, projectId);
      }),
    );
    return;
  }
  if (state.byProjectId[projectId] === taskId) return;
  setState("byProjectId", projectId, taskId);
}

/** Test-only — wipe every entry. */
export function _resetActiveTaskForTests(): void {
  setState({ byProjectId: {} });
}
