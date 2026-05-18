// Modal that seeds an auto-run queue: pick a count, a mode, a start
// time, optional pacing and deadline, and a failure policy.
//
// Ready-task selection is computed by the parent (LinkedTaskList
// already runs the same predicate to render the "Ready" badge); we
// take that list as a prop so the preview here matches what the row
// rendering decided was actionable.

import { Show, batch, createEffect, createMemo, createSignal, onCleanup, For } from "solid-js";
import type { JSX } from "solid-js";

import { startAutoRun } from "../../stores/autoRunQueue";
import type { AutoRunFailureMode } from "../../types/autoRunQueue";
import type { Task } from "../../integrations/planflow/schemas";
import {
  DEFAULT_PLANFLOW_START_MODE,
  PLANFLOW_START_MODES,
  type PlanFlowStartMode,
} from "../../types/planflowStartMode";

export interface AutoRunDialogProps {
  open: boolean;
  workspaceProjectId: string;
  externalId: string;
  /** Tasks that meet the "ready" predicate (deps DONE + not locked).
   *  Used as the gate for whether Run is enabled — we need at least
   *  one ready task to begin. */
  readyTasks: readonly Task[];
  /** All TODO tasks in plan-id order (T1.5, T1.6, …). Drives the
   *  "Will run" preview: the queue is dynamic, so the actual
   *  dispatch chain walks this list as each predecessor finishes,
   *  even if those later tasks aren't ready yet at t=0. */
  pendingTasks: readonly Task[];
  onCancel: () => void;
  /** Fired after `startAutoRun` succeeds so the parent can close the
   *  dialog and show the bar. */
  onStarted: () => void;
}

type StartWhen = "now" | "later";
type DeadlineWhen = "off" | "today";

