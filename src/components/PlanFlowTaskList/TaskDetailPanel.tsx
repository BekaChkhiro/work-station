// T12.8 — Task detail side panel.
//
// Opens when a task row is clicked. Shows the task's full description,
// its dependencies (with status icons resolved against the loaded task
// set), and a chronological comments thread. The composer at the bottom
// supports @mentions resolved against project members — i.e. anyone
// observed as an assignee, locker, or comment author on this project.
//
// Data:
//   - Task body comes from the task already loaded by T12.3. Detail
//     refetches the task on open to pick up server-side description
//     edits that didn't make the list payload.
//   - Comments via `listComments` on open + after each post.
//   - Members are derived locally from the tasks list (assignees /
//     lockers), the current user, and comment authors — no extra
//     endpoint hit. This is the most authoritative set we have without
//     a dedicated /members route, and it stays fresh as tasks reload.
//
// Posting:
//   - createComment → optimistic refetch; "<500ms" acceptance is held
//     by the API latency, not extra UI work here.
//   - Errors surface via the shared Toast.

import {
  For,
  Show,
  Switch,
  Match,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";

import { EmptyState, ErrorCard, SkeletonRows } from "../AsyncStates";
import { showToast } from "../Toast";
import { Tooltip } from "../Tooltip";
import {
  PlanFlowAuthError,
  PlanFlowClient,
  type Comment,
  type Me,
  type Task,
  type TaskStatus,
  type UserSummary,
} from "../../integrations";

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
  DROPPED: "Dropped",
};

const STATUS_ICONS: Record<TaskStatus, string> = {
  TODO: "○",
  IN_PROGRESS: "◐",
  BLOCKED: "⛔",
  DONE: "●",
  DROPPED: "·",
};

export interface TaskDetailPanelProps {
  client: PlanFlowClient;
  externalId: string;
  taskId: string;
  /** Tasks already loaded by the parent list — used to resolve dependency
   *  status icons and to seed the @mention member set. */
  tasks: readonly Task[];
  /** Current user, if known. Used so the user can self-mention and so the
   *  composer can attribute optimistic state. */
  me: Me | null | undefined;
  onClose: () => void;
  /** Called when the user clicks a dependency row — same hook used by the
   *  active-work and activity feed rails. */
  onJumpToTask?: (taskId: string) => void;
}

export function TaskDetailPanel(props: TaskDetailPanelProps): JSX.Element {
  const [reloadKey, setReloadKey] = createSignal(0);

  const [task, { refetch: refetchTask }] = createResource(
    () => ({
      client: props.client,
      externalId: props.externalId,
      taskId: props.taskId,
      reloadKey: reloadKey(),
    }),
    async (input): Promise<Task> => {
      return await input.client.getTask(input.externalId, input.taskId);
    },
  );

  const [comments, { refetch: refetchComments }] = createResource(
    () => ({
      client: props.client,
      externalId: props.externalId,
      taskId: props.taskId,
      reloadKey: reloadKey(),
    }),
    async (input): Promise<Comment[]> => {
      return await input.client.listComments(input.externalId, input.taskId);
    },
  );

  const seededTask = createMemo<Task | null>(() => {
    const fetched = task();
    if (fetched) return fetched;
    return props.tasks.find((t) => t.id === props.taskId) ?? null;
  });

  const tasksById = createMemo<Map<string, Task>>(() => {
    const map = new Map<string, Task>();
    for (const t of props.tasks) map.set(t.id, t);
    return map;
  });

  const members = createMemo<UserSummary[]>(() => {
    const byId = new Map<string, UserSummary>();
    const add = (u: UserSummary | null | undefined): void => {
      if (!u || !u.id) return;
      if (byId.has(u.id)) return;
      byId.set(u.id, u);
    };
    if (props.me) {
      add({ id: props.me.id, email: props.me.email, name: props.me.name });
    }
    for (const t of props.tasks) {
      add(t.assignee);
      add(t.lockedBy);
    }
    for (const c of comments() ?? []) add(c.author);
    return Array.from(byId.values());
  });

  const retry = (): void => {
    setReloadKey((k) => k + 1);
    void refetchTask();
    void refetchComments();
  };

  const handlePosted = (): void => {
    void refetchComments();
  };

  return (
    <aside class="ws-pf-detail" role="complementary" aria-label={`Task ${props.taskId} detail`}>
      <header class="ws-pf-detail__head">
        <div class="ws-pf-detail__head-main">
          <span class="ws-pf-detail__id">{props.taskId}</span>
          <Show when={seededTask()}>
            {(t) => (
              <Tooltip label={STATUS_LABELS[t().status]}>
                <span
                  class="ws-pf-detail__status-dot"
                  data-status={t().status}
                  aria-hidden="true"
                />
              </Tooltip>
            )}
          </Show>
          <h3 class="ws-pf-detail__title" title={seededTask()?.name ?? props.taskId}>
            {seededTask()?.name ?? props.taskId}
          </h3>
        </div>
        <button
          type="button"
          class="ws-pf-detail__close"
          onClick={() => props.onClose()}
          aria-label="Close task detail"
          title="Close"
        >
          ✕
        </button>
      </header>

      <div class="ws-pf-detail__body">
        <Switch>
          <Match when={task.loading && !seededTask()}>
            <SkeletonRows rows={6} ariaLabel="Loading task detail" />
          </Match>
          <Match when={task.error && !seededTask()}>
            <ErrorCard
              title="Couldn't load task"
              message={describeError(task.error as unknown)}
              onRetry={retry}
            />
          </Match>
          <Match when={seededTask()}>
            {(t) => (
              <>
                <TaskDescription task={t()} />
                <TaskDependencies
                  task={t()}
                  tasksById={tasksById()}
                  onJumpToTask={props.onJumpToTask}
                />
                <CommentsThread
                  comments={comments() ?? []}
                  loading={comments.loading}
                  error={comments.error as unknown}
                  onRetry={retry}
                  meId={props.me?.id ?? null}
                />
              </>
            )}
          </Match>
        </Switch>
      </div>

      <Composer
        client={props.client}
        externalId={props.externalId}
        taskId={props.taskId}
        members={members()}
        onPosted={handlePosted}
      />
    </aside>
  );
}

