// T5.5: Pane — focus-aware wrapper around a single layout leaf's content.
//
// Wraps any subtree (typically a Terminal) so that:
//   • Click anywhere inside the pane = "this pane is active".
//   • Tabbing into pane content (e.g. xterm textarea) = active too.
//   • The active pane shows an accent border ring (1px tinted) per the
//     PROJECT_PLAN T5.5 acceptance — exactly mirroring the prototype's
//     `.pane.focused` rule in work-station-design/styles.css.
//
// Focus state is fully controlled by the parent (`focused` prop). The
// wrapper reports activation intent via `onFocus(sessionId)`; the parent
// reduces those events into a single "focusedSessionId" the LayoutTree
// can render against. This keeps the hotkey-routing layer (T8.x) free
// to consult the same source of truth without duplicating click logic.
//
// Activation listeners:
//   • `pointerdown` — fires before any child takes focus, so keyboard or
//     mouse clicks both register even when the inner Terminal swallows
//     them via xterm's textarea capture.
//   • `focusin` — bubbles from any descendant. Catches keyboard tab
//     navigation that lands focus on the xterm textarea directly without
//     a pointer event ever firing.

import { For, Show, children, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { SplitDirection } from "../../types/layout";
import type { CliMeta } from "../../types/tab";

export interface PaneCliOption {
  name: string;
  path: string;
  version: string | null;
}

export type PaneCliLaunchMode = "replace" | `split-${SplitDirection}`;

export interface PaneProps {
  /** Stable identifier for this pane (typically the PTY sessionId). Echoed
   *  back through `onFocus` so the parent can reduce events into a single
   *  focused-session signal without reaching into refs. */
  sessionId: string;
  /** Whether this pane currently has the focus ring. Controlled. */
  focused: boolean;
  /** Fired on pointerdown OR descendant focusin. Idempotent — the parent
   *  may receive multiple events for the same activation; treat as
   *  "make this pane focused". */
  onFocus?: (sessionId: string) => void;
  clis?: readonly PaneCliOption[];
  onLaunchCli?: (sessionId: string, cli: PaneCliOption, mode: PaneCliLaunchMode) => void;
  /** T7.7 — CLI badge metadata for the session inside this pane. The
   *  parent resolves this from the spawn command (not by parsing process
   *  state) so the badge is stable for the lifetime of the pane. Omitted
   *  → no badge is drawn (e.g. the user-shell fallback case). */
  cli?: CliMeta | null;
  /** Optional human-readable CLI name used as the badge's accessible
   *  label. Defaults to "CLI" when not provided. */
  cliLabel?: string | null;
  /** The subtree mounted inside the pane (Terminal, placeholder, etc.). */
  children: JSX.Element;
}

export function Pane(props: PaneProps): JSX.Element {
  // The `children` helper memoises the resolved JSX so the wrapper's
  // `focused` prop changes can NEVER trigger a re-evaluation of the
  // child subtree. Required to keep T5.4's "100 ratio drags = 1 mount"
  // acceptance intact when focus is being toggled in the same session
  // (focus changes happen alongside ratio drags during normal use).
  const resolved = children(() => props.children);

  // Both paths must be idempotent — clicking on the already-focused pane
  // re-fires onFocus, descendant focusin events do too. The parent
  // reducer (typically `setFocusedSessionId`) treats repeats as no-ops,
  // so pre-filtering here would just hide the contract from callers
  // that legitimately want every activation event (e.g., for
  // last-activated metrics in T6.3 hotkey routing).
  const activate = (): void => {
    props.onFocus?.(props.sessionId);
  };

  const [menuOpen, setMenuOpen] = createSignal(false);

  const quickLaunchEnabled = (): boolean =>
    props.clis !== undefined && props.onLaunchCli !== undefined;

  const pickCli = (cli: PaneCliOption, mode: PaneCliLaunchMode): void => {
    props.onLaunchCli?.(props.sessionId, cli, mode);
    setMenuOpen(false);
  };

  const toggleMenu: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    event.stopPropagation();
    activate();
    setMenuOpen((open) => !open);
  };

  // T7.7 — the CLI badge is its own absolutely-positioned anchor so it
  // sits in the top-LEFT corner without colliding with the launch button
  // in the top-RIGHT. Rendered independently of `quickLaunchEnabled` —
  // a pane can have a CLI badge even when the launcher isn't wired
  // (e.g. read-only contexts).
  const cliBadge = (): CliMeta | null => props.cli ?? null;

  return (
    <div
      class="ws-pane"
      role="region"
      aria-label={`Pane ${props.sessionId}`}
      data-session-id={props.sessionId}
      data-focused={props.focused ? "true" : undefined}
      onPointerDown={activate}
      onFocusIn={activate}
    >
      <Show when={cliBadge()}>
        {(meta) => (
          <span
            class="ws-pane__cli-badge"
            data-cli={props.cliLabel ?? undefined}
            style={meta().color ? { color: meta().color } : undefined}
            aria-label={`CLI: ${props.cliLabel ?? "unknown"}`}
            title={props.cliLabel ?? "CLI"}
          >
            {meta().badge}
          </span>
        )}
      </Show>
      <Show when={quickLaunchEnabled()}>
        <div class="ws-pane__head">
          <button
            type="button"
            class="ws-pane__launch"
            aria-haspopup="menu"
            aria-expanded={menuOpen() ? "true" : "false"}
            aria-label="New terminal"
            title="New terminal"
            onClick={toggleMenu}
          >
            <IconPlus />
          </button>
          <Show when={menuOpen()}>
            <CliLaunchMenu
              clis={props.clis ?? []}
              onPick={pickCli}
              onClose={() => setMenuOpen(false)}
            />
          </Show>
        </div>
      </Show>
      <div class="ws-pane__body">{resolved()}</div>
    </div>
  );
}

