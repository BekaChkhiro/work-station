// T18.17 — Projects view: list desktop workspace projects and switch.
//
// Calls the T18.4 WS bridge handlers (projects_list, settings_get,
// project_switch). A successful switch fires a Tauri event on the
// desktop side so the AppShell's active project mirrors the PWA's
// choice without any extra round-trip.

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
import {
  WsBridgeError,
  WsBridgePlanflowError,
  WsBridgeServerError,
  type WsBridgeProject,
} from "../lib/wsBridge";
import { bridgeState, getBridge } from "../stores/wsBridge";

export default function ProjectsRoute() {
  // `version` bumps to force a re-fetch when the user taps refresh or when
  // the bridge transitions back to "open" after a drop.
  const [version, setVersion] = createSignal(0);
  const [switching, setSwitching] = createSignal<string | null>(null);
  const [switchError, setSwitchError] = createSignal<string | null>(null);
  // Optimistic mirror of `settings.lastActiveProject` so tapping a row
  // moves the highlight without waiting for the round-trip.
  const [activeOverride, setActiveOverride] = createSignal<string | null | undefined>(undefined);

  const [snapshot, { refetch }] = createResource(
    () => ({ v: version(), s: bridgeState() }),
    async ({ s }) => {
      if (s !== "open") return null;
      const bridge = getBridge();
      if (!bridge) throw new WsBridgeError("unavailable", "WebSocket bridge not configured");
      const [projects, settings] = await Promise.all([bridge.projectsList(), bridge.settingsGet()]);
      return { projects, lastActiveProject: settings.lastActiveProject };
    },
  );

  // Subscribe to server-initiated active_project_changed events so a
  // desktop-side switch (or a future cross-WS broadcast) is reflected
  // without polling. The Tauri server reserves this frame today and
  // may start emitting it; harmless if it never fires.
  onMount(() => {
    const bridge = getBridge();
    if (!bridge) return;
    const unsub = bridge.onActiveProjectChanged((projectId) => {
      setActiveOverride(projectId);
    });
    onCleanup(unsub);
  });

  // Refresh whenever the bridge reconnects so the list/active row are
  // never stuck on stale data after a transient drop.
  createEffect((prev: string | undefined) => {
    const s = bridgeState();
    if (prev !== "open" && s === "open") setVersion((v) => v + 1);
    return s;
  });

  // Reset the optimistic override whenever a fresh snapshot lands.
  createEffect(() => {
    if (snapshot()) setActiveOverride(undefined);
  });

  const activeProjectId = createMemo<string | null>(() => {
    const override = activeOverride();
    if (override !== undefined) return override;
    return snapshot()?.lastActiveProject ?? null;
  });

  async function handleSwitch(project: WsBridgeProject) {
    if (switching()) return;
    if (project.id === activeProjectId()) return;
    setSwitchError(null);
    setSwitching(project.id);
    const previous = activeProjectId();
    setActiveOverride(project.id);
    try {
      const bridge = getBridge();
      if (!bridge) throw new WsBridgeError("unavailable", "WebSocket bridge not configured");
      await bridge.projectSwitch(project.id);
    } catch (err) {
      setActiveOverride(previous);
      setSwitchError(formatError(err));
    } finally {
      setSwitching(null);
    }
  }

  function handleRefresh() {
    setSwitchError(null);
    setVersion((v) => v + 1);
    void refetch();
  }

  return (
    <section class="flex min-h-[calc(100vh-128px)] flex-col px-4 pt-4">
      <header class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 class="text-fg text-xl font-semibold tracking-tight">Projects</h1>
          <p class="text-fg-tertiary text-xs">
            <Switch>
              <Match when={bridgeState() !== "open"}>Reconnecting to desktop…</Match>
              <Match when={snapshot.loading}>Loading…</Match>
              <Match when={snapshot.error}>Failed to load</Match>
              <Match when={true}>
                {(snapshot()?.projects.length ?? 0).toString()}
                {(snapshot()?.projects.length ?? 0) === 1 ? " project" : " projects"}
              </Match>
            </Switch>
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={snapshot.loading || bridgeState() !== "open"}
          class="text-fg-secondary hover:text-fg active:bg-active flex h-9 min-h-touch items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50"
          aria-label="Refresh projects"
        >
          <RefreshIcon />
          Refresh
        </button>
      </header>

      <Show when={switchError()}>
        <div class="border-error/40 bg-error/10 mb-3 flex items-center justify-between gap-2 rounded-lg border p-3">
          <p class="text-error text-sm">{switchError()}</p>
          <button
            type="button"
            onClick={() => setSwitchError(null)}
            class="text-error hover:bg-error/20 inline-flex h-7 items-center rounded-md px-2 text-xs font-medium transition-colors"
          >
            Dismiss
          </button>
        </div>
      </Show>

      <Switch>
        <Match when={bridgeState() !== "open"}>
          <DisconnectedState state={bridgeState()} />
        </Match>
        <Match when={snapshot.loading && !snapshot()}>
          <Skeleton rows={4} />
        </Match>
        <Match when={snapshot.error}>
          <ErrorBanner error={snapshot.error} onRetry={handleRefresh} />
        </Match>
        <Match when={(snapshot()?.projects.length ?? 0) === 0}>
          <p class="text-fg-tertiary mt-6 px-1 text-center text-sm">
            No projects on the desktop yet. Create one from the Work Station app.
          </p>
        </Match>
        <Match when={true}>
          <ul class="bg-surface border-border-default flex flex-col divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-lg border">
            <For each={snapshot()?.projects}>
              {(project) => (
                <li>
                  <ProjectRow
                    project={project}
                    isActive={project.id === activeProjectId()}
                    isSwitching={switching() === project.id}
                    disabled={switching() !== null && switching() !== project.id}
                    onSelect={handleSwitch}
                  />
                </li>
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </section>
  );
}

// ---------- Project row ----------

function ProjectRow(props: {
  project: WsBridgeProject;
  isActive: boolean;
  isSwitching: boolean;
  disabled: boolean;
  onSelect: (project: WsBridgeProject) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.project)}
      disabled={props.disabled}
      aria-current={props.isActive ? "true" : undefined}
      class={`hover:bg-hover active:bg-active flex w-full min-h-touch items-center gap-3 px-4 py-3 text-left transition-colors disabled:opacity-50 ${
        props.isActive ? "bg-hover" : ""
      }`}
    >
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
        style={{
          "background-color": props.project.color ?? "var(--bg-elevated)",
          color: props.project.color ? "#0b0d10" : "var(--fg-secondary)",
        }}
        aria-hidden="true"
      >
        {initialsOf(props.project.name)}
      </span>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2">
          <span
            class={`truncate text-sm font-medium ${props.isActive ? "text-accent" : "text-fg"}`}
          >
            {props.project.name}
          </span>
          <Show when={props.isActive}>
            <span class="bg-accent/15 text-accent rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Active
            </span>
          </Show>
        </div>
        <span
          class="text-fg-tertiary mt-0.5 truncate font-mono text-[11px]"
          title={props.project.path}
        >
          {props.project.path}
        </span>
      </div>
      <Show when={props.isSwitching} fallback={<ChevronRightIcon />}>
        <SpinnerIcon />
      </Show>
    </button>
  );
}

