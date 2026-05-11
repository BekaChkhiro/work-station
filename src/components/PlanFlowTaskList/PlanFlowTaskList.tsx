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

import { For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js";
import type { JSX, Resource } from "solid-js";

import { EmptyState, ErrorCard, SkeletonRows } from "../AsyncStates";
import { Tooltip } from "../Tooltip";
import {
  createRendererPlanFlowClient,
  MissingPlanFlowTokenError,
  PlanFlowApiError,
  PlanFlowAuthError,
  PlanFlowParseError,
  usePlanFlowLink,
  type Task,
  type TaskComplexity,
  type TaskStatus,
} from "../../integrations";

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
  externalId: string;
  onOpenSettings?: () => void;
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

  const retry = (): void => {
    setReloadKey((k) => k + 1);
    void refetch();
  };

  return (
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
          <TaskListBody tasks={loaded()} onOpenSettings={props.onOpenSettings} onRetry={retry} />
        )}
      </Match>
    </Switch>
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
}

function TaskListBody(props: TaskListBodyProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [phase, setPhase] = createSignal<string | null>(null);
  const [doneExpanded, setDoneExpanded] = createSignal(false);

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
        <div class="ws-pf-tasks__groups">
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
                        <For each={bucket()}>{(task) => <TaskRow task={task} />}</For>
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
}

function TaskRow(props: TaskRowProps): JSX.Element {
  const depCount = (): number => props.task.dependencies?.length ?? 0;
  const complexity = (): TaskComplexity | null => props.task.complexity ?? null;
  const lockedBy = (): string | null => {
    const locker = props.task.lockedBy;
    if (!locker) return null;
    return locker.name?.trim() || locker.email || "another user";
  };
  const assignee = (): string | null => {
    const a = props.task.assignee;
    if (!a) return null;
    return a.name?.trim() || a.email || null;
  };

  return (
    <li
      class="ws-pf-tasks__row"
      data-status={props.task.status}
      data-locked={lockedBy() ? "true" : undefined}
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
    </li>
  );
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
