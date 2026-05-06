// T6.4: Quick switcher modal — Cmd/Ctrl+K palette for jumping between projects.
//
// Renders a centered modal over a dimmed backdrop. The modal owns its own
// transient state (query string, selected row index); the project list and
// switch action come from the workspace store.
//
// Behavior:
//   • ↑/↓ moves the selection within the filtered list.
//   • Enter activates the highlighted project (state-only switch via T6.2)
//     and closes the modal.
//   • Esc / backdrop click closes without switching.
//   • Hovering a row updates the selection so the keyboard and mouse stay
//     in sync.
//
// Filter: case-insensitive substring match on project name. The matched
// segment is wrapped in a `.ws-qs__match` span so the accent color makes
// the hit visible without resorting to fuzzy ranking.

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { activeProjectId, projects, sessionCount, setActiveProject } from "../../stores/workspace";

export interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
}

interface MatchResult {
  id: string;
  name: string;
  color: string;
  glyph: string;
  sessions: number;
  /** Substring match position in lowercased name; -1 means show whole name. */
  matchStart: number;
  matchLength: number;
}

export function QuickSwitcher(props: QuickSwitcherProps): JSX.Element {
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLUListElement | undefined;

  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);

  const results = createMemo<MatchResult[]>(() => {
    const all = projects();
    const q = query().trim().toLowerCase();
    const list: MatchResult[] = [];
    for (const p of all) {
      if (!q) {
        list.push({
          id: p.id,
          name: p.name,
          color: p.color,
          glyph: p.glyph,
          sessions: sessionCount(p.id),
          matchStart: -1,
          matchLength: 0,
        });
        continue;
      }
      const idx = p.name.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      list.push({
        id: p.id,
        name: p.name,
        color: p.color,
        glyph: p.glyph,
        sessions: sessionCount(p.id),
        matchStart: idx,
        matchLength: q.length,
      });
    }
    return list;
  });

  // Reset selection when the result set changes (typing, project list update).
  createEffect(() => {
    results();
    setSelected(0);
  });

  // Focus + clear the input each time the modal opens. Skip when closed so
  // the input isn't fighting with whatever surface the user closed back to.
  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setSelected(0);
    queueMicrotask(() => inputEl?.focus());
  });

  // Keep the highlighted row in view when navigating with arrow keys.
  createEffect(() => {
    const idx = selected();
    if (!listEl) return;
    const row = listEl.querySelector<HTMLLIElement>(`li[data-idx="${idx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  // Document-level Escape handler so closing works even if focus has slipped
  // out of the input (e.g. the user clicked a row with the mouse). Capture
  // phase keeps it ahead of pane-level handlers like xterm.
  createEffect(() => {
    if (!props.open) return;
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onDocKey, { capture: true }));
  });

  const pick = (id: string): void => {
    setActiveProject(id);
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
      const len = results().length;
      if (len === 0) return;
      setSelected((i) => (i + 1) % len);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const len = results().length;
      if (len === 0) return;
      setSelected((i) => (i - 1 + len) % len);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = results()[selected()];
      if (hit) pick(hit.id);
      return;
    }
  };

  const renderName = (hit: MatchResult): JSX.Element => {
    if (hit.matchStart < 0) return <>{hit.name}</>;
    const before = hit.name.slice(0, hit.matchStart);
    const middle = hit.name.slice(hit.matchStart, hit.matchStart + hit.matchLength);
    const after = hit.name.slice(hit.matchStart + hit.matchLength);
    return (
      <>
        {before}
        <span class="ws-qs__match">{middle}</span>
        {after}
      </>
    );
  };

  return (
    <Show when={props.open}>
      <div
        class="ws-qs__backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target) props.onClose();
        }}
      >
        <div
          class="ws-qs"
          role="dialog"
          aria-label="Quick switcher"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class="ws-qs__head">
            <IconSearch />
            <input
              ref={inputEl}
              class="ws-qs__input"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleKey}
              placeholder="Switch project…"
              spellcheck={false}
              autocomplete="off"
              aria-label="Filter projects"
            />
            <kbd class="ws-qs__kbd">esc</kbd>
          </div>

          <Show when={results().length > 0} fallback={<div class="ws-qs__empty">No matches</div>}>
            <ul ref={listEl} class="ws-qs__list" role="listbox">
              <For each={results()}>
                {(hit, i) => {
                  const isSelected = (): boolean => i() === selected();
                  const isActive = (): boolean => hit.id === activeProjectId();
                  return (
                    <li
                      class="ws-qs__row"
                      classList={{ "is-selected": isSelected() }}
                      data-idx={i()}
                      role="option"
                      aria-selected={isSelected()}
                      onMouseEnter={() => setSelected(i())}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(hit.id)}
                    >
                      <span
                        class="ws-qs__icon"
                        style={{ background: hit.color }}
                        aria-hidden="true"
                      >
                        {hit.glyph}
                      </span>
                      <span class="ws-qs__name">{renderName(hit)}</span>
                      <span class="ws-qs__meta">
                        {isActive() ? (
                          <span class="ws-qs__active-tag">current</span>
                        ) : hit.sessions > 0 ? (
                          <span class="ws-qs__live">{hit.sessions} live</span>
                        ) : (
                          <span class="ws-qs__idle">idle</span>
                        )}
                      </span>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>

          <div class="ws-qs__foot">
            <span class="ws-qs__hint">
              <kbd class="ws-qs__kbd">↑</kbd>
              <kbd class="ws-qs__kbd">↓</kbd>
              navigate
            </span>
            <span class="ws-qs__hint">
              <kbd class="ws-qs__kbd">↵</kbd>
              switch
            </span>
            <span class="ws-qs__foot-label">Quick switcher</span>
          </div>
        </div>
      </div>
    </Show>
  );
}

function IconSearch(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.4" />
      <path d="M9 9 L12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

export default QuickSwitcher;
