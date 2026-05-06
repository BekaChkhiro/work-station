// T5.4: LayoutTree — recursive renderer that walks a LayoutNode tree and
// emits a SplitPane for every interior split and a caller-supplied subtree
// for every pane leaf.
//
// The acceptance criterion is the most load-bearing constraint: dragging a
// split handle 100 times must not remount any Terminal (mount counter
// stays at 1). That has two reactive-architecture implications:
//
//   1. Pane leaves are keyed by `sessionId`, NOT by node reference. The
//      tree above them produces a new SplitNode every drag (immutable
//      ratio update), so child references would change too if we keyed on
//      identity. With sessionId-keyed `<Show keyed>`, the same id keeps
//      the same DOM body and the renderPane subtree is preserved.
//
//   2. Splits are NOT keyed by reference either. A non-keyed `<Match>`
//      keeps its body mounted across truthy→truthy `when` transitions, so
//      `split().ratio` flows reactively into SplitPane's `ratio` prop
//      without re-creating the SplitPane (and therefore without re-
//      creating its children). The path string identifies which split
//      emitted a ratio change so the parent can target the update.
//
// The renderer is purely controlled — it never mutates the tree. The
// caller owns the layout state and applies `updateSplitRatio(...)` (from
// types/layout) inside `onRatioChange`.

import { Match, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { SplitPane } from "../SplitPane";
import { Pane } from "../Pane";
import type { PaneCliLaunchMode, PaneCliOption } from "../Pane";
import {
  isPane,
  isSplit,
  type LayoutNode,
  type LayoutPath,
  type PaneNode,
  type SplitNode,
} from "../../types/layout";

export interface LayoutTreeProps {
  /** The subtree to render. Pane → renderPane(sessionId); split → SplitPane. */
  node: LayoutNode;
  /** Render the subtree mounted inside a pane leaf. Called once per unique
   *  sessionId; subsequent ratio changes around that pane don't re-invoke
   *  it. The caller wires the Terminal (or any equivalent host) here. */
  renderPane: (sessionId: string) => JSX.Element;
  /** Fires when a SplitPane handle commits a new ratio. The path locates
   *  the split inside the tree — feed it to `updateSplitRatio` and pass
   *  the result back as `node`. */
  onRatioChange?: (path: LayoutPath, ratio: number) => void;
  /** T5.5 — sessionId of the currently focused pane (controlled). When
   *  omitted, the focus ring layer is bypassed entirely so legacy callers
   *  see no visual change. Pair with `onFocusPane` to enable click-to-focus. */
  focusedSessionId?: string | null;
  /** T5.5 — fired when a pane is clicked or receives keyboard focus
   *  (focusin from any descendant). Reduce these into `focusedSessionId`. */
  onFocusPane?: (sessionId: string) => void;
  /** T7.3 — detected CLIs shown by each pane's quick-launch button. */
  clis?: readonly PaneCliOption[];
  /** T7.3 — parent-owned launch action for replace vs. split semantics. */
  onLaunchCli?: (sessionId: string, cli: PaneCliOption, mode: PaneCliLaunchMode) => void;
  /** Internal — accumulates "L"/"R" chars on the recursive descent. The
   *  root call defaults to "". Callers should leave this unset. */
  path?: LayoutPath;
}

export function LayoutTree(props: LayoutTreeProps): JSX.Element {
  const path = (): LayoutPath => props.path ?? "";
  // Focus tracking is opt-in: the wrapper only renders when a parent has
  // wired BOTH ends of the contract. Half-wired (only the state, only the
  // setter) would result in either a stuck ring or click events that go
  // nowhere — failing closed keeps the contract self-documenting.
  const focusEnabled = (): boolean =>
    props.focusedSessionId !== undefined && props.onFocusPane !== undefined;

  // The Pane wrapper preserves children identity across `focused` prop
  // changes — flipping focus does NOT remount the Terminal subtree, which
  // is required to keep T5.4's "100 drags = 1 mount" acceptance intact
  // even when focus is being toggled in tandem.
  const renderLeaf = (sessionId: string): JSX.Element => {
    if (!focusEnabled()) return props.renderPane(sessionId);
    return (
      <Pane
        sessionId={sessionId}
        focused={props.focusedSessionId === sessionId}
        onFocus={props.onFocusPane}
        clis={props.clis}
        onLaunchCli={props.onLaunchCli}
      >
        {props.renderPane(sessionId)}
      </Pane>
    );
  };

  return (
    <Switch>
      <Match when={isPane(props.node) ? (props.node as PaneNode) : null}>
        {(pane) => (
          <Show keyed when={pane().sessionId}>
            {(sessionId) => renderLeaf(sessionId)}
          </Show>
        )}
      </Match>
      <Match when={isSplit(props.node) ? (props.node as SplitNode) : null}>
        {(split) => (
          <SplitPane
            direction={split().direction}
            ratio={split().ratio}
            onRatioChange={(r) => props.onRatioChange?.(path(), r)}
            first={
              <LayoutTree
                node={split().children[0]}
                renderPane={props.renderPane}
                onRatioChange={props.onRatioChange}
                focusedSessionId={props.focusedSessionId}
                onFocusPane={props.onFocusPane}
                clis={props.clis}
                onLaunchCli={props.onLaunchCli}
                path={path() + "L"}
              />
            }
            second={
              <LayoutTree
                node={split().children[1]}
                renderPane={props.renderPane}
                onRatioChange={props.onRatioChange}
                focusedSessionId={props.focusedSessionId}
                onFocusPane={props.onFocusPane}
                clis={props.clis}
                onLaunchCli={props.onLaunchCli}
                path={path() + "R"}
              />
            }
          />
        )}
      </Match>
    </Switch>
  );
}

export default LayoutTree;
