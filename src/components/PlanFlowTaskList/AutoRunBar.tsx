// Slim status strip rendered above the task list whenever an auto-run
// queue is active for the current workspace project. Doubles as the
// landing zone for the "Last run: …" pill after a queue finishes —
// the user can dismiss it explicitly.
//
// The strip is expandable: a ▾ chevron flips it open to a details
// panel with metadata (start time, mode, pacing, deadline), the
// current task with an "Open in Terminal" shortcut, and the full
// dispatch history. Collapsed by default so the bar stays calm.
//
// All transitions are driven by the autoRunQueue store; this
// component only renders + dispatches user intent (pause/resume/stop/
// dismiss). No timers live here.

import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import {
  autoRunQueue,
  dismissAutoRun,
  pauseAutoRun,
  resumeAutoRun,
  stopAutoRun,
} from "../../stores/autoRunQueue";
import { setActiveTab } from "../../stores/workspace";
import {
  autoRunQueueProgressLabel,
  isAutoRunQueueActive,
  type AutoRunQueue,
} from "../../types/autoRunQueue";
import { PLANFLOW_START_MODES } from "../../types/planflowStartMode";

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

function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function modeLabel(modeId: AutoRunQueue["mode"]): string {
  return PLANFLOW_START_MODES.find((m) => m.id === modeId)?.label ?? modeId;
}

function historyIcon(status: "done" | "failed" | "skipped" | "timeout"): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✕";
    case "timeout":
      return "⏱";
    case "skipped":
      return "⤼";
  }
}

function stateLabelFor(queue: AutoRunQueue): string {
  switch (queue.state) {
    case "scheduled":
      return `Scheduled ${formatRemaining(queue.nextDispatchAt)} (${formatTime(queue.nextDispatchAt)})`;
    case "running":
      return "Running";
    case "verifying_merge":
      return "Verifying PR merge…";
    case "waiting":
      return `Next ${formatRemaining(queue.nextDispatchAt)}`;
    case "paused":
      return "Paused";
    case "stopped":
      return "Stopped";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return queue.state;
  }
}

