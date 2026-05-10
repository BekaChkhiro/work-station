import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { eventMatchesBinding, getBinding } from "../../hotkeys";

export interface TerminalSearchProps {
  addon: SearchAddon;
  onClose: () => void;
}

// SearchAddon requires #RRGGBB hex for the overview-ruler colors — there is
// no API to feed it CSS variables, so we hardcode the accent ruler swatches.
const DECORATIONS = {
  matchOverviewRuler: "#5a6e6e",
  activeMatchColorOverviewRuler: "#a0d8d8",
} as const;

export function TerminalSearch(props: TerminalSearchProps) {
  let inputEl!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [count, setCount] = createSignal(0);
  const [index, setIndex] = createSignal(-1);

  const buildOptions = (): ISearchOptions => ({
    caseSensitive: caseSensitive(),
    regex: regex(),
    decorations: DECORATIONS,
  });

  // Re-run the search whenever the query or toggles change. An empty query
  // clears decorations; otherwise we kick off a fresh forward search from
  // the current cursor so toggling case/regex re-locates the first match.
  createEffect(() => {
    const q = query();
    const opts = buildOptions();
    if (!q) {
      props.addon.clearDecorations();
      setCount(0);
      setIndex(-1);
      return;
    }
    props.addon.findNext(q, opts);
  });

  const findNext = (): void => {
    const q = query();
    if (!q) return;
    props.addon.findNext(q, buildOptions());
  };

  const findPrev = (): void => {
    const q = query();
    if (!q) return;
    props.addon.findPrevious(q, buildOptions());
  };

  onMount(() => {
    const sub = props.addon.onDidChangeResults((evt) => {
      setCount(evt.resultCount);
      setIndex(evt.resultIndex);
    });
    onCleanup(() => sub.dispose());
    inputEl.focus();
    inputEl.select();
  });

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault();
      if (event.shiftKey) findPrev();
      else findNext();
      return;
    }
    // Cmd/Ctrl+F while focused → re-select so the user can quickly retype.
    const find = getBinding("find-in-terminal");
    if (find && eventMatchesBinding(event, find)) {
      event.preventDefault();
      inputEl.select();
    }
  };

  const countLabel = (): string => {
    const n = count();
    if (n > 0) return `${index() + 1} of ${n}`;
    if (query()) return "no matches";
    return "";
  };

  return (
    <div class="ws-term-search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputEl}
        class="ws-term-search__input"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={handleKey}
        placeholder="Find in pane…"
        spellcheck={false}
        autocomplete="off"
      />
      <span class="ws-term-search__count">{countLabel()}</span>
      <button
        type="button"
        class="ws-term-search__btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={findPrev}
        disabled={count() === 0}
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        type="button"
        class="ws-term-search__btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={findNext}
        disabled={count() === 0}
        aria-label="Next match"
      >
        ↓
      </button>
      <button
        type="button"
        class="ws-term-search__btn"
        classList={{ "is-on": caseSensitive() }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setCaseSensitive((v) => !v)}
        aria-pressed={caseSensitive()}
        aria-label="Match case"
      >
        Aa
      </button>
      <button
        type="button"
        class="ws-term-search__btn"
        classList={{ "is-on": regex() }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setRegex((v) => !v)}
        aria-pressed={regex()}
        aria-label="Use regular expression"
      >
        .*
      </button>
      <button
        type="button"
        class="ws-term-search__btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onClose()}
        aria-label="Close search"
      >
        ×
      </button>
    </div>
  );
}

export default TerminalSearch;
