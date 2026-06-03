// Codex-style Git review panel for the Agent view: working-tree changes with
// per-file unified diffs and stage / unstage / discard / commit actions.
// Refreshes whenever `refreshKey` changes (the agent finishing a turn) so it
// stays in sync with edits Claude makes.

import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import {
  gitCommit,
  gitDiffFile,
  gitDiscard,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  type GitFile,
} from "../../ipc/git";

export interface GitReviewPanelProps {
  cwd?: string;
  /** Bumped by the parent to force a status refresh (e.g. after a turn). */
  refreshKey: number;
  /** Whether the panel is expanded — skips git calls while collapsed. */
  visible: boolean;
}

interface DiffRow {
  kind: "hunk" | "context" | "add" | "del" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const fileKey = (f: GitFile): string => `${f.staged ? "s" : "u"}:${f.path}`;
const baseName = (p: string): string => p.split("/").slice(-2).join("/");

/** Parse a unified diff into rows with old/new line numbers. */
function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = Number.parseInt(m[1] ?? "0", 10);
        newNo = Number.parseInt(m[2] ?? "0", 10);
      }
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
    } else {
      rows.push({ kind: "context", oldNo, newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
  }
  return rows;
}

export function GitReviewPanel(props: GitReviewPanelProps): JSX.Element {
  const [branch, setBranch] = createSignal("—");
  const [files, setFiles] = createSignal<GitFile[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [localKey, setLocalKey] = createSignal(0);
  const [openKeys, setOpenKeys] = createSignal<ReadonlySet<string>>(new Set());
  const [diffs, setDiffs] = createSignal<Record<string, string>>({});
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);

  const refresh = (): void => {
    setLocalKey((k) => k + 1);
  };

  // Load status whenever the parent refresh key, the local key, or cwd change.
  createEffect(() => {
    const cwd = props.cwd;
    void props.refreshKey;
    void localKey();
    const visible = props.visible;
    if (!cwd || !visible) {
      if (!cwd) setFiles([]);
      setError(null);
      return;
    }
    void gitStatus(cwd)
      .then((s) => {
        setBranch(s.branch);
        setFiles(s.files);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  });

  const unstaged = (): GitFile[] => files().filter((f) => !f.staged);
  const staged = (): GitFile[] => files().filter((f) => f.staged);
  const totalAdds = (): number => files().reduce((n, f) => n + f.adds, 0);
  const totalDels = (): number => files().reduce((n, f) => n + f.dels, 0);

  const toggle = (f: GitFile): void => {
    const key = fileKey(f);
    const willOpen = !openKeys().has(key);
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (willOpen && diffs()[key] === undefined && props.cwd) {
      void gitDiffFile(props.cwd, f.path, f.staged)
        .then((d) => setDiffs((prev) => ({ ...prev, [key]: d })))
        .catch(() => setDiffs((prev) => ({ ...prev, [key]: "" })));
    }
  };

  const act = (fn: (cwd: string) => Promise<unknown>): void => {
    const cwd = props.cwd;
    if (!cwd) return;
    void fn(cwd)
      .then(() => {
        setDiffs({});
        refresh();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const doCommit = (): void => {
    const cwd = props.cwd;
    const msg = commitMsg().trim();
    if (!cwd || msg.length === 0) return;
    setCommitting(true);
    void gitCommit(cwd, msg)
      .then(() => {
        setCommitMsg("");
        setDiffs({});
        refresh();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCommitting(false));
  };

  return (
    <div class="flex h-full min-h-0 flex-col bg-canvas text-fg">
      {/* Top bar */}
      <div class="flex items-center gap-2 border-b border-border-default px-3 py-2 text-[12px]">
        <span class="font-medium">Review</span>
        <span class="font-mono text-[11px]">
          <span class="text-success">+{totalAdds()}</span>{" "}
          <span class="text-danger">-{totalDels()}</span>
        </span>
        <span class="ml-auto flex items-center gap-2 text-fg-secondary">
          <span class="flex items-center gap-1">
            <IconBranch />
            {branch()}
          </span>
          <button
            type="button"
            class="rounded-md px-1.5 py-0.5 hover:bg-hover"
            aria-label="Refresh"
            onClick={refresh}
          >
            <IconRefresh />
          </button>
        </span>
      </div>

      <Show when={error()}>
        <div class="border-b border-border-default px-3 py-2 text-[11px] text-danger">
          {error()}
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={files().length > 0}
          fallback={<div class="p-4 text-center text-[12px] text-fg-secondary">No changes.</div>}
        >
          <Group
            title="Unstaged"
            files={unstaged()}
            isOpen={(f) => openKeys().has(fileKey(f))}
            diff={(f) => diffs()[fileKey(f)]}
            onToggle={toggle}
            actionLabel="Stage"
            onAction={(f) => act((cwd) => gitStage(cwd, f.path))}
            secondaryLabel="Discard"
            onSecondary={(f) => {
              if (window.confirm(`Discard changes to ${f.path}? This cannot be undone.`)) {
                act((cwd) => gitDiscard(cwd, f.path));
              }
            }}
            trailing={
              <Show when={unstaged().length > 0}>
                <button
                  type="button"
                  class="rounded-md px-2 py-0.5 text-[11px] text-accent hover:bg-hover"
                  onClick={() => act((cwd) => gitStageAll(cwd))}
                >
                  Stage all
                </button>
              </Show>
            }
          />
          <Group
            title="Staged"
            files={staged()}
            isOpen={(f) => openKeys().has(fileKey(f))}
            diff={(f) => diffs()[fileKey(f)]}
            onToggle={toggle}
            actionLabel="Unstage"
            onAction={(f) => act((cwd) => gitUnstage(cwd, f.path))}
          />
        </Show>
      </div>

      {/* Commit bar */}
      <div class="border-t border-border-default p-2">
        <input
          class="w-full rounded-lg border border-border-default bg-surface px-2.5 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-fg-secondary focus:border-accent"
          placeholder="Commit message…"
          value={commitMsg()}
          onInput={(e) => setCommitMsg(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") doCommit();
          }}
        />
        <div class="mt-1.5 flex items-center justify-between">
          <span class="text-[11px] text-fg-secondary">{staged().length} staged</span>
          <button
            type="button"
            class="rounded-lg bg-accent px-3 py-1 text-[12px] text-canvas transition-opacity disabled:opacity-30"
            disabled={committing() || commitMsg().trim().length === 0 || staged().length === 0}
            onClick={doCommit}
          >
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}

interface GroupProps {
  title: string;
  files: GitFile[];
  isOpen: (f: GitFile) => boolean;
  diff: (f: GitFile) => string | undefined;
  onToggle: (f: GitFile) => void;
  actionLabel: string;
  onAction: (f: GitFile) => void;
  secondaryLabel?: string;
  onSecondary?: (f: GitFile) => void;
  trailing?: JSX.Element;
}

function Group(props: GroupProps): JSX.Element {
  return (
    <Show when={props.files.length > 0}>
      <div class="flex items-center gap-2 px-3 py-1.5 text-[11px] uppercase tracking-wide text-fg-secondary">
        <span>{props.title}</span>
        <span class="rounded-full bg-surface px-1.5">{props.files.length}</span>
        <span class="ml-auto">{props.trailing}</span>
      </div>
      <For each={props.files}>
        {(f) => (
          <div class="border-t border-border-default">
            <div class="group flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-hover">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => props.onToggle(f)}
              >
                <span
                  class="w-3 shrink-0 text-center font-mono text-[11px]"
                  classList={{
                    "text-success": f.status === "A" || f.status === "?",
                    "text-warning": f.status === "M",
                    "text-danger": f.status === "D",
                  }}
                >
                  {f.status}
                </span>
                <span class="truncate font-mono">{baseName(f.path)}</span>
                <span class="shrink-0 font-mono text-[11px]">
                  <span class="text-success">+{f.adds}</span>{" "}
                  <span class="text-danger">-{f.dels}</span>
                </span>
              </button>
              <Show when={props.secondaryLabel}>
                <button
                  type="button"
                  class="shrink-0 rounded px-1.5 text-[11px] text-fg-secondary opacity-0 hover:text-danger group-hover:opacity-100"
                  onClick={() => props.onSecondary?.(f)}
                >
                  {props.secondaryLabel}
                </button>
              </Show>
              <button
                type="button"
                class="shrink-0 rounded px-1.5 text-[11px] text-accent opacity-0 hover:bg-hover group-hover:opacity-100"
                onClick={() => props.onAction(f)}
              >
                {props.actionLabel}
              </button>
            </div>
            <Show when={props.isOpen(f)}>
              <DiffView text={props.diff(f)} />
            </Show>
          </div>
        )}
      </For>
    </Show>
  );
}

function DiffView(props: { text: string | undefined }): JSX.Element {
  return (
    <Show
      when={props.text !== undefined}
      fallback={<div class="px-3 py-2 text-[11px] text-fg-secondary">Loading diff…</div>}
    >
      <Show
        when={(props.text ?? "").trim().length > 0}
        fallback={<div class="px-3 py-2 text-[11px] text-fg-secondary">No textual diff.</div>}
      >
        <div class="overflow-x-auto bg-surface font-mono text-[11.5px] leading-5">
          <For each={parseUnifiedDiff(props.text ?? "")}>
            {(row) => (
              <div
                class="flex"
                classList={{
                  "bg-success/10": row.kind === "add",
                  "bg-danger/10": row.kind === "del",
                  "text-fg-secondary": row.kind === "hunk" || row.kind === "meta",
                }}
              >
                <span class="w-9 shrink-0 select-none px-1 text-right text-fg-secondary opacity-60">
                  {row.oldNo ?? ""}
                </span>
                <span class="w-9 shrink-0 select-none px-1 text-right text-fg-secondary opacity-60">
                  {row.newNo ?? ""}
                </span>
                <span
                  class="w-3 shrink-0 select-none text-center"
                  classList={{
                    "text-success": row.kind === "add",
                    "text-danger": row.kind === "del",
                  }}
                >
                  {row.kind === "add" ? "+" : row.kind === "del" ? "-" : ""}
                </span>
                <span
                  class="whitespace-pre pr-3"
                  classList={{
                    "text-success": row.kind === "add",
                    "text-danger": row.kind === "del",
                  }}
                >
                  {row.text}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}

function IconBranch(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5 3v7M5 13a2 2 0 100-4 2 2 0 000 4zM5 3a2 2 0 100-.01M11 6a2 2 0 100-4 2 2 0 000 4zm0 0c0 3-6 1-6 4"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
  );
}

function IconRefresh(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 3v3h-3M3 13v-3h3M12.5 6a5 5 0 00-8.5-1.5L3 6M3.5 10a5 5 0 008.5 1.5L13 10"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export default GitReviewPanel;
