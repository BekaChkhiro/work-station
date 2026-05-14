import { useNavigate } from "@solidjs/router";
import {
  ErrorBoundary,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { rememberTab } from "../components/TabBar";
import { type Project, type Task, type TaskStatus } from "../lib/planflowClient";
import { WsBridgePlanflowError } from "../lib/wsBridge";
import { settingsStore } from "../lib/settingsStore";
import { bridgeState, getBridge } from "../stores/wsBridge";

// Thin shim with the same surface PlanFlowClient exposed — routed through
// the desktop WS bridge so the mobile PWA never handles the PlanFlow
// token directly. The desktop loads the token from the OS keychain.
interface PlanFlowBridgeClient {
  listProjects(): Promise<Project[]>;
  listTasks(projectId: string): Promise<Task[]>;
  startWork(projectId: string, taskId: string): Promise<unknown>;
}

function bridgeClient(): PlanFlowBridgeClient {
  function bridge() {
    const b = getBridge();
    if (!b) throw new WsBridgePlanflowError("unavailable", "Desktop bridge not connected");
    return b;
  }
  // PlanFlow's `/projects` and `/projects/{id}/tasks` endpoints both
  // wrap their array in a single-key object (`{ projects: [...] }`,
  // `{ tasks: [...] }`). The bridge strips the outer `{ data: ... }`
  // envelope but leaves the inner shape alone, so we have to unwrap
  // here. Some upstream paths return the array directly (older
  // PlanFlow builds), so be defensive.
  function unwrap<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === "object") {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as T[];
    }
    return [];
  }
  return {
    async listProjects() {
      const data = await bridge().planflowListProjects();
      return unwrap<Project>(data, "projects");
    },
    async listTasks(projectId: string) {
      const data = await bridge().planflowListTasks(projectId);
      return unwrap<Task>(data, "tasks");
    },
    async startWork(projectId: string, taskId: string) {
      return bridge().planflowStartWork(projectId, taskId);
    },
  };
}

// Groups & order — DONE/DROPPED collapse by default to mirror desktop T12.3.
const STATUS_GROUPS: { key: TaskStatus; label: string; collapsedByDefault: boolean }[] = [
  { key: "IN_PROGRESS", label: "In progress", collapsedByDefault: false },
  { key: "TODO", label: "To do", collapsedByDefault: false },
  { key: "BLOCKED", label: "Blocked", collapsedByDefault: false },
  { key: "DONE", label: "Done", collapsedByDefault: true },
  { key: "DROPPED", label: "Dropped", collapsedByDefault: true },
];

const STATUS_COLORS: Record<TaskStatus, string> = {
  TODO: "text-fg-secondary",
  IN_PROGRESS: "text-accent",
  BLOCKED: "text-warning",
  DONE: "text-success",
  DROPPED: "text-fg-tertiary",
};

const COMPLEXITY_DOTS: Record<string, string> = {
  L: "bg-success",
  Low: "bg-success",
  M: "bg-warning",
  Medium: "bg-warning",
  H: "bg-error",
  High: "bg-error",
};

export default function TasksRoute() {
  return (
    <ErrorBoundary
      fallback={(err: unknown, reset: () => void) => (
        <section class="flex min-h-[calc(100vh-128px)] flex-col px-4 pt-4">
          <div class="border-error/40 bg-error/10 mt-4 flex flex-col gap-2 rounded-lg border p-4">
            <p class="text-error text-sm font-medium">Tasks view crashed</p>
            <pre class="text-fg-tertiary whitespace-pre-wrap break-words text-xs">
              {err instanceof Error
                ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
                : String(err)}
            </pre>
            <button
              type="button"
              onClick={reset}
              class="text-error hover:bg-error/20 inline-flex h-8 w-fit items-center rounded-md px-3 text-xs font-medium transition-colors"
            >
              Retry
            </button>
          </div>
        </section>
      )}
    >
      <TasksRouteInner />
    </ErrorBoundary>
  );
}

