// Bridge between the PlanFlow orchestrator (in `integrations/planflow/`)
// and the CLI / PTY plumbing that lives in `AppRoot`. The orchestrator can
// only do server-side work (locks, status flips); spawning a terminal pane,
// feeding it a CLI command, and inspecting which CLI (if any) is already
// running in the focused pane need access to helpers that don't naturally
// live next to the integrations layer. Wiring those through `AppShell` →
// `PlanFlowTaskList` → `runStartTask` would mean six new prop hops with no
// other consumer. A tiny registry singleton mirrors the shape we already
// use for `pendingTaskJump`: AppRoot registers handlers on boot, the
// orchestrator calls them on Start.
//
// The launcher is invoked best-effort: any failure (no available CLI, no
// project metadata, ptySpawn rejected) is logged and swallowed so the
// start flow itself still succeeds — the lock is held, the user can
// open a CLI manually.

import type { PlanFlowStartMode } from "../types/planflowStartMode";

export interface TaskCliLauncherOptions {
  /** Explicit CLI choice — overrides the project default / auto-resolved
   *  CLI. PlanFlow Start currently always passes `"claude"`; we keep the
   *  field around for a future codex / kimi expansion. */
  cliName?: string;
  /** Selected Start mode (`manual` / `pr` / `merge-master` / `none`).
   *  Threaded all the way into the `planflow_task_start(...)` prompt
   *  the launcher types into the spawned CLI. Defaults to `manual`
   *  when omitted so legacy callers stay on the safe path. */
  mode?: PlanFlowStartMode;
}

export type TaskCliLauncher = (
  projectId: string,
  taskId: string,
  opts?: TaskCliLauncherOptions,
) => Promise<void> | void;

/** Synchronous lookup: which CLI (if any) is currently running in the
 *  focused pane for `projectId`. Returns `null` when no pane is focused,
 *  or the focused pane is running a plain shell. `startTask` uses this to
 *  decide whether to pre-fill `git checkout -b …` (shell case) or skip it
 *  (CLI case, where the text would land as a chat prompt instead of a
 *  shell command). */
export type FocusedSessionCliResolver = (projectId: string) => string | null;

let registeredLauncher: TaskCliLauncher | null = null;
let registeredResolver: FocusedSessionCliResolver | null = null;

/** AppRoot calls this once per mount with a function that knows how to
 *  drive the terminal side-effects of a PlanFlow Start press. Pass `null`
 *  from `onCleanup` to break the reference during HMR / window close. */
export function setTaskCliLauncher(fn: TaskCliLauncher | null): void {
  registeredLauncher = fn;
}

/** Returns true when AppRoot has wired a launcher. Mostly useful for tests
 *  / preview harnesses that want to assert wiring happened. */
export function hasTaskCliLauncher(): boolean {
  return registeredLauncher !== null;
}

/** AppRoot registers this so the orchestrator can introspect the focused
 *  pane's CLI status before deciding whether to pre-fill `git checkout`. */
export function setFocusedSessionCliResolver(fn: FocusedSessionCliResolver | null): void {
  registeredResolver = fn;
}

/** Synchronous read of the focused pane's CLI for `projectId`. Returns
 *  `null` when no resolver has been registered yet, when no pane is
 *  focused, or when the focused pane is a plain shell. */
export function getFocusedSessionCli(projectId: string): string | null {
  const fn = registeredResolver;
  if (fn == null) return null;
  try {
    return fn(projectId);
  } catch (error) {
    console.warn("[planflow] focused-pane CLI resolver failed:", error);
    return null;
  }
}

/** Best-effort: run the registered launcher for `(projectId, taskId)`.
 *  Pass an optional `cliName` to override the auto-resolved CLI for this
 *  specific start. Errors are caught + logged; the caller keeps going. */
export async function launchTaskCli(
  projectId: string,
  taskId: string,
  opts?: TaskCliLauncherOptions,
): Promise<void> {
  const fn = registeredLauncher;
  if (fn == null) return;
  try {
    await fn(projectId, taskId, opts);
  } catch (error) {
    console.warn("[planflow] task CLI launcher failed:", error);
  }
}
