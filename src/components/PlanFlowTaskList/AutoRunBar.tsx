// Slim status strip rendered above the task list whenever an auto-run
// queue is active for the current workspace project. Doubles as the
// landing zone for the "Last run: …" pill after a queue finishes —
// the user can dismiss it explicitly.
//
// All transitions are driven by the autoRunQueue store; this
// component only renders + dispatches user intent (pause/resume/stop/
// dismiss). No timers live here.

import { Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";

import {
  autoRunQueue,
  dismissAutoRun,
  pauseAutoRun,
  resumeAutoRun,
  stopAutoRun,
} from "../../stores/autoRunQueue";
import { autoRunQueueProgressLabel, isAutoRunQueueActive } from "../../types/autoRunQueue";

export interface AutoRunBarProps {
  workspaceProjectId: string;
}

function formatTime(stamp: number | null): string {
  if (stamp === null) return "";
  const d = new Date(stamp);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}`;
}

function formatRemaining(stamp: number | null): string {
  if (stamp === null) return "";
  const ms = stamp - Date.now();
  if (ms <= 0) return "now";
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `in ${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `in ${hours}h ${minutes}m`;
}

export function AutoRunBar(props: AutoRunBarProps): JSX.Element {
  const queue = createMemo(() => autoRunQueue(props.workspaceProjectId));

  const visible = createMemo(() => {
    const q = queue();
    if (!q) return false;
    // Active queues always show. Finished ones (done/failed/stopped)
    // remain until the user dismisses them.
    return true;
  });

  const stateLabel = createMemo(() => {
    const q = queue();
    if (!q) return "";
    switch (q.state) {
      case "scheduled":
        return `Scheduled ${formatRemaining(q.nextDispatchAt)} (${formatTime(q.nextDispatchAt)})`;
      case "running":
        return "Running";
      case "waiting":
        return `Next ${formatRemaining(q.nextDispatchAt)}`;
      case "paused":
        return "Paused";
      case "stopped":
        return "Stopped";
      case "done":
        return "Done";
      case "failed":
        return "Failed";
      default:
        return q.state;
    }
  });

  const currentTaskId = createMemo(() => {
    const q = queue();
    if (!q) return null;
    if (q.state !== "running" && q.state !== "paused") return null;
    return q.taskIds[q.cursor] ?? null;
  });

  return (
    <Show when={visible() && queue()}>
      {(q) => (
        <div class="ws-aar-bar" role="status" aria-live="polite" data-state={q().state}>
          <div class="ws-aar-bar__lead">
            <span class="ws-aar-bar__icon" aria-hidden="true">
              ⚡
            </span>
            <span class="ws-aar-bar__label">Auto run</span>
            <span class="ws-aar-bar__progress">{autoRunQueueProgressLabel(q())}</span>
            <span class="ws-aar-bar__state">· {stateLabel()}</span>
            <Show when={currentTaskId()}>
              {(id) => <span class="ws-aar-bar__current">· current: {id()}</span>}
            </Show>
          </div>
          <div class="ws-aar-bar__actions">
            <Show when={q().state === "running" || q().state === "waiting"}>
              <button
                type="button"
                class="ws-aar-bar__btn"
                onClick={() => pauseAutoRun(q().projectId)}
                aria-label="Pause auto run"
                title="Finish current task, then stop dispatching"
              >
                ⏸ Pause
              </button>
            </Show>
            <Show when={q().state === "paused"}>
              <button
                type="button"
                class="ws-aar-bar__btn"
                onClick={() => resumeAutoRun(q().projectId)}
                aria-label="Resume auto run"
                title="Continue from where the queue paused"
              >
                ▶ Resume
              </button>
            </Show>
            <Show when={isAutoRunQueueActive(q())}>
              <button
                type="button"
                class="ws-aar-bar__btn ws-aar-bar__btn--danger"
                onClick={() => stopAutoRun(q().projectId)}
                aria-label="Stop auto run"
                title="Stop the queue entirely"
              >
                ⏹ Stop
              </button>
            </Show>
            <Show when={!isAutoRunQueueActive(q())}>
              <button
                type="button"
                class="ws-aar-bar__btn"
                onClick={() => dismissAutoRun(q().projectId)}
                aria-label="Dismiss auto run summary"
                title="Hide this banner"
              >
                Dismiss
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

export default AutoRunBar;
