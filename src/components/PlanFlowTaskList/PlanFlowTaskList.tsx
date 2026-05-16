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
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX, Resource } from "solid-js";

import { EmptyState, ErrorCard, SkeletonRows } from "../AsyncStates";
import type { PaneCliOption } from "../Pane";
import { Tooltip } from "../Tooltip";
import { showToast } from "../Toast";
import {
  createRendererPlanFlowClient,
  finishTask,
  formatCommitMessage,
  markProgress,
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

type MeUser = Me["user"];
import { activeTaskId, setActiveTaskId } from "../../stores/activeTask";
import { consumeTaskJump, pendingTaskJump } from "../../stores/pendingTaskJump";
import { planflowChatRefetchTick } from "../../stores/planflowChatNotify";
import { ActiveWorkPanel } from "./ActiveWorkPanel";
import { ActivityFeed } from "./ActivityFeed";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { PlanFlowChat } from "../PlanFlowChat";

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
  /** Available CLIs for the split-button CLI picker on Start. When more
   *  than one CLI is available a ▾ chevron appears next to Start so the
   *  user can choose which CLI to launch for this task. */
  clis?: readonly PaneCliOption[];
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
              clis={props.clis ?? []}
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
  clis?: readonly PaneCliOption[];
}

interface TaskListController {
  jumpToTask: (taskId: string) => void;
}

function LinkedTaskList(props: LinkedTaskListProps): JSX.Element {
  // Single client instance for this view. The factory wraps every call
  // in the T11.8 reauth guard. We deliberately don't enable the cache
  // layer here so a manual Retry always hits the network.
  // T19.35 — scope the client to the workspace project so routed
  // `planflow_*` WS calls ship `cloud_project_id` and the cloud-agent's
  // per-project token resolver (T19.34) picks the right account. The
  // parent `<Show when={link()}>` remounts this component when the
  // workspace projectId changes, so the captured value is always live.
  // eslint-disable-next-line solid/reactivity
  const client = createRendererPlanFlowClient({ cloudProjectId: props.workspaceProjectId });
  const [reloadKey, setReloadKey] = createSignal(0);

  const [tasks, { refetch }] = createResource(
    () => ({
      externalId: props.externalId,
      reloadKey: reloadKey(),
      // Phase 5 — re-run whenever the chat bridge bumps the per-project
      // refetch tick. The tick fires after an assistant turn that
      // invoked a planflow_* tool, so any plan/task mutation the CLI
      // made shows up here without the user manually pressing refresh.
      chatTick: planflowChatRefetchTick(props.workspaceProjectId),
    }),
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
    async (): Promise<MeUser | null> => {
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

  const [controller, setController] = createSignal<TaskListController | null>(null);
  const bindController = (c: TaskListController): void => {
    setController(c);
  };
  const jumpToTask = (taskId: string): void => {
    controller()?.jumpToTask(taskId);
  };

  // T12.8 — Detail panel selection. Clicking a row opens the side panel
  // for that task; clicking the close button (or selecting the same row
  // again) clears it. Jumping to a task from any rail also focuses the
  // detail view so the user lands on the same context.
  const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null);
  const handleSelect = (taskId: string): void => {
    setSelectedTaskId((prev) => (prev === taskId ? null : taskId));
  };
  const handleJump = (taskId: string): void => {
    setSelectedTaskId(taskId);
    jumpToTask(taskId);
  };
  const handleCloseDetail = (): void => {
    setSelectedTaskId(null);
  };

  // T12.9 — cross-project notification clicks land a pending jump in the
  // store before this view is mounted (or before its task list resolves).
  // Drain it once the controller is ready so the bell's "click → switch
  // project → open task" path scrolls/flashes the row AND opens the
  // T12.8 task-detail panel for the target.
  createEffect(() => {
    const pending = pendingTaskJump(props.workspaceProjectId);
    const ctrl = controller();
    if (pending == null || ctrl == null) return;
    handleJump(pending);
    consumeTaskJump(props.workspaceProjectId);
  });

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
                  selectedTaskId={selectedTaskId()}
                  onSelectTask={handleSelect}
                  clis={props.clis ?? []}
                />
              )}
            </Match>
          </Switch>
        </div>
        <Show
          when={selectedTaskId() != null}
          fallback={
            <ActiveWorkPanel
              externalId={props.externalId}
              workspaceProjectId={props.workspaceProjectId}
              onJumpToTask={handleJump}
            />
          }
        >
          <TaskDetailPanel
            client={client}
            externalId={props.externalId}
            taskId={selectedTaskId() as string}
            tasks={tasks() ?? []}
            me={me()}
            onClose={handleCloseDetail}
            onJumpToTask={handleJump}
          />
        </Show>
      </div>
      <ActivityFeed
        externalId={props.externalId}
        workspaceProjectId={props.workspaceProjectId}
        onJumpToTask={handleJump}
      />
      <PlanFlowChat projectId={props.workspaceProjectId} externalId={props.externalId} />
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
  me: MeUser | null | undefined;
  /** T12.8 — currently selected task for the detail side panel. */
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  clis?: readonly PaneCliOption[];
}