function TaskDescription(props: { task: Task }): JSX.Element {
  const text = (): string =>
    typeof props.task.description === "string" ? props.task.description : "";
  return (
    <section class="ws-pf-detail__section" aria-label="Description">
      <h4 class="ws-pf-detail__section-title">Description</h4>
      <Show
        when={text().trim().length > 0}
        fallback={<p class="ws-pf-detail__muted">No description provided.</p>}
      >
        <pre class="ws-pf-detail__description">{text()}</pre>
      </Show>
      <Show
        when={
          typeof props.task.acceptance === "string" &&
          (props.task.acceptance ?? "").trim().length > 0
        }
      >
        <h4 class="ws-pf-detail__section-title">Acceptance</h4>
        <pre class="ws-pf-detail__description">{props.task.acceptance}</pre>
      </Show>
    </section>
  );
}

interface TaskDependenciesProps {
  task: Task;
  tasksById: Map<string, Task>;
  onJumpToTask?: (taskId: string) => void;
}

function TaskDependencies(props: TaskDependenciesProps): JSX.Element {
  const deps = (): readonly string[] => props.task.dependencies ?? [];
  return (
    <Show when={deps().length > 0}>
      <section class="ws-pf-detail__section" aria-label="Dependencies">
        <h4 class="ws-pf-detail__section-title">Dependencies</h4>
        <ul class="ws-pf-detail__deps" role="list">
          <For each={deps()}>
            {(depId) => {
              const dep = (): Task | null => props.tasksById.get(depId) ?? null;
              const status = (): TaskStatus | null => dep()?.status ?? null;
              const name = (): string => dep()?.name ?? "";
              const interactive = (): boolean => dep() != null;
              return (
                <li>
                  <button
                    type="button"
                    class="ws-pf-detail__dep"
                    onClick={() => props.onJumpToTask?.(depId)}
                    disabled={!interactive()}
                    title={interactive() ? `Jump to ${depId}` : `${depId} not loaded`}
                  >
                    <span
                      class="ws-pf-detail__dep-icon"
                      data-status={status() ?? "UNKNOWN"}
                      aria-hidden="true"
                    >
                      {status() ? STATUS_ICONS[status() as TaskStatus] : "?"}
                    </span>
                    <span class="ws-pf-detail__dep-id">{depId}</span>
                    <Show when={name()}>
                      <span class="ws-pf-detail__dep-name">{name()}</span>
                    </Show>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}

interface CommentsThreadProps {
  comments: readonly Comment[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  meId: string | null;
}

function CommentsThread(props: CommentsThreadProps): JSX.Element {
  const sorted = createMemo<readonly Comment[]>(() => {
    const items = [...props.comments];
    items.sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return ta - tb;
    });
    return items;
  });

  return (
    <section class="ws-pf-detail__section" aria-label="Comments">
      <h4 class="ws-pf-detail__section-title">
        Comments
        <Show when={sorted().length > 0}>
          <span class="ws-pf-detail__section-count">{sorted().length}</span>
        </Show>
      </h4>
      <Switch>
        <Match when={props.loading && props.comments.length === 0}>
          <SkeletonRows rows={3} ariaLabel="Loading comments" />
        </Match>
        <Match when={props.error}>
          <ErrorCard
            title="Couldn't load comments"
            message={describeError(props.error)}
            onRetry={props.onRetry}
          />
        </Match>
        <Match when={sorted().length === 0}>
          <EmptyState
            variant="muted"
            title="No comments yet"
            description="Be the first to leave a note."
            ariaLabel="No comments yet"
          />
        </Match>
        <Match when={sorted().length > 0}>
          <ul class="ws-pf-detail__comments" role="list">
            <For each={sorted()}>
              {(comment) => (
                <CommentRow comment={comment} isMine={comment.author?.id === props.meId} />
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </section>
  );
}

function CommentRow(props: { comment: Comment; isMine: boolean }): JSX.Element {
  const authorName = (): string => {
    const a = props.comment.author;
    if (!a) return "Unknown";
    return a.name?.trim() || a.email || "Unknown";
  };
  const when = (): string => {
    const ts = props.comment.createdAt;
    if (!ts) return "";
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleString();
  };
  return (
    <li class="ws-pf-detail__comment" data-mine={props.isMine ? "true" : undefined}>
      <div class="ws-pf-detail__comment-head">
        <span class="ws-pf-detail__comment-author">{authorName()}</span>
        <Show when={when()}>
          <span class="ws-pf-detail__comment-time">{when()}</span>
        </Show>
      </div>
      <div class="ws-pf-detail__comment-body">{props.comment.body}</div>
    </li>
  );
}

interface ComposerProps {
  client: PlanFlowClient;
  externalId: string;
  taskId: string;
  members: readonly UserSummary[];
  onPosted: () => void;
}

function Composer(props: ComposerProps): JSX.Element {
  const [draft, setDraft] = createSignal("");
  const [posting, setPosting] = createSignal(false);
  // Mention state: when the caret sits inside an @token, we surface a
  // popover with member matches. `mentionStart` is the index of the `@`
  // in the draft; the query is whatever follows up to the caret.
  const [mentionStart, setMentionStart] = createSignal<number | null>(null);
  const [mentionQuery, setMentionQuery] = createSignal("");
  const [mentionIndex, setMentionIndex] = createSignal(0);
  let textareaRef: HTMLTextAreaElement | undefined;

  const matches = createMemo<readonly UserSummary[]>(() => {
    if (mentionStart() == null) return [];
    const q = mentionQuery().trim().toLowerCase();
    const all = props.members;
    if (!q) return all.slice(0, 6);
    return all.filter((m) => mentionMatches(m, q)).slice(0, 6);
  });

  createEffect(() => {
    // Reset the highlighted suggestion when the match set changes so the
    // arrow-key index doesn't point at a dropped row.
    matches();
    setMentionIndex(0);
  });

  const closeMentions = (): void => {
    setMentionStart(null);
    setMentionQuery("");
  };

  const updateMentionState = (value: string, caret: number): void => {
    // Walk backwards from the caret to the most recent `@`. The mention
    // popover is active when we hit `@` before whitespace (or the start
    // of the string). This matches Slack/GitHub behaviour where typing
    // mid-word doesn't accidentally trigger the suggester.
    let i = caret - 1;
    while (i >= 0) {
      const ch = value.charAt(i);
      if (ch === "@") {
        const prev = i === 0 ? " " : value.charAt(i - 1);
        if (prev === " " || prev === "\n" || prev === "\t" || i === 0) {
          setMentionStart(i);
          setMentionQuery(value.slice(i + 1, caret));
          return;
        }
        break;
      }
      if (/\s/.test(ch)) break;
      i -= 1;
    }
    closeMentions();
  };

  const handleInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }): void => {
    const value = event.currentTarget.value;
    const caret = event.currentTarget.selectionStart ?? value.length;
    setDraft(value);
    updateMentionState(value, caret);
  };

  const insertMention = (user: UserSummary): void => {
    const start = mentionStart();
    if (start == null || !textareaRef) {
      closeMentions();
      return;
    }
    const value = draft();
    const caret = textareaRef.selectionStart ?? value.length;
    const handle = mentionHandleFor(user);
    const next = `${value.slice(0, start)}@${handle} ${value.slice(caret)}`;
    setDraft(next);
    closeMentions();
    // Restore focus + caret position to right after the inserted handle.
    queueMicrotask(() => {
      if (!textareaRef) return;
      const insertedLen = handle.length + 2; // "@" + handle + " "
      const newCaret = start + insertedLen;
      textareaRef.focus();
      textareaRef.setSelectionRange(newCaret, newCaret);
      textareaRef.value = next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (mentionStart() != null && matches().length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % matches().length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const len = matches().length;
        setMentionIndex((i) => (i - 1 + len) % len);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const m = matches()[mentionIndex()];
        if (m) {
          event.preventDefault();
          insertMention(m);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentions();
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const submit = async (): Promise<void> => {
    const body = draft().trim();
    if (!body || posting()) return;
    setPosting(true);
    try {
      await props.client.createComment(props.externalId, props.taskId, { body });
      setDraft("");
      closeMentions();
      props.onPosted();
    } catch (error) {
      if (error instanceof PlanFlowAuthError) {
        showToast({
          message: "PlanFlow rejected the token. Reconnect in Settings.",
          variant: "error",
        });
      } else {
        const detail = error instanceof Error ? error.message : "Unknown error.";
        showToast({ message: `Couldn't post comment: ${detail}`, variant: "error" });
      }
    } finally {
      setPosting(false);
    }
  };

  onCleanup(() => {
    closeMentions();
  });

  return (
    <form
      class="ws-pf-detail__composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div class="ws-pf-detail__composer-wrap">
        <textarea
          ref={textareaRef}
          class="ws-pf-detail__textarea"
          placeholder="Add a comment… (⌘/Ctrl+Enter to post, @ to mention)"
          aria-label="Comment text"
          value={draft()}
          onInput={(e) => handleInput(e as InputEvent & { currentTarget: HTMLTextAreaElement })}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={posting()}
        />
        <Show when={mentionStart() != null && matches().length > 0}>
          <ul class="ws-pf-detail__mentions" role="listbox" aria-label="Mention suggestions">
            <For each={matches()}>
              {(user, idx) => (
                <li>
                  <button
                    type="button"
                    class="ws-pf-detail__mention"
                    data-active={idx() === mentionIndex() ? "true" : undefined}
                    onMouseDown={(e) => {
                      // mousedown so the textarea doesn't lose focus before
                      // the click registers — same trick as @mention pickers
                      // in Slack / Linear.
                      e.preventDefault();
                      insertMention(user);
                    }}
                  >
                    <span class="ws-pf-detail__mention-handle">@{mentionHandleFor(user)}</span>
                    <Show when={user.name && user.name !== mentionHandleFor(user)}>
                      <span class="ws-pf-detail__mention-name">{user.name}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <div class="ws-pf-detail__composer-actions">
        <button
          type="submit"
          class="ws-pf-detail__post"
          disabled={posting() || draft().trim().length === 0}
        >
          {posting() ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
}

export function mentionHandleFor(user: UserSummary): string {
  // Prefer email local-part for handles — names contain spaces and would
  // otherwise need quoting. Fall back to name (spaces → dashes) then id.
  if (user.email) {
    const local = user.email.split("@")[0];
    if (local && local.length > 0) return local;
  }
  if (user.name) {
    const slug = user.name.trim().replace(/\s+/g, "-").toLowerCase();
    if (slug.length > 0) return slug;
  }
  return user.id;
}

export function mentionMatches(user: UserSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (user.name && user.name.toLowerCase().includes(q)) return true;
  if (user.email && user.email.toLowerCase().includes(q)) return true;
  if (mentionHandleFor(user).toLowerCase().includes(q)) return true;
  return false;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unexpected error.";
}

export default TaskDetailPanel;
