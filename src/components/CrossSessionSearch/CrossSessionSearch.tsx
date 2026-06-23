// T4.13: Cross-session search modal.
//
// Officially deferred to v0.2 (PROJECT_PLAN.md §10). This scaffold ships
// early to keep the session registry wiring honest, but the feature is
// considered post-v0.1 scope — do not promote it back into v0.1 planning.
//
// Cmd/Ctrl+Shift+F: search across every open session's scrollback in one
// pass, then jump to a match by scrolling the owning pane's terminal.
//
// Scope:
//   • Reads scrollback from the session registry (stores/sessions). Each
//     Terminal exposes a getScrollback() that walks `term.buffer.active`
//     so what we scan matches what the user sees, including post-decode
//     UTF-8 and ANSI-rendered text.
//   • `projectId` filter narrows results to the current project when one
//     is provided. Until project context lands (Phase 6), callers pass
//     undefined and we search every registered session.
//   • Match expansion is line-level: each result is one line, with up to
//     a few characters of leading context for readability. We do not
//     return multi-line context yet — keeps the result list compact and
//     avoids paying for substring slicing on huge buffers until needed.

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { sessionList } from "../../stores/sessions";
import { Tooltip } from "../Tooltip";

export interface CrossSessionSearchProps {
  open: boolean;
  onClose: () => void;
  /** When set, only search sessions belonging to this project. */
  projectId?: string;
}

interface MatchHit {
  sessionId: string;
  sessionTitle: string;
  /** 0-based buffer line where the match was found. */
  line: number;
  /** Full text of the line, used for the result snippet. */
  lineText: string;
  /** Start offset of the match within `lineText`. */
  matchStart: number;
  /** Match length, in characters. */
  matchLength: number;
}

const MAX_SNIPPET_LEN = 220;
const MAX_RESULTS = 500;

const buildPattern = (query: string, regex: boolean, caseSensitive: boolean): RegExp | null => {
  if (!query) return null;
  const flags = caseSensitive ? "g" : "gi";
  try {
    if (regex) return new RegExp(query, flags);
    // Escape every regex metachar so plain-text queries work as substring search.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  } catch {
    return null;
  }
};

// Trim a long line around the match so the result row doesn't blow out
// horizontally. Keep the match itself fully visible plus a sliver of
// leading context for orientation.
const snippetFor = (lineText: string, matchStart: number): { text: string; start: number } => {
  if (lineText.length <= MAX_SNIPPET_LEN) return { text: lineText, start: matchStart };
  const lead = 24;
  const start = Math.max(0, matchStart - lead);
  const end = Math.min(lineText.length, start + MAX_SNIPPET_LEN);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < lineText.length ? "…" : "";
  return {
    text: prefix + lineText.slice(start, end) + suffix,
    start: matchStart - start + prefix.length,
  };
};

