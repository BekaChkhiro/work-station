// T13.9: project-wide find in files.
//
// Sits inside the Editor tab beside the file tree. The user opens it via
// Cmd/Ctrl+Shift+F while the Editor tab is focused (AppShell dispatches
// the `find-in-files` menu action); the input is auto-focused. Each
// keystroke debounces a `search_in_project` call to the Rust side, which
// shells out to ripgrep — see `src-tauri/src/commands/search.rs` for the
// process / flag detail. Results stream back as a flat array; the UI
// groups them by file and renders one line per match, with the matched
// substring highlighted via `MatchRange` byte offsets.
//
// Clicking a row hands the absolute path + line number back to the
// EditorWorkspace, which feeds the existing file-open flow (T13.3) and
// the new `reveal` prop on MonacoEditor (T13.9).

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { searchInProject, type SearchMatch, type SearchResponse } from "../../ipc/search";
import { Tooltip } from "../Tooltip";

export interface ProjectSearchProps {
  /** Absolute project root. Required for the rg subprocess to know
   *  where to scan; if absent the panel renders a "no project" hint. */
  projectRoot: string | null;
  /** Fires when the user clicks a match. The path is absolute (root +
   *  relative) so it can feed straight into `read_text_file` and the
   *  Editor's existing `handleSelect` flow. */
  onOpenMatch: (absPath: string, line: number, column: number) => void;
  /** Fires when the user dismisses the panel (Esc or close button).
   *  Parent typically flips back to the file-tree view. */
  onClose: () => void;
  /** Re-focus the input when this changes — used by the parent to
   *  re-focus the panel when the shortcut is pressed a second time
   *  while the panel is already open. */
  focusVersion?: number;
  class?: string;
}

interface MatchGroup {
  path: string;
  matches: SearchMatch[];
}

const DEBOUNCE_MS = 180;

/** Build absolute path from project root + relative match path. The
 *  Rust side normalizes match paths to forward slashes on every OS; we
 *  join with the platform separator the root already uses so the result
 *  round-trips into `read_text_file` cleanly. */
function joinPath(root: string, relative: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const trimmed = relative.startsWith("./") ? relative.slice(2) : relative;
  // Strip trailing separator from root if any.
  const cleanRoot = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  const target = sep === "\\" ? trimmed.replace(/\//g, "\\") : trimmed;
  return `${cleanRoot}${sep}${target}`;
}

function groupByFile(matches: SearchMatch[]): MatchGroup[] {
  const groups: MatchGroup[] = [];
  let current: MatchGroup | null = null;
  for (const m of matches) {
    if (current === null || current.path !== m.path) {
      current = { path: m.path, matches: [] };
      groups.push(current);
    }
    current.matches.push(m);
  }
  return groups;
}

/** Slice the line text into pre/match/post fragments using the byte
 *  offsets ripgrep emits. Ripgrep returns BYTE offsets in UTF-8, while
 *  JavaScript strings are UTF-16 code units; for ASCII (the vast
 *  majority of source code) these align. For multi-byte characters we
 *  fall back to plain rendering rather than highlight the wrong span —
 *  better than mis-aligning the `<mark>`. */
function highlightLine(text: string, ranges: SearchMatch["ranges"]): JSX.Element {
  if (ranges.length === 0) return <span>{text}</span>;
  // Heuristic: if the byte length matches the JS length, the line is
  // ASCII (or close enough) and the offsets translate 1:1.
  const utf8Length = new TextEncoder().encode(text).length;
  if (utf8Length !== text.length) {
    return <span>{text}</span>;
  }
  const out: JSX.Element[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) out.push(<span>{text.slice(cursor, r.start)}</span>);
    out.push(<mark class="ws-psearch__hit">{text.slice(r.start, r.end)}</mark>);
    cursor = r.end;
  }
  if (cursor < text.length) out.push(<span>{text.slice(cursor)}</span>);
  return <>{out}</>;
}