function TasksRouteInner() {
  const [activeProjectId, setActiveProjectIdSignal] = createSignal<string | null>(
    settingsStore.getActiveProjectId(),
  );

  const client = createMemo(() => bridgeClient());

  const [projects, { refetch: refetchProjects }] = createResource(
    () => bridgeState(),
    async (state) => {
      if (state !== "open") return [] as Project[];
      return client().listProjects();
    },
  );

  const [tasks, { refetch: refetchTasks }] = createResource(
    () => (bridgeState() === "open" && activeProjectId() ? activeProjectId() : null),
    async (projectId: string | null) => {
      if (!projectId) return [] as Task[];
      return client().listTasks(projectId);
    },
  );

  // `projects()` throws when the resource is in the error state — wrap
  // every read site so the route never crashes its ErrorBoundary on a
  // PlanFlow failure (the UI surfaces the error inline instead).
  const projectsList = createMemo<Project[]>(() => {
    if (projects.error) return [];
    return projects() ?? [];
  });

  // Clear stored project if it disappears from the user's projects list.
  createEffect(() => {
    const list = projectsList();
    const pid = activeProjectId();
    if (pid == null) return;
    if (list.length === 0) return;
    if (!list.some((p) => p.id === pid)) {
      settingsStore.setActiveProjectId(null);
      setActiveProjectIdSignal(null);
    }
  });

  const tasksList = createMemo<Task[]>(() => {
    if (tasks.error) return [];
    return tasks() ?? [];
  });

  const grouped = createMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const g of STATUS_GROUPS) map.set(g.key, []);
    for (const t of tasksList()) {
      const bucket = map.get(t.status) ?? [];
      bucket.push(t);
      map.set(t.status, bucket);
    }
    return map;
  });

  function applyActiveProject(id: string | null) {
    settingsStore.setActiveProjectId(id);
    setActiveProjectIdSignal(id);
  }

  function refreshAll() {
    void refetchProjects();
    void refetchTasks();
  }

  return (
    <section class="flex min-h-[calc(100vh-128px)] flex-col px-4 pt-4">
      <header class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 class="text-fg text-xl font-semibold tracking-tight">Tasks</h1>
          <p class="text-fg-tertiary text-xs">
            <Switch>
              <Match when={bridgeState() !== "open"}>Reconnecting to desktop…</Match>
              <Match when={!activeProjectId()}>Pick a project.</Match>
              <Match when={tasks.loading}>Loading…</Match>
              <Match when={true}>{tasksList().length.toString()} tasks</Match>
            </Switch>
          </p>
        </div>
        <Show when={bridgeState() === "open"}>
          <button
            type="button"
            onClick={refreshAll}
            class="text-fg-secondary hover:text-fg active:bg-active flex h-9 min-h-touch items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors"
            aria-label="Refresh tasks"
          >
            <RefreshIcon />
            Refresh
          </button>
        </Show>
      </header>

      <Switch>
        <Match when={bridgeState() !== "open"}>
          <BridgeOffline />
        </Match>
        <Match when={!activeProjectId()}>
          <ProjectPicker
            projects={projectsList()}
            loading={projects.loading}
            error={projects.error as unknown}
            onPick={applyActiveProject}
            onRetry={() => void refetchProjects()}
          />
        </Match>
        <Match when={true}>
          <PullToRefresh onRefresh={async () => void (await refetchTasks())}>
            <TaskListBody
              tasks={tasks}
              grouped={grouped}
              activeProjectId={activeProjectId() ?? ""}
              projectName={
                projectsList().find((p) => p.id === activeProjectId())?.name ?? "Project"
              }
              client={client}
              onSwitchProject={() => applyActiveProject(null)}
              onTaskMutated={refreshAll}
            />
          </PullToRefresh>
        </Match>
      </Switch>
    </section>
  );
}

function BridgeOffline() {
  return (
    <div class="bg-surface border-border-default mx-auto mt-6 w-full max-w-md rounded-lg border p-4">
      <p class="text-fg text-sm font-medium">Desktop not connected</p>
      <p class="text-fg-tertiary mt-1 text-xs">
        Tasks live on the desktop's PlanFlow connection. Reconnect from the auth screen and your
        token comes with you automatically — no separate token needed here.
      </p>
    </div>
  );
}

// ---------- Project picker ----------

