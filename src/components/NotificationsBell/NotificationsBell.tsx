// T12.9 — Cross-project notifications bell.
//
// Rendered in the title bar. Polls `GET /notifications/unread-count`
// every 30s for the badge; the dropdown lazily fetches the full list
// via `GET /notifications` so opening it always shows fresh data.
//
// Click a row → jump to the related task:
//   1. Resolve the PlanFlow projectId on the notification to a Work
//      Station project via `project_links` (T11.5). If no workspace
//      project is linked yet, surface a toast instead of swallowing the
//      click silently.
//   2. Switch the active workspace project (T6.2) and flip its tab to
//      "planflow", reconciling visibility (T12.2 forces it visible on
//      boot, but a user-hidden tab needs to come back into view).
//   3. Land a pending-task-jump (T12.9 helper store) so PlanFlowTaskList
//      scrolls + flashes the row once it mounts.
//   4. POST `/notifications/:id/read` and refresh the count.
//
// Errors are intentionally swallowed below the badge: a missing token
// (T11.8 path) or 401 → no badge, the global Reconnect banner is the
// primary surface for those states.

import {
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { showToast } from "../Toast";
import {
  createRendererPlanFlowClient,
  Integration,
  loadProjectLinks,
  MissingPlanFlowTokenError,
  PlanFlowAuthError,
  readCachedLinks,
  type Notification,
} from "../../integrations";
import {
  activeTab as activeTabFor,
  projects,
  setActiveProject,
  setActiveTab,
  setTabVisibility,
  visibleTabs,
} from "../../stores/workspace";
import { requestTaskJump } from "../../stores/pendingTaskJump";

const POLL_INTERVAL_MS = 30_000;
const RELATIVE_TICK_MS = 60_000;

export function NotificationsBell(): JSX.Element {
  const client = createRendererPlanFlowClient();
  const [open, setOpen] = createSignal(false);
  const [countKey, setCountKey] = createSignal(0);
  const [listKey, setListKey] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  const [unread] = createResource(countKey, async (): Promise<number | null> => {
    try {
      return await client.getUnreadNotificationCount();
    } catch (error) {
      if (error instanceof MissingPlanFlowTokenError) return null;
      if (error instanceof PlanFlowAuthError) return null;
      return null;
    }
  });

  const [notifications, { refetch: refetchList }] = createResource(
    () => (open() ? listKey() : null),
    async (key): Promise<readonly Notification[]> => {
      if (key == null) return [];
      try {
        return await client.listNotifications();
      } catch (error) {
        if (error instanceof MissingPlanFlowTokenError) return [];
        if (error instanceof PlanFlowAuthError) return [];
        throw error;
      }
    },
  );

  let containerRef: HTMLDivElement | undefined;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    pollHandle = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setCountKey((k) => k + 1);
    }, POLL_INTERVAL_MS);
    // Keeps the "5m ago" relative timestamps in the dropdown moving without
    // re-fetching the list. Cheap signal write per minute.
    tickHandle = setInterval(() => setNow(Date.now()), RELATIVE_TICK_MS);

    const onDocMouseDown = (event: MouseEvent): void => {
      if (!open()) return;
      const target = event.target as Node | null;
      if (containerRef && target && containerRef.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!open()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  onCleanup(() => {
    if (pollHandle != null) clearInterval(pollHandle);
    if (tickHandle != null) clearInterval(tickHandle);
  });

  const toggle = (): void => {
    setOpen((value) => {
      const next = !value;
      if (next) {
        setListKey((k) => k + 1);
      }
      return next;
    });
  };

  const handleNotificationClick = async (notification: Notification): Promise<void> => {
    const planflowProjectId = notification.projectId;
    const taskId = notification.taskId;

    if (planflowProjectId != null) {
      const workspaceProjectId = await findWorkspaceProjectForExternalId(planflowProjectId);
      if (workspaceProjectId != null) {
        setActiveProject(workspaceProjectId);
        if (!visibleTabs(workspaceProjectId).includes("planflow")) {
          setTabVisibility(workspaceProjectId, "planflow", true);
        }
        if (activeTabFor(workspaceProjectId) !== "planflow") {
          setActiveTab(workspaceProjectId, "planflow");
        }
        if (taskId != null && taskId.length > 0) {
          requestTaskJump(workspaceProjectId, taskId);
        }
      } else {
        showToast({
          message:
            "Link the PlanFlow project in Settings → Integrations to open this notification.",
          variant: "info",
        });
      }
    }

    try {
      await client.markNotificationRead(notification.id);
      setCountKey((k) => k + 1);
      void refetchList();
    } catch {
      // The bell intentionally swallows mark-read failures — the badge
      // will simply stay at the current count until the next poll.
    }
    setOpen(false);
  };

  const badge = (): number | null => {
    const value = unread();
    if (value == null) return null;
    if (value <= 0) return null;
    return value;
  };

  const ariaLabel = (): string => {
    const count = badge();
    if (count == null) return "Notifications";
    return `Notifications (${count} unread)`;
  };

  const badgeLabel = (count: number): string => (count > 99 ? "99+" : String(count));

  return (
    <div class="ws-bell" ref={(el) => (containerRef = el)}>
      <button
        type="button"
        class="ws-titlebar__btn ws-bell__btn"
        aria-label={ariaLabel()}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        onClick={toggle}
      >
        <BellIcon />
        <Show when={badge() != null}>
          <span class="ws-bell__badge" aria-hidden="true">
            {badgeLabel(badge() as number)}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="ws-bell__panel" role="menu" aria-label="Notifications">
          <header class="ws-bell__head">
            <span class="ws-bell__title">Notifications</span>
            <Show when={badge() != null}>
              <span class="ws-bell__count">{badgeLabel(badge() as number)} unread</span>
            </Show>
          </header>
          <Switch>
            <Match when={notifications.loading}>
              <div class="ws-bell__state ws-bell__state--loading">Loading…</div>
            </Match>
            <Match when={notifications.error}>
              <div class="ws-bell__state ws-bell__state--error">Couldn't load notifications.</div>
            </Match>
            <Match when={(notifications() ?? []).length === 0}>
              <div class="ws-bell__state ws-bell__state--empty">You're all caught up.</div>
            </Match>
            <Match when={(notifications() ?? []).length > 0}>
              <ul class="ws-bell__list" role="list">
                <For each={notifications()}>
                  {(notification) => (
                    <li>
                      <button
                        type="button"
                        class="ws-bell__row"
                        classList={{ "ws-bell__row--unread": notification.read === false }}
                        onClick={() => void handleNotificationClick(notification)}
                      >
                        <Show when={notification.read === false}>
                          <span class="ws-bell__dot" aria-hidden="true" />
                        </Show>
                        <span class="ws-bell__row-message">{notification.message}</span>
                        <Show when={notification.createdAt}>
                          <span class="ws-bell__row-time">
                            {relativeTime(notification.createdAt as string, now())}
                          </span>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}

async function findWorkspaceProjectForExternalId(externalId: string): Promise<string | null> {
  for (const workspaceProject of projects()) {
    const cached = readCachedLinks(workspaceProject.id);
    const links = cached ?? (await loadProjectLinks(workspaceProject.id));
    const match = links.find(
      (link) => link.service === Integration.PlanFlow && link.externalId === externalId,
    );
    if (match) return workspaceProject.id;
  }
  return null;
}

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1m ago";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const weeks = Math.floor(diffDay / 7);
  return `${weeks}w ago`;
}

function BellIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 11.5h9l-1-1.2V7a3.5 3.5 0 0 0-7 0v3.3l-1 1.2z" />
      <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

export default NotificationsBell;