interface ActionDialogState {
  task: Task;
  kind: "progress" | "done";
}

type TaskView = "list" | "kanban";

/** Persist the user's preferred view across mounts so re-opening the
 *  PlanFlow tab lands them on the same layout they last used. Stored at
 *  module scope rather than localStorage; the value is cheap to lose and
 *  the trade-off keeps Kanban out of the SQLite settings table for the
 *  first iteration. */
let lastView: TaskView = "list";

function TaskListBody(props: TaskListBodyProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [phase, setPhase] = createSignal<string | null>(null);
  const [view, setViewState] = createSignal<TaskView>(lastView);
  const setView = (next: TaskView): void => {
    lastView = next;
    setViewState(next);
  };
  const [doneExpanded, setDoneExpanded] = createSignal(false);
  // T12.5 — open dialog state for the Progress / Done flows. `null` while
  // closed. Submission lives inside <TaskActionDialog>; this signal just
  // tracks which row triggered it.
  const [actionDialog, setActionDialog] = createSignal<ActionDialogState | null>(null);

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
      if (task.taskId.toLowerCase().includes(q)) return true;
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
    // Sort each bucket by task id ("T1.1", "T1.2", "T2.1", …) so phase /
    // sub-task ordering is stable across renders and matches the order
    // the plan was authored in. PlanFlow returns tasks in updatedAt
    // order by default, which flips rows around as the user clicks them.
    for (const status of Object.keys(buckets) as TaskStatus[]) {
      buckets[status] = [...buckets[status]].sort((a, b) => compareTaskIds(a.taskId, b.taskId));
    }
    return buckets;
  });

  // "Ready to start" — tasks the user can pick up *right now*: TODO,
  // every declared dependency is DONE, and no one else holds the lock.
  // Membership is reactive so the highlight clears as soon as the user
  // (or anyone else) starts the task or its blockers complete. We
  // compare by taskId because that's how `dependencies` are encoded.
  const doneIds = createMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const task of props.tasks) {
      if (task.status === "DONE" || task.status === "DROPPED") ids.add(task.taskId);
    }
    return ids;
  });
  const readyIds = createMemo<ReadonlySet<string>>(() => {
    const done = doneIds();
    const me = props.me?.id ?? null;
    const ready = new Set<string>();
    for (const task of props.tasks) {
      if (task.status !== "TODO") continue;
      const deps = task.dependencies ?? [];
      if (deps.length > 0 && !deps.every((d) => done.has(d))) continue;
      const lockerId = task.lockedBy?.id ?? null;
      if (lockerId !== null && lockerId !== me) continue;
      ready.add(task.taskId);
    }
    return ready;
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
        <div class="ws-pf-tasks__view-toggle" role="radiogroup" aria-label="Task view">
          <button
            type="button"
            class="ws-pf-tasks__view-btn"
            role="radio"
            aria-checked={view() === "list"}
            data-on={view() === "list" ? "true" : undefined}
            onClick={() => setView("list")}
            title="List view (grouped by status)"
          >
            List
          </button>
          <button
            type="button"
            class="ws-pf-tasks__view-btn"
            role="radio"
            aria-checked={view() === "kanban"}
            data-on={view() === "kanban" ? "true" : undefined}
            onClick={() => setView("kanban")}
            title="Kanban board"
          >
            Kanban
          </button>
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
        <Show
          when={view() === "list"}
          fallback={
            <KanbanBoard
              tasks={filtered()}
              readyIds={readyIds()}
              activeTaskId={activeTaskId(props.workspaceProjectId)}
              meUserId={props.me?.id ?? null}
              selectedTaskId={props.selectedTaskId}
              clis={props.clis ?? []}
              onSelect={(t) => props.onSelectTask(t.taskId)}
              onStart={(t, cliName) =>
                void runStartTask(
                  props.client,
                  props.externalId,
                  props.workspaceProjectId,
                  t,
                  props.onRetry,
                  cliName,
                )
              }
              onChangeStatus={(t, s) =>
                void runChangeStatus(
                  props.client,
                  props.externalId,
                  props.workspaceProjectId,
                  t,
                  s,
                  props.me?.id ?? null,
                  props.onRetry,
                )
              }
            />
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
                                ready={readyIds().has(task.taskId)}
                                selected={props.selectedTaskId === task.taskId}
                                clis={props.clis ?? []}
                                onSelect={() => props.onSelectTask(task.taskId)}
                                onStart={(t, cliName) =>
                                  void runStartTask(
                                    props.client,
                                    props.externalId,
                                    props.workspaceProjectId,
                                    t,
                                    props.onRetry,
                                    cliName,
                                  )
                                }
                                onMarkProgress={(t) =>
                                  setActionDialog({ task: t, kind: "progress" })
                                }
                                onMarkDone={(t) => setActionDialog({ task: t, kind: "done" })}
                                onChangeStatus={(t, s) =>
                                  void runChangeStatus(
                                    props.client,
                                    props.externalId,
                                    props.workspaceProjectId,
                                    t,
                                    s,
                                    props.me?.id ?? null,
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
      </Show>
      <Show when={actionDialog()}>
        {(state) => (
          <TaskActionDialog
            state={state()}
            client={props.client}
            externalId={props.externalId}
            workspaceProjectId={props.workspaceProjectId}
            onClose={() => setActionDialog(null)}
            onSuccess={() => {
              setActionDialog(null);
              props.onRetry();
            }}
          />
        )}
      </Show>
    </div>
  );
}

/* ─── Kanban board (T-feature) ─────────────────────────────────────── */

/** Columns shown in Kanban mode. "Ready" is a derived bucket — tasks
 *  whose status is TODO with every declared dependency DONE and no
 *  external lock — so the user can visually separate "what I can pick up
 *  *now*" from the rest of the TODO backlog. The Backlog column catches
 *  the remaining TODOs (deps not done yet). DROPPED rolls into DONE so
 *  archived rows don't grow a sixth column. */
type KanbanColumn = "READY" | "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
const KANBAN_COLUMNS: readonly KanbanColumn[] = ["READY", "TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
const KANBAN_LABELS: Record<KanbanColumn, string> = {
  READY: "Ready",
  TODO: "Backlog",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

interface KanbanBoardProps {
  tasks: readonly Task[];
  readyIds: ReadonlySet<string>;
  activeTaskId: string | null;
  meUserId: string | null;
  selectedTaskId: string | null;
  clis?: readonly PaneCliOption[];
  onSelect: (task: Task) => void;
  onStart: (task: Task, cliName?: string) => void;
  onChangeStatus: (task: Task, status: TaskStatus) => void;
}

function KanbanBoard(props: KanbanBoardProps): JSX.Element {
  const buckets = createMemo<Record<KanbanColumn, Task[]>>(() => {
    const out: Record<KanbanColumn, Task[]> = {
      READY: [],
      TODO: [],
      IN_PROGRESS: [],
      BLOCKED: [],
      DONE: [],
    };
    for (const task of props.tasks) {
      if (task.status === "IN_PROGRESS") {
        out.IN_PROGRESS.push(task);
      } else if (task.status === "BLOCKED") {
        out.BLOCKED.push(task);
      } else if (task.status === "DONE" || task.status === "DROPPED") {
        out.DONE.push(task);
      } else if (task.status === "TODO") {
        if (props.readyIds.has(task.taskId)) out.READY.push(task);
        else out.TODO.push(task);
      }
    }
    for (const col of KANBAN_COLUMNS) {
      out[col] = [...out[col]].sort((a, b) => compareTaskIds(a.taskId, b.taskId));
    }
    return out;
  });

  return (
    <div class="ws-pf-kanban" role="region" aria-label="Kanban board">
      <For each={KANBAN_COLUMNS}>
        {(col) => {
          const list = (): Task[] => buckets()[col];
          return (
            <section
              class="ws-pf-kanban__col"
              data-col={col}
              aria-label={`${KANBAN_LABELS[col]} (${list().length})`}
            >
              <header class="ws-pf-kanban__col-head">
                <span class="ws-pf-kanban__col-dot" data-col={col} aria-hidden="true" />
                <span class="ws-pf-kanban__col-label">{KANBAN_LABELS[col]}</span>
                <span class="ws-pf-kanban__col-count">{list().length}</span>
              </header>
              <ul class="ws-pf-kanban__list" role="list">
                <For each={list()}>
                  {(task) => (
                    <KanbanCard
                      task={task}
                      meUserId={props.meUserId}
                      activeTaskId={props.activeTaskId}
                      selected={props.selectedTaskId === task.taskId}
                      column={col}
                      clis={props.clis ?? []}
                      onSelect={() => props.onSelect(task)}
                      onStart={(cliName) => props.onStart(task, cliName)}
                      onChangeStatus={(s) => props.onChangeStatus(task, s)}
                    />
                  )}
                </For>
                <Show when={list().length === 0}>
                  <li class="ws-pf-kanban__empty" aria-hidden="true">
                    —
                  </li>
                </Show>
              </ul>
            </section>
          );
        }}
      </For>
    </div>
  );
}

interface KanbanCardProps {
  task: Task;
  meUserId: string | null;
  activeTaskId: string | null;
  selected: boolean;
  column: KanbanColumn;
  clis?: readonly PaneCliOption[];
  onSelect: () => void;
  onStart: (cliName?: string) => void;
  onChangeStatus: (status: TaskStatus) => void;
}

function KanbanCard(props: KanbanCardProps): JSX.Element {
  const depCount = (): number => props.task.dependencies?.length ?? 0;
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
  const isActive = (): boolean => props.activeTaskId === props.task.taskId;
  const showStart = (): boolean =>
    props.column === "READY" || (props.column === "IN_PROGRESS" && isActive());
  const startLabel = (): string => (isActive() || lockedBySelf() ? "Resume" : "Start");
  const startDisabled = (): boolean => lockedByOther();

  const [menuOpen, setMenuOpen] = createSignal(false);
  let cardRef: HTMLLIElement | undefined;
  const openMenu = (event: MouseEvent): void => {
    event.preventDefault();
    setMenuOpen(true);
  };
  createEffect(() => {
    if (!menuOpen()) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (cardRef && target && cardRef.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <li
      class="ws-pf-kanban__card"
      ref={(el) => (cardRef = el)}
      data-status={props.task.status}
      data-selected={props.selected ? "true" : undefined}
      data-active={isActive() ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      aria-label={`${props.task.taskId}: ${props.task.name}`}
      onClick={() => props.onSelect()}
      onContextMenu={openMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect();
        }
      }}
    >
      <div class="ws-pf-kanban__card-head">
        <span class="ws-pf-kanban__card-id">{props.task.taskId}</span>
        <Show when={depCount() > 0}>
          <Tooltip label={`Depends on ${depCount()} task${depCount() === 1 ? "" : "s"}`}>
            <span class="ws-pf-kanban__card-deps" aria-label={`${depCount()} dependencies`}>
              ⛓ {depCount()}
            </span>
          </Tooltip>
        </Show>
        <Show when={lockedBy()}>
          {(who) => (
            <Tooltip label={`Locked by ${who()}`}>
              <span class="ws-pf-kanban__card-lock" aria-label={`Locked by ${who()}`}>
                🔒
              </span>
            </Tooltip>
          )}
        </Show>
      </div>
      <div class="ws-pf-kanban__card-name" title={props.task.name}>
        {props.task.name}
      </div>
      <Show when={showStart()}>
        <CliStartButton
          label={startLabel()}
          taskId={props.task.taskId}
          disabled={startDisabled()}
          clis={props.clis ?? []}
          active={isActive()}
          variant="kanban"
          onStart={(cliName) => {
            if (startDisabled()) return;
            props.onStart(cliName);
          }}
        />
      </Show>
      <Show when={menuOpen()}>
        <ul
          class="ws-pf-tasks__statusmenu ws-pf-kanban__menu"
          role="menu"
          aria-label={`Set status for ${props.task.taskId}`}
          onClick={(e) => e.stopPropagation()}
        >
          <For each={STATUS_CHOICES}>
            {(option) => (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  class="ws-pf-tasks__statusmenu-item"
                  data-current={props.task.status === option ? "true" : undefined}
                  data-status={option}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    if (props.task.status === option) return;
                    props.onChangeStatus(option);
                  }}
                >
                  <span
                    class="ws-pf-tasks__statusmenu-dot"
                    data-status={option}
                    aria-hidden="true"
                  />
                  {STATUS_LABELS[option]}
                  <Show when={props.task.status === option}>
                    <span class="ws-pf-tasks__statusmenu-current" aria-hidden="true">
                      ✓
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

const TASK_CLI_NAMES: ReadonlySet<string> = new Set(["claude", "codex"]);

/* ─── CliStartButton ────────────────────────────────────────────────── */

interface CliStartButtonProps {
  label: string;
  taskId: string;
  disabled: boolean;
  active: boolean;
  clis: readonly PaneCliOption[];
  /** "row" = task-list row style, "kanban" = kanban card style */
  variant: "row" | "kanban";
  disabledTitle?: string;
  activeTitle?: string;
  defaultTitle?: string;
  onStart: (cliName?: string) => void;
}

function CliStartButton(props: CliStartButtonProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;

  const taskClis = (): readonly PaneCliOption[] =>
    props.clis.filter((c) => TASK_CLI_NAMES.has(c.name));
  const showChevron = (): boolean => taskClis().length > 1;
  const mainClass = (): string =>
    props.variant === "kanban" ? "ws-pf-kanban__card-start" : "ws-pf-tasks__start";

  const titleAttr = (): string => {
    if (props.disabled) return props.disabledTitle ?? "";
    if (props.active) return props.activeTitle ?? "";
    return props.defaultTitle ?? "";
  };

  createEffect(() => {
    if (!pickerOpen()) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (wrapRef && target && wrapRef.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <div
      class="ws-pf-tasks__start-wrap"
      ref={(el) => (wrapRef = el)}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class={`${mainClass()}${showChevron() ? " ws-pf-tasks__start--split" : ""}`}
        data-active={props.active ? "true" : undefined}
        disabled={props.disabled}
        aria-label={
          props.disabled
            ? `${props.label} on ${props.taskId} — ${props.disabledTitle ?? "locked"}`
            : `${props.label} on ${props.taskId}`
        }
        title={titleAttr()}
        onClick={(e) => {
          e.stopPropagation();
          props.onStart();
        }}
      >
        {props.label}
      </button>
      <Show when={showChevron()}>
        <button
          type="button"
          class="ws-pf-tasks__start-chevron"
          disabled={props.disabled}
          aria-label={`Choose CLI for ${props.taskId}`}
          title="Choose which CLI to launch"
          onClick={(e) => {
            e.stopPropagation();
            setPickerOpen((v) => !v);
          }}
        >
          ▾
        </button>
      </Show>
      <Show when={pickerOpen()}>
        <ul class="ws-pf-tasks__clipicker" role="menu" aria-label="Choose CLI">
          <For each={taskClis()}>
            {(cli) => (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  class="ws-pf-tasks__clipicker-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPickerOpen(false);
                    props.onStart(cli.name);
                  }}
                >
                  {cli.name}
                </button>
              </li>
            )}
          </For>
        </ul>
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
  /** T12.8 — true when this row is currently shown in the detail panel. */
  selected: boolean;
  /** T-feature — true when this task is in TODO, every dependency is DONE
   *  and no one else holds the lock. Surfaces a small "Ready" badge so
   *  the user can spot the actionable tasks without scanning dependency
   *  chips manually. */
  ready: boolean;
  clis?: readonly PaneCliOption[];
  onSelect: () => void;
  onStart: (task: Task, cliName?: string) => void;
  /** T12.5 — open the Progress dialog for this task. Surfaced only when
   *  the row is the user's active in-progress task. */
  onMarkProgress: (task: Task) => void;
  /** T12.5 — open the Done dialog for this task. Same gating as Progress. */
  onMarkDone: (task: Task) => void;
  /** T-feature — set the task's status directly. Wired to the right-click
   *  context menu so the user can fix an accidental Done / Progress
   *  click without going through the action dialog. */
  onChangeStatus: (task: Task, status: TaskStatus) => void;
}

const STATUS_CHOICES: readonly TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED"];

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
  const isActive = (): boolean => props.activeTaskId === props.task.taskId;
  const isDone = (): boolean => props.task.status === "DONE" || props.task.status === "DROPPED";
  // Hide Start on already-finished rows; it's still useful on IN_PROGRESS
  // when the user is the locker (re-arm the terminal nudge).
  const showStart = (): boolean => !isDone();
  const startDisabled = (): boolean => lockedByOther();
  const startLabel = (): string => (isActive() || lockedBySelf() ? "Resume" : "Start working");
  // T12.5 — Progress + Done actions are scoped to the *user's* active
  // task. `isActive()` already encodes that: the local store only sets
  // an entry after a successful `/work` POST as this user. Avoids
  // showing Done on rows where the lock is held by someone else.
  const showLifecycleActions = (): boolean => isActive() && !isDone();
  const assignee = (): string | null => {
    const a = props.task.assignee;
    if (!a) return null;
    return a.name?.trim() || a.email || null;
  };

  const onRowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSelect();
    }
  };

  // T-feature — right-click status menu. Lets the user undo an accidental
  // Done / Progress click without going through the full action dialog.
  // We render the menu inline (anchored to the row) and stash its
  // open-state in a signal so the menu can close on outside-click /
  // Escape without leaking event listeners.
  const [statusMenuOpen, setStatusMenuOpen] = createSignal(false);
  let rowRef: HTMLLIElement | undefined;
  const onRowContext = (event: MouseEvent): void => {
    event.preventDefault();
    setStatusMenuOpen(true);
  };
  createEffect(() => {
    if (!statusMenuOpen()) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (rowRef && target && rowRef.contains(target)) return;
      setStatusMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setStatusMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <li
      class="ws-pf-tasks__row"
      ref={(el) => (rowRef = el)}
      id={`ws-pf-task-${props.task.id}`}
      data-task-id={props.task.taskId}
      data-status={props.task.status}
      data-locked={lockedBy() ? "true" : undefined}
      data-active-task={isActive() ? "true" : undefined}
      data-selected={props.selected ? "true" : undefined}
      data-ready={props.ready ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      aria-label={`Open detail for ${props.task.taskId}: ${props.task.name}`}
      onClick={() => props.onSelect()}
      onContextMenu={onRowContext}
      onKeyDown={onRowKeyDown}
    >
      <span class="ws-pf-tasks__id" aria-label={`Task ${props.task.taskId}`}>
        {props.task.taskId}
      </span>
      <span class="ws-pf-tasks__name" title={props.task.name}>
        {props.task.name}
      </span>
      <Show when={props.ready && !isActive()}>
        <Tooltip label="All dependencies done — ready to start">
          <span class="ws-pf-tasks__ready" aria-label="Ready to start">
            Ready
          </span>
        </Tooltip>
      </Show>
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
        <CliStartButton
          label={startLabel()}
          taskId={props.task.taskId}
          disabled={startDisabled()}
          disabledTitle={`Locked by ${lockedBy() ?? "another user"}`}
          activeTitle="In progress — switch to terminal and re-prime the command"
          defaultTitle="Acquire lock, set IN_PROGRESS, and pre-fill the checkout command"
          clis={props.clis ?? []}
          active={isActive()}
          variant="row"
          onStart={(cliName) => {
            if (startDisabled()) return;
            props.onStart(props.task, cliName);
          }}
        />
      </Show>
      <Show when={showLifecycleActions()}>
        <button
          type="button"
          class="ws-pf-tasks__progress"
          aria-label={`Mark progress on ${props.task.taskId}`}
          title="Post a comment without changing status"
          onClick={(e) => {
            e.stopPropagation();
            props.onMarkProgress(props.task);
          }}
        >
          Progress
        </button>
        <button
          type="button"
          class="ws-pf-tasks__done"
          aria-label={`Mark ${props.task.taskId} done`}
          title="Set DONE, release the lock, and stage a commit message"
          onClick={(e) => {
            e.stopPropagation();
            props.onMarkDone(props.task);
          }}
        >
          Done
        </button>
      </Show>
      <Show when={statusMenuOpen()}>
        <ul
          class="ws-pf-tasks__statusmenu"
          role="menu"
          aria-label={`Set status for ${props.task.taskId}`}
          onClick={(e) => e.stopPropagation()}
        >
          <For each={STATUS_CHOICES}>
            {(option) => (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  class="ws-pf-tasks__statusmenu-item"
                  data-current={props.task.status === option ? "true" : undefined}
                  data-status={option}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStatusMenuOpen(false);
                    if (props.task.status === option) return;
                    props.onChangeStatus(props.task, option);
                  }}
                >
                  <span
                    class="ws-pf-tasks__statusmenu-dot"
                    data-status={option}
                    aria-hidden="true"
                  />
                  {STATUS_LABELS[option]}
                  <Show when={props.task.status === option}>
                    <span class="ws-pf-tasks__statusmenu-current" aria-hidden="true">
                      ✓
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

// T-feature — direct status flip from the row's right-click menu. The
// caller only sees the resolved Task ("T1.1"); we forward it to
// `bulk-status` (via the client's UUID resolution) and refetch the
// list so the row's group placement updates. Errors land in a toast.
//
// When the user moves a task *off* IN_PROGRESS (e.g. accidentally
// pressed Done, fixing it back to TODO), we also need to:
//   - Release the server-side work lock — bulk-status does not do this
//     on its own, so without `stopWorking` the row keeps showing 🔒 me
//     and the Start button stays as "Resume".
//   - Clear the local active-task entry so the workspace tab badge
//     and the row's "Resume" label drop back to "Start working".
// Both calls are best-effort: a failure on either leaves the new status
// in place and the user just sees a slightly stale local indicator
// until the next refetch.
async function runChangeStatus(
  client: PlanFlowClient,
  externalId: string,
  workspaceProjectId: string,
  task: Task,
  status: TaskStatus,
  meUserId: string | null,
  onRetry: () => void,
): Promise<void> {
  try {
    await client.updateTaskStatus(externalId, task.taskId, status);
    if (status !== "IN_PROGRESS") {
      const lockerId = task.lockedBy?.id ?? null;
      const lockedByMe = meUserId !== null && lockerId !== null && lockerId === meUserId;
      const wasMyActive = activeTaskId(workspaceProjectId) === task.taskId;
      if (lockedByMe || wasMyActive) {
        try {
          await client.stopWorking(externalId);
        } catch {
          // Best-effort. The status flip already succeeded; the lock is
          // stale at worst.
        }
      }
      if (wasMyActive) {
        setActiveTaskId(workspaceProjectId, null);
      }
    }
    showToast({
      message: `${task.taskId} → ${status}.`,
      variant: "success",
    });
  } catch (error) {
    if (error instanceof PlanFlowAuthError) {
      showToast({
        message: "PlanFlow rejected the token. Reconnect in Settings.",
        variant: "error",
      });
    } else if (error instanceof PlanFlowApiError) {
      showToast({
        message: `Couldn't change ${task.taskId} status: HTTP ${error.status}.`,
        variant: "error",
      });
    } else {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      showToast({
        message: `Couldn't change ${task.taskId} status: ${detail}`,
        variant: "error",
      });
    }
  } finally {
    onRetry();
  }
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
  cliName?: string,
): Promise<void> {
  try {
    const result = await startTask({
      client,
      externalId,
      workspaceProjectId,
      taskId: task.taskId,
      cliName,
    });
    if (result.branchName === null) {
      showToast({
        message: `Started ${task.taskId} — couldn't fetch branch name. Run \`git checkout -b\` manually.`,
        variant: "warning",
      });
    } else if (!result.prefilled) {
      showToast({
        message: `Started ${task.taskId}. Open a terminal pane to run: git checkout -b ${result.branchName}`,
        variant: "info",
      });
    } else {
      showToast({
        message: `${task.taskId} in progress — press Enter to create branch ${result.branchName}.`,
        variant: "success",
      });
    }
  } catch (error) {
    if (error instanceof PlanFlowConflictError) {
      showToast({
        message: `${task.taskId} is already locked by another user.`,
        variant: "warning",
      });
    } else if (error instanceof PlanFlowAuthError) {
      showToast({
        message: "PlanFlow rejected the token. Reconnect in Settings.",
        variant: "error",
      });
    } else {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      showToast({ message: `Couldn't start ${task.taskId}: ${detail}`, variant: "error" });
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

/** Compare task ids of the shape `T<phase>.<index>` (e.g. "T1.1", "T12.10")
 *  so the natural reading order survives a `Array.sort`. Tasks whose ids
 *  don't match the pattern fall back to a string compare; the result is
 *  pushed below the well-formed entries so a malformed row doesn't move
 *  the rest. */
function compareTaskIds(a: string, b: string): number {
  const parse = (id: string): { phase: number; index: number } | null => {
    const match = id.match(/^T(\d+)\.(\d+)$/);
    if (!match) return null;
    const phase = Number.parseInt(match[1] ?? "", 10);
    const index = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(phase) || !Number.isFinite(index)) return null;
    return { phase, index };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) {
    if (pa.phase !== pb.phase) return pa.phase - pb.phase;
    return pa.index - pb.index;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a.localeCompare(b);
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

// T12.5 — Progress / Done dialog. One component for both flows; the
// `kind` discriminator on `state` flips the copy, the checkbox, and the
// submit handler. Validation is minimal: a non-empty note for both
// flows. Backdrop click and Esc dismiss without submitting; clicks
// inside the dialog don't bubble to the row's onSelect handler.
interface TaskActionDialogProps {
  state: ActionDialogState;
  client: PlanFlowClient;
  externalId: string;
  workspaceProjectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

function TaskActionDialog(props: TaskActionDialogProps): JSX.Element {
  const [note, setNote] = createSignal("");
  const [saveAsKnowledge, setSaveAsKnowledge] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const task = (): Task => props.state.task;
  const kind = (): "progress" | "done" => props.state.kind;
  const title = (): string =>
    kind() === "progress" ? `Mark progress on ${task().taskId}` : `Mark ${task().taskId} done`;
  const placeholder = (): string =>
    kind() === "progress"
      ? "What just happened? (decisions, blockers, partial findings)"
      : "Summary of what landed — copied verbatim into the closing comment.";
  const submitLabel = (): string => {
    if (submitting()) return kind() === "progress" ? "Posting…" : "Closing…";
    return kind() === "progress" ? "Post comment" : "Mark done";
  };
  const commitPreview = (): string => formatCommitMessage(task().taskId, task().name);
  const canSubmit = (): boolean => note().trim().length > 0 && !submitting();

  let textareaRef: HTMLTextAreaElement | undefined;
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (submitting()) return;
      event.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    textareaRef?.focus();
    document.addEventListener("keydown", onKeydown, true);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKeydown, true);
  });

  const onSubmit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (!canSubmit()) return;
    setSubmitting(true);
    setError(null);
    const body = note().trim();
    try {
      if (kind() === "progress") {
        await markProgress({
          client: props.client,
          externalId: props.externalId,
          taskId: task().taskId,
          note: body,
          saveAsKnowledge: saveAsKnowledge(),
        });
        showToast({
          message: saveAsKnowledge()
            ? `Comment + knowledge entry posted on ${task().taskId}.`
            : `Comment posted on ${task().taskId}.`,
          variant: "success",
        });
      } else {
        const result = await finishTask({
          client: props.client,
          externalId: props.externalId,
          workspaceProjectId: props.workspaceProjectId,
          taskId: task().taskId,
          summary: body,
          taskName: task().name,
        });
        if (!result.released) {
          showToast({
            message: `${task().taskId} marked done. Lock release didn't confirm — refresh to verify.`,
            variant: "warning",
          });
        } else if (!result.prefilled) {
          showToast({
            message: `${task().taskId} done. Open a terminal and run: ${result.commitMessage}`,
            variant: "info",
          });
        } else {
          showToast({
            message: `${task().taskId} done — press Enter to commit.`,
            variant: "success",
          });
        }
      }
      props.onSuccess();
    } catch (err) {
      if (err instanceof PlanFlowAuthError) {
        setError("PlanFlow rejected the token. Reconnect in Settings.");
      } else if (err instanceof PlanFlowApiError) {
        setError(`PlanFlow responded with HTTP ${err.status}. Try again.`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Unknown error contacting PlanFlow.");
      }
      setSubmitting(false);
    }
  };

  return (
    <div
      class="ws-pf-action__backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (submitting()) return;
        props.onClose();
      }}
    >
      <form
        class="ws-pf-action"
        role="dialog"
        aria-modal="true"
        aria-label={title()}
        onSubmit={(e) => void onSubmit(e)}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="ws-pf-action__head">
          <span class="ws-pf-action__title">{title()}</span>
          <span class="ws-pf-action__task" title={task().name}>
            {task().name}
          </span>
        </header>
        <textarea
          ref={textareaRef}
          class="ws-pf-action__textarea"
          rows={5}
          placeholder={placeholder()}
          aria-label={kind() === "progress" ? "Progress note" : "Done summary"}
          value={note()}
          disabled={submitting()}
          onInput={(e) => setNote(e.currentTarget.value)}
        />
        <Show when={kind() === "progress"}>
          <label class="ws-pf-action__option">
            <input
              type="checkbox"
              checked={saveAsKnowledge()}
              disabled={submitting()}
              onChange={(e) => setSaveAsKnowledge(e.currentTarget.checked)}
            />
            <span>Save as knowledge (decision)</span>
          </label>
        </Show>
        <Show when={kind() === "done"}>
          <div class="ws-pf-action__preview">
            <span class="ws-pf-action__preview-label">Commit message</span>
            <code class="ws-pf-action__preview-code">{commitPreview()}</code>
          </div>
        </Show>
        <Show when={error()}>
          {(msg) => (
            <p class="ws-pf-action__error" role="alert">
              {msg()}
            </p>
          )}
        </Show>
        <footer class="ws-pf-action__foot">
          <button
            type="button"
            class="ws-pf-action__cancel"
            onClick={() => props.onClose()}
            disabled={submitting()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="ws-pf-action__submit"
            data-kind={kind()}
            disabled={!canSubmit()}
          >
            {submitLabel()}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default PlanFlowTaskList;

// Surfaced for typing in tests / harnesses.
export type { Task as PlanFlowTask };
export type _PlanFlowTaskListResource = Resource<readonly Task[]>;
