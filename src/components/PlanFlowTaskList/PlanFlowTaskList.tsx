// T12.3 — PlanFlow task list view.
//
// Mounted as the body of a project workspace's PlanFlow tab. Resolves
// the linked PlanFlow project via T11.5's `project_links` row, builds a
// renderer-side PlanFlowClient (T12.1), and renders the project's tasks
// grouped by status: TODO, IN_PROGRESS, BLOCKED, DONE (DONE collapsed
// by default).
//
// Filter bar:
//   - Search input (matches task ID, name, and acceptance text).
//   - Phase filter: "All phases" or one of the phases present in the
//     loaded task set. Single-select chip group; "Current phase" lands
//     when a focused-task signal exists (deferred — chip just toggles
//     between All / per-phase for now).
//
// Per-row visuals (DESIGN_PROMPT_PHASE2.md §1.5):
//   - ID badge ("T12.3") · name · complexity dot · deps count chip ·
//     assignee avatar · 🔒 lock pill (with locker name on hover when
//     known).
//
// States routed through T11.7 primitives:
//   - Loading       → <SkeletonRows />
//   - No link yet   → <EmptyState variant="muted" /> with "Open Settings" CTA
//   - No token yet  → same, but copy says "Connect PlanFlow"
//   - No tasks      → <EmptyState /> nudging the user to open the project
//                     on planflow.tools
//   - Fetch error   → <ErrorCard /> with Retry + Open Settings actions
//
// Performance target: 90+ tasks should render in <300ms. We pre-bucket
// tasks by status in a single createMemo, render the DONE group lazily
// (it only mounts when expanded), and stick to plain `<For />` so each
// row keys by `task.id` — no virtualisation needed at this scale.

import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";
import type { JSX, Resource } from "solid-js";

import { EmptyState, ErrorCard, SkeletonRows } from "../AsyncStates";
import { Tooltip } from "../Tooltip";
import { showToast } from "../Toast";
import {
  createRendererPlanFlowClient,
  MissingPlanFlowTokenError,
  PlanFlowApiError,
  PlanFlowAuthError,
  PlanFlowClient,
  PlanFlowConflictError,
  PlanFlowParseError,
  startTask,
  usePlanFlowLink,
  type Me,
  type Task,
  type TaskComplexity,
  type TaskStatus,
} from "../../integrations";
import { activeTaskId } from "../../stores/activeTask";
import { ActiveWorkPanel } from "./ActiveWorkPanel";
import { ActivityFeed } from "./ActivityFeed";

const ROW_FLASH_CLASS = "ws-pf-tasks__row--flash";
const ROW_FLASH_DURATION_MS = 1400;

const STATUS_ORDER: readonly TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
  DROPPED: "Dropped",
};

const COMPLEXITY_LABEL: Record<TaskComplexity, string> = {
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "Extra-large",
};

export interface PlanFlowTaskListProps {
  /** Workspace projectId. Used to resolve the linked PlanFlow project. */
  projectId: string;
  /** Opens Settings → Integrations. The view CTAs both the "not linked"
   *  and "needs token" empty states through this. */
  onOpenSettings?: () => void;
}