const COUNT_CHOICES = [1, 2, 3, 5, 10] as const;
const PACING_CHOICES_MINUTES = [0, 5, 15, 30, 60] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function defaultStartTime(): string {
  // Default the "At" picker to one hour from now, rounded to the next
  // quarter hour. Calmer than "right now" while still feeling soon.
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const minute = Math.ceil(d.getMinutes() / 15) * 15;
  d.setMinutes(minute % 60);
  if (minute === 60) d.setHours(d.getHours() + 1);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function defaultDeadlineTime(): string {
  // Default deadline is end of the workday. Easy to override.
  return "18:00";
}

function combineDateAndTime(date: Date, time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hourStr = match[1] ?? "";
  const minuteStr = match[2] ?? "";
  const hours = Number.parseInt(hourStr, 10);
  const minutes = Number.parseInt(minuteStr, 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const out = new Date(date);
  out.setHours(hours, minutes, 0, 0);
  return out.getTime();
}

export function AutoRunDialog(props: AutoRunDialogProps): JSX.Element {
  const [count, setCount] = createSignal<number>(3);
  const [mode, setMode] = createSignal<PlanFlowStartMode>("pr");
  const [startWhen, setStartWhen] = createSignal<StartWhen>("now");
  const [startTime, setStartTime] = createSignal<string>(defaultStartTime());
  const [pacing, setPacing] = createSignal<number>(0);
  const [deadlineWhen, setDeadlineWhen] = createSignal<DeadlineWhen>("off");
  const [deadlineTime, setDeadlineTime] = createSignal<string>(defaultDeadlineTime());
  const [onFailure, setOnFailure] = createSignal<AutoRunFailureMode>("stop");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Reset to defaults each time the dialog re-opens so a previous
  // cancel doesn't bleed into the next session.
  createEffect(() => {
    if (!props.open) return;
    batch(() => {
      setCount(3);
      setMode(DEFAULT_PLANFLOW_START_MODE === "manual" ? "pr" : DEFAULT_PLANFLOW_START_MODE);
      setStartWhen("now");
      setStartTime(defaultStartTime());
      setPacing(0);
      setDeadlineWhen("off");
      setDeadlineTime(defaultDeadlineTime());
      setOnFailure("stop");
      setSubmitting(false);
      setError(null);
    });
  });

  // Esc / Enter — capture-phase so xterm's hidden textarea doesn't
  // steal the key when a pane is focused (the existing modals follow
  // the same pattern, see DeleteProjectConfirm).
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submitting()) props.onCancel();
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onKey, { capture: true }));
  });

  // The queue dispatches dynamically (re-querying TODOs at each
  // boundary), so the count is capped by *all* pending tasks, not
  // by the subset that's ready right now. We still need at least
  // one currently-ready task to begin — the gate sits in canSubmit.
  const effectiveCount = createMemo(() => Math.min(count(), props.pendingTasks.length));
  const willRun = createMemo(() => props.pendingTasks.slice(0, effectiveCount()));
  const noReady = (): boolean => props.readyTasks.length === 0;
  const noPending = (): boolean => props.pendingTasks.length === 0;

  const computeStartAt = (): number | null => {
    if (startWhen() === "now") return null;
    const time = startTime();
    const today = new Date();
    let stamp = combineDateAndTime(today, time);
    if (stamp === null) return null;
    // If the chosen time is in the past for today, roll to tomorrow.
    if (stamp <= Date.now()) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      stamp = combineDateAndTime(tomorrow, time);
    }
    return stamp;
  };

  const computeDeadlineAt = (): number | null => {
    if (deadlineWhen() === "off") return null;
    const stamp = combineDateAndTime(new Date(), deadlineTime());
    return stamp;
  };

  const canSubmit = (): boolean => {
    if (submitting()) return false;
    if (effectiveCount() === 0) return false;
    // For "Now" start, we need at least one ready task to dispatch on
    // t=0. For "later" we trust that something will be ready by then.
    if (startWhen() === "now" && props.readyTasks.length === 0) return false;
    if (startWhen() === "later" && computeStartAt() === null) return false;
    return true;
  };

  const handleSubmit = (): void => {
    if (!canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      startAutoRun({
        workspaceProjectId: props.workspaceProjectId,
        externalId: props.externalId,
        targetCount: effectiveCount(),
        mode: mode(),
        startAt: computeStartAt(),
        pacingMinutes: pacing(),
        deadlineAt: computeDeadlineAt(),
        onFailure: onFailure(),
      });
      props.onStarted();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      setError(detail);
      setSubmitting(false);
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="ws-aar__backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target && !submitting()) props.onCancel();
        }}
      >
        <div
          class="ws-aar"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ws-aar-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class="ws-aar__head">
            <h2 class="ws-aar__title" id="ws-aar-title">
              Auto run tasks
            </h2>
            <button
              type="button"
              class="ws-aar__close"
              aria-label="Close"
              onClick={() => {
                if (!submitting()) props.onCancel();
              }}
            >
              ✕
            </button>
          </div>

          <div class="ws-aar__body">
            <Show
              when={!noPending()}
              fallback={
                <p class="ws-aar__empty">
                  No TODO tasks left in this project. Create more tasks on planflow.tools or unblock
                  the ones in BLOCKED to use auto-run.
                </p>
              }
            >
              <div class="ws-aar__row">
                <label class="ws-aar__label" for="ws-aar-count">
                  How many
                </label>
                <select
                  id="ws-aar-count"
                  class="ws-aar__select"
                  value={count()}
                  onChange={(e) => setCount(Number.parseInt(e.currentTarget.value, 10))}
                >
                  <For each={COUNT_CHOICES}>
                    {(n) => (
                      <option value={n} disabled={n > props.pendingTasks.length}>
                        {n} task{n === 1 ? "" : "s"}
                        {n > props.pendingTasks.length ? " (not enough)" : ""}
                      </option>
                    )}
                  </For>
                </select>
              </div>

              <Show when={noReady()}>
                <p class="ws-aar__error" role="alert">
                  No tasks are ready right now (every TODO is locked or its dependencies aren't DONE
                  yet). Auto-run needs at least one task it can pick up immediately.
                </p>
              </Show>

              <div class="ws-aar__row">
                <label class="ws-aar__label" for="ws-aar-mode">
                  Mode (all tasks)
                </label>
                <select
                  id="ws-aar-mode"
                  class="ws-aar__select"
                  value={mode()}
                  onChange={(e) => setMode(e.currentTarget.value as PlanFlowStartMode)}
                >
                  <For each={PLANFLOW_START_MODES}>
                    {(opt) => <option value={opt.id}>{opt.label}</option>}
                  </For>
                </select>
              </div>

              <fieldset class="ws-aar__group">
                <legend class="ws-aar__legend">When to start</legend>
                <label class="ws-aar__radio">
                  <input
                    type="radio"
                    name="ws-aar-start"
                    checked={startWhen() === "now"}
                    onChange={() => setStartWhen("now")}
                  />
                  Now
                </label>
                <label class="ws-aar__radio">
                  <input
                    type="radio"
                    name="ws-aar-start"
                    checked={startWhen() === "later"}
                    onChange={() => setStartWhen("later")}
                  />
                  At
                  <input
                    type="time"
                    class="ws-aar__time"
                    value={startTime()}
                    disabled={startWhen() !== "later"}
                    onInput={(e) => setStartTime(e.currentTarget.value)}
                  />
                  <span class="ws-aar__hint">(rolls to tomorrow if past)</span>
                </label>
              </fieldset>

              <div class="ws-aar__row">
                <label class="ws-aar__label" for="ws-aar-pacing">
                  Pacing between tasks
                </label>
                <select
                  id="ws-aar-pacing"
                  class="ws-aar__select"
                  value={pacing()}
                  onChange={(e) => setPacing(Number.parseInt(e.currentTarget.value, 10))}
                >
                  <For each={PACING_CHOICES_MINUTES}>
                    {(m) => (
                      <option value={m}>{m === 0 ? "Back-to-back (0 min)" : `${m} min`}</option>
                    )}
                  </For>
                </select>
              </div>

              <fieldset class="ws-aar__group">
                <legend class="ws-aar__legend">Deadline (optional)</legend>
                <label class="ws-aar__radio">
                  <input
                    type="radio"
                    name="ws-aar-deadline"
                    checked={deadlineWhen() === "off"}
                    onChange={() => setDeadlineWhen("off")}
                  />
                  No deadline
                </label>
                <label class="ws-aar__radio">
                  <input
                    type="radio"
                    name="ws-aar-deadline"
                    checked={deadlineWhen() === "today"}
                    onChange={() => setDeadlineWhen("today")}
                  />
                  Stop after
                  <input
                    type="time"
                    class="ws-aar__time"
                    value={deadlineTime()}
                    disabled={deadlineWhen() !== "today"}
                    onInput={(e) => setDeadlineTime(e.currentTarget.value)}
                  />
                  today
                </label>
              </fieldset>

              <fieldset class="ws-aar__group">
                <legend class="ws-aar__legend">On failure</legend>
                <label class="ws-aar__radio">
                  <input
                    type="radio"
                    name="ws-aar-fail"
                    checked={onFailure() === "stop"}
                    onChange={() => setOnFailure("stop")}
                  />
                  Stop queue
                </label>
                <label class="ws-aar__radio">
                  <input
                    type="radio"
                    name="ws-aar-fail"
                    checked={onFailure() === "continue"}
                    onChange={() => setOnFailure("continue")}
                  />
                  Continue
                </label>
              </fieldset>

              <div class="ws-aar__preview">
                <div class="ws-aar__preview-title">
                  Will run ({effectiveCount()}) — picked in plan order
                </div>
                <ol class="ws-aar__preview-list">
                  <For each={willRun()}>
                    {(task, i) => (
                      <li>
                        <span class="ws-aar__preview-num">{i() + 1}.</span>{" "}
                        <span class="ws-aar__preview-id">{task.taskId}</span>{" "}
                        <span class="ws-aar__preview-name">{task.name}</span>
                      </li>
                    )}
                  </For>
                </ol>
              </div>
            </Show>

            <Show when={error()}>
              <p class="ws-aar__error" role="alert">
                {error()}
              </p>
            </Show>
          </div>

          <footer class="ws-aar__foot">
            <button
              type="button"
              class="ws-apm__btn ws-apm__btn--ghost"
              onClick={() => {
                if (!submitting()) props.onCancel();
              }}
              disabled={submitting()}
            >
              Cancel
            </button>
            <button
              type="button"
              class="ws-apm__btn ws-apm__btn--primary"
              disabled={!canSubmit()}
              onClick={handleSubmit}
            >
              ▶ Run
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

export default AutoRunDialog;
