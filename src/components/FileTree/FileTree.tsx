// T13.2: FileTree — recursive folder navigator scoped to a project root.
//
// Lazy by design: child entries for a folder are fetched the first time
// the user expands it. The component keeps its own Map of fetched
// children keyed by absolute path so re-collapse → re-expand is free
// (and the user's expansion state survives the parent re-rendering with
// a new `root`). Children are cleared from the map when the root prop
// changes, since the previous tree is no longer addressable.
//
// Errors per folder are local — if listing one subdir fails (permissions,
// vanished mid-click) the row shows the error inline and the rest of the
// tree keeps working. The root listing's error gets the whole panel.
//
// Out of scope for T13.2 (deferred):
//   • Virtualization for >500 entries — `<For>` is fine until we see the
//     pathological monorepo case.
//   • Full `.gitignore` parsing — the Rust side strips the obvious noise
//     dirs (`.git`, `node_modules`, `target`, etc.) which covers the
//     "drowning in build output" case T13.2 calls out.
//   • Right-click / rename / drag-reorder — touched in T13.4+.

import { For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { fsListDir, type FsDirEntry } from "../../ipc/fs";

export interface FileTreeProps {
  /** Absolute filesystem path of the project root. */
  root: string;
  /** Fires when the user clicks a file row. The path is absolute and
   *  ready to feed into T13.3's file-open command. */
  onSelectFile?: (path: string) => void;
  /** Optional currently-open file path so the matching row is highlighted. */
  selectedPath?: string | null;
  /** Optional class for the host element. */
  class?: string;
}

type FolderState =
  | { kind: "loading" }
  | { kind: "loaded"; entries: FsDirEntry[] }
  | { kind: "error"; message: string };

export function FileTree(props: FileTreeProps): JSX.Element {
  // Children-by-path cache + expanded-paths set live in signals so any
  // change re-renders the affected subtree without invalidating siblings.
  const [folders, setFolders] = createSignal<Record<string, FolderState>>({});
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  const loadFolder = async (path: string): Promise<void> => {
    setFolders((prev) => ({ ...prev, [path]: { kind: "loading" } }));
    try {
      const entries = await fsListDir(path);
      setFolders((prev) => ({ ...prev, [path]: { kind: "loaded", entries } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFolders((prev) => ({ ...prev, [path]: { kind: "error", message } }));
    }
  };

  // Eager-load the root on mount and whenever the project changes. We
  // clear the caches first so stale entries from the previous project
  // don't briefly flash if a folder happens to share a path prefix.
  onMount(() => {
    void loadFolder(props.root);
    setExpanded({ [props.root]: true });
  });

  createEffect(
    on(
      () => props.root,
      (root, prevRoot) => {
        if (prevRoot === undefined || root === prevRoot) return;
        setFolders({});
        setExpanded({ [root]: true });
        void loadFolder(root);
      },
      { defer: true },
    ),
  );

  const toggleFolder = (path: string): void => {
    const isOpen = expanded()[path] === true;
    if (isOpen) {
      setExpanded((prev) => ({ ...prev, [path]: false }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [path]: true }));
    if (folders()[path] === undefined) {
      void loadFolder(path);
    }
  };

  const handleEntryClick = (entry: FsDirEntry): void => {
    if (entry.isDir) {
      toggleFolder(entry.path);
    } else {
      props.onSelectFile?.(entry.path);
    }
  };

  const renderFolderBody = (path: string, depth: number): JSX.Element => {
    const state = (): FolderState | undefined => folders()[path];
    return (
      <Show when={state()} fallback={null}>
        {(s) => (
          <Show
            when={s().kind === "loaded" ? (s() as { entries: FsDirEntry[] }) : null}
            fallback={
              <Show when={s().kind === "error" ? (s() as { message: string }) : null}>
                {(err) => (
                  <div
                    class="ws-ft__error"
                    style={{ "padding-left": `${indentPx(depth + 1)}px` }}
                    role="alert"
                  >
                    {err().message}
                  </div>
                )}
              </Show>
            }
          >
            {(loaded) => (
              <For each={loaded().entries}>{(entry) => renderEntry(entry, depth + 1)}</For>
            )}
          </Show>
        )}
      </Show>
    );
  };

  const renderEntry = (entry: FsDirEntry, depth: number): JSX.Element => {
    const isOpen = (): boolean => expanded()[entry.path] === true;
    const isSelected = (): boolean => !entry.isDir && props.selectedPath === entry.path;
    return (
      <>
        <button
          type="button"
          class="ws-ft__row"
          data-kind={entry.isDir ? "dir" : "file"}
          data-selected={isSelected() ? "true" : "false"}
          style={{ "padding-left": `${indentPx(depth)}px` }}
          onClick={() => handleEntryClick(entry)}
          aria-expanded={entry.isDir ? isOpen() : undefined}
          title={entry.path}
        >
          <span class="ws-ft__chev" aria-hidden="true">
            <Show when={entry.isDir} fallback={null}>
              {isOpen() ? "▾" : "▸"}
            </Show>
          </span>
          <span class="ws-ft__icon" aria-hidden="true">
            {entry.isDir ? "📁" : "📄"}
          </span>
          <span class="ws-ft__name">{entry.name}</span>
        </button>
        <Show when={entry.isDir && isOpen()}>{renderFolderBody(entry.path, depth)}</Show>
      </>
    );
  };

  const rootState = (): FolderState | undefined => folders()[props.root];

  return (
    <div class={`ws-ft ${props.class ?? ""}`.trim()}>
      <Show when={rootState()} fallback={<div class="ws-ft__hint">Loading…</div>}>
        {(s) => (
          <Show
            when={s().kind === "loaded" ? (s() as { entries: FsDirEntry[] }) : null}
            fallback={
              <Show when={s().kind === "error" ? (s() as { message: string }) : null}>
                {(err) => (
                  <div class="ws-ft__error" role="alert">
                    {err().message}
                  </div>
                )}
              </Show>
            }
          >
            {(loaded) => (
              <For each={loaded().entries} fallback={<div class="ws-ft__hint">Empty folder.</div>}>
                {(entry) => renderEntry(entry, 0)}
              </For>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

function indentPx(depth: number): number {
  return 8 + depth * 14;
}

export default FileTree;