export function PlanFlowTaskList(props: PlanFlowTaskListProps): JSX.Element {
  const projectIdAccessor = (): string => props.projectId;
  const link = usePlanFlowLink(projectIdAccessor);
  const workspaceProjectId = (): string => props.projectId;

  return (
    <div class="ws-pf-tasks" role="region" aria-label="PlanFlow tasks">
      <Show
        when={!link.loading}
        fallback={
          <div class="ws-pf-tasks__loading">
            <SkeletonRows rows={6} ariaLabel="Loading PlanFlow link" />
          </div>
        }
      >
        <Show
          when={link()}
          fallback={
            <EmptyState
              variant="muted"
              title="PlanFlow not linked"
              description="Link this workspace project to a PlanFlow project in Settings → Integrations to see its task list here."
              primaryAction={
                props.onOpenSettings
                  ? { label: "Open Settings", onClick: () => props.onOpenSettings?.() }
                  : undefined
              }
              ariaLabel="PlanFlow not linked"
            />
          }
        >
          {(linked) => (
            <LinkedTaskList
              workspaceProjectId={workspaceProjectId()}
              externalId={linked().externalId}
              onOpenSettings={props.onOpenSettings}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

interface LinkedTaskListProps {
  workspaceProjectId: string;
  externalId: string;
  onOpenSettings?: () => void;
}

interface TaskListController {
  jumpToTask: (taskId: string) => void;
}

function LinkedTaskList(props: LinkedTaskListProps): JSX.Element {
  // Single client instance for this view. The factory wraps every call
  // in the T11.8 reauth guard. We deliberately don't enable the cache
  // layer here so a manual Retry always hits the network.
  const client = createRendererPlanFlowClient();
  const [reloadKey, setReloadKey] = createSignal(0);

  const [tasks, { refetch }] = createResource(
    () => ({ externalId: props.externalId, reloadKey: reloadKey() }),
    async (input): Promise<Task[]> => {
      return await client.listTasks(input.externalId);
    },
  );

  // T12.4 — `Me` is needed once per view so the Start button can detect
  // whether the lock is held by *us* (button label flips to "Resume",
  // still actionable) or by another user (button disabled, tooltip names
  // the holder). Best-effort: on failure we fall back to a conservative
  // rule that disables Start whenever any lockedBy is set.
  const [me] = createResource(
    () => props.externalId,
    async (): Promise<Me | null> => {
      try {
        return await client.getMe();
      } catch {
        return null;
      }
    },
  );

  const retry = (): void => {
    setReloadKey((k) => k + 1);
    void refetch();
  };

  let controller: TaskListController | null = null;
  const bindController = (c: TaskListController): void => {
    controller = c;
  };
  const jumpToTask = (taskId: string): void => {
    controller?.jumpToTask(taskId);
  };

  return (
    <div class="ws-pf-tasks__shell">
      <div class="ws-pf-tasks__main">
        <div class="ws-pf-tasks__body">
          <Switch>
            <Match when={tasks.loading}>
              <div class="ws-pf-tasks__loading">
                <SkeletonRows rows={8} ariaLabel="Loading PlanFlow tasks" />
              </div>
            </Match>
            <Match when={tasks.error}>
              <TaskFetchError
                error={tasks.error as unknown}
                onRetry={retry}
                onOpenSettings={props.onOpenSettings}
              />
            </Match>
            <Match when={tasks()}>
              {(loaded) => (
                <TaskListBody
                  tasks={loaded()}
                  onOpenSettings={props.onOpenSettings}
                  onRetry={retry}
                  bindController={bindController}
                  client={client}
                  workspaceProjectId={props.workspaceProjectId}
                  externalId={props.externalId}
                  me={me()}
                />
              )}
            </Match>
          </Switch>
        </div>
        <ActiveWorkPanel externalId={props.externalId} onJumpToTask={jumpToTask} />
      </div>
      <ActivityFeed externalId={props.externalId} onJumpToTask={jumpToTask} />
    </div>
  );
}

interface TaskFetchErrorProps {
  error: unknown;
  onRetry: () => void;
  onOpenSettings?: () => void;
}

function TaskFetchError(props: TaskFetchErrorProps): JSX.Element {
  const isMissingToken = (): boolean => props.error instanceof MissingPlanFlowTokenError;
  const isAuthError = (): boolean => props.error instanceof PlanFlowAuthError;

  return (
    <Switch
      fallback={
        <ErrorCard
          title="Couldn't load tasks"
          message={describeError(props.error)}
          onRetry={props.onRetry}
          secondary={
            props.onOpenSettings
              ? { label: "Open Settings", onClick: () => props.onOpenSettings?.() }
              : undefined
          }
        />
      }
    >
      <Match when={isMissingToken()}>
        <EmptyState
          variant="muted"
          title="Connect PlanFlow to load tasks"
          description="Paste your PlanFlow token in Settings → Integrations. It's stored in the OS keychain — never round-trips through a server."
          primaryAction={
            props.onOpenSettings
              ? { label: "Open Settings", onClick: () => props.onOpenSettings?.() }
              : undefined
          }
          ariaLabel="PlanFlow not connected"
        />
      </Match>
      <Match when={isAuthError()}>
        {/* T11.8 will have already flipped the reauth banner — the inline
            error card here just gives the user a direct path back. */}
        <ErrorCard
          title="Token rejected"
          message="PlanFlow rejected the saved token. Paste a fresh one in Settings to reconnect."
          secondary={
            props.onOpenSettings
              ? { label: "Open Settings", onClick: () => props.onOpenSettings?.() }
              : undefined
          }
          onRetry={props.onRetry}
        />
      </Match>
    </Switch>
  );
}

interface TaskListBodyProps {
  tasks: readonly Task[];
  onOpenSettings?: () => void;
  onRetry: () => void;
  bindController?: (controller: TaskListController) => void;
  client: PlanFlowClient;
  workspaceProjectId: string;
  externalId: string;
  me: Me | null | undefined;
}

function TaskListBody(props: TaskListBodyProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [phase, setPhase] = createSignal<string | null>(null);
  const [doneExpanded, setDoneExpanded] = createSignal(false);

  let scrollHostRef: HTMLDivElement | undefined;

  const jumpToTask = (taskId: string): void => {
    // Clearing filters here is intentional: an active worker on a task
    // hidden by a phase/search filter should still surface when its row
    // is clicked from the side rail — otherwise the click would feel
    // dead. We also force-expand the DONE group in case the task has
    // already been completed.
    setQuery("");
    setPhase(null);
    setDoneExpanded(true);

    const focusRow = (): void => {
      const host = scrollHostRef;
      if (!host) return;
      const row = host.querySelector<HTMLElement>(`[data-task-id="${cssEscape(taskId)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      row.classList.add(ROW_FLASH_CLASS);
      window.setTimeout(() => {
        row.classList.remove(ROW_FLASH_CLASS);
      }, ROW_FLASH_DURATION_MS);
    };

    // Wait a frame so filter resets above commit to the DOM before we
    // look up the row — otherwise the row may still be hidden behind a
    // stale filter pass.
    queueMicrotask(() => requestAnimationFrame(focusRow));
  };

  onMount(() => {
    props.bindController?.({ jumpToTask });
  });

  const phases = createMemo<readonly string[]>(() => {
    const seen = new Set<string>();
    for (const task of props.tasks) {
      const value = normalizePhase(task.phase);
      if (value != null) seen.add(value);
    }
    return Array.from(seen).sort(comparePhases);
  });

  const filtered = createMemo<readonly Task[]>(() => {
    const q = query().trim().toLowerCase();
    const selectedPhase = phase();
    if (!q && selectedPhase == null) return props.tasks;
    return props.tasks.filter((task) => {
      if (selectedPhase != null && normalizePhase(task.phase) !== selectedPhase) return false;
      if (!q) return true;
      if (task.id.toLowerCase().includes(q)) return true;
      if (task.name.toLowerCase().includes(q)) return true;
      const acceptance = typeof task.acceptance === "string" ? task.acceptance : "";
      if (acceptance && acceptance.toLowerCase().includes(q)) return true;
      return false;
    });
  });

  const grouped = createMemo<Record<TaskStatus, Task[]>>(() => {
    const buckets: Record<TaskStatus, Task[]> = {
      TODO: [],
      IN_PROGRESS: [],
      BLOCKED: [],
      DONE: [],
      DROPPED: [],
    };
    for (const task of filtered()) {
      // DROPPED rolls into DONE visually — same "archived" treatment so
      // groups stay at four. Schema keeps DROPPED separate for the
      // mutation paths.
      const bucket = task.status === "DROPPED" ? "DONE" : task.status;
      buckets[bucket].push(task);
    }
    return buckets;
  });

  const totalShown = createMemo(() => filtered().length);
  const empty = (): boolean => totalShown() === 0;
  const noTasksAtAll = (): boolean => props.tasks.length === 0;

  return (
    <div class="ws-pf-tasks__layout">
      <div class="ws-pf-tasks__toolbar" role="search">
        <input
          type="search"
          class="ws-pf-tasks__search"
          placeholder="Search tasks by ID or name…"
          aria-label="Search PlanFlow tasks"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          spellcheck={false}
          autocomplete="off"
        />
        <div class="ws-pf-tasks__phases" role="radiogroup" aria-label="Phase filter">
          <PhaseChip label="All phases" active={phase() == null} onClick={() => setPhase(null)} />
          <For each={phases()}>
            {(value) => (
              <PhaseChip
                label={formatPhaseLabel(value)}
                active={phase() === value}
                onClick={() => setPhase(phase() === value ? null : value)}
              />
            )}
          </For>
        </div>
        <button
          type="button"
          class="ws-pf-tasks__refresh"
          onClick={() => props.onRetry()}
          aria-label="Refresh task list"
          title="Refresh"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>

      <Show
        when={!empty()}
        fallback={
          <Show
            when={noTasksAtAll()}
            fallback={
              <EmptyState
                variant="muted"
                title="No tasks match"
                description="Try a different search term or clear the phase filter."
                primaryAction={{
                  label: "Clear filters",
                  onClick: () => {
                    setQuery("");
                    setPhase(null);
                  },
                }}
                ariaLabel="No tasks match"
              />
            }
          >
            <EmptyState
              variant="muted"
              title="No tasks yet"
              description="Open this project on planflow.tools to plan tasks — they'll show up here automatically."
              ariaLabel="No tasks yet"
            />
          </Show>
        }
      >
        <div class="ws-pf-tasks__groups" ref={scrollHostRef}>
          <For each={STATUS_ORDER}>
            {(status) => {
              const bucket = (): Task[] => grouped()[status];
              const count = (): number => bucket().length;
              const isDoneGroup = status === "DONE";
              const expanded = (): boolean => (isDoneGroup ? doneExpanded() : true);
              return (
                <Show when={count() > 0}>
                  <section
                    class="ws-pf-tasks__group"
                    data-status={status}
                    aria-label={`${STATUS_LABELS[status]} (${count()})`}
                  >
                    <button
                      type="button"
                      class="ws-pf-tasks__group-head"
                      onClick={() => {
                        if (!isDoneGroup) return;
                        setDoneExpanded((v) => !v);
                      }}
                      data-collapsible={isDoneGroup ? "true" : undefined}
                      aria-expanded={isDoneGroup ? expanded() : undefined}
                    >
                      <span
                        class="ws-pf-tasks__group-dot"
                        data-status={status}
                        aria-hidden="true"
                      />
                      <span class="ws-pf-tasks__group-label">{STATUS_LABELS[status]}</span>
                      <span class="ws-pf-tasks__group-count">{count()}</span>
                      <Show when={isDoneGroup}>
                        <span class="ws-pf-tasks__group-chevron" aria-hidden="true">
                          {expanded() ? "▾" : "▸"}
                        </span>
                      </Show>
                    </button>
                    <Show when={expanded()}>
                      <ul class="ws-pf-tasks__rows" role="list">
                        <For each={bucket()}>
                          {(task) => (
                            <TaskRow
                              task={task}
                              meUserId={props.me?.id ?? null}
                              activeTaskId={activeTaskId(props.workspaceProjectId)}
                              onStart={(t) =>
                                void runStartTask(
                                  props.client,
                                  props.externalId,
                                  props.workspaceProjectId,
                                  t,
                                  props.onRetry,
                                )
                              }
                            />
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface PhaseChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function PhaseChip(props: PhaseChipProps): JSX.Element {
  return (
    <button
      type="button"
      class="ws-pf-tasks__chip"
      role="radio"
      aria-checked={props.active}
      data-on={props.active ? "true" : undefined}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}

interface TaskRowProps {
  task: Task;
  /** Current user id. `null` when `/me` failed — falls back to disabling
   *  Start whenever *any* user (incl. self) holds the lock. */
  meUserId: string | null;
  /** Active in-progress task id for this project. Used to mark the row
   *  when it matches `task.id` so the badge styling lights up. */
  activeTaskId: string | null;
  onStart: (task: Task) => void;
}

function TaskRow(props: TaskRowProps): JSX.Element {
  const depCount = (): number => props.task.dependencies?.length ?? 0;
  const complexity = (): TaskComplexity | null => props.task.complexity ?? null;
  const lockerId = (): string | null => props.task.lockedBy?.id ?? null;
  const lockedBy = (): string | null => {
    const locker = props.task.lockedBy;
    if (!locker) return null;
    return locker.name?.trim() || locker.email || "another user";
  };
  const lockedBySelf = (): boolean => {
    const meId = props.meUserId;
    const lid = lockerId();
    return meId !== null && lid !== null && meId === lid;
  };
  const lockedByOther = (): boolean => lockedBy() !== null && !lockedBySelf();
  const isActive = (): boolean => props.activeTaskId === props.task.id;
  const isDone = (): boolean => props.task.status === "DONE" || props.task.status === "DROPPED";
  // Hide Start on already-finished rows; it's still useful on IN_PROGRESS
  // when the user is the locker (re-arm the terminal nudge).
  const showStart = (): boolean => !isDone();
  const startDisabled = (): boolean => lockedByOther();
  const startLabel = (): string => (isActive() || lockedBySelf() ? "Resume" : "Start working");
  const assignee = (): string | null => {
    const a = props.task.assignee;
    if (!a) return null;
    return a.name?.trim() || a.email || null;
  };

  return (
    <li
      class="ws-pf-tasks__row"
      id={`ws-pf-task-${props.task.id}`}
      data-task-id={props.task.id}
      data-status={props.task.status}
      data-locked={lockedBy() ? "true" : undefined}
      data-active-task={isActive() ? "true" : undefined}
    >
      <span class="ws-pf-tasks__id" aria-label={`Task ${props.task.id}`}>
        {props.task.id}
      </span>
      <span class="ws-pf-tasks__name" title={props.task.name}>
        {props.task.name}
      </span>
      <Show when={complexity()}>
        {(c) => (
          <Tooltip label={`${COMPLEXITY_LABEL[c()]} complexity`}>
            <span class="ws-pf-tasks__cx" data-cx={c()} aria-hidden="true" />
          </Tooltip>
        )}
      </Show>
      <Show when={depCount() > 0}>
        <Tooltip label={`Depends on ${depCount()} task${depCount() === 1 ? "" : "s"}`}>
          <span class="ws-pf-tasks__deps" aria-label={`${depCount()} dependencies`}>
            ⛓ {depCount()}
          </span>
        </Tooltip>
      </Show>
      <Show when={assignee()}>
        {(name) => (
          <Tooltip label={`Assigned to ${name()}`}>
            <span class="ws-pf-tasks__avatar" aria-hidden="true">
              {initials(name())}
            </span>
          </Tooltip>
        )}
      </Show>
      <Show when={lockedBy()}>
        {(who) => (
          <Tooltip label={`Locked by ${who()}`}>
            <span class="ws-pf-tasks__lock" aria-label={`Locked by ${who()}`}>
              <span aria-hidden="true">🔒</span>
            </span>
          </Tooltip>
        )}
      </Show>
      <Show when={showStart()}>
        <button
          type="button"
          class="ws-pf-tasks__start"
          data-active={isActive() ? "true" : undefined}
          disabled={startDisabled()}
          aria-label={
            startDisabled()
              ? `${startLabel()} on ${props.task.id} — locked by ${lockedBy()}`
              : `${startLabel()} on ${props.task.id}`
          }
          title={
            startDisabled()
              ? `Locked by ${lockedBy() ?? "another user"}`
              : isActive()
                ? "In progress — switch to terminal and re-prime the command"
                : "Acquire lock, set IN_PROGRESS, and pre-fill the checkout command"
          }
          onClick={(e) => {
            e.stopPropagation();
            if (startDisabled()) return;
            props.onStart(props.task);
          }}
        >
          {startLabel()}
        </button>
      </Show>
    </li>
  );
}

// T12.4 — Wraps `startTask` for the row's click handler. On success we
// refetch the task list so `lockedBy = me` shows up. On
// PlanFlowConflictError we toast "locked by …" and refetch so the row
// updates with the real holder. Auth errors are handled by the reauth
// guard elsewhere; we just surface a short note.
async function runStartTask(
  client: PlanFlowClient,
  externalId: string,
  workspaceProjectId: string,
  task: Task,
  onRetry: () => void,
): Promise<void> {
  try {
    const result = await startTask({ client, externalId, workspaceProjectId, taskId: task.id });
    if (result.branchName === null) {
      showToast({
        message: `Started ${task.id} — couldn't fetch branch name. Run \`git checkout -b\` manually.`,
        variant: "warning",
      });
    } else if (!result.prefilled) {
      showToast({
        message: `Started ${task.id}. Open a terminal pane to run: git checkout -b ${result.branchName}`,
        variant: "info",
      });
    } else {
      showToast({
        message: `${task.id} in progress — press Enter to create branch ${result.branchName}.`,
        variant: "success",
      });
    }
  } catch (error) {
    if (error instanceof PlanFlowConflictError) {
      showToast({
        message: `${task.id} is already locked by another user.`,
        variant: "warning",
      });
    } else if (error instanceof PlanFlowAuthError) {
      showToast({
        message: "PlanFlow rejected the token. Reconnect in Settings.",
        variant: "error",
      });
    } else {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      showToast({ message: `Couldn't start ${task.id}: ${detail}`, variant: "error" });
    }
  } finally {
    onRetry();
  }
}

function normalizePhase(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function comparePhases(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}

function formatPhaseLabel(value: string): string {
  return /^\d+$/.test(value) ? `Phase ${value}` : value;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const single = parts[0];
    if (!single) return "?";
    return single.slice(0, 2).toUpperCase();
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const a = first ? (first[0] ?? "") : "";
  const b = last ? (last[0] ?? "") : "";
  return (a + b).toUpperCase() || "?";
}

function cssEscape(value: string): string {
  // Task IDs are well-formed ("T12.3", "T7.10"), but CSS.escape is the
  // belt-and-braces guard — periods would otherwise read as class
  // selectors inside querySelector. Falls back to a manual escape on
  // platforms where CSS.escape is missing (older WebKit, jsdom).
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function describeError(error: unknown): string {
  if (error instanceof PlanFlowApiError) {
    return `PlanFlow responded with HTTP ${error.status}. Try again or check status.planflow.tools.`;
  }
  if (error instanceof PlanFlowParseError) {
    return "PlanFlow returned an unexpected response shape.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unexpected error contacting PlanFlow.";
}

export default PlanFlowTaskList;

// Surfaced for typing in tests / harnesses.
export type { Task as PlanFlowTask };
export type _PlanFlowTaskListResource = Resource<readonly Task[]>;