function ProjectPicker(props: {
  projects: Project[];
  loading: boolean;
  error: unknown;
  onPick: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <div class="mt-4 flex flex-col gap-3">
      <Show when={!props.loading && props.error}>
        <ErrorBanner error={props.error} onRetry={props.onRetry} />
      </Show>
      <Show when={props.loading && !props.projects.length}>
        <Skeleton rows={4} />
      </Show>
      <Show when={!props.loading && !props.error && props.projects.length === 0}>
        <p class="text-fg-tertiary px-1 text-sm">
          No projects on your account. Create one at{" "}
          <a
            href="https://planflow.tools"
            target="_blank"
            rel="noreferrer"
            class="text-accent underline"
          >
            planflow.tools
          </a>
          .
        </p>
      </Show>
      <ul class="bg-surface border-border-default flex flex-col divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-lg border">
        <For each={props.projects}>
          {(project) => (
            <li>
              <button
                type="button"
                onClick={() => props.onPick(project.id)}
                class="hover:bg-hover active:bg-active flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors"
              >
                <div class="flex min-w-0 flex-col">
                  <span class="text-fg truncate text-sm font-medium">{project.name}</span>
                  <Show when={project.description}>
                    <span class="text-fg-tertiary mt-0.5 truncate text-xs">
                      {project.description}
                    </span>
                  </Show>
                </div>
                <ChevronRightIcon />
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

// ---------- Task list ----------

interface TaskListBodyProps {
  tasks: { (): Task[] | undefined; loading: boolean; error: unknown };
  grouped: () => Map<TaskStatus, Task[]>;
  activeProjectId: string;
  projectName: string;
  client: () => PlanFlowBridgeClient;
  onSwitchProject: () => void;
  onTaskMutated: () => void;
}

function TaskListBody(props: TaskListBodyProps) {
  const [collapsed, setCollapsed] = createSignal<Record<TaskStatus, boolean>>(
    STATUS_GROUPS.reduce(
      (acc, g) => ({ ...acc, [g.key]: g.collapsedByDefault }),
      {} as Record<TaskStatus, boolean>,
    ),
  );
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<Task | null>(null);

  // `props.tasks()` throws when the resource is in the error state.
  // Reading it inside JSX would crash the route — collapse to a
  // bucket-sum count derived from the safe `grouped()` accessor.
  const safeTaskCount = createMemo(() => {
    let total = 0;
    for (const list of props.grouped().values()) total += list.length;
    return total;
  });

  function toggle(status: TaskStatus) {
    setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }));
  }

  const filteredGrouped = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return props.grouped();
    const filtered = new Map<TaskStatus, Task[]>();
    for (const [k, v] of props.grouped()) {
      filtered.set(
        k,
        v.filter((t) => t.name.toLowerCase().includes(q) || t.taskId.toLowerCase().includes(q)),
      );
    }
    return filtered;
  });

  return (
    <>
      <div class="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={props.onSwitchProject}
          class="text-fg-secondary hover:text-fg active:bg-active flex h-9 min-h-touch items-center gap-1.5 truncate rounded-md px-2 text-xs font-medium transition-colors"
          aria-label="Switch project"
        >
          <FolderIcon />
          <span class="max-w-[160px] truncate">{props.projectName}</span>
        </button>
        <input
          type="search"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search…"
          class="bg-elevated border-border-default focus:border-accent focus:ring-accent-ring/40 h-9 min-w-0 flex-1 rounded-md border px-3 text-xs outline-none focus:ring-2"
        />
      </div>

      <Show when={props.tasks.error}>
        <ErrorBanner error={props.tasks.error} onRetry={props.onTaskMutated} />
      </Show>

      <Show when={props.tasks.loading && safeTaskCount() === 0}>
        <Skeleton rows={6} />
      </Show>

      <ul class="flex flex-col gap-3 pb-4">
        <For each={STATUS_GROUPS}>
          {(group) => {
            const list = () => filteredGrouped().get(group.key) ?? [];
            return (
              <Show when={list().length > 0}>
                <li class="bg-surface border-border-default overflow-hidden rounded-lg border">
                  <button
                    type="button"
                    onClick={() => toggle(group.key)}
                    class="hover:bg-hover active:bg-active text-fg flex w-full items-center justify-between px-4 py-3 text-left transition-colors"
                    aria-expanded={!collapsed()[group.key]}
                  >
                    <span class="flex items-center gap-2 text-sm font-medium">
                      <span class={STATUS_COLORS[group.key]}>●</span>
                      {group.label}
                      <span class="text-fg-tertiary text-xs">{list().length}</span>
                    </span>
                    <ChevronIcon flipped={!collapsed()[group.key]} />
                  </button>
                  <Show when={!collapsed()[group.key]}>
                    <ul class="divide-y divide-[color:var(--border-subtle)]">
                      <For each={list()}>
                        {(task) => (
                          <li>
                            <TaskRow task={task} onOpen={() => setSelected(task)} />
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </li>
              </Show>
            );
          }}
        </For>
        <Show
          when={
            !props.tasks.loading &&
            safeTaskCount() > 0 &&
            Array.from(filteredGrouped().values()).every((v) => v.length === 0)
          }
        >
          <li class="text-fg-tertiary px-2 py-6 text-center text-sm">
            No tasks match "{search()}".
          </li>
        </Show>
        <Show when={!props.tasks.loading && safeTaskCount() === 0}>
          <li class="text-fg-tertiary px-2 py-8 text-center text-sm">
            No tasks yet — open this project on{" "}
            <a
              href="https://planflow.tools"
              target="_blank"
              rel="noreferrer"
              class="text-accent underline"
            >
              planflow.tools
            </a>
            .
          </li>
        </Show>
      </ul>

      <TaskDetailSheet
        task={selected()}
        projectId={props.activeProjectId}
        client={props.client}
        onClose={() => setSelected(null)}
        onTaskMutated={props.onTaskMutated}
      />
    </>
  );
}

function TaskRow(props: { task: Task; onOpen: () => void }) {
  const complexityClass = () => {
    const c = props.task.complexity ?? "";
    return COMPLEXITY_DOTS[c] ?? "bg-fg-tertiary";
  };
  const locked = () => !!props.task.lockedBy;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="hover:bg-hover active:bg-active flex w-full min-h-touch items-center gap-3 px-4 py-2.5 text-left transition-colors"
    >
      <span class="text-fg-tertiary tabular w-12 shrink-0 text-xs">{props.task.taskId}</span>
      <span class={`h-2 w-2 shrink-0 rounded-full ${complexityClass()}`} aria-hidden="true" />
      <span class="text-fg min-w-0 flex-1 truncate text-sm">{props.task.name}</span>
      <Show when={locked()}>
        <span
          title={props.task.lockedBy?.name ?? props.task.lockedBy?.email ?? "Locked"}
          aria-label="Locked"
        >
          🔒
        </span>
      </Show>
      <Show when={(props.task.dependencies?.length ?? 0) > 0}>
        <span class="text-fg-tertiary text-[10px]">↳{props.task.dependencies?.length ?? 0}</span>
      </Show>
    </button>
  );
}

