// T12.7 — Activity feed (incremental polling).
//
// Bottom rail of the PlanFlow tab. Lists recent project changes — task
// status changes, comments, knowledge added, members joined — using the
// `/projects/:id/changes` endpoint. Polls every 10s with a `since`
// watermark so each tick only ships new entries.
//
// Dedupe on `change.id` (a slow/repeated initial response can otherwise
// duplicate rows). Display cap at 100 — older entries are dropped from
// memory; the UI is meant to surface recent activity, not full history.
//
// Errors are intentionally swallowed: this rail is a non-blocking
// auxiliary view. T11.8's reauth flow already routes 401/403 into the
// global Reconnect banner, and T12.3 owns the visible fetch-error path.

import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import {
  createRendererPlanFlowClient,
  MissingPlanFlowTokenError,
  PlanFlowAuthError,
  type Change,
} from "../../integrations";

const POLL_INTERVAL_MS = 10_000;
const CLOCK_TICK_MS = 30_000;
const PAGE_LIMIT = 50;
const MAX_ENTRIES = 100;

export interface ActivityFeedProps {
  externalId: string;
  onJumpToTask?: (taskId: string) => void;
}

export function ActivityFeed(props: ActivityFeedProps): JSX.Element {
  const client = createRendererPlanFlowClient();
  const [reloadKey, setReloadKey] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [entries, setEntries] = createSignal<readonly Change[]>([]);
  const [since, setSince] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  // The resource exists purely as a polling driver — it merges into the
  // accumulated `entries` signal. We don't render off `resource()` directly
  // because each poll returns only the delta, not the full feed. `since`
  // is read untracked inside the fetcher: it's mutated *by* the fetcher
  // itself, and re-triggering on every mutation would defeat the 10s
  // poll cadence we want.
  createResource(
    () => ({ externalId: props.externalId, reloadKey: reloadKey() }),
    // eslint-disable-next-line solid/reactivity
    async (input): Promise<void> => {
      try {
        const cursor = since();
        const response = await client.listChanges(input.externalId, {
          since: cursor ?? undefined,
          limit: PAGE_LIMIT,
        });
        mergeChanges(response.changes);
        if (response.cursor != null) setSince(response.cursor);
        setLoaded(true);
      } catch (error) {
        if (error instanceof MissingPlanFlowTokenError) return;
        if (error instanceof PlanFlowAuthError) return;
        console.warn("[ActivityFeed] poll failed:", error);
      }
    },
  );

  function mergeChanges(incoming: readonly Change[]): void {
    if (incoming.length === 0) return;
    setEntries((prev) => {
      const seen = new Set<string>();
      const merged: Change[] = [];
      for (const change of incoming) {
        if (seen.has(change.id)) continue;
        seen.add(change.id);
        merged.push(change);
      }
      for (const change of prev) {
        if (seen.has(change.id)) continue;
        seen.add(change.id);
        merged.push(change);
      }
      merged.sort((a, b) => {
        const ta = Date.parse(a.occurredAt ?? "");
        const tb = Date.parse(b.occurredAt ?? "");
        if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
        return tb - ta;
      });
      return merged.length > MAX_ENTRIES ? merged.slice(0, MAX_ENTRIES) : merged;
    });
  }

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

  const list = (): readonly Change[] => entries();
  const empty = (): boolean => loaded() && list().length === 0;

  const handleClick = (change: Change): void => {
    const taskId = taskIdFor(change);
    if (taskId != null) props.onJumpToTask?.(taskId);
  };

  return (
    <section class="ws-pf-activity" aria-label="Project activity">
      <header class="ws-pf-activity__head">
        <span class="ws-pf-activity__title">Activity</span>
        <Show when={list().length > 0}>
          <span class="ws-pf-activity__count">{list().length}</span>
        </Show>
      </header>
      <Show when={!empty()} fallback={<div class="ws-pf-activity__empty">No recent activity.</div>}>
        <ul class="ws-pf-activity__rows" role="list">
          <For each={list()}>
            {(change) => {
              const view = createMemo(() => describeChange(change));
              const taskId = (): string | null => taskIdFor(change);
              const interactive = (): boolean => taskId() != null;
              return (
                <li>
                  <button
                    type="button"
                    class="ws-pf-activity__row"
                    onClick={() => handleClick(change)}
                    disabled={!interactive()}
                    title={interactive() ? `Jump to ${taskId()}` : undefined}
                  >
                    <span class="ws-pf-activity__icon" aria-hidden="true">
                      {view().icon}
                    </span>
                    <span class="ws-pf-activity__line">
                      <span class="ws-pf-activity__actor">{view().actor}</span>{" "}
                      <span class="ws-pf-activity__verb">{view().verb}</span>{" "}
                      <Show when={view().target}>
                        <span class="ws-pf-activity__target">{view().target}</span>
                      </Show>
                    </span>
                    <span class="ws-pf-activity__time">
                      {formatRelative(change.occurredAt ?? "", now())}
                    </span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

interface ChangeView {
  icon: string;
  actor: string;
  verb: string;
  target: string;
}

function describeChange(change: Change): ChangeView {
  const actor = change.userName?.trim() || change.userEmail || "Someone";
  const kind = change.entityType && change.action ? `${change.entityType}.${change.action}` : "";
  const target = change.entityId ?? "";

  // Kinds are loosely-typed strings from the server. We pattern-match on
  // common prefixes / suffixes so a future kind doesn't crash the UI.
  if (kind === "member.joined" || kind === "project.member_added") {
    return { icon: "👥", actor, verb: "joined the project", target: "" };
  }
  if (kind.startsWith("knowledge.")) {
    const verb = kind.endsWith(".deleted") ? "removed knowledge" : "added knowledge";
    return { icon: "📚", actor, verb, target: target ? `· ${target}` : "" };
  }
  if (kind === "task.created" || kind === "task.added") {
    return { icon: "➕", actor, verb: "created", target: formatTaskRef(target) };
  }
  if (kind === "task.status_changed" || kind === "task.status_updated") {
    return { icon: "🔄", actor, verb: "moved", target: formatTaskRef(target) };
  }
  if (kind === "task.locked" || kind === "task.work_started") {
    return { icon: "▶", actor, verb: "started", target: formatTaskRef(target) };
  }
  if (kind === "task.unlocked" || kind === "task.work_stopped") {
    return { icon: "■", actor, verb: "stopped working on", target: formatTaskRef(target) };
  }
  if (kind === "task.done" || kind === "task.completed") {
    return { icon: "✅", actor, verb: "completed", target: formatTaskRef(target) };
  }
  if (kind === "comment.added" || kind === "task.comment_added") {
    return { icon: "💬", actor, verb: "commented on", target: formatTaskRef(target) };
  }
  if (kind === "task.updated") {
    return { icon: "✏️", actor, verb: "updated", target: formatTaskRef(target) };
  }
  // Fallback: show the kind verbatim so unknown events stay visible
  // rather than rendering as a blank row.
  return {
    icon: "·",
    actor,
    verb: prettifyKind(kind) || "did something",
    target: target ? formatTaskRef(target) : "",
  };
}

function taskIdFor(change: Change): string | null {
  const type = change.entityType ?? "";
  const id = change.entityId ?? "";
  if (!id) return null;
  if (type === "task" || type === "comment") return id;
  return null;
}

function formatTaskRef(value: string): string {
  if (!value) return "";
  return /^T\d/.test(value) ? value : `· ${value}`;
}

function prettifyKind(kind: string): string {
  return kind.replace(/^[^.]+\./, "").replace(/_/g, " ");
}

function formatRelative(occurredAt: string, now: number): string {
  const t = Date.parse(occurredAt);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const date = new Date(t);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default ActivityFeed;