export function ProjectSearch(props: ProjectSearchProps): JSX.Element {
  let inputEl!: HTMLInputElement;
  let listEl: HTMLDivElement | undefined;

  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  const [response, setResponse] = createSignal<SearchResponse | null>(null);
  const [status, setStatus] = createSignal<"idle" | "searching" | "error">("idle");
  const [error, setError] = createSignal<string | null>(null);
  // Token guards against an older slow search overwriting a newer one.
  let searchSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDebounce = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const runSearch = async (): Promise<void> => {
    const q = query();
    const root = props.projectRoot;
    if (!q || !root) {
      setResponse(null);
      setStatus("idle");
      setError(null);
      return;
    }
    const myToken = ++searchSeq;
    setStatus("searching");
    setError(null);
    try {
      const res = await searchInProject(root, q, {
        regex: regex(),
        caseSensitive: caseSensitive(),
        wholeWord: wholeWord(),
      });
      if (myToken !== searchSeq) return;
      setResponse(res);
      setStatus("idle");
    } catch (err) {
      if (myToken !== searchSeq) return;
      const message = extractErrorMessage(err);
      setError(message);
      setResponse(null);
      setStatus("error");
    }
  };

  // Debounce searches on query / option changes so typing doesn't fan
  // out one rg subprocess per keystroke. We also re-search immediately
  // when an option toggle flips (no debounce needed — those changes are
  // discrete, not streaming).
  createEffect(
    on(
      () => [query(), regex(), caseSensitive(), wholeWord()] as const,
      (deps, prev) => {
        const onlyQueryChanged =
          prev !== undefined && deps[1] === prev[1] && deps[2] === prev[2] && deps[3] === prev[3];
        clearDebounce();
        if (onlyQueryChanged) {
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void runSearch();
          }, DEBOUNCE_MS);
        } else {
          void runSearch();
        }
      },
    ),
  );

  // Parent can refocus by bumping focusVersion (e.g. when the user hits
  // Cmd+Shift+F again with the panel already open).
  createEffect(
    on(
      () => props.focusVersion,
      () => {
        inputEl?.focus();
        inputEl?.select();
      },
    ),
  );

  onCleanup(() => {
    searchSeq++; // Invalidate any in-flight callback.
    clearDebounce();
  });

  const groups = createMemo<MatchGroup[]>(() => groupByFile(response()?.matches ?? []));

  const matchCount = (): number => response()?.matches.length ?? 0;
  const fileCount = (): number => groups().length;

  const summary = (): string => {
    if (!props.projectRoot) return "No project root";
    if (!query()) return "Type to search project files";
    const r = response();
    if (status() === "searching" && !r) return "Searching…";
    if (status() === "error") return error() ?? "Search failed";
    if (r === null) return "";
    if (r.matches.length === 0) return "No matches";
    const fc = fileCount();
    const mc = matchCount();
    const suffix = r.truncated ? "+" : "";
    return `${mc}${suffix} ${mc === 1 ? "match" : "matches"} in ${fc} ${fc === 1 ? "file" : "files"}`;
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      // First Esc clears query if present; second closes. Familiar from
      // most search inputs, and avoids accidentally bailing on a long
      // query.
      if (query()) {
        setQuery("");
        return;
      }
      props.onClose();
    }
  };

  const onMatchClick = (m: SearchMatch): void => {
    const root = props.projectRoot;
    if (!root) return;
    props.onOpenMatch(joinPath(root, m.path), m.lineNumber, m.column);
  };

  return (
    <div class={`ws-psearch ${props.class ?? ""}`.trim()} role="region" aria-label="Find in files">
      <div class="ws-psearch__head">
        <div class="ws-psearch__title-row">
          <span class="ws-psearch__title">Search</span>
          <Tooltip label="Close search" shortcut="Esc">
            <button
              type="button"
              class="ws-psearch__btn ws-psearch__btn--close"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onClose()}
              aria-label="Close search"
            >
              ×
            </button>
          </Tooltip>
        </div>
        <div class="ws-psearch__input-row">
          <input
            ref={inputEl}
            class="ws-psearch__input"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search in project…"
            spellcheck={false}
            autocomplete="off"
            aria-label="Search query"
          />
        </div>
        <div class="ws-psearch__opts">
          <Tooltip label="Match case">
            <button
              type="button"
              class="ws-psearch__btn"
              classList={{ "is-on": caseSensitive() }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-pressed={caseSensitive()}
              aria-label="Match case"
            >
              Aa
            </button>
          </Tooltip>
          <Tooltip label="Match whole word">
            <button
              type="button"
              class="ws-psearch__btn"
              classList={{ "is-on": wholeWord() }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setWholeWord((v) => !v)}
              aria-pressed={wholeWord()}
              aria-label="Match whole word"
            >
              ab
            </button>
          </Tooltip>
          <Tooltip label="Use regular expression">
            <button
              type="button"
              class="ws-psearch__btn"
              classList={{ "is-on": regex() }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setRegex((v) => !v)}
              aria-pressed={regex()}
              aria-label="Use regular expression"
            >
              .*
            </button>
          </Tooltip>
        </div>
        <div class="ws-psearch__summary" data-status={status()} role="status" aria-live="polite">
          {summary()}
        </div>
      </div>
      <div ref={listEl} class="ws-psearch__list">
        <Show when={groups().length > 0}>
          <For each={groups()}>
            {(group) => (
              <div class="ws-psearch__group" role="group" aria-label={group.path}>
                <div class="ws-psearch__file" title={group.path}>
                  {group.path}
                  <span class="ws-psearch__file-count">{group.matches.length}</span>
                </div>
                <For each={group.matches}>
                  {(m) => (
                    <button
                      type="button"
                      class="ws-psearch__row"
                      onClick={() => onMatchClick(m)}
                      title={`${group.path}:${m.lineNumber}:${m.column}`}
                    >
                      <span class="ws-psearch__lineno">{m.lineNumber}</span>
                      <span class="ws-psearch__snippet">{highlightLine(m.text, m.ranges)}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
          <Show when={response()?.truncated}>
            <div class="ws-psearch__truncated">
              Showing first results — refine the query for more.
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { message?: unknown; userMessage?: unknown };
    if (typeof maybe.userMessage === "string") return maybe.userMessage;
    if (typeof maybe.message === "string") return maybe.message;
  }
  if (typeof err === "string") return err;
  return "Search failed";
}

export default ProjectSearch;