export function CrossSessionSearch(props: CrossSessionSearchProps) {
  let inputEl!: HTMLInputElement;
  let listEl!: HTMLUListElement;
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [activeIdx, setActiveIdx] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  const sessionsInScope = createMemo(() => {
    const all = sessionList();
    if (!props.projectId) return all;
    return all.filter((s) => s.projectId === props.projectId);
  });

  const results = createMemo<MatchHit[]>(() => {
    const q = query();
    const pattern = buildPattern(q, regex(), caseSensitive());
    if (!pattern) {
      setError(q && regex() ? "invalid regex" : null);
      return [];
    }
    setError(null);

    const hits: MatchHit[] = [];
    for (const session of sessionsInScope()) {
      let lines: string[];
      try {
        lines = session.getScrollback();
      } catch {
        continue;
      }
      const title = session.title ?? session.id;
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        if (!text) continue;
        // Reset lastIndex for each line — `g` flag makes it stateful.
        pattern.lastIndex = 0;
        const m = pattern.exec(text);
        if (!m) continue;
        // Guard against zero-width regex matches looping forever — we only
        // record one hit per line anyway, so length-zero matches are ignored.
        if (m[0].length === 0) continue;
        hits.push({
          sessionId: session.id,
          sessionTitle: title,
          line: i,
          lineText: text,
          matchStart: m.index,
          matchLength: m[0].length,
        });
        if (hits.length >= MAX_RESULTS) return hits;
      }
    }
    return hits;
  });

  // Reset selection whenever the result set changes shape.
  createEffect(() => {
    results();
    setActiveIdx(0);
  });

  // Keep the active row scrolled into view as the user navigates with arrows.
  createEffect(() => {
    const idx = activeIdx();
    if (!listEl) return;
    const row = listEl.querySelector<HTMLLIElement>(`li[data-idx="${idx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  const jumpTo = (hit: MatchHit): void => {
    const session = sessionsInScope().find((s) => s.id === hit.sessionId);
    if (!session) return;
    try {
      session.focusLine(hit.line);
    } catch {
      // Pane was unmounted between the search and the click; just close.
    }
    props.onClose();
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results().length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = results()[activeIdx()];
      if (hit) jumpTo(hit);
      return;
    }
  };

  // The input only mounts inside `<Show when={props.open}>`, so its ref is
  // populated lazily on first open. Focus + select run from an effect that
  // tracks `open` rather than `onMount`, which would fire before the input
  // exists.
  createEffect(() => {
    if (!props.open) return;
    inputEl?.focus();
    inputEl?.select();
  });

  // Document-level Escape handler is fine to register once: it cheaply
  // no-ops while the modal is closed because `props.onClose` is the only
  // thing it triggers and the parent ignores spurious closes.
  createEffect(() => {
    if (!props.open) return;
    const onDocKey = (e: KeyboardEvent) => {
      // Closing on Escape from outside the input (e.g. focus on a result row).
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onDocKey, { capture: true }));
  });

  const renderSnippet = (hit: MatchHit) => {
    const snip = snippetFor(hit.lineText, hit.matchStart);
    const before = snip.text.slice(0, snip.start);
    const middle = snip.text.slice(snip.start, snip.start + hit.matchLength);
    const after = snip.text.slice(snip.start + hit.matchLength);
    return (
      <span class="ws-xsearch__snippet">
        <span>{before}</span>
        <mark class="ws-xsearch__hit">{middle}</mark>
        <span>{after}</span>
      </span>
    );
  };

  const countLabel = () => {
    const r = results();
    if (error()) return error();
    if (!query()) return "";
    if (r.length === 0) return "no matches";
    if (r.length >= MAX_RESULTS) return `${MAX_RESULTS}+ matches`;
    return `${r.length} ${r.length === 1 ? "match" : "matches"}`;
  };

  return (
    <Show when={props.open}>
      <div
        class="ws-xsearch__backdrop"
        onMouseDown={(e) => {
          // Click on the dimmed backdrop closes; clicks inside the panel
          // are stopped before reaching here.
          if (e.currentTarget === e.target) props.onClose();
        }}
      >
        <div
          class="ws-xsearch"
          role="dialog"
          aria-label="Search across sessions"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class="ws-xsearch__head">
            <input
              ref={inputEl}
              class="ws-xsearch__input"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleKey}
              placeholder="Search across all sessions…"
              spellcheck={false}
              autocomplete="off"
            />
            <span class="ws-xsearch__count">{countLabel()}</span>
            <Tooltip label="Match case">
              <button
                type="button"
                class="ws-xsearch__btn"
                classList={{ "is-on": caseSensitive() }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setCaseSensitive((v) => !v)}
                aria-pressed={caseSensitive()}
                aria-label="Match case"
              >
                Aa
              </button>
            </Tooltip>
            <Tooltip label="Use regular expression">
              <button
                type="button"
                class="ws-xsearch__btn"
                classList={{ "is-on": regex() }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setRegex((v) => !v)}
                aria-pressed={regex()}
                aria-label="Use regular expression"
              >
                .*
              </button>
            </Tooltip>
            <Tooltip label="Close" shortcut="Esc">
              <button
                type="button"
                class="ws-xsearch__btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onClose()}
                aria-label="Close search"
              >
                ×
              </button>
            </Tooltip>
          </div>
          <Show
            when={results().length > 0}
            fallback={
              <div class="ws-xsearch__empty">
                {query()
                  ? (error() ?? "No matches in any open session.")
                  : sessionsInScope().length === 0
                    ? "No open sessions."
                    : `Searching ${sessionsInScope().length} session${
                        sessionsInScope().length === 1 ? "" : "s"
                      }.`}
              </div>
            }
          >
            <ul ref={listEl} class="ws-xsearch__list" role="listbox">
              <For each={results()}>
                {(hit, i) => (
                  <li
                    class="ws-xsearch__row"
                    classList={{ "is-active": i() === activeIdx() }}
                    data-idx={i()}
                    role="option"
                    aria-selected={i() === activeIdx()}
                    onMouseEnter={() => setActiveIdx(i())}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => jumpTo(hit)}
                  >
                    <span class="ws-xsearch__title">{hit.sessionTitle}</span>
                    <span class="ws-xsearch__line">:{hit.line + 1}</span>
                    {renderSnippet(hit)}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  );
}

export default CrossSessionSearch;