export default Pane;

interface CliLaunchMenuProps {
  clis: readonly PaneCliOption[];
  onPick: (cli: PaneCliOption, mode: PaneCliLaunchMode) => void;
  onClose: () => void;
}

function CliLaunchMenu(props: CliLaunchMenuProps): JSX.Element {
  let root: HTMLDivElement | undefined;
  const [selected, setSelected] = createSignal(0);

  createEffect(() => {
    const max = Math.max(0, props.clis.length - 1);
    if (selected() > max) setSelected(max);
  });

  const pickAt = (index: number, mode: PaneCliLaunchMode): void => {
    const cli = props.clis[index];
    if (!cli) return;
    props.onPick(cli, mode);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, props.clis.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickAt(selected(), event.shiftKey ? "split-v" : "split-h");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      pickAt(Number.parseInt(event.key, 10) - 1, event.shiftKey ? "split-v" : "split-h");
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && root?.contains(target)) return;
    props.onClose();
  };

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
  });

  return (
    <div ref={root} class="ws-cli-pop" role="menu" aria-label="New terminal">
      <div class="ws-cli-pop__head">
        <span>Spawn in pane</span>
        <span class="ws-cli-pop__keys">
          <Kbd>⌘</Kbd>
          <Kbd>1</Kbd>
        </span>
      </div>
      <Show
        when={props.clis.length > 0}
        fallback={<div class="ws-cli-pop__empty">No detected CLIs</div>}
      >
        <For each={props.clis}>
          {(cli, index) => (
            <div
              class="ws-cli-pop__row"
              role="menuitem"
              data-selected={selected() === index() ? "true" : undefined}
              onMouseEnter={() => setSelected(index())}
            >
              <span class="ws-cli-pop__dot" />
              <span class="ws-cli-pop__name">{cli.name}</span>
              <span class="ws-cli-pop__version">{cli.version ?? ""}</span>
              <span class="ws-cli-pop__actions">
                <button
                  type="button"
                  class="ws-cli-pop__action"
                  aria-label={`Open ${cli.name} side by side`}
                  title="Open side by side"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onPick(cli, event.altKey ? "replace" : "split-h");
                  }}
                >
                  <IconSplitRight />
                </button>
                <button
                  type="button"
                  class="ws-cli-pop__action"
                  aria-label={`Open ${cli.name} stacked`}
                  title="Open stacked"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onPick(cli, event.altKey ? "replace" : "split-v");
                  }}
                >
                  <IconSplitDown />
                </button>
                <Show when={index() < 9}>
                  <span class="ws-cli-pop__keys">
                    <Kbd>⌘</Kbd>
                    <Kbd>{String(index() + 1)}</Kbd>
                  </span>
                </Show>
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

function Kbd(props: { children: JSX.Element }): JSX.Element {
  return <span class="ws-cli-pop__kbd">{props.children}</span>;
}

function IconPlus(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function IconSplitRight(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3.5h10v9H3zM8 3.5v9" />
    </svg>
  );
}

function IconSplitDown(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3.5h10v9H3zM3 8h10" />
    </svg>
  );
}