// ---------- Detail sheet ----------

function TaskDetailSheet(props: {
  task: Task | null;
  projectId: string;
  client: () => PlanFlowBridgeClient;
  onClose: () => void;
  onTaskMutated: () => void;
}) {
  const navigate = useNavigate();
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.task) setError(null);
  });

  // Reset busy flag when sheet closes.
  createEffect(() => {
    if (!props.task) setStarting(false);
  });

  // Close on ESC.
  createEffect(() => {
    if (!props.task) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function handleStart(task: Task) {
    setStarting(true);
    setError(null);
    try {
      await props.client().startWork(props.projectId, task.taskId);
      props.onTaskMutated();
      // Switch to terminal tab — T18.6 will eventually spawn a CLI session
      // tied to this task. For now we just route the user where the
      // terminal lives so the navigation pattern is in place.
      rememberTab("/terminal");
      navigate("/terminal");
      props.onClose();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Show when={props.task}>
      {(task) => (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Task ${task().taskId}`}
          class="fixed inset-0 z-40 flex items-end justify-center"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={props.onClose}
            class="absolute inset-0 bg-black/50 backdrop-blur-sm"
          />
          <div
            class="bg-surface border-border-default relative z-10 max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border-t border-x px-5 pt-4"
            style={{
              "padding-bottom": "calc(env(safe-area-inset-bottom) + 16px)",
              "box-shadow": "var(--shadow-sheet)",
            }}
          >
            <div
              class="mx-auto mb-3 h-1 w-10 rounded-full bg-[color:var(--border-strong)]"
              aria-hidden="true"
            />
            <div class="mb-2 flex items-center gap-2">
              <span class={`text-xs font-semibold ${STATUS_COLORS[task().status]}`}>
                {task().status.replace("_", " ")}
              </span>
              <span class="text-fg-tertiary tabular text-xs">{task().taskId}</span>
              <Show when={task().complexity}>
                <span class="text-fg-tertiary text-xs">· {task().complexity}</span>
              </Show>
            </div>
            <h2 class="text-fg text-lg font-semibold tracking-tight">{task().name}</h2>
            <Show when={task().description}>
              <p class="text-fg-secondary mt-3 whitespace-pre-wrap text-sm">{task().description}</p>
            </Show>
            <Show when={task().acceptance}>
              <div class="mt-3">
                <h3 class="text-fg-tertiary text-xs font-semibold uppercase tracking-wide">
                  Acceptance
                </h3>
                <p class="text-fg-secondary mt-1 whitespace-pre-wrap text-sm">
                  {task().acceptance}
                </p>
              </div>
            </Show>
            <Show when={(task().dependencies?.length ?? 0) > 0}>
              <div class="mt-3">
                <h3 class="text-fg-tertiary text-xs font-semibold uppercase tracking-wide">
                  Dependencies
                </h3>
                <ul class="mt-1 flex flex-wrap gap-1.5">
                  <For each={task().dependencies}>
                    {(dep) => (
                      <li class="bg-elevated text-fg-secondary tabular rounded-md px-2 py-0.5 text-xs">
                        {dep}
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <Show when={task().lockedBy}>
              <p class="text-warning mt-3 text-xs">
                🔒 Locked by {task().lockedBy?.name ?? task().lockedBy?.email}
              </p>
            </Show>
            <Show when={error()}>
              <p class="text-error mt-3 text-xs">{error()}</p>
            </Show>
            <div class="mt-5 flex gap-2">
              <Show when={task().status === "TODO" && !task().lockedBy}>
                <button
                  type="button"
                  onClick={() => void handleStart(task())}
                  disabled={starting()}
                  class="bg-accent hover:bg-accent-muted text-canvas inline-flex h-11 min-h-touch flex-1 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-60"
                >
                  <Show when={starting()} fallback={<PlayIcon />}>
                    <SpinnerIcon />
                  </Show>
                  {starting() ? "Starting…" : "Start working"}
                </button>
              </Show>
              <button
                type="button"
                onClick={props.onClose}
                class="border-border-default text-fg-secondary hover:bg-hover active:bg-active inline-flex h-11 min-h-touch items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

// ---------- Pull-to-refresh ----------

function PullToRefresh(props: { children: JSX.Element; onRefresh: () => Promise<void> }) {
  let containerRef: HTMLDivElement | undefined;
  const [pull, setPull] = createSignal(0);
  const [refreshing, setRefreshing] = createSignal(false);
  let startY = 0;
  let active = false;

  function onTouchStart(e: TouchEvent) {
    if (!containerRef) return;
    if (containerRef.scrollTop > 0) return;
    if (refreshing()) return;
    const touch = e.touches[0];
    if (!touch) return;
    startY = touch.clientY;
    active = true;
  }
  function onTouchMove(e: TouchEvent) {
    if (!active) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dy = touch.clientY - startY;
    if (dy <= 0) {
      setPull(0);
      return;
    }
    // Rubber-band: square-root distance for diminishing return.
    setPull(Math.min(96, Math.sqrt(dy) * 6));
  }
  async function onTouchEnd() {
    if (!active) return;
    active = false;
    const distance = pull();
    if (distance >= 64) {
      setRefreshing(true);
      try {
        await props.onRefresh();
      } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
  }

  return (
    <div
      ref={containerRef}
      class="relative flex-1 overflow-y-auto"
      style={{ "overscroll-behavior-y": "contain" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        class="text-fg-tertiary pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center text-xs"
        style={{
          height: `${Math.max(pull(), refreshing() ? 32 : 0)}px`,
          opacity: pull() > 0 || refreshing() ? 1 : 0,
          transition: refreshing() ? "none" : "opacity var(--dur-fast) var(--ease)",
        }}
        aria-hidden="true"
      >
        <Show when={refreshing()} fallback={<span>↓ Pull to refresh</span>}>
          <SpinnerIcon />
        </Show>
      </div>
      <div
        style={{
          transform: `translateY(${pull()}px)`,
          transition:
            pull() === 0 && !refreshing() ? "transform var(--dur-base) var(--ease)" : "none",
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

// ---------- Helpers ----------

function ErrorBanner(props: { error: unknown; onRetry: () => void }) {
  const message = formatError(props.error);
  return (
    <div class="border-error/40 bg-error/10 flex flex-col gap-2 rounded-lg border p-3">
      <p class="text-error text-sm">{message}</p>
      <div class="flex gap-2">
        <button
          type="button"
          onClick={props.onRetry}
          class="text-error hover:bg-error/20 inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function Skeleton(props: { rows: number }) {
  return (
    <ul class="flex flex-col gap-2" aria-hidden="true">
      <For each={Array.from({ length: props.rows })}>
        {() => <li class="bg-surface border-border-default h-12 animate-pulse rounded-md border" />}
      </For>
    </ul>
  );
}

function formatError(err: unknown): string {
  if (err instanceof WsBridgePlanflowError) {
    if (err.kind === "no_credential")
      return "PlanFlow token isn't set on the desktop — add it under Settings → Integrations on the desktop app.";
    if (err.kind === "unauthorized" || err.kind === "forbidden")
      return "PlanFlow rejected the desktop's token. Re-enter it on the desktop.";
    if (err.kind === "unavailable") return err.message;
    return `PlanFlow error: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

// ---------- Icons ----------

function ChevronIcon(props: { flipped?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{
        transform: props.flipped ? "rotate(180deg)" : "none",
        transition: "transform var(--dur-fast) var(--ease)",
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-fg-tertiary"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="animate-spin"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 1-9 9" />
    </svg>
  );
}
