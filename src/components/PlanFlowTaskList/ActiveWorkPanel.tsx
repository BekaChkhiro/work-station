// T12.6 — Active work panel.
//
// Right-rail listing of users currently in IN_PROGRESS on the linked
// PlanFlow project. Backed by `GET /projects/:id/active-work`, polled
// every 10s. Each row shows avatar + name + task ID + elapsed duration;
// clicking jumps to the task in the parent list.
//
// Collapses to a thin "you · T12.6 · 12m" indicator when only the
// current user is active (matches the design's "solo project doesn't
// waste space" goal). Renders nothing when no one is active.
//
// Errors are intentionally swallowed: this panel is a non-blocking
// auxiliary view. T11.8's reauth flow already routes 401/403 into the
// global Reconnect banner, and the task list (T12.3) is the primary
// surface for fetch errors.

import {
  For,
  Show,
  Switch,
  Match,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { Tooltip } from "../Tooltip";
import {
  createRendererPlanFlowClient,
  MissingPlanFlowTokenError,
  PlanFlowAuthError,
  type ActiveWorkUser,
  type Me,
} from "../../integrations";

type ActiveWorkEntry = ActiveWorkUser;
type MeUser = Me["user"];

const POLL_INTERVAL_MS = 10_000;
const CLOCK_TICK_MS = 30_000;

export interface ActiveWorkPanelProps {
  externalId: string;
  onJumpToTask?: (taskId: string) => void;
}

export function ActiveWorkPanel(props: ActiveWorkPanelProps): JSX.Element {
  const client = createRendererPlanFlowClient();
  const [reloadKey, setReloadKey] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  const [entries] = createResource(
    () => ({ externalId: props.externalId, reloadKey: reloadKey() }),
    async (input): Promise<readonly ActiveWorkEntry[]> => {
      try {
        return await client.listActiveWork(input.externalId);
      } catch (error) {
        if (error instanceof MissingPlanFlowTokenError) return [];
        if (error instanceof PlanFlowAuthError) return [];
        return [];
      }
    },
  );

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

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let clockHandle: ReturnType<typeof setInterval> | null = null;

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  onMount(() => {
    pollHandle = setInterval(() => {
      if (isHidden()) return;
      setReloadKey((k) => k + 1);
    }, POLL_INTERVAL_MS);
    clockHandle = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
  });

  onCleanup(() => {
    if (pollHandle != null) clearInterval(pollHandle);
    if (clockHandle != null) clearInterval(clockHandle);
  });

  const list = (): readonly ActiveWorkEntry[] => entries() ?? [];
  const myId = (): string | null => me()?.id ?? null;

  const mode = createMemo<"hidden" | "compact" | "full">(() => {
    const items = list();
    if (items.length === 0) return "hidden";
    const meId = myId();
    const allMine = meId != null && items.every((e) => e.user.id === meId);
    if (allMine) return "compact";
    return "full";
  });

  const handleClick = (taskId: string): void => {
    props.onJumpToTask?.(taskId);
  };

  const labelFor = (entry: ActiveWorkEntry): string => {
    if (myId() != null && entry.user.id === myId()) return "you";
    return entry.user.name?.trim() || entry.user.email || "Someone";
  };

  return (
    <Show when={mode() !== "hidden"}>
      <Switch>
        <Match when={mode() === "compact"}>
          {(() => {
            const entry = (): ActiveWorkEntry | null => list()[0] ?? null;
            return (
              <aside class="ws-pf-active ws-pf-active--compact" aria-label="Your active work">
                <Show when={entry()}>
                  {(e) => (
                    <button
                      type="button"
                      class="ws-pf-active__chip"
                      onClick={() => handleClick(e().taskId)}
                      title={`Jump to ${e().taskId}`}
                    >
                      <span class="ws-pf-active__pulse" aria-hidden="true" />
                      <span class="ws-pf-active__chip-label">
                        you · <span class="ws-pf-active__chip-id">{e().taskId}</span> ·{" "}
                        {formatDuration(e().startedAt, now())}
                      </span>
                    </button>
                  )}
                </Show>
              </aside>
            );
          })()}
        </Match>
        <Match when={mode() === "full"}>
          <aside class="ws-pf-active" aria-label="Active work">
            <header class="ws-pf-active__head">
              <span class="ws-pf-active__pulse" aria-hidden="true" />
              <span class="ws-pf-active__title">Active work</span>
              <span class="ws-pf-active__count">{list().length}</span>
            </header>
            <ul class="ws-pf-active__rows" role="list">
              <For each={list()}>
                {(entry) => (
                  <li>
                    <button
                      type="button"
                      class="ws-pf-active__row"
                      onClick={() => handleClick(entry.taskId)}
                      title={`Jump to ${entry.taskId}`}
                    >
                      <Tooltip label={labelFor(entry)}>
                        <span class="ws-pf-active__avatar" aria-hidden="true">
                          {initials(labelFor(entry))}
                        </span>
                      </Tooltip>
                      <span class="ws-pf-active__meta">
                        <span class="ws-pf-active__name">{labelFor(entry)}</span>
                        <span class="ws-pf-active__sub">
                          <span class="ws-pf-active__taskid">{entry.taskId}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatDuration(entry.startedAt, now())}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </aside>
        </Match>
      </Switch>
    </Show>
  );
}

function formatDuration(startedAt: string, now: number): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "";
  const elapsedMs = Math.max(0, now - startedMs);
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  if (trimmed === "you") return "YOU";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    const single = parts[0] ?? "";
    return single.slice(0, 2).toUpperCase() || "?";
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase() || "?";
}

export default ActiveWorkPanel;