export function AutoRunBar(props: AutoRunBarProps): JSX.Element {
  const queue = createMemo<AutoRunQueue | null>(() => autoRunQueue(props.workspaceProjectId));
  // Default to expanded so the user sees metadata + history without
  // having to click. The chevron still works to collapse for users
  // who want a quieter strip.
  const [expanded, setExpanded] = createSignal(true);

  const currentTaskId = createMemo((): string | null => {
    const q = queue();
    if (!q) return null;
    if (q.state !== "running" && q.state !== "paused" && q.state !== "verifying_merge") {
      return null;
    }
    return q.currentTaskId ?? null;
  });

  const openInTerminal = (projectId: string): void => {
    setActiveTab(projectId, "terminal");
  };

  // Use a `keyed` Show: the children re-create whenever the queue
  // reference changes. Combined with createMemo above, each child
  // closure sees a single, stable queue snapshot — far simpler than
  // re-deriving via accessors inside the JSX. Solid still re-runs
  // tracked sub-expressions (expanded(), currentTaskId(), etc.) as
  // their own signals change.
  return (
    <Show when={queue()} keyed>
      {(q) => (
        <div
          class="ws-aar-bar"
          role="status"
          aria-live="polite"
          data-state={q.state}
          data-expanded={expanded() ? "true" : undefined}
        >
          <div class="ws-aar-bar__row">
            <button
              type="button"
              class="ws-aar-bar__toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded()}
              aria-label={expanded() ? "Collapse auto-run details" : "Expand auto-run details"}
              title={expanded() ? "Hide details" : "Show details"}
            >
              <span class="ws-aar-bar__icon" aria-hidden="true">
                ⚡
              </span>
              <span class="ws-aar-bar__label">Auto run</span>
              <span class="ws-aar-bar__progress">{autoRunQueueProgressLabel(q)}</span>
              <span class="ws-aar-bar__state">· {stateLabelFor(q)}</span>
              <Show when={currentTaskId()}>
                {(id) => <span class="ws-aar-bar__current">· current: {id()}</span>}
              </Show>
              <span class="ws-aar-bar__chevron" aria-hidden="true">
                {expanded() ? "▴" : "▾"}
              </span>
            </button>
            <div class="ws-aar-bar__actions">
              <Show when={currentTaskId()}>
                <button
                  type="button"
                  class="ws-aar-bar__btn"
                  onClick={() => openInTerminal(q.projectId)}
                  aria-label="Open terminal pane"
                  title="Jump to the terminal tab to watch the agent"
                >
                  ⤴ Terminal
                </button>
              </Show>
              <Show
                when={
                  q.state === "running" || q.state === "waiting" || q.state === "verifying_merge"
                }
              >
                <button
                  type="button"
                  class="ws-aar-bar__btn"
                  onClick={() => pauseAutoRun(q.projectId)}
                  aria-label="Pause auto run"
                  title="Finish current task, then stop dispatching"
                >
                  ⏸ Pause
                </button>
              </Show>
              <Show when={q.state === "paused"}>
                <button
                  type="button"
                  class="ws-aar-bar__btn"
                  onClick={() => resumeAutoRun(q.projectId)}
                  aria-label="Resume auto run"
                  title="Continue from where the queue paused"
                >
                  ▶ Resume
                </button>
              </Show>
              <Show when={isAutoRunQueueActive(q)}>
                <button
                  type="button"
                  class="ws-aar-bar__btn ws-aar-bar__btn--danger"
                  onClick={() => stopAutoRun(q.projectId)}
                  aria-label="Stop auto run"
                  title="Stop the queue entirely"
                >
                  ⏹ Stop
                </button>
              </Show>
              <Show when={!isAutoRunQueueActive(q)}>
                <button
                  type="button"
                  class="ws-aar-bar__btn"
                  onClick={() => dismissAutoRun(q.projectId)}
                  aria-label="Dismiss auto run summary"
                  title="Hide this banner"
                >
                  Dismiss
                </button>
              </Show>
            </div>
          </div>

          <Show when={expanded()}>
            <div class="ws-aar-bar__details">
              <dl class="ws-aar-bar__meta">
                <div class="ws-aar-bar__meta-cell">
                  <dt>Started</dt>
                  <dd>
                    {formatTime(q.createdAt)} · {q.completedCount}/{q.targetCount} done
                  </dd>
                </div>
                <div class="ws-aar-bar__meta-cell">
                  <dt>Mode</dt>
                  <dd>{modeLabel(q.mode)}</dd>
                </div>
                <div class="ws-aar-bar__meta-cell">
                  <dt>Pacing</dt>
                  <dd>
                    {q.pacingMinutes === 0 ? "Back-to-back" : `${q.pacingMinutes} min between`}
                  </dd>
                </div>
                <div class="ws-aar-bar__meta-cell">
                  <dt>Deadline</dt>
                  <dd>{q.deadlineAt === null ? "—" : formatTime(q.deadlineAt)}</dd>
                </div>
                <div class="ws-aar-bar__meta-cell">
                  <dt>On failure</dt>
                  <dd>{q.onFailure === "stop" ? "Stop queue" : "Continue"}</dd>
                </div>
                <Show when={currentTaskId() && q.currentTaskStartedAt !== null}>
                  <div class="ws-aar-bar__meta-cell">
                    <dt>Current</dt>
                    <dd>
                      {currentTaskId()} · running{" "}
                      {formatDuration(q.currentTaskStartedAt ?? 0, null)}
                    </dd>
                  </div>
                </Show>
              </dl>

              <div class="ws-aar-bar__history">
                <div class="ws-aar-bar__history-title">History ({q.history.length})</div>
                <Show
                  when={q.history.length > 0}
                  fallback={<p class="ws-aar-bar__history-empty">No tasks completed yet.</p>}
                >
                  <ol class="ws-aar-bar__history-list">
                    <For each={q.history}>
                      {(entry, i) => (
                        <li class="ws-aar-bar__history-item" data-status={entry.status}>
                          <span class="ws-aar-bar__history-num">{i() + 1}.</span>
                          <span class="ws-aar-bar__history-icon" aria-hidden="true">
                            {historyIcon(entry.status)}
                          </span>
                          <span class="ws-aar-bar__history-id">{entry.taskId}</span>
                          <span class="ws-aar-bar__history-status">{entry.status}</span>
                          <span class="ws-aar-bar__history-time">
                            {formatTime(entry.startedAt)}
                            {entry.finishedAt !== null
                              ? ` → ${formatTime(entry.finishedAt)} · ${formatDuration(entry.startedAt, entry.finishedAt)}`
                              : ""}
                          </span>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

export default AutoRunBar;