// ---------- States ----------

function DisconnectedState(props: { state: string }) {
  return (
    <div class="bg-surface border-border-default mt-4 flex flex-col items-center gap-2 rounded-lg border p-6 text-center">
      <p class="text-fg text-sm font-medium">
        {props.state === "reconnecting" ? "Reconnecting…" : "Disconnected"}
      </p>
      <p class="text-fg-tertiary text-xs">Projects load once the desktop connection is open.</p>
    </div>
  );
}

function ErrorBanner(props: { error: unknown; onRetry: () => void }) {
  return (
    <div class="border-error/40 bg-error/10 mt-4 flex flex-col gap-2 rounded-lg border p-3">
      <p class="text-error text-sm">{formatError(props.error)}</p>
      <div>
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
        {() => (
          <li class="bg-surface border-border-default h-[60px] animate-pulse rounded-lg border" />
        )}
      </For>
    </ul>
  );
}

// ---------- Helpers ----------

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const second = parts[1] ?? "";
  return ((first[0] ?? "") + (second[0] ?? "")).toUpperCase();
}

function formatError(err: unknown): string {
  if (err instanceof WsBridgeError) {
    if (err.kind === "not_found") return "Project no longer exists. Refresh to update the list.";
    if (err.kind === "unavailable") return "Desktop bridge not available.";
    return err.message || "Bridge error";
  }
  if (err instanceof WsBridgeServerError) return err.message || "Bridge error";
  if (err instanceof WsBridgePlanflowError) return err.message || "PlanFlow error";
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

// ---------- Icons ----------

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
      class="text-fg-tertiary shrink-0"
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

function SpinnerIcon() {
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
      class="text-fg-tertiary shrink-0 animate-spin"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 1-9 9" />
    </svg>
  );
}
